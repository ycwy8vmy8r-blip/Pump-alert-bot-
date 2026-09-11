const { Telegraf } = require("telegraf");

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("BOT_TOKEN manquant");
  process.exit(1);
}

const bot = new Telegraf(token);

bot.start((ctx) => {
  ctx.reply(
    "🤖 Pump Alert Bot est en ligne !\n\n" +
    "Je vais bientôt surveiller les tokens Pump.fun et détecter les signes de baisse de liquidité."
  );
});

bot.command("status", (ctx) => {
  ctx.reply("🟢 Bot opérationnel !");
});

bot.launch();

console.log("🤖 Pump Alert Bot démarré");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
