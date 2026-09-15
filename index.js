require("dotenv").config();

const { Telegraf } = require("telegraf");
const {
  Connection,
  PublicKey,
} = require("@solana/web3.js");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

/* =========================================================
   CONFIG
========================================================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN manquant");
}

if (!CHAT_ID) {
  throw new Error("CHAT_ID manquant");
}

if (!HELIUS_API_KEY) {
  throw new Error("HELIUS_API_KEY manquant");
}

/* =========================================================
   SOLANA
========================================================= */

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(
  RPC_URL,
  {
    commitment: "processed",
  }
);

/* =========================================================
   PUMPSWAP
========================================================= */

const PUMPSWAP_PROGRAM_ID =
  new PublicKey(
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
  );

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

/*
  PumpSwap Pool layout officiel

  43  = base_mint
  75  = quote_mint
  139 = pool_base_token_account
  171 = pool_quote_token_account
  245 = virtual_quote_reserves
*/

const POOL_BASE_MINT_OFFSET = 43;
const POOL_QUOTE_MINT_OFFSET = 75;
const POOL_BASE_VAULT_OFFSET = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;
const POOL_VIRTUAL_QUOTE_OFFSET = 245;

/* =========================================================
   STRATEGIE
========================================================= */

const CAPITAL_USD = 10;
const TARGET_GAIN = 0.05;

const MARKET_INTERVAL_MS = 2000;

const OBSERVATION_AFTER_SELL_MS =
  30 * 1000;

const NO_NEW_BUY_AFTER_MS =
  43 * 60 * 1000;

const MAX_SESSION_MS =
  45 * 60 * 1000;

const MIN_LIQUIDITY_USD = 3000;

const MIN_HEALTH_SCORE = 80;

const REQUIRED_CONFIRMATIONS = 4;

/* Crash */

const CRASH_PRICE_10S = -20;
const CRASH_LIQUIDITY_10S = -50;
const CRASH_MIN_LIQUIDITY = 1;

/* Entrée */

const ENTRY_PRICE_10S = -4;
const ENTRY_LIQUIDITY_10S = -10;
const ENTRY_LIQUIDITY_30S = -15;

/* On-chain */

const LARGE_SELL_SOL = 0.5;
const ONCHAIN_PAIR_WINDOW_MS = 350;

/* =========================================================
   TELEGRAM
========================================================= */

const bot = new Telegraf(BOT_TOKEN);

/* =========================================================
   FICHIERS
========================================================= */

const DATA_DIR =
  fs.existsSync("/data")
    ? "/data"
    : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });
}

const TRADE_FILE =
  path.join(
    DATA_DIR,
    "trade_history.json"
  );

const CRASH_FILE =
  path.join(
    DATA_DIR,
    "crash_reports.json"
  );

const MARKET_FILE =
  path.join(
    DATA_DIR,
    "market_history.jsonl"
);

/* =========================================================
   ETAT
========================================================= */

let running = false;

let tokenMint = null;

let sessionStart = null;

let marketTimer = null;

let sessionTimer = null;

let ws = null;

let heliusConnected = false;

let stopReason = null;

let tickBusy = false;

let currentPosition = null;

let cyclesCompleted = 0;

let sessionProfit = 0;

let observationUntil = 0;

let noNewBuyUntil = 0;

let marketHistory = [];

let poolInfo = null;

let lastCrashReport = null;

let pendingSubscriptionTypes = [];

let wsSubscriptionIds = {
  base: null,
  quote: null,
  pool: null,
};

let onchainState = {
  lastBase: null,
  lastQuote: null,
  pendingBase: null,
  pendingQuote: null,
  lastEvent: null,
};

/* =========================================================
   UTILITAIRES
========================================================= */

function now() {
  return Date.now();
}

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return value.toFixed(10);
}

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `$${value.toFixed(4)}`;
}

function pct(current, previous) {
  if (
    previous === null ||
    previous === undefined ||
    previous === 0
  ) {
    return 0;
  }

  return (
    ((current - previous) / previous) *
    100
  );
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

async function telegram(text) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (error) {
    console.log(
      "Erreur Telegram :",
      error.message
    );
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(
        file,
        "utf8"
      )
    );
  } catch (error) {
    console.log(
      "Erreur lecture JSON :",
      error.message
    );

    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(
        data,
        null,
        2
      )
    );
  } catch (error) {
    console.log(
      "Erreur écriture JSON :",
      error.message
    );
  }
}

function appendJsonLine(file, data) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(data) + "\n"
    );
  } catch (error) {
    console.log(
      "Erreur historique :",
      error.message
    );
  }
}

/* =========================================================
   PARSING PUBKEY
========================================================= */

function readPubkey(
  buffer,
  offset
) {
  if (
    !buffer ||
    buffer.length <
      offset + 32
  ) {
    return null;
  }

  try {
    return new PublicKey(
      buffer.subarray(
        offset,
        offset + 32
      )
    ).toBase58();
  } catch (_) {
    return null;
  }
}

/* =========================================================
   I128
========================================================= */

function readI128LE(
  buffer,
  offset
) {
  try {
    if (
      buffer.length <
      offset + 16
    ) {
      return 0;
    }

    const low =
      buffer.readBigUInt64LE(
        offset
      );

    const high =
      buffer.readBigInt64LE(
        offset + 8
      );

    const value =
      high *
        18446744073709551616n +
      BigInt(low);

    return Number(value);
  } catch (_) {
    return 0;
  }
}

/* =========================================================
   PARSER POOL
========================================================= */

function parsePool(
  address,
  rawData
) {
  const buffer =
    Buffer.from(rawData);

  return {
    pool: address,

    dataLength:
      buffer.length,

    baseMint:
      readPubkey(
        buffer,
        POOL_BASE_MINT_OFFSET
      ),

    quoteMint:
      readPubkey(
        buffer,
        POOL_QUOTE_MINT_OFFSET
      ),

    baseVault:
      readPubkey(
        buffer,
        POOL_BASE_VAULT_OFFSET
      ),

    quoteVault:
      readPubkey(
        buffer,
        POOL_QUOTE_VAULT_OFFSET
      ),

    virtualQuote:
      readI128LE(
        buffer,
        POOL_VIRTUAL_QUOTE_OFFSET
      ),
  };
}

/* =========================================================
   DEXSCREENER
========================================================= */

async function getDexMarkets(
  mint
) {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  return Array.isArray(
    json.pairs
  )
    ? json.pairs
    : [];
}

/* =========================================================
   RECHERCHE DU MARCHE PUMPSWAP
========================================================= */

async function findDexPumpSwapPair(
  mint
) {
  console.log("");
  console.log(
    "========================================"
  );
  console.log(
    "🔎 RECHERCHE MARCHÉ VIA DEXSCREENER"
  );
  console.log(
    "Token :",
    mint
  );
  console.log(
    "========================================"
  );

  const pairs =
    await getDexMarkets(
      mint
    );

  console.log(
    "Marchés trouvés :",
    pairs.length
  );

  if (!pairs.length) {
    return {
      status: "NO_MARKET",
      pair: null,
      pairs: [],
    };
  }

  const pumpPairs =
    pairs.filter(
      (pair) =>
        pair &&
        pair.dexId ===
          "pump_amm" &&
        pair.baseToken &&
        pair.baseToken.address ===
          mint &&
        pair.pairAddress
    );

  console.log(
    "Marchés PumpSwap trouvés :",
    pumpPairs.length
  );

  /*
    Affichage de tous les marchés.
    Cela nous permettra de voir si un token
    n'est pas encore sur PumpSwap.
  */

  for (
    let i = 0;
    i < pairs.length;
    i++
  ) {
    const pair =
      pairs[i];

    console.log(
      `Marché #${i + 1}`
    );

    console.log(
      "DEX :",
      pair?.dexId || "N/A"
    );

    console.log(
      "Pair :",
      pair?.pairAddress || "N/A"
    );

    console.log(
      "Quote :",
      pair?.quoteToken?.symbol ||
        pair?.quoteToken?.address ||
        "N/A"
    );

    console.log(
      "Liquidity :",
      pair?.liquidity?.usd || 0
    );
  }

  if (!pumpPairs.length) {
    return {
      status: "NO_PUMPSWAP",
      pair: null,
      pairs,
    };
  }

  /*
    On prend la paire PumpSwap ayant
    la plus grosse liquidité USD.
  */

  pumpPairs.sort(
    (a, b) =>
      Number(
        b.liquidity?.usd || 0
      ) -
      Number(
        a.liquidity?.usd || 0
      )
  );

  return {
    status: "FOUND",
    pair: pumpPairs[0],
    pairs,
  };
}

/* =========================================================
   VERIFICATION DIRECTE DU POOL
========================================================= */

async function verifyPoolAddress(
  pairAddress,
  mint
) {
  console.log("");
  console.log(
    "🔗 VÉRIFICATION DIRECTE DU POOL"
  );

  console.log(
    "Pair address :",
    pairAddress
  );

  let poolPubkey;

  try {
    poolPubkey =
      new PublicKey(
        pairAddress
      );
  } catch (error) {
    return {
      ok: false,
      reason:
        "pairAddress invalide",
    };
  }

  let account;

  try {
    account =
      await connection.getAccountInfo(
        poolPubkey,
        "processed"
      );
  } catch (error) {
    return {
      ok: false,
      reason:
        `RPC getAccountInfo : ${error.message}`,
    };
  }

  if (!account) {
    return {
      ok: false,
      reason:
        "le compte du pair n'existe pas sur Solana",
    };
  }

  console.log(
    "Owner :",
    account.owner.toBase58()
  );

  if (
    !account.owner.equals(
      PUMPSWAP_PROGRAM_ID
    )
  ) {
    return {
      ok: false,
      reason:
        "le compte n'est pas possédé par PumpSwap",
    };
  }

  const parsed =
    parsePool(
      pairAddress,
      account.data
    );

  console.log(
    "Taille compte :",
    parsed.dataLength
  );

  console.log(
    "Base mint :",
    parsed.baseMint
  );

  console.log(
    "Quote mint :",
    parsed.quoteMint
  );

  console.log(
    "Base vault :",
    parsed.baseVault
  );

  console.log(
    "Quote vault :",
    parsed.quoteVault
  );

  console.log(
    "Virtual quote :",
    parsed.virtualQuote
  );

  if (
    parsed.baseMint !==
    mint
  ) {
    return {
      ok: false,
      reason:
        "base mint du pool différent du token",
      parsed,
    };
  }

  if (
    parsed.quoteMint !==
    WSOL_MINT
  ) {
    return {
      ok: false,
      reason:
        "quote mint différent de WSOL",
      parsed,
    };
  }

  if (
    !parsed.baseVault ||
    !parsed.quoteVault
  ) {
    return {
      ok: false,
      reason:
        "vault manquant",
      parsed,
    };
  }

  /*
    Vérification des vaults.
  */

  let baseBalance;

  let quoteBalance;

  try {
    const result =
      await connection.getTokenAccountBalance(
        new PublicKey(
          parsed.baseVault
        ),
        "processed"
      );

    baseBalance =
      Number(
        result.value.amount
      ) /
      Math.pow(
        10,
        result.value.decimals
      );
  } catch (error) {
    return {
      ok: false,
      reason:
        `vault base illisible : ${error.message}`,
      parsed,
    };
  }

  try {
    const result =
      await connection.getTokenAccountBalance(
        new PublicKey(
          parsed.quoteVault
        ),
        "processed"
      );

    quoteBalance =
      Number(
        result.value.amount
      ) /
      Math.pow(
        10,
        result.value.decimals
      );
  } catch (error) {
    return {
      ok: false,
      reason:
        `vault quote illisible : ${error.message}`,
      parsed,
    };
  }

  const virtualQuoteSol =
    parsed.virtualQuote /
    1e9;

  const effectiveQuote =
    quoteBalance +
    virtualQuoteSol;

  console.log(
    "Réserve quote :",
    quoteBalance,
    "SOL"
  );

  console.log(
    "Virtual quote :",
    virtualQuoteSol,
    "SOL"
  );

  console.log(
    "Réserve effective :",
    effectiveQuote,
    "SOL"
  );

  if (
    !Number.isFinite(
      effectiveQuote
    ) ||
    effectiveQuote <= 0
  ) {
    return {
      ok: false,
      reason:
        "réserve SOL effective invalide",
      parsed,
    };
  }

  return {
    ok: true,

    pool: pairAddress,

    baseMint:
      parsed.baseMint,

    quoteMint:
      parsed.quoteMint,

    baseVault:
      parsed.baseVault,

    quoteVault:
      parsed.quoteVault,

    virtualQuote:
      parsed.virtualQuote,

    baseBalance,

    quoteBalance,

    effectiveQuote,
  };
}

/* =========================================================
   DECOUVERTE COMPLETE DU POOL
========================================================= */

async function discoverPool(
  mint
) {
  const market =
    await findDexPumpSwapPair(
      mint
    );

  if (
    market.status ===
    "NO_MARKET"
  ) {
    return {
      ok: false,
      status: "NO_MARKET",
      reason:
        "aucun marché trouvé sur DexScreener",
    };
  }

  if (
    market.status ===
    "NO_PUMPSWAP"
  ) {
    return {
      ok: false,
      status: "NO_PUMPSWAP",
      reason:
        "aucun marché PumpSwap trouvé",
      pairs:
        market.pairs,
    };
  }

  /*
    Il peut y avoir plusieurs marchés PumpSwap.
    On essaie chacun jusqu'à trouver un pool
    directement confirmé sur Solana.
  */

  const candidates =
    market.pairs
      .filter(
        (pair) =>
          pair &&
          pair.dexId ===
            "pump_amm" &&
          pair.baseToken &&
          pair.baseToken.address ===
            mint &&
          pair.pairAddress
      )
      .sort(
        (a, b) =>
          Number(
            b.liquidity?.usd || 0
          ) -
          Number(
            a.liquidity?.usd || 0
          )
      );

  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {
    const pair =
      candidates[i];

    console.log("");
    console.log(
      `🔎 CANDIDAT PUMPSWAP #${i + 1}`
    );

    console.log(
      "Pair :",
      pair.pairAddress
    );

    console.log(
      "Liquidité Dex :",
      formatUsd(
        Number(
          pair.liquidity?.usd || 0
        )
      )
    );

    const verified =
      await verifyPoolAddress(
        pair.pairAddress,
        mint
      );

    if (verified.ok) {
      return {
        ...verified,

        dexPair: pair,
      };
    }

    console.log(
      "❌ Pool rejeté :",
      verified.reason
    );
  }

  return {
    ok: false,
    status: "NO_VALID_POOL",
    reason:
      "aucun marché PumpSwap n'a pu être confirmé directement sur Solana",
  };
}

/* =========================================================
   MARKET DATA
========================================================= */

async function getMarketData(
  mint
) {
  const market =
    await findDexPumpSwapPair(
      mint
    );

  if (
    market.status !==
    "FOUND"
  ) {
    return null;
  }

  const pair =
    market.pair;

  return {
    price:
      Number(
        pair.priceUsd || 0
      ),

    liquidity:
      Number(
        pair.liquidity?.usd || 0
      ),

    pairAddress:
      pair.pairAddress ||
      null,

    volume24h:
      Number(
        pair.volume?.h24 || 0
      ),

    buys5m:
      Number(
        pair.txns?.m5?.buys || 0
      ),

    sells5m:
      Number(
        pair.txns?.m5?.sells || 0
      ),
  };
}

/* =========================================================
   HISTORIQUE MARCHE
========================================================= */

function addMarketPoint(
  data
) {
  const point = {
    timestamp:
      now(),

    price:
      data.price,

    liquidity:
      data.liquidity,

    pairAddress:
      data.pairAddress,

    volume24h:
      data.volume24h,

    buys5m:
      data.buys5m,

    sells5m:
      data.sells5m,
  };

  marketHistory.push(
    point
  );

  const cutoff =
    now() - 120000;

  marketHistory =
    marketHistory.filter(
      (item) =>
        item.timestamp >=
        cutoff
    );

  appendJsonLine(
    MARKET_FILE,
    {
      mint: tokenMint,
      ...point,
    }
  );
}

function getPointAgo(
  milliseconds
) {
  const target =
    now() -
    milliseconds;

  for (
    let i =
      marketHistory.length - 1;
    i >= 0;
    i--
  ) {
    if (
      marketHistory[i]
        .timestamp <= target
    ) {
      return marketHistory[i];
    }
  }

  return null;
}

/* =========================================================
   SCORE
========================================================= */

function calculateHealthScore(
  data
) {
  let score = 100;

  const p10 =
    pct(
      data.price,
      getPointAgo(10000)
        ?.price
    );

  const l10 =
    pct(
      data.liquidity,
      getPointAgo(10000)
        ?.liquidity
    );

  const l30 =
    pct(
      data.liquidity,
      getPointAgo(30000)
        ?.liquidity
    );

  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    score -= 40;
  } else if (
    data.liquidity <
    MIN_LIQUIDITY_USD * 2
  ) {
    score -= 10;
  }

  if (p10 <= -4) {
    score -= 20;
  }

  if (p10 <= -8) {
    score -= 20;
  }

  if (l10 <= -10) {
    score -= 20;
  }

  if (l10 <= -20) {
    score -= 20;
  }

  if (l30 <= -15) {
    score -= 20;
  }

  const buys =
    Number(
      data.buys5m || 0
    );

  const sells =
    Number(
      data.sells5m || 0
    );

  if (
    sells >
      buys * 1.5 &&
    sells > 20
  ) {
    score -= 10;
  }

  if (
    buys >
      sells * 1.5 &&
    buys > 20
  ) {
    score += 5;
  }

  return clamp(
    Math.round(score),
    0,
    100
  );
}

/* =========================================================
   CRASH
========================================================= */

function getCrashSignals(
  data
) {
  const reasons = [];

  const p10 =
    pct(
      data.price,
      getPointAgo(10000)
        ?.price
    );

  const l10 =
    pct(
      data.liquidity,
      getPointAgo(10000)
        ?.liquidity
    );

  if (
    data.liquidity <=
    CRASH_MIN_LIQUIDITY
  ) {
    reasons.push(
      "liquidité quasi nulle"
    );
  }

  if (
    l10 <=
    CRASH_LIQUIDITY_10S
  ) {
    reasons.push(
      `liquidité ${l10.toFixed(2)}% / 10s`
    );
  }

  if (
    p10 <=
    CRASH_PRICE_10S
  ) {
    reasons.push(
      `prix ${p10.toFixed(2)}% / 10s`
    );
  }

  return {
    crash:
      reasons.length > 0,

    reasons,

    p10,

    l10,
  };
}

/* =========================================================
   ENTREE
========================================================= */

function entryCheck(
  data
) {
  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    return {
      ok: false,
      reason:
        `liquidité trop faible : ${formatUsd(data.liquidity)}`,
    };
  }

  const p10 =
    pct(
      data.price,
      getPointAgo(10000)
        ?.price
    );

  const l10 =
    pct(
      data.liquidity,
      getPointAgo(10000)
        ?.liquidity
    );

  const l30 =
    pct(
      data.liquidity,
      getPointAgo(30000)
        ?.liquidity
    );

  if (
    p10 <=
    ENTRY_PRICE_10S
  ) {
    return {
      ok: false,
      reason:
        `prix ${p10.toFixed(2)}% / 10s`,
    };
  }

  if (
    l10 <=
    ENTRY_LIQUIDITY_10S
  ) {
    return {
      ok: false,
      reason:
        `liquidité ${l10.toFixed(2)}% / 10s`,
    };
  }

  if (
    l30 <=
    ENTRY_LIQUIDITY_30S
  ) {
    return {
      ok: false,
      reason:
        `liquidité ${l30.toFixed(2)}% / 30s`,
    };
  }

  const score =
    calculateHealthScore(
      data
    );

  if (
    score <
    MIN_HEALTH_SCORE
  ) {
    return {
      ok: false,
      reason:
        `score ${score}/100`,
    };
  }

  return {
    ok: true,
    reason: "OK",
  };
}

function healthyConfirmation() {
  if (
    marketHistory.length <
    REQUIRED_CONFIRMATIONS
  ) {
    return 0;
  }

  const recent =
    marketHistory.slice(
      -REQUIRED_CONFIRMATIONS
    );

  let count = 0;

  for (
    const point of recent
  ) {
    if (
      calculateHealthScore(
        point
      ) >=
      MIN_HEALTH_SCORE
    ) {
      count++;
    }
  }

  return count;
}

/* =========================================================
   ACHAT
========================================================= */

async function simulateBuy(
  data
) {
  if (currentPosition) {
    return;
  }

  if (
    now() <
    observationUntil
  ) {
    return;
  }

  if (
    now() >=
    noNewBuyUntil
  ) {
    return;
  }

  if (!poolInfo) {
    return;
  }

  const check =
    entryCheck(data);

  if (!check.ok) {
    return;
  }

  const confirmations =
    healthyConfirmation();

  if (
    confirmations <
    REQUIRED_CONFIRMATIONS
  ) {
    return;
  }

  const tokens =
    CAPITAL_USD /
    data.price;

  const targetPrice =
    data.price *
    (1 + TARGET_GAIN);

  currentPosition = {
    cycle:
      cyclesCompleted + 1,

    entryPrice:
      data.price,

    tokens,

    capital:
      CAPITAL_USD,

    targetPrice,

    entryLiquidity:
      data.liquidity,

    entryTimestamp:
      now(),
  };

  console.log("");
  console.log(
    "🟢 ACHAT TEST V5.6"
  );

  console.log(
    "Cycle :",
    currentPosition.cycle
  );

  console.log(
    "Token :",
    tokenMint
  );

  console.log(
    "Mise fixe :",
    formatUsd(
      CAPITAL_USD
    )
  );

  console.log(
    "Prix :",
    formatPrice(
      data.price
    )
  );

  console.log(
    "Tokens :",
    tokens.toFixed(8)
  );

  console.log(
    "Prix cible :",
    formatPrice(
      targetPrice
    )
  );

  console.log(
    "Liquidité :",
    formatUsd(
      data.liquidity
    )
  );

  console.log(
    "Score :",
    calculateHealthScore(
      data
    ) + "/100"
  );

  console.log(
    "Pool :",
    poolInfo.pool
  );

  await telegram(
`🟢 ACHAT TEST V5.6

Token :
${tokenMint}

Cycle :
#${currentPosition.cycle}

Mise fixe :
$${CAPITAL_USD.toFixed(4)}

Prix :
${formatPrice(data.price)}

Tokens :
${tokens.toFixed(8)}

🎯 Objectif :
+${(TARGET_GAIN * 100).toFixed(2)}%

Prix cible :
${formatPrice(targetPrice)}

💧 Liquidité :
${formatUsd(data.liquidity)}

🧠 Score :
${calculateHealthScore(data)}/100

🔗 Pool PumpSwap :
${poolInfo.pool}

🧪 Simulation uniquement.`
  );
}

/* =========================================================
   VENTE OBJECTIF
========================================================= */

async function simulateTargetSell(
  data
) {
  if (!currentPosition) {
    return;
  }

  if (
    data.price <
    currentPosition.targetPrice
  ) {
    return;
  }

  const position =
    currentPosition;

  const exitPrice =
    position.targetPrice;

  const amount =
    position.tokens *
    exitPrice;

  const profit =
    amount -
    position.capital;

  cyclesCompleted++;

  sessionProfit +=
    profit;

  saveTrade({
    type:
      "TARGET_SELL",

    timestamp:
      new Date().toISOString(),

    mint:
      tokenMint,

    cycle:
      position.cycle,

    entryPrice:
      position.entryPrice,

    exitPrice,

    capital:
      position.capital,

    amount,

    profit,

    sessionProfit,

    pool:
      poolInfo?.pool ||
      null,
  });

  currentPosition =
    null;

  observationUntil =
    now() +
    OBSERVATION_AFTER_SELL_MS;

  console.log("");
  console.log(
    "🔴 VENTE TEST V5.6"
  );

  console.log(
    "Cycle :",
    position.cycle
  );

  console.log(
    "Prix vente :",
    formatPrice(
      exitPrice
    )
  );

  console.log(
    "Résultat :",
    `+${((profit / CAPITAL_USD) * 100).toFixed(2)}%`
  );

  console.log(
    "Bénéfice :",
    `+$${profit.toFixed(4)}`
  );

  console.log(
    "Cumul :",
    `+$${sessionProfit.toFixed(4)}`
  );

  await telegram(
`🔴 VENTE TEST V5.6

Cycle :
#${position.cycle}

Token :
${tokenMint}

Prix :
${formatPrice(exitPrice)}

Montant simulé :
$${amount.toFixed(4)}

Résultat :
+${((profit / CAPITAL_USD) * 100).toFixed(2)}%

Bénéfice :
+$${profit.toFixed(4)}

💰 Bénéfices cumulés :
+$${sessionProfit.toFixed(4)}

🛡️ Observation sécurité :
30 secondes

❌ Aucun rachat immédiat.

🧪 Simulation uniquement.`
  );
}

/* =========================================================
   SORTIE SECURITE 45 MIN
========================================================= */

async function forceSessionExit(
  data
) {
  if (!currentPosition) {
    return;
  }

  const position =
    currentPosition;

  const exitPrice =
    data.price;

  const amount =
    position.tokens *
    exitPrice;

  const profit =
    amount -
    position.capital;

  cyclesCompleted++;

  sessionProfit +=
    profit;

  saveTrade({
    type:
      "SESSION_LIMIT",

    timestamp:
      new Date().toISOString(),

    mint:
      tokenMint,

    cycle:
      position.cycle,

    entryPrice:
      position.entryPrice,

    exitPrice,

    capital:
      position.capital,

    amount,

    profit,

    sessionProfit,

    pool:
      poolInfo?.pool ||
      null,
  });

  currentPosition =
    null;

  console.log("");
  console.log(
    "🛑 SORTIE SECURITE 45 MIN"
  );

  console.log(
    "Cycle :",
    position.cycle
  );

  console.log(
    "Prix entrée :",
    formatPrice(
      position.entryPrice
    )
  );

  console.log(
    "Prix sortie :",
    formatPrice(
      exitPrice
    )
  );

  console.log(
    "Résultat :",
    `${((profit / CAPITAL_USD) * 100).toFixed(2)}%`
  );

  await telegram(
`🛑 SORTIE SECURITE 45 MIN

Token :
${tokenMint}

Cycle :
#${position.cycle}

Prix entrée :
${formatPrice(position.entryPrice)}

Prix sortie :
${formatPrice(exitPrice)}

Résultat :
${((profit / CAPITAL_USD) * 100).toFixed(2)}%

Résultat simulé :
${profit >= 0 ? "+" : ""}$${profit.toFixed(4)}

💰 Résultat session :
${sessionProfit >= 0 ? "+" : ""}$${sessionProfit.toFixed(4)}

⛔ Session arrêtée.

🧪 Simulation uniquement.`
  );
}

/* =========================================================
   CRASH
========================================================= */

async function triggerCrash(
  data,
  crash
) {
  if (!running) {
    return;
  }

  stopReason =
    "CRASH";

  const report = {
    id:
      `crash_${Date.now()}`,

    timestamp:
      new Date().toISOString(),

    sessionStart:
      sessionStart
        ? new Date(
            sessionStart
          ).toISOString()
        : null,

    mint:
      tokenMint,

    cyclesCompleted,

    sessionProfit,

    crashMarket: {
      price:
        data.price,

      liquidity:
        data.liquidity,

      priceChange10s:
        crash.p10,

      liquidityChange10s:
        crash.l10,

      score:
        calculateHealthScore(
          data
        ),
    },

    reasons:
      crash.reasons,

    openPosition:
      currentPosition,

    pool:
      poolInfo,
  };

  lastCrashReport =
    report;

  const reports =
    readJson(
      CRASH_FILE,
      []
    );

  reports.push(
    report
  );

  writeJson(
    CRASH_FILE,
    reports
  );

  console.log("");
  console.log(
    "🚨 STOP CRASH V5.6"
  );

  console.log(
    "Prix :",
    formatPrice(
      data.price
    )
  );

  console.log(
    "Variation prix :",
    crash.p10.toFixed(2) +
      "%"
  );

  console.log(
    "Liquidité :",
    formatUsd(
      data.liquidity
    )
  );

  console.log(
    "Variation liquidité :",
    crash.l10.toFixed(2) +
      "%"
  );

  if (currentPosition) {
    console.log(
      "⚠️ Position ouverte."
    );

    console.log(
      "⚠️ Pas de liquidation fictive."
    );
  }

  await telegram(
`🚨 STOP CRASH - MODE TEST V5.6

Token :
${tokenMint}

Prix :
${formatPrice(data.price)}

Variation prix ~10s :
${crash.p10.toFixed(2)}%

Liquidité :
${formatUsd(data.liquidity)}

Variation liquidité ~10s :
${crash.l10.toFixed(2)}%

🧠 Score :
${calculateHealthScore(data)}/100

⚠️ Signaux :
${crash.reasons
  .map(
    (r) => `• ${r}`
  )
  .join("\n")}

${
  currentPosition
    ? `⚠️ Position restante :
${currentPosition.tokens}

⚠️ Prix de sortie non considéré fiable.
⚠️ Aucun bénéfice fictif ajouté.`
    : "Aucune position ouverte."
}

⛔ NOUVEAU CYCLE BLOQUÉ
⛔ RADAR ARRÊTÉ

Cycles :
${cyclesCompleted}

💰 Bénéfices simulés :
$${sessionProfit.toFixed(4)}

🧪 Simulation uniquement.`
  );

  stopSession();
}

/* =========================================================
   ON-CHAIN
========================================================= */

function startOnchainMonitoring() {
  if (!poolInfo) {
    return;
  }

  try {
    ws =
      new WebSocket(
        WSS_URL
      );

    ws.on(
      "open",
      () => {
        heliusConnected =
          true;

        console.log(
          "⛓️ Helius WebSocket connecté"
        );

        subscribeAccount(
          "base",
          poolInfo.baseVault
        );

        subscribeAccount(
          "quote",
          poolInfo.quoteVault
        );

        subscribeAccount(
          "pool",
          poolInfo.pool
        );
      }
    );

    ws.on(
      "message",
      (raw) => {
        try {
          const message =
            JSON.parse(
              raw.toString()
            );

          handleWebSocketMessage(
            message
          );
        } catch (error) {
          console.log(
            "Erreur message WS :",
            error.message
          );
        }
      }
    );

    ws.on(
      "close",
      () => {
        heliusConnected =
          false;

        console.log(
          "⛓️ Helius WebSocket fermé"
        );
      }
    );

    ws.on(
      "error",
      (error) => {
        heliusConnected =
          false;

        console.log(
          "⚠️ Helius WS :",
          error.message
        );
      }
    );
  } catch (error) {
    console.log(
      "❌ Erreur démarrage WS :",
      error.message
    );
  }
}

/* =========================================================
   SUBSCRIBE
========================================================= */

function subscribeAccount(
  type,
  address
) {
  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  const id =
    Date.now() +
    Math.floor(
      Math.random() * 100000
    );

  const request = {
    jsonrpc:
      "2.0",

    id,

    method:
      "accountSubscribe",

    params: [
      address,
      {
        encoding:
          "base64",

        commitment:
          "processed",
      },
    ],
  };

  pendingSubscriptionTypes.push(
    type
  );

  ws.send(
    JSON.stringify(
      request
    )
  );
}

/* =========================================================
   MESSAGE WS
========================================================= */

function handleWebSocketMessage(
  message
) {
  if (
    message.result !==
      undefined &&
    message.id !==
      undefined
  ) {
    const type =
      pendingSubscriptionTypes.shift();

    if (type) {
      wsSubscriptionIds[
        type
      ] =
        message.result;

      console.log(
        `⛓️ Subscription ${type} :`,
        message.result
      );
    }

    return;
  }

  if (
    message.method !==
    "accountNotification"
  ) {
    return;
  }

  const subscription =
    message.params
      ?.subscription;

  const value =
    message.params
      ?.result?.value;

  const context =
    message.params
      ?.result?.context;

  if (
    subscription ===
      undefined ||
    !value
  ) {
    return;
  }

  const data =
    value.data;

  if (
    !Array.isArray(data) ||
    !data[0]
  ) {
    return;
  }

  const raw =
    Buffer.from(
      data[0],
      "base64"
    );

  let type =
    null;

  if (
    subscription ===
    wsSubscriptionIds.base
  ) {
    type = "base";
  }

  if (
    subscription ===
    wsSubscriptionIds.quote
  ) {
    type = "quote";
  }

  if (
    subscription ===
    wsSubscriptionIds.pool
  ) {
    type = "pool";
  }

  const slot =
    Number(
      context?.slot || 0
    );

  if (type === "base") {
    processBaseUpdate(
      raw,
      slot
    );
  }

  if (type === "quote") {
    processQuoteUpdate(
      raw,
      slot
    );
  }

  if (type === "pool") {
    processPoolUpdate(
      raw
    );
  }
}

/* =========================================================
   TOKEN ACCOUNT BALANCE
========================================================= */

function readTokenAmount(
  raw
) {
  try {
    if (
      raw.length < 72
    ) {
      return null;
    }

    return Number(
      raw.readBigUInt64LE(
        64
      )
    );
  } catch (_) {
    return null;
  }
}

/* =========================================================
   BASE
========================================================= */

function processBaseUpdate(
  raw,
  slot
) {
  const amount =
    readTokenAmount(
      raw
    );

  if (
    amount === null
  ) {
    return;
  }

  onchainState.pendingBase = {
    amount,
    slot,
    timestamp:
      now(),
  };

  tryPairOnchainChanges();
}

/* =========================================================
   QUOTE
========================================================= */

function processQuoteUpdate(
  raw,
  slot
) {
  const amount =
    readTokenAmount(
      raw
    );

  if (
    amount === null
  ) {
    return;
  }

  onchainState.pendingQuote = {
    amount,
    slot,
    timestamp:
      now(),
  };

  tryPairOnchainChanges();
}

/* =========================================================
   POOL UPDATE
========================================================= */

function processPoolUpdate(
  raw
) {
  if (
    !poolInfo
  ) {
    return;
  }

  if (
    raw.length >=
    POOL_VIRTUAL_QUOTE_OFFSET +
      16
  ) {
    const virtualQuote =
      readI128LE(
        raw,
        POOL_VIRTUAL_QUOTE_OFFSET
      );

    poolInfo.virtualQuote =
      virtualQuote;
  }
}

/* =========================================================
   EVENEMENTS ON-CHAIN
========================================================= */

function tryPairOnchainChanges() {
  const base =
    onchainState.pendingBase;

  const quote =
    onchainState.pendingQuote;

  if (
    !base ||
    !quote
  ) {
    return;
  }

  const timeDiff =
    Math.abs(
      base.timestamp -
        quote.timestamp
    );

  if (
    timeDiff >
    ONCHAIN_PAIR_WINDOW_MS
  ) {
    return;
  }

  const previous =
    onchainState.lastEvent;

  if (!previous) {
    onchainState.lastEvent = {
      baseAmount:
        base.amount,

      quoteAmount:
        quote.amount,

      slot:
        Math.max(
          base.slot,
          quote.slot
        ),

      timestamp:
        now(),
    };

    onchainState.pendingBase =
      null;

    onchainState.pendingQuote =
      null;

    return;
  }

  const baseDelta =
    base.amount -
    previous.baseAmount;

  const quoteDelta =
    quote.amount -
    previous.quoteAmount;

  let type =
    "UNKNOWN";

  if (
    baseDelta < 0 &&
    quoteDelta > 0
  ) {
    type = "SELL";
  } else if (
    baseDelta > 0 &&
    quoteDelta < 0
  ) {
    type = "BUY";
  } else if (
    baseDelta < 0 &&
    quoteDelta < 0
  ) {
    type = "WITHDRAWAL";
  } else if (
    baseDelta > 0 &&
    quoteDelta > 0
  ) {
    type = "ADD_LIQUIDITY";
  }

  const quoteSol =
    Math.abs(
      quoteDelta
    ) / 1e9;

  if (
    type !== "UNKNOWN"
  ) {
    console.log("");
    console.log(
      "⛓️ EVENT PUMPSWAP"
    );

    console.log(
      "Type :",
      type
    );

    console.log(
      "Base delta :",
      baseDelta
    );

    console.log(
      "Quote delta :",
      quoteSol.toFixed(6),
      "SOL"
    );

    console.log(
      "Slot :",
      Math.max(
        base.slot,
        quote.slot
      )
    );
  }

  if (
    running &&
    type ===
      "WITHDRAWAL"
  ) {
    triggerOnchainProtection(
      type,
      quoteSol
    );
  }

  if (
    running &&
    type ===
      "SELL" &&
    quoteSol >=
      LARGE_SELL_SOL
  ) {
    triggerOnchainProtection(
      type,
      quoteSol
    );
  }

  onchainState.lastEvent = {
    baseAmount:
      base.amount,

    quoteAmount:
      quote.amount,

    slot:
      Math.max(
        base.slot,
        quote.slot
      ),

    timestamp:
      now(),
  };

  onchainState.pendingBase =
    null;

  onchainState.pendingQuote =
    null;
}

/* =========================================================
   PROTECTION ON-CHAIN
========================================================= */

async function triggerOnchainProtection(
  type,
  quoteSol
) {
  if (!running) {
    return;
  }

  if (stopReason) {
    return;
  }

  stopReason =
    "ONCHAIN_RISK";

  await telegram(
`🚨 PROTECTION ON-CHAIN V5.6

Token :
${tokenMint}

Type :
${type}

Variation quote :
${quoteSol.toFixed(6)} SOL

${
  currentPosition
    ? `⚠️ Position ouverte :
Cycle #${currentPosition.cycle}

⚠️ Aucune vente fictive.
Prix de sortie non considéré fiable.`
    : "Aucune position ouverte."
}

⛔ NOUVEAU CYCLE BLOQUÉ
⛔ SURVEILLANCE ARRÊTÉE

🧪 Simulation uniquement.`
  );

  stopSession();
}

/* =========================================================
   MARKET TICK
========================================================= */

async function marketTick() {
  if (!running) {
    return;
  }

  if (tickBusy) {
    return;
  }

  tickBusy = true;

  try {
    const data =
      await getMarketData(
        tokenMint
      );

    if (!data) {
      return;
    }

    if (
      !Number.isFinite(
        data.price
      ) ||
      data.price <= 0
    ) {
      return;
    }

    addMarketPoint(
      data
    );

    const crash =
      getCrashSignals(
        data
      );

    if (
      crash.crash
    ) {
      await triggerCrash(
        data,
        crash
      );

      return;
    }

    if (
      currentPosition
    ) {
      await simulateTargetSell(
        data
      );

      return;
    }

    if (
      now() <
      observationUntil
    ) {
      return;
    }

    if (
      now() >=
      noNewBuyUntil
    ) {
      return;
    }

    await simulateBuy(
      data
    );
  } catch (error) {
    console.log(
      "⚠️ Erreur market tick :",
      error.message
    );
  } finally {
    tickBusy = false;
  }
}

/* =========================================================
   LIMITE 45 MIN
========================================================= */

async function sessionLimitReached() {
  if (!running) {
    return;
  }

  console.log("");
  console.log(
    "⏱️ LIMITE SESSION 45 MIN"
  );

  /*
    Position ouverte :
    sortie de sécurité obligatoire.
  */

  if (
    currentPosition
  ) {
    try {
      const data =
        await getMarketData(
          tokenMint
        );

      if (
        data &&
        Number.isFinite(
          data.price
        ) &&
        data.price > 0
      ) {
        await forceSessionExit(
          data
        );
      } else {
        await telegram(
`⚠️ LIMITE 45 MIN

Token :
${tokenMint}

Position ouverte mais prix indisponible.

⚠️ Aucun résultat fictif ajouté.

⛔ Session arrêtée.`
        );
      }
    } catch (error) {
      console.log(
        "Erreur sortie 45 min :",
        error.message
      );

      await telegram(
`⚠️ LIMITE 45 MIN

Token :
${tokenMint}

Impossible d'obtenir un prix de sortie fiable.

⚠️ Aucun résultat fictif ajouté.

⛔ Session arrêtée.`
      );
    }
  }

  stopReason =
    "SESSION_LIMIT";

  await telegram(
`⏱️ SESSION V5.6 TERMINÉE

Token :
${tokenMint}

Cycles :
${cyclesCompleted}

💰 Résultat session :
${sessionProfit >= 0 ? "+" : ""}$${sessionProfit.toFixed(4)}

⛔ Arrêt après 45 minutes.

🧪 Simulation uniquement.`
  );

  stopSession();
}

/* =========================================================
   DEMARRAGE
========================================================= */

async function startSession(
  mint
) {
  if (running) {
    await telegram(
`⚠️ Une session est déjà active.

Token :
${tokenMint}

Utilise /stoptrade d'abord.`
    );

    return;
  }

  try {
    tokenMint =
      new PublicKey(
        mint.trim()
      ).toBase58();
  } catch (_) {
    await telegram(
`❌ Adresse token invalide.

Token :
${mint}`
    );

    return;
  }

  running = true;

  stopReason =
    null;

  sessionStart =
    now();

  cyclesCompleted = 0;

  sessionProfit = 0;

  currentPosition =
    null;

  observationUntil = 0;

  noNewBuyUntil =
    sessionStart +
    NO_NEW_BUY_AFTER_MS;

  marketHistory = [];

  poolInfo =
    null;

  heliusConnected =
    false;

  pendingSubscriptionTypes =
    [];

  wsSubscriptionIds = {
    base: null,
    quote: null,
    pool: null,
  };

  onchainState = {
    lastBase: null,
    lastQuote: null,
    pendingBase: null,
    pendingQuote: null,
    lastEvent: null,
  };

  console.log("");
  console.log(
    "🚀 V5.6 DÉMARRÉE"
  );

  await telegram(
`🚀 V5.6 DÉMARRÉE

Token :
${tokenMint}

💵 Capital :
$${CAPITAL_USD.toFixed(2)}

🎯 Objectif :
+${TARGET_GAIN * 100}%

🔎 Méthode :
DexScreener → PumpSwap → Solana

⛓️ Surveillance :
Vault token + vault SOL

⏳ Observation après vente :
30 secondes

⏱️ Aucun nouvel achat après :
43 minutes

🛑 Limite session :
45 minutes

🧪 SIMULATION UNIQUEMENT

🔎 Recherche du marché...`
  );

  /*
    NOUVELLE METHODE V5.6 :
    DexScreener trouve la paire,
    puis Solana confirme le pool.
  */

  const discovered =
    await discoverPool(
      tokenMint
    );

  if (!discovered.ok) {
    running = false;

    stopReason =
      discovered.status ||
      "NO_POOL";

    console.log("");
    console.log(
      "❌ V5.6 ARRÊTÉE"
    );

    console.log(
      "Raison :",
      discovered.reason
    );

    let message =
`❌ V5.6 ARRÊTÉE

Token :
${tokenMint}

`;

    if (
      discovered.status ===
      "NO_MARKET"
    ) {
      message +=
`🟡 Aucun marché trouvé sur DexScreener.

Le token n'est peut-être pas encore tradable/indexé.`;
    } else if (
      discovered.status ===
      "NO_PUMPSWAP"
    ) {
      message +=
`🟡 Aucun marché PumpSwap détecté.

Le token peut être encore sur la bonding curve Pump.fun,
ou être négocié sur un autre DEX.`;
    } else {
      message +=
`🔴 Marché PumpSwap trouvé,
mais aucun pool n'a pu être confirmé directement sur Solana.

Raison :
${discovered.reason}`;
    }

    message +=
`

⛔ Surveillance on-chain NON lancée.`;

    await telegram(
      message
    );

    return;
  }

  poolInfo =
    discovered;

  console.log("");
  console.log(
    "========================================"
  );

  console.log(
    "✅ POOL PUMPSWAP CONFIRMÉ"
  );

  console.log(
    "Pool :",
    poolInfo.pool
  );

  console.log(
    "Base vault :",
    poolInfo.baseVault
  );

  console.log(
    "Quote vault :",
    poolInfo.quoteVault
  );

  console.log(
    "Réserve SOL :",
    poolInfo.effectiveQuote
  );

  console.log(
    "========================================"
  );

  await telegram(
`✅ POOL PUMPSWAP CONFIRMÉ

Pool :
${poolInfo.pool}

Base vault :
${poolInfo.baseVault}

Quote vault :
${poolInfo.quoteVault}

💧 Réserve SOL :
${poolInfo.effectiveQuote.toFixed(4)} SOL

⛓️ Vérification Solana :
OK

📡 Surveillance on-chain :
DÉMARRAGE

📊 Marché :
DexScreener

⏱️ Session :
45 minutes`
  );

  startOnchainMonitoring();

  await new Promise(
    (resolve) =>
      setTimeout(
        resolve,
        1000
      )
  );

  if (!running) {
    return;
  }

  await marketTick();

  marketTimer =
    setInterval(
      marketTick,
      MARKET_INTERVAL_MS
    );

  sessionTimer =
    setTimeout(
      sessionLimitReached,
      MAX_SESSION_MS
    );
}

/* =========================================================
   STOP
========================================================= */

function stopSession() {
  if (
    marketTimer
  ) {
    clearInterval(
      marketTimer
    );

    marketTimer =
      null;
  }

  if (
    sessionTimer
  ) {
    clearTimeout(
      sessionTimer
    );

    sessionTimer =
      null;
  }

  if (ws) {
    try {
      ws.close();
    } catch (_) {}
  }

  ws = null;

  heliusConnected =
    false;

  running = false;

  console.log("");
  console.log(
    "⛔ RADAR ARRÊTÉ"
  );

  console.log(
    "Raison :",
    stopReason ||
      "MANUAL"
  );

  console.log(
    "Cycles :",
    cyclesCompleted
  );

  console.log(
    "Bénéfices :",
    `$${sessionProfit.toFixed(4)}`
  );
}

/* =========================================================
   SAUVEGARDE TRADE
========================================================= */

function saveTrade(
  trade
) {
  const history =
    readJson(
      TRADE_FILE,
      []
    );

  history.push(
    trade
  );

  writeJson(
    TRADE_FILE,
    history
  );
}

/* =========================================================
   COMMANDES
========================================================= */

bot.command(
  "starttrade",
  async (ctx) => {
    const args =
      ctx.message.text
        .trim()
        .split(/\s+/)
        .slice(1);

    if (!args.length) {
      await ctx.reply(
`Utilisation :

/starttrade ADRESSE_TOKEN

Exemple :

/starttrade 5XnMHrs45GNHqNpPNHd8bepoHdRhFBppZdUieP4MKa1S`
      );

      return;
    }

    await startSession(
      args[0]
    );
  }
);

bot.command(
  "stoptrade",
  async (ctx) => {
    if (!running) {
      await ctx.reply(
        "ℹ️ Aucune session en cours."
      );

      return;
    }

    stopReason =
      "MANUAL";

    stopSession();

    await ctx.reply(
`🛑 SESSION ARRÊTÉE

Token :
${tokenMint}

Cycles :
${cyclesCompleted}

💰 Bénéfices :
$${sessionProfit.toFixed(4)}

🧪 Simulation uniquement.`
    );
  }
);

bot.command(
  "status",
  async (ctx) => {
    if (!running) {
      await ctx.reply(
`ℹ️ Aucune session active.

/starttrade ADRESSE_TOKEN`
      );

      return;
    }

    const elapsed =
      now() -
      sessionStart;

    const minutes =
      Math.floor(
        elapsed / 60000
      );

    await ctx.reply(
`📊 STATUS V5.6

Token :
${tokenMint}

⏱️ Temps :
${minutes} min

Cycles :
${cyclesCompleted}

💰 Bénéfices :
$${sessionProfit.toFixed(4)}

📍 Position :
${
  currentPosition
    ? "OUVERTE"
    : "AUCUNE"
}

⛓️ Helius :
${
  heliusConnected
    ? "🟢 connecté"
    : "🔴 déconnecté"
}

🔗 Pool :
${
  poolInfo
    ? poolInfo.pool
    : "N/A"
}

🧪 Simulation`
    );
  }
);

bot.command(
  "lastcrash",
  async (ctx) => {
    if (
      !lastCrashReport
    ) {
      const reports =
        readJson(
          CRASH_FILE,
          []
        );

      if (
        reports.length
      ) {
        lastCrashReport =
          reports[
            reports.length - 1
          ];
      }
    }

    if (
      !lastCrashReport
    ) {
      await ctx.reply(
        "ℹ️ Aucun crash enregistré."
      );

      return;
    }

    const r =
      lastCrashReport;

    await ctx.reply(
`🚨 DERNIER CRASH

Token :
${r.mint}

Date :
${r.timestamp}

Prix :
${formatPrice(
  r.crashMarket.price
)}

Variation prix :
${r.crashMarket.priceChange10s.toFixed(2)}%

Liquidité :
${formatUsd(
  r.crashMarket.liquidity
)}

Variation liquidité :
${r.crashMarket.liquidityChange10s.toFixed(2)}%

Score :
${r.crashMarket.score}/100

Signaux :
${r.reasons.join("\n")}

Cycles :
${r.cyclesCompleted}

Bénéfices :
$${r.sessionProfit.toFixed(4)}`
    );
  }
);

bot.command(
  "help",
  async (ctx) => {
    await ctx.reply(
`🤖 COMMANDES V5.6

/starttrade TOKEN
Lance une simulation.

/stoptrade
Arrête la session.

/status
Affiche l'état.

/lastcrash
Affiche le dernier crash.

/help
Affiche l'aide.

💵 Mise :
$10

🎯 Objectif :
+5%

⏳ Observation :
30 secondes

⏱️ Aucun nouvel achat :
après 43 minutes

🛑 Session :
45 minutes

🧪 Simulation uniquement.`
    );
  }
);

/* =========================================================
   ERREURS TELEGRAM
========================================================= */

bot.catch(
  (error) => {
    console.log(
      "❌ Erreur Telegram :",
      error.message
    );
  }
);

/* =========================================================
   LANCEMENT
========================================================= */

(async () => {
  try {
    console.log(
      "🤖 Démarrage Telegram..."
    );

    await bot.launch();

    console.log(
      "✅ Bot Telegram opérationnel."
    );

    console.log(
      "🚀 V5.6 prête."
    );
  } catch (error) {
    console.error(
      "❌ Erreur démarrage :",
      error
    );

    process.exit(1);
  }
})();

/* =========================================================
   ARRET PROPRE
========================================================= */

process.once(
  "SIGINT",
  () => {
    stopSession();
    bot.stop(
      "SIGINT"
    );
  }
);

process.once(
  "SIGTERM",
  () => {
    stopSession();
    bot.stop(
      "SIGTERM"
    );
  }
);
