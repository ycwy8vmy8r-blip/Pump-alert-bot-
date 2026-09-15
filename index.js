require("dotenv").config();

const fs = require("fs");
const path = require("path");
const https = require("https");
const {
  Connection,
  PublicKey
} = require("@solana/web3.js");
const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

/* =========================================================
   V5.8 DIAGNOSTIQUE
   ---------------------------------------------------------
   Simulation uniquement.
   $10 / cycle
   +5% cible
   45 min max
   Aucun nouveau BUY après 43 min

   IMPORTANT :
   - DexScreener = source principale du marché
   - Vérification PumpSwap on-chain = diagnostic
   - L'on-chain NE BLOQUE PAS le BUY simulé
   ========================================================= */

/* =========================
   ENV
   ========================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN manquant");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("❌ CHAT_ID manquant");
  process.exit(1);
}

if (!HELIUS_API_KEY) {
  console.error("❌ HELIUS_API_KEY manquant");
  process.exit(1);
}

/* =========================
   TOKEN
   ========================= */

const TOKEN_MINT =
  "5XnMHrs45GNHqNpPNHd8bepoHdRhFBppZdUieP4MKa1S";

/* =========================
   SOLANA
   ========================= */

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, "processed");

/* =========================
   PROGRAMMES
   ========================= */

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const PUMP_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

/* =========================
   PUMPSWAP OFFSETS
   ========================= */

const OFFSET_BASE_MINT = 43;
const OFFSET_QUOTE_MINT = 75;
const OFFSET_BASE_VAULT = 139;
const OFFSET_QUOTE_VAULT = 171;

/* =========================
   STRATEGIE
   ========================= */

const CAPITAL_USD = 10;

const TARGET_GAIN = 0.05;

const MARKET_INTERVAL_MS = 2000;

const POST_SELL_WAIT_MS = 30000;

const MAX_SESSION_MS = 45 * 60 * 1000;

const NO_NEW_BUY_AFTER_MS = 43 * 60 * 1000;

const MIN_LIQUIDITY_USD = 3000;

const MAX_ENTRY_PRICE_DROP_10S = -0.05;

const MAX_ENTRY_LIQUIDITY_DROP_10S = -0.12;

const MAX_ENTRY_LIQUIDITY_DROP_30S = -0.20;

const CRASH_PRICE_DROP_10S = -0.20;

const CRASH_LIQUIDITY_DROP_10S = -0.50;

const CRASH_LIQUIDITY_USD = 1;

/* =========================
   DATA
   ========================= */

const DATA_DIR =
  fs.existsSync("/data")
    ? "/data"
    : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MARKET_FILE =
  path.join(DATA_DIR, "market_history.jsonl");

const TRADE_FILE =
  path.join(DATA_DIR, "trade_history.json");

const CRASH_FILE =
  path.join(DATA_DIR, "crash_reports.json");

const SUMMARY_FILE =
  path.join(DATA_DIR, "v5_8_summary.json");

/* =========================
   TELEGRAM
   ========================= */

const bot = new Telegraf(BOT_TOKEN);

/* =========================
   ETAT
   ========================= */

let running = false;

let sessionStartedAt = null;

let position = null;

let lastSellAt = 0;

let cycleNumber = 0;

let totalWins = 0;

let totalLosses = 0;

let totalPnl = 0;

let lastMarket = null;

let lastPair = null;

let lastDiagnostic = null;

let lastCrash = null;

let marketTimer = null;

let diagnosticTimer = null;

let heliusWs = null;

let heliusWsTimer = null;

let crashDetected = false;

let stopReason = null;

let priceHistory = [];

let liquidityHistory = [];

let diagnosticStep = 0;

/* =========================
   UTIL
   ========================= */

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pct(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) {
    return null;
  }

  return ((a - b) / b) * 100;
}

function pctSigned(value) {
  if (value === null || !Number.isFinite(value)) {
    return "N/A";
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function usd(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `$${value.toFixed(2)}`;
}

function shortAddress(address) {
  if (!address) return "N/A";
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

/* =========================
   TELEGRAM SEND
   ========================= */

async function send(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text);
  } catch (err) {
    console.error("Telegram send error:", err.message);
  }
}

/* =========================
   HTTP JSON
   ========================= */

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(
      url,
      {
        headers: {
          "User-Agent": "pump-alert-bot-v5.8"
        }
      },
      res => {
        let data = "";

        res.on("data", chunk => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(
              new Error(
                `HTTP ${res.statusCode}: ${data.slice(0, 200)}`
              )
            );
            return;
          }

          try {
            resolve(JSON.parse(data));
          } catch (err) {
            reject(
              new Error("Réponse JSON invalide")
            );
          }
        });
      }
    ).on("error", reject);
  });
}

/* =========================================================
   DEXSCREENER
   ========================================================= */

async function getDexPairs() {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`;

  const data = await getJson(url);

  if (!data || !Array.isArray(data.pairs)) {
    return [];
  }

  return data.pairs.filter(
    pair => pair && pair.chainId === "solana"
  );
}

function isPumpSwapPair(pair) {
  if (!pair) return false;

  const dexId =
    String(pair.dexId || "").toLowerCase();

  return (
    dexId === "pumpswap" ||
    dexId === "pump_amm" ||
    dexId === "pumpamm" ||
    dexId.includes("pump")
  );
}

function chooseBestPair(pairs) {
  const candidates = pairs
    .filter(pair => isPumpSwapPair(pair))
    .filter(pair => {
      const base =
        pair.baseToken?.address;

      const quote =
        pair.quoteToken?.address;

      return (
        base === TOKEN_MINT ||
        quote === TOKEN_MINT
      );
    })
    .sort((a, b) => {
      const la =
        Number(a.liquidity?.usd || 0);

      const lb =
        Number(b.liquidity?.usd || 0);

      return lb - la;
    });

  return candidates[0] || null;
}

/* =========================================================
   DIAGNOSTIQUE DEX
   ========================================================= */

async function diagnoseDex() {
  try {
    const pairs = await getDexPairs();

    const pumpPairs =
      pairs.filter(isPumpSwapPair);

    console.log(
      `🔎 DEX: ${pairs.length} paire(s) Solana, ` +
      `${pumpPairs.length} PumpSwap`
    );

    if (pairs.length > 0) {
      for (const p of pairs.slice(0, 5)) {
        console.log(
          `   ${p.dexId || "?"} | ` +
          `${p.baseToken?.symbol || "?"}/${p.quoteToken?.symbol || "?"} | ` +
          `${usd(Number(p.liquidity?.usd || 0))}`
        );
      }
    }

    const best =
      chooseBestPair(pairs);

    if (!best) {
      return {
        ok: false,
        reason: "NO_PUMPSWAP_PAIR",
        pairs,
        pair: null
      };
    }

    return {
      ok: true,
      reason: "PUMPSWAP_FOUND",
      pairs,
      pair: best
    };

  } catch (err) {
    console.error(
      "❌ DexScreener:",
      err.message
    );

    return {
      ok: false,
      reason: "DEX_ERROR",
      error: err.message,
      pairs: [],
      pair: null
    };
  }
}

/* =========================================================
   ON-CHAIN POOL VALIDATION
   ========================================================= */

function readPubkey(data, offset) {
  if (!data || data.length < offset + 32) {
    return null;
  }

  try {
    return new PublicKey(
      data.slice(offset, offset + 32)
    ).toBase58();
  } catch {
    return null;
  }
}

async function validatePumpSwapPool(pairAddress) {
  try {
    if (!pairAddress) {
      return {
        ok: false,
        reason: "NO_PAIR_ADDRESS"
      };
    }

    const pubkey =
      new PublicKey(pairAddress);

    const info =
      await connection.getAccountInfo(
        pubkey,
        "processed"
      );

    if (!info) {
      return {
        ok: false,
        reason: "POOL_ACCOUNT_NOT_FOUND"
      };
    }

    const owner =
      info.owner.toBase58();

    if (owner !== PUMPSWAP_PROGRAM) {
      return {
        ok: false,
        reason: "WRONG_OWNER",
        owner
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

    const validOrientation =
      (
        baseMint === TOKEN_MINT &&
        quoteMint === WSOL_MINT
      ) ||
      (
        quoteMint === TOKEN_MINT &&
        baseMint === WSOL_MINT
      );

    if (!validOrientation) {
      return {
        ok: false,
        reason: "INVALID_TOKEN_ORIENTATION",
        baseMint,
        quoteMint
      };
    }

    return {
      ok: true,
      owner,
      baseMint,
      quoteMint,
      baseVault,
      quoteVault,
      accountSize: data.length
    };

  } catch (err) {
    return {
      ok: false,
      reason: "ONCHAIN_ERROR",
      error: err.message
    };
  }
}

/* =========================================================
   MARKET DATA
   ========================================================= */

async function getMarketData() {
  try {
    const dex = await diagnoseDex();

    if (!dex.ok || !dex.pair) {
      lastDiagnostic = {
        stage: "DEX",
        status: "BLOCKED",
        reason: dex.reason
      };

      return null;
    }

    const pair = dex.pair;

    lastPair = pair;

    const priceUsd =
      safeNumber(pair.priceUsd);

    const priceNative =
      safeNumber(pair.priceNative);

    const liquidityUsd =
      safeNumber(pair.liquidity?.usd);

    const volume24h =
      safeNumber(pair.volume?.h24);

    const txns24h =
      pair.txns?.h24 || {};

    const buys24h =
      safeNumber(txns24h.buys) || 0;

    const sells24h =
      safeNumber(txns24h.sells) || 0;

    if (
      priceUsd === null ||
      liquidityUsd === null
    ) {
      lastDiagnostic = {
        stage: "DEX_DATA",
        status: "BLOCKED",
        reason: "PRICE_OR_LIQUIDITY_MISSING"
      };

      return null;
    }

    /* -----------------------------------------
       ON-CHAIN DIAGNOSTIC
       ----------------------------------------- */

    const onchain =
      await validatePumpSwapPool(
        pair.pairAddress
      );

    if (onchain.ok) {
      lastDiagnostic = {
        stage: "MARKET",
        status: "OK",
        dex: pair.dexId,
        pair: pair.pairAddress,
        onchain: "VALID_PUMPSWAP",
        priceUsd,
        liquidityUsd
      };
    } else {
      lastDiagnostic = {
        stage: "MARKET",
        status: "OK_DEX_ONLY",
        dex: pair.dexId,
        pair: pair.pairAddress,
        onchain: onchain.reason,
        priceUsd,
        liquidityUsd
      };
    }

    const market = {
      timestamp: now(),

      priceUsd,
      priceNative,

      liquidityUsd,

      volume24h,

      buys24h,
      sells24h,

      dexId: pair.dexId,

      pairAddress:
        pair.pairAddress,

      url:
        pair.url,

      onchainOk:
        onchain.ok,

      onchainReason:
        onchain.ok
          ? "VALID"
          : onchain.reason
    };

    return market;

  } catch (err) {
    lastDiagnostic = {
      stage: "MARKET",
      status: "ERROR",
      reason: err.message
    };

    console.error(
      "❌ Market:",
      err.message
    );

    return null;
  }
}

/* =========================================================
   HISTORY
   ========================================================= */

function addHistory(market) {
  if (!market) return;

  priceHistory.push({
    timestamp: market.timestamp,
    value: market.priceUsd
  });

  liquidityHistory.push({
    timestamp: market.timestamp,
    value: market.liquidityUsd
  });

  const cutoff =
    now() - 120000;

  priceHistory =
    priceHistory.filter(
      x => x.timestamp >= cutoff
    );

  liquidityHistory =
    liquidityHistory.filter(
      x => x.timestamp >= cutoff
    );

  try {
    fs.appendFileSync(
      MARKET_FILE,
      JSON.stringify(market) + "\n"
    );
  } catch (err) {
    console.error(
      "Erreur sauvegarde market:",
      err.message
    );
  }
}

/* =========================================================
   HISTORY HELPERS
   ========================================================= */

function getOldestWithin(
  history,
  seconds
) {
  const target =
    now() - seconds * 1000;

  let candidate = null;

  for (const point of history) {
    if (point.timestamp <= target) {
      candidate = point;
    }
  }

  return candidate;
}

function getChange(history, seconds) {
  if (history.length < 2) {
    return null;
  }

  const current =
    history[history.length - 1];

  const old =
    getOldestWithin(
      history,
      seconds
    );

  if (!old) {
    return null;
  }

  if (
    !Number.isFinite(current.value) ||
    !Number.isFinite(old.value) ||
    old.value === 0
  ) {
    return null;
  }

  return (
    (current.value - old.value) /
    old.value
  );
}

/* =========================================================
   CRASH DETECTION
   ========================================================= */

function crashCheck(market) {
  const price10 =
    getChange(
      priceHistory,
      10
    );

  const liquidity10 =
    getChange(
      liquidityHistory,
      10
    );

  if (
    market.liquidityUsd <=
    CRASH_LIQUIDITY_USD
  ) {
    return {
      crash: true,
      reason: "LIQUIDITY_NEAR_ZERO",
      price10,
      liquidity10
    };
  }

  if (
    liquidity10 !== null &&
    liquidity10 <=
    CRASH_LIQUIDITY_DROP_10S
  ) {
    return {
      crash: true,
      reason: "LIQUIDITY_COLLAPSE",
      price10,
      liquidity10
    };
  }

  if (
    price10 !== null &&
    price10 <=
    CRASH_PRICE_DROP_10S
  ) {
    return {
      crash: true,
      reason: "PRICE_COLLAPSE",
      price10,
      liquidity10
    };
  }

  return {
    crash: false,
    price10,
    liquidity10
  };
}

/* =========================================================
   ENTRY FILTERS
   ========================================================= */

function entryCheck(market) {
  const age =
    now() - sessionStartedAt;

  if (
    age >=
    NO_NEW_BUY_AFTER_MS
  ) {
    return {
      ok: false,
      reason: "43_MIN_CUTOFF"
    };
  }

  if (
    market.liquidityUsd <
    MIN_LIQUIDITY_USD
  ) {
    return {
      ok: false,
      reason:
        `LIQUIDITY_TOO_LOW (${usd(market.liquidityUsd)})`
    };
  }

  if (priceHistory.length < 8) {
    return {
      ok: false,
      reason:
        `HISTORY_WARMUP (${priceHistory.length}/8)`
    };
  }

  const price10 =
    getChange(
      priceHistory,
      10
    );

  if (
    price10 !== null &&
    price10 <=
    MAX_ENTRY_PRICE_DROP_10S
  ) {
    return {
      ok: false,
      reason:
        `PRICE_DROP_10S ${pctSigned(price10 * 100)}`
    };
  }

  const liquidity10 =
    getChange(
      liquidityHistory,
      10
    );

  if (
    liquidity10 !== null &&
    liquidity10 <=
    MAX_ENTRY_LIQUIDITY_DROP_10S
  ) {
    return {
      ok: false,
      reason:
        `LIQUIDITY_DROP_10S ${pctSigned(liquidity10 * 100)}`
    };
  }

  const liquidity30 =
    getChange(
      liquidityHistory,
      30
    );

  if (
    liquidity30 !== null &&
    liquidity30 <=
    MAX_ENTRY_LIQUIDITY_DROP_30S
  ) {
    return {
      ok: false,
      reason:
        `LIQUIDITY_DROP_30S ${pctSigned(liquidity30 * 100)}`
    };
  }

  return {
    ok: true,
    reason: "ENTRY_OK"
  };
}

/* =========================================================
   BUY SIMULE
   ========================================================= */

function simulateBuy(market) {
  cycleNumber++;

  const tokenAmount =
    CAPITAL_USD /
    market.priceUsd;

  position = {
    cycle: cycleNumber,

    openedAt: now(),

    entryPrice:
      market.priceUsd,

    entryLiquidity:
      market.liquidityUsd,

    capitalUsd:
      CAPITAL_USD,

    tokenAmount
  };

  console.log(
    `💰 BUY SIMULÉ #${cycleNumber} ` +
    `@ ${market.priceUsd}`
  );

  send(
    `🟢 BUY SIMULÉ #${cycleNumber}\n\n` +
    `💵 Capital : $${CAPITAL_USD.toFixed(2)}\n` +
    `💰 Prix : ${market.priceUsd}\n` +
    `💧 Liquidité : ${usd(market.liquidityUsd)}\n\n` +
    `🎯 Vente cible : ` +
    `${(market.priceUsd * (1 + TARGET_GAIN)).toFixed(10)}`
  );
}

/* =========================================================
   SELL SIMULE
   ========================================================= */

function simulateSell(
  market,
  reason = "TARGET"
) {
  if (!position) {
    return;
  }

  const exitPrice =
    market.priceUsd;

  const pnlPct =
    (
      (exitPrice -
        position.entryPrice) /
      position.entryPrice
    );

  const pnlUsd =
    CAPITAL_USD * pnlPct;

  totalPnl += pnlUsd;

  if (
    reason === "TARGET"
  ) {
    totalWins++;
  } else {
    totalLosses++;
  }

  const trade = {
    cycle: position.cycle,

    openedAt:
      new Date(position.openedAt)
        .toISOString(),

    closedAt:
      new Date(now())
        .toISOString(),

    entryPrice:
      position.entryPrice,

    exitPrice,

    pnlPct,

    pnlUsd,

    reason
  };

  try {
    let trades = [];

    if (fs.existsSync(TRADE_FILE)) {
      trades =
        JSON.parse(
          fs.readFileSync(
            TRADE_FILE,
            "utf8"
          )
        );
    }

    trades.push(trade);

    fs.writeFileSync(
      TRADE_FILE,
      JSON.stringify(
        trades,
        null,
        2
      )
    );
  } catch (err) {
    console.error(
      "Erreur trade history:",
      err.message
    );
  }

  const emoji =
    reason === "TARGET"
      ? "🎯"
      : reason === "SESSION_LIMIT"
        ? "⏱️"
        : "⚠️";

  send(
    `${emoji} SELL SIMULÉ #${position.cycle}\n\n` +
    `📌 Motif : ${reason}\n` +
    `💵 Entrée : ${position.entryPrice}\n` +
    `💵 Sortie : ${exitPrice}\n` +
    `📊 Résultat : ${pctSigned(pnlPct * 100)}\n` +
    `💰 P&L : ${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)} $`
  );

  lastSellAt = now();

  position = null;
}

/* =========================================================
   FORCE SAFETY SELL
   ========================================================= */

async function forceSafetySell() {
  if (!position) {
    return true;
  }

  console.log(
    "⏱️ LIMITE 45 MIN : sécurité"
  );

  const market =
    await getMarketData();

  if (!market) {
    console.log(
      "⚠️ Impossible d'obtenir le prix " +
      "pour la sortie de sécurité."
    );

    await send(
      `🚨 SÉCURITÉ 45 MIN\n\n` +
      `Une position #${position.cycle} est encore ouverte.\n\n` +
      `⚠️ Prix actuel indisponible.\n` +
      `⛔ Le bot NE considère PAS la position comme fermée.`
    );

    return false;
  }

  simulateSell(
    market,
    "SESSION_LIMIT"
  );

  return true;
}

/* =========================================================
   CRASH
   ========================================================= */

async function handleCrash(
  market,
  crash
) {
  if (crashDetected) {
    return;
  }

  crashDetected = true;

  stopReason =
    crash.reason;

  lastCrash = {
    timestamp:
      new Date().toISOString(),

    reason:
      crash.reason,

    price:
      market.priceUsd,

    liquidity:
      market.liquidityUsd,

    price10:
      crash.price10,

    liquidity10:
      crash.liquidity10,

    position:
      position
        ? {
            cycle: position.cycle,
            entryPrice:
              position.entryPrice
          }
        : null
  };

  try {
    fs.writeFileSync(
      CRASH_FILE,
      JSON.stringify(
        lastCrash,
        null,
        2
      )
    );
  } catch (err) {
    console.error(
      "Crash save:",
      err.message
    );
  }

  if (position) {
    simulateSell(
      market,
      "CRASH"
    );
  }

  await send(
    `🚨 CRASH DÉTECTÉ\n\n` +
    `📌 ${crash.reason}\n` +
    `💵 Prix : ${market.priceUsd}\n` +
    `💧 Liquidité : ${usd(market.liquidityUsd)}\n` +
    `📉 Prix 10s : ${pctSigned((crash.price10 || 0) * 100)}\n` +
    `📉 Liquidité 10s : ${pctSigned((crash.liquidity10 || 0) * 100)}\n\n` +
    `⛔ NOUVEAUX BUY ARRÊTÉS`
  );

  stopTimersOnly();
}

/* =========================================================
   MARKET LOOP
   ========================================================= */

async function marketTick() {
  if (!running) {
    return;
  }

  if (crashDetected) {
    return;
  }

  /* -----------------------------------------
     SESSION 45 MIN
     ----------------------------------------- */

  const sessionAge =
    now() - sessionStartedAt;

  if (
    sessionAge >=
    MAX_SESSION_MS
  ) {
    console.log(
      "⏱️ 45 minutes atteintes"
    );

    if (position) {
      const closed =
        await forceSafetySell();

      if (!closed) {
        return;
      }
    }

    stopReason =
      "SESSION_LIMIT";

    running = false;

    stopTimersOnly();

    await send(
      `⏱️ SESSION TERMINÉE\n\n` +
      `Durée : 45 minutes\n` +
      `Position : fermée\n\n` +
      `💰 Wins : ${totalWins}\n` +
      `❌ Pertes : ${totalLosses}\n` +
      `📊 P&L simulé : ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} $`
    );

    return;
  }

  /* -----------------------------------------
     MARKET
     ----------------------------------------- */

  const market =
    await getMarketData();

  diagnosticStep++;

  if (!market) {
    if (
      diagnosticStep % 5 === 0
    ) {
      await send(
        `🔎 DIAGNOSTIC V5.8\n\n` +
        `Étape : ${lastDiagnostic?.stage || "?"}\n` +
        `État : ${lastDiagnostic?.status || "?"}\n` +
        `Motif : ${lastDiagnostic?.reason || "inconnu"}\n\n` +
        `⏳ Aucun BUY pour le moment.`
      );
    }

    return;
  }

  lastMarket =
    market;

  addHistory(market);

  /* -----------------------------------------
     CRASH
     ----------------------------------------- */

  const crash =
    crashCheck(market);

  if (crash.crash) {
    await handleCrash(
      market,
      crash
    );

    return;
  }

  /* -----------------------------------------
     POSITION OUVERTE
     ----------------------------------------- */

  if (position) {
    const target =
      position.entryPrice *
      (1 + TARGET_GAIN);

    if (
      market.priceUsd >=
      target
    ) {
      simulateSell(
        market,
        "TARGET"
      );

      await sleep(
        POST_SELL_WAIT_MS
      );

      return;
    }

    return;
  }

  /* -----------------------------------------
     COOLDOWN
     ----------------------------------------- */

  if (
    lastSellAt > 0 &&
    now() - lastSellAt <
      POST_SELL_WAIT_MS
  ) {
    return;
  }

  /* -----------------------------------------
     ENTRY
     ----------------------------------------- */

  const entry =
    entryCheck(market);

  if (
    entry.ok
  ) {
    simulateBuy(
      market
    );

    return;
  }

  /* -----------------------------------------
     DIAGNOSTIC PERIODIQUE
     ----------------------------------------- */

  if (
    diagnosticStep % 5 === 0
  ) {
    const ageMin =
      (
        now() -
        sessionStartedAt
      ) / 60000;

    await send(
      `🔍 V5.8 DIAGNOSTIC\n\n` +
      `⏱️ Session : ${ageMin.toFixed(1)} min\n` +
      `📊 Prix : ${market.priceUsd}\n` +
      `💧 Liquidité : ${usd(market.liquidityUsd)}\n` +
      `🔗 DEX : ${market.dexId}\n` +
      `🧩 Pair : ${shortAddress(market.pairAddress)}\n` +
      `⛓️ On-chain : ${market.onchainOk ? "OK" : market.onchainReason}\n\n` +
      `🚫 Entrée refusée : ${entry.reason}`
    );
  }
}

/* =========================================================
   DIAGNOSTIC TIMER
   ========================================================= */

function startDiagnosticTimer() {
  if (diagnosticTimer) {
    clearInterval(
      diagnosticTimer
    );
  }

  diagnosticTimer =
    setInterval(
      async () => {
        if (!running) {
          return;
        }

        const age =
          sessionStartedAt
            ? (
                now() -
                sessionStartedAt
              ) / 60000
            : 0;

        console.log(
          `🩺 V5.8 | ` +
          `${age.toFixed(1)} min | ` +
          `position=${!!position} | ` +
          `pair=${shortAddress(lastPair?.pairAddress)} | ` +
          `diag=${lastDiagnostic?.reason || "?"}`
        );
      },
      10000
    );
}

/* =========================================================
   TIMERS
   ========================================================= */

function stopTimersOnly() {
  if (marketTimer) {
    clearInterval(
      marketTimer
    );

    marketTimer = null;
  }

  if (diagnosticTimer) {
    clearInterval(
      diagnosticTimer
    );

    diagnosticTimer = null;
  }

  if (heliusWsTimer) {
    clearTimeout(
      heliusWsTimer
    );

    heliusWsTimer = null;
  }

  if (heliusWs) {
    try {
      heliusWs.close();
    } catch {}

    heliusWs = null;
  }
}

function startTimers() {
  stopTimersOnly();

  marketTimer =
    setInterval(
      () => {
        marketTick()
          .catch(err => {
            console.error(
              "Market tick:",
              err.message
            );
          });
      },
      MARKET_INTERVAL_MS
    );

  startDiagnosticTimer();

  marketTick()
    .catch(err => {
      console.error(
        "Initial market tick:",
        err.message
      );
    });
}

/* =========================================================
   HELIUS WEBSOCKET
   ========================================================= */

function startHeliusDiagnostics() {
  try {
    if (heliusWs) {
      try {
        heliusWs.close();
      } catch {}
    }

    heliusWs =
      new WebSocket(
        WSS_URL
      );

    heliusWs.on(
      "open",
      () => {
        console.log(
          "🟢 Helius WebSocket connecté"
        );

        const subscribeRequest = {
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [
            {
              mentions: [
                PUMPSWAP_PROGRAM
              ]
            },
            {
              commitment: "processed"
            }
          ]
        };

        heliusWs.send(
          JSON.stringify(
            subscribeRequest
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
            msg.method ===
            "logsNotification"
          ) {
            console.log(
              "📡 PumpSwap activity détectée"
            );
          }
        } catch {}
      }
    );

    heliusWs.on(
      "close",
      () => {
        console.log(
          "⚠️ Helius WebSocket fermé"
        );

        if (
          running &&
          !crashDetected
        ) {
          heliusWsTimer =
            setTimeout(
              () => {
                startHeliusDiagnostics();
              },
              5000
            );
        }
      }
    );

    heliusWs.on(
      "error",
      err => {
        console.log(
          "⚠️ Helius WS:",
          err.message
        );
      }
    );

  } catch (err) {
    console.log(
      "⚠️ Helius WS impossible:",
      err.message
    );
  }
}

/* =========================================================
   START TRADE
   ========================================================= */

async function startTrade() {
  if (running) {
    await send(
      "⚠️ La surveillance est déjà active."
    );

    return;
  }

  running = true;

  crashDetected = false;

  stopReason = null;

  sessionStartedAt =
    now();

  position = null;

  lastSellAt = 0;

  cycleNumber = 0;

  totalWins = 0;

  totalLosses = 0;

  totalPnl = 0;

  lastMarket = null;

  lastPair = null;

  lastDiagnostic = null;

  lastCrash = null;

  priceHistory = [];

  liquidityHistory = [];

  diagnosticStep = 0;

  await send(
    `🟢 V5.8 DIAGNOSTIQUE ACTIVE\n\n` +
    `💵 $10.00 / cycle\n` +
    `🎯 +5% cible\n` +
    `⏱️ 45 min maximum\n` +
    `🚫 Aucun nouveau BUY après 43 min\n\n` +
    `🔍 Diagnostic actif\n` +
    `⛓️ On-chain non bloquant\n\n` +
    `Simulation uniquement.`
  );

  startHeliusDiagnostics();

  startTimers();
}

/* =========================================================
   STOP TRADE
   ========================================================= */

async function stopTrade() {
  if (!running) {
    await send(
      "ℹ️ La surveillance est déjà arrêtée."
    );

    return;
  }

  if (position) {
    await send(
      `⚠️ Position #${position.cycle} encore ouverte.\n\n` +
      `Utilise /stoptrade uniquement après avoir vérifié le statut.\n` +
      `La sécurité 45 min reste active.`
    );

    return;
  }

  running = false;

  stopReason =
    "MANUAL";

  stopTimersOnly();

  await send(
    `🔴 V5.8 ARRÊTÉE\n\n` +
    `💰 Wins : ${totalWins}\n` +
    `❌ Pertes : ${totalLosses}\n` +
    `📊 P&L simulé : ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} $`
  );
}

/* =========================================================
   STATUS
   ========================================================= */

async function status() {
  const age =
    sessionStartedAt
      ? (
          now() -
          sessionStartedAt
        ) / 60000
      : 0;

  let text =
    `📊 V5.8 STATUS\n\n` +
    `🟢 Active : ${running ? "OUI" : "NON"}\n` +
    `⏱️ Session : ${age.toFixed(1)} min\n` +
    `💰 Position : ${position ? "OUVERTE" : "AUCUNE"}\n` +
    `🔢 Cycle : ${cycleNumber}\n` +
    `🏆 Wins : ${totalWins}\n` +
    `❌ Pertes : ${totalLosses}\n` +
    `📊 P&L : ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)} $\n\n`;

  if (lastMarket) {
    text +=
      `💵 Prix : ${lastMarket.priceUsd}\n` +
      `💧 Liquidité : ${usd(lastMarket.liquidityUsd)}\n` +
      `🔗 DEX : ${lastMarket.dexId}\n` +
      `🧩 Pair : ${shortAddress(lastMarket.pairAddress)}\n` +
      `⛓️ On-chain : ${lastMarket.onchainOk ? "OK" : lastMarket.onchainReason}\n\n`;
  }

  if (lastDiagnostic) {
    text +=
      `🩺 Diagnostic :\n` +
      `${lastDiagnostic.stage} / ` +
      `${lastDiagnostic.status}\n` +
      `${lastDiagnostic.reason || ""}`;
  }

  await send(text);
}

/* =========================================================
   LAST CRASH
   ========================================================= */

async function lastCrashCommand() {
  if (!lastCrash) {
    try {
      if (
        fs.existsSync(
          CRASH_FILE
        )
      ) {
        lastCrash =
          JSON.parse(
            fs.readFileSync(
              CRASH_FILE,
              "utf8"
            )
          );
      }
    } catch {}
  }

  if (!lastCrash) {
    await send(
      "ℹ️ Aucun crash enregistré."
    );

    return;
  }

  await send(
    `🚨 DERNIER CRASH\n\n` +
    `📅 ${lastCrash.timestamp}\n` +
    `📌 ${lastCrash.reason}\n` +
    `💵 Prix : ${lastCrash.price}\n` +
    `💧 Liquidité : ${usd(lastCrash.liquidity)}\n` +
    `📉 Prix 10s : ${pctSigned((lastCrash.price10 || 0) * 100)}\n` +
    `📉 Liquidité 10s : ${pctSigned((lastCrash.liquidity10 || 0) * 100)}`
  );
}

/* =========================================================
   HELP
   ========================================================= */

async function help() {
  await send(
    `🤖 V5.8 COMMANDES\n\n` +
    `/starttrade → démarrer\n` +
    `/stoptrade → arrêter\n` +
    `/status → état actuel\n` +
    `/lastcrash → dernier crash\n` +
    `/help → aide\n\n` +
    `Simulation uniquement.`
  );
}

/* =========================================================
   TELEGRAM COMMANDS
   ========================================================= */

bot.command(
  "starttrade",
  async ctx => {
    await startTrade();
  }
);

bot.command(
  "stoptrade",
  async ctx => {
    await stopTrade();
  }
);

bot.command(
  "status",
  async ctx => {
    await status();
  }
);

bot.command(
  "lastcrash",
  async ctx => {
    await lastCrashCommand();
  }
);

bot.command(
  "help",
  async ctx => {
    await help();
  }
);

/* =========================================================
   GLOBAL ERRORS
   ========================================================= */

bot.catch(
  err => {
    console.error(
      "Telegram error:",
      err
    );
  }
);

/* =========================================================
   SAVE SUMMARY
   ========================================================= */

setInterval(
  () => {
    try {
      const summary = {
        timestamp:
          new Date().toISOString(),

        running,

        sessionStartedAt,

        position,

        cycleNumber,

        totalWins,

        totalLosses,

        totalPnl,

        lastMarket,

        lastPair,

        lastDiagnostic,

        lastCrash,

        stopReason
      };

      fs.writeFileSync(
        SUMMARY_FILE,
        JSON.stringify(
          summary,
          null,
          2
        )
      );
    } catch (err) {
      console.error(
        "Summary save:",
        err.message
      );
    }
  },
  30000
);

/* =========================================================
   START TELEGRAM
   ========================================================= */

console.log(
  "🤖 V5.8 DIAGNOSTIQUE démarrage..."
);

console.log(
  "📡 RPC:",
  RPC_URL.replace(
    HELIUS_API_KEY,
    "***"
  )
);

bot.launch()
  .then(() => {
    console.log(
      "🤖 V5.8 Telegram bot démarré"
    );
  })
  .catch(err => {
    console.error(
      "❌ Telegram launch:",
      err.message
    );
  });

/* =========================================================
   SHUTDOWN
   ========================================================= */

process.once(
  "SIGINT",
  () => {
    stopTimersOnly();
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    stopTimersOnly();
    bot.stop("SIGTERM");
  }
);
