const { Telegraf } = require("telegraf");

const botToken = process.env.BOT_TOKEN;
const bitqueryToken = process.env.BITQUERY_TOKEN;

if (!botToken) {
  console.error("BOT_TOKEN manquant");
  process.exit(1);
}

if (!bitqueryToken) {
  console.error("BITQUERY_TOKEN manquant");
  process.exit(1);
}

const bot = new Telegraf(botToken);

bot.start((ctx) => {
  ctx.reply("🤖 Pump Alert Bot est en ligne !");
});

bot.command("status", async (ctx) => {
  try {
    const response = await fetch("https://streaming.bitquery.io/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${bitqueryToken}`
      },
      body: JSON.stringify({
        query: `
          query {
            Solana {
              DEXTrades(limit: {count: 1}) {
                Block {
                  Time
                }
              }
            }
          }
        `
      })
    });

    const text = await response.text();

    console.log("Bitquery HTTP :", response.status);
    console.log("Bitquery réponse :", text);

    if (!response.ok) {
      await ctx.reply(
        `🔴 Bitquery erreur HTTP ${response.status}\n\n${text.slice(0, 500)}`
      );
      return;
    }

    await ctx.reply("🟢 Bot opérationnel !\n🟢 Bitquery répond !");
  } catch (error) {
    console.error("Erreur Bitquery :", error);

    await ctx.reply(
      `🔴 Erreur de connexion Bitquery\n\n${error.message}`
    );
  }
});

bot.launch();

console.log("🤖 Pump Alert Bot démarré");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
