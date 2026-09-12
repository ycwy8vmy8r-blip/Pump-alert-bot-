const { Telegraf } = require("telegraf");
const { PublicKey } = require("@solana/web3.js");

/* =========================
   VARIABLES
========================= */

const botToken = process.env.BOT_TOKEN;
const anaxerApiKey = process.env.ANAXER_API_KEY;
const chatId = process.env.CHAT_ID;

if (!botToken || !anaxerApiKey || !chatId) {
  console.error("❌ Variable Railway manquante");
  process.exit(1);
}

const bot = new Telegraf(botToken);

/* =========================
   CONFIGURATION
========================= */

const LIQUIDITY_INTERVAL = 10000;
const TRADE_INTERVAL = 45000;

const ALERT_LEVELS = [
  { level: "🟠 PRÉ-ALERTE", usd: 80000 },
  { level: "🔴 ALERTE", usd: 50000 },
  { level: "🚨 CRITIQUE", usd: 20000 },
  { level: "💀 EXTRÊME", usd: 5000 }
];

const CRASH_PERCENT = 8;
const CRASH_WINDOW_MS = 60000;

const TELEGRAM_MIN_INTERVAL = 10000;

/* =========================
   ÉTAT
========================= */

let watchedMint = null;

let liquidityInterval = null;
let tradeInterval = null;

let currentLiquidity = null;
let previousLiquidity = null;
let previousLiquidityTime = null;

let highestLiquidity = null;

let lastAlertLevel = null;

let lastTradeId = null;
let recentTrades = [];

let lastTelegramMessageTime = 0;

/* =========================
   TELEGRAM
========================= */

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

    lastTelegramMessageTime =
      Date.now();

    console.log("🟢 Telegram envoyé");

  } catch (error) {

    console.error(
      "🔴 Telegram :",
      error.message
    );
  }
}

/* =========================
   OUTILS
========================= */

function formatUsd(value) {

  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return "$" +
    value.toLocaleString(
      "fr-FR",
      {
        maximumFractionDigits: 0
      }
    );
}

function shortAddress(address) {

  if (!address) {
    return "Inconnu";
  }

  return (
    address.slice(0, 6) +
    "..." +
    address.slice(-6)
  );
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

function tradeWallet(trade) {

  return (
    trade.wallet ||
    trade.trader ||
    trade.user ||
    "Inconnu"
  );
}

/* =========================
   DIRECTION BUY / SELL
========================= */

function getDirection(trade) {

  const from =
    trade.swap?.from;

  const to =
    trade.swap?.to;

  if (!from || !to) {
    return "UNKNOWN";
  }

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

  /*
   * BUY
   * SOL -> TOKEN
   */

  if (
    fromMint === SOL &&
    toMint === watchedMint
  ) {
    return "BUY";
  }

  /*
   * SELL
   * TOKEN -> SOL
   */

  if (
    fromMint === watchedMint &&
    toMint === SOL
  ) {
    return "SELL";
  }

  return "UNKNOWN";
}

/* =========================
   ANAXER
========================= */

async function fetchTrades() {

  if (!watchedMint) {
    return [];
  }

  try {

    const url =
      "https://api.anaxer.com/v1/tokens/" +
      watchedMint +
      "/trades?source=pump_amm&solOnly=true&limit=50";

    const response =
      await fetch(
        url,
        {
          headers: {
            "x-api-key": anaxerApiKey
          }
        }
      );

    if (!response.ok) {

      console.error(
        "🔴 Anaxer :",
        response.status
      );

      return [];
    }

    const result =
      await response.json();

    return Array.isArray(result)
      ? result
      : result.data || [];

  } catch (error) {

    console.error(
      "🔴 Anaxer erreur :",
      error.message
    );

    return [];
  }
}

/* =========================
   ANALYSE TRADES
========================= */

async function checkTrades() {

  if (!watchedMint) {
    return;
  }

  const trades =
    await fetchTrades();

  if (!trades.length) {

    console.log(
      "ℹ️ Aucun trade PumpSwap"
    );

    return;
  }

  console.log(
    `📊 ${trades.length} trades PumpSwap`
  );

  /*
   * Première initialisation.
   */

  if (!lastTradeId) {

    lastTradeId =
      tradeId(trades[0]);

    recentTrades =
      trades;

    console.log(
      "🧠 Historique trades mémorisé"
    );

    return;
  }

  /*
   * Recherche des nouveaux trades.
   */

  const newTrades = [];

  for (const trade of trades) {

    if (
      tradeId(trade) ===
      lastTradeId
    ) {
      break;
    }

    newTrades.push(trade);
  }

  if (!newTrades.length) {
    return;
  }

  lastTradeId =
    tradeId(newTrades[0]);

  recentTrades =
    [
      ...newTrades,
      ...recentTrades
    ].slice(0, 100);

  let buyVolume = 0;
  let sellVolume = 0;

  for (const trade of newTrades) {

    const direction =
      getDirection(trade);

    const volume =
      tradeVolume(trade);

    if (direction === "BUY") {
      buyVolume += volume;
    }

    if (direction === "SELL") {
      sellVolume += volume;
    }
  }

  console.log(
    "🆕 Nouveaux trades :",
    newTrades.length,
    "| BUY $",
    buyVolume.toFixed(2),
    "| SELL $",
    sellVolume.toFixed(2)
  );
}

/* =========================
   DEXSCREENER
========================= */

async function fetchPumpSwapPool() {

  if (!watchedMint) {
    return null;
  }

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

    /*
     * On cherche PumpSwap.
     */

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

    /*
     * Si plusieurs pools existent,
     * on prend celui avec la plus
     * grosse liquidité.
     */

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

/* =========================
   DERNIER SELL IMPORTANT
========================= */

function getLatestImportantSell() {

  for (
    const trade of recentTrades
  ) {

    if (
      getDirection(trade) !==
      "SELL"
    ) {
      continue;
    }

    const volume =
      tradeVolume(trade);

    if (volume >= 500) {
      return trade;
    }
  }

  return null;
}

/* =========================
   ALERTE LIQUIDITÉ
========================= */

async function checkLiquidity() {

  if (!watchedMint) {
    return;
  }

  const pair =
    await fetchPumpSwapPool();

  if (!pair) {
    return;
  }

  const liquidity =
    Number(
      pair.liquidity?.usd || 0
    );

  if (!Number.isFinite(liquidity)) {
    return;
  }

  const now =
    Date.now();

  console.log(
    "💧 PumpSwap :",
    formatUsd(liquidity)
  );

  /*
   * Première mesure.
   */

  if (currentLiquidity === null) {

    currentLiquidity =
      liquidity;

    previousLiquidity =
      liquidity;

    previousLiquidityTime =
      now;

    highestLiquidity =
      liquidity;

    console.log(
      "🧠 Liquidité initiale :",
      formatUsd(liquidity)
    );

    return;
  }

  /*
   * Nouveau plus haut.
   */

  if (
    liquidity >
    highestLiquidity
  ) {

    highestLiquidity =
      liquidity;

    /*
     * On réarme les niveaux
     * si la liquidité remonte.
     */

    lastAlertLevel =
      null;

    console.log(
      "📈 Nouveau plus haut :",
      formatUsd(liquidity)
    );
  }

  /*
   * Variation.
   */

  const variation =
    liquidity -
    currentLiquidity;

  const variationPercent =
    currentLiquidity > 0
      ? (
          variation /
          currentLiquidity
        ) * 100
      : 0;

  /*
   * Forte chute rapide.
   */

  const rapidCrash =
    variationPercent <=
      -CRASH_PERCENT;

  if (rapidCrash) {

    console.log(
      "🚨 CHUTE RAPIDE :",
      variationPercent.toFixed(1),
      "%"
    );

    const sell =
      getLatestImportantSell();

    let sellInfo =
      "❓ Aucun gros SELL identifié.";

    if (sell) {

      sellInfo =
        "🐋 <b>SELL important récent</b>\n" +
        "💵 Volume : <b>" +
        formatUsd(
          tradeVolume(sell)
        ) +
        "</b>\n" +
        "👛 Wallet : <code>" +
        shortAddress(
          tradeWallet(sell)
        ) +
        "</code>\n" +
        "🔗 Tx : <code>" +
        shortAddress(
          sell.signature
        ) +
        "</code>";
    }

    await safeTelegramSend(

      "🚨 <b>CHUTE RAPIDE PUMPSWAP</b>\n\n" +

      "🪙 Token :\n" +
      "<code>" +
      watchedMint +
      "</code>\n\n" +

      "💧 Liquidité : <b>" +
      formatUsd(liquidity) +
      "</b>\n" +

      "📉 Variation : <b>" +
      variationPercent.toFixed(1) +
      "%</b>\n\n" +

      sellInfo +

      "\n\n⚠️ <b>Pression vendeuse à surveiller.</b>"
    );
  }

  /*
   * Niveaux de sortie.
   */

  for (
    const alert of ALERT_LEVELS
  ) {

    if (
      liquidity <=
      alert.usd
    ) {

      /*
       * Ne pas répéter le même niveau.
       */

      if (
        lastAlertLevel ===
        alert.usd
      ) {
        break;
      }

      lastAlertLevel =
        alert.usd;

      const sell =
        getLatestImportantSell();

      let sellInfo =
        "❓ Pas de gros SELL identifié.";

      if (sell) {

        sellInfo =
          "🐋 SELL récent : <b>" +
          formatUsd(
            tradeVolume(sell)
          ) +
          "</b>\n" +

          "👛 Wallet : <code>" +
          shortAddress(
            tradeWallet(sell)
          ) +
          "</code>";
      }

      await safeTelegramSend(

        alert.level +
        " <b>LIQUIDITÉ</b>\n\n" +

        "🪙 Token :\n" +
        "<code>" +
        watchedMint +
        "</code>\n\n" +

        "💧 Liquidité actuelle : <b>" +
        formatUsd(liquidity) +
        "</b>\n\n" +

        "📌 Seuil atteint : <b>" +
        formatUsd(alert.usd) +
        "</b>\n\n" +

        sellInfo
      );

      break;
    }
  }

  /*
   * Si la liquidité revient
   * nettement au-dessus du dernier
   * niveau, on réarme progressivement.
   */

  if (
    liquidity >
    90000
  ) {

    lastAlertLevel =
      null;
  }

  previousLiquidity =
    currentLiquidity;

  previousLiquidityTime =
    now;

  currentLiquidity =
    liquidity;
}

/* =========================
   WATCH
========================= */

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

    /*
     * Reset complet.
     */

    watchedMint =
      mint;

    currentLiquidity =
      null;

    previousLiquidity =
      null;

    previousLiquidityTime =
      null;

    highestLiquidity =
      null;

    lastAlertLevel =
      null;

    lastTradeId =
      null;

    recentTrades =
      [];

    /*
     * Stop anciennes boucles.
     */

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

      "👁️ <b>PUMPSWAP ACTIVÉ</b>\n\n" +

      "🪙 Token :\n" +
      "<code>" +
      mint +
      "</code>\n\n" +

      "💧 Liquidité : toutes les 10 secondes\n" +
      "📊 Trades : Anaxer\n\n" +

      "🎯 Seuils :\n" +
      "🟠 $80K\n" +
      "🔴 $50K\n" +
      "🚨 $20K\n" +
      "💀 $5K\n\n" +

      "⚡ Chute rapide surveillée"
    );

    /*
     * Vérifications immédiates.
     */

    checkLiquidity();
    checkTrades();

    /*
     * Boucles.
     */

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

/* =========================
   UNWATCH
========================= */

bot.command(
  "unwatch",
  async (ctx) => {

    watchedMint =
      null;

    currentLiquidity =
      null;

    previousLiquidity =
      null;

    highestLiquidity =
      null;

    lastAlertLevel =
      null;

    lastTradeId =
      null;

    recentTrades =
      [];

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

/* =========================
   STATUS
========================= */

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

    await ctx.reply(

      "🟢 <b>Bot opérationnel</b>\n\n" +

      "🪙 Token :\n" +
      "<code>" +
      watchedMint +
      "</code>\n\n" +

      "💧 Liquidité : " +
      (
        currentLiquidity !== null
          ? formatUsd(currentLiquidity)
          : "lecture..."
      ) +
      "\n\n" +

      "📈 Plus haut : " +
      (
        highestLiquidity !== null
          ? formatUsd(highestLiquidity)
          : "lecture..."
      )
    );
  }
);

/* =========================
   DÉMARRAGE
========================= */

bot.launch();

console.log(
  "🤖 Pump Alert Bot PumpSwap démarré"
);

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
