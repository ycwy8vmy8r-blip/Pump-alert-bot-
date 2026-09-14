const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const { Connection, PublicKey } = require("@solana/web3.js");
const { Telegraf } = require("telegraf");

/*
===========================================================
 PUMP TEST BOT V5.2
===========================================================

 STRATEGIE :

 - Capital fixe : 10 $
 - Objectif : +5 %
 - Simulation uniquement
 - Pas de wallet
 - Pas de clé privée
 - Pas de transaction réelle

 NOUVEAUTE V5.2 :

 - DEX Screener = prix/liquidité secondaire
 - Helius WSS = surveillance directe du pool PumpSwap
 - Surveillance des vaults base + quote
 - Détection :
      BUY
      SELL
      WITHDRAWAL
      LIQUIDITY ADD
      RESERVE SHOCK
 - Blocage d'achat après anomalie on-chain
 - Rapport crash Telegram
 - Historique 60 secondes
 - Sauvegarde locale
 - Reconnexion WebSocket
===========================================================
*/

// ========================================================
// CONFIG
// ========================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const DEFAULT_MINT =
  "HjoAZW2wFe4tUmHXwkUsRddiSLq4Ej5JzvM4UBydwaXv";

const CAPITAL_USD = 10;
const TARGET_PROFIT = 0.05;

const POLL_MS = 2000;

const HISTORY_MS = 120000;
const CRASH_HISTORY_MS = 60000;

const OBSERVATION_AFTER_SELL_MS = 30000;

const NO_NEW_BUY_AFTER_MS = 43 * 60 * 1000;
const MAX_SESSION_MS = 45 * 60 * 1000;

// Entrée
const MIN_LIQUIDITY_USD = 3000;
const MIN_HEALTH_SCORE = 80;
const REQUIRED_CONFIRMATIONS = 4;

// Dégradation DEX
const ENTRY_PRICE_DROP_10S = -0.04;
const ENTRY_LIQ_DROP_10S = -0.10;
const ENTRY_LIQ_DROP_30S = -0.15;

// Crash DEX
const CRASH_PRICE_DROP_10S = -0.20;
const CRASH_LIQ_DROP_10S = -0.50;
const CRASH_MIN_LIQUIDITY = 1;

// On-chain
const ONCHAIN_BATCH_MS = 80;

const ONCHAIN_WITHDRAWAL_BLOCK_MS = 30000;

const ONCHAIN_RESERVE_SHOCK_5S = -0.05;
const ONCHAIN_RESERVE_SHOCK_10S = -0.10;

const ONCHAIN_MIN_CHANGE_SOL = 0.01;

// PumpSwap
const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// ========================================================
// PATHS
// ========================================================

const DATA_DIR =
  fs.existsSync("/data")
    ? "/data"
    : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MARKET_FILE =
  path.join(DATA_DIR, "market_history.jsonl");

const TRADES_FILE =
  path.join(DATA_DIR, "trade_history.json");

const CRASH_FILE =
  path.join(DATA_DIR, "crash_reports.json");

const SUMMARY_FILE =
  path.join(DATA_DIR, "v52_summary.json");

// ========================================================
// TELEGRAM
// ========================================================

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN ou CHAT_ID manquant.");
  process.exit(1);
}

if (!HELIUS_API_KEY) {
  console.error("❌ HELIUS_API_KEY manquant.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ========================================================
// SOLANA
// ========================================================

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, {
  commitment: "processed",
});

// ========================================================
// ETAT
// ========================================================

let running = false;
let mint = DEFAULT_MINT;

let marketTimer = null;
let sessionTimer = null;

let sessionStart = null;

let currentPrice = null;
let currentLiquidity = null;

let position = null;

let cycleNumber = 0;
let totalProfit = 0;

let observationUntil = 0;
let noNewBuyUntil = 0;

let favorableConfirmations = 0;

let healthScore = 100;

let lastMarketData = null;

let marketHistory = [];
let onchainHistory = [];

let crashReports = [];
let tradeHistory = [];

// ========================================================
// ON-CHAIN STATE
// ========================================================

let ws = null;

let wsReconnectTimer = null;
let wsReconnectAttempts = 0;

let poolAddress = null;
let baseVaultAddress = null;
let quoteVaultAddress = null;

let poolBaseMint = null;
let poolQuoteMint = null;

let virtualQuoteReserves = 0n;

let baseVaultState = {
  amount: null,
  slot: null,
};

let quoteVaultState = {
  amount: null,
  slot: null,
};

let lastProcessedVaults = {
  base: null,
  quote: null,
};

let onchainBatchTimer = null;

let lastOnchainEvent = null;

let onchainBlockedUntil = 0;

let lastOnchainRisk = null;

// ========================================================
// LOAD DATA
// ========================================================

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (error) {
    console.error(
      `⚠️ Impossible de lire ${file}:`,
      error.message
    );

    return fallback;
  }
}

tradeHistory =
  loadJson(TRADES_FILE, []);

crashReports =
  loadJson(CRASH_FILE, []);

const summary =
  loadJson(SUMMARY_FILE, {
    totalProfit: 0,
  });

totalProfit =
  Number(summary.totalProfit || 0);

// ========================================================
// SAVE
// ========================================================

function saveJson(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    console.error(
      `❌ Erreur sauvegarde ${file}:`,
      error.message
    );
  }
}

function appendMarketPoint(point) {
  try {
    fs.appendFileSync(
      MARKET_FILE,
      JSON.stringify(point) + "\n"
    );
  } catch (error) {
    console.error(
      "❌ Erreur market_history:",
      error.message
    );
  }
}

function saveSummary() {
  saveJson(
    SUMMARY_FILE,
    {
      updatedAt: new Date().toISOString(),
      mint,
      totalProfit,
      cyclesCompleted: cycleNumber,
      sessionStart,
    }
  );
}

// ========================================================
// TELEGRAM HELPERS
// ========================================================

async function telegram(message) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      message
    );
  } catch (error) {
    console.error(
      "❌ Telegram:",
      error.message
    );
  }
}

// ========================================================
// FORMAT
// ========================================================

function shortMint(value) {
  if (!value) return "???";

  return (
    value.slice(0, 6) +
    "..." +
    value.slice(-6)
  );
}

function money(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `$${value.toFixed(4)}`;
}

function pct(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `${value.toFixed(2)}%`;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return value < 0.001
    ? value.toFixed(10)
    : value.toFixed(8);
}

// ========================================================
// DEXSCREENER
// ========================================================

async function getMarketData() {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  try {
    const response =
      await fetch(url);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data ||
      !Array.isArray(data.pairs) ||
      data.pairs.length === 0
    ) {
      return null;
    }

    const pumpPairs =
      data.pairs.filter(
        pair =>
          String(pair.dexId || "")
            .toLowerCase() ===
          "pumpswap"
      );

    if (pumpPairs.length === 0) {
      return null;
    }

    pumpPairs.sort(
      (a, b) =>
        Number(b.liquidity?.usd || 0) -
        Number(a.liquidity?.usd || 0)
    );

    const pair =
      pumpPairs[0];

    const price =
      Number(pair.priceUsd || 0);

    const liquidity =
      Number(pair.liquidity?.usd || 0);

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return null;
    }

    return {
      timestamp: Date.now(),
      price,
      liquidity,
      pairAddress:
        pair.pairAddress || null,

      volume24h:
        Number(pair.volume?.h24 || 0),

      buys5m:
        Number(pair.txns?.m5?.buys || 0),

      sells5m:
        Number(pair.txns?.m5?.sells || 0),

      priceChange5m:
        Number(pair.priceChange?.m5 || 0),

      priceChange1h:
        Number(pair.priceChange?.h1 || 0),
    };

  } catch (error) {
    console.error(
      "⚠️ DexScreener:",
      error.message
    );

    return null;
  }
}

// ========================================================
// HISTORY HELPERS
// ========================================================

function cleanupHistory() {
  const cutoff =
    Date.now() - HISTORY_MS;

  marketHistory =
    marketHistory.filter(
      x => x.timestamp >= cutoff
    );

  const onchainCutoff =
    Date.now() - HISTORY_MS;

  onchainHistory =
    onchainHistory.filter(
      x => x.timestamp >= onchainCutoff
    );
}

function getPreviousPoint(msAgo) {
  const target =
    Date.now() - msAgo;

  let best = null;

  for (
    let i = marketHistory.length - 1;
    i >= 0;
    i--
  ) {
    const point =
      marketHistory[i];

    if (
      point.timestamp <= target
    ) {
      best = point;
      break;
    }
  }

  return best;
}

function percentageChange(
  current,
  previous
) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous <= 0
  ) {
    return null;
  }

  return (
    (current - previous) /
    previous
  );
}

// ========================================================
// DEX METRICS
// ========================================================

function getDexMetrics() {
  const previous10 =
    getPreviousPoint(10000);

  const previous30 =
    getPreviousPoint(30000);

  const price10 =
    previous10
      ? percentageChange(
          currentPrice,
          previous10.price
        )
      : null;

  const price30 =
    previous30
      ? percentageChange(
          currentPrice,
          previous30.price
        )
      : null;

  const liquidity10 =
    previous10
      ? percentageChange(
          currentLiquidity,
          previous10.liquidity
        )
      : null;

  const liquidity30 =
    previous30
      ? percentageChange(
          currentLiquidity,
          previous30.liquidity
        )
      : null;

  return {
    price10,
    price30,
    liquidity10,
    liquidity30,
  };
}

// ========================================================
// HEALTH SCORE
// ========================================================

function calculateHealthScore() {
  if (
    !Number.isFinite(currentLiquidity) ||
    currentLiquidity <= 0
  ) {
    return 0;
  }

  let score = 100;

  const metrics =
    getDexMetrics();

  if (
    metrics.liquidity10 !== null &&
    metrics.liquidity10 < -0.05
  ) {
    score -= 20;
  }

  if (
    metrics.liquidity10 !== null &&
    metrics.liquidity10 < -0.10
  ) {
    score -= 20;
  }

  if (
    metrics.liquidity30 !== null &&
    metrics.liquidity30 < -0.15
  ) {
    score -= 20;
  }

  if (
    metrics.price10 !== null &&
    metrics.price10 < -0.03
  ) {
    score -= 15;
  }

  if (
    metrics.price10 !== null &&
    metrics.price10 < -0.05
  ) {
    score -= 20;
  }

  // Anomaly on-chain
  if (
    Date.now() < onchainBlockedUntil
  ) {
    score -= 40;
  }

  if (
    lastOnchainRisk &&
    Date.now() -
      lastOnchainRisk.timestamp <
      30000
  ) {
    score -= 20;
  }

  return Math.max(
    0,
    Math.min(100, score)
  );
}

// ========================================================
// ENTRY FILTER
// ========================================================

function entryHealthy() {
  if (
    !Number.isFinite(currentPrice) ||
    currentPrice <= 0
  ) {
    return false;
  }

  if (
    !Number.isFinite(currentLiquidity) ||
    currentLiquidity <
      MIN_LIQUIDITY_USD
  ) {
    return false;
  }

  if (
    Date.now() <
    observationUntil
  ) {
    return false;
  }

  if (
    Date.now() <
    noNewBuyUntil
  ) {
    return false;
  }

  if (
    Date.now() <
    onchainBlockedUntil
  ) {
    return false;
  }

  const metrics =
    getDexMetrics();

  if (
    metrics.price10 !== null &&
    metrics.price10 <
      ENTRY_PRICE_DROP_10S
  ) {
    return false;
  }

  if (
    metrics.liquidity10 !== null &&
    metrics.liquidity10 <
      ENTRY_LIQ_DROP_10S
  ) {
    return false;
  }

  if (
    metrics.liquidity30 !== null &&
    metrics.liquidity30 <
      ENTRY_LIQ_DROP_30S
  ) {
    return false;
  }

  healthScore =
    calculateHealthScore();

  if (
    healthScore <
    MIN_HEALTH_SCORE
  ) {
    return false;
  }

  if (
    favorableConfirmations <
    REQUIRED_CONFIRMATIONS
  ) {
    return false;
  }

  return true;
}

// ========================================================
// CRASH DETECTION
// ========================================================

function detectCrash() {
  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(currentLiquidity)
  ) {
    return null;
  }

  const metrics =
    getDexMetrics();

  const reasons = [];

  if (
    currentLiquidity <=
    CRASH_MIN_LIQUIDITY
  ) {
    reasons.push(
      "liquidité quasi nulle"
    );
  }

  if (
    metrics.liquidity10 !== null &&
    metrics.liquidity10 <=
      CRASH_LIQ_DROP_10S
  ) {
    reasons.push(
      `liquidité ${pct(
        metrics.liquidity10 * 100
      )} / 10s`
    );
  }

  if (
    metrics.price10 !== null &&
    metrics.price10 <=
      CRASH_PRICE_DROP_10S
  ) {
    reasons.push(
      `prix ${pct(
        metrics.price10 * 100
      )} / 10s`
    );
  }

  // Signal on-chain critique
  if (
    lastOnchainRisk &&
    lastOnchainRisk.level ===
      "CRITICAL_WITHDRAWAL"
  ) {
    reasons.push(
      "retrait de liquidité détecté on-chain"
    );
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    reasons,
    metrics,
  };
}

// ========================================================
// PUMPSWAP POOL DECODER
// ========================================================

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

  return new PublicKey(
    buffer.subarray(
      offset,
      offset + 32
    )
  );
}

function readU64LE(
  buffer,
  offset
) {
  if (
    !buffer ||
    buffer.length <
      offset + 8
  ) {
    return null;
  }

  return buffer.readBigUInt64LE(
    offset
  );
}

function readI128LE(
  buffer,
  offset
) {
  if (
    !buffer ||
    buffer.length <
      offset + 16
  ) {
    return 0n;
  }

  return buffer.readBigInt64LE(offset) +
    (buffer.readBigInt64LE(offset + 8) << 64n);
}

/*
 PumpSwap Pool layout:

 discriminator              0-8
 bump                       8
 index                      9-11
 creator                   11-43
 base_mint                 43-75
 quote_mint                75-107
 lp_mint                   107-139
 pool_base_token_account   139-171
 pool_quote_token_account  171-203
 lp_supply                 203-211
 coin_creator              211-243
 is_mayhem_mode            243
 is_cashback_coin          244
 virtual_quote_reserves    245-261
*/

function decodePool(buffer) {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 203
  ) {
    throw new Error(
      "Données Pool PumpSwap trop courtes."
    );
  }

  const baseMint =
    readPubkey(buffer, 43);

  const quoteMint =
    readPubkey(buffer, 75);

  const baseVault =
    readPubkey(buffer, 139);

  const quoteVault =
    readPubkey(buffer, 171);

  const virtualQuote =
    buffer.length >= 261
      ? readI128LE(buffer, 245)
      : 0n;

  return {
    baseMint:
      baseMint?.toBase58(),

    quoteMint:
      quoteMint?.toBase58(),

    baseVault:
      baseVault?.toBase58(),

    quoteVault:
      quoteVault?.toBase58(),

    virtualQuoteReserves:
      virtualQuote,
  };
}

// ========================================================
// VERIFY POOL
// ========================================================

async function loadPool(poolAddressCandidate) {
  if (!poolAddressCandidate) {
    return null;
  }

  try {
    const poolPk =
      new PublicKey(
        poolAddressCandidate
      );

    const account =
      await connection.getAccountInfo(
        poolPk,
        "processed"
      );

    if (!account) {
      throw new Error(
        "Compte pool introuvable."
      );
    }

    const owner =
      account.owner.toBase58();

    if (
      owner !== PUMPSWAP_PROGRAM
    ) {
      throw new Error(
        `Owner inattendu: ${owner}`
      );
    }

    const decoded =
      decodePool(account.data);

    if (
      decoded.baseMint !== mint
    ) {
      throw new Error(
        "Le base mint du pool ne correspond pas au token."
      );
    }

    if (
      decoded.quoteMint !== WSOL_MINT
    ) {
      throw new Error(
        "Pool non pairé avec WSOL."
      );
    }

    poolAddress =
      poolAddressCandidate;

    baseVaultAddress =
      decoded.baseVault;

    quoteVaultAddress =
      decoded.quoteVault;

    poolBaseMint =
      decoded.baseMint;

    poolQuoteMint =
      decoded.quoteMint;

    virtualQuoteReserves =
      decoded.virtualQuoteReserves;

    console.log(
      "⛓️ Pool PumpSwap validé."
    );

    console.log(
      `Pool : ${poolAddress}`
    );

    console.log(
      `Base vault : ${baseVaultAddress}`
    );

    console.log(
      `Quote vault : ${quoteVaultAddress}`
    );

    console.log(
      `Virtual quote : ${virtualQuoteReserves.toString()}`
    );

    return decoded;

  } catch (error) {
    console.error(
      "❌ Vérification pool:",
      error.message
    );

    return null;
  }
}

// ========================================================
// TOKEN ACCOUNT DECODER
// ========================================================

function decodeTokenAmount(base64) {
  try {
    const buffer =
      Buffer.from(
        base64,
        "base64"
      );

    if (
      buffer.length < 72
    ) {
      return null;
    }

    return buffer.readBigUInt64LE(
      64
    );

  } catch {
    return null;
  }
}

// ========================================================
// ONCHAIN WS
// ========================================================

function resetOnchainState() {
  baseVaultState = {
    amount: null,
    slot: null,
  };

  quoteVaultState = {
    amount: null,
    slot: null,
  };

  lastProcessedVaults = {
    base: null,
    quote: null,
  };

  lastOnchainEvent = null;
}

function closeOnchainWs() {
  if (onchainBatchTimer) {
    clearTimeout(
      onchainBatchTimer
    );

    onchainBatchTimer = null;
  }

  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {}

    ws = null;
  }
}

function scheduleOnchainBatch() {
  if (onchainBatchTimer) {
    return;
  }

  onchainBatchTimer =
    setTimeout(() => {
      onchainBatchTimer = null;

      processOnchainBatch();

    }, ONCHAIN_BATCH_MS);
}

function handleVaultNotification(
  vaultType,
  result
) {
  try {
    const slot =
      Number(
        result.context?.slot || 0
      );

    const value =
      result.value;

    if (
      !value ||
      !value.data ||
      !Array.isArray(value.data)
    ) {
      return;
    }

    const encoded =
      value.data[0];

    const amount =
      decodeTokenAmount(
        encoded
      );

    if (amount === null) {
      return;
    }

    if (
      vaultType === "base"
    ) {
      baseVaultState = {
        amount,
        slot,
      };
    }

    if (
      vaultType === "quote"
    ) {
      quoteVaultState = {
        amount,
        slot,
      };
    }

    scheduleOnchainBatch();

  } catch (error) {
    console.error(
      "⚠️ Vault notification:",
      error.message
    );
  }
}

// ========================================================
// ONCHAIN CLASSIFICATION
// ========================================================

function classifyOnchainDelta(
  deltaBase,
  deltaQuote
) {
  const baseSol =
    Number(deltaBase) / 1e9;

  const quoteSol =
    Number(deltaQuote) / 1e9;

  const absBase =
    Math.abs(baseSol);

  const absQuote =
    Math.abs(quoteSol);

  if (
    absBase < ONCHAIN_MIN_CHANGE_SOL &&
    absQuote < ONCHAIN_MIN_CHANGE_SOL
  ) {
    return {
      type: "SMALL",
      baseSol,
      quoteSol,
    };
  }

  if (
    deltaBase > 0n &&
    deltaQuote < 0n
  ) {
    return {
      type: "BUY",
      baseSol,
      quoteSol,
    };
  }

  if (
    deltaBase < 0n &&
    deltaQuote > 0n
  ) {
    return {
      type: "SELL",
      baseSol,
      quoteSol,
    };
  }

  if (
    deltaBase < 0n &&
    deltaQuote < 0n
  ) {
    return {
      type: "WITHDRAWAL",
      baseSol,
      quoteSol,
    };
  }

  if (
    deltaBase > 0n &&
    deltaQuote > 0n
  ) {
    return {
      type: "ADD_LIQUIDITY",
      baseSol,
      quoteSol,
    };
  }

  return {
    type: "OTHER",
    baseSol,
    quoteSol,
  };
}

function processOnchainBatch() {
  if (
    baseVaultState.amount === null ||
    quoteVaultState.amount === null
  ) {
    return;
  }

  if (
    baseVaultState.slot === null ||
    quoteVaultState.slot === null
  ) {
    return;
  }

  /*
   On ne classe que lorsque les deux
   vaults appartiennent au même slot.

   Cela évite de mélanger deux opérations
   différentes.
  */

  if (
    baseVaultState.slot !==
    quoteVaultState.slot
  ) {
    return;
  }

  const base =
    baseVaultState.amount;

  const quote =
    quoteVaultState.amount;

  if (
    lastProcessedVaults.base === null ||
    lastProcessedVaults.quote === null
  ) {
    lastProcessedVaults = {
      base,
      quote,
    };

    return;
  }

  const deltaBase =
    base -
    lastProcessedVaults.base;

  const deltaQuote =
    quote -
    lastProcessedVaults.quote;

  if (
    deltaBase === 0n &&
    deltaQuote === 0n
  ) {
    return;
  }

  const classification =
    classifyOnchainDelta(
      deltaBase,
      deltaQuote
    );

  const event = {
    timestamp: Date.now(),
    slot:
      baseVaultState.slot,

    type:
      classification.type,

    deltaBase:
      deltaBase.toString(),

    deltaQuote:
      deltaQuote.toString(),

    deltaBaseSOL:
      classification.baseSol,

    deltaQuoteSOL:
      classification.quoteSol,

    baseReserve:
      base.toString(),

    quoteReserve:
      quote.toString(),

    virtualQuoteReserves:
      virtualQuoteReserves.toString(),

    effectiveQuoteReserve:
      (
        quote +
        virtualQuoteReserves
      ).toString(),
  };

  onchainHistory.push(
    event
  );

  lastOnchainEvent =
    event;

  lastProcessedVaults = {
    base,
    quote,
  };

  evaluateOnchainRisk(
    event
  );

  console.log(
    `⛓️ ONCHAIN ${event.type} | ` +
    `base ${event.deltaBaseSOL.toFixed(4)} SOL | ` +
    `quote ${event.deltaQuoteSOL.toFixed(4)} SOL`
  );
}

// ========================================================
// ONCHAIN RISK
// ========================================================

function evaluateOnchainRisk(
  event
) {
  const now =
    Date.now();

  if (
    event.type ===
    "WITHDRAWAL"
  ) {
    onchainBlockedUntil =
      Math.max(
        onchainBlockedUntil,
        now +
          ONCHAIN_WITHDRAWAL_BLOCK_MS
      );

    lastOnchainRisk = {
      timestamp: now,
      level:
        "CRITICAL_WITHDRAWAL",
      event,
    };

    console.log(
      "🚨 RETRAIT DE LIQUIDITÉ ON-CHAIN"
    );

    telegram(
      `🚨 ANOMALIE ON-CHAIN

Token :
${mint}

Pool :
${shortMint(poolAddress)}

⚠️ RETRAIT DE LIQUIDITÉ DÉTECTÉ

Base :
${event.deltaBaseSOL.toFixed(4)} SOL

Quote :
${event.deltaQuoteSOL.toFixed(4)} SOL

⛔ Nouvel achat bloqué pendant 30 secondes.

Simulation uniquement.`
    );

    return;
  }

  if (
    event.type ===
    "ADD_LIQUIDITY"
  ) {
    lastOnchainRisk = {
      timestamp: now,
      level:
        "LIQUIDITY_ADDED",
      event,
    };

    return;
  }

  // Vérification d'un choc de réserve
  const previous =
    getPreviousOnchain(
      event.timestamp,
      5000
    );

  if (previous) {
    const currentBase =
      Number(event.baseReserve);

    const previousBase =
      Number(previous.baseReserve);

    const currentQuote =
      Number(event.quoteReserve);

    const previousQuote =
      Number(previous.quoteReserve);

    if (
      previousBase > 0 &&
      previousQuote > 0
    ) {
      const baseChange =
        (currentBase -
          previousBase) /
        previousBase;

      const quoteChange =
        (currentQuote -
          previousQuote) /
        previousQuote;

      if (
        baseChange <=
          ONCHAIN_RESERVE_SHOCK_5S &&
        quoteChange <=
          ONCHAIN_RESERVE_SHOCK_5S
      ) {
        onchainBlockedUntil =
          Math.max(
            onchainBlockedUntil,
            now +
              ONCHAIN_WITHDRAWAL_BLOCK_MS
          );

        lastOnchainRisk = {
          timestamp: now,
          level:
            "RESERVE_SHOCK",
          baseChange,
          quoteChange,
          event,
        };

        console.log(
          "🚨 CHOC DES RÉSERVES ON-CHAIN"
        );

        telegram(
          `🚨 CHOC DES RÉSERVES ON-CHAIN

Token :
${mint}

Base :
${pct(baseChange * 100)}

Quote :
${pct(quoteChange * 100)}

⛔ Nouveau cycle temporairement bloqué.`
        );
      }
    }
  }
}

function getPreviousOnchain(
  timestamp,
  msAgo
) {
  const target =
    timestamp - msAgo;

  for (
    let i =
      onchainHistory.length - 1;
    i >= 0;
    i--
  ) {
    const point =
      onchainHistory[i];

    if (
      point.timestamp <=
      target
    ) {
      return point;
    }
  }

  return null;
}

// ========================================================
// CONNECT ONCHAIN
// ========================================================

async function connectOnchainMonitor() {
  if (
    !poolAddress ||
    !baseVaultAddress ||
    !quoteVaultAddress
  ) {
    return;
  }

  closeOnchainWs();
  resetOnchainState();

  ws = new WebSocket(
    WSS_URL
  );

  ws.on(
    "open",
    () => {
      console.log(
        "⛓️ Helius WSS on-chain connecté."
      );

      wsReconnectAttempts = 0;

      subscribeAccounts();
    }
  );

  ws.on(
    "message",
    raw => {
      try {
        const message =
          JSON.parse(
            raw.toString()
          );

        if (
          !message.params ||
          !message.params.result
        ) {
          return;
        }

        const result =
          message.params.result;

        /*
         Les IDs sont créés dans
         subscribeAccounts().
        */

        if (
          message.params.subscription ===
          wsBaseSubscriptionId
        ) {
          handleVaultNotification(
            "base",
            result
          );
        }

        if (
          message.params.subscription ===
          wsQuoteSubscriptionId
        ) {
          handleVaultNotification(
            "quote",
            result
          );
        }

        if (
          message.params.subscription ===
          wsPoolSubscriptionId
        ) {
          handlePoolUpdate(
            result
          );
        }

      } catch (error) {
        console.error(
          "⚠️ WSS message:",
          error.message
        );
      }
    }
  );

  ws.on(
    "close",
    () => {
      if (!running) {
        return;
      }

      console.log(
        "⚠️ Helius WSS fermé."
      );

      scheduleReconnect();
    }
  );

  ws.on(
    "error",
    error => {
      console.error(
        "⚠️ Helius WSS:",
        error.message
      );
    }
  );
}

let wsBaseSubscriptionId = null;
let wsQuoteSubscriptionId = null;
let wsPoolSubscriptionId = null;

function subscribeAccounts() {
  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  const baseId =
    1001;

  const quoteId =
    1002;

  const poolId =
    1003;

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: baseId,
      method:
        "accountSubscribe",
      params: [
        baseVaultAddress,
        {
          encoding:
            "base64",
          commitment:
            "processed",
        },
      ],
    })
  );

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: quoteId,
      method:
        "accountSubscribe",
      params: [
        quoteVaultAddress,
        {
          encoding:
            "base64",
          commitment:
            "processed",
        },
      ],
    })
  );

  /*
   On surveille aussi le compte Pool lui-même.
   Cela permet de récupérer une éventuelle
   évolution de virtual_quote_reserves.
  */

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: poolId,
      method:
        "accountSubscribe",
      params: [
        poolAddress,
        {
          encoding:
            "base64",
          commitment:
            "processed",
        },
      ],
    })
  );
}

function handlePoolUpdate(
  result
) {
  try {
    const value =
      result.value;

    if (
      !value ||
      !value.data ||
      !Array.isArray(value.data)
    ) {
      return;
    }

    const buffer =
      Buffer.from(
        value.data[0],
        "base64"
      );

    if (
      buffer.length <
      203
    ) {
      return;
    }

    const decoded =
      decodePool(buffer);

    if (
      decoded.baseMint !==
      mint
    ) {
      return;
    }

    if (
      decoded.quoteMint !==
      WSOL_MINT
    ) {
      return;
    }

    if (
      decoded.baseVault !==
      baseVaultAddress ||
      decoded.quoteVault !==
      quoteVaultAddress
    ) {
      return;
    }

    virtualQuoteReserves =
      decoded.virtualQuoteReserves;

  } catch (error) {
    console.error(
      "⚠️ Pool update:",
      error.message
    );
  }
}

function scheduleReconnect() {
  if (
    wsReconnectTimer ||
    !running
  ) {
    return;
  }

  wsReconnectAttempts++;

  const delay =
    Math.min(
      30000,
      1000 *
        Math.pow(
          2,
          Math.min(
            wsReconnectAttempts,
            5
          )
        )
    );

  wsReconnectTimer =
    setTimeout(
      async () => {
        wsReconnectTimer = null;

        if (!running) {
          return;
        }

        console.log(
          `🔄 Reconnexion Helius dans ${delay} ms`
        );

        await connectOnchainMonitor();

      },
      delay
    );
}

// ========================================================
// INITIAL ONCHAIN SNAPSHOT
// ========================================================

async function initializeVaultState() {
  try {
    const accounts =
      await connection.getMultipleAccountsInfo(
        [
          new PublicKey(
            baseVaultAddress
          ),
          new PublicKey(
            quoteVaultAddress
          ),
        ],
        "processed"
      );

    if (
      !accounts ||
      accounts.length !== 2 ||
      !accounts[0] ||
      !accounts[1]
    ) {
      return;
    }

    const baseBuffer =
      accounts[0].data;

    const quoteBuffer =
      accounts[1].data;

    if (
      baseBuffer.length < 72 ||
      quoteBuffer.length < 72
    ) {
      return;
    }

    const baseAmount =
      baseBuffer.readBigUInt64LE(
        64
      );

    const quoteAmount =
      quoteBuffer.readBigUInt64LE(
        64
      );

    const slot =
      await connection.getSlot(
        "processed"
      );

    baseVaultState = {
      amount: baseAmount,
      slot,
    };

    quoteVaultState = {
      amount: quoteAmount,
      slot,
    };

    lastProcessedVaults = {
      base: baseAmount,
      quote: quoteAmount,
    };

    console.log(
      "⛓️ Réserves initiales chargées."
    );

  } catch (error) {
    console.error(
      "⚠️ Initialisation vaults:",
      error.message
    );
  }
}

// ========================================================
// CRASH REPORT
// ========================================================

function getLast60Seconds() {
  const cutoff =
    Date.now() -
    CRASH_HISTORY_MS;

  return {
    market:
      marketHistory.filter(
        x =>
          x.timestamp >=
          cutoff
      ),

    onchain:
      onchainHistory.filter(
        x =>
          x.timestamp >=
          cutoff
      ),
  };
}

async function saveCrashReport(
  crashInfo
) {
  const snapshot =
    getLast60Seconds();

  const report = {
    id:
      `crash_${Date.now()}`,

    timestamp:
      new Date().toISOString(),

    sessionStart,

    mint,

    cyclesCompleted:
      cycleNumber,

    sessionProfit:
      totalProfit,

    crashMarket: {
      price:
        currentPrice,

      liquidity:
        currentLiquidity,

      priceChange10s:
        crashInfo.metrics.price10 !== null
          ? crashInfo.metrics.price10 * 100
          : null,

      liquidityChange10s:
        crashInfo.metrics.liquidity10 !== null
          ? crashInfo.metrics.liquidity10 * 100
          : null,

      score:
        healthScore,
    },

    onchain: {
      poolAddress,

      baseVaultAddress,

      quoteVaultAddress,

      virtualQuoteReserves:
        virtualQuoteReserves.toString(),

      lastEvent:
        lastOnchainEvent,

      lastRisk:
        lastOnchainRisk,
    },

    reasons:
      crashInfo.reasons,

    openPosition:
      position,

    last60Seconds:
      snapshot,
  };

  crashReports.push(
    report
  );

  saveJson(
    CRASH_FILE,
    crashReports
  );

  console.log(
    `🚨 CRASH enregistré : ${report.id}`
  );

  await sendCrashTelegram(
    report
  );
}

async function sendCrashTelegram(
  report
) {
  const lastOnchain =
    report.onchain?.lastEvent;

  let onchainText =
    "Aucun événement on-chain récent.";

  if (lastOnchain) {
    onchainText =
      `Dernier événement :
${lastOnchain.type}

Base :
${Number(
  lastOnchain.deltaBaseSOL
).toFixed(4)} SOL

Quote :
${Number(
  lastOnchain.deltaQuoteSOL
).toFixed(4)} SOL`;
  }

  const message =
`🚨 STOP CRASH - V5.2

Token :
${report.mint}

Prix :
${formatPrice(
  report.crashMarket.price
)}

Liquidité :
${money(
  report.crashMarket.liquidity
)}

Prix / 10s :
${pct(
  report.crashMarket.priceChange10s
)}

Liquidité / 10s :
${pct(
  report.crashMarket.liquidityChange10s
)}

🧠 Score :
${report.crashMarket.score}/100

⛓️ ON-CHAIN
${onchainText}

⚠️ Signaux :
${report.reasons
  .map(x => `• ${x}`)
  .join("\n")}

⚠️ Position restante :
${
  report.openPosition
    ? report.openPosition.tokens
    : "Aucune"
} tokens

⚠️ Prix de sortie NON considéré fiable.

📊 Données des 60 dernières secondes :
sauvegardées dans crash_reports.json

💰 Bénéfices simulés :
${money(report.sessionProfit)}

⛔ Radar arrêté.

Simulation uniquement.`;

  await telegram(
    message
  );
}

// ========================================================
// TRADE HISTORY
// ========================================================

function saveTrade(
  trade
) {
  tradeHistory.push(
    trade
  );

  saveJson(
    TRADES_FILE,
    tradeHistory
  );

  saveSummary();
}

// ========================================================
// BUY
// ========================================================

async function simulateBuy() {
  if (
    position
  ) {
    return;
  }

  if (
    !entryHealthy()
  ) {
    return;
  }

  cycleNumber++;

  const entryPrice =
    currentPrice;

  const tokens =
    CAPITAL_USD /
    entryPrice;

  const targetPrice =
    entryPrice *
    (1 + TARGET_PROFIT);

  position = {
    cycle:
      cycleNumber,

    mint,

    entryPrice,

    tokens,

    capital:
      CAPITAL_USD,

    targetPrice,

    timestamp:
      Date.now(),
  };

  await telegram(
`🟢 ACHAT TEST V5.2 #${cycleNumber}

Token :
${mint}

Mise fixe :
${money(CAPITAL_USD)}

Prix :
${formatPrice(entryPrice)}

Tokens :
${tokens.toFixed(8)}

🎯 Objectif :
+${(
  TARGET_PROFIT *
  100
).toFixed(2)}%

Prix cible :
${formatPrice(targetPrice)}

💧 Liquidité :
${money(currentLiquidity)}

🧠 Score :
${healthScore}/100

⛓️ Pool PumpSwap :
${shortMint(poolAddress)}

🛡️ Entrée :
${favorableConfirmations}/${REQUIRED_CONFIRMATIONS}

Simulation uniquement.`
  );
}

// ========================================================
// SELL
// ========================================================

async function simulateSell(
  reason = "TARGET"
) {
  if (
    !position
  ) {
    return;
  }

  /*
   On ne simule pas une vente pendant
   une situation de liquidité critique.
  */

  if (
    currentLiquidity <=
      CRASH_MIN_LIQUIDITY ||
    healthScore <= 20
  ) {
    return;
  }

  const entryPrice =
    position.entryPrice;

  const targetPrice =
    entryPrice *
    (1 + TARGET_PROFIT);

  /*
   Pour le test, on ne prétend pas avoir
   vendu à un prix meilleur que celui observé.
  */

  const exitPrice =
    reason === "TARGET"
      ? targetPrice
      : currentPrice;

  const exitAmount =
    position.tokens *
    exitPrice;

  const profit =
    exitAmount -
    position.capital;

  totalProfit +=
    profit;

  saveTrade({
    timestamp:
      new Date().toISOString(),

    cycle:
      position.cycle,

    mint,

    entryPrice,

    exitPrice,

    capital:
      position.capital,

    exitAmount,

    profit,

    reason,
  });

  await telegram(
`🔴 VENTE TEST V5.2 #${position.cycle}

Prix :
${formatPrice(exitPrice)}

Montant simulé :
${money(exitAmount)}

Résultat :
${pct(
  (profit /
    position.capital) *
    100
)}

Bénéfice réalisé :
${profit >= 0 ? "+" : ""}${money(profit)}

💰 Bénéfices cumulés :
${money(totalProfit)}

🛡️ NOUVELLE PHASE DE SÉCURITÉ

⏳ Observation du marché :
30 secondes

❌ Aucun rachat immédiat.`
  );

  position = null;

  observationUntil =
    Date.now() +
    OBSERVATION_AFTER_SELL_MS;

  favorableConfirmations = 0;

  saveSummary();
}

// ========================================================
// SESSION END
// ========================================================

async function stopSession(
  reason
) {
  if (!running) {
    return;
  }

  running = false;

  if (marketTimer) {
    clearInterval(
      marketTimer
    );

    marketTimer = null;
  }

  if (sessionTimer) {
    clearTimeout(
      sessionTimer
    );

    sessionTimer = null;
  }

  closeOnchainWs();

  if (
    wsReconnectTimer
  ) {
    clearTimeout(
      wsReconnectTimer
    );

    wsReconnectTimer = null;
  }

  const openPosition =
    position;

  await telegram(
`⛔ SESSION V5.2 ARRÊTÉE

Token :
${mint}

Raison :
${reason}

Cycles terminés :
${cycleNumber}

💰 Bénéfices simulés :
${money(totalProfit)}

${
  openPosition
    ? `⚠️ Position ouverte :
${openPosition.tokens.toFixed(8)} tokens

⚠️ Cette position n'est PAS considérée comme vendue.`
    : "Aucune position ouverte."
}

🧪 Simulation uniquement.`
  );

  saveSummary();
}

// ========================================================
// CRASH STOP
// ========================================================

async function crashStop(
  crashInfo
) {
  if (!running) {
    return;
  }

  running = false;

  if (marketTimer) {
    clearInterval(
      marketTimer
    );

    marketTimer = null;
  }

  if (sessionTimer) {
    clearTimeout(
      sessionTimer
    );

    sessionTimer = null;
  }

  closeOnchainWs();

  if (
    wsReconnectTimer
  ) {
    clearTimeout(
      wsReconnectTimer
    );

    wsReconnectTimer = null;
  }

  await saveCrashReport(
    crashInfo
  );

  position = null;

  saveSummary();

  console.log(
    "⛔ Radar arrêté après crash."
  );
}

// ========================================================
// MARKET LOOP
// ========================================================

async function marketTick() {
  if (!running) {
    return;
  }

  const data =
    await getMarketData();

  if (!data) {
    return;
  }
lastMarketData = data;
  currentPrice =
    data.price;

  currentLiquidity =
    data.liquidity;

  const point = {
    ...data,

    onchainEvent:
      lastOnchainEvent
        ? lastOnchainEvent.type
        : null,

    onchainBlocked:
      Date.now() <
      onchainBlockedUntil,

    healthScore:
      healthScore,
  };

  marketHistory.push(
    point
  );

  cleanupHistory();

  appendMarketPoint(
    point
  );

  /*
   Si le pool a changé,
   on reconstruit le monitoring.
  */

  if (
    data.pairAddress &&
    data.pairAddress !==
      poolAddress
  ) {
    const loaded =
      await loadPool(
        data.pairAddress
      );

    if (loaded) {
      await initializeVaultState();
      await connectOnchainMonitor();
    }
  }

  healthScore =
    calculateHealthScore();

  /*
   Confirmation d'entrée
  */

  if (
    currentLiquidity >=
      MIN_LIQUIDITY_USD &&
    healthScore >=
      MIN_HEALTH_SCORE &&
    Date.now() >=
      observationUntil &&
    Date.now() >=
      noNewBuyUntil &&
    Date.now() >=
      onchainBlockedUntil
  ) {
    favorableConfirmations =
      Math.min(
        REQUIRED_CONFIRMATIONS,
        favorableConfirmations + 1
      );
  } else {
    favorableConfirmations =
      0;
  }

  /*
   CRASH
  */

  const crash =
    detectCrash();

  if (crash) {
    await crashStop(
      crash
    );

    return;
  }

  /*
   POSITION OUVERTE
  */

  if (position) {
    if (
      currentPrice >=
      position.targetPrice
    ) {
      await simulateSell(
        "TARGET"
      );

      return;
    }

    return;
  }

  /*
   PAS DE POSITION
  */

  if (
    entryHealthy()
  ) {
    await simulateBuy();
  }
}

// ========================================================
// SESSION START
// ========================================================

async function startSession(
  requestedMint
) {
  if (running) {
    await telegram(
      "⚠️ Une session est déjà active."
    );

    return;
  }

  mint =
    requestedMint ||
    DEFAULT_MINT;

  try {
    new PublicKey(mint);
  } catch {
    await telegram(
      "❌ Mint Solana invalide."
    );

    return;
  }

  running = true;

  sessionStart =
    new Date().toISOString();

  cycleNumber = 0;

  totalProfit = 0;

  position = null;

  marketHistory = [];

  onchainHistory = [];

  favorableConfirmations = 0;

  observationUntil =
    0;

  noNewBuyUntil =
    Date.now() +
    NO_NEW_BUY_AFTER_MS;

  healthScore = 100;

  poolAddress = null;

  baseVaultAddress = null;

  quoteVaultAddress = null;

  resetOnchainState();

  await telegram(
`🚀 V5.2 DÉMARRÉE

Token :
${mint}

💵 Capital fixe :
${money(CAPITAL_USD)}

🎯 Objectif :
+${(
  TARGET_PROFIT *
  100
).toFixed(2)}%

⛓️ Surveillance :
PumpSwap on-chain

📡 Source secondaire :
DEX Screener

🧠 Protection :
retraits de liquidité
+
chocs de réserves

⏳ Observation après vente :
30 secondes

⏱️ Aucun nouvel achat après :
43 minutes

🛑 Fin de session :
45 minutes

🧪 SIMULATION UNIQUEMENT`
  );

  /*
   Premier tick immédiat
  */

  await marketTick();

  if (!running) {
    return;
  }

  /*
   Recherche du pool après le premier
   résultat DEX.
  */

  if (
    !poolAddress &&
    lastMarketData?.pairAddress
  ) {
    const loaded =
      await loadPool(
        lastMarketData.pairAddress
      );

    if (loaded) {
      await initializeVaultState();
      await connectOnchainMonitor();
    }
  }

  marketTimer =
    setInterval(
      marketTick,
      POLL_MS
    );

  sessionTimer =
    setTimeout(
      async () => {

        if (!running) {
          return;
        }

        /*
         Si une position est ouverte,
         on ne fabrique pas un prix de vente
         si le marché est mauvais.
        */

        if (
          position &&
          currentLiquidity >
            MIN_LIQUIDITY_USD &&
          healthScore >= 60
        ) {
          await simulateSell(
            "SESSION_LIMIT"
          );
        }

        await stopSession(
          "limite de session 45 minutes"
        );

      },
      MAX_SESSION_MS
    );
}

// ========================================================
// STATUS
// ========================================================

async function sendStatus() {
  if (!running) {
    await telegram(
`⚪ V5.2 inactive

💰 Bénéfices cumulés :
${money(totalProfit)}

Cycles :
${cycleNumber}

Dernier crash :
${
  crashReports.length
    ? crashReports[
        crashReports.length - 1
      ].id
    : "aucun"
}`
    );

    return;
  }

  const remainingNoBuy =
    Math.max(
      0,
      noNewBuyUntil -
        Date.now()
    );

  const remainingObservation =
    Math.max(
      0,
      observationUntil -
        Date.now()
    );

  const remainingSession =
    Math.max(
      0,
      MAX_SESSION_MS -
        (
          Date.now() -
          new Date(
            sessionStart
          ).getTime()
        )
    );

  await telegram(
`📊 STATUS V5.2

Token :
${mint}

Prix :
${formatPrice(currentPrice)}

Liquidité :
${money(currentLiquidity)}

🧠 Score :
${healthScore}/100

💰 Profit :
${money(totalProfit)}

Cycles :
${cycleNumber}

⛓️ Pool :
${poolAddress || "non détecté"}

⛓️ Dernier événement :
${
  lastOnchainEvent
    ? lastOnchainEvent.type
    : "aucun"
}

🛡️ Blocage on-chain :
${
  Date.now() <
  onchainBlockedUntil
    ? "OUI"
    : "NON"
}

⏳ Observation :
${
  remainingObservation > 0
    ? Math.ceil(
        remainingObservation /
          1000
      ) + "s"
    : "terminée"
}

⛔ Nouvel achat :
${
  remainingNoBuy > 0
    ? Math.ceil(
        remainingNoBuy /
          60000
      ) + " min"
    : "autorisé"
}

⏱️ Session restante :
${Math.ceil(
  remainingSession /
    60000
)} min

${
  position
    ? `🟢 Position #${position.cycle}
Entrée :
${formatPrice(position.entryPrice)}

Cible :
${formatPrice(position.targetPrice)}`
    : "⚪ Aucune position"
}`
  );
}

// ========================================================
// LAST CRASH
// ========================================================

async function sendLastCrash() {
  if (
    crashReports.length === 0
  ) {
    await telegram(
      "📭 Aucun crash enregistré."
    );

    return;
  }

  const report =
    crashReports[
      crashReports.length - 1
    ];

  const event =
    report.onchain?.lastEvent;

  await telegram(
`📋 DERNIER CRASH V5.2

Token :
${report.mint}

Date :
${report.timestamp}

Prix :
${formatPrice(
  report.crashMarket.price
)}

Liquidité :
${money(
  report.crashMarket.liquidity
)}

Prix / 10s :
${pct(
  report.crashMarket.priceChange10s
)}

Liquidité / 10s :
${pct(
  report.crashMarket.liquidityChange10s
)}

Score :
${report.crashMarket.score}/100

⛓️ Dernier événement :
${
  event
    ? event.type
    : "aucun"
}

💰 Profit avant crash :
${money(
  report.sessionProfit
)}

Cycles :
${report.cyclesCompleted}

⚠️ Le rapport complet est sauvegardé dans :
crash_reports.json`
  );
}

// ========================================================
// COMMANDS
// ========================================================

bot.command(
  "starttrade",
  async ctx => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    const requestedMint =
      parts[1] ||
      DEFAULT_MINT;

    await startSession(
      requestedMint
    );
  }
);

bot.command(
  "stoptrade",
  async () => {
    await stopSession(
      "arrêt manuel"
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
  "lastcrash",
  async () => {
    await sendLastCrash();
  }
);

bot.command(
  "help",
  async () => {
    await telegram(
`🤖 COMMANDES V5.2

/starttrade
Démarrer avec le token par défaut

/starttrade MINT
Démarrer avec un token précis

/status
Voir l'état du test

/stoptrade
Arrêter le test

/lastcrash
Voir le dernier rapport de crash

/help
Afficher cette aide

🧪 Tout est encore en simulation.

💵 Capital :
10 $

🎯 Objectif :
+5 %

⛓️ Surveillance :
PumpSwap on-chain`
    );
  }
);

// ========================================================
// BOT ERRORS
// ========================================================

bot.catch(
  error => {
    console.error(
      "❌ Erreur Telegram:",
      error
    );
  }
);

// ========================================================
// START BOT
// ========================================================

bot.launch()
  .then(() => {
    console.log(
      "🤖 Bot Telegram V5.2 prêt."
    );
  })
  .catch(error => {
    console.error(
      "❌ Impossible de lancer Telegram:",
      error
    );

    process.exit(1);
  });

// ========================================================
// SHUTDOWN
// ========================================================

async function shutdown() {
  console.log(
    "🛑 Arrêt du bot..."
  );

  running = false;

  if (marketTimer) {
    clearInterval(
      marketTimer
    );
  }

  if (sessionTimer) {
    clearTimeout(
      sessionTimer
    );
  }

  closeOnchainWs();

  if (
    wsReconnectTimer
  ) {
    clearTimeout(
      wsReconnectTimer
    );
  }

  try {
    bot.stop(
      "shutdown"
    );
  } catch {}

  process.exit(0);
}

process.once(
  "SIGINT",
  shutdown
);

process.once(
  "SIGTERM",
  shutdown
);
