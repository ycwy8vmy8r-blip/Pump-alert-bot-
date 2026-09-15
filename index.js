require("dotenv").config();

const { Telegraf } = require("telegraf");
const {
  Connection,
  PublicKey,
} = require("@solana/web3.js");

const fs = require("fs");
const path = require("path");

// ============================================================
// V6 RADAR + V5.9 SIMULATION
// ============================================================

// -------------------- ENV --------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN manquant");
if (!CHAT_ID) throw new Error("CHAT_ID manquant");
if (!HELIUS_API_KEY) throw new Error("HELIUS_API_KEY manquant");

// -------------------- SOLANA --------------------

const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  process.env.HELIUS_WSS_URL ||
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, "confirmed");

// -------------------- PROGRAMMES --------------------

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const PUMP_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// -------------------- STRATEGIE --------------------

const CAPITAL = 10;

const TARGET_PCT = 5;

const STOP_LEVELS = [-10, -15, -20, -25];

const MARKET_INTERVAL = 2000;

const RADAR_INTERVAL = 15000;

const PAIR_REFRESH_INTERVAL = 30000;

const HOLDER_REFRESH_INTERVAL = 60000;

const SESSION_MAX_MS = 45 * 60 * 1000;

const NO_NEW_BUY_MS = 43 * 60 * 1000;

const POST_SELL_COOLDOWN_MS = 30000;

const MIN_LIQUIDITY = 200000;

const MAX_LIQUIDITY = 400000;

const MIN_HOLDERS = 1000;

const MAX_AGE_MS = 5 * 60 * 60 * 1000;

const HISTORY_SECONDS = 120;

const CRASH_LIQUIDITY = 1;

const CRASH_LIQUIDITY_DROP_10S = -50;

const CRASH_PRICE_DROP_10S = -20;

// -------------------- DATA --------------------

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MARKET_FILE = path.join(
  DATA_DIR,
  "v6_market_history.jsonl"
);

const TRADE_FILE = path.join(
  DATA_DIR,
  "v6_trades.json"
);

const CRASH_FILE = path.join(
  DATA_DIR,
  "v6_crashes.json"
);

const SUMMARY_FILE = path.join(
  DATA_DIR,
  "v6_summary.json"
);

// ============================================================
// ETAT GENERAL
// ============================================================

let radarRunning = false;
let simulationRunning = false;

let radarTimer = null;
let marketTimer = null;

let radarBusy = false;
let marketBusy = false;

let currentCandidate = null;

let currentPair = null;

let lastPairRefresh = 0;

let lastHolderRefresh = 0;

let lastHolderCount = null;

let sessionStart = null;

let marketHistory = [];

let lastMarket = null;

let crashDetected = false;

let sessionStoppedReason = null;

// ============================================================
// TELEGRAM
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

async function sendTelegram(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text);
  } catch (err) {
    console.log("Telegram error:", err.message);
  }
}

// ============================================================
// UTILITAIRES
// ============================================================

function now() {
  return Date.now();
}

function ageMs(timestamp) {
  return now() - timestamp;
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000);

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return `${h}h ${m}m ${s}s`;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "N/A";

  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return null;
  }

  return ((a - b) / b) * 100;
}

function writeJsonLine(file, obj) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(obj) + "\n"
    );
  } catch (err) {
    console.log("writeJsonLine:", err.message);
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(obj, null, 2)
    );
  } catch (err) {
    console.log("writeJson:", err.message);
  }
}

// ============================================================
// NOMS RECHERCHES
// ============================================================

const TARGET_NAMES = [
  "claude",
  "openai",
  "anthropic",
];

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .trim();
}

function matchesTargetName(name, symbol) {
  const n = normalizeName(name);
  const s = normalizeName(symbol);

  return TARGET_NAMES.some((target) => {
    return (
      n === target ||
      s === target ||
      n.includes(target) ||
      s.includes(target)
    );
  });
}

// ============================================================
// DEXSCREENER
// ============================================================

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${url}`
    );
  }

  return response.json();
}

// ------------------------------------------------------------
// Recherche PumpSwap pour un mint
// ------------------------------------------------------------

async function getPumpSwapPairsForMint(mint) {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  const data = await fetchJson(url);

  const pairs = Array.isArray(data.pairs)
    ? data.pairs
    : [];

  return pairs.filter((pair) => {
    const dex = normalizeName(pair.dexId);

    const isPumpSwap =
      dex === "pumpswap" ||
      dex === "pump_amm" ||
      dex === "pumpamm" ||
      dex.includes("pump");

    const base =
      pair.baseToken?.address === mint;

    const quote =
      pair.quoteToken?.address === mint;

    return isPumpSwap && (base || quote);
  });
}

// ------------------------------------------------------------
// Choisir meilleur pair
// ------------------------------------------------------------

function chooseBestPair(pairs, mint) {
  if (!pairs.length) return null;

  const valid = pairs.filter((pair) => {
    const liquidity =
      Number(pair.liquidity?.usd || 0);

    return liquidity > 0;
  });

  if (!valid.length) return null;

  valid.sort((a, b) => {
    const la =
      Number(a.liquidity?.usd || 0);

    const lb =
      Number(b.liquidity?.usd || 0);

    return lb - la;
  });

  return valid[0];
}

// ============================================================
// SOLANA / HOLDERS
// ============================================================

// ------------------------------------------------------------
// Compter holders
// ------------------------------------------------------------

async function getHolderCount(mint) {
  try {
    const url =
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

    const body = {
      jsonrpc: "2.0",
      id: "v6-holders",
      method: "getTokenAccounts",
      params: {
        mint: mint,
        limit: 1000,
      },
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(
        `Helius holders HTTP ${response.status}`
      );
    }

    const data = await response.json();

    const accounts =
      data.result?.token_accounts ||
      data.result?.tokenAccounts ||
      [];

    const owners = new Set();

    for (const account of accounts) {
      const owner =
        account.owner ||
        account.owner_address ||
        account.ownerAddress;

      const amount = Number(
        account.amount ||
        account.token_amount ||
        account.tokenAmount ||
        0
      );

      if (owner && amount > 0) {
        owners.add(owner);
      }
    }

    return owners.size;

  } catch (err) {
    console.log(
      "⚠️ Holder check:",
      err.message
    );

    return null;
  }
}

// ============================================================
// VERIFICATION PUMPSWAP ON-CHAIN
// ============================================================

const OFFSET_BASE_MINT = 43;
const OFFSET_QUOTE_MINT = 75;
const OFFSET_BASE_VAULT = 139;
const OFFSET_QUOTE_VAULT = 171;
const OFFSET_VIRTUAL_QUOTE = 245;

function readPubkey(data, offset) {
  if (
    !data ||
    data.length < offset + 32
  ) {
    return null;
  }

  return new PublicKey(
    data.subarray(offset, offset + 32)
  ).toBase58();
}

function readI128LE(data, offset) {
  if (
    !data ||
    data.length < offset + 16
  ) {
    return 0n;
  }

  let result = 0n;

  for (let i = 15; i >= 0; i--) {
    result =
      (result << 8n) +
      BigInt(data[offset + i]);
  }

  return result;
}

async function verifyPumpSwapPool(pairAddress, mint) {
  try {
    const info = await connection.getAccountInfo(
      new PublicKey(pairAddress),
      "confirmed"
    );

    if (!info) {
      return {
        ok: false,
        reason: "POOL_NOT_FOUND",
      };
    }

    if (
      info.owner.toBase58() !==
      PUMPSWAP_PROGRAM
    ) {
      return {
        ok: false,
        reason: "OWNER_NOT_PUMPSWAP",
      };
    }

    const data = info.data;

    const baseMint =
      readPubkey(data, OFFSET_BASE_MINT);

    const quoteMint =
      readPubkey(data, OFFSET_QUOTE_MINT);

    const baseVault =
      readPubkey(data, OFFSET_BASE_VAULT);

    const quoteVault =
      readPubkey(data, OFFSET_QUOTE_VAULT);

    if (!baseMint || !quoteMint) {
      return {
        ok: false,
        reason: "INVALID_POOL_LAYOUT",
      };
    }

    if (baseMint !== mint) {
      return {
        ok: false,
        reason: "BASE_MINT_MISMATCH",
        baseMint,
      };
    }

    if (quoteMint !== WSOL_MINT) {
      return {
        ok: false,
        reason: "QUOTE_NOT_WSOL",
        quoteMint,
      };
    }

    return {
      ok: true,
      baseMint,
      quoteMint,
      baseVault,
      quoteVault,
      virtualQuote: readI128LE(
        data,
        OFFSET_VIRTUAL_QUOTE
      ),
    };

  } catch (err) {
    return {
      ok: false,
      reason: err.message,
    };
  }
}

// ============================================================
// CANDIDAT
// ============================================================

async function evaluateCandidate(pair) {
  try {
    const base = pair.baseToken || {};

    const mint =
      base.address;

    const name =
      base.name || "";

    const symbol =
      base.symbol || "";

    if (!mint) {
      return {
        ok: false,
        reason: "NO_MINT",
      };
    }

    // -------------------- NOM --------------------

    if (
      !matchesTargetName(
        name,
        symbol
      )
    ) {
      return {
        ok: false,
        reason: "NAME",
      };
    }

    // -------------------- AGE --------------------

    const pairCreated =
      Number(pair.pairCreatedAt || 0);

    if (!pairCreated) {
      return {
        ok: false,
        reason: "NO_CREATION_DATE",
      };
    }

    const createdMs =
      pairCreated;

    const age =
      now() - createdMs;

    if (
      age < 0 ||
      age > MAX_AGE_MS
    ) {
      return {
        ok: false,
        reason: "AGE",
        age,
      };
    }

    // -------------------- LIQUIDITE --------------------

    const liquidity =
      Number(
        pair.liquidity?.usd || 0
      );

    if (
      liquidity < MIN_LIQUIDITY ||
      liquidity > MAX_LIQUIDITY
    ) {
      return {
        ok: false,
        reason: "LIQUIDITY",
        liquidity,
      };
    }

    // -------------------- PUMPSWAP --------------------

    const dex =
      normalizeName(pair.dexId);

    const isPumpSwap =
      dex === "pumpswap" ||
      dex === "pump_amm" ||
      dex === "pumpamm" ||
      dex.includes("pump");

    if (!isPumpSwap) {
      return {
        ok: false,
        reason: "DEX",
      };
    }

    // -------------------- HOLDERS --------------------

    let holders =
      lastHolderCount;

    if (
      currentCandidate?.mint !== mint ||
      now() - lastHolderRefresh >
      HOLDER_REFRESH_INTERVAL
    ) {
      holders =
        await getHolderCount(mint);

      lastHolderRefresh = now();

      if (holders !== null) {
        lastHolderCount = holders;
      }
    }

    if (holders === null) {
      return {
        ok: false,
        reason: "HOLDERS_UNAVAILABLE",
      };
    }

    if (holders < MIN_HOLDERS) {
      return {
        ok: false,
        reason: "HOLDERS",
        holders,
      };
    }

    // -------------------- ON-CHAIN --------------------

    const pairAddress =
      pair.pairAddress;

    if (!pairAddress) {
      return {
        ok: false,
        reason: "NO_PAIR_ADDRESS",
      };
    }

    const onchain =
      await verifyPumpSwapPool(
        pairAddress,
        mint
      );

    if (!onchain.ok) {
      return {
        ok: false,
        reason:
          `ONCHAIN_${onchain.reason}`,
      };
    }

    return {
      ok: true,

      mint,

      name,

      symbol,

      pairAddress,

      dex: pair.dexId,

      liquidity,

      priceUsd:
        Number(
          pair.priceUsd || 0
        ),

      holders,

      ageMs: age,

      ageMinutes:
        age / 60000,

      onchain,

      pair,
    };

  } catch (err) {
    return {
      ok: false,
      reason: err.message,
    };
  }
}

// ============================================================
// RADAR
// ============================================================

// ------------------------------------------------------------
// Source de découverte
// ------------------------------------------------------------
//
// On utilise les tokens récemment apparus dans les flux
// Pump.fun disponibles publiquement.
// Le radar garde également les candidats déjà vus.
//
// ------------------------------------------------------------

async function getRecentPumpTokens() {
  const urls = [
    "https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false",
    "https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false",
  ];

  const result = [];

  for (const url of urls) {
    try {
      const data =
        await fetchJson(url);

      if (Array.isArray(data)) {
        result.push(...data);
      } else if (
        Array.isArray(data.coins)
      ) {
        result.push(...data.coins);
      }
    } catch (err) {
      console.log(
        "Pump.fun source:",
        err.message
      );
    }
  }

  const map = new Map();

  for (const token of result) {
    const mint =
      token.mint ||
      token.address;

    if (mint) {
      map.set(mint, token);
    }
  }

  return Array.from(
    map.values()
  );
}

// ------------------------------------------------------------
// Vérifier un token
// ------------------------------------------------------------

async function inspectToken(token) {
  const mint =
    token.mint ||
    token.address;

  if (!mint) return null;

  const name =
    token.name ||
    token.symbol ||
    "";

  const symbol =
    token.symbol ||
    "";

  if (
    !matchesTargetName(
      name,
      symbol
    )
  ) {
    return null;
  }

  let pairs;

  try {
    pairs =
      await getPumpSwapPairsForMint(
        mint
      );
  } catch {
    return null;
  }

  const pair =
    chooseBestPair(
      pairs,
      mint
    );

  if (!pair) {
    return null;
  }

  const candidate =
    await evaluateCandidate(
      pair
    );

  if (!candidate.ok) {
    return null;
  }

  return candidate;
}

// ------------------------------------------------------------
// Boucle radar
// ------------------------------------------------------------

async function radarTick() {
  if (!radarRunning) return;

  if (radarBusy) return;

  radarBusy = true;

  try {
    const tokens =
      await getRecentPumpTokens();

    console.log(
      `🔎 Radar: ${tokens.length} tokens examinés`
    );

    for (const token of tokens) {
      if (!radarRunning) break;

      const candidate =
        await inspectToken(token);

      if (!candidate?.ok) {
        continue;
      }

      const mint =
        candidate.mint;

      // Éviter de relancer constamment
      // exactement le même candidat.

      if (
        currentCandidate?.mint === mint &&
        simulationRunning
      ) {
        continue;
      }

      currentCandidate =
        candidate;

      await announceCandidate(
        candidate
      );

      // Pour le moment, le radar ne lance
      // PAS automatiquement la simulation.
      //
      // Le candidat est envoyé sur Telegram.
      // La commande /starttrade permet de le lancer.

      break;
    }

  } catch (err) {
    console.log(
      "❌ Radar:",
      err.message
    );
  } finally {
    radarBusy = false;
  }
}

// ============================================================
// ANNONCE CANDIDAT
// ============================================================

async function announceCandidate(candidate) {
  const text =
`🟢 CANDIDAT V6

🪙 ${candidate.name}
🔤 ${candidate.symbol}

💧 Liquidité :
${formatUsd(candidate.liquidity)}

👥 Holders :
${candidate.holders}

⏱️ Âge :
${candidate.ageMinutes.toFixed(1)} min

🏦 DEX :
${candidate.dex}

🔗 Pair :
${candidate.pairAddress}

⛓️ PumpSwap on-chain :
OK

🧪 V5.9 prêt

Mint :
${candidate.mint}

Commande :
/starttrade`;

  await sendTelegram(text);
}

// ============================================================
// MARCHE
// ============================================================

async function getCurrentMarket() {
  if (!currentCandidate) {
    return null;
  }

  const mint =
    currentCandidate.mint;

  try {
    const pairs =
      await getPumpSwapPairsForMint(
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
      Number(pair.priceUsd || 0);

    const liquidity =
      Number(
        pair.liquidity?.usd || 0
      );

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return null;
    }

    if (
      !Number.isFinite(liquidity)
    ) {
      return null;
    }

    return {
      timestamp: now(),

      mint,

      price,

      liquidity,

      dex: pair.dexId,

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

function addMarketPoint(market) {
  marketHistory.push(market);

  const cutoff =
    now() -
    HISTORY_SECONDS * 1000;

  marketHistory =
    marketHistory.filter(
      (x) =>
        x.timestamp >= cutoff
    );

  writeJsonLine(
    MARKET_FILE,
    market
  );
}

function getPointAgo(seconds) {
  const target =
    now() -
    seconds * 1000;

  let best = null;

  for (const point of marketHistory) {
    if (point.timestamp <= target) {
      best = point;
    }
  }

  return best;
}

function getPriceDrop(seconds) {
  const old =
    getPointAgo(seconds);

  if (!old || !lastMarket) {
    return null;
  }

  return pct(
    lastMarket.price,
    old.price
  );
}

function getLiquidityDrop(seconds) {
  const old =
    getPointAgo(seconds);

  if (!old || !lastMarket) {
    return null;
  }

  return pct(
    lastMarket.liquidity,
    old.liquidity
  );
}

// ============================================================
// V5.9 STRATEGIES
// ============================================================

function createStrategy(stopPct) {
  return {
    id: `STOP_${Math.abs(stopPct)}`,

    stopPct,

    capital: CAPITAL,

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
// CONDITIONS D'ENTREE
// ============================================================

function entryAllowed() {
  if (!simulationRunning) {
    return {
      ok: false,
      reason: "SIMULATION_STOPPED",
    };
  }

  if (!lastMarket) {
    return {
      ok: false,
      reason: "NO_MARKET",
    };
  }

  const sessionAge =
    now() - sessionStart;

  if (
    sessionAge >= NO_NEW_BUY_MS
  ) {
    return {
      ok: false,
      reason: "NO_NEW_BUY_43MIN",
    };
  }

  if (
    lastMarket.liquidity <
    MIN_LIQUIDITY
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_LOW",
    };
  }

  if (
    lastMarket.liquidity >
    MAX_LIQUIDITY
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_HIGH",
    };
  }

  if (
    marketHistory.length < 8
  ) {
    return {
      ok: false,
      reason: "HISTORY_WARMUP",
    };
  }

  const drop10 =
    getPriceDrop(10);

  if (
    drop10 !== null &&
    drop10 <= -5
  ) {
    return {
      ok: false,
      reason: "PRICE_TOO_WEAK",
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
      reason: "LIQUIDITY_10S_WEAK",
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
      reason: "LIQUIDITY_30S_WEAK",
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
    liq10 <= CRASH_LIQUIDITY_DROP_10S
  ) {
    return "LIQUIDITY_CRASH";
  }

  const price10 =
    getPriceDrop(10);

  if (
    price10 !== null &&
    price10 <= CRASH_PRICE_DROP_10S
  ) {
    return "PRICE_CRASH";
  }

  return null;
}

// ============================================================
// ACHAT SIMULE
// ============================================================

function simulateBuy(strategy) {
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
    (1 + TARGET_PCT / 100);

  console.log(
    `🟢 BUY SIMULÉ ${strategy.id} #${strategy.cycle}`
  );

  sendTelegram(
`🟢 BUY SIMULÉ

Stratégie : ${strategy.id}
Stop : ${strategy.stopPct}%

Cycle #${strategy.cycle}

Capital :
${formatUsd(strategy.capital)}

Prix :
${strategy.entryPrice}

Liquidité :
${formatUsd(lastMarket.liquidity)}

🎯 Vente cible :
${target}`
  );
}

// ============================================================
// VENTE SIMULEE
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
    ((exitPrice - entry) / entry) *
    100;

  const pnl =
    strategy.capital *
    (resultPct / 100);

  strategy.pnl += pnl;

  if (reason === "TARGET") {
    strategy.wins++;
  }

  if (
    reason === "STOP" ||
    reason === "CRASH"
  ) {
    strategy.losses++;
  }

  if (reason === "SESSION_LIMIT") {
    strategy.sessionLimit++;
  }

  if (reason === "CRASH") {
    strategy.crashExits++;
  }

  const trade = {
    timestamp: new Date().toISOString(),

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

  writeJsonLine(
    TRADE_FILE,
    trade
  );

  console.log(
    `🎯 SELL ${strategy.id}`,
    reason,
    resultPct.toFixed(2) + "%",
    pnl.toFixed(2)
  );

  sendTelegram(
`🎯 SELL SIMULÉ

Stratégie : ${strategy.id}
Motif : ${reason}

Cycle #${strategy.cycle}

Entrée :
${entry}

Sortie :
${exitPrice}

Résultat :
${resultPct >= 0 ? "+" : ""}${resultPct.toFixed(2)}%

P&L :
${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)} $

Total stratégie :
${strategy.pnl >= 0 ? "+" : ""}${strategy.pnl.toFixed(2)} $`
  );

  strategy.open = false;

  strategy.entryPrice = null;

  strategy.entryTime = null;

  strategy.lastSellTime =
    now();
}

// ============================================================
// STRATEGIE TICK
// ============================================================

function processStrategy(strategy) {
  if (!lastMarket) return;

  // -------------------- POSITION OUVERTE --------------------

  if (strategy.open) {
    const entry =
      strategy.entryPrice;

    const gainPct =
      ((lastMarket.price - entry) /
        entry) *
      100;

    // TARGET

    if (
      gainPct >= TARGET_PCT
    ) {
      simulateSell(
        strategy,
        "TARGET",
        lastMarket.price
      );

      return;
    }

    // STOP

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

  // -------------------- COOLDOWN --------------------

  if (
    now() - strategy.lastSellTime <
    POST_SELL_COOLDOWN_MS
  ) {
    return;
  }

  // -------------------- ENTREE --------------------

  const entry =
    entryAllowed();

  if (!entry.ok) {
    return;
  }

  simulateBuy(strategy);
}

// ============================================================
// CRASH GLOBAL
// ============================================================

async function handleCrash(reason) {
  if (crashDetected) {
    return;
  }

  crashDetected = true;

  console.log(
    "💥 CRASH :",
    reason
  );

  for (const strategy of strategies) {
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
          stopPct: s.stopPct,
          wins: s.wins,
          losses: s.losses,
          pnl: s.pnl,
          crashExits:
            s.crashExits,
        })
      ),
  };

  writeJsonLine(
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

Les positions ouvertes ont été clôturées en simulation.

Utilise :
/comparison`
  );

  simulationRunning = false;

  saveComparison();

  stopMarketLoop();
}

// ============================================================
// LIMITE 45 MIN
// ============================================================

async function handleSessionLimit() {
  if (!simulationRunning) {
    return;
  }

  const elapsed =
    now() - sessionStart;

  if (
    elapsed < SESSION_MAX_MS
  ) {
    return;
  }

  console.log(
    "⏰ LIMITE 45 MIN"
  );

  for (const strategy of strategies) {
    if (strategy.open) {
      // Règle ferme :
      // position ouverte = vente de sécurité.

      simulateSell(
        strategy,
        "SESSION_LIMIT",
        lastMarket.price
      );
    }
  }

  sessionStoppedReason =
    "SESSION_LIMIT";

  simulationRunning = false;

  saveComparison();

  await sendTelegram(
`⏰ FIN DE SESSION

45 minutes atteintes.

🔒 Toute position encore ouverte a été vendue au prix observé.

🛑 Nouvelle entrée impossible.

📊 Comparaison finale :
/comparison`
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

    // --------------------------------------------------------
    // IMPORTANT
    // On traite d'abord TARGET/STOP.
    // --------------------------------------------------------

    for (const strategy of strategies) {
      processStrategy(
        strategy
      );
    }

    // --------------------------------------------------------
    // CRASH
    // --------------------------------------------------------

    const crashReason =
      getCrashReason();

    if (crashReason) {
      await handleCrash(
        crashReason
      );

      return;
    }

    // --------------------------------------------------------
    // 45 MIN
    // --------------------------------------------------------

    await handleSessionLimit();

  } catch (err) {
    console.log(
      "❌ Market loop:",
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
    (strategy) => ({
      strategy:
        strategy.id,

      stop:
        strategy.stopPct,

      wins:
        strategy.wins,

      losses:
        strategy.losses,

      sessionLimit:
        strategy.sessionLimit,

      crashExits:
        strategy.crashExits,

      pnl:
        Number(
          strategy.pnl.toFixed(2)
        ),

      cycles:
        strategy.cycle,
    })
  );
}

function saveComparison() {
  const comparison = {
    timestamp:
      new Date().toISOString(),

    candidate:
      currentCandidate,

    sessionStart,

    sessionStoppedReason,

    strategies:
      getComparison(),
  };

  writeJson(
    SUMMARY_FILE,
    comparison
  );
}

async function sendComparison() {
  const rows =
    getComparison();

  let text =
`📊 COMPARAISON V6 / V5.9

🪙 ${currentCandidate?.name || "N/A"}
${currentCandidate?.symbol || ""}

`;

  for (const row of rows) {
    text +=
`
${row.strategy}
Stop : ${row.stop}%
Cycles : ${row.cycles}
Wins : ${row.wins}
Losses : ${row.losses}
Crash exits : ${row.crashExits}
Session limit : ${row.sessionLimit}
P&L : ${row.pnl >= 0 ? "+" : ""}${row.pnl} $
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
`📡 STATUS V6

Radar :
${radarRunning ? "🟢 ACTIF" : "🔴 ARRÊTÉ"}

Simulation :
${simulationRunning ? "🟢 ACTIVE" : "🔴 ARRÊTÉE"}

`;

  if (currentCandidate) {
    text +=
`
🪙 Candidat :
${currentCandidate.name}

🔤 ${currentCandidate.symbol}

💧 ${formatUsd(
  currentCandidate.liquidity
)}

👥 ${currentCandidate.holders}

⏱️ ${currentCandidate.ageMinutes.toFixed(1)} min

🏦 ${currentCandidate.dex}
`;
  }

  if (lastMarket) {
    text +=
`
📈 Prix :
${lastMarket.price}

💧 Liquidité :
${formatUsd(
  lastMarket.liquidity
)}
`;
  }

  if (simulationRunning) {
    text +=
`
⏱️ Session :
${formatDuration(
  now() - sessionStart
)}
`;
  }

  await sendTelegram(
    text
  );
}

// ============================================================
// DERNIER CRASH
// ============================================================

async function sendLastCrash() {
  try {
    if (!fs.existsSync(
      CRASH_FILE
    )) {
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
        lines[lines.length - 1]
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
      "Impossible de lire le dernier crash."
    );
  }
}

// ============================================================
// START SIMULATION
// ============================================================

async function startSimulation() {
  if (!currentCandidate) {
    await sendTelegram(
`❌ Aucun candidat V6 validé.

Laisse d'abord le radar trouver un token répondant aux critères.`
    );

    return;
  }

  if (simulationRunning) {
    await sendTelegram(
      "⚠️ Une simulation est déjà active."
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

  sessionStoppedReason = null;

  sessionStart =
    now();

  simulationRunning = true;

  await sendTelegram(
`🧪 V5.9 DÉMARRÉE

🪙 ${currentCandidate.name}
🔤 ${currentCandidate.symbol}

💵 Capital :
10 $ / cycle

🎯 Target :
+5%

🛑 Stops comparés :
-10%
-15%
-20%
-25%

⏱️ Session :
45 min

🚫 Aucun nouveau BUY après :
43 min

🔒 Vente de sécurité obligatoire à :
45 min

⚠️ Simulation uniquement.

Aucune transaction réelle.`
  );

  startMarketLoop();
}

// ============================================================
// STOP SIMULATION
// ============================================================

async function stopSimulation() {
  if (!simulationRunning) {
    await sendTelegram(
      "ℹ️ Aucune simulation active."
    );

    return;
  }

  for (const strategy of strategies) {
    if (strategy.open && lastMarket) {
      simulateSell(
        strategy,
        "MANUAL",
        lastMarket.price
      );

      strategy.manualExits++;
    }
  }

  simulationRunning = false;

  sessionStoppedReason =
    "MANUAL";

  saveComparison();

  stopMarketLoop();

  await sendTelegram(
`🛑 SIMULATION ARRÊTÉE

Toutes les positions ouvertes ont été clôturées en simulation.

📊 Résultats :
/comparison`
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

  radarRunning = true;

  radarTick();

  radarTimer =
    setInterval(
      radarTick,
      RADAR_INTERVAL
    );
}

function stopRadarLoop() {
  radarRunning = false;

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
// TELEGRAM COMMANDES
// ============================================================

bot.command(
  "start",
  async (ctx) => {
    await ctx.reply(
`🤖 V6 RADAR

Filtres :

• Claude / OpenAI / Anthropic
• moins de 5 heures
• liquidité 200k–400k $
• minimum 1 000 holders
• PumpSwap

🧪 V5.9 :
10 $ / cycle
+5% target
stops -10/-15/-20/-25%
45 min maximum

Commandes :

/status
/starttrade
/stoptrade
/comparison
/lastcrash
/scan
/help`
    );
  }
);

bot.command(
  "status",
  async () => {
    await sendStatus();
  }
);

bot.command(
  "scan",
  async () => {
    if (radarBusy) {
      await sendTelegram(
        "🔎 Le radar est déjà en train de scanner."
      );

      return;
    }

    await sendTelegram(
      "🔎 Scan V6 lancé..."
    );

    await radarTick();

    if (!currentCandidate) {
      await sendTelegram(
`🔴 Aucun candidat validé pour le moment.

Critères :
Claude / OpenAI / Anthropic
< 5 h
200k–400k $
≥ 1 000 holders
PumpSwap`
      );
    }
  }
);

bot.command(
  "starttrade",
  async () => {
    await startSimulation();
  }
);

bot.command(
  "stoptrade",
  async () => {
    await stopSimulation();
  }
);

bot.command(
  "comparison",
  async () => {
    await sendComparison();
  }
);

bot.command(
  "lastcrash",
  async () => {
    await sendLastCrash();
  }
);

bot.command(
  "help",
  async () => {
    await sendTelegram(
`🤖 COMMANDES V6

/scan
Cherche immédiatement un candidat.

/status
État du radar et de la simulation.

/starttrade
Lance V5.9 sur le candidat validé.

/stoptrade
Arrête la simulation.

/comparison
Compare les 4 stops.

/lastcrash
Dernier crash enregistré.

/help
Cette aide.`
    );
  }
);

// ============================================================
// LANCEMENT
// ============================================================

async function main() {
  console.log(
    "🚀 V6 RADAR + V5.9 SIMULATION"
  );

  console.log(
    "📡 RPC:",
    RPC_URL.replace(
      HELIUS_API_KEY,
      "***"
    )
  );

  console.log(
    "🎯 Filtres:",
    "Claude/OpenAI/Anthropic | <5h | 200k-400k | >=1000 holders | PumpSwap"
  );

  console.log(
    "🧪 Simulation:",
    "$10 | +5% | stops -10/-15/-20/-25%"
  );

  await bot.launch({
    dropPendingUpdates: true,
  });

  console.log(
    "🤖 Telegram connecté"
  );

  await sendTelegram(
`🟢 V6 RADAR DÉMARRÉ

🔎 Recherche automatique :

Claude / OpenAI / Anthropic
< 5 heures
200k–400k $ liquidité
≥ 1 000 holders
PumpSwap

🧪 V5.9 conservé :
10 $ / cycle
+5%
stops -10/-15/-20/-25%
45 min max
43 min cutoff

Simulation uniquement.

Le radar cherche maintenant.`
  );

  startRadarLoop();
}

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
      "❌ ERREUR FATALE:",
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
