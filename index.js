const { Telegraf } = require("telegraf");
const { Connection, PublicKey } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
require("dotenv").config();

/*
  PUMP RADAR V5.9
  COMPARATIF STOP-LOSS

  SIMULATION UNIQUEMENT

  4 stratégies virtuelles :
    +5% / stop -10%
    +5% / stop -15%
    +5% / stop -20%
    +5% / stop -25%

  Capital : 10 $ par stratégie
  Cooldown : 30 secondes
  Aucun nouveau BUY après 43 minutes
  Fermeture forcée à 45 minutes
*/

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

const TOKEN_MINT =
  "5XnMHrs45GNHqNpPNHd8bepoHdRhFBppZdUieP4MKa1S";

const SOLANA_RPC = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : "https://api.mainnet-beta.solana.com";

const HELIUS_WSS = HELIUS_API_KEY
  ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : null;

const DEX_TOKEN_URL =
  `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`;

const DEX_PAIR_URL =
  "https://api.dexscreener.com/latest/dex/pairs/solana/";

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// ================================
// PARAMÈTRES DE LA STRATÉGIE
// ================================

const CAPITAL_USD = 10;
const TARGET_PCT = 0.05;

const STOP_VARIANTS = [
  {
    id: "STOP_10",
    label: "-10 %",
    stopPct: 0.10,
  },
  {
    id: "STOP_15",
    label: "-15 %",
    stopPct: 0.15,
  },
  {
    id: "STOP_20",
    label: "-20 %",
    stopPct: 0.20,
  },
  {
    id: "STOP_25",
    label: "-25 %",
    stopPct: 0.25,
  },
];

const MARKET_INTERVAL_MS = 2000;

const HISTORY_MS = 120000;
const WARMUP_POINTS = 8;

const COOLDOWN_MS = 30000;

const NO_NEW_BUY_MS = 43 * 60 * 1000;
const MAX_SESSION_MS = 45 * 60 * 1000;

const MIN_LIQUIDITY_USD = 3000;

// Détection crash
const CRASH_LIQUIDITY_USD = 1;
const CRASH_LIQUIDITY_DROP_10S = -0.50;
const CRASH_PRICE_DROP_10S = -0.20;

// DexScreener : redécouverte de la paire
const DISCOVERY_INTERVAL_MS = 30000;

// Diagnostics Telegram/console
const DIAGNOSTIC_INTERVAL_MS = 30000;

// ================================
// STOCKAGE
// ================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

fs.mkdirSync(DATA_DIR, {
  recursive: true,
});

const FILES = {
  market: path.join(
    DATA_DIR,
    "v5_9_market_history.jsonl"
  ),

  trades: path.join(
    DATA_DIR,
    "v5_9_trades.json"
  ),

  comparison: path.join(
    DATA_DIR,
    "v5_9_comparison.json"
  ),

  crash: path.join(
    DATA_DIR,
    "v5_9_crash_reports.json"
  ),
};

// ================================
// VARIABLES GLOBALES
// ================================

let bot = null;
let connection = null;
let heliusWs = null;

let sessionRunning = false;
let sessionStartedAt = null;
let sessionEndedAt = null;

let marketTimer = null;

let marketHistory = [];

let cachedPairAddress = null;
let cachedPair = null;
let lastDiscoveryAt = 0;

let lastMarketData = null;

let lastDiagnosticAt = 0;

let crashDetected = false;
let crashReport = null;

let previousVaultSnapshot = null;

let lastOnChainValidation = {
  checkedAt: 0,
  ok: false,
  reason: "NOT_CHECKED",
  owner: null,
  baseMint: null,
  quoteMint: null,
  baseVault: null,
  quoteVault: null,
};

// ================================
// HISTORIQUE SAUVEGARDÉ
// ================================

const comparisonHistory =
  loadJson(FILES.comparison, []);

const savedTrades =
  loadJson(FILES.trades, []);

const savedCrashes =
  loadJson(FILES.crash, []);

// ================================
// 4 STRATÉGIES VIRTUELLES
// ================================

function initStrategy(definition) {
  return {
    id: definition.id,
    label: definition.label,
    stopPct: definition.stopPct,

    positionOpen: false,

    entryPrice: null,
    entryTime: null,
    targetPrice: null,

    invested: CAPITAL_USD,

    cycleNumber: 0,

    wins: 0,
    stops: 0,
    crashExits: 0,
    sessionExits: 0,
    otherExits: 0,

    pnl: 0,

    cooldownUntil: 0,

    lastExit: null,

    totalTrades: 0,
    entryCount: 0,

    stoppedBeforeCrash: 0,
    targetBeforeCrash: 0,
  };
}

const strategies =
  STOP_VARIANTS.map(initStrategy);

// ================================
// OUTILS
// ================================

function now() {
  return Date.now();
}

function pctChange(oldValue, newValue) {
  if (
    !Number.isFinite(oldValue) ||
    oldValue === 0 ||
    !Number.isFinite(newValue)
  ) {
    return null;
  }

  return (newValue / oldValue) - 1;
}

function money(value) {
  if (!Number.isFinite(value)) {
    return "$0.00";
  }

  return `$${value.toFixed(2)}`;
}

function priceText(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  if (value < 0.001) {
    return value.toFixed(10);
  }

  return value.toFixed(8);
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (e) {
    console.log(
      `⚠️ Lecture impossible ${file}:`,
      e.message
    );

    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2)
    );
  } catch (e) {
    console.log(
      `⚠️ Écriture impossible ${file}:`,
      e.message
    );
  }
}

function appendJsonl(file, data) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(data) + "\n"
    );
  } catch (e) {
    console.log(
      "⚠️ Écriture JSONL impossible:",
      e.message
    );
  }
}

function elapsedMs() {
  if (!sessionStartedAt) {
    return 0;
  }

  return now() - sessionStartedAt;
}

function sessionMinutes() {
  return elapsedMs() / 60000;
}

// ================================
// SESSION
// ================================

function canOpenNewPosition() {
  return (
    sessionRunning &&
    !crashDetected &&
    elapsedMs() < NO_NEW_BUY_MS
  );
}

function sessionLimitReached() {
  return (
    sessionRunning &&
    elapsedMs() >= MAX_SESSION_MS
  );
}

// ================================
// HISTORIQUE MARCHÉ
// ================================

function historyTrim() {
  const cutoff =
    now() - HISTORY_MS;

  marketHistory =
    marketHistory.filter(
      x => x.ts >= cutoff
    );
}

function snapshotAtOrBefore(msAgo) {
  const target =
    now() - msAgo;

  let best = null;

  for (
    let i = marketHistory.length - 1;
    i >= 0;
    i--
  ) {
    if (
      marketHistory[i].ts <= target
    ) {
      best = marketHistory[i];
      break;
    }
  }

  return best;
}

function getMarketChange(msAgo, field) {
  const old =
    snapshotAtOrBefore(msAgo);

  const latest =
    marketHistory[
      marketHistory.length - 1
    ];

  if (!old || !latest) {
    return null;
  }

  return pctChange(
    old[field],
    latest[field]
  );
}

// ================================
// CONDITIONS D'ENTRÉE
// ================================

function entryHealthReason() {
  if (!lastMarketData) {
    return "NO_MARKET";
  }

  if (
    lastMarketData.liquidityUsd <
    MIN_LIQUIDITY_USD
  ) {
    return "LIQUIDITY_TOO_LOW";
  }

  if (
    marketHistory.length <
    WARMUP_POINTS
  ) {
    return (
      `HISTORY_WARMUP ` +
      `${marketHistory.length}/${WARMUP_POINTS}`
    );
  }

  const price10 =
    getMarketChange(
      10000,
      "priceUsd"
    );

  const liq10 =
    getMarketChange(
      10000,
      "liquidityUsd"
    );

  const liq30 =
    getMarketChange(
      30000,
      "liquidityUsd"
    );

  if (
    price10 !== null &&
    price10 < -0.05
  ) {
    return "PRICE_DROP_10S";
  }

  if (
    liq10 !== null &&
    liq10 < -0.12
  ) {
    return "LIQUIDITY_DROP_10S";
  }

  if (
    liq30 !== null &&
    liq30 < -0.20
  ) {
    return "LIQUIDITY_DROP_30S";
  }

  return null;
}

function isHealthyEntry() {
  return entryHealthReason() === null;
}

// ================================
// DÉTECTION CRASH
// ================================

function crashReason() {
  if (
    !lastMarketData ||
    marketHistory.length < 2
  ) {
    return null;
  }

  const price10 =
    getMarketChange(
      10000,
      "priceUsd"
    );

  const liq10 =
    getMarketChange(
      10000,
      "liquidityUsd"
    );

  if (
    Number.isFinite(
      lastMarketData.liquidityUsd
    ) &&
    lastMarketData.liquidityUsd <=
      CRASH_LIQUIDITY_USD
  ) {
    return "LIQUIDITY_NEAR_ZERO";
  }

  if (
    liq10 !== null &&
    liq10 <=
      CRASH_LIQUIDITY_DROP_10S
  ) {
    return "LIQUIDITY_COLLAPSE_10S";
  }

  if (
    price10 !== null &&
    price10 <=
      CRASH_PRICE_DROP_10S
  ) {
    return "PRICE_CRASH_10S";
  }

  return null;
}

// ================================
// TELEGRAM
// ================================

async function sendTelegram(text) {
  if (!bot || !CHAT_ID) {
    console.log(text);
    return;
  }

  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (e) {
    console.log(
      "⚠️ Telegram:",
      e.message
    );
  }
}

// ================================
// RESET
// ================================

function resetStrategies() {
  for (let i = 0; i < strategies.length; i++) {
    const definition =
      STOP_VARIANTS[i];

    strategies[i] =
      initStrategy(definition);
  }
}

function resetSessionState() {
  marketHistory = [];

  cachedPairAddress = null;
  cachedPair = null;

  lastDiscoveryAt = 0;

  lastMarketData = null;

  lastDiagnosticAt = 0;

  crashDetected = false;
  crashReport = null;

  previousVaultSnapshot = null;

  lastOnChainValidation = {
    checkedAt: 0,
    ok: false,
    reason: "NOT_CHECKED",
    owner: null,
    baseMint: null,
    quoteMint: null,
    baseVault: null,
    quoteVault: null,
  };

  resetStrategies();
}

// ================================
// HTTP
// ================================

async function fetchJson(
  url,
  timeoutMs = 8000
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      timeoutMs
    );

  try {
    const response =
      await fetch(url, {
        method: "GET",

        headers: {
          accept:
            "application/json",

          "user-agent":
            "PumpRadar-V5.9",
        },

        signal:
          controller.signal,
      });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ================================
// DEXSCREENER
// ================================

function isPumpSwapPair(pair) {
  if (!pair) {
    return false;
  }

  const dexId =
    String(
      pair.dexId || ""
    ).toLowerCase();

  return (
    dexId === "pumpswap" ||
    dexId === "pump_amm" ||
    dexId === "pumpamm" ||
    dexId.includes("pump")
  );
}

function isTargetBasePair(pair) {
  return (
    pair &&
    pair.baseToken &&
    String(
      pair.baseToken.address
    ).toLowerCase() ===
      TOKEN_MINT.toLowerCase()
  );
}

async function discoverPumpSwapPair(
  force = false
) {
  if (
    !force &&
    cachedPairAddress &&
    now() - lastDiscoveryAt <
      DISCOVERY_INTERVAL_MS
  ) {
    return cachedPairAddress;
  }

  const data =
    await fetchJson(
      DEX_TOKEN_URL,
      8000
    );

  const pairs =
    Array.isArray(data.pairs)
      ? data.pairs
      : [];

  const candidates =
    pairs
      .filter(isPumpSwapPair)
      .filter(isTargetBasePair)
      .filter(
        pair => pair.pairAddress
      )
      .sort((a, b) => {
        const la =
          Number(
            a.liquidity?.usd || 0
          );

        const lb =
          Number(
            b.liquidity?.usd || 0
          );

        return lb - la;
      });

  lastDiscoveryAt = now();

  if (!candidates.length) {
    cachedPairAddress = null;
    cachedPair = null;

    throw new Error(
      "Aucune paire PumpSwap cible trouvée"
    );
  }

  cachedPair =
    candidates[0];

  cachedPairAddress =
    candidates[0].pairAddress;

  return cachedPairAddress;
}

async function fetchPairMarket(
  pairAddress
) {
  const data =
    await fetchJson(
      `${DEX_PAIR_URL}${encodeURIComponent(
        pairAddress
      )}`,
      8000
    );

  const pairs =
    Array.isArray(data.pairs)
      ? data.pairs
      : [];

  let pair =
    pairs.find(
      p =>
        p.pairAddress ===
          pairAddress &&
        isPumpSwapPair(p) &&
        isTargetBasePair(p)
    );

  if (!pair) {
    pair =
      pairs.find(
        p =>
          isPumpSwapPair(p) &&
          isTargetBasePair(p)
      );
  }

  if (!pair) {
    throw new Error(
      "Paire PumpSwap introuvable"
    );
  }

  cachedPair = pair;

  return pair;
}

async function getDexMarketData() {
  let pairAddress =
    cachedPairAddress;

  if (
    !pairAddress ||
    now() - lastDiscoveryAt >=
      DISCOVERY_INTERVAL_MS
  ) {
    pairAddress =
      await discoverPumpSwapPair();
  }

  let pair;

  try {
    pair =
      await fetchPairMarket(
        pairAddress
      );
  } catch (e) {
    console.log(
      "⚠️ Pair endpoint:",
      e.message
    );

    pairAddress =
      await discoverPumpSwapPair(
        true
      );

    pair =
      await fetchPairMarket(
        pairAddress
      );
  }

  const priceUsd =
    Number(pair.priceUsd);

  const liquidityUsd =
    Number(
      pair.liquidity?.usd
    );

  if (
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0
  ) {
    throw new Error(
      "Prix DEX invalide"
    );
  }

  if (
    !Number.isFinite(liquidityUsd)
  ) {
    throw new Error(
      "Liquidité DEX invalide"
    );
  }

  return {
    ts: now(),

    priceUsd,

    liquidityUsd,

    pairAddress,

    dexId: pair.dexId,

    url:
      pair.url || null,

    baseMint:
      pair.baseToken?.address ||
      null,

    quoteMint:
      pair.quoteToken?.address ||
      null,

    priceNative:
      Number(
        pair.priceNative
      ) || null,

    fdv:
      Number(pair.fdv) || null,

    marketCap:
      Number(pair.marketCap) ||
      null,
  };
}

// ================================
// VALIDATION ON-CHAIN
// ================================

function readInt128LE(bytes) {
  let result = 0n;

  for (
    let i = 0;
    i < bytes.length;
    i++
  ) {
    result +=
      BigInt(bytes[i]) <<
      (8n * BigInt(i));
  }

  const negative =
    (bytes[bytes.length - 1] &
      0x80) !== 0;

  if (!negative) {
    return result;
  }

  return (
    result -
    (1n << 128n)
  );
}

function parsePumpSwapPool(data) {
  if (
    !data ||
    !data.length ||
    data.length < 203
  ) {
    throw new Error(
      "Compte pool trop court"
    );
  }

  const baseMint =
    new PublicKey(
      data.slice(43, 75)
    ).toBase58();

  const quoteMint =
    new PublicKey(
      data.slice(75, 107)
    ).toBase58();

  const baseVault =
    new PublicKey(
      data.slice(139, 171)
    ).toBase58();

  const quoteVault =
    new PublicKey(
      data.slice(171, 203)
    ).toBase58();

  let virtualQuoteReserves =
    null;

  if (data.length >= 261) {
    try {
      virtualQuoteReserves =
        readInt128LE(
          data.slice(245, 261)
        );
    } catch (_) {
      virtualQuoteReserves =
        null;
    }
  }

  return {
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
    virtualQuoteReserves,
  };
}

async function validatePumpSwapPool(
  pairAddress
) {
  try {
    const pubkey =
      new PublicKey(
        pairAddress
      );

    const info =
      await connection.getAccountInfo(
        pubkey,
        "processed"
      );

    if (!info) {
      throw new Error(
        "Compte pool introuvable"
      );
    }

    const owner =
      info.owner.toBase58();

    if (
      owner !== PUMPSWAP_PROGRAM
    ) {
      throw new Error(
        `Owner inattendu: ${owner}`
      );
    }

    const parsed =
      parsePumpSwapPool(
        info.data
      );

    if (
      parsed.baseMint !==
        TOKEN_MINT ||
      parsed.quoteMint !==
        WSOL_MINT
    ) {
      throw new Error(
        `Mints inattendus`
      );
    }

    lastOnChainValidation = {
      checkedAt: now(),

      ok: true,

      reason: "OK",

      owner,

      ...parsed,
    };

    return lastOnChainValidation;
  } catch (e) {
    lastOnChainValidation = {
      checkedAt: now(),

      ok: false,

      reason: e.message,

      owner: null,

      baseMint: null,

      quoteMint: null,

      baseVault: null,

      quoteVault: null,
    };

    return lastOnChainValidation;
  }
}

async function readVaultSnapshot(
  validation
) {
  if (
    !validation?.ok ||
    !validation.baseVault ||
    !validation.quoteVault
  ) {
    return null;
  }

  try {
    const [
      baseInfo,
      quoteInfo,
    ] =
      await Promise.all([
        connection.getTokenAccountBalance(
          new PublicKey(
            validation.baseVault
          ),
          "processed"
        ),

        connection.getTokenAccountBalance(
          new PublicKey(
            validation.quoteVault
          ),
          "processed"
        ),
      ]);

    const baseAmount =
      Number(
        baseInfo.value.amount
      );

    const quoteAmount =
      Number(
        quoteInfo.value.amount
      );

    return {
      ts: now(),

      baseAmount,

      quoteAmount,

      quoteSol:
        quoteAmount / 1e9,
    };
  } catch (_) {
    return null;
  }
}

function processVaultDiagnostics(
  snapshot
) {
  if (!snapshot) {
    return null;
  }

  if (!previousVaultSnapshot) {
    previousVaultSnapshot =
      snapshot;

    return null;
  }

  const baseDelta =
    snapshot.baseAmount -
    previousVaultSnapshot.baseAmount;

  const quoteDelta =
    snapshot.quoteAmount -
    previousVaultSnapshot.quoteAmount;

  previousVaultSnapshot =
    snapshot;

  if (
    baseDelta === 0 &&
    quoteDelta === 0
  ) {
    return null;
  }

  if (
    baseDelta < 0 &&
    quoteDelta > 0
  ) {
    return "SELL";
  }

  if (
    baseDelta > 0 &&
    quoteDelta < 0
  ) {
    return "BUY";
  }

  if (
    baseDelta < 0 &&
    quoteDelta < 0
  ) {
    return "WITHDRAWAL";
  }

  if (
    baseDelta > 0 &&
    quoteDelta > 0
  ) {
    return "ADDITION";
  }

  return "UNKNOWN";
}

async function refreshOnChainDiagnostics() {
  if (
    !cachedPairAddress ||
    !connection
  ) {
    return;
  }

  const validation =
    await validatePumpSwapPool(
      cachedPairAddress
    );

  if (!validation.ok) {
    return;
  }

  const snapshot =
    await readVaultSnapshot(
      validation
    );

  processVaultDiagnostics(
    snapshot
  );
}

// ================================
// SAUVEGARDE
// ================================

function saveMarketSnapshot(
  market
) {
  appendJsonl(
    FILES.market,
    {
      ...market,

      sessionMinute:
        Number(
          sessionMinutes().toFixed(3)
        ),
    }
  );
}

function saveTrade(
  strategy,
  action,
  reason,
  price,
  pnl,
  extra = {}
) {
  const trade = {
    ts:
      new Date().toISOString(),

    strategy:
      strategy.label,

    stopPct:
      strategy.stopPct,

    cycle:
      strategy.cycleNumber,

    action,

    reason,

    price,

    pnl,

    sessionMinute:
      Number(
        sessionMinutes().toFixed(3)
      ),

    ...extra,
  };

  savedTrades.push(
    trade
  );

  if (
    savedTrades.length > 5000
  ) {
    savedTrades.splice(
      0,
      savedTrades.length - 5000
    );
  }

  saveJson(
    FILES.trades,
    savedTrades
  );
}

// ================================
// P&L
// ================================

function calculatePnl(
  entryPrice,
  exitPrice
) {
  if (
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(exitPrice) ||
    entryPrice <= 0 ||
    exitPrice <= 0
  ) {
    return 0;
  }

  const tokenQty =
    CAPITAL_USD /
    entryPrice;

  const exitValue =
    tokenQty *
    exitPrice;

  return (
    exitValue -
    CAPITAL_USD
  );
}

// ================================
// ACHAT
// ================================

async function openPosition(
  strategy,
  price,
  reason = "ENTRY"
) {
  if (
    strategy.positionOpen
  ) {
    return false;
  }

  strategy.positionOpen =
    true;

  strategy.entryPrice =
    price;

  strategy.entryTime =
    now();

  strategy.targetPrice =
    price *
    (1 + TARGET_PCT);

  strategy.cycleNumber += 1;

  strategy.totalTrades += 1;

  strategy.entryCount += 1;

  saveTrade(
    strategy,
    "BUY",
    reason,
    price,
    0,
    {
      targetPrice:
        strategy.targetPrice,

      capital:
        CAPITAL_USD,
    }
  );

  return true;
}

// ================================
// VENTE
// ================================

async function closePosition(
  strategy,
  exitPrice,
  reason
) {
  if (
    !strategy.positionOpen
  ) {
    return false;
  }

  const entryPrice =
    strategy.entryPrice;

  const pnl =
    calculatePnl(
      entryPrice,
      exitPrice
    );

  strategy.positionOpen =
    false;

  strategy.lastExit = {
    ts: now(),

    reason,

    entryPrice,

    exitPrice,

    pnl,
  };

  strategy.pnl += pnl;

  strategy.cooldownUntil =
    now() +
    COOLDOWN_MS;

  if (
    reason === "TARGET"
  ) {
    strategy.wins += 1;

    strategy.targetBeforeCrash +=
      1;
  } else if (
    reason === "STOP"
  ) {
    strategy.stops += 1;

    strategy.stoppedBeforeCrash +=
      1;
  } else if (
    reason === "CRASH"
  ) {
    strategy.crashExits +=
      1;
  } else if (
    reason === "SESSION_LIMIT"
  ) {
    strategy.sessionExits +=
      1;
  } else {
    strategy.otherExits +=
      1;
  }

  saveTrade(
    strategy,
    "SELL",
    reason,
    exitPrice,
    pnl,
    {
      entryPrice,

      targetPrice:
        strategy.targetPrice,

      stopPrice:
        entryPrice *
        (1 - strategy.stopPct),
    }
  );

  const result = {
    reason,

    entryPrice,

    exitPrice,

    pnl,
  };

  strategy.entryPrice =
    null;

  strategy.entryTime =
    null;

  strategy.targetPrice =
    null;

  return result;
}

// ================================
// TRAITEMENT D'UNE STRATÉGIE
// ================================

async function processStrategy(
  strategy
) {
  if (
    !strategy.positionOpen
  ) {
    if (
      !canOpenNewPosition()
    ) {
      return null;
    }

    if (
      strategy.cooldownUntil >
      now()
    ) {
      return null;
    }

    if (
      !isHealthyEntry()
    ) {
      return null;
    }

    await openPosition(
      strategy,
      lastMarketData.priceUsd
    );

    return {
      type: "BUY",

      strategy,
    };
  }

  const price =
    lastMarketData.priceUsd;

  // CIBLE +5 %
  if (
    price >=
    strategy.targetPrice
  ) {
    const result =
      await closePosition(
        strategy,
        price,
        "TARGET"
      );

    return {
      type: "SELL",

      strategy,

      result,
    };
  }

  // STOP
  const stopPrice =
    strategy.entryPrice *
    (1 - strategy.stopPct);

  if (
    price <= stopPrice
  ) {
    const result =
      await closePosition(
        strategy,
        price,
        "STOP"
      );

    return {
      type: "SELL",

      strategy,

      result,
    };
  }

  return null;
}

// ================================
// FERMETURE FORCÉE
// ================================

async function forceCloseAll(
  reason,
  price
) {
  const exits = [];

  for (
    const strategy of strategies
  ) {
    if (
      !strategy.positionOpen
    ) {
      continue;
    }

    const result =
      await closePosition(
        strategy,
        price,
        reason
      );

    if (result) {
      exits.push({
        strategy,

        result,
      });
    }
  }

  return exits;
}

// ================================
// MESSAGES TELEGRAM
// ================================

function buildBuyMessage() {
  const price =
    lastMarketData.priceUsd;

  let text =
    `🧪 V5.9 BUY COMPARATIF\n` +
    `Prix: ${priceText(price)}\n` +
    `Capital: ${money(CAPITAL_USD)} par stratégie\n\n`;

  for (
    const s of strategies
  ) {
    text +=
      `${s.label}: ` +
      `cible ${priceText(
        s.targetPrice
      )} | ` +
      `stop ${priceText(
        s.entryPrice *
        (1 - s.stopPct)
      )}\n`;
  }

  return text;
}

function buildSellMessage(
  strategy,
  result
) {
  const variation =
    pctChange(
      result.entryPrice,
      result.exitPrice
    ) * 100;

  let icon = "💥";

  if (
    result.reason === "TARGET"
  ) {
    icon = "🎯";
  }

  if (
    result.reason === "STOP"
  ) {
    icon = "🛑";
  }

  if (
    result.reason ===
    "SESSION_LIMIT"
  ) {
    icon = "⏰";
  }

  return (
    `${icon} V5.9 SELL ${strategy.label}\n` +
    `Motif: ${result.reason}\n` +
    `Entrée: ${priceText(
      result.entryPrice
    )}\n` +
    `Sortie: ${priceText(
      result.exitPrice
    )}\n` +
    `Variation: ${variation.toFixed(
      2
    )}%\n` +
    `P&L: ${money(
      result.pnl
    )}`
  );
}

// ================================
// RAPPORT FINAL
// ================================

function buildComparisonReport() {
  const totalPnl =
    strategies.reduce(
      (sum, s) =>
        sum + s.pnl,
      0
    );

  let text =
    `🧪 V5.9 COMPARATIF TERMINÉ\n\n` +
    `Token: ${TOKEN_MINT}\n` +
    `Durée: ${sessionMinutes().toFixed(
      1
    )} min\n` +
    `Capital virtuel: ${money(
      CAPITAL_USD
    )} / stratégie\n` +
    `Cible: +5 %\n\n`;

  for (
    const s of strategies
  ) {
    text +=
      `${s.label}\n` +
      `  🎯 Gains: ${s.wins}\n` +
      `  🛑 Stops: ${s.stops}\n` +
      `  💥 Crash: ${s.crashExits}\n` +
      `  ⏰ Limite: ${s.sessionExits}\n` +
      `  💰 P&L: ${money(
        s.pnl
      )}\n\n`;
  }

  text +=
    `Somme P&L des 4 simulations: ` +
    `${money(totalPnl)}\n`;

  if (crashDetected) {
    text +=
      `\n💥 Crash détecté: ` +
      `${crashReport?.reason ||
        "UNKNOWN"}\n` +
      `Prix: ${priceText(
        lastMarketData?.priceUsd
      )}\n` +
      `Liquidité: ${money(
        lastMarketData?.liquidityUsd
      )}\n`;
  }

  return text;
}

// ================================
// SAUVEGARDE COMPARATIF
// ================================

function saveComparisonReport(
  reason
) {
  const report = {
    ts:
      new Date().toISOString(),

    token:
      TOKEN_MINT,

    reason,

    durationMinutes:
      Number(
        sessionMinutes().toFixed(3)
      ),

    capitalPerStrategy:
      CAPITAL_USD,

    targetPct:
      TARGET_PCT,

    crashDetected,

    crashReport,

    strategies:
      strategies.map(s => ({
        id:
          s.id,

        label:
          s.label,

        stopPct:
          s.stopPct,

        wins:
          s.wins,

        stops:
          s.stops,

        crashExits:
          s.crashExits,

        sessionExits:
          s.sessionExits,

        pnl:
          Number(
            s.pnl.toFixed(6)
          ),

        totalTrades:
          s.totalTrades,

        stoppedBeforeCrash:
          s.stoppedBeforeCrash,

        targetBeforeCrash:
          s.targetBeforeCrash,

        lastExit:
          s.lastExit,
      })),
  };

  comparisonHistory.push(
    report
  );

  if (
    comparisonHistory.length >
    100
  ) {
    comparisonHistory.splice(
      0,
      comparisonHistory.length -
        100
    );
  }

  saveJson(
    FILES.comparison,
    comparisonHistory
  );
}

// ================================
// RAPPORT CRASH
// ================================

function saveCrashReport(
  reason
) {
  crashReport = {
    ts:
      new Date().toISOString(),

    reason,

    priceUsd:
      lastMarketData?.priceUsd ??
      null,

    liquidityUsd:
      lastMarketData?.liquidityUsd ??
      null,

    priceDrop10s:
      getMarketChange(
        10000,
        "priceUsd"
      ),

    liquidityDrop10s:
      getMarketChange(
        10000,
        "liquidityUsd"
      ),

    pairAddress:
      cachedPairAddress,

    onChain:
      lastOnChainValidation,

    sessionMinute:
      Number(
        sessionMinutes().toFixed(3)
      ),
  };

  savedCrashes.push(
    crashReport
  );

  if (
    savedCrashes.length >
    100
  ) {
    savedCrashes.splice(
      0,
      savedCrashes.length -
        100
    );
  }

  saveJson(
    FILES.crash,
    savedCrashes
  );
}

// ================================
// CRASH
// ================================

async function handleCrash(
  reason
) {
  if (crashDetected) {
    return;
  }

  crashDetected = true;

  saveCrashReport(
    reason
  );

  const price =
    lastMarketData?.priceUsd;

  const price10 =
    getMarketChange(
      10000,
      "priceUsd"
    );

  const liq10 =
    getMarketChange(
      10000,
      "liquidityUsd"
    );

  let text =
    `💥 V5.9 CRASH DÉTECTÉ\n` +
    `Motif: ${reason}\n` +
    `Prix: ${priceText(
      price
    )}\n` +
    `Liquidité: ${money(
      lastMarketData?.liquidityUsd
    )}\n` +
    `Prix 10s: ${
      price10 === null
        ? "N/A"
        : (price10 * 100).toFixed(
            2
          ) + "%"
    }\n` +
    `Liquidité 10s: ${
      liq10 === null
        ? "N/A"
        : (liq10 * 100).toFixed(
            2
          ) + "%"
    }\n\n` +
    `🛑 Aucun nouvel achat.`;

  await sendTelegram(
    text
  );

  if (
    Number.isFinite(price) &&
    price > 0
  ) {
    const exits =
      await forceCloseAll(
        "CRASH",
        price
      );

    for (
      const exit of exits
    ) {
      await sendTelegram(
        buildSellMessage(
          exit.strategy,
          exit.result
        )
      );
    }
  }

  await sendTelegram(
    buildComparisonReport(
      "CRASH"
    )
  );

  saveComparisonReport(
    "CRASH"
  );

  sessionRunning = false;

  sessionEndedAt =
    now();

  stopTimers();

  await sendTelegram(
    `🛑 V5.9 arrêtée après crash.`
  );
}

// ================================
// LIMITE 45 MIN
// ================================

async function handleSessionLimit() {
  if (!sessionRunning) {
    return;
  }

  const price =
    lastMarketData?.priceUsd;

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    await sendTelegram(
      `⏰ 45 min atteintes, ` +
      `mais aucun prix exploitable n'est disponible.`
    );

    return;
  }

  const exits =
    await forceCloseAll(
      "SESSION_LIMIT",
      price
    );

  for (
    const exit of exits
  ) {
    await sendTelegram(
      buildSellMessage(
        exit.strategy,
        exit.result
      )
    );
  }

  sessionRunning = false;

  sessionEndedAt =
    now();

  const report =
    buildComparisonReport(
      "SESSION_LIMIT"
    );

  await sendTelegram(
    `⏰ V5.9 LIMITE 45 MIN\n\n` +
    `Toutes les positions ouvertes ` +
    `ont été fermées en sécurité.\n\n` +
    report
  );

  saveComparisonReport(
    "SESSION_LIMIT"
  );

  stopTimers();
}

// ================================
// TICK PRINCIPAL
// ================================

async function marketTick() {
  if (!sessionRunning) {
    return;
  }

  try {
    const market =
      await getDexMarketData();

    lastMarketData =
      market;

    marketHistory.push(
      market
    );

    historyTrim();

    saveMarketSnapshot(
      market
    );

    if (
      now() -
        lastOnChainValidation.checkedAt >
      15000
    ) {
      refreshOnChainDiagnostics()
        .catch(() => {});
    }

    /*
      ORDRE IMPORTANT :

      1. Mise à jour du marché
      2. Chaque stop/cible est testé
      3. Ensuite seulement on vérifie le crash

      Cela permet de voir si un stop
      aurait réellement été touché
      avant le crash.
    */

    const actions = [];

    for (
      const strategy of strategies
    ) {
      const action =
        await processStrategy(
          strategy
        );

      if (action) {
        actions.push(
          action
        );
      }
    }

    for (
      const action of actions
    ) {
      if (
        action.type === "BUY"
      ) {
        await sendTelegram(
          buildBuyMessage()
        );
      }

      if (
        action.type === "SELL"
      ) {
        await sendTelegram(
          buildSellMessage(
            action.strategy,
            action.result
          )
        );
      }
    }

    const reason =
      crashReason();

    if (reason) {
      await handleCrash(
        reason
      );

      return;
    }

    if (
      sessionLimitReached()
    ) {
      await handleSessionLimit();

      return;
    }

    if (
      now() -
        lastDiagnosticAt >=
      DIAGNOSTIC_INTERVAL_MS
    ) {
      lastDiagnosticAt =
        now();

      const entryReason =
        entryHealthReason();

      console.log(
        `📊 V5.9 ` +
        `${sessionMinutes().toFixed(
          1
        )}m | ` +
        `Prix ${priceText(
          market.priceUsd
        )} | ` +
        `Liq ${money(
          market.liquidityUsd
        )} | ` +
        `Entrée ${
          entryReason ||
          "OK"
        }`
      );
    }
  } catch (e) {
    console.log(
      "⚠️ Tick marché:",
      e.message
    );

    if (
      sessionLimitReached()
    ) {
      await handleSessionLimit();
    }
  }
}

// ================================
// TIMERS
// ================================

function stopTimers() {
  if (marketTimer) {
    clearInterval(
      marketTimer
    );

    marketTimer = null;
  }
}

// ================================
// START SESSION
// ================================

async function startSession() {
  if (sessionRunning) {
    await sendTelegram(
      "⚠️ V5.9 est déjà en cours."
    );

    return;
  }

  resetSessionState();

  sessionRunning =
    true;

  sessionStartedAt =
    now();

  sessionEndedAt =
    null;

  await sendTelegram(
    `🧪 V5.9 COMPARATIF DÉMARRÉ\n\n` +
    `Token: ${TOKEN_MINT}\n` +
    `Capital: ${money(
      CAPITAL_USD
    )} par stratégie\n` +
    `Cible: +5 %\n` +
    `Stops: -10 % / -15 % / -20 % / -25 %\n` +
    `Cooldown: 30 s\n` +
    `Pas de BUY après 43 min\n` +
    `Fermeture forcée à 45 min\n` +
    `Simulation uniquement.\n\n` +
    `🔎 Recherche PumpSwap...`
  );

  try {
    await discoverPumpSwapPair(
      true
    );

    await sendTelegram(
      `🟢 PumpSwap trouvé\n` +
      `Pair: ${cachedPairAddress}\n` +
      `⏳ Warm-up: ${WARMUP_POINTS} observations.`
    );
  } catch (e) {
    await sendTelegram(
      `❌ V5.9 ARRÊTÉE\n` +
      `Aucun marché PumpSwap détecté.\n` +
      `Erreur: ${e.message}`
    );

    sessionRunning =
      false;

    return;
  }

  marketTimer =
    setInterval(
      marketTick,
      MARKET_INTERVAL_MS
    );

  await marketTick();
}

// ================================
// STOP MANUEL
// ================================

async function stopSession(
  reason = "MANUAL"
) {
  if (!sessionRunning) {
    await sendTelegram(
      "ℹ️ V5.9 n'est pas active."
    );

    return;
  }

  const price =
    lastMarketData?.priceUsd;

  if (
    Number.isFinite(price) &&
    price > 0
  ) {
    const exits =
      await forceCloseAll(
        "MANUAL",
        price
      );

    for (
      const exit of exits
    ) {
      await sendTelegram(
        buildSellMessage(
          exit.strategy,
          exit.result
        )
      );
    }
  }

  sessionRunning =
    false;

  sessionEndedAt =
    now();

  saveComparisonReport(
    reason
  );

  await sendTelegram(
    `🛑 V5.9 arrêt manuel.\n\n` +
    buildComparisonReport(
      reason
    )
  );

  stopTimers();
}

// ================================
// STATUS
// ================================

function statusText() {
  if (!sessionRunning) {
    return "🔴 V5.9 inactive";
  }

  let text =
    `🟢 V5.9 active\n` +
    `Session: ${sessionMinutes().toFixed(
      1
    )} min\n` +
    `Prix: ${priceText(
      lastMarketData?.priceUsd
    )}\n` +
    `Liquidité: ${money(
      lastMarketData?.liquidityUsd
    )}\n` +
    `Pair: ${
      cachedPairAddress ||
      "N/A"
    }\n` +
    `On-chain: ${
      lastOnChainValidation.ok
        ? "OK"
        : lastOnChainValidation.reason
    }\n\n`;

  for (
    const s of strategies
  ) {
    const status =
      s.positionOpen
        ? "OPEN"
        : s.cooldownUntil >
          now()
          ? "COOLDOWN"
          : "READY";

    text +=
      `${s.label} | ` +
      `${status} | ` +
      `W:${s.wins} ` +
      `S:${s.stops} ` +
      `C:${s.crashExits} ` +
      `P&L:${money(
        s.pnl
      )}\n`;
  }

  return text;
}

// ================================
// DERNIER CRASH
// ================================

function lastCrashText() {
  if (
    !savedCrashes.length
  ) {
    return "ℹ️ Aucun crash enregistré.";
  }

  const c =
    savedCrashes[
      savedCrashes.length - 1
    ];

  return (
    `💥 DERNIER CRASH V5.9\n` +
    `Date: ${c.ts}\n` +
    `Motif: ${c.reason}\n` +
    `Prix: ${priceText(
      c.priceUsd
    )}\n` +
    `Liquidité: ${money(
      c.liquidityUsd
    )}\n` +
    `Prix 10s: ${
      c.priceDrop10s === null
        ? "N/A"
        : (
            c.priceDrop10s *
            100
          ).toFixed(2) +
          "%"
    }\n` +
    `Liquidité 10s: ${
      c.liquidityDrop10s === null
        ? "N/A"
        : (
            c.liquidityDrop10s *
            100
          ).toFixed(2) +
          "%"
    }`
  );
}

// ================================
// DERNIER COMPARATIF
// ================================

function comparisonHistoryText() {
  if (
    !comparisonHistory.length
  ) {
    return "ℹ️ Aucun comparatif terminé.";
  }

  const r =
    comparisonHistory[
      comparisonHistory.length - 1
    ];

  let text =
    `📚 DERNIER COMPARATIF\n` +
    `Date: ${r.ts}\n` +
    `Fin: ${r.reason}\n` +
    `Durée: ${r.durationMinutes} min\n\n`;

  for (
    const s of r.strategies
  ) {
    text +=
      `${s.label}: ` +
      `W${s.wins} / ` +
      `S${s.stops} / ` +
      `C${s.crashExits} / ` +
      `P&L ${money(
        s.pnl
      )}\n`;
  }

  return text;
}

// ================================
// TELEGRAM SETUP
// ================================

function setupTelegram() {
  if (!BOT_TOKEN) {
    console.log(
      "❌ BOT_TOKEN manquant."
    );

    return;
  }

  bot =
    new Telegraf(
      BOT_TOKEN
    );

  bot.start(
    async ctx => {
      await ctx.reply(
        `🤖 V5.9\n\n` +
        `/starttrade = lancer\n` +
        `/stoptrade = arrêter\n` +
        `/status = état actuel\n` +
        `/lastcrash = dernier crash\n` +
        `/comparison = dernier comparatif\n` +
        `/help = aide\n\n` +
        `Simulation uniquement.`
      );
    }
  );

  bot.command(
    "starttrade",
    async ctx => {
      await startSession();
    }
  );

  bot.command(
    "stoptrade",
    async ctx => {
      await stopSession(
        "MANUAL"
      );
    }
  );

  bot.command(
    "status",
    async ctx => {
      await ctx.reply(
        statusText()
      );
    }
  );

  bot.command(
    "lastcrash",
    async ctx => {
      await ctx.reply(
        lastCrashText()
      );
    }
  );

  bot.command(
    "comparison",
    async ctx => {
      await ctx.reply(
        comparisonHistoryText()
      );
    }
  );

  bot.command(
    "help",
    async ctx => {
      await ctx.reply(
        `🧪 V5.9\n\n` +
        `Comparaison de 4 protections:\n` +
        `-10 %, -15 %, -20 %, -25 %\n\n` +
        `Toutes utilisent:\n` +
        `• 10 $ par cycle\n` +
        `• cible +5 %\n` +
        `• même marché\n` +
        `• mêmes conditions d'entrée\n` +
        `• cooldown 30 s\n` +
        `• aucun BUY après 43 min\n` +
        `• fermeture à 45 min\n\n` +
        `/starttrade\n` +
        `/stoptrade\n` +
        `/status\n` +
        `/lastcrash\n` +
        `/comparison`
      );
    }
  );

  bot.catch(
    err => {
      console.log(
        "❌ Erreur Telegram:",
        err.message
      );
    }
  );

  bot
    .launch({
      dropPendingUpdates: true,
    })
    .then(() => {
      console.log(
        "🤖 V5.9 Telegram bot démarré"
      );
    })
    .catch(err => {
      console.log(
        "❌ Telegram launch:",
        err.message
      );
    });

  process.once(
    "SIGINT",
    () => bot.stop("SIGINT")
  );

  process.once(
    "SIGTERM",
    () => bot.stop("SIGTERM")
  );
}

// ================================
// SOLANA
// ================================

function setupSolana() {
  connection =
    new Connection(
      SOLANA_RPC,
      {
        commitment:
          "processed",

        wsEndpoint:
          HELIUS_WSS ||
          undefined,
      }
    );
}

// ================================
// HELIUS DIAGNOSTIC
// ================================

function setupHeliusDiagnostics() {
  if (!HELIUS_WSS) {
    console.log(
      "ℹ️ Helius WSS non configuré."
    );

    return;
  }

  try {
    heliusWs =
      new WebSocket(
        HELIUS_WSS
      );

    heliusWs.on(
      "open",
      () => {
        console.log(
          "📡 Helius WSS connecté"
        );

        const request = {
          jsonrpc:
            "2.0",

          id: 1,

          method:
            "logsSubscribe",

          params: [
            {
              mentions: [
                PUMPSWAP_PROGRAM,
              ],
            },

            {
              commitment:
                "processed",
            },
          ],
        };

        heliusWs.send(
          JSON.stringify(
            request
          )
        );
      }
    );

    heliusWs.on(
      "message",
      raw => {
        try {
          const msg =
            JSON.parse(
              raw.toString()
            );

          if (
            msg.result
          ) {
            console.log(
              `📡 Helius subscription: ${msg.result}`
            );
          }
        } catch (_) {}
      }
    );

    heliusWs.on(
      "error",
      err => {
        console.log(
          "⚠️ Helius WSS:",
          err.message
        );
      }
    );

    heliusWs.on(
      "close",
      () => {
        console.log(
          "📡 Helius WSS fermé"
        );
      }
    );
  } catch (e) {
    console.log(
      "⚠️ Helius WSS:",
      e.message
    );
  }
}

// ================================
// ARRÊT PROPRE
// ================================

async function shutdown() {
  stopTimers();

  if (heliusWs) {
    try {
      heliusWs.close();
    } catch (_) {}
  }

  if (sessionRunning) {
    const price =
      lastMarketData?.priceUsd;

    if (
      Number.isFinite(price) &&
      price > 0
    ) {
      await forceCloseAll(
        "SESSION_LIMIT",
        price
      );
    }

    saveComparisonReport(
      "PROCESS_SHUTDOWN"
    );
  }
}

process.on(
  "SIGINT",
  async () => {
    await shutdown();
    process.exit(0);
  }
);

process.on(
  "SIGTERM",
  async () => {
    await shutdown();
    process.exit(0);
  }
);

// ================================
// MAIN
// ================================

async function main() {
  console.log(
    "===================================="
  );

  console.log(
    "🧪 PUMP RADAR V5.9"
  );

  console.log(
    "===================================="
  );

  console.log(
    `Token: ${TOKEN_MINT}`
  );

  console.log(
    `Capital: $${CAPITAL_USD}`
  );

  console.log(
    `Target: +${TARGET_PCT * 100}%`
  );

  console.log(
    `Stops: ${
      STOP_VARIANTS
        .map(x => x.label)
        .join(" / ")
    }`
  );

  console.log(
    `RPC: ${
      HELIUS_API_KEY
        ? "Helius"
        : "Public Solana"
    }`
  );

  console.log(
    `Data: ${DATA_DIR}`
  );

  if (!BOT_TOKEN) {
    console.log(
      "❌ BOT_TOKEN absent"
    );
  }

  if (!CHAT_ID) {
    console.log(
      "⚠️ CHAT_ID absent"
    );
  }

  setupSolana();

  setupTelegram();

  setupHeliusDiagnostics();
}

main().catch(
  err => {
    console.error(
      "❌ Erreur fatale V5.9:",
      err
    );

    process.exit(1);
  }
);
