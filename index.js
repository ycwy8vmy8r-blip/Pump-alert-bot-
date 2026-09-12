const { Telegraf } = require("telegraf");
const { WebSocket } = require("ws");
const { PublicKey } = require("@solana/web3.js");

const botToken = process.env.BOT_TOKEN;
const anaxerApiKey = process.env.ANAXER_API_KEY;
const heliusApiKey = process.env.HELIUS_API_KEY;
const chatId = process.env.CHAT_ID;

if (!botToken || !anaxerApiKey || !heliusApiKey || !chatId) {
  console.error("❌ Variable manquante dans Railway");
  process.exit(1);
}

const bot = new Telegraf(botToken);

let watchedMint = null;
let lastTradeId = null;
let watchInterval = null;

let heliusWs = null;
let heliusSubscriptionId = null;

let lastRealSolReserves = null;

/* =========================
   PROTECTION TELEGRAM
========================= */

let lastTelegramMessageTime = 0;

const TELEGRAM_MIN_INTERVAL = 10000;

async function safeTelegramSend(message, options = {}) {
  const now = Date.now();
  const elapsed = now - lastTelegramMessageTime;

  if (elapsed < TELEGRAM_MIN_INTERVAL) {
    const waitTime =
      TELEGRAM_MIN_INTERVAL - elapsed;

    console.log(
      `⏳ Protection Telegram : attente ${waitTime} ms`
    );

    await new Promise((resolve) =>
      setTimeout(resolve, waitTime)
    );
  }

  try {
    await bot.telegram.sendMessage(
      chatId,
      message,
      options
    );

    lastTelegramMessageTime = Date.now();

    console.log(
      "🟢 Message Telegram envoyé"
    );

  } catch (error) {
    console.error(
      "🔴 Erreur Telegram :",
      error.message
    );
  }
}

/* =========================
   TELEGRAM
========================= */

bot.start((ctx) => {
  ctx.reply(
    "🤖 Pump Alert Bot est en ligne !\n\n" +
    "👁️ /watch MINT = surveiller un token\n" +
    "🛑 /unwatch = arrêter\n" +
    "📊 Trades Anaxer\n" +
    "💧 Liquidité Helius"
  );
});

bot.command("status", (ctx) => {
  if (watchedMint) {
    ctx.reply(
      "🟢 Bot opérationnel !\n\n" +
      "🪙 Token surveillé :\n" +
      watchedMint +
      "\n\n" +
      "📊 Trades : Anaxer\n" +
      "💧 Liquidité : Helius"
    );
  } else {
    ctx.reply(
      "🟢 Bot opérationnel !\n\n" +
      "👁️ Aucun token surveillé."
    );
  }
});

/* =========================
   WATCH
========================= */

bot.command("watch", async (ctx) => {
  const parts =
    ctx.message.text.trim().split(/\s+/);

  const mint = parts[1];

  if (!mint) {
    await ctx.reply(
      "❌ Il manque l'adresse du token.\n\n" +
      "Exemple :\n/watch ADRESSE_DU_MINT"
    );
    return;
  }

  try {
    new PublicKey(mint);
  } catch {
    await ctx.reply(
      "❌ Adresse de token Solana invalide."
    );
    return;
  }

  watchedMint = mint;
  lastTradeId = null;
  lastRealSolReserves = null;

  if (watchInterval) {
    clearInterval(watchInterval);
    watchInterval = null;
  }

  stopHeliusMonitoring();

  await ctx.reply(
    "👁️ Surveillance activée !\n\n" +
    "🪙 Token :\n" +
    mint +
    "\n\n" +
    "📊 Trades : toutes les 45 secondes\n" +
    "💧 Liquidité : surveillance Helius"
  );

  checkTrades();

  watchInterval = setInterval(
    checkTrades,
    45000
  );

  startHeliusMonitoring();
});

/* =========================
   UNWATCH
========================= */

bot.command("unwatch", async (ctx) => {
  watchedMint = null;
  lastTradeId = null;
  lastRealSolReserves = null;

  if (watchInterval) {
    clearInterval(watchInterval);
    watchInterval = null;
  }

  stopHeliusMonitoring();

  await ctx.reply(
    "🛑 Surveillance arrêtée.\n\n" +
    "Aucun token n'est actuellement surveillé."
  );
});

/* =========================
   ANAXER : TRADES
========================= */

async function checkTrades() {
  if (!watchedMint) {
    return;
  }

  try {
    const url =
      `https://api.anaxer.com/v1/tokens/${watchedMint}/trades`;

    const response = await fetch(url, {
      headers: {
        "X-API-Key": anaxerApiKey
      }
    });

    if (!response.ok) {
      const text =
        await response.text();

      console.error(
        "🔴 Anaxer REST :",
        response.status,
        text
      );

      return;
    }

    const result =
      await response.json();

    const trades =
      Array.isArray(result)
        ? result
        : result.data ||
          result.trades ||
          [];

    if (!trades.length) {
      console.log(
        "ℹ️ Aucun trade trouvé"
      );
      return;
    }

    console.log(
      `📊 ${trades.length} trade(s) récupéré(s)`
    );

    if (!lastTradeId) {
      const newestTrade =
        trades[0];

      lastTradeId =
        newestTrade.id ||
        newestTrade.signature ||
        newestTrade.txHash ||
        newestTrade.slot ||
        newestTrade.timestamp;

      console.log(
        "🧠 Dernier trade mémorisé"
      );

      return;
    }

    const newTrades = [];

    for (const trade of trades) {
      const id =
        trade.id ||
        trade.signature ||
        trade.txHash ||
        trade.slot ||
        trade.timestamp;

      if (id === lastTradeId) {
        break;
      }

      newTrades.push(trade);
    }

    if (!newTrades.length) {
      console.log(
        "⏳ Aucun nouveau trade"
      );

      return;
    }

    const newestTrade =
      newTrades[0];

    lastTradeId =
      newestTrade.id ||
      newestTrade.signature ||
      newestTrade.txHash ||
      newestTrade.slot ||
      newestTrade.timestamp;

    console.log(
      `🆕 ${newTrades.length} nouveau(x) trade(s)`
    );

    /*
     * Sécurité :
     * maximum 1 alerte Telegram
     * par cycle de vérification.
     */

    const newestAlert =
      newTrades[newTrades.length - 1];

    await sendTradeAlert(
      newestAlert
    );

  } catch (error) {
    console.error(
      "🔴 Erreur récupération trades :",
      error.message
    );
  }
}

/* =========================
   TELEGRAM : TRADE
========================= */

async function sendTradeAlert(trade) {
  try {
    const volume =
      trade.volumeUsd ??
      trade.volume_usd ??
      trade.usdVolume ??
      null;

    const signature =
      trade.signature ??
      trade.txHash ??
      trade.transaction ??
      "Inconnue";

    const wallet =
      trade.wallet ??
      trade.trader ??
      trade.user ??
      "Inconnu";

    let message =
      "📊 <b>Nouveau trade détecté</b>\n\n" +
      "🪙 <code>" +
      watchedMint +
      "</code>\n\n";

    if (volume !== null) {
      message +=
        "💵 Volume : $" +
        volume +
        "\n";
    }

    message +=
      "👛 Wallet : <code>" +
      wallet +
      "</code>\n" +
      "🔗 Transaction : <code>" +
      signature +
      "</code>";

    await safeTelegramSend(
      message,
      {
        parse_mode: "HTML"
      }
    );

  } catch (error) {
    console.error(
      "🔴 Erreur préparation alerte trade :",
      error.message
    );
  }
}

/* =========================
   HELIUS : LIQUIDITÉ
========================= */

let liquidityInterval = null;
let lastLiquidityAlert = false;

async function checkLiquidity() {
  if (!watchedMint) {
    return;
  }

  try {
    const mintPublicKey =
      new PublicKey(watchedMint);

    const programId =
      new PublicKey(
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
      );

    const [bondingCurve] =
      PublicKey.findProgramAddressSync(
        [
          Buffer.from("bonding-curve"),
          mintPublicKey.toBuffer()
        ],
        programId
      );

    const response =
      await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getAccountInfo",
            params: [
              bondingCurve.toBase58(),
              {
                encoding: "base64",
                commitment: "confirmed"
              }
            ]
          })
        }
      );

    if (!response.ok) {
      console.error(
        "🔴 Helius HTTP :",
        response.status
      );
      return;
    }

    const result =
      await response.json();

    const account =
      result.result?.value;

    if (!account) {
      console.log(
        "⚠️ Bonding curve introuvable"
      );
      return;
    }

    const encodedData =
      account.data?.[0];

    if (!encodedData) {
      console.log(
        "⚠️ Données bonding curve absentes"
      );
      return;
    }

    const buffer =
      Buffer.from(
        encodedData,
        "base64"
      );

    if (buffer.length < 40) {
      console.log(
        "⚠️ Données bonding curve trop courtes :",
        buffer.length
      );
      return;
    }

    const realSolReserves =
      buffer.readBigUInt64LE(32);

    const realSol =
      Number(realSolReserves) /
      1000000000;

    console.log(
      "💧 Liquidité bonding curve :",
      realSol.toFixed(4),
      "SOL"
    );

    /* Première valeur */
    if (lastRealSolReserves === null) {
      lastRealSolReserves =
        realSolReserves;

      console.log(
        "🧠 Réserve initiale mémorisée :",
        realSol.toFixed(4),
        "SOL"
      );

      return;
    }

    const difference =
      Number(
        realSolReserves -
        lastRealSolReserves
      ) / 1000000000;

    if (difference < 0) {
      console.log(
        "📉 Variation :",
        difference.toFixed(4),
        "SOL"
      );
    }

    if (difference > 0) {
      console.log(
        "📈 Variation :",
        difference.toFixed(4),
        "SOL"
      );
    }

    /*
     * ALERTE LIQUIDITÉ À ZÉRO
     */

    if (
      realSol <= 0.001 &&
      !lastLiquidityAlert
    ) {
      lastLiquidityAlert = true;

      await safeTelegramSend(
        "🚨 <b>LIQUIDITÉ À ZÉRO</b>\n\n" +
        "🪙 Token :\n" +
        "<code>" +
        watchedMint +
        "</code>\n\n" +
        "💧 Liquidité bonding curve : <b>0 SOL</b>\n\n" +
        "⚠️ Surveillance immédiate recommandée.",
        {
          parse_mode: "HTML"
        }
      );
    }

    /*
     * ALERTE FORTE BAISSE
     */

    if (
      difference <= -2
    ) {
      await safeTelegramSend(
        "🚨 <b>Forte baisse de liquidité</b>\n\n" +
        "🪙 Token :\n" +
        "<code>" +
        watchedMint +
        "</code>\n\n" +
        "💧 Liquidité actuelle : <b>" +
        realSol.toFixed(2) +
        " SOL</b>\n\n" +
        "📉 Variation : <b>" +
        difference.toFixed(2) +
        " SOL</b>",
        {
          parse_mode: "HTML"
        }
      );
    }

    /*
     * Si la liquidité remonte,
     * on autorise une nouvelle alerte zéro.
     */

    if (realSol > 0.001) {
      lastLiquidityAlert = false;
    }

    lastRealSolReserves =
      realSolReserves;

  } catch (error) {
    console.error(
      "🔴 Erreur vérification liquidité :",
      error.message
    );
  }
}

/* =========================
   DÉMARRAGE SURVEILLANCE
========================= */

function startHeliusMonitoring() {
  if (!watchedMint) {
    return;
  }

  if (liquidityInterval) {
    clearInterval(liquidityInterval);
    liquidityInterval = null;
  }

  lastRealSolReserves = null;
  lastLiquidityAlert = false;

  console.log(
    "💧 Surveillance directe Helius activée"
  );

  checkLiquidity();

  liquidityInterval =
    setInterval(
      checkLiquidity,
      15000
    );
}

/* =========================
   ARRÊT HELIUS
========================= */

function stopHeliusMonitoring() {
  if (liquidityInterval) {
    clearInterval(liquidityInterval);
    liquidityInterval = null;
  }

  lastRealSolReserves = null;
  lastLiquidityAlert = false;

  console.log(
    "🛑 Surveillance liquidité arrêtée"
  );
}

/* =========================
   DÉMARRAGE
========================= */

bot.launch();

console.log(
  "🤖 Pump Alert Bot démarré"
);

process.once("SIGINT", () => {
  stopHeliusMonitoring();
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  stopHeliusMonitoring();
  bot.stop("SIGTERM");
});
