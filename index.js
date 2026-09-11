const { Telegraf } = require("telegraf");
const { WebSocket } = require("ws");

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

const PUMP_FUN_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

bot.start((ctx) => {
  ctx.reply(
    "🤖 Pump Alert Bot est en ligne !\n\n" +
    "🔎 Surveillance des nouveaux tokens Pump.fun activée."
  );
});

bot.command("status", (ctx) => {
  ctx.reply(
    "🟢 Bot opérationnel !\n" +
    "🟢 Connexion Bitquery configurée !\n" +
    "🔎 Surveillance Pump.fun active."
  );
});

bot.launch();

console.log("🤖 Pump Alert Bot démarré");

function startPumpFunStream() {
  const ws = new WebSocket(
    `wss://streaming.bitquery.io/graphql?token=${bitqueryToken}`,
    ["graphql-ws"]
  );

  ws.on("open", () => {
    console.log("🟢 Connecté à Bitquery");

    ws.send(
      JSON.stringify({
        type: "connection_init"
      })
    );
  });

  ws.on("message", async (data) => {
    try {
      const response = JSON.parse(data.toString());

      if (response.type === "connection_ack") {
        console.log("🟢 Bitquery a accepté la connexion");

        const subscription = {
          type: "start",
          id: "1",
          payload: {
            query: `
              subscription {
                Solana {
                  TokenSupplyUpdates(
                    where: {
                      Instruction: {
                        Program: {
                          Address: {
                            is: "${PUMP_FUN_PROGRAM}"
                          }
                          Method: {
                            in: ["create", "create_v2"]
                          }
                        }
                      }
                    }
                  ) {
                    Block {
                      Time
                    }

                    Transaction {
                      Signer
                    }

                    TokenSupplyUpdate {
                      Amount

                      Currency {
                        Symbol
                        Name
                        MintAddress
                        Uri
                      }

                      PostBalance
                    }
                  }
                }
              }
            `
          }
        };

        ws.send(JSON.stringify(subscription));

        console.log("🟢 Surveillance des nouveaux tokens Pump.fun activée");
      }

      if (response.type === "data") {
        const item =
          response.payload?.data?.Solana?.TokenSupplyUpdates?.[0];

        if (!item) {
          return;
        }

        const token = item.TokenSupplyUpdate?.Currency;

        if (!token) {
          return;
        }

        const name = token.Name || "Inconnu";
        const symbol = token.Symbol || "???";
        const mint = token.MintAddress || "Adresse inconnue";
        const creator = item.Transaction?.Signer || "Inconnu";

        console.log("🆕 NOUVEAU TOKEN PUMP.FUN");
        console.log(`${name} (${symbol})`);
        console.log(`Mint: ${mint}`);
        console.log(`Créateur: ${creator}`);

        const message =
          `🆕 <b>Nouveau token Pump.fun</b>\n\n` +
          `🪙 <b>${name}</b> (${symbol})\n` +
          `📍 <code>${mint}</code>\n` +
          `👤 Créateur : <code>${creator}</code>`;

        await sendAlertToTelegram(message);
      }

      if (response.type === "error") {
        console.error("🔴 Erreur Bitquery :", response);
      }
    } catch (error) {
      console.error("🔴 Erreur traitement Bitquery :", error);
    }
  });

  ws.on("close", () => {
    console.log("🟠 Bitquery déconnecté. Reconnexion dans 5 secondes...");

    setTimeout(() => {
      startPumpFunStream();
    }, 5000);
  });

  ws.on("error", (error) => {
    console.error("🔴 WebSocket Bitquery :", error.message);
  });
}

async function sendAlertToTelegram(message) {
  try {
    const chatId = process.env.CHAT_ID;

    if (!chatId) {
      console.log("⚠️ CHAT_ID non configuré");
      return;
    }

    await bot.telegram.sendMessage(chatId, message, {
      parse_mode: "HTML"
    });
  } catch (error) {
    console.error("🔴 Erreur Telegram :", error.message);
  }
}

startPumpFunStream();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
