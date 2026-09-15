require("dotenv").config();

const { Telegraf } = require("telegraf");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const bot = new Telegraf(BOT_TOKEN);

const TOKEN_MINT = "5XnMHrs45GNHqNpPNHd8bepoHdRhFBppZdUieP4MKa1S";

const CAPITAL = 1;
const TARGET_PERCENT = 5;

const POLL_MS = 2000;
const HISTORY_MS = 120000;

const MIN_LIQUIDITY = 3000;

const MAX_PRICE_DROP_10S = -5;
const MAX_LIQ_DROP_10S = -12;
const MAX_LIQ_DROP_30S = -20;

const ACCELERATION_DROP_5S = -8;

const COOLDOWN_MS = 15000;
const POST_SELL_OBSERVATION_MS = 30000;

const SESSION_LIMIT_MS = 45 * 60 * 1000;
const NO_NEW_BUY_AFTER_MS = 43 * 60 * 1000;

const CRASH_PRICE_DROP_10S = -20;
const CRASH_LIQ_DROP_10S = -50;

const DATA_DIR = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MARKET_FILE = path.join(DATA_DIR, "v5_1_market_history.jsonl");
const TRADES_FILE = path.join(DATA_DIR, "v5_1_trades.jsonl");
const HELIUS_FILE = path.join(DATA_DIR, "v5_1_helius_events.jsonl");
const CRASH_FILE = path.join(DATA_DIR, "v5_1_crash_report.json");
const SUMMARY_FILE = path.join(DATA_DIR, "v5_1_summary.json");

let running = false;
let sessionStart = null;

let position = null;

let cycles = 0;
let winners = 0;
let losers = 0;
let pnl = 0;

let lastMarket = null;
let marketHistory = [];

let lastBuyTime = 0;
let lastSellTime = 0;

let pollTimer = null;
let heliusWs = null;

let pairAddress = null;

function now() {
  return Date.now();
}

function appendJsonl(file, data) {
  try {
    fs.appendFileSync(file, JSON.stringify(data) + "\n");
  } catch (e) {
    console.log("Erreur écriture fichier:", e.message);
  }
}

function saveSummary() {
  const summary = {
    version: "V5.1",
    timestamp: new Date().toISOString(),
    running,
    sessionStart,
    cycles,
    winners,
    losers,
    pnl,
    position,
    lastMarket,
    pairAddress
  };

  try {
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2));
  } catch (e) {
    console.log("Erreur summary:", e.message);
  }
}

async function sendTelegram(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text);
  } catch (e) {
    console.log("Telegram:", e.message);
  }
}

/* =========================================================
   DEXSCREENER
   ========================================================= */

async function fetchDexScreener() {
  try {
    /*
      On utilise l'endpoint token-pairs plutôt que l'ancien
      endpoint token simple.

      Cela permet de récupérer directement les paires associées
      au mint et de choisir une paire PumpSwap.
    */

    const url =
      `https://api.dexscreener.com/token-pairs/v1/solana/${TOKEN_MINT}`;

    const response = await fetch(url, {
      headers: {
        "accept": "application/json"
      }
    });

    if (!response.ok) {
      console.log(`DexScreener HTTP ${response.status}`);
      return null;
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
      return null;
    }

    /*
      On privilégie PumpSwap.
    */

    let pairs = data.filter((p) => {
      const dex = String(p.dexId || "").toLowerCase();
      return dex === "pumpswap";
    });

    /*
      Si aucune paire PumpSwap n'est retournée,
      on garde quand même une paire Solana valide.
    */

    if (pairs.length === 0) {
      pairs = data.filter((p) => {
        return (
          p &&
          p.chainId === "solana" &&
          p.priceUsd &&
          p.liquidity &&
          Number(p.liquidity.usd) > 0
        );
      });
    }

    if (pairs.length === 0) {
      return null;
    }

    /*
      Choisir la paire ayant la meilleure liquidité.
    */

    pairs.sort((a, b) => {
      const la = Number(a?.liquidity?.usd || 0);
      const lb = Number(b?.liquidity?.usd || 0);
      return lb - la;
    });

    const pair = pairs[0];

    if (!pair) {
      return null;
    }

    const price = Number(pair.priceUsd || 0);
    const liquidity = Number(pair.liquidity?.usd || 0);

    if (!Number.isFinite(price) || price <= 0) {
      return null;
    }

    if (!Number.isFinite(liquidity) || liquidity <= 0) {
      return null;
    }

    pairAddress = pair.pairAddress || pairAddress;

    const market = {
      timestamp: now(),
      price,
      liquidity,
      pairAddress: pair.pairAddress || null,
      dexId: pair.dexId || null,
      url: pair.url || null
    };

    return market;

  } catch (e) {
    console.log("DexScreener erreur:", e.message);
    return null;
  }
}

/* =========================================================
   HISTORIQUE
   ========================================================= */

function addMarketHistory(market) {
  marketHistory.push(market);

  const cutoff = now() - HISTORY_MS;

  marketHistory = marketHistory.filter(
    (x) => x.timestamp >= cutoff
  );

  appendJsonl(MARKET_FILE, market);
}

function getMarketAgo(ms) {
  const target = now() - ms;

  let best = null;
  let bestDiff = Infinity;

  for (const item of marketHistory) {
    const diff = Math.abs(item.timestamp - target);

    if (diff < bestDiff) {
      bestDiff = diff;
      best = item;
    }
  }

  return best;
}

function percentChange(current, previous) {
  if (!previous || previous === 0) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

function getPriceDrop(ms) {
  const old = getMarketAgo(ms);

  if (!old || !lastMarket) {
    return null;
  }

  return percentChange(lastMarket.price, old.price);
}

function getLiquidityDrop(ms) {
  const old = getMarketAgo(ms);

  if (!old || !lastMarket) {
    return null;
  }

  return percentChange(lastMarket.liquidity, old.liquidity);
}

/* =========================================================
   ENTREE
   ========================================================= */

function canBuy() {
  if (!running) {
    return false;
  }

  if (position) {
    return false;
  }

  const elapsed = now() - sessionStart;

  if (elapsed >= NO_NEW_BUY_AFTER_MS) {
    return false;
  }

  if (now() - lastSellTime < COOLDOWN_MS) {
    return false;
  }

  if (!lastMarket) {
    return false;
  }

  if (lastMarket.liquidity < MIN_LIQUIDITY) {
    return false;
  }

  const priceDrop10 = getPriceDrop(10000);
  const liqDrop10 = getLiquidityDrop(10000);
  const liqDrop30 = getLiquidityDrop(30000);
  const priceDrop5 = getPriceDrop(5000);

  if (
    priceDrop10 !== null &&
    priceDrop10 <= MAX_PRICE_DROP_10S
  ) {
    return false;
  }

  if (
    liqDrop10 !== null &&
    liqDrop10 <= MAX_LIQ_DROP_10S
  ) {
    return false;
  }

  if (
    liqDrop30 !== null &&
    liqDrop30 <= MAX_LIQ_DROP_30S
  ) {
    return false;
  }

  if (
    priceDrop5 !== null &&
    priceDrop5 <= ACCELERATION_DROP_5S
  ) {
    return false;
  }

  return true;
}

/* =========================================================
   ACHAT
   ========================================================= */

function buy() {
  if (!lastMarket) {
    return;
  }

  const price = lastMarket.price;

  position = {
    capital: CAPITAL,
    entryPrice: price,
    entryTime: now(),
    targetPrice: price * (1 + TARGET_PERCENT / 100)
  };

  cycles++;

  appendJsonl(TRADES_FILE, {
    timestamp: new Date().toISOString(),
    type: "BUY",
    cycle: cycles,
    capital: CAPITAL,
    price,
    targetPrice: position.targetPrice
  });

  sendTelegram(
    `🟢 ACHAT SIMULATION V5.1\n\n` +
    `Capital : $${CAPITAL.toFixed(2)}\n` +
    `Prix : $${price}\n` +
    `Objectif : +${TARGET_PERCENT}%\n` +
    `Cible : $${position.targetPrice}`
  );

  saveSummary();
}

/* =========================================================
   VENTE
   ========================================================= */

function sell(reason) {
  if (!position || !lastMarket) {
    return;
  }

  const exitPrice = lastMarket.price;

  const variation =
    ((exitPrice - position.entryPrice) /
      position.entryPrice) *
    100;

  const result =
    position.capital *
    (variation / 100);

  pnl += result;

  if (result >= 0) {
    winners++;
  } else {
    losers++;
  }

  const trade = {
    timestamp: new Date().toISOString(),
    type: "SELL",
    cycle: cycles,
    reason,
    entryPrice: position.entryPrice,
    exitPrice,
    variationPercent: variation,
    result,
    pnlSession: pnl
  };

  appendJsonl(TRADES_FILE, trade);

  sendTelegram(
    `${result >= 0 ? "🟢" : "🔴"} VENTE SIMULATION V5.1\n\n` +
    `Raison : ${reason}\n` +
    `Variation : ${variation.toFixed(2)}%\n` +
    `Résultat : ${result >= 0 ? "+" : ""}$${result.toFixed(4)}\n` +
    `P&L session : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`
  );

  position = null;
  lastSellTime = now();

  saveSummary();
}

/* =========================================================
   CRASH
   ========================================================= */

async function handleCrash(reason) {
  console.log("🚨 CRASH:", reason);

  if (position && lastMarket) {
    sell("CRASH");
  }

  running = false;

  const report = {
    timestamp: new Date().toISOString(),
    reason,
    sessionDurationMs: sessionStart
      ? now() - sessionStart
      : null,
    cycles,
    winners,
    losers,
    pnl,
    lastMarket
  };

  try {
    fs.writeFileSync(
      CRASH_FILE,
      JSON.stringify(report, null, 2)
    );
  } catch (e) {
    console.log("Erreur crash report:", e.message);
  }

  await sendTelegram(
    `🚨 CRASH V5.1\n\n` +
    `${reason}\n\n` +
    `Cycles : ${cycles}\n` +
    `Gagnants : ${winners}\n` +
    `Perdants : ${losers}\n` +
    `P&L : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`
  );

  stopPolling();
  closeHelius();

  saveSummary();
}

/* =========================================================
   MARKET TICK
   ========================================================= */

async function marketTick() {
  if (!running) {
    return;
  }

  /*
    Sécurité session 45 minutes.
  */

  if (
    sessionStart &&
    now() - sessionStart >= SESSION_LIMIT_MS
  ) {
    if (position && lastMarket) {
      sell("SESSION_45_MIN");
    }

    running = false;

    await sendTelegram(
      `⏱️ FIN SESSION V5.1\n\n` +
      `45 minutes atteintes.\n` +
      `Cycles : ${cycles}\n` +
      `P&L : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`
    );

    stopPolling();
    closeHelius();
    saveSummary();

    return;
  }

  const market = await fetchDexScreener();

  if (!market) {
    console.log("⚠️ Marché indisponible");
    return;
  }

  lastMarket = market;

  addMarketHistory(market);

  const priceDrop10 = getPriceDrop(10000);
  const liqDrop10 = getLiquidityDrop(10000);

  console.log(
    `📊 Prix $${market.price} | ` +
    `Liq $${market.liquidity.toFixed(0)} | ` +
    `Pair ${market.pairAddress || "N/A"}`
  );

  /*
    CRASH
  */

  if (market.liquidity <= 1) {
    await handleCrash("LIQUIDITY_NEAR_ZERO");
    return;
  }

  if (
    priceDrop10 !== null &&
    priceDrop10 <= CRASH_PRICE_DROP_10S
  ) {
    await handleCrash(
      `PRICE_CRASH ${priceDrop10.toFixed(2)}%`
    );
    return;
  }

  if (
    liqDrop10 !== null &&
    liqDrop10 <= CRASH_LIQ_DROP_10S
  ) {
    await handleCrash(
      `LIQUIDITY_CRASH ${liqDrop10.toFixed(2)}%`
    );
    return;
  }

  /*
    POSITION
  */

  if (position) {
    const gain =
      ((market.price - position.entryPrice) /
      position.entryPrice) *
      100;

    if (gain >= TARGET_PERCENT) {
      sell("TARGET_5_PERCENT");
      return;
    }

    return;
  }

  /*
    NO POSITION
  */

  if (canBuy()) {
    buy();
  }
}

/* =========================================================
   POLLING
   ========================================================= */

function startPolling() {
  stopPolling();

  pollTimer = setInterval(
    marketTick,
    POLL_MS
  );

  marketTick();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/* =========================================================
   HELIUS
   ========================================================= */

function connectHelius() {
  if (!HELIUS_API_KEY) {
    console.log("⚠️ HELIUS_API_KEY absente");
    return;
  }

  closeHelius();

  const url =
    `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  heliusWs = new WebSocket(url);

  heliusWs.on("open", () => {
    console.log("🟢 Helius WebSocket connecté");

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [TOKEN_MINT]
        },
        {
          commitment: "processed"
        }
      ]
    };

    heliusWs.send(JSON.stringify(request));
  });

  heliusWs.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (
        msg.result &&
        typeof msg.result === "number"
      ) {
        console.log(
          `Helius logs subscription: ${msg.result}`
        );
        return;
      }

      appendJsonl(HELIUS_FILE, {
        timestamp: new Date().toISOString(),
        data: msg
      });

    } catch (e) {
      console.log("Helius message error:", e.message);
    }
  });

  heliusWs.on("close", () => {
    console.log("🔴 Helius WebSocket fermé");

    if (running) {
      setTimeout(() => {
        if (running) {
          connectHelius();
        }
      }, 3000);
    }
  });

  heliusWs.on("error", (err) => {
    console.log("Helius WebSocket error:", err.message);
  });
}

function closeHelius() {
  if (heliusWs) {
    try {
      heliusWs.removeAllListeners();
      heliusWs.close();
    } catch (e) {}

    heliusWs = null;
  }
}

/* =========================================================
   COMMANDES TELEGRAM
   ========================================================= */

bot.start(async (ctx) => {
  await ctx.reply(
    `🤖 V5.1\n\n` +
    `Simulation uniquement.\n\n` +
    `Capital : $${CAPITAL}\n` +
    `Objectif : +${TARGET_PERCENT}%\n` +
    `Session : 45 minutes`
  );
});

bot.command("starttrade", async (ctx) => {
  if (running) {
    await ctx.reply("🟢 La session est déjà active.");
    return;
  }

  running = true;

  sessionStart = now();

  position = null;

  cycles = 0;
  winners = 0;
  losers = 0;
  pnl = 0;

  lastMarket = null;
  marketHistory = [];

  lastBuyTime = 0;
  lastSellTime = 0;

  pairAddress = null;

  await ctx.reply(
    `🟢 V5.1 DÉMARRÉE\n\n` +
    `Capital : $${CAPITAL}\n` +
    `Objectif : +${TARGET_PERCENT}%\n` +
    `Durée max : 45 min`
  );

  connectHelius();
  startPolling();

  saveSummary();
});

bot.command("stoptrade", async (ctx) => {
  if (!running) {
    await ctx.reply("⚪ Aucune session active.");
    return;
  }

  if (position && lastMarket) {
    sell("MANUAL_STOP");
  }

  running = false;

  stopPolling();
  closeHelius();

  saveSummary();

  await ctx.reply(
    `🛑 V5.1 ARRÊTÉE\n\n` +
    `Cycles : ${cycles}\n` +
    `Gagnants : ${winners}\n` +
    `Perdants : ${losers}\n` +
    `P&L : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}`
  );
});

bot.command("status", async (ctx) => {
  const duration = sessionStart
    ? ((now() - sessionStart) / 60000).toFixed(1)
    : "0.0";

  const price = lastMarket
    ? `$${lastMarket.price}`
    : "N/A";

  const liquidity = lastMarket
    ? `$${lastMarket.liquidity.toFixed(0)}`
    : "N/A";

  await ctx.reply(
    `📊 STATUS V5.1\n\n` +
    `Actif : ${running ? "🟢 OUI" : "🔴 NON"}\n` +
    `Session : ${duration} min\n` +
    `Cycles : ${cycles}\n` +
    `Gagnants : ${winners}\n` +
    `Perdants : ${losers}\n` +
    `P&L : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(4)}\n\n` +
    `Position : ${position ? "🟢 OUVERTE" : "⚪ AUCUNE"}\n` +
    `Prix : ${price}\n` +
    `Liquidité : ${liquidity}\n` +
    `Pair : ${pairAddress || "N/A"}`
  );
});

bot.command("lastcrash", async (ctx) => {
  try {
    if (!fs.existsSync(CRASH_FILE)) {
      await ctx.reply("Aucun crash enregistré.");
      return;
    }

    const report = JSON.parse(
      fs.readFileSync(CRASH_FILE, "utf8")
    );

    await ctx.reply(
      `🚨 DERNIER CRASH\n\n` +
      `Raison : ${report.reason}\n` +
      `Cycles : ${report.cycles}\n` +
      `P&L : ${report.pnl >= 0 ? "+" : ""}$${Number(report.pnl).toFixed(4)}`
    );

  } catch (e) {
    await ctx.reply("Erreur lecture crash.");
  }
});

bot.help(async (ctx) => {
  await ctx.reply(
    `/starttrade - démarrer V5.1\n` +
    `/stoptrade - arrêter\n` +
    `/status - état actuel\n` +
    `/lastcrash - dernier crash\n` +
    `/help - aide`
  );
});

/* =========================================================
   DEMARRAGE
   ========================================================= */

bot.launch()
  .then(() => {
    console.log("🤖 Bot Telegram démarré");
  })
  .catch((err) => {
    console.log("Erreur démarrage bot:", err.message);
  });

process.once("SIGINT", () => {
  stopPolling();
  closeHelius();
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  stopPolling();
  closeHelius();
  bot.stop("SIGTERM");
});
