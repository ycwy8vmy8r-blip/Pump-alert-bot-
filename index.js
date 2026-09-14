const { Telegraf } = require("telegraf");
const fetch = global.fetch;

/* =========================================================
   CONFIGURATION
   ========================================================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN ou CHAT_ID manquant");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ===== STRATÉGIE TEST =====
const CAPITAL_PER_CYCLE_USD = 10.00;
const TARGET_NET_PERCENT = 5.00;

// ===== SURVEILLANCE =====
const POLL_INTERVAL_MS = 2000;
const HISTORY_MS = 120000;

// Temps minimum d'observation après une vente
const ENTRY_COOLDOWN_MS = 15000;

// ===== FILTRES D'ENTRÉE =====

// On refuse une entrée si la liquidité baisse trop vite
const ENTRY_MAX_LIQ_DROP_10S = -12;

// On refuse une entrée si le prix baisse trop vite
const ENTRY_MAX_PRICE_DROP_10S = -5;

// On refuse une entrée si la liquidité baisse fortement
// sur une fenêtre plus longue
const ENTRY_MAX_LIQ_DROP_30S = -20;

// Liquidité minimale absolue
const MIN_LIQUIDITY_USD = 3000;

// ===== CRASH =====

const CRASH_LIQ_DROP_10S = -50;
const CRASH_PRICE_DROP_10S = -20;
const CRASH_MIN_LIQUIDITY_USD = 1;

// =========================================================
// ÉTAT DU BOT
// =========================================================

let running = false;
let crashed = false;

let currentToken = null;

let position = null;

let cycleNumber = 0;
let completedCycles = 0;

let cumulativeProfit = 0;

let lastPrice = null;
let lastLiquidity = null;

let history = [];

let cooldownUntil = 0;

let pollTimer = null;

/* =========================================================
   OUTILS
   ========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shortToken(mint) {
  if (!mint) return "???";
  return mint.slice(0, 6) + "..." + mint.slice(-6);
}

function now() {
  return Date.now();
}

async function sendTelegram(message) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, message);
  } catch (err) {
    console.error("Erreur Telegram :", err.message);
  }
}

/* =========================================================
   DEXSCREENER
   ========================================================= */

async function getTokenData(mint) {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );

    if (!response.ok) {
      throw new Error(`DexScreener HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.pairs || data.pairs.length === 0) {
      return null;
    }

    // On privilégie PumpSwap
    let pair =
      data.pairs.find(p => {
        return (
          p.dexId &&
          p.dexId.toLowerCase().includes("pump")
        );
      }) || data.pairs[0];

    const price = Number(pair.priceUsd);
    const liquidity = Number(pair.liquidity?.usd);

    if (!Number.isFinite(price) || price <= 0) {
      return null;
    }

    if (!Number.isFinite(liquidity)) {
      return null;
    }

    return {
      price,
      liquidity,
      dexId: pair.dexId || "unknown",
      pairAddress: pair.pairAddress || null
    };

  } catch (err) {
    console.error("DexScreener :", err.message);
    return null;
  }
}

/* =========================================================
   HISTORIQUE
   ========================================================= */

function addHistory(data) {
  const timestamp = now();

  history.push({
    timestamp,
    price: data.price,
    liquidity: data.liquidity
  });

  const cutoff = timestamp - HISTORY_MS;

  history = history.filter(x => x.timestamp >= cutoff);
}

function getValueAgo(field, milliseconds) {
  const target = now() - milliseconds;

  let candidate = null;

  for (const item of history) {
    if (item.timestamp <= target) {
      candidate = item;
    }
  }

  return candidate ? candidate[field] : null;
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

  return ((current - old) / old) * 100;
}

function getMetrics(data) {
  const liq10 = getValueAgo("liquidity", 10000);
  const liq30 = getValueAgo("liquidity", 30000);
  const price10 = getValueAgo("price", 10000);

  return {
    liquidity10s: percentageChange(
      data.liquidity,
      liq10
    ),

    liquidity30s: percentageChange(
      data.liquidity,
      liq30
    ),

    price10s: percentageChange(
      data.price,
      price10
    )
  };
}

/* =========================================================
   ANALYSE DU MARCHÉ
   ========================================================= */

function analyzeEntry(data) {
  const metrics = getMetrics(data);

  const reasons = [];

  if (data.liquidity < MIN_LIQUIDITY_USD) {
    reasons.push(
      `liquidité trop faible : $${data.liquidity.toFixed(2)}`
    );
  }

  if (
    metrics.liquidity10s !== null &&
    metrics.liquidity10s <= ENTRY_MAX_LIQ_DROP_10S
  ) {
    reasons.push(
      `liquidité ${metrics.liquidity10s.toFixed(2)}% / 10s`
    );
  }

  if (
    metrics.liquidity30s !== null &&
    metrics.liquidity30s <= ENTRY_MAX_LIQ_DROP_30S
  ) {
    reasons.push(
      `liquidité ${metrics.liquidity30s.toFixed(2)}% / 30s`
    );
  }

  if (
    metrics.price10s !== null &&
    metrics.price10s <= ENTRY_MAX_PRICE_DROP_10S
  ) {
    reasons.push(
      `prix ${metrics.price10s.toFixed(2)}% / 10s`
    );
  }

  // Il faut suffisamment de données pour éviter
  // d'acheter immédiatement sur une information incomplète.
  const enoughHistory =
    history.length >= 8;

  if (!enoughHistory) {
    reasons.push("historique encore insuffisant");
  }

  return {
    healthy: reasons.length === 0,
    reasons,
    metrics
  };
}

/* =========================================================
   CRASH
   ========================================================= */

function analyzeCrash(data) {
  const metrics = getMetrics(data);

  const reasons = [];

  if (data.liquidity <= CRASH_MIN_LIQUIDITY_USD) {
    reasons.push(
      `liquidité quasi nulle : $${data.liquidity.toFixed(2)}`
    );
  }

  if (
    metrics.liquidity10s !== null &&
    metrics.liquidity10s <= CRASH_LIQ_DROP_10S
  ) {
    reasons.push(
      `liquidité ${metrics.liquidity10s.toFixed(2)}% / 10s`
    );
  }

  if (
    metrics.price10s !== null &&
    metrics.price10s <= CRASH_PRICE_DROP_10S
  ) {
    reasons.push(
      `prix ${metrics.price10s.toFixed(2)}% / 10s`
    );
  }

  return {
    crash: reasons.length > 0,
    reasons,
    metrics
  };
}

/* =========================================================
   ACHAT TEST
   ========================================================= */

async function simulatedBuy(data) {

  cycleNumber++;

  const amount = CAPITAL_PER_CYCLE_USD;

  const tokens = amount / data.price;

  const targetPrice =
    data.price *
    (1 + TARGET_NET_PERCENT / 100);

  position = {
    cycle: cycleNumber,
    invested: amount,
    entryPrice: data.price,
    tokens,
    targetPrice,
    entryLiquidity: data.liquidity
  };

  await sendTelegram(
`🟢 ACHAT TEST #${cycleNumber}

Token : ${shortToken(currentToken)}

Mise fixe : $${amount.toFixed(4)}
Prix simulé : $${data.price.toFixed(8)}
Tokens : ${tokens.toFixed(8)}

🎯 Objectif : +${TARGET_NET_PERCENT.toFixed(2)}%
Prix cible : $${targetPrice.toFixed(8)}

💧 Liquidité : $${data.liquidity.toFixed(2)}

🛡️ Filtre d'entrée : OK`
  );
}

/* =========================================================
   VENTE TEST
   ========================================================= */

async function simulatedSell() {

  if (!position) return;

  /*
    IMPORTANT :

    On vend au prix cible exact.

    Cela évite de transformer un polling toutes les 2 secondes
    en bénéfice artificiellement supérieur à l'objectif.
  */

  const executionPrice = position.targetPrice;

  const amountReceived =
    position.tokens * executionPrice;

  const profit =
    amountReceived - position.invested;

  const percent =
    (profit / position.invested) * 100;

  cumulativeProfit += profit;
  completedCycles++;

  const cycle = position.cycle;

  position = null;

  cooldownUntil =
    now() + ENTRY_COOLDOWN_MS;

  await sendTelegram(
`🔴 VENTE TEST #${cycle}

Token : ${shortToken(currentToken)}

Prix de vente : $${executionPrice.toFixed(8)}

Montant simulé : $${amountReceived.toFixed(4)}

Résultat : +${percent.toFixed(2)}%
Bénéfice réalisé : $${profit.toFixed(4)}

💰 Bénéfices cumulés : $${cumulativeProfit.toFixed(4)}

⏳ PAUSE AVANT NOUVEL ACHAT
Observation du marché pendant ${ENTRY_COOLDOWN_MS / 1000}s`
  );
}

/* =========================================================
   STOP CRASH
   ========================================================= */

async function emergencyStop(data, crashAnalysis) {

  if (crashed) return;

  crashed = true;
  running = false;

  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  let positionMessage = "";

  if (position) {

    positionMessage =
`⚠️ Position restante :
${position.tokens.toFixed(8)} tokens

⚠️ Prix de sortie NON considéré fiable.
⚠️ Aucun bénéfice fictif ajouté.`;

  } else {

    positionMessage =
`✅ Aucune position ouverte au moment du crash.`;
  }

  await sendTelegram(
`🚨 STOP CRASH - MODE TEST

Token : ${shortToken(currentToken)}

Prix : $${data.price.toFixed(8)}

Variation prix ~10s :
${crashAnalysis.metrics.price10s !== null
  ? crashAnalysis.metrics.price10s.toFixed(2) + "%"
  : "N/D"}

Liquidité :
$${data.liquidity.toFixed(2)}

Variation liquidité ~10s :
${crashAnalysis.metrics.liquidity10s !== null
  ? crashAnalysis.metrics.liquidity10s.toFixed(2) + "%"
  : "N/D"}

⚠️ Signaux :
• ${crashAnalysis.reasons.join("\n• ")}

${positionMessage}

⛔ NOUVEAU CYCLE BLOQUÉ
⛔ RADAR ARRÊTÉ

Cycles terminés : ${completedCycles}

💰 Bénéfices réellement simulés :
$${cumulativeProfit.toFixed(4)}

⚠️ Ceci reste une simulation.`
  );
}

/* =========================================================
   AUTORISATION D'ACHAT
   ========================================================= */

async function tryEntry(data) {

  if (!running || crashed) return;

  if (position) return;

  // Cooldown après vente
  if (now() < cooldownUntil) {
    return;
  }

  const analysis = analyzeEntry(data);

  if (!analysis.healthy) {

    // On évite de spammer Telegram à chaque passage.
    if (!tryEntry.lastWarning ||
        now() - tryEntry.lastWarning > 10000) {

      tryEntry.lastWarning = now();

      await sendTelegram(
`⛔ ACHAT REFUSÉ

Token : ${shortToken(currentToken)}

Le marché n'est pas suffisamment sain.

⚠️ Raisons :
• ${analysis.reasons.join("\n• ")}

💧 Liquidité :
$${data.liquidity.toFixed(2)}

📊 Prix :
$${data.price.toFixed(8)}

⏳ Surveillance en cours...`
      );
    }

    return;
  }

  await simulatedBuy(data);
}

/* =========================================================
   BOUCLE PRINCIPALE
   ========================================================= */

async function monitor() {

  if (!running || crashed || !currentToken) {
    return;
  }

  const data =
    await getTokenData(currentToken);

  if (!data) {
    return;
  }

  addHistory(data);

  lastPrice = data.price;
  lastLiquidity = data.liquidity;

  // =========================================
  // CRASH PRIORITAIRE
  // =========================================

  const crashAnalysis =
    analyzeCrash(data);

  if (crashAnalysis.crash) {

    await emergencyStop(
      data,
      crashAnalysis
    );

    return;
  }

  // =========================================
  // POSITION OUVERTE
  // =========================================

  if (position) {

    if (
      data.price >= position.targetPrice
    ) {
      await simulatedSell();
    }

    return;
  }

  // =========================================
  // PAS DE POSITION
  // =========================================

  await tryEntry(data);
}

/* =========================================================
   START TRADE
   ========================================================= */

async function startTrade(mint) {

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

  currentToken = mint.trim();

  running = true;
  crashed = false;

  position = null;

  cycleNumber = 0;
  completedCycles = 0;
  cumulativeProfit = 0;

  history = [];

  lastPrice = null;
  lastLiquidity = null;

  cooldownUntil = 0;

  tryEntry.lastWarning = 0;

  await sendTelegram(
`🚀 TEST V3 DÉMARRÉ

Token :
${shortToken(currentToken)}

💵 Capital par cycle :
$${CAPITAL_PER_CYCLE_USD.toFixed(2)}

🎯 Objectif :
+${TARGET_NET_PERCENT.toFixed(2)}%

⏳ Cooldown après vente :
${ENTRY_COOLDOWN_MS / 1000}s

🛡️ Nouveau filtre :
Le bot ne rachète PAS automatiquement.

Il attend que le marché soit suffisamment sain.

⛔ Crash :
arrêt définitif du test.

📡 Surveillance en cours...`
  );

  pollTimer =
    setInterval(
      monitor,
      POLL_INTERVAL_MS
    );

  // Premier passage immédiat
  await monitor();
}

/* =========================================================
   STOP MANUEL
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
    clearInterval(pollTimer);
    pollTimer = null;
  }

  await sendTelegram(
`🛑 TEST ARRÊTÉ MANUELLEMENT

Cycles terminés :
${completedCycles}

💰 Bénéfices simulés :
$${cumulativeProfit.toFixed(4)}

${position
  ? "⚠️ Une position simulée était encore ouverte."
  : "✅ Aucune position ouverte."}`
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

  let positionText =
    "Aucune position";

  if (position) {
    positionText =
`Position #${position.cycle}
Mise : $${position.invested.toFixed(2)}
Entrée : $${position.entryPrice.toFixed(8)}
Cible : $${position.targetPrice.toFixed(8)}`
  }

  await sendTelegram(
`📊 STATUS TEST V3

Token :
${shortToken(currentToken)}

Radar :
${running ? "🟢 ACTIF" : "🔴 ARRÊTÉ"}

Cycles terminés :
${completedCycles}

💰 Bénéfices :
$${cumulativeProfit.toFixed(4)}

${positionText}

💵 Capital/cycle :
$${CAPITAL_PER_CYCLE_USD.toFixed(2)}

🎯 Objectif :
+${TARGET_NET_PERCENT.toFixed(2)}%`
  );
}

/* =========================================================
   COMMANDES TELEGRAM
   ========================================================= */

bot.command("starttrade", async ctx => {

  const text = ctx.message.text || "";

  const parts =
    text.split(/\s+/);

  const mint = parts[1];

  await startTrade(mint);
});

bot.command("stoptrade", async ctx => {
  await stopTrade();
});

bot.command("status", async ctx => {
  await status();
});

bot.command("help", async ctx => {

  await sendTelegram(
`🤖 TEST V3

/starttrade MINT
➡️ démarre un test

/stoptrade
➡️ arrête le test

/status
➡️ affiche l'état

💵 Capital :
$${CAPITAL_PER_CYCLE_USD.toFixed(2)} par cycle

🎯 Objectif :
+${TARGET_NET_PERCENT.toFixed(2)}%

🛡️ Particularité V3 :
Après une vente, le bot ne rachète plus immédiatement.

Il observe le marché et bloque l'entrée si les conditions deviennent mauvaises.

⚠️ Simulation uniquement.`
  );
});

/* =========================================================
   LANCEMENT
   ========================================================= */

bot.launch()
  .then(() => {
    console.log("🤖 Bot Telegram TEST V3 démarré");
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
