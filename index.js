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

bot.start((ctx) => {
  ctx.reply(
    "🤖 Pump Alert Bot est en ligne !\n\n" +
    "🔎 Surveillance des nouveaux tokens Pump.fun activée avec Anaxer."
  );
});

bot.command("status", (ctx) => {
  ctx.reply(
    "🟢 Bot opérationnel !\n" +
    "🟢 Anaxer configuré !\n" +
    "🔎 Surveillance Pump.fun active."
  );
});

async function sendAlertToTelegram(token) {
  try {
    const name = token.name || "Inconnu";
    const symbol = token.symbol || "???";
    const mint = token.mint || "Inconnue";
    const creator = token.creator || "Inconnu";

    const message =
      `🆕 Nouveau token Pump.fun\n\n` +
      `🪙 ${name} (${symbol})\n` +
      `📍 ${mint}\n` +
      `👤 Créateur : ${creator}`;

    await bot.telegram.sendMessage(chatId, message);

    console.log(`🟢 Alerte Telegram envoyée : ${symbol}`);
  } catch (error) {
    console.error("🔴 Erreur Telegram :", error.message);
  }
}

function startAnaxerStream() {
  const ws = new WebSocket(
    `wss://api.anaxer.com/v1/stream?apiKey=${anaxerApiKey}`
  );

  ws.on("open", () => {
    console.log("🟢 Connecté à Anaxer");

    ws.send(
      JSON.stringify({
        type: "subscribe",
        id: "launches",
        channel: "creations",
        filters: {
          enriched: true,
          excludeMayhem: true
        }
      })
    );

    console.log("🟢 Surveillance des créations Pump.fun activée");
  });

  ws.on("message", async (data) => {
    try {
      const envelope = JSON.parse(data.toString());

      if (envelope.type === "subscribed") {
        console.log("🟢 Abonnement Anaxer confirmé :", envelope.id);
        return;
      }

      if (envelope.channel !== "creations") {
        return;
      }

      const token = envelope.data;

      if (!token) {
        return;
      }

      console.log("🆕 NOUVEAU TOKEN PUMP.FUN");
      console.log("Nom :", token.name);
      console.log("Symbole :", token.symbol);
      console.log("Mint :", token.mint);
      console.log("Créateur :", token.creator);

      await sendAlertToTelegram(token);
    } catch (error) {
      console.error("🔴 Erreur traitement Anaxer :", error.message);
    }
  });

  ws.on("close", () => {
    console.log("🟠 Anaxer déconnecté. Reconnexion dans 5 secondes...");

    setTimeout(() => {
      startAnaxerStream();
    }, 5000);
  });

  ws.on("error", (error) => {
    console.error("🔴 WebSocket Anaxer :", error.message);
  });
}

bot.launch();

console.log("🤖 Pump Alert Bot démarré");

startAnaxerStream();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
