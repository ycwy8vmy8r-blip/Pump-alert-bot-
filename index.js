require("dotenv").config();

const { Telegraf } = require("telegraf");
const { Connection } = require("@solana/web3.js");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const ANAXER_API_KEY = process.env.ANAXER_API_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN manquant");
if (!CHAT_ID) throw new Error("CHAT_ID manquant");
if (!HELIUS_API_KEY) throw new Error("HELIUS_API_KEY manquant");

const bot = new Telegraf(BOT_TOKEN);

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(
  RPC_URL,
  "processed"
);

// ======================================================
// V5.1
// $1 par cycle
// +5% target
// ======================================================

const TOKEN_MINT =
  "5XnMHrs45GNHqNpPNHd8bepoHdRhFBppZdUieP4MKa1S";

const CAPITAL = 1;
const TARGET_PERCENT = 5;

const MARKET_INTERVAL = 2000;
const HISTORY_MS = 120000;

const MIN_LIQUIDITY = 3000;

const MAX_PRICE_DROP_10S = -5;
const MAX_LIQUIDITY_DROP_10S = -12;
const MAX_LIQUIDITY_DROP_30S = -20;

const CRASH_PRICE_DROP_10S = -20;
const CRASH_LIQUIDITY_DROP_10S = -50;

const COOLDOWN_AFTER_SELL = 15000;

const OBSERVATION_AFTER_SELL = 30000;

const NO_NEW_BUY_AFTER_MIN = 43;
const MAX_SESSION_MIN = 45;

const ACCELERATION_WINDOW_MS = 5000;
const ACCELERATION_THRESHOLD = -8;

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });
}

// ======================================================
// ÉTAT
// ======================================================

let running = false;
let startTime = null;

let position = null;

let cycleNumber = 0;
let wins = 0;
let losses = 0;

let sessionPnL = 0;

let lastSellTime = 0;

let lastMarket = null;

let marketHistory = [];

let crashDetected = false;

let observationUntil = 0;

let ws = null;

let heliusSubId = null;

let lastHeliusEvent = null;

let lastCrashReport = null;

let marketTickRunning = false;

// ======================================================
// FICHIERS
// ======================================================

function saveJSON(file, data) {
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, file),
      JSON.stringify(data, null, 2)
    );
  } catch (e) {
    console.log(
      "Erreur sauvegarde:",
      e.message
    );
  }
}

function appendJSONL(file, data) {
  try {
    fs.appendFileSync(
      path.join(DATA_DIR, file),
      JSON.stringify(data) + "\n"
    );
  } catch (e) {
    console.log(
      "Erreur JSONL:",
      e.message
    );
  }
}

// ======================================================
// TELEGRAM
// ======================================================

async function send(text) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (e) {
    console.log(
      "Telegram:",
      e.message
    );
  }
}

// ======================================================
// OUTILS
// ======================================================

function shortMint(mint) {
  if (!mint) return "N/A";

  return (
    mint.slice(0, 6) +
    "..." +
    mint.slice(-6)
  );
}

function formatPrice(price) {
  if (!price) return "0";

  return Number(price).toFixed(10);
}

function percentageChange(oldValue, newValue) {
  if (
    oldValue === null ||
    oldValue === undefined ||
    !oldValue
  ) {
    return null;
  }

  return (
    ((newValue - oldValue) /
      oldValue) *
    100
  );
}

function elapsedMinutes() {
  if (!startTime) return 0;

  return (
    (Date.now() - startTime) /
    60000
  );
}

// ======================================================
// DEXSCREENER
// ======================================================

let dexCache = null;
let dexCacheTime = 0;

async function getDexPair() {
  try {
    if (
      dexCache &&
      Date.now() - dexCacheTime < 3000
    ) {
      return dexCache;
    }

    const url =
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`;

    const response =
      await fetch(url);

    if (!response.ok) {
      throw new Error(
        `DexScreener HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const pairs =
      (data.pairs || []).filter(
        (pair) => {
          const dex =
            String(
              pair.dexId || ""
            ).toLowerCase();

          const pumpSwap =
            dex === "pumpswap" ||
            dex === "pump_amm" ||
            dex === "pumpamm" ||
            dex.includes("pump");

          return (
            pair.chainId ===
              "solana" &&
            pumpSwap &&
            pair.baseToken &&
            pair.baseToken.address ===
              TOKEN_MINT
          );
        }
      );

    if (!pairs.length) {
      return null;
    }

    pairs.sort(
      (a, b) => {
        const liquidityA =
          Number(
            a.liquidity?.usd || 0
          );

        const liquidityB =
          Number(
            b.liquidity?.usd || 0
          );

        return (
          liquidityB -
          liquidityA
        );
      }
    );

    dexCache = pairs[0];
    dexCacheTime =
      Date.now();

    return dexCache;
  } catch (e) {
    console.log(
      "DexScreener:",
      e.message
    );

    return null;
  }
}

// ======================================================
// MARCHÉ
// ======================================================

async function getMarketData() {
  const pair =
    await getDexPair();

  if (!pair) {
    return null;
  }

  const price =
    Number(
      pair.priceUsd || 0
    );

  const liquidity =
    Number(
      pair.liquidity?.usd || 0
    );

  if (
    price <= 0 ||
    liquidity <= 0
  ) {
    return null;
  }

  return {
    time: Date.now(),
    price,
    liquidity,
    pairAddress:
      pair.pairAddress,
    dexId:
      pair.dexId,
    volume24h:
      Number(
        pair.volume?.h24 || 0
      ),
    priceChange5m:
      Number(
        pair.priceChange?.m5 || 0
      ),
    priceChange1h:
      Number(
        pair.priceChange?.h1 || 0
      ),
  };
}

// ======================================================
// HISTORIQUE
// ======================================================

function updateHistory(market) {
  marketHistory.push(
    market
  );

  const cutoff =
    Date.now() -
    HISTORY_MS;

  marketHistory =
    marketHistory.filter(
      (item) =>
        item.time >= cutoff
    );

  appendJSONL(
    "v5_1_market_history.jsonl",
    market
  );
}

function getHistoryPoint(ms) {
  const cutoff =
    Date.now() - ms;

  for (
    let i = 0;
    i < marketHistory.length;
    i++
  ) {
    if (
      marketHistory[i].time >=
      cutoff
    ) {
      return marketHistory[i];
    }
  }

  return null;
}

function getPriceDrop10s() {
  if (!lastMarket)
    return null;

  const old =
    getHistoryPoint(10000);

  if (!old) return null;

  return percentageChange(
    old.price,
    lastMarket.price
  );
}

function getLiquidityDrop10s() {
  if (!lastMarket)
    return null;

  const old =
    getHistoryPoint(10000);

  if (!old) return null;

  return percentageChange(
    old.liquidity,
    lastMarket.liquidity
  );
}

function getLiquidityDrop30s() {
  if (!lastMarket)
    return null;

  const old =
    getHistoryPoint(30000);

  if (!old) return null;

  return percentageChange(
    old.liquidity,
    lastMarket.liquidity
  );
}

function getPriceDrop5s() {
  if (!lastMarket)
    return null;

  const old =
    getHistoryPoint(
      ACCELERATION_WINDOW_MS
    );

  if (!old) return null;

  return percentageChange(
    old.price,
    lastMarket.price
  );
}

// ======================================================
// ACCÉLÉRATION
// ======================================================

function accelerationAnomaly() {
  const drop =
    getPriceDrop5s();

  if (drop === null) {
    return false;
  }

  return (
    drop <=
    ACCELERATION_THRESHOLD
  );
}

// ======================================================
// CRASH
// ======================================================

function checkCrash() {
  if (!lastMarket) {
    return false;
  }

  const priceDrop10 =
    getPriceDrop10s();

  const liquidityDrop10 =
    getLiquidityDrop10s();

  if (
    lastMarket.liquidity <= 1
  ) {
    return true;
  }

  if (
    priceDrop10 !== null &&
    priceDrop10 <=
      CRASH_PRICE_DROP_10S
  ) {
    return true;
  }

  if (
    liquidityDrop10 !== null &&
    liquidityDrop10 <=
      CRASH_LIQUIDITY_DROP_10S
  ) {
    return true;
  }

  return false;
}

// ======================================================
// CONDITIONS D'ENTRÉE
// ======================================================

function canBuy() {
  if (!lastMarket) {
    return {
      ok: false,
      reason: "NO_MARKET",
    };
  }

  if (
    elapsedMinutes() >=
    NO_NEW_BUY_AFTER_MIN
  ) {
    return {
      ok: false,
      reason: "43_MIN_CUTOFF",
    };
  }

  if (
    lastMarket.liquidity <
    MIN_LIQUIDITY
  ) {
    return {
      ok: false,
      reason:
        "LIQUIDITY_TOO_LOW",
    };
  }

  if (
    marketHistory.length < 8
  ) {
    return {
      ok: false,
      reason:
        "HISTORY_WARMUP",
    };
  }

  const priceDrop10 =
    getPriceDrop10s();

  const liquidityDrop10 =
    getLiquidityDrop10s();

  const liquidityDrop30 =
    getLiquidityDrop30s();

  if (
    priceDrop10 !== null &&
    priceDrop10 <=
      MAX_PRICE_DROP_10S
  ) {
    return {
      ok: false,
      reason:
        "PRICE_DROP_10S",
    };
  }

  if (
    liquidityDrop10 !== null &&
    liquidityDrop10 <=
      MAX_LIQUIDITY_DROP_10S
  ) {
    return {
      ok: false,
      reason:
        "LIQUIDITY_DROP_10S",
    };
  }

  if (
    liquidityDrop30 !== null &&
    liquidityDrop30 <=
      MAX_LIQUIDITY_DROP_30S
  ) {
    return {
      ok: false,
      reason:
        "LIQUIDITY_DROP_30S",
    };
  }

  if (
    accelerationAnomaly()
  ) {
    return {
      ok: false,
      reason:
        "ACCELERATION_ANOMALY",
    };
  }

  if (
    Date.now() -
      lastSellTime <
      COOLDOWN_AFTER_SELL
  ) {
    return {
      ok: false,
      reason: "COOLDOWN",
    };
  }

  if (
    Date.now() <
    observationUntil
  ) {
    return {
      ok: false,
      reason:
        "POST_SELL_OBSERVATION",
    };
  }

  return {
    ok: true,
    reason: "OK",
  };
}

// ======================================================
// BUY SIMULÉ
// ======================================================

async function simulateBuy() {
  if (position) {
    return;
  }

  const check =
    canBuy();

  if (!check.ok) {
    return;
  }

  const entryPrice =
    lastMarket.price;

  const targetPrice =
    entryPrice *
    (
      1 +
      TARGET_PERCENT / 100
    );

  cycleNumber++;

  position = {
    cycle:
      cycleNumber,

    entryPrice,

    targetPrice,

    entryTime:
      Date.now(),

    capital:
      CAPITAL,

    entryLiquidity:
      lastMarket.liquidity,
  };

  await send(
    `🟢 BUY SIMULÉ #${position.cycle}\n\n` +
    `💵 Capital : $${CAPITAL.toFixed(2)}\n` +
    `💰 Prix : ${formatPrice(entryPrice)} $\n` +
    `💧 Liquidité : $${lastMarket.liquidity.toFixed(2)}\n\n` +
    `🎯 Vente cible : ${formatPrice(targetPrice)} $\n\n` +
    `⏱️ Session : ${elapsedMinutes().toFixed(1)} min\n` +
    `🧪 SIMULATION UNIQUEMENT`
  );
}

// ======================================================
// SELL SIMULÉ
// ======================================================

async function simulateSell(reason) {
  if (
    !position ||
    !lastMarket
  ) {
    return;
  }

  const entry =
    position.entryPrice;

  const exit =
    lastMarket.price;

  const result =
    (
      (exit - entry) /
      entry
    ) *
    100;

  const pnl =
    CAPITAL *
    (result / 100);

  sessionPnL += pnl;

  if (result >= 0) {
    wins++;
  } else {
    losses++;
  }

  const trade = {
    cycle:
      position.cycle,

    reason,

    entryPrice:
      entry,

    exitPrice:
      exit,

    resultPercent:
      result,

    pnl,

    entryLiquidity:
      position.entryLiquidity,

    exitLiquidity:
      lastMarket.liquidity,

    durationSeconds:
      (
        Date.now() -
        position.entryTime
      ) / 1000,

    timestamp:
      new Date().toISOString(),
  };

  appendJSONL(
    "v5_1_trades.jsonl",
    trade
  );

  await send(
    `${reason === "CRASH"
      ? "🚨"
      : reason === "SESSION_LIMIT"
      ? "⏱️"
      : "🎯"} SELL SIMULÉ #${position.cycle}\n\n` +
    `Motif : ${reason}\n` +
    `Entrée : ${formatPrice(entry)} $\n` +
    `Sortie : ${formatPrice(exit)} $\n` +
    `Résultat : ${result >= 0 ? "+" : ""}${result.toFixed(2)} %\n` +
    `P&L : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n\n` +
    `💰 P&L session : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );

  position = null;

  lastSellTime =
    Date.now();

  observationUntil =
    Date.now() +
    OBSERVATION_AFTER_SELL;
}

// ======================================================
// RAPPORT CRASH
// ======================================================

async function handleCrash() {
  if (crashDetected) {
    return;
  }

  crashDetected = true;

  const priceDrop10 =
    getPriceDrop10s();

  const liquidityDrop10 =
    getLiquidityDrop10s();

  if (position) {
    await simulateSell(
      "CRASH"
    );
  }

  const report = {
    timestamp:
      new Date().toISOString(),

    token:
      TOKEN_MINT,

    price:
      lastMarket?.price || null,

    liquidity:
      lastMarket?.liquidity || null,

    priceDrop10s:
      priceDrop10,

    liquidityDrop10s:
      liquidityDrop10,

    acceleration:
      accelerationAnomaly(),

    sessionMinutes:
      elapsedMinutes(),

    cycles:
      cycleNumber,

    wins,
    losses,

    sessionPnL,
  };

  lastCrashReport =
    report;

  saveJSON(
    "v5_1_crash_report.json",
    report
  );

  await send(
    `🚨 CRASH DÉTECTÉ\n\n` +
    `Prix : ${formatPrice(lastMarket.price)} $\n` +
    `Liquidité : $${lastMarket.liquidity.toFixed(2)}\n` +
    `Prix 10s : ${priceDrop10 === null
      ? "N/A"
      : priceDrop10.toFixed(2) + " %"}\n` +
    `Liquidité 10s : ${liquidityDrop10 === null
      ? "N/A"
      : liquidityDrop10.toFixed(2) + " %"}\n\n` +
    `🛑 Nouveaux achats arrêtés.\n` +
    `💰 P&L session : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );

  running = false;

  stopWebSocket();

  saveJSON(
    "v5_1_summary.json",
    {
      timestamp:
        new Date().toISOString(),

      durationMinutes:
        elapsedMinutes(),

      cycles:
        cycleNumber,

      wins,
      losses,

      sessionPnL,

      crash:
        true,
    }
  );
}

// ======================================================
// FIN SESSION 45 MIN
// ======================================================

async function handleSessionLimit() {
  if (!running) {
    return;
  }

  if (
    elapsedMinutes() <
    MAX_SESSION_MIN
  ) {
    return;
  }

  if (
    position &&
    lastMarket
  ) {
    await simulateSell(
      "SESSION_LIMIT"
    );
  }

  running = false;

  saveJSON(
    "v5_1_summary.json",
    {
      timestamp:
        new Date().toISOString(),

      durationMinutes:
        elapsedMinutes(),

      cycles:
        cycleNumber,

      wins,
      losses,

      sessionPnL,

      crash:
        false,
    }
  );

  await send(
    `⏱️ SESSION TERMINÉE\n\n` +
    `Durée : ${MAX_SESSION_MIN} min\n` +
    `Cycles : ${cycleNumber}\n` +
    `Gagnants : ${wins}\n` +
    `Perdants : ${losses}\n` +
    `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );

  stopWebSocket();
}

// ======================================================
// HELIUS WEBSOCKET
// ======================================================

function startWebSocket() {
  try {
    ws =
      new WebSocket(
        WSS_URL
      );

    ws.on(
      "open",
      () => {
        console.log(
          "🟢 Helius WebSocket connecté"
        );

        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method:
              "logsSubscribe",
            params: [
              {
                mentions: [
                  TOKEN_MINT,
                ],
              },
              {
                commitment:
                  "processed",
              },
            ],
          })
        );
      }
    );

    ws.on(
      "message",
      (raw) => {
        try {
          const msg =
            JSON.parse(
              raw.toString()
            );

          if (
            msg.id === 1
          ) {
            heliusSubId =
              msg.result;

            console.log(
              "Helius logs subscription:",
              heliusSubId
            );

            return;
          }

          if (
            msg.method ===
            "logsNotification"
          ) {
            lastHeliusEvent =
              {
                time:
                  Date.now(),

                value:
                  msg.params?.result
                    ?.value || null,
              };

            appendJSONL(
              "v5_1_helius_events.jsonl",
              {
                timestamp:
                  new Date().toISOString(),

                value:
                  msg.params?.result
                    ?.value || null,
              }
            );
          }
        } catch (e) {
          console.log(
            "Helius message:",
            e.message
          );
        }
      }
    );

    ws.on(
      "error",
      (e) => {
        console.log(
          "Helius WS:",
          e.message
        );
      }
    );

    ws.on(
      "close",
      () => {
        console.log(
          "🔴 Helius WebSocket fermé"
        );

        heliusSubId =
          null;

        if (running) {
          setTimeout(
            () => {
              if (
                running
              ) {
                startWebSocket();
              }
            },
            3000
          );
        }
      }
    );
  } catch (e) {
    console.log(
      "WS erreur:",
      e.message
    );
  }
}

// ======================================================
// STOP WEBSOCKET
// ======================================================

function stopWebSocket() {
  try {
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
  } catch {}

  heliusSubId =
    null;
}

// ======================================================
// DÉMARRAGE
// ======================================================

async function startSimulation() {
  if (running) {
    await send(
      "⚠️ Une simulation est déjà active."
    );

    return;
  }

  running = true;

  startTime =
    Date.now();

  position = null;

  cycleNumber = 0;

  wins = 0;

  losses = 0;

  sessionPnL = 0;

  lastSellTime = 0;

  observationUntil = 0;

  crashDetected = false;

  lastCrashReport = null;

  lastMarket = null;

  marketHistory = [];

  dexCache = null;

  dexCacheTime = 0;

  await send(
    `🟢 V5.1 SIMULATION ACTIVE\n\n` +
    `💵 $${CAPITAL.toFixed(2)} / cycle\n` +
    `🎯 +${TARGET_PERCENT}% target\n` +
    `⏱️ ${MAX_SESSION_MIN} min maximum\n` +
    `🚫 Aucun BUY après ${NO_NEW_BUY_AFTER_MIN} min\n` +
    `⚡ Protection accélération active\n` +
    `🧪 SIMULATION UNIQUEMENT`
  );

  startWebSocket();
}

// ======================================================
// BOUCLE PRINCIPALE
// ======================================================

async function marketTick() {
  if (!running) {
    return;
  }

  if (marketTickRunning) {
    return;
  }

  marketTickRunning = true;

  try {
    if (
      elapsedMinutes() >=
      MAX_SESSION_MIN
    ) {
      await handleSessionLimit();

      return;
    }

    const market =
      await getMarketData();

    if (!market) {
      console.log(
        "⚠️ Marché indisponible"
      );

      return;
    }

    lastMarket =
      market;

    updateHistory(
      market
    );

    const priceDrop10 =
      getPriceDrop10s();

    const liquidityDrop10 =
      getLiquidityDrop10s();

    const priceDrop5 =
      getPriceDrop5s();

    console.log(
      `📊 ${formatPrice(market.price)} | ` +
      `$${market.liquidity.toFixed(0)} | ` +
      `P10 ${priceDrop10 === null
        ? "N/A"
        : priceDrop10.toFixed(2) + "%"} | ` +
      `L10 ${liquidityDrop10 === null
        ? "N/A"
        : liquidityDrop10.toFixed(2) + "%"} | ` +
      `5s ${priceDrop5 === null
        ? "N/A"
        : priceDrop5.toFixed(2) + "%"}`
    );

    // --------------------------------------------------
    // CRASH
    // --------------------------------------------------

    if (
      checkCrash()
    ) {
      await handleCrash();

      return;
    }

    // --------------------------------------------------
    // POSITION OUVERTE
    // --------------------------------------------------

    if (position) {
      if (
        market.price >=
        position.targetPrice
      ) {
        await simulateSell(
          "TARGET"
        );
      }
    }

    // --------------------------------------------------
    // NOUVEAU BUY
    // --------------------------------------------------

    if (
      running &&
      !position
    ) {
      await simulateBuy();
    }

    // --------------------------------------------------
    // LIMITE SESSION
    // --------------------------------------------------

    await handleSessionLimit();
  } catch (e) {
    console.log(
      "marketTick:",
      e.message
    );
  } finally {
    marketTickRunning =
      false;
  }
}

// ======================================================
// COMMANDES
// ======================================================

bot.command(
  "start",
  async (ctx) => {
    await ctx.reply(
      `🤖 V5.1\n\n` +
      `💵 $${CAPITAL} / cycle\n` +
      `🎯 +${TARGET_PERCENT}%\n` +
      `⏱️ ${MAX_SESSION_MIN} min\n` +
      `🚫 Aucun BUY après ${NO_NEW_BUY_AFTER_MIN} min\n` +
      `⚡ Détection accélération\n` +
      `🧪 Simulation uniquement\n\n` +
      `/starttrade\n` +
      `/stoptrade\n` +
      `/status\n` +
      `/lastcrash\n` +
      `/help`
    );
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
    if (!running) {
      await send(
        "ℹ️ Aucune simulation active."
      );

      return;
    }

    if (
      position &&
      lastMarket
    ) {
      await simulateSell(
        "MANUAL_STOP"
      );
    }

    running = false;

    stopWebSocket();

    saveJSON(
      "v5_1_summary.json",
      {
        timestamp:
          new Date().toISOString(),

        durationMinutes:
          elapsedMinutes(),

        cycles:
          cycleNumber,

        wins,
        losses,

        sessionPnL,

        crash:
          false,

        manualStop:
          true,
      }
    );

    await send(
      `🛑 SIMULATION ARRÊTÉE\n\n` +
      `Cycles : ${cycleNumber}\n` +
      `Gagnants : ${wins}\n` +
      `Perdants : ${losses}\n` +
      `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
    );
  }
);

bot.command(
  "status",
  async () => {
    await send(
      `📊 STATUS V5.1\n\n` +
      `Actif : ${running ? "🟢 OUI" : "🔴 NON"}\n` +
      `Session : ${elapsedMinutes().toFixed(1)} min\n` +
      `Cycles : ${cycleNumber}\n` +
      `Gagnants : ${wins}\n` +
      `Perdants : ${losses}\n` +
      `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}\n\n` +
      `Position : ${position ? "🟢 OUVERTE" : "⚪ AUCUNE"}\n` +
      `Prix : ${lastMarket ? formatPrice(lastMarket.price) : "N/A"} $\n` +
      `Liquidité : ${lastMarket ? "$" + lastMarket.liquidity.toFixed(2) : "N/A"}`
    );
  }
);

bot.command(
  "lastcrash",
  async () => {
    if (!lastCrashReport) {
      await send(
        "ℹ️ Aucun crash enregistré dans cette session."
      );

      return;
    }

    await send(
      `🚨 DERNIER CRASH\n\n` +
      `Prix : ${formatPrice(lastCrashReport.price)} $\n` +
      `Liquidité : $${Number(
        lastCrashReport.liquidity
      ).toFixed(2)}\n` +
      `Prix 10s : ${lastCrashReport.priceDrop10s === null
        ? "N/A"
        : lastCrashReport.priceDrop10s.toFixed(2) + " %"}\n` +
      `Liquidité 10s : ${lastCrashReport.liquidityDrop10s === null
        ? "N/A"
        : lastCrashReport.liquidityDrop10s.toFixed(2) + " %"}\n` +
      `P&L session : ${lastCrashReport.sessionPnL >= 0 ? "+" : ""}$${Number(
        lastCrashReport.sessionPnL
      ).toFixed(2)}`
    );
  }
);

bot.command(
  "help",
  async () => {
    await send(
      `🤖 V5.1 COMMANDES\n\n` +
      `/start\n` +
      `/starttrade\n` +
      `/stoptrade\n` +
      `/status\n` +
      `/lastcrash\n` +
      `/help`
    );
  }
);

// ======================================================
// TELEGRAM LAUNCH
// ======================================================

bot.launch({
  dropPendingUpdates: true,
})
  .then(() => {
    console.log(
      "🤖 V5.1 Telegram bot démarré"
    );

    console.log(
      "💵 Capital:",
      CAPITAL,
      "$"
    );

    console.log(
      "🎯 Target:",
      TARGET_PERCENT,
      "%"
    );

    console.log(
      "🪙 Token:",
      TOKEN_MINT
    );
  })
  .catch(
    (e) => {
      console.error(
        "❌ Telegram launch:",
        e.message
      );
    }
  );

// ======================================================
// BOUCLE 2 SECONDES
// ======================================================

setInterval(
  marketTick,
  MARKET_INTERVAL
);

// ======================================================
// ARRÊT PROPRE
// ======================================================

process.once(
  "SIGINT",
  () => {
    stopWebSocket();
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    stopWebSocket();
    bot.stop("SIGTERM");
  }
);
