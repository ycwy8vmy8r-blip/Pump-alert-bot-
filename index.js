const { Connection, PublicKey } = require("@solana/web3.js");
const { Telegraf } = require("telegraf");

// ============================================================
// RADAR SORTIE V5
// Objectif : détecter les micro-signaux pré-crash
// ============================================================

// ------------------------------------------------------------
// ENV
// ------------------------------------------------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN manquant");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("❌ CHAT_ID manquant");
  process.exit(1);
}

if (!HELIUS_API_KEY) {
  console.error("❌ HELIUS_API_KEY manquant");
  process.exit(1);
}

// ------------------------------------------------------------
// CONNECTION
// ------------------------------------------------------------

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, {
  commitment: "processed",
  wsEndpoint: WSS_URL
});

const bot = new Telegraf(BOT_TOKEN);

// ------------------------------------------------------------
// CONSTANTES
// ------------------------------------------------------------

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// Pool layout PumpSwap
const BASE_VAULT_OFFSET = 139;
const QUOTE_VAULT_OFFSET = 171;

// ------------------------------------------------------------
// ETAT
// ------------------------------------------------------------

let watchedMint = null;
let poolAddress = null;

let baseVault = null;
let quoteVault = null;

let baseSubscription = null;
let quoteSubscription = null;
let logSubscription = null;

let currentBase = null;
let currentQuote = null;

let lastPrice = null;
let lastLiquidity = null;

let localHighPrice = null;
let localHighLiquidity = null;

let lastDexUpdate = 0;

let onChainActive = false;

let lastAlertTime = 0;
let lastAlertLevel = "NORMAL";

let lastStatusTime = 0;

// ------------------------------------------------------------
// HISTORIQUE MICRO
// ------------------------------------------------------------

const events = [];

/*
event = {
  time,
  type: BUY / SELL / WITHDRAW / ADD,
  quote,
  base,
  tx
}
*/

function cleanupEvents() {
  const now = Date.now();

  while (
    events.length &&
    now - events[0].time > 30000
  ) {
    events.shift();
  }
}

// ------------------------------------------------------------
// UTILITAIRES
// ------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatSol(value) {
  return safeNumber(value).toFixed(4);
}

function formatPct(value) {
  return safeNumber(value).toFixed(1);
}

// ------------------------------------------------------------
// TELEGRAM
// ------------------------------------------------------------

async function sendTelegram(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text);
    console.log("📨 Telegram envoyé");
  } catch (err) {
    console.error("❌ Telegram:", err.message);
  }
}

// ------------------------------------------------------------
// LECTURE U64
// ------------------------------------------------------------

function readU64LE(buffer, offset) {
  if (!buffer || buffer.length < offset + 8) {
    return null;
  }

  try {
    return buffer.readBigUInt64LE(offset);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// TOKEN ACCOUNT
// Amount SPL TokenAccount = offset 64
// ------------------------------------------------------------

function readTokenAmount(data) {
  let buffer = null;

  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (data && Buffer.isBuffer(data.data)) {
    buffer = data.data;
  } else if (data && Array.isArray(data.data)) {
    try {
      buffer = Buffer.from(data.data[0], "base64");
    } catch {
      return null;
    }
  }

  if (!buffer || buffer.length < 72) {
    return null;
  }

  return readU64LE(buffer, 64);
}

// ------------------------------------------------------------
// POOL VAULTS
// ------------------------------------------------------------

async function readPoolVaults(pool) {
  try {
    const info = await connection.getAccountInfo(
      new PublicKey(pool),
      "processed"
    );

    if (!info || !info.data) {
      return null;
    }

    const data = Buffer.from(info.data);

    if (data.length < QUOTE_VAULT_OFFSET + 32) {
      return null;
    }

    const base = new PublicKey(
      data.subarray(
        BASE_VAULT_OFFSET,
        BASE_VAULT_OFFSET + 32
      )
    );

    const quote = new PublicKey(
      data.subarray(
        QUOTE_VAULT_OFFSET,
        QUOTE_VAULT_OFFSET + 32
      )
    );

    return {
      base: base.toBase58(),
      quote: quote.toBase58()
    };

  } catch (err) {
    console.error("❌ Lecture vaults:", err.message);
    return null;
  }
}

// ------------------------------------------------------------
// BALANCES INITIALES
// ------------------------------------------------------------

async function readVaultBalance(address) {
  try {
    const info = await connection.getAccountInfo(
      new PublicKey(address),
      "processed"
    );

    if (!info) {
      return null;
    }

    return readTokenAmount(info.data);

  } catch (err) {
    console.error(
      "❌ Lecture balance vault:",
      err.message
    );

    return null;
  }
}

// ------------------------------------------------------------
// DEXSCREENER
// ------------------------------------------------------------

async function fetchDexData() {
  if (!watchedMint) {
    return null;
  }

  try {
    const url =
      `https://api.dexscreener.com/latest/dex/tokens/${watchedMint}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const json = await response.json();

    if (!json.pairs || !json.pairs.length) {
      return null;
    }

    const pumpPairs = json.pairs.filter(pair => {
      const dexId =
        String(pair.dexId || "").toLowerCase();

      return (
        dexId.includes("pump") ||
        dexId.includes("pumpswap")
      );
    });

    const pairs =
      pumpPairs.length
        ? pumpPairs
        : json.pairs;

    pairs.sort((a, b) => {
      const la =
        safeNumber(a.liquidity?.usd);

      const lb =
        safeNumber(b.liquidity?.usd);

      return lb - la;
    });

    const pair = pairs[0];

    if (!pair) {
      return null;
    }

    const price =
      safeNumber(pair.priceUsd);

    const liquidity =
      safeNumber(pair.liquidity?.usd);

    const detectedPool =
      pair.pairAddress || null;

    return {
      price,
      liquidity,
      pool: detectedPool
    };

  } catch (err) {
    console.error(
      "⚠️ DexScreener:",
      err.message
    );

    return null;
  }
}

// ------------------------------------------------------------
// UPDATE PRIX / LIQUIDITE
// ------------------------------------------------------------

async function updateMarketData() {
  const data = await fetchDexData();

  if (!data) {
    return;
  }

  const now = Date.now();

  lastPrice = data.price;
  lastLiquidity = data.liquidity;

  if (
    lastPrice > 0 &&
    (
      localHighPrice === null ||
      lastPrice > localHighPrice
    )
  ) {
    localHighPrice = lastPrice;
  }

  if (
    lastLiquidity > 0 &&
    (
      localHighLiquidity === null ||
      lastLiquidity > localHighLiquidity
    )
  ) {
    localHighLiquidity = lastLiquidity;
  }

  lastDexUpdate = now;
}

// ------------------------------------------------------------
// PRIX DEPUIS SOMMET
// ------------------------------------------------------------

function priceDrawdown() {
  if (
    !localHighPrice ||
    !lastPrice ||
    localHighPrice <= 0
  ) {
    return 0;
  }

  return (
    (lastPrice - localHighPrice) /
    localHighPrice
  ) * 100;
}

// ------------------------------------------------------------
// LIQUIDITE DEPUIS SOMMET
// ------------------------------------------------------------

function liquidityDrawdown() {
  if (
    !localHighLiquidity ||
    !lastLiquidity ||
    localHighLiquidity <= 0
  ) {
    return 0;
  }

  return (
    (lastLiquidity - localHighLiquidity) /
    localHighLiquidity
  ) * 100;
}

// ------------------------------------------------------------
// EVENEMENTS PAR FENETRE
// ------------------------------------------------------------

function getEvents(seconds) {
  cleanupEvents();

  const cutoff =
    Date.now() - seconds * 1000;

  return events.filter(
    e => e.time >= cutoff
  );
}

function getSellEvents(seconds) {
  return getEvents(seconds)
    .filter(e => e.type === "SELL");
}

function getBuyEvents(seconds) {
  return getEvents(seconds)
    .filter(e => e.type === "BUY");
}

// ------------------------------------------------------------
// VOLUME SELL
// ------------------------------------------------------------

function sellVolume(seconds) {
  return getSellEvents(seconds)
    .reduce(
      (sum, e) => sum + safeNumber(e.quote),
      0
    );
}

// ------------------------------------------------------------
// VOLUME BUY
// ------------------------------------------------------------

function buyVolume(seconds) {
  return getBuyEvents(seconds)
    .reduce(
      (sum, e) => sum + safeNumber(e.quote),
      0
    );
}

// ------------------------------------------------------------
// RATIO SELL
// ------------------------------------------------------------

function sellRatio(seconds) {
  const sells = sellVolume(seconds);
  const buys = buyVolume(seconds);

  const total = sells + buys;

  if (total <= 0) {
    return 0;
  }

  return (
    sells / total
  ) * 100;
}

// ------------------------------------------------------------
// NOMBRE SELL
// ------------------------------------------------------------

function sellCount(seconds) {
  return getSellEvents(seconds).length;
}

// ------------------------------------------------------------
// GROS SELL
// ------------------------------------------------------------

function largestSell(seconds) {
  const sells = getSellEvents(seconds);

  if (!sells.length) {
    return 0;
  }

  return Math.max(
    ...sells.map(
      e => safeNumber(e.quote)
    )
  );
}

// ------------------------------------------------------------
// ACCELERATION SELL
// Compare 3s avec les 3s précédentes
// ------------------------------------------------------------

function sellAcceleration() {
  cleanupEvents();

  const now = Date.now();

  const recent = events.filter(
    e =>
      e.type === "SELL" &&
      e.time >= now - 3000
  );

  const previous = events.filter(
    e =>
      e.type === "SELL" &&
      e.time >= now - 6000 &&
      e.time < now - 3000
  );

  const recentVolume =
    recent.reduce(
      (s, e) => s + safeNumber(e.quote),
      0
    );

  const previousVolume =
    previous.reduce(
      (s, e) => s + safeNumber(e.quote),
      0
    );

  if (previousVolume <= 0) {
    return recentVolume > 0
      ? 999
      : 0;
  }

  return (
    recentVolume /
    previousVolume
  );
}

// ------------------------------------------------------------
// SELL BURST
// ------------------------------------------------------------

function sellBurstScore() {
  const s1 = sellVolume(1);
  const s3 = sellVolume(3);
  const s5 = sellVolume(5);
  const c1 = sellCount(1);
  const c3 = sellCount(3);

  let score = 0;

  // Activité instantanée
  if (s1 >= 3) score += 8;
  if (s1 >= 5) score += 8;
  if (s1 >= 10) score += 10;
  if (s1 >= 20) score += 12;

  // Répétition
  if (c1 >= 3) score += 6;
  if (c1 >= 5) score += 8;
  if (c3 >= 10) score += 8;

  // Ratio
  const ratio = sellRatio(3);

  if (ratio >= 70) score += 5;
  if (ratio >= 80) score += 7;
  if (ratio >= 90) score += 10;

  // Accélération
  const acceleration =
    sellAcceleration();

  if (acceleration >= 2) score += 6;
  if (acceleration >= 4) score += 8;
  if (acceleration >= 8) score += 10;

  return clamp(score, 0, 45);
}

// ------------------------------------------------------------
// LIQUIDITY MICRO
// ------------------------------------------------------------

let liquiditySamples = [];

/*
{
  time,
  liquidity,
  price
}
*/

function addLiquiditySample() {
  if (
    !lastLiquidity ||
    lastLiquidity <= 0
  ) {
    return;
  }

  liquiditySamples.push({
    time: Date.now(),
    liquidity: lastLiquidity,
    price: lastPrice
  });

  const cutoff =
    Date.now() - 60000;

  liquiditySamples =
    liquiditySamples.filter(
      x => x.time >= cutoff
    );
}

// ------------------------------------------------------------
// LIQUIDITE CHANGE
// ------------------------------------------------------------

function liquidityChange(seconds) {
  const now = Date.now();

  const cutoff =
    now - seconds * 1000;

  const samples =
    liquiditySamples.filter(
      x => x.time >= cutoff
    );

  if (
    !samples.length ||
    !lastLiquidity
  ) {
    return 0;
  }

  const oldest =
    samples[0].liquidity;

  if (!oldest) {
    return 0;
  }

  return (
    (lastLiquidity - oldest) /
    oldest
  ) * 100;
}

// ------------------------------------------------------------
// RESERVE MICRO CHANGE
// ------------------------------------------------------------

let reserveSamples = [];

/*
{
  time,
  quote
}
*/

function addReserveSample() {
  if (
    currentQuote === null ||
    currentQuote === undefined
  ) {
    return;
  }

  reserveSamples.push({
    time: Date.now(),
    quote: Number(currentQuote)
  });

  const cutoff =
    Date.now() - 30000;

  reserveSamples =
    reserveSamples.filter(
      x => x.time >= cutoff
    );
}

function reserveChange(seconds) {
  if (
    currentQuote === null ||
    currentQuote === undefined
  ) {
    return 0;
  }

  const cutoff =
    Date.now() - seconds * 1000;

  const samples =
    reserveSamples.filter(
      x => x.time >= cutoff
    );

  if (!samples.length) {
    return 0;
  }

  const oldest =
    samples[0].quote;

  if (!oldest) {
    return 0;
  }

  return (
    (
      Number(currentQuote) -
      oldest
    ) / oldest
  ) * 100;
}

// ------------------------------------------------------------
// SCORE PRIX
// ------------------------------------------------------------

function priceWeaknessScore() {
  let score = 0;

  const dd = priceDrawdown();

  // Prix proche du sommet mais qui commence à décrocher
  if (dd <= -1) score += 4;
  if (dd <= -2) score += 7;
  if (dd <= -3) score += 10;
  if (dd <= -5) score += 15;
  if (dd <= -8) score += 20;

  return clamp(score, 0, 25);
}

// ------------------------------------------------------------
// SCORE RESERVE
// ------------------------------------------------------------

function reserveRiskScore() {
  let score = 0;

  const r10 =
    reserveChange(10);

  const r5 =
    reserveChange(5);

  if (r5 <= -0.5) score += 5;
  if (r5 <= -1) score += 7;
  if (r5 <= -2) score += 10;
  if (r5 <= -5) score += 15;

  if (r10 <= -2) score += 5;
  if (r10 <= -5) score += 8;
  if (r10 <= -10) score += 12;
  if (r10 <= -20) score += 18;

  return clamp(score, 0, 30);
}

// ------------------------------------------------------------
// SCORE LIQUIDITE
// ------------------------------------------------------------

function liquidityRiskScore() {
  let score = 0;

  const l5 =
    liquidityChange(5);

  const l15 =
    liquidityChange(15);

  if (l5 <= -1) score += 5;
  if (l5 <= -3) score += 8;
  if (l5 <= -5) score += 12;
  if (l5 <= -10) score += 18;

  if (l15 <= -3) score += 5;
  if (l15 <= -8) score += 8;
  if (l15 <= -15) score += 12;
  if (l15 <= -25) score += 18;

  return clamp(score, 0, 30);
}

// ------------------------------------------------------------
// RETRAITS LIQUIDITE
// ------------------------------------------------------------

function withdrawalRiskScore() {
  const withdrawals =
    getEvents(10)
      .filter(
        e => e.type === "WITHDRAW"
      );

  if (!withdrawals.length) {
    return 0;
  }

  const total =
    withdrawals.reduce(
      (s, e) =>
        s + Math.abs(safeNumber(e.quote)),
      0
    );

  let score = 10;

  if (total >= 5) score += 8;
  if (total >= 20) score += 10;
  if (total >= 50) score += 12;
  if (withdrawals.length >= 2) score += 10;

  return clamp(score, 0, 35);
}

// ------------------------------------------------------------
// CONFLUENCE
// Le cœur de V5
// ------------------------------------------------------------

function calculateRisk() {
  let score = 0;

  const reasons = [];

  const burst =
    sellBurstScore();

  const priceRisk =
    priceWeaknessScore();

  const reserveRisk =
    reserveRiskScore();

  const liquidityRisk =
    liquidityRiskScore();

  const withdrawalRisk =
    withdrawalRiskScore();

  score += burst;
  score += priceRisk;
  score += reserveRisk;
  score += liquidityRisk;
  score += withdrawalRisk;

  // ----------------------------------------------------------
  // CONFLUENCE 1
  // SELL agressifs + prix qui décroche
  // ----------------------------------------------------------

  const sell10 =
    sellVolume(10);

  const ratio10 =
    sellRatio(10);

  const dd =
    priceDrawdown();

  if (
    sell10 >= 10 &&
    ratio10 >= 75 &&
    dd <= -1
  ) {
    score += 15;
    reasons.push(
      "SELL agressifs + prix sous le sommet"
    );
  }

  // ----------------------------------------------------------
  // CONFLUENCE 2
  // SELL agressifs + réserve en baisse
  // ----------------------------------------------------------

  const r10 =
    reserveChange(10);

  if (
    sell10 >= 10 &&
    ratio10 >= 70 &&
    r10 <= -2
  ) {
    score += 15;
    reasons.push(
      "SELL agressifs + réserve en baisse"
    );
  }

  // ----------------------------------------------------------
  // CONFLUENCE 3
  // SELL accélèrent
  // ----------------------------------------------------------

  const acceleration =
    sellAcceleration();

  if (
    acceleration >= 3 &&
    sellCount(3) >= 5
  ) {
    score += 12;

    reasons.push(
      "accélération brutale des SELL"
    );
  }

  // ----------------------------------------------------------
  // CONFLUENCE 4
  // plusieurs gros SELL rapprochés
  // ----------------------------------------------------------

  const biggest =
    largestSell(5);

  const count5 =
    sellCount(5);

  if (
    biggest >= 10 &&
    count5 >= 3
  ) {
    score += 12;

    reasons.push(
      "gros SELL répétés"
    );
  }

  // ----------------------------------------------------------
  // CONFLUENCE 5
  // prix monte encore mais pression extrême
  // ----------------------------------------------------------

  if (
    ratio10 >= 90 &&
    sell10 >= 15 &&
    dd > -1
  ) {
    score += 8;

    reasons.push(
      "pression extrême malgré prix encore haut"
    );
  }

  // ----------------------------------------------------------
  // CONFLUENCE 6
  // liquidité et réserve chutent ensemble
  // ----------------------------------------------------------

  const l10 =
    liquidityChange(10);

  if (
    l10 <= -3 &&
    r10 <= -2
  ) {
    score += 15;

    reasons.push(
      "liquidité + réserve se dégradent"
    );
  }

  // ----------------------------------------------------------
  // CONFLUENCE 7
  // rupture du sommet
  // ----------------------------------------------------------

  if (
    dd <= -3 &&
    sell10 >= 5
  ) {
    score += 10;

    reasons.push(
      "rupture du sommet récent"
    );
  }

  return {
    score: clamp(
      Math.round(score),
      0,
      100
    ),
    reasons,
    metrics: {
      sell1: sellVolume(1),
      sell3: sellVolume(3),
      sell5: sellVolume(5),
      sell10,
      sell30: sellVolume(30),
      buy10: buyVolume(10),
      ratio10,
      sellCount1: sellCount(1),
      sellCount3: sellCount(3),
      sellCount10: sellCount(10),
      acceleration,
      drawdown: dd,
      reserve5: reserveChange(5),
      reserve10: r10,
      liquidity5: liquidityChange(5),
      liquidity15: liquidityChange(15)
    }
  };
}

// ------------------------------------------------------------
// NIVEAU
// ------------------------------------------------------------

function getRiskLevel(score) {
  if (score >= 75) {
    return "URGENT";
  }

  if (score >= 50) {
    return "DANGER";
  }

  if (score >= 35) {
    return "PRECRASH";
  }

  if (score >= 20) {
    return "PRESSION";
  }

  return "NORMAL";
}

// ------------------------------------------------------------
// DOIT ALERTER ?
// ------------------------------------------------------------

function shouldAlert(level, score) {
  const now = Date.now();

  // Normal
  if (level === "NORMAL") {
    return false;
  }

  // Nouveau niveau
  if (level !== lastAlertLevel) {
    return true;
  }

  // Urgent : cooldown court
  if (level === "URGENT") {
    return (
      now - lastAlertTime >= 15000
    );
  }

  // Danger
  if (level === "DANGER") {
    return (
      now - lastAlertTime >= 20000
    );
  }

  // Precrash
  if (level === "PRECRASH") {
    return (
      now - lastAlertTime >= 30000
    );
  }

  // Pression
  return (
    now - lastAlertTime >= 60000
  );
}

// ------------------------------------------------------------
// MESSAGE ALERTE
// ------------------------------------------------------------

async function sendRiskAlert(
  level,
  analysis
) {
  const m =
    analysis.metrics;

  let title = "";

  if (level === "URGENT") {
    title =
      "🚨 SIGNAL DE SORTIE URGENT";
  } else if (level === "DANGER") {
    title =
      "🟠 DANGER : DÉGRADATION RAPIDE";
  } else if (level === "PRECRASH") {
    title =
      "🟡 PRÉ-CRASH : MICRO-SIGNAUX";
  } else {
    title =
      "🟠 PRESSION VENDEUSE";
  }

  const reasonText =
    analysis.reasons.length
      ? analysis.reasons.join(" | ")
      : "activité vendeuse inhabituelle";

  const message =
`${title}

Score risque : ${analysis.score}/100

Prix : $${safeNumber(lastPrice).toFixed(8)}
Liquidité : $${safeNumber(lastLiquidity).toFixed(2)}

SELL 1s : ${formatSol(m.sell1)} SOL
SELL 3s : ${formatSol(m.sell3)} SOL
SELL 5s : ${formatSol(m.sell5)} SOL
SELL 10s : ${formatSol(m.sell10)} SOL
SELL ratio 10s : ${formatPct(m.ratio10)}%

SELL / 10s : ${m.sellCount10}

Réserve WSOL :
${currentQuote !== null
  ? formatSol(Number(currentQuote))
  : "N/A"} SOL

Prix sous sommet :
${formatPct(m.drawdown)}%

Réserve 5s :
${formatPct(m.reserve5)}%

Réserve 10s :
${formatPct(m.reserve10)}%

Liquidité 5s :
${formatPct(m.liquidity5)}%

⚠️ Signaux :
${reasonText}

📡 RADAR V5`;

  await sendTelegram(message);

  lastAlertTime = Date.now();
  lastAlertLevel = level;
}

// ------------------------------------------------------------
// EVALUATION
// ------------------------------------------------------------

async function evaluateRisk() {
  if (!watchedMint) {
    return;
  }

  cleanupEvents();

  const analysis =
    calculateRisk();

  const level =
    getRiskLevel(
      analysis.score
    );

  if (
    shouldAlert(
      level,
      analysis.score
    )
  ) {
    await sendRiskAlert(
      level,
      analysis
    );
  }

  if (level === "NORMAL") {
    lastAlertLevel = "NORMAL";
  }
}

// ------------------------------------------------------------
// ENREGISTREMENT EVENEMENT
// ------------------------------------------------------------

function recordEvent(
  type,
  quote,
  base,
  tx
) {
  events.push({
    time: Date.now(),
    type,
    quote: Math.abs(
      safeNumber(quote)
    ),
    base: Math.abs(
      safeNumber(base)
    ),
    tx: tx || null
  });

  cleanupEvents();

  console.log(
    `📊 ${type} | ${safeNumber(quote).toFixed(4)} SOL`
  );
}

// ------------------------------------------------------------
// BATCH VAULT
// ------------------------------------------------------------

let pendingBase = null;
let pendingQuote = null;

let batchTimer = null;

function scheduleVaultEvaluation() {
  if (batchTimer) {
    return;
  }

  batchTimer = setTimeout(() => {
    batchTimer = null;

    processVaultBatch();

  }, 80);
}

// ------------------------------------------------------------
// PROCESS DELTA
// ------------------------------------------------------------

function processVaultBatch() {
  if (
    pendingBase === null ||
    pendingQuote === null
  ) {
    return;
  }

  const newBase =
    pendingBase;

  const newQuote =
    pendingQuote;

  pendingBase = null;
  pendingQuote = null;

  if (
    currentBase === null ||
    currentQuote === null
  ) {
    currentBase = newBase;
    currentQuote = newQuote;

    addReserveSample();

    return;
  }

  const baseDelta =
    newBase - currentBase;

  const quoteDelta =
    newQuote - currentQuote;

  currentBase = newBase;
  currentQuote = newQuote;

  addReserveSample();

  if (
    baseDelta === 0 &&
    quoteDelta === 0
  ) {
    return;
  }

  /*
   SELL :
   base vault ↓
   quote vault ↑

   BUY :
   base vault ↑
   quote vault ↓

   RETRAIT :
   base vault ↓
   quote vault ↓

   AJOUT :
   base vault ↑
   quote vault ↑
  */

  const baseDown =
    baseDelta < 0;

  const baseUp =
    baseDelta > 0;

  const quoteDown =
    quoteDelta < 0;

  const quoteUp =
    quoteDelta > 0;

  const quoteAbs =
    Math.abs(
      Number(quoteDelta)
    ) /
    1e9;

  const baseAbs =
    Math.abs(
      Number(baseDelta)
    );

  if (
    baseDown &&
    quoteUp
  ) {
    recordEvent(
      "SELL",
      quoteAbs,
      baseAbs,
      null
    );

    return;
  }

  if (
    baseUp &&
    quoteDown
  ) {
    recordEvent(
      "BUY",
      quoteAbs,
      baseAbs,
      null
    );

    return;
  }

  if (
    baseDown &&
    quoteDown
  ) {
    recordEvent(
      "WITHDRAW",
      quoteAbs,
      baseAbs,
      null
    );

    return;
  }

  if (
    baseUp &&
    quoteUp
  ) {
    recordEvent(
      "ADD",
      quoteAbs,
      baseAbs,
      null
    );

    return;
  }
}

// ------------------------------------------------------------
// BASE VAULT SUBSCRIPTION
// ------------------------------------------------------------

async function subscribeBaseVault() {
  if (!baseVault) {
    return;
  }

  try {
    baseSubscription =
      connection.onAccountChange(
        new PublicKey(baseVault),
        accountInfo => {
          const amount =
            readTokenAmount(
              accountInfo.data
            );

          if (
            amount === null
          ) {
            return;
          }

          pendingBase =
            amount;

          scheduleVaultEvaluation();
        },
        {
          commitment: "processed",
          encoding: "base64"
        }
      );

    console.log(
      "🟢 Base vault surveillé"
    );

  } catch (err) {
    console.error(
      "❌ Base subscription:",
      err.message
    );
  }
}

// ------------------------------------------------------------
// QUOTE VAULT SUBSCRIPTION
// ------------------------------------------------------------

async function subscribeQuoteVault() {
  if (!quoteVault) {
    return;
  }

  try {
    quoteSubscription =
      connection.onAccountChange(
        new PublicKey(quoteVault),
        accountInfo => {
          const amount =
            readTokenAmount(
              accountInfo.data
            );

          if (
            amount === null
          ) {
            return;
          }

          pendingQuote =
            amount;

          scheduleVaultEvaluation();
        },
        {
          commitment: "processed",
          encoding: "base64"
        }
      );

    console.log(
      "🟢 Quote vault surveillé"
    );

  } catch (err) {
    console.error(
      "❌ Quote subscription:",
      err.message
    );
  }
}

// ------------------------------------------------------------
// LOGS PUMPSWAP
// ------------------------------------------------------------

async function subscribeLogs() {
  if (!poolAddress) {
    return;
  }

  try {
    logSubscription =
      connection.onLogs(
        new PublicKey(poolAddress),
        logInfo => {

          const logs =
            logInfo.logs || [];

          const text =
            logs.join(" ");

          const lower =
            text.toLowerCase();

          if (
            lower.includes("sell")
          ) {
            console.log(
              "⚠️ LOG PUMPSWAP SELL"
            );
          }

          if (
            lower.includes("buy")
          ) {
            console.log(
              "🟢 LOG PUMPSWAP BUY"
            );
          }

        },
        "processed"
      );

    console.log(
      "🟢 Logs PumpSwap actifs"
    );

  } catch (err) {
    console.error(
      "❌ Logs subscription:",
      err.message
    );
  }
}

// ------------------------------------------------------------
// INITIALISATION VAULTS
// ------------------------------------------------------------

async function initializeVaultBalances() {
  if (
    !baseVault ||
    !quoteVault
  ) {
    return false;
  }

  const base =
    await readVaultBalance(
      baseVault
    );

  const quote =
    await readVaultBalance(
      quoteVault
    );

  if (
    base === null ||
    quote === null
  ) {
    console.error(
      "❌ Impossible d'initialiser les réserves"
    );

    return false;
  }

  currentBase = base;
  currentQuote = quote;

  addReserveSample();

  console.log(
    "💧 Base :",
    base.toString()
  );

  console.log(
    "💧 Quote :",
    quote.toString()
  );

  return true;
}

// ------------------------------------------------------------
// RESET
// ------------------------------------------------------------

async function resetSubscriptions() {
  try {
    if (
      baseSubscription !== null
    ) {
      await connection.removeAccountChangeListener(
        baseSubscription
      );
    }
  } catch {}

  try {
    if (
      quoteSubscription !== null
    ) {
      await connection.removeAccountChangeListener(
        quoteSubscription
      );
    }
  } catch {}

  try {
    if (
      logSubscription !== null
    ) {
      await connection.removeOnLogsListener(
        logSubscription
      );
    }
  } catch {}

  baseSubscription = null;
  quoteSubscription = null;
  logSubscription = null;
}

// ------------------------------------------------------------
// DISCOVERY
// ------------------------------------------------------------

async function discoverPool() {
  const data =
    await fetchDexData();

  if (!data) {
    throw new Error(
      "Token introuvable sur DexScreener"
    );
  }

  if (!data.pool) {
    throw new Error(
      "Pool introuvable"
    );
  }

  poolAddress =
    data.pool;

  lastPrice =
    data.price;

  lastLiquidity =
    data.liquidity;

  localHighPrice =
    data.price;

  localHighLiquidity =
    data.liquidity;

  console.log(
    "🏊 Pool :",
    poolAddress
  );

  const vaults =
    await readPoolVaults(
      poolAddress
    );

  if (!vaults) {
    throw new Error(
      "Impossible de lire les vaults PumpSwap"
    );
  }

  baseVault =
    vaults.base;

  quoteVault =
    vaults.quote;

  console.log(
    "🪙 Base vault :",
    baseVault
  );

  console.log(
    "💧 Quote vault :",
    quoteVault
  );
}

// ------------------------------------------------------------
// START WATCH
// ------------------------------------------------------------

async function startWatch(mint) {
  try {
    await resetSubscriptions();

    watchedMint =
      mint.trim();

    events.length = 0;
    liquiditySamples = [];
    reserveSamples = [];

    currentBase = null;
    currentQuote = null;

    lastPrice = null;
    lastLiquidity = null;

    localHighPrice = null;
    localHighLiquidity = null;

    lastAlertTime = 0;
    lastAlertLevel = "NORMAL";

    console.log(
      "🔎 Recherche pool..."
    );

    await discoverPool();

    const initialized =
      await initializeVaultBalances();

    if (!initialized) {
      throw new Error(
        "Initialisation des réserves impossible"
      );
    }

    await subscribeBaseVault();
    await subscribeQuoteVault();
    await subscribeLogs();

    onChainActive = true;

    await sendTelegram(
`🛰️ RADAR SORTIE V5 ACTIVÉ

Token :
${watchedMint}

Pool :
${poolAddress}

Je surveille maintenant :

• micro-SELL 1s / 3s / 5s / 10s
• accélération des SELL
• SELL répétés
• pression vendeuse extrême
• vraies variations des vaults
• retraits de liquidité
• réserve WSOL
• liquidité
• prix
• sommet récent
• confluence pré-crash

🟢 On-chain : ACTIVE

⚠️ V5 cherche des signaux précoces, mais aucune alerte ne peut garantir une sortie avant un crash.`);

  } catch (err) {
    console.error(
      "❌ startWatch:",
      err.message
    );

    onChainActive = false;

    await sendTelegram(
`❌ RADAR V5

Impossible d'activer la surveillance.

Erreur :
${err.message}`
    );
  }
}

// ------------------------------------------------------------
// STOP WATCH
// ------------------------------------------------------------

async function stopWatch() {
  await resetSubscriptions();

  watchedMint = null;
  poolAddress = null;

  baseVault = null;
  quoteVault = null;

  currentBase = null;
  currentQuote = null;

  onChainActive = false;

  events.length = 0;
  liquiditySamples = [];
  reserveSamples = [];

  await sendTelegram(
    "🔴 RADAR V5 arrêté."
  );
}

// ------------------------------------------------------------
// STATUS
// ------------------------------------------------------------

async function sendStatus() {
  if (!watchedMint) {
    await sendTelegram(
      "ℹ️ Aucun token surveillé."
    );

    return;
  }

  await updateMarketData();

  addLiquiditySample();
  addReserveSample();

  const analysis =
    calculateRisk();

  const level =
    getRiskLevel(
      analysis.score
    );

  const m =
    analysis.metrics;

  const status =
`🛰️ RADAR V5

Token :
${watchedMint}

Pool :
${poolAddress || "N/A"}

💰 Prix :
$${safeNumber(lastPrice).toFixed(8)}

💧 Liquidité :
$${safeNumber(lastLiquidity).toFixed(2)}

📈 Sommet :
$${safeNumber(localHighPrice).toFixed(8)}

📉 Sous sommet :
${formatPct(m.drawdown)}%

💧 Réserve WSOL :
${currentQuote !== null
  ? formatSol(Number(currentQuote))
  : "N/A"} SOL

🔴 SELL 1s :
${formatSol(m.sell1)} SOL

🔴 SELL 3s :
${formatSol(m.sell3)} SOL

🔴 SELL 5s :
${formatSol(m.sell5)} SOL

🔴 SELL 10s :
${formatSol(m.sell10)} SOL

🔴 SELL 30s :
${formatSol(m.sell30)} SOL

📊 SELL ratio 10s :
${formatPct(m.ratio10)}%

🔢 SELL / 10s :
${m.sellCount10}

⚡ Accélération :
${safeNumber(m.acceleration).toFixed(2)}x

💧 Réserve 5s :
${formatPct(m.reserve5)}%

💧 Réserve 10s :
${formatPct(m.reserve10)}%

💧 Liquidité 5s :
${formatPct(m.liquidity5)}%

💧 Liquidité 15s :
${formatPct(m.liquidity15)}%

🎯 RISQUE :
${analysis.score}/100

NIVEAU :
${level}

📡 On-chain :
${onChainActive
  ? "ACTIVE"
  : "INACTIVE"}

🔎 Raisons :
${analysis.reasons.length
  ? analysis.reasons.join(" | ")
  : "aucune"}`;

  await sendTelegram(
    status
  );
}

// ------------------------------------------------------------
// COMMANDES TELEGRAM
// ------------------------------------------------------------

bot.command("watch", async ctx => {
  const text =
    ctx.message.text
      .replace("/watch", "")
      .trim();

  if (!text) {
    await ctx.reply(
      "Utilisation : /watch MINT"
    );

    return;
  }

  await ctx.reply(
    "🔎 V5 recherche le pool..."
  );

  await startWatch(text);
});

// ------------------------------------------------------------

bot.command("unwatch", async ctx => {
  await stopWatch();
});

// ------------------------------------------------------------

bot.command("status", async ctx => {
  await sendStatus();
});

// ------------------------------------------------------------

bot.command("help", async ctx => {
  await ctx.reply(
`🛰️ RADAR SORTIE V5

Commandes :

/watch MINT
→ surveiller un token

/status
→ état actuel du radar

/unwatch
→ arrêter

V5 surveille les micro-signaux pré-crash, les SELL rapides, les variations réelles des réserves, les retraits de liquidité et la perte du sommet.`
  );
});

// ------------------------------------------------------------
// MARKET LOOP
// ------------------------------------------------------------

setInterval(async () => {
  if (!watchedMint) {
    return;
  }

  try {
    await updateMarketData();

    addLiquiditySample();

    addReserveSample();

    await evaluateRisk();

  } catch (err) {
    console.error(
      "❌ Market loop:",
      err.message
    );
  }

}, 3000);

// ------------------------------------------------------------
// RESERVE LOOP
// ------------------------------------------------------------

setInterval(async () => {
  if (!watchedMint) {
    return;
  }

  try {
    if (
      quoteVault &&
      currentQuote !== null
    ) {
      addReserveSample();
    }

  } catch (err) {
    console.error(
      "❌ Reserve loop:",
      err.message
    );
  }

}, 1000);

// ------------------------------------------------------------
// WATCHDOG
// ------------------------------------------------------------

setInterval(async () => {
  if (!watchedMint) {
    return;
  }

  const age =
    Date.now() - lastDexUpdate;

  if (
    age > 30000
  ) {
    console.log(
      "⚠️ DexScreener non actualisé depuis",
      Math.round(age / 1000),
      "s"
    );
  }

  if (
    !onChainActive
  ) {
    console.log(
      "⚠️ On-chain inactif"
    );
  }

}, 15000);

// ------------------------------------------------------------
// START BOT
// ------------------------------------------------------------

bot.launch()
  .then(() => {
    console.log(
      "🛰️ RADAR SORTIE V5 démarré"
    );

    console.log(
      "📡 Helius RPC/WSS actif"
    );
  })
  .catch(err => {
    console.error(
      "❌ Bot launch:",
      err.message
    );

    process.exit(1);
  });

// ------------------------------------------------------------
// STOP PROPRE
// ------------------------------------------------------------

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
