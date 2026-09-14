const { Telegraf } = require("telegraf");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN ou CHAT_ID manquant.");
  process.exit(1);
}

// ------------------------------------------------------------
// STRATÉGIE TEST
// ------------------------------------------------------------

const CAPITAL_PER_CYCLE_USD = 10.00;
const TARGET_NET_PERCENT = 5.00;

// ------------------------------------------------------------
// TIMING
// ------------------------------------------------------------

const POLL_INTERVAL_MS = 2000;
const HISTORY_WINDOW_MS = 120000;
const PRE_CRASH_WINDOW_MS = 60000;
const SAFETY_OBSERVATION_MS = 30000;

// ------------------------------------------------------------
// FILTRES D'ENTRÉE
// ------------------------------------------------------------

const MIN_LIQUIDITY_USD = 3000;

const MAX_PRICE_DROP_10S = -4;
const MAX_LIQUIDITY_DROP_10S = -10;
const MAX_LIQUIDITY_DROP_30S = -15;

const REQUIRED_CONFIRMATIONS = 4;

// ------------------------------------------------------------
// CRASH
// ------------------------------------------------------------

const CRASH_PRICE_DROP_10S = -20;
const CRASH_LIQUIDITY_DROP_10S = -50;
const CRASH_MIN_LIQUIDITY_USD = 1;

// ------------------------------------------------------------
// DEXSCREENER
// ------------------------------------------------------------

const DEX_API =
  "https://api.dexscreener.com/latest/dex/tokens/";

// ------------------------------------------------------------
// PUMPSWAP
// ------------------------------------------------------------

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

// ============================================================
// STOCKAGE DES DONNÉES
// ============================================================

// Railway peut utiliser /data si un volume persistant est monté.
// Sinon on utilise le dossier courant.

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TRADE_FILE = path.join(DATA_DIR, "trade_history.json");
const MARKET_FILE = path.join(DATA_DIR, "market_history.jsonl");
const CRASH_FILE = path.join(DATA_DIR, "crash_reports.json");
const SUMMARY_FILE = path.join(DATA_DIR, "v5_summary.json");

// ============================================================
// OUTILS STOCKAGE
// ============================================================

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch (err) {
    console.error(`⚠️ Erreur lecture ${file}:`, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error(`⚠️ Erreur écriture ${file}:`, err.message);
  }
}

function appendJsonLine(file, data) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(data) + "\n",
      "utf8"
    );
  } catch (err) {
    console.error(`⚠️ Erreur écriture historique:`, err.message);
  }
}

// ============================================================
// DONNÉES PERSISTANTES
// ============================================================

let tradeHistory = readJson(TRADE_FILE, []);
let crashReports = readJson(CRASH_FILE, []);

let totalProfit = 0;

if (Array.isArray(tradeHistory)) {
  for (const trade of tradeHistory) {
    if (
      trade &&
      typeof trade.profit === "number"
    ) {
      totalProfit += trade.profit;
    }
  }
}

// ============================================================
// BOT TELEGRAM
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

// ============================================================
// ÉTAT DU BOT
// ============================================================

let running = false;
let stoppedByCrash = false;

let currentMint = null;

let position = null;

let cycleNumber = 0;
let completedCycles = 0;

let confirmationCount = 0;

let observationUntil = 0;

let pollTimer = null;

let heliusWs = null;

// ============================================================
// HISTORIQUE MARCHÉ EN MÉMOIRE
// ============================================================

let marketHistory = [];

// ============================================================
// UTILITAIRES
// ============================================================

function now() {
  return Date.now();
}

function trimHistory() {
  const cutoff = now() - HISTORY_WINDOW_MS;

  marketHistory = marketHistory.filter(
    x => x.timestamp >= cutoff
  );
}

function getPointAgo(ms) {
  const target = now() - ms;

  let closest = null;
  let bestDiff = Infinity;

  for (const point of marketHistory) {
    const diff = Math.abs(point.timestamp - target);

    if (diff < bestDiff) {
      bestDiff = diff;
      closest = point;
    }
  }

  return closest;
}

function percentChange(current, old) {
  if (
    typeof current !== "number" ||
    typeof old !== "number" ||
    old <= 0
  ) {
    return null;
  }

  return ((current - old) / old) * 100;
}

function round(value, decimals = 6) {
  if (typeof value !== "number") return null;

  return Number(value.toFixed(decimals));
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      message
    );
  } catch (err) {
    console.error(
      "❌ Erreur Telegram:",
      err.message
    );
  }
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getMarketData(mint) {
  try {
    const response = await fetch(
      `${DEX_API}${mint}`
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (
      !data ||
      !Array.isArray(data.pairs) ||
      data.pairs.length === 0
    ) {
      return null;
    }

    // On cherche en priorité une paire PumpSwap.
    let pair =
      data.pairs.find(p =>
        String(p.dexId || "").toLowerCase() ===
        "pump-swap"
      );

    // Fallback si l'identifiant varie.
    if (!pair) {
      pair =
        data.pairs.find(p =>
          String(p.dexId || "")
            .toLowerCase()
            .includes("pump")
        );
    }

    // Dernier fallback
    if (!pair) {
      pair = data.pairs[0];
    }

    const price =
      Number(pair.priceUsd);

    const liquidity =
      Number(
        pair.liquidity &&
        pair.liquidity.usd
      );

    const volume24h =
      Number(
        pair.volume &&
        pair.volume.h24
      );

    const txns =
      pair.txns || {};

    const buys =
      Number(
        txns.h24 &&
        txns.h24.buys
      ) || 0;

    const sells =
      Number(
        txns.h24 &&
        txns.h24.sells
      ) || 0;

    const pairCreatedAt =
      pair.pairCreatedAt
        ? Number(pair.pairCreatedAt)
        : null;

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      return null;
    }

    return {
      mint,
      price,
      liquidity:
        Number.isFinite(liquidity)
          ? liquidity
          : 0,
      volume24h:
        Number.isFinite(volume24h)
          ? volume24h
          : 0,
      buys,
      sells,
      pairCreatedAt,
      dexId: pair.dexId || null,
      pairAddress: pair.pairAddress || null
    };

  } catch (err) {
    console.error(
      "⚠️ DexScreener:",
      err.message
    );

    return null;
  }
}

// ============================================================
// SCORE DE SANTÉ
// ============================================================

function calculateHealth(data) {
  let score = 100;

  const p10 = getPointAgo(10000);
  const p30 = getPointAgo(30000);

  let price10 = null;
  let liq10 = null;
  let liq30 = null;

  if (p10) {
    price10 =
      percentChange(
        data.price,
        p10.price
      );

    liq10 =
      percentChange(
        data.liquidity,
        p10.liquidity
      );
  }

  if (p30) {
    liq30 =
      percentChange(
        data.liquidity,
        p30.liquidity
      );
  }

  // ----------------------------------------------------------
  // LIQUIDITÉ
  // ----------------------------------------------------------

  if (
    data.liquidity < MIN_LIQUIDITY_USD
  ) {
    score -= 70;
  } else if (
    data.liquidity < 5000
  ) {
    score -= 20;
  }

  if (
    liq10 !== null &&
    liq10 <= -20
  ) {
    score -= 40;
  } else if (
    liq10 !== null &&
    liq10 <= -10
  ) {
    score -= 20;
  }

  if (
    liq30 !== null &&
    liq30 <= -20
  ) {
    score -= 25;
  }

  // ----------------------------------------------------------
  // PRIX
  // ----------------------------------------------------------

  if (
    price10 !== null &&
    price10 <= -10
  ) {
    score -= 30;
  } else if (
    price10 !== null &&
    price10 <= -4
  ) {
    score -= 15;
  }

  // ----------------------------------------------------------
  // ACTIVITÉ
  // ----------------------------------------------------------

  const totalTx =
    data.buys + data.sells;

  if (totalTx === 0) {
    score -= 5;
  }

  // ----------------------------------------------------------
  // SCORE FINAL
  // ----------------------------------------------------------

  score = Math.max(
    0,
    Math.min(100, score)
  );

  return {
    score,
    price10,
    liq10,
    liq30
  };
}

// ============================================================
// ACCÉLÉRATION DU PRIX
// ============================================================

function calculateAcceleration(data) {
  const p5 = getPointAgo(5000);
  const p10 = getPointAgo(10000);
  const p20 = getPointAgo(20000);

  const c5 = p5
    ? percentChange(
        data.price,
        p5.price
      )
    : null;

  const c10 = p10
    ? percentChange(
        data.price,
        p10.price
      )
    : null;

  const c20 = p20
    ? percentChange(
        data.price,
        p20.price
      )
    : null;

  let acceleration = 0;

  if (
    c5 !== null &&
    c10 !== null
  ) {
    acceleration =
      c5 - (c10 / 2);
  }

  return {
    change5s: c5,
    change10s: c10,
    change20s: c20,
    acceleration
  };
}

// ============================================================
// ENREGISTREMENT D'UN POINT
// ============================================================

function recordMarketPoint(
  data,
  health,
  acceleration
) {
  const point = {
    timestamp: now(),
    iso: new Date().toISOString(),

    mint: data.mint,

    price: round(data.price, 10),

    liquidity: round(
      data.liquidity,
      2
    ),

    volume24h: round(
      data.volume24h,
      2
    ),

    buys: data.buys,
    sells: data.sells,

    score: health.score,

    priceChange10s:
      round(
        health.price10,
        4
      ),

    liquidityChange10s:
      round(
        health.liq10,
        4
      ),

    liquidityChange30s:
      round(
        health.liq30,
        4
      ),

    priceChange5s:
      round(
        acceleration.change5s,
        4
      ),

    priceChange20s:
      round(
        acceleration.change20s,
        4
      ),

    acceleration:
      round(
        acceleration.acceleration,
        4
      ),

    state:
      position
        ? "POSITION_OPEN"
        : "NO_POSITION",

    cycle: cycleNumber,

    observation:
      now() < observationUntil
  };

  marketHistory.push(point);

  trimHistory();

  // Sauvegarde permanente
  appendJsonLine(
    MARKET_FILE,
    point
  );
}

// ============================================================
// CRÉATION DU RAPPORT CRASH
// ============================================================

function createCrashReport(
  data,
  health,
  acceleration
) {
  const cutoff =
    now() - PRE_CRASH_WINDOW_MS;

  const last60s =
    marketHistory.filter(
      x => x.timestamp >= cutoff
    );

  const report = {
    id:
      `crash_${Date.now()}`,

    timestamp: now(),

    iso:
      new Date().toISOString(),

    mint: data.mint,

    cycle: cycleNumber,

    crash: {
      price:
        round(data.price, 10),

      liquidity:
        round(data.liquidity, 2),

      priceChange10s:
        round(
          health.price10,
          4
        ),

      liquidityChange10s:
        round(
          health.liq10,
          4
        )
    },

    acceleration: {
      change5s:
        round(
          acceleration.change5s,
          4
        ),

      change10s:
        round(
          acceleration.change10s,
          4
        ),

      change20s:
        round(
          acceleration.change20s,
          4
        ),

      acceleration:
        round(
          acceleration.acceleration,
          4
        )
    },

    scoreAtCrash:
      health.score,

    samplesLast60s:
      last60s
  };

  crashReports.push(report);

  writeJson(
    CRASH_FILE,
    crashReports
  );

  return report;
}

// ============================================================
// SAUVEGARDE DU RÉSUMÉ
// ============================================================

function saveSummary() {
  const summary = {
    version: "V5 TEST",

    updatedAt:
      new Date().toISOString(),

    strategy: {
      capitalPerCycle:
        CAPITAL_PER_CYCLE_USD,

      targetPercent:
        TARGET_NET_PERCENT
    },

    status: {
      running,
      stoppedByCrash
    },

    currentMint,

    cyclesCompleted:
      completedCycles,

    currentCycle:
      cycleNumber,

    totalProfit:
      round(totalProfit, 4),

    positionOpen:
      !!position,

    files: {
      trades:
        TRADE_FILE,

      market:
        MARKET_FILE,

      crashes:
        CRASH_FILE,

      summary:
        SUMMARY_FILE
    }
  };

  writeJson(
    SUMMARY_FILE,
    summary
  );
}

// ============================================================
// ENTRÉE
// ============================================================

async function simulateBuy(data) {
  if (position) {
    return false;
  }

  position = {
    cycle: cycleNumber,

    mint: data.mint,

    capital:
      CAPITAL_PER_CYCLE_USD,

    entryPrice:
      data.price,

    tokens:
      CAPITAL_PER_CYCLE_USD /
      data.price,

    targetPrice:
      data.price *
      (1 + TARGET_NET_PERCENT / 100),

    entryLiquidity:
      data.liquidity,

    entryTime:
      now()
  };

  await sendTelegram(
`🟢 ACHAT TEST #${cycleNumber}

Token :
${data.mint}

Mise fixe :
$${CAPITAL_PER_CYCLE_USD.toFixed(4)}

Prix :
$${data.price.toFixed(8)}

Tokens :
${position.tokens.toFixed(8)}

🎯 Objectif :
+${TARGET_NET_PERCENT.toFixed(2)}%

Prix cible :
$${position.targetPrice.toFixed(8)}

💧 Liquidité :
$${data.liquidity.toFixed(2)}

🧠 SCORE DE SANTÉ :
100/100

🛡️ Entrée confirmée :
${REQUIRED_CONFIRMATIONS}/${REQUIRED_CONFIRMATIONS}

⛓️ Helius :
${heliusWs ? "🟢 connecté" : "⚪ non connecté"}`
  );

  saveSummary();

  return true;
}

// ============================================================
// VENTE
// ============================================================

async function simulateSell(data) {
  if (!position) {
    return false;
  }

  const entry =
    position.entryPrice;

  const target =
    position.targetPrice;

  // On vend exactement au prix cible
  // pour ne pas surestimer les gains.

  const simulatedAmount =
    CAPITAL_PER_CYCLE_USD *
    (target / entry);

  const profit =
    simulatedAmount -
    CAPITAL_PER_CYCLE_USD;

  const result = {
    cycle:
      position.cycle,

    mint:
      position.mint,

    entryPrice:
      entry,

    exitPrice:
      target,

    capital:
      CAPITAL_PER_CYCLE_USD,

    amount:
      simulatedAmount,

    profit,

    percent:
      TARGET_NET_PERCENT,

    durationMs:
      now() -
      position.entryTime,

    timestamp:
      now(),

    iso:
      new Date().toISOString()
  };

  tradeHistory.push(result);

  writeJson(
    TRADE_FILE,
    tradeHistory
  );

  totalProfit += profit;

  completedCycles++;

  await sendTelegram(
`🔴 VENTE TEST #${position.cycle}

Token :
${position.mint}

Prix de vente :
$${target.toFixed(8)}

Montant simulé :
$${simulatedAmount.toFixed(4)}

Résultat :
+${TARGET_NET_PERCENT.toFixed(2)}%

Bénéfice réalisé :
+$${profit.toFixed(4)}

💰 Bénéfices cumulés :
$${totalProfit.toFixed(4)}

🛡️ NOUVELLE PHASE DE SÉCURITÉ

⏳ Observation du marché pendant ${SAFETY_OBSERVATION_MS / 1000}s

❌ Aucun rachat immédiat.`
  );

  position = null;

  observationUntil =
    now() +
    SAFETY_OBSERVATION_MS;

  confirmationCount = 0;

  saveSummary();

  return true;
}

// ============================================================
// FILTRE D'ENTRÉE
// ============================================================

function entryHealthy(
  data,
  health
) {
  if (
    marketHistory.length < 8
  ) {
    return false;
  }

  if (
    health.score < 80
  ) {
    return false;
  }

  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    return false;
  }

  if (
    health.price10 !== null &&
    health.price10 <=
      MAX_PRICE_DROP_10S
  ) {
    return false;
  }

  if (
    health.liq10 !== null &&
    health.liq10 <=
      MAX_LIQUIDITY_DROP_10S
  ) {
    return false;
  }

  if (
    health.liq30 !== null &&
    health.liq30 <=
      MAX_LIQUIDITY_DROP_30S
  ) {
    return false;
  }

  return true;
}

// ============================================================
// CRASH
// ============================================================

function isCrash(
  data,
  health
) {
  if (
    data.liquidity <=
    CRASH_MIN_LIQUIDITY_USD
  ) {
    return true;
  }

  if (
    health.liq10 !== null &&
    health.liq10 <=
      CRASH_LIQUIDITY_DROP_10S
  ) {
    return true;
  }

  if (
    health.price10 !== null &&
    health.price10 <=
      CRASH_PRICE_DROP_10S
  ) {
    return true;
  }

  return false;
}

// ============================================================
// ARRÊT CRASH
// ============================================================

async function emergencyStop(
  data,
  health,
  acceleration
) {
  if (stoppedByCrash) {
    return;
  }

  stoppedByCrash = true;
  running = false;

  const report =
    createCrashReport(
      data,
      health,
      acceleration
    );

  const accelerationText =
    acceleration.change5s !== null
      ? `${acceleration.change5s.toFixed(2)}%`
      : "N/A";

  let message =
`🚨 STOP CRASH - MODE TEST V5

Token :
${data.mint}

Prix :
$${data.price.toFixed(10)}

Variation prix ~10s :
${health.price10 !== null
  ? health.price10.toFixed(2) + "%"
  : "N/A"}

Liquidité :
$${data.liquidity.toFixed(2)}

Variation liquidité ~10s :
${health.liq10 !== null
  ? health.liq10.toFixed(2) + "%"
  : "N/A"}

⚡ Prix ~5s :
${accelerationText}

🧠 Score au crash :
${health.score}/100

⚠️ Signaux :`;

  if (
    health.liq10 !== null &&
    health.liq10 <=
      CRASH_LIQUIDITY_DROP_10S
  ) {
    message +=
      `\n• liquidité ${health.liq10.toFixed(2)}% / 10s`;
  }

  if (
    health.price10 !== null &&
    health.price10 <=
      CRASH_PRICE_DROP_10S
  ) {
    message +=
      `\n• prix ${health.price10.toFixed(2)}% / 10s`;
  }

  if (
    acceleration.change5s !== null &&
    acceleration.change5s >= 10
  ) {
    message +=
      `\n• ⚡ forte variation prix juste avant`;
  }

  if (!position) {
    message +=
`
    
✅ Aucune position ouverte.`;
  } else {
    message +=
`
    
⚠️ Position restante :
${position.tokens.toFixed(8)} tokens

⚠️ Prix de sortie NON considéré fiable.
⚠️ Aucun bénéfice fictif ajouté.`;
  }

  message +=
`

📊 DONNÉES DES 60 DERNIÈRES SECONDES
sauvegardées dans crash_reports.json

⛔ NOUVEAU CYCLE BLOQUÉ
⛔ RADAR ARRÊTÉ

Cycles terminés :
${completedCycles}

💰 Bénéfices simulés :
$${totalProfit.toFixed(4)}

⚠️ Simulation uniquement.`;

  await sendTelegram(message);

  console.log(
    `🚨 CRASH enregistré : ${report.id}`
  );

  saveSummary();

  stopRadar();
}

// ============================================================
// TRAITEMENT DU MARCHÉ
// ============================================================

async function processMarket() {
  if (!running) {
    return;
  }

  if (!currentMint) {
    return;
  }

  const data =
    await getMarketData(
      currentMint
    );

  if (!data) {
    console.log(
      "⚠️ Impossible de récupérer les données marché."
    );

    return;
  }

  const health =
    calculateHealth(data);

  const acceleration =
    calculateAcceleration(data);

  recordMarketPoint(
    data,
    health,
    acceleration
  );

  saveSummary();

  // ----------------------------------------------------------
  // CRASH PRIORITAIRE
  // ----------------------------------------------------------

  if (
    isCrash(
      data,
      health
    )
  ) {
    await emergencyStop(
      data,
      health,
      acceleration
    );

    return;
  }

  // ----------------------------------------------------------
  // POSITION OUVERTE
  // ----------------------------------------------------------

  if (position) {
    if (
      data.price >=
      position.targetPrice
    ) {
      await simulateSell(
        data
      );
    }

    return;
  }

  // ----------------------------------------------------------
  // PHASE D'OBSERVATION
  // ----------------------------------------------------------

  if (
    now() <
    observationUntil
  ) {
    return;
  }

  // ----------------------------------------------------------
  // CONFIRMATION ENTRÉE
  // ----------------------------------------------------------

  if (
    entryHealthy(
      data,
      health
    )
  ) {
    confirmationCount++;

    console.log(
      `🟡 Marché favorable : ${confirmationCount}/${REQUIRED_CONFIRMATIONS}`
    );

    if (
      confirmationCount >=
      REQUIRED_CONFIRMATIONS
    ) {
      cycleNumber++;

      confirmationCount = 0;

      await simulateBuy(
        data
      );
    }

  } else {
    confirmationCount = 0;
  }
}

// ============================================================
// HELIUS
// ============================================================

function connectHelius() {
  if (!HELIUS_API_KEY) {
    console.log(
      "⚠️ HELIUS_API_KEY absent."
    );

    return;
  }

  try {
    const url =
      `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

    heliusWs =
      new WebSocket(url);

    heliusWs.on(
      "open",
      () => {
        console.log(
          "⛓️ Helius WSS connecté."
        );

        const request = {
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
        };

        heliusWs.send(
          JSON.stringify(request)
        );
      }
    );

    heliusWs.on(
      "message",
      () => {
        // V5 utilise Helius comme
        // confirmation d'activité on-chain.
        // Le décodage BUY/SELL exact
        // n'est volontairement pas
        // inventé ici.
      }
    );

    heliusWs.on(
      "error",
      err => {
        console.error(
          "⚠️ Helius:",
          err.message
        );
      }
    );

    heliusWs.on(
      "close",
      () => {
        console.log(
          "⚠️ Helius WSS fermé."
        );

        heliusWs = null;
      }
    );

  } catch (err) {
    console.error(
      "❌ Erreur Helius:",
      err.message
    );
  }
}

// ============================================================
// DÉMARRAGE
// ============================================================

async function startRadar(
  mint
) {
  if (running) {
    return false;
  }

  currentMint = mint;

  running = true;
  stoppedByCrash = false;

  position = null;

  cycleNumber = 0;
  confirmationCount = 0;

  observationUntil = 0;

  marketHistory = [];

  console.log(
    `🚀 V5 démarrée pour ${mint}`
  );

  await sendTelegram(
`🧪 V5 TEST DÉMARRÉE

Token :
${mint}

💵 Mise par cycle :
$${CAPITAL_PER_CYCLE_USD.toFixed(2)}

🎯 Objectif :
+${TARGET_NET_PERCENT.toFixed(2)}%

🛡️ Confirmation entrée :
${REQUIRED_CONFIRMATIONS} lectures

⏳ Observation après chaque vente :
${SAFETY_OBSERVATION_MS / 1000}s

📊 Sauvegarde automatique :
🟢 activée

📁 Données :
${DATA_DIR}

⚠️ Simulation uniquement.`
  );

  connectHelius();

  pollTimer =
    setInterval(
      processMarket,
      POLL_INTERVAL_MS
    );

  await processMarket();

  saveSummary();

  return true;
}

// ============================================================
// ARRÊT
// ============================================================

function stopRadar() {
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

    heliusWs = null;
  }

  saveSummary();

  console.log(
    "⛔ Radar arrêté."
  );
}

// ============================================================
// COMMANDES TELEGRAM
// ============================================================

bot.command(
  "starttrade",
  async ctx => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    const mint =
      parts[1];

    if (!mint) {
      await ctx.reply(
`❌ Il manque le mint.

Utilisation :

/starttrade MINT_DU_TOKEN`
      );

      return;
    }

    if (running) {
      await ctx.reply(
        "⚠️ Le test est déjà en cours."
      );

      return;
    }

    await startRadar(
      mint
    );
  }
);

// ------------------------------------------------------------

bot.command(
  "stoptrade",
  async ctx => {
    if (!running) {
      await ctx.reply(
        "ℹ️ Aucun test en cours."
      );

      return;
    }

    stopRadar();

    await ctx.reply(
`⛔ TEST ARRÊTÉ

Cycles terminés :
${completedCycles}

💰 Bénéfices simulés :
$${totalProfit.toFixed(4)}

📁 Données sauvegardées.`
    );
  }
);

// ------------------------------------------------------------

bot.command(
  "status",
  async ctx => {
    const positionText =
      position
        ? `🟢 Position ouverte
Cycle : #${position.cycle}
Entrée : $${position.entryPrice.toFixed(8)}
Cible : $${position.targetPrice.toFixed(8)}`
        : "⚪ Aucune position ouverte";

    await ctx.reply(
`📊 STATUT V5

État :
${running ? "🟢 EN COURS" : "⛔ ARRÊTÉ"}

Token :
${currentMint || "Aucun"}

Cycles terminés :
${completedCycles}

Cycle actuel :
${cycleNumber}

💰 Bénéfices :
$${totalProfit.toFixed(4)}

${positionText}

📊 Points mémoire :
${marketHistory.length}

💾 Sauvegarde :
🟢 active

⛓️ Helius :
${heliusWs ? "🟢 connecté" : "⚪ déconnecté"}`
    );
  }
);

// ------------------------------------------------------------

bot.command(
  "help",
  async ctx => {
    await ctx.reply(
`🧪 COMMANDES V5

/starttrade MINT
▶️ Lance le test

/status
📊 Affiche l'état

/stoptrade
⛔ Arrête le test

/help
ℹ️ Affiche l'aide

💵 Stratégie :
$10 par cycle

🎯 Objectif :
+5%

📊 V5 :
Sauvegarde automatique des données
+ analyse des 60 secondes avant crash

⚠️ Simulation uniquement.`
    );
  }
);

// ============================================================
// LANCEMENT BOT
// ============================================================

bot.launch()
  .then(() => {
    console.log(
      "🤖 Bot Telegram V5 démarré."
    );
  })
  .catch(err => {
    console.error(
      "Erreur lancement bot :",
      err.message
    );
  });

// ============================================================
// ARRÊT PROPRE
// ============================================================

process.once(
  "SIGINT",
  () => {
    stopRadar();
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    stopRadar();
    bot.stop("SIGTERM");
  }
);
