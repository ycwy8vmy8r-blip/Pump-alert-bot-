require("dotenv").config();

const { Telegraf } = require("telegraf");
const { Connection, PublicKey } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

// ============================================================
// V6 RADAR + V5.9 SIMULATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN manquant");
if (!CHAT_ID) throw new Error("CHAT_ID manquant");
if (!HELIUS_API_KEY) throw new Error("HELIUS_API_KEY manquant");

// ============================================================
// SOLANA
// ============================================================

const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(
  RPC_URL,
  "confirmed"
);

// ============================================================
// PROGRAMMES
// ============================================================

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const PUMP_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// ============================================================
// FILTRES V6
// ============================================================

const TARGET_NAMES = [
  "claude",
  "openai",
  "anthropic",
];

const MIN_LIQUIDITY = 200000;
const MAX_LIQUIDITY = 400000;

const MIN_HOLDERS = 1000;

const MAX_AGE_MS =
  5 * 60 * 60 * 1000;

// ============================================================
// V5.9
// ============================================================

const CAPITAL = 10;

const TARGET_PCT = 5;

const STOP_LEVELS = [
  -10,
  -15,
  -20,
  -25,
];

const MARKET_INTERVAL = 2000;

const RADAR_INTERVAL = 15000;

const POST_SELL_COOLDOWN_MS =
  30000;

const SESSION_MAX_MS =
  45 * 60 * 1000;

const NO_NEW_BUY_MS =
  43 * 60 * 1000;

const HISTORY_SECONDS = 120;

// Crash
const CRASH_LIQUIDITY = 1;

const CRASH_LIQUIDITY_DROP_10S = -50;

const CRASH_PRICE_DROP_10S = -20;

// ============================================================
// DONNÉES
// ============================================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });
}

const MARKET_FILE =
  path.join(
    DATA_DIR,
    "v6_market_history.jsonl"
  );

const TRADE_FILE =
  path.join(
    DATA_DIR,
    "v6_trades.jsonl"
  );

const CRASH_FILE =
  path.join(
    DATA_DIR,
    "v6_crashes.jsonl"
  );

const SUMMARY_FILE =
  path.join(
    DATA_DIR,
    "v6_summary.json"
  );

// ============================================================
// ÉTAT
// ============================================================

let radarRunning = false;

let simulationRunning = false;

let radarTimer = null;

let marketTimer = null;

let radarBusy = false;

let marketBusy = false;

let currentCandidate = null;

let sessionStart = null;

let marketHistory = [];

let lastMarket = null;

let crashDetected = false;

let sessionStoppedReason = null;

// ============================================================
// HOLDERS CACHE
// ============================================================

const holderCache = new Map();

const HOLDER_CACHE_MS =
  60000;

// ============================================================
// TELEGRAM
// ============================================================

const bot = new Telegraf(
  BOT_TOKEN
);

async function sendTelegram(text) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (err) {
    console.log(
      "Telegram:",
      err.message
    );
  }
}

// ============================================================
// UTILITAIRES
// ============================================================

function now() {
  return Date.now();
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .trim();
}

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `$${value.toLocaleString(
    "en-US",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }
  )}`;
}

function formatDuration(ms) {
  const total =
    Math.floor(ms / 1000);

  const h =
    Math.floor(total / 3600);

  const m =
    Math.floor(
      (total % 3600) / 60
    );

  const s =
    total % 60;

  return `${h}h ${m}m ${s}s`;
}

function percentageChange(
  current,
  previous
) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }

  return (
    ((current - previous) /
      previous) *
    100
  );
}

function appendJsonLine(
  file,
  object
) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(object) +
        "\n"
    );
  } catch (err) {
    console.log(
      "Écriture:",
      err.message
    );
  }
}

function saveJson(
  file,
  object
) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(
        object,
        null,
        2
      )
    );
  } catch (err) {
    console.log(
      "Save JSON:",
      err.message
    );
  }
}

// ============================================================
// VALIDATION MINT
// ============================================================

function isValidMint(mint) {
  try {
    new PublicKey(mint);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// NOM
// ============================================================

function matchesTargetName(
  name,
  symbol
) {
  const n =
    normalizeName(name);

  const s =
    normalizeName(symbol);

  return TARGET_NAMES.some(
    (target) =>
      n === target ||
      s === target ||
      n.includes(target) ||
      s.includes(target)
  );
}

// ============================================================
// HTTP
// ============================================================

async function fetchJson(url) {
  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  return response.json();
}

// ============================================================
// DEXSCREENER
// ============================================================

function isPumpSwapPair(pair) {
  const dex =
    normalizeName(
      pair?.dexId
    );

  return (
    dex === "pumpswap" ||
    dex === "pump_amm" ||
    dex === "pumpamm" ||
    dex.includes("pump")
  );
}

async function getDexPairs(
  mint
) {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  const data =
    await fetchJson(url);

  const pairs =
    Array.isArray(data?.pairs)
      ? data.pairs
      : [];

  return pairs.filter(
    (pair) => {
      if (
        !isPumpSwapPair(pair)
      ) {
        return false;
      }

      const base =
        pair.baseToken?.address ===
        mint;

      const quote =
        pair.quoteToken?.address ===
        mint;

      return base || quote;
    }
  );
}

function chooseBestPair(
  pairs,
  mint
) {
  if (!pairs.length) {
    return null;
  }

  const valid =
    pairs.filter(
      (pair) => {
        const liquidity =
          Number(
            pair.liquidity?.usd ||
              0
          );

        return (
          liquidity > 0
        );
      }
    );

  if (!valid.length) {
    return null;
  }

  valid.sort(
    (a, b) => {
      const la =
        Number(
          a.liquidity?.usd ||
            0
        );

      const lb =
        Number(
          b.liquidity?.usd ||
            0
        );

      return lb - la;
    }
  );

  return valid[0];
}

// ============================================================
// HOLDERS HELIUS
// ============================================================

async function getHolderCount(
  mint
) {
  const cached =
    holderCache.get(mint);

  if (
    cached &&
    now() - cached.timestamp <
      HOLDER_CACHE_MS
  ) {
    return cached.count;
  }

  try {
    const url =
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

    const body = {
      jsonrpc: "2.0",
      id: "v6-holders",
      method:
        "getTokenAccounts",
      params: {
        mint,
        limit: 1000,
      },
    };

    const response =
      await fetch(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",
          },
          body:
            JSON.stringify(body),
        }
      );

    if (!response.ok) {
      throw new Error(
        `Helius HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const accounts =
      data?.result
        ?.token_accounts ||
      data?.result
        ?.tokenAccounts ||
      [];

    const owners =
      new Set();

    for (
      const account of accounts
    ) {
      const owner =
        account.owner ||
        account.owner_address ||
        account.ownerAddress;

      const rawAmount =
        account.amount ??
        account.token_amount ??
        account.tokenAmount ??
        0;

      const amount =
        Number(rawAmount);

      if (
        owner &&
        Number.isFinite(amount) &&
        amount > 0
      ) {
        owners.add(owner);
      }
    }

    const count =
      owners.size;

    holderCache.set(
      mint,
      {
        count,
        timestamp: now(),
      }
    );

    return count;

  } catch (err) {
    console.log(
      "⚠️ Holders:",
      err.message
    );

    return null;
  }
}

// ============================================================
// PUMPSWAP ON-CHAIN
// ============================================================

const OFFSET_BASE_MINT = 43;

const OFFSET_QUOTE_MINT = 75;

const OFFSET_BASE_VAULT = 139;

const OFFSET_QUOTE_VAULT = 171;

const OFFSET_VIRTUAL_QUOTE = 245;

function readPubkey(
  data,
  offset
) {
  if (
    !data ||
    data.length <
      offset + 32
  ) {
    return null;
  }

  try {
    return new PublicKey(
      data.subarray(
        offset,
        offset + 32
      )
    ).toBase58();
  } catch {
    return null;
  }
}

function readI128LE(
  data,
  offset
) {
  if (
    !data ||
    data.length <
      offset + 16
  ) {
    return 0n;
  }

  let result = 0n;

  for (
    let i = 15;
    i >= 0;
    i--
  ) {
    result =
      (result << 8n) +
      BigInt(
        data[offset + i]
      );
  }

  return result;
}

async function verifyPumpSwapPool(
  pairAddress,
  mint
) {
  try {
    const info =
      await connection.getAccountInfo(
        new PublicKey(
          pairAddress
        ),
        "confirmed"
      );

    if (!info) {
      return {
        ok: false,
        reason:
          "POOL_NOT_FOUND",
      };
    }

    if (
      info.owner.toBase58() !==
      PUMPSWAP_PROGRAM
    ) {
      return {
        ok: false,
        reason:
          "OWNER_NOT_PUMPSWAP",
      };
    }

    const data =
      info.data;

    const baseMint =
      readPubkey(
        data,
        OFFSET_BASE_MINT
      );

    const quoteMint =
      readPubkey(
        data,
        OFFSET_QUOTE_MINT
      );

    const baseVault =
      readPubkey(
        data,
        OFFSET_BASE_VAULT
      );

    const quoteVault =
      readPubkey(
        data,
        OFFSET_QUOTE_VAULT
      );

    if (
      !baseMint ||
      !quoteMint
    ) {
      return {
        ok: false,
        reason:
          "INVALID_POOL_LAYOUT",
      };
    }

    if (
      baseMint !== mint
    ) {
      return {
        ok: false,
        reason:
          "BASE_MINT_MISMATCH",
      };
    }

    if (
      quoteMint !== WSOL_MINT
    ) {
      return {
        ok: false,
        reason:
          "QUOTE_NOT_WSOL",
      };
    }

    return {
      ok: true,

      baseMint,

      quoteMint,

      baseVault,

      quoteVault,

      virtualQuote:
        readI128LE(
          data,
          OFFSET_VIRTUAL_QUOTE
        ),
    };

  } catch (err) {
    return {
      ok: false,
      reason:
        err.message,
    };
  }
}

// ============================================================
// ÉVALUATION D'UN TOKEN
// ============================================================

async function evaluateMint(
  mint
) {
  const result = {
    ok: false,
    mint,
    checks: {},
  };

  if (!isValidMint(mint)) {
    result.reason =
      "MINT_INVALIDE";

    return result;
  }

  // ----------------------------------------------------------
  // 1. DEX
  // ----------------------------------------------------------

  let pairs;

  try {
    pairs =
      await getDexPairs(
        mint
      );
  } catch (err) {
    result.reason =
      "DEXSCREENER_ERROR";

    result.error =
      err.message;

    return result;
  }

  if (!pairs.length) {
    result.reason =
      "PAS_DE_PUMPSWAP";

    result.checks.pumpSwap =
      false;

    return result;
  }

  result.checks.pumpSwap =
    true;

  const pair =
    chooseBestPair(
      pairs,
      mint
    );

  if (!pair) {
    result.reason =
      "AUCUN_PAIR_VALIDE";

    return result;
  }

  // ----------------------------------------------------------
  // 2. NOM
  // ----------------------------------------------------------

  const name =
    pair.baseToken?.address ===
    mint
      ? pair.baseToken?.name ||
        ""
      : pair.quoteToken?.name ||
        "";

  const symbol =
    pair.baseToken?.address ===
    mint
      ? pair.baseToken?.symbol ||
        ""
      : pair.quoteToken?.symbol ||
        "";

  result.name = name;

  result.symbol = symbol;

  result.checks.name =
    matchesTargetName(
      name,
      symbol
    );

  if (
    !result.checks.name
  ) {
    result.reason =
      "NOM_NON_AUTORISE";

    return result;
  }

  // ----------------------------------------------------------
  // 3. ÂGE
  // ----------------------------------------------------------

  const pairCreatedAt =
    Number(
      pair.pairCreatedAt || 0
    );

  if (!pairCreatedAt) {
    result.reason =
      "AGE_INCONNU";

    return result;
  }

  const ageMs =
    now() - pairCreatedAt;

  result.ageMs =
    ageMs;

  result.ageMinutes =
    ageMs / 60000;

  result.checks.age =
    ageMs >= 0 &&
    ageMs <= MAX_AGE_MS;

  if (
    !result.checks.age
  ) {
    result.reason =
      "AGE_SUPERIEUR_5H";

    return result;
  }

  // ----------------------------------------------------------
  // 4. LIQUIDITÉ
  // ----------------------------------------------------------

  const liquidity =
    Number(
      pair.liquidity?.usd ||
        0
    );

  result.liquidity =
    liquidity;

  result.checks.liquidity =
    liquidity >=
      MIN_LIQUIDITY &&
    liquidity <=
      MAX_LIQUIDITY;

  if (
    !result.checks.liquidity
  ) {
    result.reason =
      "LIQUIDITE_HORS_PLAGE";

    return result;
  }

  // ----------------------------------------------------------
  // 5. HOLDERS
  // ----------------------------------------------------------

  const holders =
    await getHolderCount(
      mint
    );

  result.holders =
    holders;

  if (
    holders === null
  ) {
    result.reason =
      "HOLDERS_INDISPONIBLES";

    return result;
  }

  result.checks.holders =
    holders >=
    MIN_HOLDERS;

  if (
    !result.checks.holders
  ) {
    result.reason =
      "PAS_ASSEZ_DE_HOLDERS";

    return result;
  }

  // ----------------------------------------------------------
  // 6. PAIR ADDRESS
  // ----------------------------------------------------------

  const pairAddress =
    pair.pairAddress;

  if (!pairAddress) {
    result.reason =
      "PAIR_ADDRESS_MANQUANTE";

    return result;
  }

  result.pairAddress =
    pairAddress;

  // ----------------------------------------------------------
  // 7. ON-CHAIN
  // ----------------------------------------------------------

  const onchain =
    await verifyPumpSwapPool(
      pairAddress,
      mint
    );

  result.onchain =
    onchain;

  result.checks.onchain =
    onchain.ok;

  if (!onchain.ok) {
    result.reason =
      `ONCHAIN_${onchain.reason}`;

    return result;
  }

  // ----------------------------------------------------------
  // TOUT EST OK
  // ----------------------------------------------------------

  result.ok = true;

  result.reason =
    "CANDIDAT_VALIDE";

  result.dex =
    pair.dexId;

  result.priceUsd =
    Number(
      pair.priceUsd || 0
    );

  result.pair =
    pair;

  return result;
}

// ============================================================
// MESSAGE DE DIAGNOSTIC
// ============================================================

function candidateDiagnostic(
  result
) {
  let text =
`🔎 TEST V6

Mint :
${result.mint}

`;

  if (result.name) {
    text +=
`🪙 Nom :
${result.name}

`;
  }

  if (result.symbol) {
    text +=
`🔤 Symbole :
${result.symbol}

`;
  }

  if (
    result.liquidity !==
    undefined
  ) {
    text +=
`💧 Liquidité :
${formatUsd(
  result.liquidity
)}

`;
  }

  if (
    result.holders !==
    undefined
  ) {
    text +=
`👥 Holders :
${result.holders}

`;
  }

  if (
    result.ageMinutes !==
    undefined
  ) {
    text +=
`⏱️ Âge :
${result.ageMinutes.toFixed(
  1
)} min

`;
  }

  text +=
`🏦 PumpSwap :
${
  result.checks?.pumpSwap
    ? "🟢 OK"
    : "🔴 NON"
}

`;

  text +=
`📝 Nom :
${
  result.checks?.name
    ? "🟢 OK"
    : "🔴 NON"
}

`;

  text +=
`⏱️ Âge :
${
  result.checks?.age
    ? "🟢 OK"
    : "🔴 NON"
}

`;

  text +=
`💧 Liquidité :
${
  result.checks?.liquidity
    ? "🟢 OK"
    : "🔴 NON"
}

`;

  text +=
`👥 Holders :
${
  result.checks?.holders
    ? "🟢 OK"
    : "🔴 NON"
}

`;

  text +=
`⛓️ On-chain :
${
  result.checks?.onchain
    ? "🟢 OK"
    : "🔴 NON"
}

`;

  text +=
`📌 Résultat :
${result.ok
  ? "🟢 CANDIDAT VALIDÉ"
  : "🔴 REFUSÉ"}

`;

  text +=
`Motif :
${result.reason}`;

  if (
    result.pairAddress
  ) {
    text +=
`

Pair :
${result.pairAddress}`;
  }

  return text;
}

// ============================================================
// TEST MANUEL D'UN MINT
// ============================================================

async function testMint(
  mint
) {
  await sendTelegram(
`🔎 TEST MANUEL V6

Mint :
${mint}

⏳ Vérification :
PumpSwap
nom
âge
liquidité
holders
on-chain`
  );

  const result =
    await evaluateMint(
      mint
    );

  console.log(
    "TEST:",
    result
  );

  await sendTelegram(
    candidateDiagnostic(
      result
    )
  );

  if (result.ok) {
    currentCandidate =
      result;

    await sendTelegram(
`🟢 TOKEN PRÊT POUR V5.9

${result.name}
${result.symbol}

Liquidité :
${formatUsd(
  result.liquidity
)}

Holders :
${result.holders}

Âge :
${result.ageMinutes.toFixed(
  1
)} min

PumpSwap :
${result.pairAddress}

👉 Pour lancer la simulation :

/starttrade`
    );
  }

  return result;
}

// ============================================================
// RADAR AUTOMATIQUE
// ============================================================

async function getRecentPumpTokens() {
  const urls = [
    "https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false",
  ];

  const tokens =
    new Map();

  for (
    const url of urls
  ) {
    try {
      const data =
        await fetchJson(
          url
        );

      const list =
        Array.isArray(data)
          ? data
          : Array.isArray(
              data?.coins
            )
          ? data.coins
          : [];

      for (
        const token of list
      ) {
        const mint =
          token.mint ||
          token.address;

        if (mint) {
          tokens.set(
            mint,
            token
          );
        }
      }
    } catch (err) {
      console.log(
        "Pump.fun:",
        err.message
      );
    }
  }

  return Array.from(
    tokens.values()
  );
}

async function radarTick() {
  if (!radarRunning) {
    return;
  }

  if (radarBusy) {
    return;
  }

  radarBusy = true;

  try {
    const tokens =
      await getRecentPumpTokens();

    console.log(
      `🔎 Radar : ${tokens.length} tokens`
    );

    for (
      const token of tokens
    ) {
      if (!radarRunning) {
        break;
      }

      const mint =
        token.mint ||
        token.address;

      if (!mint) {
        continue;
      }

      const name =
        token.name ||
        "";

      const symbol =
        token.symbol ||
        "";

      // Premier filtre très léger :
      // on ne fait pas Helius pour les autres.

      if (
        !matchesTargetName(
          name,
          symbol
        )
      ) {
        continue;
      }

      const result =
        await evaluateMint(
          mint
        );

      if (!result.ok) {
        console.log(
          `❌ ${name} ${symbol}: ${result.reason}`
        );

        continue;
      }

      // Nouveau candidat
      if (
        currentCandidate?.mint ===
        result.mint
      ) {
        continue;
      }

      currentCandidate =
        result;

      await sendTelegram(
`🟢 CANDIDAT V6 AUTOMATIQUE

🪙 ${result.name}
🔤 ${result.symbol}

💧 Liquidité :
${formatUsd(
  result.liquidity
)}

👥 Holders :
${result.holders}

⏱️ Âge :
${result.ageMinutes.toFixed(
  1
)} min

🏦 DEX :
${result.dex}

⛓️ On-chain :
🟢 OK

Mint :
${result.mint}

🧪 V5.9 prêt

/starttrade`
      );

      break;
    }
  } catch (err) {
    console.log(
      "Radar:",
      err.message
    );
  } finally {
    radarBusy = false;
  }
}

// ============================================================
// MARCHÉ V5.9
// ============================================================

async function getCurrentMarket() {
  if (!currentCandidate) {
    return null;
  }

  const mint =
    currentCandidate.mint;

  try {
    const pairs =
      await getDexPairs(
        mint
      );

    const pair =
      chooseBestPair(
        pairs,
        mint
      );

    if (!pair) {
      return null;
    }

    const price =
      Number(
        pair.priceUsd || 0
      );

    const liquidity =
      Number(
        pair.liquidity?.usd ||
          0
      );

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return null;
    }

    return {
      timestamp: now(),

      mint,

      price,

      liquidity,

      dex:
        pair.dexId,

      pairAddress:
        pair.pairAddress,

      name:
        pair.baseToken?.name ||
        currentCandidate.name,

      symbol:
        pair.baseToken?.symbol ||
        currentCandidate.symbol,
    };
  } catch (err) {
    console.log(
      "Market:",
      err.message
    );

    return null;
  }
}

// ============================================================
// HISTORIQUE
// ============================================================

function addMarketPoint(
  market
) {
  marketHistory.push(
    market
  );

  const cutoff =
    now() -
    HISTORY_SECONDS * 1000;

  marketHistory =
    marketHistory.filter(
      (point) =>
        point.timestamp >=
        cutoff
    );

  appendJsonLine(
    MARKET_FILE,
    market
  );
}

function getPointAgo(
  seconds
) {
  const target =
    now() -
    seconds * 1000;

  let best = null;

  for (
    const point of marketHistory
  ) {
    if (
      point.timestamp <=
      target
    ) {
      best = point;
    }
  }

  return best;
}

function getPriceDrop(
  seconds
) {
  const old =
    getPointAgo(seconds);

  if (
    !old ||
    !lastMarket
  ) {
    return null;
  }

  return percentageChange(
    lastMarket.price,
    old.price
  );
}

function getLiquidityDrop(
  seconds
) {
  const old =
    getPointAgo(seconds);

  if (
    !old ||
    !lastMarket
  ) {
    return null;
  }

  return percentageChange(
    lastMarket.liquidity,
    old.liquidity
  );
}

// ============================================================
// STRATÉGIES
// ============================================================

function createStrategy(
  stopPct
) {
  return {
    id:
      `STOP_${Math.abs(
        stopPct
      )}`,

    stopPct,

    capital:
      CAPITAL,

    open: false,

    entryPrice: null,

    entryTime: null,

    cycle: 0,

    wins: 0,

    losses: 0,

    sessionLimit: 0,

    crashExits: 0,

    manualExits: 0,

    pnl: 0,

    lastSellTime: 0,

    trades: [],
  };
}

let strategies =
  STOP_LEVELS.map(
    createStrategy
  );

// ============================================================
// ENTRÉE
// ============================================================

function entryAllowed() {
  if (
    !simulationRunning
  ) {
    return {
      ok: false,
      reason:
        "SIMULATION_STOPPED",
    };
  }

  if (!lastMarket) {
    return {
      ok: false,
      reason:
        "NO_MARKET",
    };
  }

  const elapsed =
    now() -
    sessionStart;

  if (
    elapsed >=
    NO_NEW_BUY_MS
  ) {
    return {
      ok: false,
      reason:
        "NO_NEW_BUY_43MIN",
    };
  }

  if (
    lastMarket.liquidity <
    MIN_LIQUIDITY
  ) {
    return {
      ok: false,
      reason:
        "LIQUIDITY_LOW",
    };
  }

  if (
    lastMarket.liquidity >
    MAX_LIQUIDITY
  ) {
    return {
      ok: false,
      reason:
        "LIQUIDITY_HIGH",
    };
  }

  if (
    marketHistory.length <
    8
  ) {
    return {
      ok: false,
      reason:
        "HISTORY_WARMUP",
    };
  }

  const price10 =
    getPriceDrop(10);

  if (
    price10 !== null &&
    price10 <= -5
  ) {
    return {
      ok: false,
      reason:
        "PRICE_TOO_WEAK",
    };
  }

  const liq10 =
    getLiquidityDrop(10);

  if (
    liq10 !== null &&
    liq10 <= -12
  ) {
    return {
      ok: false,
      reason:
        "LIQUIDITY_10S_WEAK",
    };
  }

  const liq30 =
    getLiquidityDrop(30);

  if (
    liq30 !== null &&
    liq30 <= -20
  ) {
    return {
      ok: false,
      reason:
        "LIQUIDITY_30S_WEAK",
    };
  }

  return {
    ok: true,
    reason: "OK",
  };
}

// ============================================================
// CRASH
// ============================================================

function getCrashReason() {
  if (!lastMarket) {
    return null;
  }

  if (
    lastMarket.liquidity <=
    CRASH_LIQUIDITY
  ) {
    return "LIQUIDITY_NEAR_ZERO";
  }

  const liq10 =
    getLiquidityDrop(10);

  if (
    liq10 !== null &&
    liq10 <=
      CRASH_LIQUIDITY_DROP_10S
  ) {
    return "LIQUIDITY_CRASH";
  }

  const price10 =
    getPriceDrop(10);

  if (
    price10 !== null &&
    price10 <=
      CRASH_PRICE_DROP_10S
  ) {
    return "PRICE_CRASH";
  }

  return null;
}

// ============================================================
// BUY
// ============================================================

function simulateBuy(
  strategy
) {
  if (strategy.open) {
    return;
  }

  strategy.open = true;

  strategy.entryPrice =
    lastMarket.price;

  strategy.entryTime =
    now();

  strategy.cycle++;

  const target =
    strategy.entryPrice *
    (1 +
      TARGET_PCT / 100);

  console.log(
    `🟢 BUY ${strategy.id} #${strategy.cycle}`
  );

  sendTelegram(
`🟢 BUY SIMULÉ

Stratégie :
${strategy.id}

Stop :
${strategy.stopPct}%

Cycle :
#${strategy.cycle}

Capital :
${formatUsd(
  strategy.capital
)}

Prix :
${strategy.entryPrice}

Liquidité :
${formatUsd(
  lastMarket.liquidity
)}

🎯 Cible :
${target}`
  );
}

// ============================================================
// SELL
// ============================================================

function simulateSell(
  strategy,
  reason,
  exitPrice
) {
  if (!strategy.open) {
    return;
  }

  const entry =
    strategy.entryPrice;

  const resultPct =
    ((exitPrice - entry) /
      entry) *
    100;

  const pnl =
    strategy.capital *
    (resultPct / 100);

  strategy.pnl +=
    pnl;

  if (
    reason === "TARGET"
  ) {
    strategy.wins++;
  }

  if (
    reason === "STOP" ||
    reason === "CRASH"
  ) {
    strategy.losses++;
  }

  if (
    reason ===
    "SESSION_LIMIT"
  ) {
    strategy.sessionLimit++;
  }

  if (
    reason === "CRASH"
  ) {
    strategy.crashExits++;
  }

  const trade = {
    timestamp:
      new Date().toISOString(),

    strategy:
      strategy.id,

    stopPct:
      strategy.stopPct,

    cycle:
      strategy.cycle,

    reason,

    entry,

    exit:
      exitPrice,

    resultPct,

    pnl,
  };

  strategy.trades.push(
    trade
  );

  appendJsonLine(
    TRADE_FILE,
    trade
  );

  sendTelegram(
`🎯 SELL SIMULÉ

Stratégie :
${strategy.id}

Motif :
${reason}

Cycle :
#${strategy.cycle}

Entrée :
${entry}

Sortie :
${exitPrice}

Résultat :
${
  resultPct >= 0
    ? "+"
    : ""
}${resultPct.toFixed(
  2
)}%

P&L :
${
  pnl >= 0
    ? "+"
    : ""
}${pnl.toFixed(
  2
)} $`
  );

  strategy.open =
    false;

  strategy.entryPrice =
    null;

  strategy.entryTime =
    null;

  strategy.lastSellTime =
    now();
}

// ============================================================
// TRAITEMENT STRATÉGIE
// ============================================================

function processStrategy(
  strategy
) {
  if (!lastMarket) {
    return;
  }

  if (strategy.open) {
    const gainPct =
      ((lastMarket.price -
        strategy.entryPrice) /
        strategy.entryPrice) *
      100;

    if (
      gainPct >=
      TARGET_PCT
    ) {
      simulateSell(
        strategy,
        "TARGET",
        lastMarket.price
      );

      return;
    }

    if (
      gainPct <=
      strategy.stopPct
    ) {
      simulateSell(
        strategy,
        "STOP",
        lastMarket.price
      );

      return;
    }

    return;
  }

  if (
    now() -
      strategy.lastSellTime <
    POST_SELL_COOLDOWN_MS
  ) {
    return;
  }

  const entry =
    entryAllowed();

  if (!entry.ok) {
    return;
  }

  simulateBuy(
    strategy
  );
}

// ============================================================
// CRASH GLOBAL
// ============================================================

async function handleCrash(
  reason
) {
  if (crashDetected) {
    return;
  }

  crashDetected = true;

  console.log(
    "💥 CRASH:",
    reason
  );

  for (
    const strategy of strategies
  ) {
    if (strategy.open) {
      simulateSell(
        strategy,
        "CRASH",
        lastMarket.price
      );
    }
  }

  const report = {
    timestamp:
      new Date().toISOString(),

    reason,

    mint:
      currentCandidate?.mint,

    name:
      currentCandidate?.name,

    symbol:
      currentCandidate?.symbol,

    price:
      lastMarket?.price,

    liquidity:
      lastMarket?.liquidity,

    priceDrop10s:
      getPriceDrop(10),

    liquidityDrop10s:
      getLiquidityDrop(10),

    strategies:
      strategies.map(
        (s) => ({
          id: s.id,
          stopPct:
            s.stopPct,
          wins:
            s.wins,
          losses:
            s.losses,
          pnl:
            s.pnl,
          crashExits:
            s.crashExits,
        })
      ),
  };

  appendJsonLine(
    CRASH_FILE,
    report
  );

  await sendTelegram(
`💥 CRASH DÉTECTÉ

${reason}

🪙 ${currentCandidate?.name}
${currentCandidate?.symbol}

Prix :
${lastMarket?.price}

Liquidité :
${formatUsd(
  lastMarket?.liquidity
)}

Prix 10s :
${getPriceDrop(10)?.toFixed(2) ?? "N/A"}%

Liquidité 10s :
${getLiquidityDrop(10)?.toFixed(2) ?? "N/A"}%

🛑 NOUVEAUX BUY ARRÊTÉS

📊 /comparison`
  );

  simulationRunning =
    false;

  saveComparison();

  stopMarketLoop();
}

// ============================================================
// FIN 45 MIN
// ============================================================

async function handleSessionLimit() {
  if (!simulationRunning) {
    return;
  }

  const elapsed =
    now() -
    sessionStart;

  if (
    elapsed <
    SESSION_MAX_MS
  ) {
    return;
  }

  console.log(
    "⏰ FIN 45 MIN"
  );

  for (
    const strategy of strategies
  ) {
    if (strategy.open) {
      simulateSell(
        strategy,
        "SESSION_LIMIT",
        lastMarket.price
      );
    }
  }

  sessionStoppedReason =
    "SESSION_LIMIT";

  simulationRunning =
    false;

  saveComparison();

  await sendTelegram(
`⏰ FIN DE SESSION

45 minutes atteintes.

🔒 Les positions ouvertes ont été vendues en simulation au prix observé.

🛑 Plus aucun BUY.

📊 /comparison`
  );

  stopMarketLoop();
}

// ============================================================
// MARKET LOOP
// ============================================================

async function marketTick() {
  if (!simulationRunning) {
    return;
  }

  if (marketBusy) {
    return;
  }

  marketBusy = true;

  try {
    const market =
      await getCurrentMarket();

    if (!market) {
      console.log(
        "⚠️ Marché indisponible"
      );

      // Même si DexScreener rate
      // un tick, on vérifie quand même
      // la limite de session.
      await handleSessionLimit();

      return;
    }

    lastMarket =
      market;

    addMarketPoint(
      market
    );

    console.log(
      `📈 ${market.price} | ${formatUsd(
        market.liquidity
      )}`
    );

    // TARGET / STOP
    for (
      const strategy of strategies
    ) {
      processStrategy(
        strategy
      );
    }

    // CRASH
    const crashReason =
      getCrashReason();

    if (crashReason) {
      await handleCrash(
        crashReason
      );

      return;
    }

    // 45 MIN
    await handleSessionLimit();

  } catch (err) {
    console.log(
      "Market loop:",
      err.message
    );
  } finally {
    marketBusy = false;
  }
}

// ============================================================
// COMPARAISON
// ============================================================

function getComparison() {
  return strategies.map(
    (s) => ({
      strategy:
        s.id,

      stop:
        s.stopPct,

      cycles:
        s.cycle,

      wins:
        s.wins,

      losses:
        s.losses,

      sessionLimit:
        s.sessionLimit,

      crashExits:
        s.crashExits,

      pnl:
        Number(
          s.pnl.toFixed(2)
        ),
    })
  );
}

function saveComparison() {
  saveJson(
    SUMMARY_FILE,
    {
      timestamp:
        new Date().toISOString(),

      candidate:
        currentCandidate,

      sessionStart,

      sessionStoppedReason,

      strategies:
        getComparison(),
    }
  );
}

async function sendComparison() {
  const rows =
    getComparison();

  let text =
`📊 COMPARAISON V5.9

`;

  for (
    const row of rows
  ) {
    text +=
`
${row.strategy}
Stop : ${row.stop}%
Cycles : ${row.cycles}
Wins : ${row.wins}
Losses : ${row.losses}
Crash : ${row.crashExits}
Fin session : ${row.sessionLimit}
P&L : ${
  row.pnl >= 0
    ? "+"
    : ""
}${row.pnl} $
`;
  }

  await sendTelegram(
    text
  );
}

// ============================================================
// STATUS
// ============================================================

async function sendStatus() {
  let text =
`📡 V6 STATUS

Radar :
${
  radarRunning
    ? "🟢 ACTIF"
    : "🔴 ARRÊTÉ"
}

Simulation :
${
  simulationRunning
    ? "🟢 ACTIVE"
    : "🔴 ARRÊTÉE"
}

`;

  if (currentCandidate) {
    text +=
`🪙 ${currentCandidate.name}
🔤 ${currentCandidate.symbol}

💧 ${formatUsd(
  currentCandidate.liquidity
)}

👥 ${currentCandidate.holders}

⏱️ ${currentCandidate.ageMinutes?.toFixed(1) ?? "?"} min

🏦 ${currentCandidate.dex || "PumpSwap"}

Mint :
${currentCandidate.mint}

`;
  }

  if (
    simulationRunning &&
    sessionStart
  ) {
    text +=
`⏱️ Session :
${formatDuration(
  now() -
    sessionStart
)}
`;
  }

  await sendTelegram(
    text
  );
}

// ============================================================
// START V5.9
// ============================================================

async function startSimulation() {
  if (!currentCandidate) {
    await sendTelegram(
`❌ Aucun candidat validé.

Utilise d'abord :

/test TON_MINT

ou attends que le radar trouve un candidat.`
    );

    return;
  }

  if (
    simulationRunning
  ) {
    await sendTelegram(
      "⚠️ V5.9 est déjà active."
    );

    return;
  }

  strategies =
    STOP_LEVELS.map(
      createStrategy
    );

  marketHistory = [];

  lastMarket = null;

  crashDetected = false;

  sessionStoppedReason =
    null;

  sessionStart =
    now();

  simulationRunning =
    true;

  await sendTelegram(
`🧪 V5.9 DÉMARRÉE

🪙 ${currentCandidate.name}
🔤 ${currentCandidate.symbol}

💵 10 $ / cycle

🎯 Target :
+5%

🛑 Stops :
-10%
-15%
-20%
-25%

🚫 Aucun nouveau BUY après 43 min

⏰ Fin forcée à 45 min

🔒 Position ouverte à 45 min :
VENTE DE SÉCURITÉ

⚠️ SIMULATION UNIQUEMENT`
  );

  startMarketLoop();
}

// ============================================================
// STOP
// ============================================================

async function stopSimulation() {
  if (
    !simulationRunning
  ) {
    await sendTelegram(
      "ℹ️ V5.9 n'est pas active."
    );

    return;
  }

  if (lastMarket) {
    for (
      const strategy of strategies
    ) {
      if (strategy.open) {
        simulateSell(
          strategy,
          "MANUAL",
          lastMarket.price
        );

        strategy.manualExits++;
      }
    }
  }

  simulationRunning =
    false;

  sessionStoppedReason =
    "MANUAL";

  saveComparison();

  stopMarketLoop();

  await sendTelegram(
`🛑 V5.9 ARRÊTÉE

Toutes les positions ouvertes ont été clôturées en simulation.

📊 /comparison`
  );
}

// ============================================================
// LOOPS
// ============================================================

function startRadarLoop() {
  if (radarTimer) {
    clearInterval(
      radarTimer
    );
  }

  radarRunning =
    true;

  radarTick();

  radarTimer =
    setInterval(
      radarTick,
      RADAR_INTERVAL
    );
}

function stopRadarLoop() {
  radarRunning =
    false;

  if (radarTimer) {
    clearInterval(
      radarTimer
    );

    radarTimer = null;
  }
}

function startMarketLoop() {
  if (marketTimer) {
    clearInterval(
      marketTimer
    );
  }

  marketTimer =
    setInterval(
      marketTick,
      MARKET_INTERVAL
    );

  marketTick();
}

function stopMarketLoop() {
  if (marketTimer) {
    clearInterval(
      marketTimer
    );

    marketTimer = null;
  }
}

// ============================================================
// TELEGRAM
// ============================================================

bot.command(
  "start",
  async () => {
    await sendTelegram(
`🤖 V6 RADAR

🎯 FILTRES

• Claude / OpenAI / Anthropic
• < 5 heures
• liquidité 200k–400k $
• ≥ 1 000 holders
• PumpSwap

🧪 V5.9

• 10 $ / cycle
• target +5%
• stop -10%
• stop -15%
• stop -20%
• stop -25%
• cooldown 30s
• aucun BUY après 43 min
• fin forcée 45 min

COMMANDES

/scan
/test MINT
/starttrade
/stoptrade
/status
/comparison
/lastcrash
/help`
    );
  }
);

// ------------------------------------------------------------
// /TEST MINT
// ------------------------------------------------------------

bot.command(
  "test",
  async (ctx) => {
    const parts =
      String(
        ctx.message?.text || ""
      )
      .trim()
      .split(/\s+/);

    const mint =
      parts[1];

    if (!mint) {
      await sendTelegram(
`❌ Il manque le mint.

Exemple :

/test 6mXbyvPJbPQRyMU5BFL99TFLEDdvuV434cQBSjjitxX7`
      );

      return;
    }

    await testMint(
      mint
    );
  }
);

// ------------------------------------------------------------
// /SCAN
// ------------------------------------------------------------

bot.command(
  "scan",
  async () => {
    if (radarBusy) {
      await sendTelegram(
        "🔎 Le radar est déjà occupé."
      );

      return;
    }

    await sendTelegram(
      "🔎 SCAN V6 EN COURS..."
    );

    const before =
      currentCandidate?.mint;

    await radarTick();

    if (
      currentCandidate?.mint ===
      before
    ) {
      await sendTelegram(
`🔴 Aucun nouveau candidat validé.

Filtres :
Claude / OpenAI / Anthropic
< 5 h
200k–400k $
≥ 1 000 holders
PumpSwap`
      );
    }
  }
);

// ------------------------------------------------------------
// /STARTTRADE
// ------------------------------------------------------------

bot.command(
  "starttrade",
  async () => {
    await startSimulation();
  }
);

// ------------------------------------------------------------
// /STOPTRADE
// ------------------------------------------------------------

bot.command(
  "stoptrade",
  async () => {
    await stopSimulation();
  }
);

// ------------------------------------------------------------
// /STATUS
// ------------------------------------------------------------

bot.command(
  "status",
  async () => {
    await sendStatus();
  }
);

// ------------------------------------------------------------
// /COMPARISON
// ------------------------------------------------------------

bot.command(
  "comparison",
  async () => {
    await sendComparison();
  }
);

// ------------------------------------------------------------
// /LASTCRASH
// ------------------------------------------------------------

bot.command(
  "lastcrash",
  async () => {
    try {
      if (
        !fs.existsSync(
          CRASH_FILE
        )
      ) {
        await sendTelegram(
          "Aucun crash enregistré."
        );

        return;
      }

      const lines =
        fs.readFileSync(
          CRASH_FILE,
          "utf8"
        )
        .trim()
        .split("\n")
        .filter(Boolean);

      if (!lines.length) {
        await sendTelegram(
          "Aucun crash enregistré."
        );

        return;
      }

      const last =
        JSON.parse(
          lines[
            lines.length - 1
          ]
        );

      await sendTelegram(
`💥 DERNIER CRASH

${last.reason}

Token :
${last.name}

Prix :
${last.price}

Liquidité :
${formatUsd(
  last.liquidity
)}

Prix 10s :
${last.priceDrop10s?.toFixed(2) ?? "N/A"}%

Liquidité 10s :
${last.liquidityDrop10s?.toFixed(2) ?? "N/A"}%`
      );

    } catch (err) {
      await sendTelegram(
        "❌ Impossible de lire le crash."
      );
    }
  }
);

// ------------------------------------------------------------
// /HELP
// ------------------------------------------------------------

bot.command(
  "help",
  async () => {
    await sendTelegram(
`🤖 AIDE V6

/scan
🔎 Cherche un candidat.

/test MINT
🧪 Vérifie manuellement un token.

/starttrade
🚀 Lance V5.9.

/stoptrade
🛑 Arrête V5.9.

/status
📡 État du bot.

/comparison
📊 Résultats des 4 stops.

/lastcrash
💥 Dernier crash.

/help
ℹ️ Aide.`
    );
  }
);

// ============================================================
// LANCEMENT
// ============================================================

async function main() {
  console.log(
    "🚀 V6 RADAR + V5.9"
  );

  console.log(
    "🎯 Filtres :",
    "Claude/OpenAI/Anthropic"
  );

  console.log(
    "💧 Liquidité :",
    "200k-400k"
  );

  console.log(
    "👥 Holders :",
    ">=1000"
  );

  console.log(
    "⏱️ Age :",
    "<5h"
  );

  console.log(
    "🏦 DEX :",
    "PumpSwap"
  );

  await bot.launch({
    dropPendingUpdates: true,
  });

  console.log(
    "🤖 Telegram connecté"
  );

  await sendTelegram(
`🟢 V6 CORRIGÉ DÉMARRÉ

🔎 Radar automatique actif.

Filtres :
Claude / OpenAI / Anthropic
< 5 h
200k–400k $
≥ 1 000 holders
PumpSwap

🧪 V5.9 conservé.

Nouveau :
/test MINT

Simulation uniquement.`
  );

  startRadarLoop();
}

// ============================================================
// ARRÊT PROPRE
// ============================================================

process.once(
  "SIGINT",
  () => {
    stopRadarLoop();
    stopMarketLoop();
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    stopRadarLoop();
    stopMarketLoop();
    bot.stop("SIGTERM");
  }
);

main().catch(
  async (err) => {
    console.error(
      "❌ ERREUR FATALE",
      err
    );

    try {
      await sendTelegram(
`❌ V6 ERREUR FATALE

${err.message}`
      );
    } catch {}
  }
);
