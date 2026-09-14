const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN ou CHAT_ID manquant");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

/* =========================================================
   CONFIGURATION V4 TEST
   ========================================================= */

const CAPITAL_PER_CYCLE_USD = 10.00;
const TARGET_NET_PERCENT = 5.00;

const POLL_INTERVAL_MS = 2000;

const ENTRY_COOLDOWN_MS = 30000;

// Il faut plusieurs confirmations favorables
const REQUIRED_HEALTHY_READINGS = 4;

// Historique local
const HISTORY_MS = 120000;

// Liquidité minimale
const MIN_LIQUIDITY_USD = 3000;

// =========================================================
// SEUILS D'ENTRÉE
// =========================================================

const ENTRY_MAX_PRICE_DROP_10S = -4;
const ENTRY_MAX_LIQ_DROP_10S = -10;
const ENTRY_MAX_LIQ_DROP_30S = -15;

// Score minimum
const MIN_ENTRY_SCORE = 80;

// =========================================================
// SEUILS CRASH
// =========================================================

const CRASH_PRICE_DROP_10S = -20;
const CRASH_LIQ_DROP_10S = -50;
const CRASH_MIN_LIQUIDITY_USD = 1;

// =========================================================
// PUMP SWAP
// =========================================================

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

/* =========================================================
   ÉTAT
   ========================================================= */

let running = false;
let crashed = false;

let currentToken = null;

let position = null;

let cycleNumber = 0;
let completedCycles = 0;

let cumulativeProfit = 0;

let history = [];

let cooldownUntil = 0;

let healthyReadings = 0;

let lastEntryWarning = 0;

let pollTimer = null;

let heliusWs = null;

let heliusConnected = false;

let onchainStats = {
  buys: 0,
  sells: 0,
  buyVolumeSol: 0,
  sellVolumeSol: 0,
  lastActivity: 0
};

/* =========================================================
   TELEGRAM
   ========================================================= */

async function sendTelegram(message) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      message
    );
  } catch (err) {
    console.error(
      "Erreur Telegram :",
      err.message
    );
  }
}

/* =========================================================
   OUTILS
   ========================================================= */

function now() {
  return Date.now();
}

function shortToken(mint) {
  if (!mint) return "???";

  return (
    mint.slice(0, 6) +
    "..." +
    mint.slice(-6)
  );
}

function percentageChange(current, old) {

  if (
    old === null ||
    old === undefined ||
    !Number.isFinite(old) ||
    old === 0
  ) {
    return null;
  }

  return (
    ((current - old) / old) *
    100
  );
}

/* =========================================================
   DEXSCREENER
   ========================================================= */

async function getTokenData(mint) {

  try {

    const response =
      await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data.pairs ||
      data.pairs.length === 0
    ) {
      return null;
    }

    // PumpSwap prioritaire
    const pumpPair =
      data.pairs.find(pair =>
        pair.dexId &&
        pair.dexId
          .toLowerCase()
          .includes("pump")
      );

    const pair =
      pumpPair || data.pairs[0];

    const price =
      Number(pair.priceUsd);

    const liquidity =
      Number(pair.liquidity?.usd);

    const volume24h =
      Number(pair.volume?.h24 || 0);

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return null;
    }

    if (
      !Number.isFinite(liquidity)
    ) {
      return null;
    }

    return {
      price,
      liquidity,
      volume24h,
      dexId:
        pair.dexId || "unknown",
      pairAddress:
        pair.pairAddress || null
    };

  } catch (err) {

    console.error(
      "DexScreener :",
      err.message
    );

    return null;
  }
}

/* =========================================================
   HISTORIQUE
   ========================================================= */

function addHistory(data) {

  history.push({
    timestamp: now(),
    price: data.price,
    liquidity: data.liquidity
  });

  const cutoff =
    now() - HISTORY_MS;

  history =
    history.filter(
      item =>
        item.timestamp >= cutoff
    );
}

function getValueAgo(
  field,
  milliseconds
) {

  const target =
    now() - milliseconds;

  let candidate = null;

  for (
    const item of history
  ) {

    if (
      item.timestamp <= target
    ) {
      candidate = item;
    }
  }

  return candidate
    ? candidate[field]
    : null;
}

function getMetrics(data) {

  const price10 =
    getValueAgo(
      "price",
      10000
    );

  const liq10 =
    getValueAgo(
      "liquidity",
      10000
    );

  const liq30 =
    getValueAgo(
      "liquidity",
      30000
    );

  return {

    price10s:
      percentageChange(
        data.price,
        price10
      ),

    liquidity10s:
      percentageChange(
        data.liquidity,
        liq10
      ),

    liquidity30s:
      percentageChange(
        data.liquidity,
        liq30
      )
  };
}

/* =========================================================
   SCORE DE SANTÉ
   ========================================================= */

function calculateHealthScore(data) {

  const metrics =
    getMetrics(data);

  let score = 100;

  const reasons = [];

  // -------------------------------------------------------
  // LIQUIDITÉ
  // -------------------------------------------------------

  if (
    data.liquidity < MIN_LIQUIDITY_USD
  ) {

    score -= 30;

    reasons.push(
      "liquidité faible"
    );
  }

  if (
    metrics.liquidity10s !== null
  ) {

    if (
      metrics.liquidity10s <= -20
    ) {

      score -= 35;

      reasons.push(
        `liquidité ${metrics.liquidity10s.toFixed(1)}% / 10s`
      );

    } else if (
      metrics.liquidity10s <= -10
    ) {

      score -= 20;

      reasons.push(
        `liquidité ${metrics.liquidity10s.toFixed(1)}% / 10s`
      );

    } else if (
      metrics.liquidity10s >= 5
    ) {

      score += 5;
    }
  }

  // -------------------------------------------------------
  // LIQUIDITÉ 30s
  // -------------------------------------------------------

  if (
    metrics.liquidity30s !== null
  ) {

    if (
      metrics.liquidity30s <= -25
    ) {

      score -= 30;

      reasons.push(
        `liquidité ${metrics.liquidity30s.toFixed(1)}% / 30s`
      );

    } else if (
      metrics.liquidity30s <= -15
    ) {

      score -= 15;
    }
  }

  // -------------------------------------------------------
  // PRIX
  // -------------------------------------------------------

  if (
    metrics.price10s !== null
  ) {

    if (
      metrics.price10s <= -10
    ) {

      score -= 30;

      reasons.push(
        `prix ${metrics.price10s.toFixed(1)}% / 10s`
      );

    } else if (
      metrics.price10s <= -4
    ) {

      score -= 15;

      reasons.push(
        `prix ${metrics.price10s.toFixed(1)}% / 10s`
      );

    } else if (
      metrics.price10s > 2
    ) {

      score += 5;
    }
  }

  // -------------------------------------------------------
  // ACTIVITÉ ON-CHAIN
  // -------------------------------------------------------

  const buys =
    onchainStats.buys;

  const sells =
    onchainStats.sells;

  if (
    buys > 0 ||
    sells > 0
  ) {

    if (
      buys > sells
    ) {

      score += 10;

    } else if (
      sells > buys * 1.5
    ) {

      score -= 20;

      reasons.push(
        "pression vendeuse élevée"
      );
    }
  }

  // -------------------------------------------------------
  // ABSENCE D'ACTIVITÉ
  // -------------------------------------------------------

  if (
    onchainStats.lastActivity > 0
  ) {

    const age =
      now() -
      onchainStats.lastActivity;

    if (
      age > 30000
    ) {

      score -= 5;
    }
  }

  // Bornes
  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  return {
    score,
    reasons,
    metrics
  };
}

/* =========================================================
   CRASH
   ========================================================= */

function analyzeCrash(data) {

  const metrics =
    getMetrics(data);

  const reasons = [];

  if (
    data.liquidity <=
    CRASH_MIN_LIQUIDITY_USD
  ) {

    reasons.push(
      "liquidité quasi nulle"
    );
  }

  if (
    metrics.liquidity10s !== null &&
    metrics.liquidity10s <=
      CRASH_LIQ_DROP_10S
  ) {

    reasons.push(
      `liquidité ${metrics.liquidity10s.toFixed(2)}% / 10s`
    );
  }

  if (
    metrics.price10s !== null &&
    metrics.price10s <=
      CRASH_PRICE_DROP_10S
  ) {

    reasons.push(
      `prix ${metrics.price10s.toFixed(2)}% / 10s`
    );
  }

  return {
    crash:
      reasons.length > 0,

    reasons,

    metrics
  };
}

/* =========================================================
   HELIUS WEBSOCKET
   ========================================================= */

function connectHelius() {

  if (!HELIUS_API_KEY) {

    console.log(
      "⚠️ HELIUS_API_KEY absente"
    );

    return;
  }

  if (!currentToken) {
    return;
  }

  try {

    if (heliusWs) {
      try {
        heliusWs.close();
      } catch {}
    }

    const url =
      `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

    heliusWs =
      new WebSocket(url);

    heliusWs.on(
      "open",
      () => {

        heliusConnected = true;

        console.log(
          "🟢 Helius WSS connecté"
        );

        /*
         * On écoute les transactions PumpSwap.
         *
         * L'objectif V4 est d'obtenir un signal
         * supplémentaire d'activité on-chain.
         */

        heliusWs.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
              {
                mentions: [
                  PUMPSWAP_PROGRAM
                ]
              },
              {
                commitment: "processed"
              }
            ]
          })
        );
      }
    );

    heliusWs.on(
      "message",
      raw => {

        try {

          const msg =
            JSON.parse(
              raw.toString()
            );

          if (
            !msg.params ||
            !msg.params.result
          ) {
            return;
          }

          const value =
            msg.params.result.value;

          if (!value) {
            return;
          }

          const logs =
            value.logs || [];

          /*
           * On utilise les logs uniquement
           * comme indicateur d'activité.
           *
           * On ne prétend PAS décoder ici
           * BUY/SELL avec certitude.
           */

          const text =
            logs.join(" ").toLowerCase();

          onchainStats.lastActivity =
            now();

          if (
            text.includes("buy")
          ) {

            onchainStats.buys++;

          } else if (
            text.includes("sell")
          ) {

            onchainStats.sells++;

          }

          // Empêche les compteurs de grossir
          // indéfiniment
          if (
            onchainStats.buys +
            onchainStats.sells >
            100
          ) {

            onchainStats.buys =
              Math.floor(
                onchainStats.buys / 2
              );

            onchainStats.sells =
              Math.floor(
                onchainStats.sells / 2
              );
          }

        } catch (err) {

          console.error(
            "Helius message :",
            err.message
          );
        }
      }
    );

    heliusWs.on(
      "close",
      () => {

        heliusConnected = false;

        console.log(
          "🔴 Helius WSS déconnecté"
        );

        if (running) {

          setTimeout(
            () => {

              if (running) {
                connectHelius();
              }

            },
            5000
          );
        }
      }
    );

    heliusWs.on(
      "error",
      err => {

        console.error(
          "Helius WSS :",
          err.message
        );
      }
    );

  } catch (err) {

    console.error(
      "Erreur Helius :",
      err.message
    );
  }
}

/* =========================================================
   ACHAT TEST
   ========================================================= */

async function simulatedBuy(
  data,
  health
) {

  cycleNumber++;

  const amount =
    CAPITAL_PER_CYCLE_USD;

  const tokens =
    amount / data.price;

  const targetPrice =
    data.price *
    (
      1 +
      TARGET_NET_PERCENT / 100
    );

  position = {

    cycle:
      cycleNumber,

    invested:
      amount,

    entryPrice:
      data.price,

    tokens,

    targetPrice,

    entryLiquidity:
      data.liquidity
  };

  await sendTelegram(
`🟢 ACHAT TEST #${cycleNumber}

Token : ${shortToken(currentToken)}

Mise fixe : $${amount.toFixed(4)}

Prix : $${data.price.toFixed(8)}

Tokens : ${tokens.toFixed(8)}

🎯 Objectif :
+${TARGET_NET_PERCENT.toFixed(2)}%

Prix cible :
$${targetPrice.toFixed(8)}

💧 Liquidité :
$${data.liquidity.toFixed(2)}

🧠 SCORE DE SANTÉ :
${health.score}/100

🛡️ Entrée confirmée :
${REQUIRED_HEALTHY_READINGS}/${REQUIRED_HEALTHY_READINGS}

⛓️ Helius :
${heliusConnected ? "🟢 connecté" : "🟠 non connecté"}`
  );
}

/* =========================================================
   VENTE TEST
   ========================================================= */

async function simulatedSell() {

  if (!position) {
    return;
  }

  // Prix cible exact
  const executionPrice =
    position.targetPrice;

  const amountReceived =
    position.tokens *
    executionPrice;

  const profit =
    amountReceived -
    position.invested;

  const percent =
    (
      profit /
      position.invested
    ) * 100;

  cumulativeProfit +=
    profit;

  completedCycles++;

  const cycle =
    position.cycle;

  position = null;

  cooldownUntil =
    now() +
    ENTRY_COOLDOWN_MS;

  healthyReadings = 0;

  await sendTelegram(
`🔴 VENTE TEST #${cycle}

Token : ${shortToken(currentToken)}

Prix de vente :
$${executionPrice.toFixed(8)}

Montant simulé :
$${amountReceived.toFixed(4)}

Résultat :
+${percent.toFixed(2)}%

Bénéfice réalisé :
$${profit.toFixed(4)}

💰 Bénéfices cumulés :
$${cumulativeProfit.toFixed(4)}

🛡️ NOUVELLE PHASE DE SÉCURITÉ

⏳ Observation :
30 secondes minimum

❌ Aucun rachat immédiat.`
  );
}

/* =========================================================
   STOP CRASH
   ========================================================= */

async function emergencyStop(
  data,
  crash
) {

  if (crashed) {
    return;
  }

  crashed = true;
  running = false;

  if (pollTimer) {

    clearInterval(
      pollTimer
    );

    pollTimer = null;
  }

  if (heliusWs) {

    try {
      heliusWs.close();
    } catch {}
  }

  let positionText;

  if (position) {

    positionText =
`⚠️ Position restante :
${position.tokens.toFixed(8)} tokens

⚠️ Prix de sortie NON considéré fiable.
⚠️ Aucun bénéfice fictif ajouté.`;

  } else {

    positionText =
      "✅ Aucune position ouverte.";
  }

  await sendTelegram(
`🚨 STOP CRASH - MODE TEST V4

Token :
${shortToken(currentToken)}

Prix :
$${data.price.toFixed(8)}

Variation prix ~10s :
${
  crash.metrics.price10s !== null
    ? crash.metrics.price10s.toFixed(2) + "%"
    : "N/D"
}

Liquidité :
$${data.liquidity.toFixed(2)}

Variation liquidité ~10s :
${
  crash.metrics.liquidity10s !== null
    ? crash.metrics.liquidity10s.toFixed(2) + "%"
    : "N/D"
}

⚠️ Signaux :
• ${crash.reasons.join("\n• ")}

${positionText}

⛔ NOUVEAU CYCLE BLOQUÉ
⛔ RADAR ARRÊTÉ

Cycles terminés :
${completedCycles}

💰 Bénéfices simulés :
$${cumulativeProfit.toFixed(4)}

⚠️ Simulation uniquement.`
  );
}

/* =========================================================
   TEST D'ENTRÉE
   ========================================================= */

async function tryEntry(
  data
) {

  if (!running || crashed) {
    return;
  }

  if (position) {
    return;
  }

  // Cooldown
  if (
    now() <
    cooldownUntil
  ) {
    return;
  }

  const health =
    calculateHealthScore(data);

  /*
   * Si le score est insuffisant,
   * on remet le compteur à zéro.
   */

  if (
    health.score <
    MIN_ENTRY_SCORE
  ) {

    healthyReadings = 0;

    if (
      now() -
      lastEntryWarning >
      10000
    ) {

      lastEntryWarning =
        now();

      await sendTelegram(
`🟠 ACHAT REFUSÉ

Token :
${shortToken(currentToken)}

🧠 Score santé :
${health.score}/100

🎯 Minimum requis :
${MIN_ENTRY_SCORE}/100

⚠️ Signaux :
${
  health.reasons.length
    ? "• " +
      health.reasons.join(
        "\n• "
      )
    : "• conditions insuffisantes"
}

⏳ Le bot continue d'observer.`
      );
    }

    return;
  }

  /*
   * Score suffisant.
   *
   * Mais on exige plusieurs lectures
   * consécutives favorables.
   */

  healthyReadings++;

  if (
    healthyReadings <
    REQUIRED_HEALTHY_READINGS
  ) {

    if (
      healthyReadings === 1
    ) {

      await sendTelegram(
`🟡 MARCHÉ FAVORABLE

Score :
${health.score}/100

Confirmation :
1/${REQUIRED_HEALTHY_READINGS}

⏳ Pas encore d'achat.

Le bot veut confirmer que la situation reste saine.`
      );
    }

    return;
  }

  await simulatedBuy(
    data,
    health
  );

  healthyReadings = 0;
}

/* =========================================================
   MONITORING
   ========================================================= */

async function monitor() {

  if (
    !running ||
    crashed ||
    !currentToken
  ) {
    return;
  }

  const data =
    await getTokenData(
      currentToken
    );

  if (!data) {
    return;
  }

  addHistory(data);

  // -------------------------------------------------------
  // CRASH
  // -------------------------------------------------------

  const crash =
    analyzeCrash(data);

  if (crash.crash) {

    await emergencyStop(
      data,
      crash
    );

    return;
  }

  // -------------------------------------------------------
  // POSITION OUVERTE
  // -------------------------------------------------------

  if (position) {

    if (
      data.price >=
      position.targetPrice
    ) {

      await simulatedSell();
    }

    return;
  }

  // -------------------------------------------------------
  // NOUVELLE ENTRÉE
  // -------------------------------------------------------

  await tryEntry(data);
}

/* =========================================================
   START
   ========================================================= */

async function startTrade(
  mint
) {

  if (running) {

    await sendTelegram(
      "⚠️ Un test est déjà en cours."
    );

    return;
  }

  if (!mint) {

    await sendTelegram(
`❌ Mint manquant.

Utilisation :

/starttrade ADRESSE_DU_TOKEN`
    );

    return;
  }

  currentToken =
    mint.trim();

  running = true;
  crashed = false;

  position = null;

  cycleNumber = 0;
  completedCycles = 0;

  cumulativeProfit = 0;

  history = [];

  cooldownUntil = 0;

  healthyReadings = 0;

  lastEntryWarning = 0;

  onchainStats = {
    buys: 0,
    sells: 0,
    buyVolumeSol: 0,
    sellVolumeSol: 0,
    lastActivity: 0
  };

  await sendTelegram(
`🚀 TEST V4 DÉMARRÉ

Token :
${shortToken(currentToken)}

💵 Capital :
$${CAPITAL_PER_CYCLE_USD.toFixed(2)}

🎯 Objectif :
+${TARGET_NET_PERCENT.toFixed(2)}%

⏳ Cooldown :
${ENTRY_COOLDOWN_MS / 1000}s

🧠 Score minimum :
${MIN_ENTRY_SCORE}/100

🛡️ Confirmations nécessaires :
${REQUIRED_HEALTHY_READINGS}

📡 Sources :
• DEX Screener
• Helius on-chain

⛔ Crash = arrêt définitif

⚠️ Simulation uniquement.`
  );

  connectHelius();

  pollTimer =
    setInterval(
      monitor,
      POLL_INTERVAL_MS
    );

  await monitor();
}

/* =========================================================
   STOP
   ========================================================= */

async function stopTrade() {

  if (!running) {

    await sendTelegram(
      "ℹ️ Aucun test en cours."
    );

    return;
  }

  running = false;

  if (pollTimer) {

    clearInterval(
      pollTimer
    );

    pollTimer = null;
  }

  if (heliusWs) {

    try {
      heliusWs.close();
    } catch {}
  }

  await sendTelegram(
`🛑 TEST ARRÊTÉ

Cycles terminés :
${completedCycles}

💰 Bénéfices :
$${cumulativeProfit.toFixed(4)}

${
  position
    ? "⚠️ Position simulée encore ouverte."
    : "✅ Aucune position."
}`
  );
}

/* =========================================================
   STATUS
   ========================================================= */

async function status() {

  if (!currentToken) {

    await sendTelegram(
      "ℹ️ Aucun token chargé."
    );

    return;
  }

  const positionText =
    position
      ? `Position #${position.cycle}
Entrée : $${position.entryPrice.toFixed(8)}
Cible : $${position.targetPrice.toFixed(8)}
Mise : $${position.invested.toFixed(2)}`
      : "Aucune position";

  await sendTelegram(
`📊 STATUS V4

Token :
${shortToken(currentToken)}

Radar :
${running ? "🟢 ACTIF" : "🔴 ARRÊTÉ"}

Helius :
${heliusConnected ? "🟢 connecté" : "🔴 déconnecté"}

Cycles :
${completedCycles}

💰 Bénéfices :
$${cumulativeProfit.toFixed(4)}

🧠 Confirmations :
${healthyReadings}/${REQUIRED_HEALTHY_READINGS}

⛓️ Activité :
${onchainStats.buys} achats détectés
${onchainStats.sells} ventes détectées

${positionText}`
  );
}

/* =========================================================
   HELP
   ========================================================= */

async function help() {

  await sendTelegram(
`🤖 TEST V4

/starttrade MINT
➡️ démarre un test

/status
➡️ état du bot

/stoptrade
➡️ arrête le test

💵 Capital :
$10 par cycle

🎯 Objectif :
+5%

🧠 Score santé :
minimum 80/100

⏳ Après chaque vente :
30 secondes minimum

🛡️ Avant chaque achat :
4 confirmations favorables

📡 Sources :
DEX Screener + Helius

⚠️ Simulation uniquement.`
  );
}

/* =========================================================
   COMMANDES
   ========================================================= */

bot.command(
  "starttrade",
  async ctx => {

    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    await startTrade(
      parts[1]
    );
  }
);

bot.command(
  "status",
  async () => {
    await status();
  }
);

bot.command(
  "stoptrade",
  async () => {
    await stopTrade();
  }
);

bot.command(
  "help",
  async () => {
    await help();
  }
);

/* =========================================================
   LANCEMENT
   ========================================================= */

bot.launch()
  .then(() => {

    console.log(
      "🤖 Bot Telegram TEST V4 démarré"
    );

  })
  .catch(err => {

    console.error(
      "Erreur lancement bot :",
      err.message
    );

  });

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
