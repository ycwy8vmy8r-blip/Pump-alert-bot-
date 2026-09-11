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
  ctx.reply(
    "🤖 Pump Alert Bot est en ligne !\n\n" +
    "🔗 Connexion Bitquery : test en cours..."
  );
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
          {
            Solana {
              DEXTrades(limit: {count: 1}) {
                Block {
                  Time
                }
                Trade {
                  Buy {
                    Price
                  }
                }
                Dex {
                  ProtocolName
                }
              }
            }
          }
        `
      })
    });

    const data = await response.json();

    if (data.errors) {
      console.error("Erreur Bitquery :", data.errors);
      await ctx.reply("🔴 Bitquery : erreur de connexion");
      return;
    }

    await ctx.reply("🟢 Bot opérationnel !\n🟢 Bitquery connecté !");
  } catch (error) {
    console.error(error);
    await ctx.reply("🔴 Bitquery inaccessible");
  }
});

bot.launch();

console.log("🤖 Pump Alert Bot démarré");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
