const { Telegraf } = require("telegraf");
const { PublicKey } = require("@solana/web3.js");

/* =========================
   VARIABLES RAILWAY
========================= */

const botToken = process.env.BOT_TOKEN;
const anaxerApiKey = process.env.ANAXER_API_KEY;
const heliusApiKey = process.env.HELIUS_API_KEY;
const chatId = process.env.CHAT_ID;

if (!botToken || !anaxerApiKey || !heliusApiKey || !chatId) {
  console.error("❌ Variable manquante dans Railway");
  process.exit(1);
}

const bot = new Telegraf(botToken);

/* =========================
   CONFIGURATION
========================= */

const TRADE_INTERVAL = 45000;
const LIQUIDITY_INTERVAL = 15000;

/*
 * Une forte baisse doit être :
 * - au moins 2 SOL
 * - ET au moins 10 % de la réserve précédente
 */
const MIN_LIQUIDITY_DROP_SOL = 2;
const MIN_LIQUIDITY_DROP_PERCENT = 10;

/*
 * Un SELL est considéré comme significatif
 * à partir de ce volume USD.
 *
 * Cette valeur pourra être ajustée plus tard.
 */
const SIGNIFICANT_SELL_USD = 500;

/*
 * Protection contre plusieurs alertes
 * pour le même événement.
 */
const ALERT_COOLDOWN = 120000;

/*
 * Protection Telegram.
 */
const TELEGRAM_MIN_INTERVAL = 10000;

/* =========================
   ÉTAT DU BOT
========================= */

let watchedMint = null;

let lastTradeId = null;
let lastTrade = null;
let lastSellTrade = null;

let watchInterval = null;
let liquidityInterval = null;

let lastRealSolReserves = null;

let lastLiquidityAlert = false;

let lastCrashAlertTime = 0;

let curveMissingAlertSent = false;

/* =========================
   PROTECTION TELEGRAM
========================= */

let lastTelegramMessageTime = 0;

async function safeTelegramSend(message, options = {}) {
  const now = Date.now();

  const elapsed =
    now - lastTelegramMessageTime;

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
   UTILITAIRES TRADES
========================= */

function getTradeId(trade) {
  return (
    trade.id ||
    trade.signature ||
    trade.txHash ||
    trade.slot ||
    trade.timestamp ||
    null
  );
}

function getTradeVolumeUsd(trade) {
  return (
    trade.volumeUsd ??
    trade.volume_usd ??
    trade.usdVolume ??
    null
  );
}

function getTradeWallet(trade) {
  return (
    trade.wallet ||
    trade.trader ||
    trade.user ||
    "Inconnu"
  );
}

function getTradeSignature(trade) {
  return (
    trade.signature ||
    trade.txHash ||
    trade.transaction ||
    "Inconnue"
  );
}

function getTradeTimestamp(trade) {
  return (
    trade.timestamp ||
    trade.time ||
    trade.blockTime ||
    null
  );
}

/* =========================
   DIRECTION BUY / SELL
========================= */

function isSolMint(mint) {

  if (!mint) {
    return false;
  }

  const value =
    String(mint).toLowerCase();

  return (
    value ===
      "so11111111111111111111111111111111111111112"
    ||
    value === "sol"
    ||
    value === "native"
  );
}

function getTradeDirection(trade) {

  const from =
    trade.swap?.from;

  const to =
    trade.swap?.to;

  if (!from || !to) {
    return "UNKNOWN";
  }

  const fromMint =
    from.mint ||
    from.address ||
    "";

  const toMint =
    to.mint ||
    to.address ||
    "";

  /*
   * BUY :
   * SOL -> TOKEN
   */

  if (
    isSolMint(fromMint) &&
    String(toMint) === String(watchedMint)
  ) {
    return "BUY";
  }

  /*
   * SELL :
   * TOKEN -> SOL
   */

  if (
    String(fromMint) === String(watchedMint) &&
    isSolMint(toMint)
  ) {
    return "SELL";
  }

  return "UNKNOWN";
}

/* =========================
   ANAXER : RÉCUPÉRATION
========================= */

async function fetchTrades() {

  if (!watchedMint) {
    return [];
  }

  try {

    const url =
      `https://api.anaxer.com/v1/tokens/${watchedMint}/trades?limit=50`;

    const response =
      await fetch(url, {
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

      return [];
    }

    const result =
      await response.json();

    const trades =
      Array.isArray(result)
        ? result
        : result.data ||
          result.trades ||
          [];

    return trades;

  } catch (error) {

    console.error(
      "🔴 Erreur Anaxer :",
      error.message
    );

    return [];
  }
}

/* =========================
   ANALYSE D'UN SELL
========================= */

function isSignificantSell(trade) {

  const direction =
    getTradeDirection(trade);

  if (direction !== "SELL") {
    return false;
  }

  const volume =
    Number(
      getTradeVolumeUsd(trade)
    );

  if (!Number.isFinite(volume)) {
    return false;
  }

  return volume >= SIGNIFICANT_SELL_USD;
}

/* =========================
   MÉMORISER LES TRADES
========================= */

function rememberLatestSell(trades) {

  for (const trade of trades) {

    if (
      isSignificantSell(trade)
    ) {

      if (!lastSellTrade) {

        lastSellTrade = trade;

        console.log(
          "🧠 SELL significatif mémorisé :",
          getTradeVolumeUsd(trade),
          "USD"
        );

        return;
      }

      const currentTimestamp =
        Number(
          getTradeTimestamp(trade) || 0
        );

      const previousTimestamp =
        Number(
          getTradeTimestamp(lastSellTrade) || 0
        );

      if (
        currentTimestamp >=
        previousTimestamp
      ) {

        lastSellTrade = trade;

        console.log(
          "🧠 Nouveau SELL significatif mémorisé :",
          getTradeVolumeUsd(trade),
          "USD"
        );
      }

      return;
    }
  }
}

/* =========================
   ANAXER : TRADES
========================= */

async function checkTrades() {

  if (!watchedMint) {
    return;
  }

  try {

    const trades =
      await fetchTrades();

    if (!trades.length) {

      console.log(
        "ℹ️ Aucun trade trouvé"
      );

      return;
    }

    console.log(
      `📊 ${trades.length} trade(s) récupéré(s)`
    );

    /*
     * Anaxer renvoie normalement
     * les trades du plus récent
     * au plus ancien.
     */

    if (!lastTradeId) {

      const newestTrade =
        trades[0];

      lastTradeId =
        getTradeId(newestTrade);

      lastTrade =
        newestTrade;

      /*
       * On mémorise également
       * le dernier SELL significatif.
       */

      rememberLatestSell(trades);

      console.log(
        "🧠 Dernier trade mémorisé"
      );

      return;
    }

    const newTrades = [];

    for (const trade of trades) {

      const id =
        getTradeId(trade);

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

    console.log(
      `🆕 ${newTrades.length} nouveau(x) trade(s)`
    );

    /*
     * Le premier est le plus récent.
     */

    const newestTrade =
      newTrades[0];

    lastTrade =
      newestTrade;

    lastTradeId =
      getTradeId(newestTrade);

    /*
     * On recherche les SELL significatifs.
     */

    rememberLatestSell(newTrades);

  } catch (error) {

    console.error(
      "🔴 Erreur récupération trades :",
      error.message
    );
  }
}

/* =========================
   RECHERCHE SELL AVANT CRASH
========================= */

async function findSellBeforeCrash() {

  const trades =
    await fetchTrades();

  if (!trades.length) {
    return null;
  }

  /*
   * Les trades sont du plus récent
   * au plus ancien.
   *
   * On cherche le SELL significatif
   * le plus récent.
   */

  for (const trade of trades) {

    if (
      isSignificantSell(trade)
    ) {

      lastSellTrade =
        trade;

      return trade;
    }
  }

  return null;
}

/* =========================
   ALERTE CRASH
========================= */

async function sendLiquidityCrashAlert(
  realSol,
  difference,
  previousSol
) {

  const now =
    Date.now();

  /*
   * Évite plusieurs alertes
   * pour la même chute.
   */

  if (
    now - lastCrashAlertTime <
    ALERT_COOLDOWN
  ) {

    console.log(
      "⏳ Alerte crash ignorée : cooldown actif"
    );

    return;
  }

  lastCrashAlertTime =
    now;

  /*
   * On récupère immédiatement
   * les derniers trades avant
   * de construire l'alerte.
   */

  const recentSell =
    await findSellBeforeCrash();

  let tradeInfo =
    "❓ Aucun SELL significatif identifié.";

  if (recentSell) {

    const volume =
      getTradeVolumeUsd(
        recentSell
      );

    const wallet =
      getTradeWallet(
        recentSell
      );

    const signature =
      getTradeSignature(
        recentSell
      );

    const timestamp =
      getTradeTimestamp(
        recentSell
      );

    let timeText =
      "Inconnu";

    if (timestamp) {

      const timestampMs =
        Number(timestamp);

      if (
        Number.isFinite(timestampMs)
      ) {

        timeText =
          new Date(
            timestampMs
          ).toLocaleTimeString(
            "fr-FR"
          );
      }
    }

    tradeInfo =
      "📉 <b>SELL juste avant la chute :</b>\n\n" +
      "💵 Volume : <b>" +
      (
        volume !== null
          ? "$" + Number(volume).toFixed(2)
          : "Inconnu"
      ) +
      "</b>\n" +
      "👛 Wallet : <code>" +
      wallet +
      "</code>\n" +
      "🕐 Heure : " +
      timeText +
      "\n" +
      "🔗 Transaction : <code>" +
      signature +
      "</code>";
  }

  const dropPercent =
    previousSol > 0
      ? Math.abs(difference) /
        previousSol *
        100
      : 0;

  await safeTelegramSend(
    "🚨 <b>FORTE CHUTE DE LIQUIDITÉ</b>\n\n" +

    "🪙 Token :\n" +
    "<code>" +
    watchedMint +
    "</code>\n\n" +

    "💧 Réserve précédente : <b>" +
    previousSol.toFixed(2) +
    " SOL</b>\n" +

    "💧 Réserve actuelle : <b>" +
    realSol.toFixed(2) +
    " SOL</b>\n\n" +

    "📉 Baisse : <b>" +
    Math.abs(difference).toFixed(2) +
    " SOL</b>\n" +

    "📊 Variation : <b>" +
    dropPercent.toFixed(1) +
    "%</b>\n\n" +

    tradeInfo +
    "\n\n" +

    "⚠️ <b>Surveillance immédiate recommandée.</b>",

    {
      parse_mode: "HTML"
    }
  );
}

/* =========================
   TELEGRAM
========================= */

bot.start((ctx) => {

  ctx.reply(
    "🤖 Pump Alert Bot est en ligne !\n\n" +

    "👁️ /watch MINT = surveiller un token\n" +
    "🛑 /unwatch = arrêter\n" +
    "📊 SELL significatifs : Anaxer\n" +
    "💧 Liquidité : Helius\n\n" +

    "🚨 Une alerte est envoyée uniquement\n" +
    "en cas de forte chute de la réserve."
  );
});

/* =========================
   STATUS
========================= */

bot.command("status", (ctx) => {

  if (watchedMint) {

    ctx.reply(
      "🟢 Bot opérationnel !\n\n" +

      "🪙 Token surveillé :\n" +
      watchedMint +
      "\n\n" +

      "📊 Trades : Anaxer\n" +
      "💧 Liquidité : Helius\n" +
      "🎯 Détection : SELL + chute"
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
    ctx.message.text
      .trim()
      .split(/\s+/);

  const mint =
    parts[1];

  if (!mint) {

    await ctx.reply(
      "❌ Il manque l'adresse du token.\n\n" +
      "Exemple :\n" +
      "/watch ADRESSE_DU_MINT"
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

  /*
   * Réinitialisation complète.
   */

  watchedMint =
    mint;

  lastTradeId =
    null;

  lastTrade =
    null;

  lastSellTrade =
    null;

  lastRealSolReserves =
    null;

  lastLiquidityAlert =
    false;

  lastCrashAlertTime =
    0;

  curveMissingAlertSent =
    false;

  /*
   * Arrêt des anciennes surveillances.
   */

  if (watchInterval) {

    clearInterval(
      watchInterval
    );

    watchInterval =
      null;
  }

  stopHeliusMonitoring();

  await ctx.reply(
    "👁️ <b>Surveillance activée !</b>\n\n" +

    "🪙 Token :\n" +
    "<code>" +
    mint +
    "</code>\n\n" +

    "📊 Trades : toutes les 45 secondes\n" +
    "💧 Liquidité : toutes les 15 secondes\n\n" +

    "🎯 Alerte uniquement si :\n" +
    "• forte baisse de liquidité\n" +
    "• SELL significatif identifié",

    {
      parse_mode: "HTML"
    }
  );

  /*
   * Première vérification immédiate.
   */

  checkTrades();

  watchInterval =
    setInterval(
      checkTrades,
      TRADE_INTERVAL
    );

  startHeliusMonitoring();
});

/* =========================
   UNWATCH
========================= */

bot.command("unwatch", async (ctx) => {

  watchedMint =
    null;

  lastTradeId =
    null;

  lastTrade =
    null;

  lastSellTrade =
    null;

  lastRealSolReserves =
    null;

  lastLiquidityAlert =
    false;

  lastCrashAlertTime =
    0;

  if (watchInterval) {

    clearInterval(
      watchInterval
    );

    watchInterval =
      null;
  }

  stopHeliusMonitoring();

  await ctx.reply(
    "🛑 Surveillance arrêtée.\n\n" +
    "Aucun token n'est actuellement surveillé."
  );
});

/* =========================
   HELIUS : LIQUIDITÉ
========================= */

async function checkLiquidity() {

  if (!watchedMint) {
    return;
  }

  try {

    const mintPublicKey =
      new PublicKey(
        watchedMint
      );

    const programId =
      new PublicKey(
        "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
      );

    /*
     * PDA bonding curve Pump.fun.
     */

    const [
      bondingCurve
    ] =
      PublicKey.findProgramAddressSync(
        [
          Buffer.from(
            "bonding-curve"
          ),

          mintPublicKey.toBuffer()
        ],

        programId
      );

    const response =
      await fetch(
        `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json"
          },

          body: JSON.stringify({

            jsonrpc: "2.0",

            id: 1,

            method:
              "getAccountInfo",

            params: [

              bondingCurve.toBase58(),

              {
                encoding: "base64",

                commitment:
                  "confirmed"
              }
            ]
          })
        }
      );

    if (!response.ok) {

      console.error(
        "🔴 Helius HTTP :",
        response.status
      );

      return;
    }

    const result =
      await response.json();

    const account =
      result.result?.value;

    /*
     * Si la bonding curve n'existe plus,
     * cela peut notamment correspondre
     * à une graduation.
     */

    if (!account) {

      console.log(
        "⚠️ Bonding curve introuvable."
      );

      return;
    }

    const encodedData =
      account.data?.[0];

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
        "⚠️ Données bonding curve trop courtes :",
        buffer.length
      );

      return;
    }

    /*
     * Réserve SOL réelle.
     *
     * Offset Pump.fun :
     * realSolReserves = position 32
     */

    const realSolReserves =
      buffer.readBigUInt64LE(
        32
      );

    const realSol =
      Number(
        realSolReserves
      ) / 1000000000;

    console.log(
      "💧 Liquidité bonding curve :",
      realSol.toFixed(4),
      "SOL"
    );

    /* =========================
       PREMIÈRE MESURE
    ========================= */

    if (
      lastRealSolReserves === null
    ) {

      lastRealSolReserves =
        realSolReserves;

      console.log(
        "🧠 Réserve initiale mémorisée :",
        realSol.toFixed(4),
        "SOL"
      );

      if (
        realSol <= 0.001 &&
        !lastLiquidityAlert
      ) {

        lastLiquidityAlert =
          true;

        await safeTelegramSend(

          "🚨 <b>LIQUIDITÉ À ZÉRO</b>\n\n" +

          "🪙 Token :\n" +
          "<code>" +
          watchedMint +
          "</code>\n\n" +

          "💧 Liquidité : <b>0 SOL</b>\n\n" +

          "⚠️ La bonding curve est vide.",

          {
            parse_mode: "HTML"
          }
        );
      }

      return;
    }

    /* =========================
       CALCUL VARIATION
    ========================= */

    const difference =
      Number(
        realSolReserves -
        lastRealSolReserves
      ) / 1000000000;

    const previousSol =
      Number(
        lastRealSolReserves
      ) / 1000000000;

    const dropPercent =
      previousSol > 0
        ? Math.abs(difference) /
          previousSol *
          100
        : 0;

    if (difference < 0) {

      console.log(
        "📉 Variation :",
        difference.toFixed(4),
        "SOL",
        "(" +
        dropPercent.toFixed(1) +
        "%)"
      );

    } else if (difference > 0) {

      console.log(
        "📈 Variation :",
        difference.toFixed(4),
        "SOL"
      );
    }

    /* =========================
       LIQUIDITÉ À ZÉRO
    ========================= */

    if (
      realSol <= 0.001 &&
      !lastLiquidityAlert
    ) {

      lastLiquidityAlert =
        true;

      await safeTelegramSend(

        "🚨 <b>LIQUIDITÉ À ZÉRO</b>\n\n" +

        "🪙 Token :\n" +
        "<code>" +
        watchedMint +
        "</code>\n\n" +

        "💧 Liquidité bonding curve : <b>0 SOL</b>\n\n" +

        "⚠️ Surveillance immédiate recommandée.",

        {
          parse_mode: "HTML"
        }
      );
    }

    /* =========================
       FORTE BAISSE
    ========================= */

    const strongDrop =
      difference <=
        -MIN_LIQUIDITY_DROP_SOL
      &&
      dropPercent >=
        MIN_LIQUIDITY_DROP_PERCENT;

    if (strongDrop) {

      console.log(
        "🚨 FORTE BAISSE DÉTECTÉE !"
      );

      await sendLiquidityCrashAlert(
        realSol,
        difference,
        previousSol
      );
    }

    /* =========================
       RÉARMEMENT
    ========================= */

    if (
      realSol > 0.001
    ) {

      lastLiquidityAlert =
        false;
    }

    /*
     * On mémorise la nouvelle réserve
     * pour la prochaine comparaison.
     */

    lastRealSolReserves =
      realSolReserves;

  } catch (error) {

    console.error(
      "🔴 Erreur vérification liquidité :",
      error.message
    );
  }
}

/* =========================
   DÉMARRAGE HELIUS
========================= */

function startHeliusMonitoring() {

  if (!watchedMint) {
    return;
  }

  if (liquidityInterval) {

    clearInterval(
      liquidityInterval
    );

    liquidityInterval =
      null;
  }

  lastRealSolReserves =
    null;

  lastLiquidityAlert =
    false;

  console.log(
    "💧 Surveillance directe Helius activée"
  );

  /*
   * Vérification immédiate.
   */

  checkLiquidity();

  /*
   * Puis toutes les 15 secondes.
   */

  liquidityInterval =
    setInterval(
      checkLiquidity,
      LIQUIDITY_INTERVAL
    );
}

/* =========================
   ARRÊT HELIUS
========================= */

function stopHeliusMonitoring() {

  if (liquidityInterval) {

    clearInterval(
      liquidityInterval
    );

    liquidityInterval =
      null;
  }

  lastRealSolReserves =
    null;

  lastLiquidityAlert =
    false;

  console.log(
    "🛑 Surveillance liquidité arrêtée"
  );
}

/* =========================
   DÉMARRAGE BOT
========================= */

bot.launch();

console.log(
  "🤖 Pump Alert Bot démarré"
);

/* =========================
   ARRÊT PROPRE
========================= */

process.once(
  "SIGINT",
  () => {

    stopHeliusMonitoring();

    bot.stop(
      "SIGINT"
    );
  }
);

process.once(
  "SIGTERM",
  () => {

    stopHeliusMonitoring();

    bot.stop(
      "SIGTERM"
    );
  }
);
