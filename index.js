require("dotenv").config();

const { Telegraf } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const TOKEN_MINT = "5XnMHrs45GNHqNpPNHd8bepoHdRhFBppZdUieP4MKa1S";

const bot = new Telegraf(BOT_TOKEN);

async function diagnosticDex() {
  console.log("========================================");
  console.log("🔎 DIAGNOSTIC DEXSCREENER");
  console.log("Token :", TOKEN_MINT);
  console.log("========================================");

  const urls = [
    `https://api.dexscreener.com/token-pairs/v1/solana/${TOKEN_MINT}`,
    `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`
  ];

  for (const url of urls) {
    console.log("\n🌐 URL :", url);

    try {
      const response = await fetch(url);

      console.log("HTTP :", response.status);

      const text = await response.text();

      console.log("Réponse brute :");
      console.log(text.substring(0, 5000));

      try {
        const data = JSON.parse(text);

        console.log("\n📦 TYPE :", Array.isArray(data) ? "ARRAY" : typeof data);

        if (Array.isArray(data)) {
          console.log("Nombre d'éléments :", data.length);

          data.forEach((pair, i) => {
            console.log(`\n--- PAIRE ${i + 1} ---`);
            console.log("chainId :", pair.chainId);
            console.log("dexId :", pair.dexId);
            console.log("pairAddress :", pair.pairAddress);
            console.log("baseToken :", pair.baseToken);
            console.log("quoteToken :", pair.quoteToken);
            console.log("priceUsd :", pair.priceUsd);
            console.log("liquidity :", pair.liquidity);
            console.log("url :", pair.url);
          });
        } else {
          console.log("\nClés :", Object.keys(data));

          if (data.pairs) {
            console.log("Nombre de paires :", data.pairs.length);

            data.pairs.forEach((pair, i) => {
              console.log(`\n--- PAIRE ${i + 1} ---`);
              console.log("chainId :", pair.chainId);
              console.log("dexId :", pair.dexId);
              console.log("pairAddress :", pair.pairAddress);
              console.log("baseToken :", pair.baseToken);
              console.log("quoteToken :", pair.quoteToken);
              console.log("priceUsd :", pair.priceUsd);
              console.log("liquidity :", pair.liquidity);
              console.log("url :", pair.url);
            });
          }
        }

      } catch (e) {
        console.log("⚠️ Réponse non JSON");
      }

    } catch (e) {
      console.log("❌ ERREUR :", e.message);
    }
  }

  console.log("\n========================================");
  console.log("🏁 FIN DIAGNOSTIC");
  console.log("========================================");
}

bot.start(async (ctx) => {
  await ctx.reply(
    "🔎 Diagnostic DexScreener démarré.\n\n" +
    "Regarde les logs Railway."
  );

  await diagnosticDex();
});

bot.command("starttrade", async (ctx) => {
  await ctx.reply(
    "🔎 Diagnostic en cours..."
  );

  await diagnosticDex();

  await ctx.reply(
    "✅ Diagnostic terminé.\n\n" +
    "Envoie-moi les logs Railway."
  );
});

bot.command("status", async (ctx) => {
  await ctx.reply(
    "🔎 MODE DIAGNOSTIC\n\n" +
    "Aucune simulation active."
  );
});

bot.launch()
  .then(() => {
    console.log("🤖 Bot diagnostic démarré");
  })
  .catch((err) => {
    console.log("❌ Erreur bot :", err.message);
  });

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});
