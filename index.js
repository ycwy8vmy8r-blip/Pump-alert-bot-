const { Telegraf } = require("telegraf");
const { WebSocket } = require("ws");

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

/* =========================
   COMMANDES TELEGRAM
========================= */

bot.start((ctx) => {
  ctx.reply(
    "🤖 Pump Alert Bot est en ligne !\n\n" +
    "👁️ /watch MINT = surveiller un token\n" +
    "🛑 /unwatch = arrêter\n" +
    "📊 Trades Anaxer + activité blockchain Helius"
  );
});

bot.command("status", (ctx) => {
  if (watchedMint) {
    ctx.reply(
      "🟢 Bot opérationnel !\n\n" +
      "👁️ Token surveillé :\n" +
      watchedMint +
      "\n\n" +
      "📊 Trades : Anaxer\n" +
      "⛓️ Blockchain : Helius"
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
    watchInterval = null;
  }

  stopHeliusMonitoring();

  await ctx.reply(
    "👁️ Surveillance activée !\n\n" +
    "🪙 Token :\n" +
    mint +
    "\n\n" +
    "📊 Trades vérifiés toutes les 45 secondes.\n" +
    "💧 Surveillance de la liquidité Helius activée."
  );

  checkTrades();

  watchInterval = setInterval(
    checkTrades,
    45000
  );

  startHeliusMonitoring();
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

/* =========================
   HELIUS : BLOCKCHAIN
========================= */

function startHeliusMonitoring() {
  if (!watchedMint) {
    return;
  }

  try {
    const url =
      `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;

    heliusWs = new WebSocket(url);

    heliusWs.on("open", () => {
      console.log("🟢 Connecté à Helius");

      heliusWs.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [
            {
              mentions: [watchedMint]
            },
            {
              commitment: "confirmed"
            }
          ]
        })
      );

      console.log(
        "⛓️ Surveillance blockchain activée pour le token"
      );
    });

    heliusWs.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (
          message.result &&
          typeof message.result === "number"
        ) {
          heliusSubscriptionId = message.result;

          console.log(
            "🟢 Abonnement Helius confirmé :",
            heliusSubscriptionId
          );

          return;
        }

        if (
          message.method !== "logsNotification"
        ) {
          return;
        }

        const value =
          message.params?.result?.value;

        const signature =
          value?.signature;

        if (!signature) {
          return;
        }

        console.log(
          "⛓️ Activité blockchain détectée :",
          signature
        );

        await sendBlockchainAlert(signature);

      } catch (error) {
        console.error(
          "🔴 Erreur traitement Helius :",
          error.message
        );
      }
    });

    heliusWs.on("close", () => {
      console.log(
        "🟠 Helius déconnecté."
      );

      heliusWs = null;
      heliusSubscriptionId = null;

      if (watchedMint) {
        setTimeout(() => {
          if (watchedMint && !heliusWs) {
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
      "🔴 Erreur démarrage Helius :",
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
  heliusSubscriptionId = null;
}

/* =========================
   ALERTE BLOCKCHAIN
========================= */

async function sendBlockchainAlert(signature) {
  try {
    const url =
      `https://api.helius.xyz/v0/transactions/?api-key=${heliusApiKey}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        transactions: [signature]
      })
    });

    if (!response.ok) {
      const text = await response.text();

      console.error(
        "🔴 Helius transaction :",
        response.status,
        text
      );

      return;
    }

    const transactions = await response.json();

    if (!transactions.length) {
      console.log("ℹ️ Transaction non décodée");
      return;
    }

    const tx = transactions[0];

    console.log("🔎 TRANSACTION ANALYSÉE");
    console.log("Type :", tx.type);
    console.log("Description :", tx.description);

    /*
     * Pour le moment :
     * on analyse la transaction mais on ne l'envoie
     * PAS automatiquement sur Telegram.
     */

    if (tx.type === "SWAP") {
      console.log("🔄 SWAP détecté");

      if (tx.nativeTransfers?.length) {
        for (const transfer of tx.nativeTransfers) {
          const sol =
            transfer.amount / 1000000000;

          console.log(
            "💰 Mouvement SOL :",
            sol.toFixed(4),
            "SOL"
          );
        }
      }

      if (tx.tokenTransfers?.length) {
        for (const transfer of tx.tokenTransfers) {
          console.log(
            "🪙 Mouvement token :",
            transfer.tokenAmount
          );
        }
      }
    }

    /*
     * On alerte seulement si la transaction
     * semble importante.
     */

    let totalSol = 0;

    if (tx.nativeTransfers?.length) {
      for (const transfer of tx.nativeTransfers) {
        totalSol +=
          Math.abs(transfer.amount) / 1000000000;
      }
    }

    console.log(
      "💰 Total SOL déplacé :",
      totalSol.toFixed(4),
      "SOL"
    );

    /*
     * Seuil provisoire :
     * 5 SOL de mouvements cumulés.
     *
     * Ce n'est PAS encore un signal de retrait
     * de liquidité. C'est seulement un filtre
     * pour éviter le spam.
     */

    if (totalSol >= 5) {
      const message =
        "🚨 <b>Gros mouvement détecté</b>\n\n" +
        "🪙 Token :\n" +
        "<code>" +
        watchedMint +
        "</code>\n\n" +
        "💰 SOL déplacés : <b>" +
        totalSol.toFixed(2) +
        " SOL</b>\n\n" +
        "📌 Type : " +
        (tx.type || "Inconnu") +
        "\n\n" +
        "🔗 Transaction :\n" +
        "<code>" +
        signature +
        "</code>";

      await bot.telegram.sendMessage(
        chatId,
        message,
        {
          parse_mode: "HTML"
        }
      );

      console.log(
        "🚨 Alerte gros mouvement envoyée"
      );
    } else {
      console.log(
        "🟢 Mouvement normal, aucune alerte Telegram"
      );
    }

  } catch (error) {
    console.error(
      "🔴 Erreur analyse transaction :",
      error.message
    );
  }
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
