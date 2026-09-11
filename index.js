const { Telegraf } = require("telegraf");

const botToken = process.env.BOT_TOKEN;
const anaxerApiKey = process.env.ANAXER_API_KEY;
const chatId = process.env.CHAT_ID;

if (!botToken || !anaxerApiKey || !chatId) {
  console.error("❌ Variable manquante dans Railway");
  process.exit(1);
}

const bot = new Telegraf(botToken);

let watchedMint = null;
let lastTradeId = null;
let watchInterval = null;

bot.start((ctx) => {
  ctx.reply(
    "🤖 Pump Alert Bot est en ligne !\n\n" +
    "👁️ /watch MINT = surveiller un token\n" +
    "🛑 /unwatch = arrêter"
  );
});

bot.command("status", (ctx) => {
  if (watchedMint) {
    ctx.reply(
      "🟢 Bot opérationnel !\n\n" +
      "👁️ Token surveillé :\n" +
      watchedMint
    );
  } else {
    ctx.reply("🟢 Bot opérationnel !\n\n👁️ Aucun token surveillé.");
  }
});

bot.command("watch", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const mint = parts[1];

  if (!mint) {
    await ctx.reply(
      "❌ Il manque l'adresse du token.\n\n" +
      "Exemple :\n/watch ADRESSE_DU_MINT"
    );
    return;
  }

  watchedMint = mint;
  lastTradeId = null;

  if (watchInterval) {
    clearInterval(watchInterval);
  }

  await ctx.reply(
    "👁️ Surveillance activée !\n\n" +
    "🪙 Token :\n" +
    mint +
    "\n\n" +
    "📊 Vérification des nouveaux trades toutes les 45 secondes."
  );

  checkTrades();

  watchInterval = setInterval(checkTrades, 45000);
});

bot.command("unwatch", async (ctx) => {
  watchedMint = null;
  lastTradeId = null;

  if (watchInterval) {
    clearInterval(watchInterval);
    watchInterval = null;
  }

  await ctx.reply(
    "🛑 Surveillance arrêtée.\n\n" +
    "Aucun token n'est actuellement surveillé."
  );
});

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
      const text = await response.text();

      console.error(
        "🔴 Anaxer REST :",
        response.status,
        text
      );

      return;
    }

    const result = await response.json();

    const trades =
      Array.isArray(result)
        ? result
        : result.data || result.trades || [];

    if (!trades.length) {
      console.log("ℹ️ Aucun trade trouvé");
      return;
    }

    console.log(
      `📊 ${trades.length} trade(s) récupéré(s)`
    );

    /*
     * Premier passage :
     * on mémorise le dernier trade sans envoyer
     * toutes les anciennes transactions.
     */
    if (!lastTradeId) {
      const newestTrade = trades[0];

      lastTradeId =
        newestTrade.id ||
        newestTrade.signature ||
        newestTrade.txHash ||
        newestTrade.slot ||
        newestTrade.timestamp;

      console.log("🧠 Dernier trade mémorisé");
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
      console.log("⏳ Aucun nouveau trade");
      return;
    }

    /*
     * On met à jour le dernier trade connu.
     */
    const newestTrade = newTrades[0];

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
     * Pour commencer, on alerte seulement sur
     * les nouveaux trades importants.
     */
    for (const trade of newTrades.reverse()) {
      await sendTradeAlert(trade);
    }

  } catch (error) {
    console.error(
      "🔴 Erreur récupération trades :",
      error.message
    );
  }
}

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
      message += "💵 Volume : $" + volume + "\n";
    }

    message +=
      "👛 Wallet : <code>" +
      wallet +
      "</code>\n" +
      "🔗 Transaction : <code>" +
      signature +
      "</code>";

    await bot.telegram.sendMessage(chatId, message, {
      parse_mode: "HTML"
    });

    console.log("🟢 Alerte trade envoyée");
  } catch (error) {
    console.error(
      "🔴 Erreur Telegram :",
      error.message
    );
  }
}

bot.launch();

console.log("🤖 Pump Alert Bot démarré");
