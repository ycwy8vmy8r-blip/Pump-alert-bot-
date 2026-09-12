const { Telegraf } = require("telegraf");
const { PublicKey } = require("@solana/web3.js");

const botToken = process.env.BOT_TOKEN;
const anaxerApiKey = process.env.ANAXER_API_KEY;
const chatId = process.env.CHAT_ID;

if (!botToken || !anaxerApiKey || !chatId) {
  console.error("❌ Variable Railway manquante");
  process.exit(1);
}

const bot = new Telegraf(botToken);

// ===============================
// RÉGLAGES
// ===============================

const LIQUIDITY_INTERVAL = 10000;
const TRADE_INTERVAL = 45000;

// Alertes de liquidité
const LIQUIDITY_LEVELS = [
  { level: "🟠 ALERTE", usd: 80000 },
  { level: "🔴 DANGER", usd: 50000 },
  { level: "🚨 CRITIQUE", usd: 20000 },
  { level: "💀 EXTRÊME", usd: 5000 }
];

// Pression vendeuse
const PRESSURE_WINDOW_MS = 120000; // 2 minutes

const PRESSURE_LEVELS = {
  WATCH: {
    sellRatio: 60,
    minSellUsd: 1000
  },
  STRONG: {
    sellRatio: 70,
    minSellUsd: 2000
  },
  EXTREME: {
    sellRatio: 75,
    minSellUsd: 4000
  }
};

// Chute rapide de liquidité
const RAPID_DROP_PERCENT = 4;
const RAPID_DROP_WINDOW_MS = 60000;

// Anti-spam Telegram
const TELEGRAM_MIN_INTERVAL = 10000;

// ===============================
// ÉTAT
// ===============================

let watchedMint = null;

let liquidityInterval = null;
let tradeInterval = null;

let currentLiquidity = null;
let highestLiquidity = null;

let liquidityHistory = [];

let lastLiquidityAlert = null;
let lastPressureAlert = null;

let recentTrades = [];

let lastTelegramMessageTime = 0;

// ===============================
// OUTILS
// ===============================

function formatUsd(value) {
  if (!Number.isFinite(value)) return "N/A";

  return "$" + value.toLocaleString("fr-FR", {
    maximumFractionDigits: 0
  });
}

function shortAddress(address) {
  if (!address) return "Inconnu";

  return address.slice(0, 6) + "..." + address.slice(-6);
}

function tradeId(trade) {
  return (
    trade.signature ||
    trade.id ||
    trade.slot ||
    trade.timestamp
  );
}

function tradeVolume(trade) {
  return Number(
    trade.volumeUsd ??
    trade.volume_usd ??
    trade.usdVolume ??
    0
  );
}

// ===============================
// DIRECTION BUY / SELL
// ===============================

function getDirection(trade) {
  const from = trade.swap?.from;
  const to = trade.swap?.to;

  if (!from || !to) return "UNKNOWN";

  const fromMint =
    from.mint ||
    from.address ||
    "";

  const toMint =
    to.mint ||
    to.address ||
    "";

  const SOL =
    "So11111111111111111111111111111111111111112";

  if (
    fromMint === SOL &&
    toMint === watchedMint
  ) {
    return "BUY";
  }

  if (
    fromMint === watchedMint &&
    toMint === SOL
  ) {
    return "SELL";
  }

  return "UNKNOWN";
}

// ===============================
// TELEGRAM
// ===============================

async function safeTelegramSend(message) {
  const now = Date.now();

  const elapsed =
    now - lastTelegramMessageTime;

  if (elapsed < TELEGRAM_MIN_INTERVAL) {
    const wait =
      TELEGRAM_MIN_INTERVAL - elapsed;

    await new Promise(resolve =>
      setTimeout(resolve, wait)
    );
  }

  try {
    await bot.telegram.sendMessage(
      chatId,
      message,
      {
        parse_mode: "HTML"
      }
    );

    lastTelegramMessageTime = Date.now();

    console.log("🟢 Telegram envoyé");

  } catch (error) {
    console.error(
      "🔴 Telegram :",
      error.message
    );
  }
}

// ===============================
// ANAXER
// ===============================

async function fetchTrades() {
  if (!watchedMint) return [];

  try {

    const url =
      "https://api.anaxer.com/v1/tokens/" +
      watchedMint +
      "/trades?source=pump_amm&solOnly=true&limit=50";

    const response =
      await fetch(url, {
        headers: {
          "x-api-key": anaxerApiKey
        }
      });

    if (!response.ok) {

      console.error(
        "🔴 Anaxer :",
        response.status
      );

      return [];
    }

    const result =
      await response.json();

    if (Array.isArray(result)) {
      return result;
    }

    return result.data || [];

  } catch (error) {

    console.error(
      "🔴 Anaxer erreur :",
      error.message
    );

    return [];
  }
}

// ===============================
// ANALYSE PRESSION
// ===============================

function analyzePressure() {

  const now = Date.now();

  const recent = recentTrades.filter(
    trade => {

      const timestamp =
        Number(trade.timestamp || 0);

      return (
        timestamp > 0 &&
        now - timestamp <= PRESSURE_WINDOW_MS
      );
    }
  );

  let buyVolume = 0;
  let sellVolume = 0;

  let sellCount = 0;
  let buyCount = 0;

  let biggestSell = null;
  let biggestSellVolume = 0;

  for (const trade of recent) {

    const volume =
      tradeVolume(trade);

    if (!Number.isFinite(volume) || volume <= 0) {
      continue;
    }

    const direction =
      getDirection(trade);

    if (direction === "BUY") {

      buyVolume += volume;
      buyCount++;

    }

    if (direction === "SELL") {

      sellVolume += volume;
      sellCount++;

      if (volume > biggestSellVolume) {

        biggestSellVolume = volume;
        biggestSell = trade;
      }
    }
  }

  const totalVolume =
    buyVolume + sellVolume;

  if (totalVolume <= 0) {

    return {
      recent,
      buyVolume: 0,
      sellVolume: 0,
      sellRatio: 0,
      buyCount: 0,
      sellCount: 0,
      biggestSell: null
    };
  }

  const sellRatio =
    (sellVolume / totalVolume) * 100;

  return {
    recent,
    buyVolume,
    sellVolume,
    sellRatio,
    buyCount,
    sellCount,
    biggestSell
  };
}

// ===============================
// CHECK TRADES
// ===============================

async function checkTrades() {

  if (!watchedMint) return;

  const trades =
    await fetchTrades();

  if (!trades.length) {

    console.log(
      "ℹ️ Aucun trade PumpSwap"
    );

    return;
  }

  recentTrades = trades;

  const pressure =
    analyzePressure();

  console.log(
    "📊 2 min | BUY",
    formatUsd(pressure.buyVolume),
    "| SELL",
    formatUsd(pressure.sellVolume),
    "| SELL %",
    pressure.sellRatio.toFixed(1)
  );

  // ==================================
  // PRESSION VENDEUSE
  // ==================================

  let pressureLevel = null;

  if (
    pressure.sellRatio >=
      PRESSURE_LEVELS.EXTREME.sellRatio &&
    pressure.sellVolume >=
      PRESSURE_LEVELS.EXTREME.minSellUsd
  ) {

    pressureLevel = "EXTREME";

  } else if (
    pressure.sellRatio >=
      PRESSURE_LEVELS.STRONG.sellRatio &&
    pressure.sellVolume >=
      PRESSURE_LEVELS.STRONG.minSellUsd
  ) {

    pressureLevel = "STRONG";

  } else if (
    pressure.sellRatio >=
      PRESSURE_LEVELS.WATCH.sellRatio &&
    pressure.sellVolume >=
      PRESSURE_LEVELS.WATCH.minSellUsd
  ) {

    pressureLevel = "WATCH";
  }

  // ==================================
  // ALERTE TELEGRAM
  // ==================================

  if (
    pressureLevel &&
    pressureLevel !== lastPressureAlert
  ) {

    lastPressureAlert =
      pressureLevel;

    let title =
      "🟡 PRESSION VENDEUSE";

    if (pressureLevel === "STRONG") {
      title =
        "🟠 FORTE PRESSION VENDEUSE";
    }

    if (pressureLevel === "EXTREME") {
      title =
        "🔴 PRESSION VENDEUSE EXTRÊME";
    }

    let sellInfo =
      "❓ Aucun gros SELL identifié.";

    if (pressure.biggestSell) {

      sellInfo =
        "🐋 Plus gros SELL : <b>" +
        formatUsd(
          tradeVolume(
            pressure.biggestSell
          )
        ) +
        "</b>";
    }

    await safeTelegramSend(

      title +
      "\n\n" +

      "🪙 Token :\n" +
      "<code>" +
      watchedMint +
      "</code>\n\n" +

      "📊 Sur les 2 dernières minutes :\n" +

      "🔴 SELL : <b>" +
      formatUsd(
        pressure.sellVolume
      ) +
      "</b>\n" +

      "🟢 BUY : <b>" +
      formatUsd(
        pressure.buyVolume
      ) +
      "</b>\n\n" +

      "📉 Part des SELL : <b>" +
      pressure.sellRatio.toFixed(1) +
      "%</b>\n\n" +

      sellInfo +
      "\n\n" +

      "⚠️ La pression vendeuse augmente."
    );
  }

  // Retour à la normale
  if (
    pressure.sellRatio < 50
  ) {

    lastPressureAlert = null;
  }
}

// ===============================
// DEXSCREENER
// ===============================

async function fetchPumpSwapPool() {

  if (!watchedMint) return null;

  try {

    const url =
      "https://api.dexscreener.com/token-pairs/v1/solana/" +
      watchedMint;

    const response =
      await fetch(url);

    if (!response.ok) {

      console.error(
        "🔴 DexScreener :",
        response.status
      );

      return null;
    }

    const pairs =
      await response.json();

    if (!Array.isArray(pairs)) {
      return null;
    }

    const pumpSwapPairs =
      pairs.filter(pair => {

        const dex =
          String(
            pair.dexId || ""
          ).toLowerCase();

        return (
          dex === "pumpswap" ||
          dex === "pump_amm" ||
          dex === "pumpamm"
        );
      });

    if (!pumpSwapPairs.length) {

      console.log(
        "⚠️ Aucun pool PumpSwap trouvé"
      );

      return null;
    }

    pumpSwapPairs.sort(
      (a, b) =>
        Number(
          b.liquidity?.usd || 0
        ) -
        Number(
          a.liquidity?.usd || 0
        )
    );

    return pumpSwapPairs[0];

  } catch (error) {

    console.error(
      "🔴 DexScreener erreur :",
      error.message
    );

    return null;
  }
}

// ===============================
// LIQUIDITÉ
// ===============================

async function checkLiquidity() {

  if (!watchedMint) return;

  const pair =
    await fetchPumpSwapPool();

  if (!pair) return;

  const liquidity =
    Number(
      pair.liquidity?.usd || 0
    );

  if (
    !Number.isFinite(liquidity) ||
    liquidity <= 0
  ) {
    return;
  }

  const now =
    Date.now();

  console.log(
    "💧 PumpSwap :",
    formatUsd(liquidity)
  );

  // Première lecture
  if (currentLiquidity === null) {

    currentLiquidity =
      liquidity;

    highestLiquidity =
      liquidity;

    liquidityHistory = [
      {
        time: now,
        liquidity
      }
    ];

    console.log(
      "🧠 Liquidité initiale :",
      formatUsd(liquidity)
    );

    return;
  }

  // Plus haut
  if (
    liquidity >
    highestLiquidity
  ) {

    highestLiquidity =
      liquidity;

    console.log(
      "📈 Nouveau plus haut :",
      formatUsd(liquidity)
    );
  }

  // Historique 2 minutes
  liquidityHistory.push({
    time: now,
    liquidity
  });

  liquidityHistory =
    liquidityHistory.filter(
      item =>
        now - item.time <= 120000
    );

  // ==================================
  // CHUTE RAPIDE SUR 60 SECONDES
  // ==================================

  const oneMinuteAgo =
    liquidityHistory.find(
      item =>
        now - item.time >=
        RAPID_DROP_WINDOW_MS
    );

  if (oneMinuteAgo) {

    const dropPercent =
      (
        (liquidity -
          oneMinuteAgo.liquidity) /
        oneMinuteAgo.liquidity
      ) * 100;

    if (
      dropPercent <=
      -RAPID_DROP_PERCENT
    ) {

      await safeTelegramSend(

        "🚨 <b>CHUTE RAPIDE DE LIQUIDITÉ</b>\n\n" +

        "🪙 Token :\n" +
        "<code>" +
        watchedMint +
        "</code>\n\n" +

        "💧 Liquidité : <b>" +
        formatUsd(liquidity) +
        "</b>\n\n" +

        "📉 Variation 60s : <b>" +
        dropPercent.toFixed(1) +
        "%</b>\n\n" +

        "⚠️ <b>Risque de sortie important.</b>"
      );
    }
  }

  // ==================================
  // SEUILS LIQUIDITÉ
  // ==================================

  for (
    const alert of LIQUIDITY_LEVELS
  ) {

    if (
      liquidity <= alert.usd &&
      lastLiquidityAlert !==
        alert.usd
    ) {

      lastLiquidityAlert =
        alert.usd;

      await safeTelegramSend(

        alert.level +
        " <b>LIQUIDITÉ</b>\n\n" +

        "🪙 Token :\n" +
        "<code>" +
        watchedMint +
        "</code>\n\n" +

        "💧 Liquidité : <b>" +
        formatUsd(liquidity) +
        "</b>\n\n" +

        "🎯 Seuil : <b>" +
        formatUsd(alert.usd) +
        "</b>"
      );

      break;
    }
  }

  // Reset si la liquidité remonte franchement
  if (liquidity > 90000) {

    lastLiquidityAlert = null;
  }

  currentLiquidity =
    liquidity;
}

// ===============================
// WATCH
// ===============================

bot.command(
  "watch",
  async (ctx) => {

    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    const mint =
      parts[1];

    if (!mint) {

      await ctx.reply(
        "❌ Utilise :\n/watch MINT"
      );

      return;
    }

    try {

      new PublicKey(mint);

    } catch {

      await ctx.reply(
        "❌ Adresse Solana invalide."
      );

      return;
    }

    watchedMint =
      mint;

    currentLiquidity =
      null;

    highestLiquidity =
      null;

    liquidityHistory =
      [];

    lastLiquidityAlert =
      null;

    lastPressureAlert =
      null;

    recentTrades =
      [];

    if (liquidityInterval) {
      clearInterval(
        liquidityInterval
      );
    }

    if (tradeInterval) {
      clearInterval(
        tradeInterval
      );
    }

    await ctx.reply(

      "👁️ <b>RADAR PUMPSWAP ACTIVÉ</b>\n\n" +

      "🪙 Token :\n" +
      "<code>" +
      mint +
      "</code>\n\n" +

      "💧 Liquidité : toutes les 10 secondes\n" +

      "📊 Pression SELL : toutes les 45 secondes\n\n" +

      "🟡 Pression : SELL ≥ 60%\n" +
      "🟠 Forte : SELL ≥ 70%\n" +
      "🔴 Extrême : SELL ≥ 75%\n\n" +

      "🚨 Chute rapide : -4% / 60s\n\n" +

      "⚠️ Pas d'alerte à chaque trade.",

      {
        parse_mode: "HTML"
      }
    );

    await checkLiquidity();
    await checkTrades();

    liquidityInterval =
      setInterval(
        checkLiquidity,
        LIQUIDITY_INTERVAL
      );

    tradeInterval =
      setInterval(
        checkTrades,
        TRADE_INTERVAL
      );
  }
);

// ===============================
// UNWATCH
// ===============================

bot.command(
  "unwatch",
  async (ctx) => {

    watchedMint =
      null;

    currentLiquidity =
      null;

    highestLiquidity =
      null;

    liquidityHistory =
      [];

    recentTrades =
      [];

    lastLiquidityAlert =
      null;

    lastPressureAlert =
      null;

    if (liquidityInterval) {

      clearInterval(
        liquidityInterval
      );

      liquidityInterval =
        null;
    }

    if (tradeInterval) {

      clearInterval(
        tradeInterval
      );

      tradeInterval =
        null;
    }

    await ctx.reply(
      "🛑 Surveillance PumpSwap arrêtée."
    );
  }
);

// ===============================
// STATUS
// ===============================

bot.command(
  "status",
  async (ctx) => {

    if (!watchedMint) {

      await ctx.reply(
        "🟢 Bot opérationnel.\n\n" +
        "👁️ Aucun token surveillé."
      );

      return;
    }

    const pressure =
      analyzePressure();

    await ctx.reply(

      "🟢 <b>RADAR ACTIF</b>\n\n" +

      "🪙 Token :\n" +
      "<code>" +
      watchedMint +
      "</code>\n\n" +

      "💧 Liquidité : " +
      (
        currentLiquidity !== null
          ? "<b>" +
            formatUsd(currentLiquidity) +
            "</b>"
          : "lecture..."
      ) +

      "\n\n" +

      "📈 Plus haut : " +
      (
        highestLiquidity !== null
          ? formatUsd(highestLiquidity)
          : "lecture..."
      ) +

      "\n\n" +

      "🔴 SELL 2 min : <b>" +
      formatUsd(
        pressure.sellVolume
      ) +
      "</b>\n" +

      "🟢 BUY 2 min : <b>" +
      formatUsd(
        pressure.buyVolume
      ) +
      "</b>\n\n" +

      "📉 Pression SELL : <b>" +
      pressure.sellRatio.toFixed(1) +
      "%</b>",

      {
        parse_mode: "HTML"
      }
    );
  }
);

// ===============================
// DÉMARRAGE
// ===============================

bot.launch();

console.log(
  "🤖 Pump Alert Bot Radar PumpSwap démarré"
);

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
