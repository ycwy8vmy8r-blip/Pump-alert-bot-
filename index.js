require("dotenv").config();

const { Telegraf } = require("telegraf");
const { Connection, PublicKey } = require("@solana/web3.js");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

/* =========================================================
   V6.4
   1 SEUL BUY SIMULÉ DE 10 $
   4 STOPS VIRTUELS COMPARÉS SUR LA MÊME POSITION
   SIMULATION UNIQUEMENT
========================================================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHAT_ID) {
  throw new Error("BOT_TOKEN ou CHAT_ID manquant dans Railway.");
}

const RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : "https://api.mainnet-beta.solana.com";

const WSS_URL = HELIUS_API_KEY
  ? `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : "wss://api.mainnet-beta.solana.com";

const connection = new Connection(RPC_URL, "confirmed");
const bot = new Telegraf(BOT_TOKEN);

/* =========================================================
   TOKEN DE TEST ACTUEL
========================================================= */

const TRUSTED_TEST_MINT =
  "6mXbyvPJbPQRyMU5BFL99TFLEDdvuV434cQBSjjitxX7";

/* =========================================================
   PARAMÈTRES
========================================================= */

const CAPITAL_PER_BUY = 10;
const TARGET_PERCENT = 5;

const VIRTUAL_STOPS = [-10, -15, -20, -25];

const MIN_LIQUIDITY = 200000;
const MAX_LIQUIDITY = 400000;
const MIN_HOLDERS = 1000;
const MAX_AGE_MINUTES = 5 * 60;

const MARKET_INTERVAL_MS = 2000;
const PAIR_REFRESH_MS = 30000;
const COOLDOWN_MS = 30000;
const NO_NEW_BUY_AFTER_MS = 43 * 60 * 1000;
const MAX_SESSION_MS = 45 * 60 * 1000;

const HISTORY_REQUIRED = 8;
const HISTORY_WINDOW_MS = 120000;

const PRICE_CRASH_10S = -20;
const LIQUIDITY_CRASH_10S = -50;
const LIQUIDITY_NEAR_ZERO = 1;

/* =========================================================
   FICHIERS
========================================================= */

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const FILES = {
  market: path.join(DATA_DIR, "v6_4_market_history.jsonl"),
  trades: path.join(DATA_DIR, "v6_4_trades.json"),
  comparison: path.join(DATA_DIR, "v6_4_comparison.json"),
  crashes: path.join(DATA_DIR, "v6_4_crashes.json"),
  summary: path.join(DATA_DIR, "v6_4_summary.json"),
};

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (error) {
    console.error("Erreur sauvegarde:", error.message);
  }
}

function appendJsonLine(file, value) {
  try {
    fs.appendFileSync(file, JSON.stringify(value) + "\n");
  } catch (error) {
    console.error("Erreur journal:", error.message);
  }
}

let savedTrades = loadJson(FILES.trades, []);
let savedComparisons = loadJson(FILES.comparison, []);
let savedCrashes = loadJson(FILES.crashes, []);

/* =========================================================
   ÉTAT GLOBAL
========================================================= */

let currentCandidate = null;
let selectedMint = TRUSTED_TEST_MINT;

let tradingActive = false;
let sessionStartedAt = null;
let lastBuyAt = 0;
let lastPairRefreshAt = 0;

let selectedPair = null;
let marketHistory = [];
let currentMarket = null;

let singlePosition = null;
let buyNumber = 0;

let lastDiagnosticAt = 0;
let lastCrashReport = null;

let heliusSocket = null;

/* =========================================================
   OUTILS
========================================================= */

function now() {
  return Date.now();
}

function round(value, decimals = 10) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimals));
}

function formatUsd(value) {
  return `${Number(value || 0).toFixed(2)} $`;
}

function formatPrice(value) {
  return Number(value || 0).toFixed(10);
}

function shortAddress(value) {
  if (!value) return "inconnu";
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function percentChange(oldValue, newValue) {
  if (!Number.isFinite(oldValue) || !Number.isFinite(newValue)) {
    return null;
  }

  if (oldValue === 0) return null;

  return ((newValue - oldValue) / oldValue) * 100;
}

function minutesSince(timestamp) {
  if (!timestamp) return 0;
  return (now() - timestamp) / 60000;
}

function sessionMinutes() {
  if (!sessionStartedAt) return 0;
  return (now() - sessionStartedAt) / 60000;
}

function isSessionExpired() {
  return sessionStartedAt &&
    now() - sessionStartedAt >= MAX_SESSION_MS;
}

function noNewBuyWindowReached() {
  return sessionStartedAt &&
    now() - sessionStartedAt >= NO_NEW_BUY_AFTER_MS;
}

function isPumpSwapPair(pair) {
  const dexId = String(pair?.dexId || "").toLowerCase();

  return (
    dexId === "pumpswap" ||
    dexId === "pump_amm" ||
    dexId === "pumpamm" ||
    dexId.includes("pump")
  );
}

function isFinitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

/* =========================================================
   TELEGRAM
========================================================= */

async function sendTelegram(message) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, message);
  } catch (error) {
    console.error("Erreur Telegram:", error.message);
  }
}

/* =========================================================
   DEXSCREENER
========================================================= */

async function fetchJson(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function getDexPairs(mint) {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  const data = await fetchJson(url);

  return Array.isArray(data?.pairs) ? data.pairs : [];
}

function chooseBestPumpSwapPair(pairs, mint) {
  const valid = pairs.filter((pair) => {
    const baseAddress = pair?.baseToken?.address;
    const quoteAddress = pair?.quoteToken?.address;

    return (
      isPumpSwapPair(pair) &&
      (
        baseAddress === mint ||
        quoteAddress === mint
      ) &&
      isFinitePositive(pair?.priceUsd) &&
      isFinitePositive(pair?.liquidity?.usd)
    );
  });

  valid.sort((a, b) => {
    const liquidityA = Number(a?.liquidity?.usd || 0);
    const liquidityB = Number(b?.liquidity?.usd || 0);
    return liquidityB - liquidityA;
  });

  return valid[0] || null;
}

async function refreshSelectedPair(force = false) {
  if (
    !force &&
    selectedPair &&
    now() - lastPairRefreshAt < PAIR_REFRESH_MS
  ) {
    return selectedPair;
  }

  const pairs = await getDexPairs(selectedMint);
  const best = chooseBestPumpSwapPair(pairs, selectedMint);

  lastPairRefreshAt = now();

  if (best) {
    selectedPair = {
      pairAddress: best.pairAddress,
      dexId: best.dexId,
      baseToken: best.baseToken,
      quoteToken: best.quoteToken,
      url: best.url || null,
    };
  } else {
    selectedPair = null;
  }

  return selectedPair;
}

/* =========================================================
   DONNÉES DE MARCHÉ
========================================================= */

async function getMarketData() {
  const pair = await refreshSelectedPair();

  if (!pair) {
    throw new Error("Aucune paire PumpSwap valide trouvée.");
  }

  const pairs = await getDexPairs(selectedMint);

  const freshPair =
    pairs.find((item) => item.pairAddress === pair.pairAddress) ||
    pairs.find((item) => item.pairAddress === selectedPair?.pairAddress);

  if (!freshPair) {
    throw new Error("Paire introuvable dans la réponse DexScreener.");
  }

  const priceUsd = Number(freshPair?.priceUsd || 0);
  const liquidityUsd = Number(freshPair?.liquidity?.usd || 0);

  if (!isFinitePositive(priceUsd)) {
    throw new Error("Prix invalide reçu de DexScreener.");
  }

  return {
    timestamp: now(),
    price: priceUsd,
    liquidity: liquidityUsd,
    dexId: freshPair.dexId || "unknown",
    pairAddress: freshPair.pairAddress,
    pairUrl: freshPair.url || null,
    baseSymbol: freshPair?.baseToken?.symbol || "TOKEN",
    baseName: freshPair?.baseToken?.name || "Token",
  };
}

function addMarketPoint(market) {
  marketHistory.push(market);

  const cutoff = now() - HISTORY_WINDOW_MS;

  marketHistory = marketHistory.filter(
    (item) => item.timestamp >= cutoff
  );

  appendJsonLine(FILES.market, market);
}

function getPointAgo(milliseconds) {
  const target = now() - milliseconds;

  const older = marketHistory
    .filter((item) => item.timestamp <= target)
    .sort((a, b) => b.timestamp - a.timestamp)[0];

  return older || null;
}

function getPriceChange10s() {
  const old = getPointAgo(10000);
  if (!old || !currentMarket) return null;

  return percentChange(old.price, currentMarket.price);
}

function getLiquidityChange10s() {
  const old = getPointAgo(10000);
  if (!old || !currentMarket) return null;

  return percentChange(old.liquidity, currentMarket.liquidity);
}

function getLiquidityChange30s() {
  const old = getPointAgo(30000);
  if (!old || !currentMarket) return null;

  return percentChange(old.liquidity, currentMarket.liquidity);
}

function historyReady() {
  return marketHistory.length >= HISTORY_REQUIRED;
}

/* =========================================================
   FILTRES D’ENTRÉE
========================================================= */

function evaluateEntry() {
  if (!currentMarket) {
    return {
      allowed: false,
      reason: "NO_MARKET_DATA",
    };
  }

  if (!historyReady()) {
    return {
      allowed: false,
      reason: `HISTORY_WARMUP ${marketHistory.length}/${HISTORY_REQUIRED}`,
    };
  }

  if (
    currentMarket.liquidity < MIN_LIQUIDITY ||
    currentMarket.liquidity > MAX_LIQUIDITY
  ) {
    return {
      allowed: false,
      reason: "LIQUIDITY_OUT_OF_RANGE",
    };
  }

  const price10s = getPriceChange10s();
  const liquidity10s = getLiquidityChange10s();
  const liquidity30s = getLiquidityChange30s();

  if (price10s !== null && price10s < -5) {
    return {
      allowed: false,
      reason: "PRICE_DROP_10S",
    };
  }

  if (liquidity10s !== null && liquidity10s < -12) {
    return {
      allowed: false,
      reason: "LIQUIDITY_DROP_10S",
    };
  }

  if (liquidity30s !== null && liquidity30s < -20) {
    return {
      allowed: false,
      reason: "LIQUIDITY_DROP_30S",
    };
  }

  if (noNewBuyWindowReached()) {
    return {
      allowed: false,
      reason: "NO_NEW_BUY_AFTER_43_MIN",
    };
  }

  return {
    allowed: true,
    reason: "BUY_AUTHORIZED",
  };
}

/* =========================================================
   DÉTECTION CRASH
========================================================= */

function detectCrash() {
  if (!currentMarket) {
    return {
      crashed: false,
      reason: null,
    };
  }

  const price10s = getPriceChange10s();
  const liquidity10s = getLiquidityChange10s();

  if (currentMarket.liquidity <= LIQUIDITY_NEAR_ZERO) {
    return {
      crashed: true,
      reason: "LIQUIDITY_NEAR_ZERO",
    };
  }

  if (
    liquidity10s !== null &&
    liquidity10s <= LIQUIDITY_CRASH_10S
  ) {
    return {
      crashed: true,
      reason: "LIQUIDITY_CRASH_10S",
    };
  }

  if (
    price10s !== null &&
    price10s <= PRICE_CRASH_10S
  ) {
    return {
      crashed: true,
      reason: "PRICE_CRASH_10S",
    };
  }

  return {
    crashed: false,
    reason: null,
  };
}

/* =========================================================
   POSITION UNIQUE ET STOPS VIRTUELS
========================================================= */

function createVirtualScenarios(entryPrice) {
  return VIRTUAL_STOPS.map((stopPercent) => ({
    stopPercent,
    status: "OPEN",
    entryPrice,
    targetPrice: entryPrice * (1 + TARGET_PERCENT / 100),
    stopPrice: entryPrice * (1 + stopPercent / 100),
    exitPrice: null,
    exitReason: null,
    pnlPercent: null,
    pnlUsd: null,
    exitAt: null,
  }));
}

function openSinglePosition() {
  if (!currentMarket || singlePosition) return false;

  buyNumber += 1;

  singlePosition = {
    buyNumber,
    capital: CAPITAL_PER_BUY,
    entryPrice: currentMarket.price,
    entryLiquidity: currentMarket.liquidity,
    openedAt: now(),
    scenarios: createVirtualScenarios(currentMarket.price),
  };

  lastBuyAt = now();

  appendJsonLine(FILES.market, {
    type: "BUY",
    buyNumber,
    timestamp: now(),
    price: currentMarket.price,
    liquidity: currentMarket.liquidity,
  });

  sendTelegram(
    `🟢 BUY SIMULÉ UNIQUE #${buyNumber}\n\n` +
    `💵 Capital : ${formatUsd(CAPITAL_PER_BUY)}\n` +
    `💰 Prix : ${formatPrice(currentMarket.price)} $\n` +
    `💧 Liquidité : ${formatUsd(currentMarket.liquidity)}\n\n` +
    `🎯 Cible commune : ${formatPrice(singlePosition.scenarios[0].targetPrice)} $\n\n` +
    `🛡️ Stops virtuels comparés :\n` +
    `• -10 % : ${formatPrice(singlePosition.scenarios[0].stopPrice)} $\n` +
    `• -15 % : ${formatPrice(singlePosition.scenarios[1].stopPrice)} $\n` +
    `• -20 % : ${formatPrice(singlePosition.scenarios[2].stopPrice)} $\n` +
    `• -25 % : ${formatPrice(singlePosition.scenarios[3].stopPrice)} $\n\n` +
    `📊 Une seule position de 10 $.\n` +
    `Les 4 stops sont virtuels et utilisent exactement le même prix de marché.`
  );

  return true;
}

function closeScenario(scenario, exitPrice, reason) {
  if (scenario.status !== "OPEN") return;

  scenario.status = "CLOSED";
  scenario.exitPrice = exitPrice;
  scenario.exitReason = reason;
  scenario.exitAt = now();

  scenario.pnlPercent =
    ((exitPrice - scenario.entryPrice) / scenario.entryPrice) * 100;

  scenario.pnlUsd =
    CAPITAL_PER_BUY * (scenario.pnlPercent / 100);

  const trade = {
    version: "V6.4",
    buyNumber: singlePosition.buyNumber,
    stopPercent: scenario.stopPercent,
    capital: CAPITAL_PER_BUY,
    entryPrice: scenario.entryPrice,
    exitPrice,
    reason,
    pnlPercent: scenario.pnlPercent,
    pnlUsd: scenario.pnlUsd,
    openedAt: singlePosition.openedAt,
    closedAt: now(),
  };

  savedTrades.push(trade);
  saveJson(FILES.trades, savedTrades);

  appendJsonLine(FILES.market, {
    type: "SELL",
    timestamp: now(),
    buyNumber: singlePosition.buyNumber,
    stopPercent: scenario.stopPercent,
    exitPrice,
    reason,
    pnlPercent: scenario.pnlPercent,
    pnlUsd: scenario.pnlUsd,
  });

  sendTelegram(
    `${reason === "TARGET" ? "🎯" : reason === "STOP" ? "🛑" : "⚠️"} ` +
    `SCÉNARIO ${scenario.stopPercent}% FERMÉ\n\n` +
    `📌 BUY commun #${singlePosition.buyNumber}\n` +
    `🛡️ Stop testé : ${scenario.stopPercent}%\n` +
    `📍 Motif : ${reason}\n` +
    `💰 Entrée : ${formatPrice(scenario.entryPrice)}\n` +
    `💰 Sortie : ${formatPrice(exitPrice)}\n` +
    `📈 Résultat : ${scenario.pnlPercent >= 0 ? "+" : ""}${scenario.pnlPercent.toFixed(2)}%\n` +
    `💵 P&L virtuel : ${scenario.pnlUsd >= 0 ? "+" : ""}${scenario.pnlUsd.toFixed(2)} $`
  );
}

function processPosition() {
  if (!singlePosition || !currentMarket) return;

  const price = currentMarket.price;

  for (const scenario of singlePosition.scenarios) {
    if (scenario.status !== "OPEN") continue;

    if (price >= scenario.targetPrice) {
      closeScenario(scenario, price, "TARGET");
      continue;
    }

    if (price <= scenario.stopPrice) {
      closeScenario(scenario, price, "STOP");
    }
  }

  const remaining = singlePosition.scenarios.filter(
    (scenario) => scenario.status === "OPEN"
  );

  if (remaining.length === 0) {
    const closedPosition = singlePosition;

    singlePosition = null;

    sendTelegram(
      `📦 POSITION UNIQUE TERMINÉE\n\n` +
      `BUY #${closedPosition.buyNumber}\n` +
      `Les 4 scénarios virtuels sont maintenant fermés.\n` +
      `Une nouvelle position pourra être simulée après la pause de ${COOLDOWN_MS / 1000}s.`
    );
  }
}

function forceCloseRemaining(reason) {
  if (!singlePosition || !currentMarket) return;

  const price = currentMarket.price;

  for (const scenario of singlePosition.scenarios) {
    if (scenario.status === "OPEN") {
      closeScenario(scenario, price, reason);
    }
  }

  const closedPosition = singlePosition;
  singlePosition = null;

  sendTelegram(
    `⚠️ POSITION UNIQUE FERMÉE DE SÉCURITÉ\n\n` +
    `Motif : ${reason}\n` +
    `BUY #${closedPosition.buyNumber}\n` +
    `Prix de sortie : ${formatPrice(price)} $\n` +
    `Aucun scénario ne reste ouvert.`
  );
}

/* =========================================================
   COMPARAISON
========================================================= */

function getComparison() {
  const result = {};

  for (const stop of VIRTUAL_STOPS) {
    const trades = savedTrades.filter(
      (trade) => Number(trade.stopPercent) === Number(stop)
    );

    const wins = trades.filter(
      (trade) => Number(trade.pnlUsd) > 0
    ).length;

    const losses = trades.filter(
      (trade) => Number(trade.pnlUsd) < 0
    ).length;

    const pnl = trades.reduce(
      (total, trade) => total + Number(trade.pnlUsd || 0),
      0
    );

    result[stop] = {
      stopPercent: stop,
      trades: trades.length,
      wins,
      losses,
      pnl: round(pnl, 4),
    };
  }

  return result;
}

function formatComparison() {
  const comparison = getComparison();

  saveJson(FILES.comparison, comparison);

  let message = "📊 COMPARAISON V6.4\n\n";
  message += "1 seul BUY de 10 $ par position.\n";
  message += "Les 4 stops sont virtuels.\n\n";

  for (const stop of VIRTUAL_STOPS) {
    const item = comparison[stop];

    message +=
      `🛡️ Stop ${stop}%\n` +
      `• Trades : ${item.trades}\n` +
      `• Gains : ${item.wins}\n` +
      `• Pertes : ${item.losses}\n` +
      `• P&L : ${item.pnl >= 0 ? "+" : ""}${item.pnl.toFixed(2)} $\n\n`;
  }

  return message;
}

/* =========================================================
   RAPPORT CRASH
========================================================= */

function createCrashReport(reason) {
  const report = {
    timestamp: now(),
    mint: selectedMint,
    reason,
    price: currentMarket?.price || null,
    liquidity: currentMarket?.liquidity || null,
    price10s: getPriceChange10s(),
    liquidity10s: getLiquidityChange10s(),
    liquidity30s: getLiquidityChange30s(),
    sessionMinutes: sessionMinutes(),
    pairAddress: currentMarket?.pairAddress || null,
  };

  savedCrashes.push(report);
  saveJson(FILES.crashes, savedCrashes);

  lastCrashReport = report;

  return report;
}

function formatCrashReport(report) {
  if (!report) return "Aucun crash enregistré.";

  return (
    `💥 DERNIER CRASH\n\n` +
    `📌 Motif : ${report.reason}\n` +
    `💰 Prix : ${formatPrice(report.price)} $\n` +
    `💧 Liquidité : ${formatUsd(report.liquidity)}\n` +
    `📉 Prix 10s : ${report.price10s === null ? "N/A" : report.price10s.toFixed(2) + "%"}\n` +
    `💧 Liquidité 10s : ${report.liquidity10s === null ? "N/A" : report.liquidity10s.toFixed(2) + "%"}\n` +
    `💧 Liquidité 30s : ${report.liquidity30s === null ? "N/A" : report.liquidity30s.toFixed(2) + "%"}\n` +
    `⏱️ Session : ${report.sessionMinutes.toFixed(1)} min\n` +
    `🔗 Pair : ${report.pairAddress || "inconnue"}`
  );
}

/* =========================================================
   DIAGNOSTIC TELEGRAM
========================================================= */

async function sendDiagnostic(entryResult) {
  if (!currentMarket) return;

  if (now() - lastDiagnosticAt < 15000) return;

  lastDiagnosticAt = now();

  const price10s = getPriceChange10s();
  const liquidity10s = getLiquidityChange10s();
  const liquidity30s = getLiquidityChange30s();

  const openScenarios = singlePosition
    ? singlePosition.scenarios.filter(
        (scenario) => scenario.status === "OPEN"
      ).length
    : 0;

  await sendTelegram(
    `📊 V6.4 DIAGNOSTIC\n\n` +
    `🪙 ${currentMarket.baseName}\n` +
    `💰 Prix : ${formatPrice(currentMarket.price)} $\n` +
    `💧 Liquidité : ${formatUsd(currentMarket.liquidity)}\n` +
    `🏦 DEX : ${currentMarket.dexId}\n` +
    `🔗 Pair : ${shortAddress(currentMarket.pairAddress)}\n\n` +
    `⏱️ Session : ${sessionMinutes().toFixed(1)} min\n` +
    `📚 Historique : ${marketHistory.length}/${HISTORY_REQUIRED}\n` +
    `📉 Prix 10s : ${price10s === null ? "en attente" : price10s.toFixed(2) + "%"}\n` +
    `💧 Liquidité 10s : ${liquidity10s === null ? "en attente" : liquidity10s.toFixed(2) + "%"}\n` +
    `💧 Liquidité 30s : ${liquidity30s === null ? "en attente" : liquidity30s.toFixed(2) + "%"}\n\n` +
    `🔎 BUY : ${entryResult.allowed ? "🟢 AUTORISÉ" : "🟡 REFUSÉ"}\n` +
    `Motif : ${entryResult.reason}\n\n` +
    `📦 Position unique : ${singlePosition ? "🟢 OUVERTE" : "⚪ FERMÉE"}\n` +
    `🛡️ Scénarios encore ouverts : ${openScenarios}/4`
  );
}

/* =========================================================
   BOUCLE DE TRADING SIMULÉ
========================================================= */

async function marketTick() {
  if (!tradingActive) return;

  try {
    currentMarket = await getMarketData();
    addMarketPoint(currentMarket);

    const crash = detectCrash();

    /*
      Important :
      On traite d’abord les cibles et les stops virtuels.
      Ensuite seulement on traite le crash global.
    */
    if (singlePosition) {
      processPosition();
    }

    if (crash.crashed) {
      const report = createCrashReport(crash.reason);

      if (singlePosition) {
        forceCloseRemaining("CRASH");
      }

      tradingActive = false;

      await sendTelegram(
        `💥 CRASH DÉTECTÉ\n\n` +
        `📌 Motif : ${crash.reason}\n` +
        `💰 Prix : ${formatPrice(currentMarket.price)} $\n` +
        `💧 Liquidité : ${formatUsd(currentMarket.liquidity)}\n\n` +
        `🛑 Nouveaux BUY interdits.\n` +
        `📊 Les scénarios encore ouverts ont été fermés au prix observé.\n\n` +
        formatCrashReport(report)
      );

      saveJson(FILES.summary, {
        version: "V6.4",
        stoppedAt: now(),
        reason: crash.reason,
        comparison: getComparison(),
      });

      return;
    }

    if (isSessionExpired()) {
      if (singlePosition) {
        forceCloseRemaining("SESSION_LIMIT");
      }

      tradingActive = false;

      await sendTelegram(
        `⏱️ SESSION V6.4 TERMINÉE\n\n` +
        `Durée maximale : 45 minutes.\n` +
        `Aucune position ne reste ouverte.\n\n` +
        formatComparison()
      );

      saveJson(FILES.summary, {
        version: "V6.4",
        stoppedAt: now(),
        reason: "SESSION_LIMIT",
        comparison: getComparison(),
      });

      return;
    }

    const entry = evaluateEntry();

    if (
      !singlePosition &&
      entry.allowed &&
      now() - lastBuyAt >= COOLDOWN_MS
    ) {
      openSinglePosition();
    } else {
      await sendDiagnostic(entry);
    }
  } catch (error) {
    console.error("Erreur marketTick:", error.message);

    if (now() - lastDiagnosticAt > 30000) {
      lastDiagnosticAt = now();

      await sendTelegram(
        `⚠️ V6.4\n\n` +
        `Erreur lecture marché :\n` +
        `${error.message}\n\n` +
        `La simulation continue et réessaiera.`
      );
    }
  }
}

let marketTimer = null;

function startMarketLoop() {
  if (marketTimer) {
    clearInterval(marketTimer);
  }

  marketTimer = setInterval(marketTick, MARKET_INTERVAL_MS);
}

/* =========================================================
   HELIUS WEBSOCKET DIAGNOSTIQUE
========================================================= */

function startHeliusDiagnostics() {
  if (!HELIUS_API_KEY) {
    console.log("Helius absent, WebSocket désactivé.");
    return;
  }

  try {
    heliusSocket = new WebSocket(WSS_URL);

    heliusSocket.on("open", () => {
      console.log("Helius WebSocket connecté.");

      heliusSocket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [
            {
              mentions: [selectedMint],
            },
            {
              commitment: "processed",
            },
          ],
        })
      );
    });

    heliusSocket.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        if (data?.method === "logsNotification") {
          appendJsonLine(FILES.market, {
            type: "HELIUS_LOG",
            timestamp: now(),
            mint: selectedMint,
            value: data.params?.result || null,
          });
        }
      } catch {
        // Message non exploitable, ignoré.
      }
    });

    heliusSocket.on("error", (error) => {
      console.error("Helius WebSocket:", error.message);
    });

    heliusSocket.on("close", () => {
      console.log("Helius WebSocket fermé.");
    });
  } catch (error) {
    console.error("Impossible de démarrer Helius:", error.message);
  }
}

function stopHeliusDiagnostics() {
  try {
    if (heliusSocket) {
      heliusSocket.close();
      heliusSocket = null;
    }
  } catch {
    // Rien à faire.
  }
}

/* =========================================================
   ÉVALUATION DU TOKEN
========================================================= */

async function evaluateToken(mint) {
  const pairs = await getDexPairs(mint);
  const pair = chooseBestPumpSwapPair(pairs, mint);

  if (!pair) {
    return {
      accepted: false,
      reason: "NO_PUMPSWAP_PAIR",
      mint,
    };
  }

  const name =
    pair?.baseToken?.address === mint
      ? pair?.baseToken?.name
      : pair?.quoteToken?.name;

  const symbol =
    pair?.baseToken?.address === mint
      ? pair?.baseToken?.symbol
      : pair?.quoteToken?.symbol;

  const liquidity = Number(pair?.liquidity?.usd || 0);

  const acceptedName = /claude|openai|anthropic/i.test(
    `${name || ""} ${symbol || ""}`
  );

  if (!acceptedName && mint !== TRUSTED_TEST_MINT) {
    return {
      accepted: false,
      reason: "NAME_FILTER",
      mint,
      name,
      symbol,
      liquidity,
      pair,
    };
  }

  if (
    liquidity < MIN_LIQUIDITY ||
    liquidity > MAX_LIQUIDITY
  ) {
    return {
      accepted: false,
      reason: "LIQUIDITY_FILTER",
      mint,
      name,
      symbol,
      liquidity,
      pair,
    };
  }

  currentCandidate = {
    mint,
    name: name || "Unknown",
    symbol: symbol || "UNKNOWN",
    liquidity,
    pairAddress: pair.pairAddress,
    dexId: pair.dexId,
    pairUrl: pair.url || null,
  };

  return {
    accepted: true,
    reason: "TOKEN_ACCEPTED",
    ...currentCandidate,
  };
}

/* =========================================================
   COMMANDES TELEGRAM
========================================================= */

bot.start(async (ctx) => {
  await ctx.reply(
    `🤖 V6.4 ACTIVE\n\n` +
    `🎯 1 seul BUY simulé de 10 $\n` +
    `📈 Cible : +5 %\n` +
    `🛡️ Stops virtuels : -10 / -15 / -20 / -25 %\n` +
    `⏱️ Session maximale : 45 min\n` +
    `🚫 Aucun BUY après 43 min\n\n` +
    `Commandes :\n` +
    `/test MINT\n` +
    `/starttrade\n` +
    `/stoptrade\n` +
    `/status\n` +
    `/comparison\n` +
    `/lastcrash\n` +
    `/help\n\n` +
    `⚠️ Simulation uniquement.`
  );
});

bot.command("test", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const mint = parts[1];

  if (!mint) {
    await ctx.reply("Utilisation : /test ADRESSE_DU_TOKEN");
    return;
  }

  await ctx.reply(
    `🔎 TEST V6.4\n\n` +
    `Mint : ${mint}\n\n` +
    `Validation PumpSwap en cours...`
  );

  try {
    const result = await evaluateToken(mint);

    if (!result.accepted) {
      await ctx.reply(
        `🔴 TOKEN REFUSÉ\n\n` +
        `Mint : ${mint}\n` +
        `Motif : ${result.reason}\n` +
        `Nom : ${result.name || "inconnu"}\n` +
        `Symbole : ${result.symbol || "inconnu"}\n` +
        `Liquidité : ${formatUsd(result.liquidity)}`
      );

      return;
    }

    selectedMint = mint;
    selectedPair = null;
    currentCandidate = result;

    await ctx.reply(
      `🟢 TOKEN ACCEPTÉ V6.4\n\n` +
      `🪙 Nom : ${result.name}\n` +
      `🔤 Symbole : ${result.symbol}\n` +
      `💧 Liquidité : ${formatUsd(result.liquidity)}\n` +
      `🏦 DEX : ${result.dexId}\n` +
      `🔗 Pair : ${result.pairAddress}\n\n` +
      `Le token est prêt pour /starttrade.`
    );
  } catch (error) {
    await ctx.reply(
      `❌ Erreur pendant le test :\n${error.message}`
    );
  }
});

bot.command("starttrade", async (ctx) => {
  if (tradingActive) {
    await ctx.reply("🟡 Une simulation est déjà active.");
    return;
  }

  try {
    const result = await evaluateToken(selectedMint);

    if (!result.accepted) {
      await ctx.reply(
        `🔴 Simulation refusée.\n\nMotif : ${result.reason}`
      );
      return;
    }

    tradingActive = true;
    sessionStartedAt = now();
    lastBuyAt = 0;
    marketHistory = [];
    currentMarket = null;
    singlePosition = null;
    buyNumber = 0;
    selectedPair = null;
    lastDiagnosticAt = 0;

    startHeliusDiagnostics();
    startMarketLoop();

    await ctx.reply(
      `🟢 V6.4 SIMULATION ACTIVE\n\n` +
      `🪙 ${result.name}\n` +
      `💵 1 seul BUY de ${CAPITAL_PER_BUY} $\n` +
      `🎯 Cible : +${TARGET_PERCENT}%\n` +
      `🛡️ Stops virtuels : -10 / -15 / -20 / -25%\n` +
      `⏱️ Maximum : 45 min\n` +
      `🚫 Aucun BUY après 43 min\n\n` +
      `📊 Les 4 stops utilisent la même position simulée.`
    );
  } catch (error) {
    await ctx.reply(
      `❌ Impossible de démarrer :\n${error.message}`
    );
  }
});

bot.command("stoptrade", async (ctx) => {
  if (!tradingActive) {
    await ctx.reply("⚪ Aucune simulation active.");
    return;
  }

  if (singlePosition && currentMarket) {
    forceCloseRemaining("MANUAL_STOP");
  }

  tradingActive = false;
  stopHeliusDiagnostics();

  if (marketTimer) {
    clearInterval(marketTimer);
    marketTimer = null;
  }

  await ctx.reply(
    `🛑 V6.4 ARRÊTÉE\n\n` +
    `Aucune position ne reste ouverte.\n\n` +
    formatComparison()
  );
});

bot.command("status", async (ctx) => {
  const openScenarios = singlePosition
    ? singlePosition.scenarios.filter(
        (scenario) => scenario.status === "OPEN"
      ).length
    : 0;

  await ctx.reply(
    `📊 STATUS V6.4\n\n` +
    `Simulation : ${tradingActive ? "🟢 ACTIVE" : "⚪ INACTIVE"}\n` +
    `Mint : ${selectedMint}\n` +
    `Session : ${sessionMinutes().toFixed(1)} min\n` +
    `Prix : ${currentMarket ? formatPrice(currentMarket.price) : "N/A"} $\n` +
    `Liquidité : ${currentMarket ? formatUsd(currentMarket.liquidity) : "N/A"}\n` +
    `Historique : ${marketHistory.length}/${HISTORY_REQUIRED}\n` +
    `Position unique : ${singlePosition ? "🟢 OUVERTE" : "⚪ FERMÉE"}\n` +
    `Scénarios ouverts : ${openScenarios}/4\n\n` +
    formatComparison()
  );
});

bot.command("comparison", async (ctx) => {
  await ctx.reply(formatComparison());
});

bot.command("lastcrash", async (ctx) => {
  await ctx.reply(
    formatCrashReport(
      lastCrashReport || savedCrashes[savedCrashes.length - 1]
    )
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    `🤖 COMMANDES V6.4\n\n` +
    `/test MINT : tester un token\n` +
    `/starttrade : démarrer la simulation\n` +
    `/stoptrade : arrêter la simulation\n` +
    `/status : état actuel\n` +
    `/comparison : comparaison des stops\n` +
    `/lastcrash : dernier crash\n` +
    `/help : aide\n\n` +
    `⚠️ Aucun achat réel n'est effectué.`
  );
});

/* =========================================================
   DÉMARRAGE
========================================================= */

bot.launch({
  dropPendingUpdates: true,
})
  .then(() => {
    console.log("🤖 V6.4 Telegram démarré");
    console.log("🎯 1 BUY simulé de 10 $");
    console.log("🛡️ Stops virtuels : -10 / -15 / -20 / -25 %");
    console.log("📡 RPC :", RPC_URL);
  })
  .catch((error) => {
    console.error("Erreur lancement Telegram:", error.message);
  });

process.once("SIGINT", () => {
  stopHeliusDiagnostics();
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  stopHeliusDiagnostics();
  bot.stop("SIGTERM");
});
