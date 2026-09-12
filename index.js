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

function startHeliusMonitoring() {
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

    console.log(
      "📈 Bonding curve :",
      bondingCurve.toBase58()
    );

    const url =
      `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;

    heliusWs =
      new WebSocket(url);

    heliusWs.on("open", () => {
      console.log(
        "🟢 Connecté à Helius"
      );

      heliusWs.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "accountSubscribe",
          params: [
            bondingCurve.toBase58(),
            {
              commitment: "confirmed",
              encoding: "base64"
            }
          ]
        })
      );

      console.log(
        "💧 Surveillance de la liquidité activée"
      );
    });

    heliusWs.on("message", (data) => {
      try {
        const message =
          JSON.parse(data.toString());

        if (
          message.result &&
          typeof message.result ===
            "number"
        ) {
          heliusSubscriptionId =
            message.result;

          console.log(
            "🟢 Abonnement liquidité confirmé :",
            heliusSubscriptionId
          );

          return;
        }

        if (
          message.method !==
          "accountNotification"
        ) {
          return;
        }

        const account =
          message.params?.result?.value;

        const encodedData =
          account?.data?.[0];

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
            "⚠️ Données bonding curve trop courtes"
          );

          return;
        }

        const realSolReserves =
          buffer.readBigUInt64LE(32);

        const realSol =
          Number(
            realSolReserves
          ) / 1000000000;

        console.log(
          "💧 Liquidité bonding curve :",
          realSol.toFixed(4),
          "SOL"
        );

        if (
          lastRealSolReserves ===
          null
        ) {
          lastRealSolReserves =
            realSolReserves;

          console.log(
            "🧠 Réserve initiale mémorisée"
          );

          return;
        }

        const difference =
          Number(
            realSolReserves -
            lastRealSolReserves
          );

        const differenceSol =
          difference / 1000000000;

        if (
          differenceSol < 0
        ) {
          console.log(
            "📉 Liquidité en baisse :",
            differenceSol.toFixed(4),
            "SOL"
          );
        }

        if (
          differenceSol > 0
        ) {
          console.log(
            "📈 Liquidité en hausse :",
            differenceSol.toFixed(4),
            "SOL"
          );
        }

        /*
         * Alerte uniquement
         * pour une baisse importante.
         */

        if (
          differenceSol <= -2
        ) {
          const message =
            "🚨 <b>Forte baisse de liquidité</b>\n\n" +
            "🪙 Token :\n" +
            "<code>" +
            watchedMint +
            "</code>\n\n" +
            "💧 Liquidité actuelle : <b>" +
            realSol.toFixed(2) +
            " SOL</b>\n\n" +
            "📉 Variation : <b>" +
            differenceSol.toFixed(2) +
            " SOL</b>";

          safeTelegramSend(
            message,
            {
              parse_mode: "HTML"
            }
          );
        }

        lastRealSolReserves =
          realSolReserves;

      } catch (error) {
        console.error(
          "🔴 Erreur traitement liquidité :",
          error.message
        );
      }
    });

    heliusWs.on("close", () => {
      console.log(
        "🟠 Helius déconnecté"
      );

      heliusWs = null;
      heliusSubscriptionId =
        null;

      if (watchedMint) {
        setTimeout(() => {
          if (
            watchedMint &&
            !heliusWs
          ) {
            startHeliusMonitoring();
          }
        }, 5000);
      }
    });

    heliusWs.on("error", (error) => {
      console.error(
        "🔴 WebSocket Helius :",
        error.message
      );
    });

  } catch (error) {
    console.error(
      "🔴 Erreur démarrage liquidité :",
      error.message
    );
  }
}

/* =========================
   ARRÊT HELIUS
========================= */

function stopHeliusMonitoring() {
  if (heliusWs) {
    try {
      heliusWs.close();
    } catch (error) {
      console.error(
        "🔴 Erreur fermeture Helius :",
        error.message
      );
    }
  }

  heliusWs = null;
  heliusSubscriptionId =
    null;
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
