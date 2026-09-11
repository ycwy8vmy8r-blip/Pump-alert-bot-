const { Telegraf } = require("telegraf");
const { WebSocket } = require("ws");

const botToken = process.env.BOT_TOKEN;
const anaxerApiKey = process.env.ANAXER_API_KEY;
const chatId = process.env.CHAT_ID;

if (!botToken) {
  console.error("BOT_TOKEN manquant");
  process.exit(1);
}

if (!anaxerApiKey) {
  console.error("ANAXER_API_KEY manquante");
  process.exit(1);
}

if (!chatId) {
  console.error("CHAT_ID manquant");
  process.exit(1);
}

const bot = new Telegraf(botToken);

let watchedMint = null;
let tradeWs = null;

bot.start((ctx) => {
  ctx.reply(
    "🤖 Pump Alert Bot est en ligne !\n\n" +
    "Utilise /watch MINT pour surveiller un token.\n" +
    "Utilise /unwatch pour arrêter la surveillance."
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
    ctx.reply(
      "🟢 Bot opérationnel !\n\n" +
      "👁️ Aucun token surveillé."
    );
  }
});

bot.command("watch", async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const mint = parts[1];

  if (!mint) {
    await ctx.reply(
      "❌ Il manque l'adresse du token.\n\n" +
      "Exemple :\n" +
      "/watch ADRESSE_DU_MINT"
    );
    return;
  }

  watchedMint = mint;

  if (tradeWs) {
    try {
      tradeWs.close();
    } catch (error) {
      console.error("Erreur fermeture ancien stream :", error.message);
    }

    tradeWs = null;
  }

  await ctx.reply(
    "👁️ Surveillance activée !\n\n" +
    "🪙 Token :\n" +
    mint +
    "\n\n" +
    "📊 Je surveille maintenant ses trades."
  );

  startTradeStream(mint);
});

bot.command("unwatch", async (ctx) => {
  watchedMint = null;

  if (tradeWs) {
    try {
      tradeWs.close();
    } catch (error) {
      console.error("Erreur fermeture stream :", error.message);
    }

    tradeWs = null;
  }

  await ctx.reply(
    "🛑 Surveillance arrêtée.\n\n" +
    "Aucun token n'est actuellement surveillé."
  );
});

function startTradeStream(mint) {
  console.log("🔎 Démarrage surveillance :", mint);

  const ws = new WebSocket(
    `wss://api.anaxer.com/v1/stream?apiKey=${anaxerApiKey}`
  );

  tradeWs = ws;

  ws.on("open", () => {
    console.log("🟢 Connecté à Anaxer pour les trades");

    ws.send(
      JSON.stringify({
        type: "subscribe",
        id: "trades",
        channel: "trades",
        filters: {
          sources: ["pump_fun"],
          mints: [mint],
          solOnly: true
        }
      })
    );

    console.log("🟢 Surveillance des trades activée");
  });

  ws.on("message", async (data) => {
    try {
      const envelope = JSON.parse(data.toString());

      if (envelope.type === "subscribed") {
        console.log("🟢 Abonnement trades confirmé");
        return;
      }

      if (envelope.channel !== "trades") {
        return;
      }

      if (mint !== watchedMint) {
        return;
      }

      const trade = envelope.data;

      if (!trade) {
        return;
      }

      console.log("📊 TRADE DÉTECTÉ");
      console.log(JSON.stringify(trade, null, 2));

      await sendTradeAlert(trade, mint);

    } catch (error) {
      console.error(
        "🔴 Erreur traitement trade :",
        error.message
      );
    }
  });

  ws.on("close", () => {
    console.log("🟠 Stream trades fermé");

    if (watchedMint === mint) {
      console.log(
        "🔄 Reconnexion du stream dans 5 secondes..."
      );

      setTimeout(() => {
        if (watchedMint === mint) {
          startTradeStream(mint);
        }
      }, 5000);
    }
  });

  ws.on("error", (error) => {
    console.error(
      "🔴 WebSocket Anaxer :",
      error.message
    );
  });
}

async function sendTradeAlert(trade, mint) {
  try {
    const message =
      "📊 Trade détecté\n\n" +
      "🪙 Token :\n" +
      mint +
      "\n\n" +
      "📦 Données reçues :\n" +
      JSON.stringify(trade, null, 2).slice(0, 3000);

    await bot.telegram.sendMessage(chatId, message);

    console.log("🟢 Alerte trade envoyée à Telegram");
  } catch (error) {
    console.error(
      "🔴 Erreur Telegram :",
      error.message
    );
  }
}

bot.launch();

console.log("🤖 Pump Alert Bot démarré");
