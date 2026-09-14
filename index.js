const { Connection, PublicKey } = require("@solana/web3.js");
const { Telegraf } = require("telegraf");
const WebSocket = require("ws");

// ============================================================
// RADAR V6
// Détection précoce de dégradation structurelle PumpSwap
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  console.error("❌ Variables manquantes : BOT_TOKEN, CHAT_ID ou HELIUS_API_KEY");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, {
  commitment: "processed",
});

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

// ============================================================
// LAYOUT PUMPSWAP
// ============================================================

const BASE_VAULT_OFFSET = 139;
const QUOTE_VAULT_OFFSET = 171;
const VIRTUAL_QUOTE_OFFSET = 245;

// ============================================================
// RÉGLAGES
// ============================================================

const POLL_MS = 3000;
const BATCH_MS = 120;
const EVENT_HISTORY_MS = 30000;

// ============================================================
// ÉTAT
// ============================================================

const state = {
  mint: null,
  pool: null,

  baseVault: null,
  quoteVault: null,

  ws: null,
  wsReady: false,

  baseSub: null,
  quoteSub: null,
  logSub: null,

  wsReconnectTimer: null,
  wsPingTimer: null,

  pendingBase: null,
  pendingQuote: null,
  pendingTimer: null,

  baseRaw: null,
  quoteRaw: null,

  quoteSol: 0,

  virtualQuoteRaw: 0n,

  price: 0,
  liquidityUsd: 0,

  priceHistory: [],
  liquidityHistory: [],
  reserveHistory: [],
  events: [],

  localHigh: 0,

  lastOnchainAt: 0,
  lastDexAt: 0,

  dexErrors: 0,

  pollTimer: null,
  staleTimer: null,

  running: false,
  stopped: false,

  stopReason: null,

  lastAlertAt: 0,
  lastAlertKey: null,

  alertCount: 0,
};

// ============================================================
// OUTILS
// ============================================================

function now() {
  return Date.now();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pctChange(oldValue, newValue) {
  if (
    oldValue == null ||
    newValue == null ||
    oldValue === 0
  ) {
    return 0;
  }

  return ((newValue - oldValue) / oldValue) * 100;
}

function fmtPct(value) {
  if (!Number.isFinite(value)) {
    return "0.0%";
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function fmtSol(value) {
  if (!Number.isFinite(value)) {
    return "0.0000";
  }

  return value.toFixed(4);
}

function fmtUsd(value) {
  if (!Number.isFinite(value)) {
    return "0.00";
  }

  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ============================================================
// LECTURE U64
// ============================================================

function readU64LE(buffer, offset) {
  if (!buffer || offset + 8 > buffer.length) {
    return 0n;
  }

  return buffer.readBigUInt64LE(offset);
}

// ============================================================
// COMPTE SPL TOKEN
//
// Dans un compte Token Account SPL :
// amount = offset 64
//
// C'était une erreur importante de V5.
// ============================================================

function readSplTokenAccountAmount(buffer) {
  if (!buffer || buffer.length < 72) {
    return null;
  }

  return readU64LE(buffer, 64);
}

// ============================================================
// PUBKEY
// ============================================================

function readPubkey(buffer, offset) {
  if (!buffer || offset + 32 > buffer.length) {
    throw new Error("Pubkey impossible à lire");
  }

  return new PublicKey(
    buffer.subarray(offset, offset + 32)
  ).toBase58();
}

// ============================================================
// I128
// ============================================================

function readI128LE(buffer, offset) {
  if (!buffer || offset + 16 > buffer.length) {
    return 0n;
  }

  let value = 0n;

  for (let i = 0; i < 16; i++) {
    value |=
      BigInt(buffer[offset + i]) <<
      (8n * BigInt(i));
  }

  const signBit = 1n << 127n;

  if (value & signBit) {
    value -= 1n << 128n;
  }

  return value;
}

// ============================================================
// LAMPORTS -> SOL
// ============================================================

function lamportsToSol(raw) {
  if (raw == null) {
    return 0;
  }

  const whole = raw / 1000000000n;
  const remainder = raw % 1000000000n;

  return (
    Number(whole) +
    Number(remainder) / 1000000000
  );
}

// ============================================================
// DATA COMPTE
// ============================================================

function dataToBuffer(data) {
  if (!data) {
    return null;
  }

  if (Buffer.isBuffer(data)) {
    return data;
  }

  if (
    Array.isArray(data) &&
    typeof data[0] === "string"
  ) {
    try {
      return Buffer.from(data[0], "base64");
    } catch (_) {
      return null;
    }
  }

  if (typeof data === "string") {
    try {
      return Buffer.from(data, "base64");
    } catch (_) {
      return null;
    }
  }

  return null;
}

// ============================================================
// HISTORIQUES
// ============================================================

function trimHistory() {
  const priceCutoff =
    now() - 10 * 60 * 1000;

  const eventCutoff =
    now() - EVENT_HISTORY_MS;

  state.priceHistory =
    state.priceHistory.filter(
      x => x.t >= priceCutoff
    );

  state.liquidityHistory =
    state.liquidityHistory.filter(
      x => x.t >= priceCutoff
    );

  state.reserveHistory =
    state.reserveHistory.filter(
      x => x.t >= priceCutoff
    );

  state.events =
    state.events.filter(
      x => x.t >= eventCutoff
    );
}

function valueAtOrBefore(history, seconds) {
  const target =
    now() - seconds * 1000;

  let result = null;

  for (const item of history) {
    if (item.t <= target) {
      result = item;
    } else {
      break;
    }
  }

  return result;
}

function changeWithin(history, seconds) {
  if (!history.length) {
    return 0;
  }

  const old =
    valueAtOrBefore(history, seconds);

  if (!old) {
    return 0;
  }

  const current =
    history[history.length - 1];

  return pctChange(
    old.v,
    current.v
  );
}

// ============================================================
// PRIX SOUS SOMMET
// ============================================================

function getPriceDropFromHigh() {
  if (
    !state.price ||
    !state.localHigh
  ) {
    return 0;
  }

  if (state.price >= state.localHigh) {
    return 0;
  }

  return (
    1 -
    state.price / state.localHigh
  ) * 100;
}

// ============================================================
// DEXSCREENER
// ============================================================

function getPumpPair(data, mint) {
  const pairs =
    data?.pairs || [];

  const candidates =
    pairs.filter(pair => {
      const base =
        pair?.baseToken?.address;

      const quote =
        pair?.quoteToken?.address;

      return (
        (base === mint &&
          quote === SOL_MINT) ||
        (quote === mint &&
          base === SOL_MINT)
      );
    });

  candidates.sort((a, b) => {
    const la =
      Number(a?.liquidity?.usd || 0);

    const lb =
      Number(b?.liquidity?.usd || 0);

    return lb - la;
  });

  return candidates[0] || null;
}

async function fetchDex() {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${state.mint}`;

  const response =
    await fetch(url, {
      headers: {
        accept: "application/json",
      },
    });

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const pair =
    getPumpPair(
      data,
      state.mint
    );

  if (!pair) {
    throw new Error(
      "Paire PumpSwap introuvable"
    );
  }

  if (pair.pairAddress) {
    state.pool =
      pair.pairAddress;
  }

  state.price =
    Number(pair.priceUsd || 0);

  state.liquidityUsd =
    Number(
      pair.liquidity?.usd || 0
    );

  state.lastDexAt =
    now();

  state.dexErrors = 0;

  if (state.price > 0) {
    if (
      state.localHigh === 0 ||
      state.price > state.localHigh
    ) {
      state.localHigh =
        state.price;
    }

    state.priceHistory.push({
      t: now(),
      v: state.price,
    });
  }

  if (state.liquidityUsd > 0) {
    state.liquidityHistory.push({
      t: now(),
      v: state.liquidityUsd,
    });
  }

  trimHistory();

  return pair;
}

// ============================================================
// DÉCOUVERTE DU POOL
// ============================================================

async function discoverPool() {
  console.log(
    "🔎 Recherche du pool PumpSwap..."
  );

  const pair =
    await fetchDex();

  if (!state.pool) {
    throw new Error(
      "Adresse du pool introuvable"
    );
  }

  console.log(
    `🏊 Pool : ${state.pool}`
  );

  const info =
    await connection.getAccountInfo(
      new PublicKey(state.pool),
      "processed"
    );

  if (!info?.data) {
    throw new Error(
      "Compte Pool illisible"
    );
  }

  const data =
    Buffer.from(info.data);

  if (
    data.length <
    VIRTUAL_QUOTE_OFFSET + 16
  ) {
    throw new Error(
      `Pool trop court : ${data.length}`
    );
  }

  state.baseVault =
    readPubkey(
      data,
      BASE_VAULT_OFFSET
    );

  state.quoteVault =
    readPubkey(
      data,
      QUOTE_VAULT_OFFSET
    );

  state.virtualQuoteRaw =
    readI128LE(
      data,
      VIRTUAL_QUOTE_OFFSET
    );

  console.log(
    `🪙 Base vault : ${state.baseVault}`
  );

  console.log(
    `💧 Quote vault : ${state.quoteVault}`
  );

  console.log(
    `💠 Virtual quote : ${
      fmtSol(
        lamportsToSol(
          state.virtualQuoteRaw > 0n
            ? state.virtualQuoteRaw
            : 0n
        )
      )
    } SOL`
  );

  return pair;
}

// ============================================================
// LECTURE DES VAULTS
// ============================================================

async function readVaults() {
  const keys = [
    new PublicKey(
      state.baseVault
    ),
    new PublicKey(
      state.quoteVault
    ),
  ];

  const infos =
    await connection.getMultipleAccountsInfo(
      keys,
      "processed"
    );

  const baseBuffer =
    dataToBuffer(
      infos[0]?.data
    );

  const quoteBuffer =
    dataToBuffer(
      infos[1]?.data
    );

  if (
    !baseBuffer ||
    !quoteBuffer
  ) {
    throw new Error(
      "Vaults illisibles"
    );
  }

  const base =
    readSplTokenAccountAmount(
      baseBuffer
    );

  const quote =
    readSplTokenAccountAmount(
      quoteBuffer
    );

  if (
    base == null ||
    quote == null
  ) {
    throw new Error(
      "Montant SPL illisible"
    );
  }

  state.baseRaw =
    base;

  state.quoteRaw =
    quote;

  state.quoteSol =
    lamportsToSol(
      quote
    );

  state.reserveHistory.push({
    t: now(),
    v: state.quoteSol,
  });

  state.lastOnchainAt =
    now();

  trimHistory();

  return {
    base,
    quote,
  };
}

// ============================================================
// ÉVÉNEMENTS VAULTS
// ============================================================

function addEvent(
  baseDelta,
  quoteDelta
) {
  const absoluteQuote =
    quoteDelta < 0n
      ? -quoteDelta
      : quoteDelta;

  const quoteSol =
    lamportsToSol(
      absoluteQuote
    );

  // Poussière ignorée.
  if (quoteSol < 0.01) {
    return;
  }

  let type =
    "OTHER";

  // Base token sort du pool
  // + SOL entre dans le pool
  // = SELL
  if (
    baseDelta < 0n &&
    quoteDelta > 0n
  ) {
    type = "SELL";
  }

  // Base token entre dans le pool
  // + SOL sort du pool
  // = BUY
  else if (
    baseDelta > 0n &&
    quoteDelta < 0n
  ) {
    type = "BUY";
  }

  // Les deux réserves diminuent
  // = retrait potentiel
  else if (
    baseDelta < 0n &&
    quoteDelta < 0n
  ) {
    type = "WITHDRAWAL";
  }

  // Les deux augmentent
  // = ajout de liquidité potentiel
  else if (
    baseDelta > 0n &&
    quoteDelta > 0n
  ) {
    type = "LIQUIDITY_ADD";
  }

  state.events.push({
    t: now(),
    type,
    quoteSol,
    baseDelta,
    quoteDelta,
  });

  trimHistory();
}

// ============================================================
// BATCH VAULTS
// ============================================================

function flushVaultBatch() {
  state.pendingTimer =
    null;

  const base =
    state.pendingBase;

  const quote =
    state.pendingQuote;

  state.pendingBase =
    null;

  state.pendingQuote =
    null;

  if (
    base == null ||
    quote == null
  ) {
    return;
  }

  if (
    state.baseRaw == null ||
    state.quoteRaw == null
  ) {
    state.baseRaw =
      base;

    state.quoteRaw =
      quote;

    state.quoteSol =
      lamportsToSol(
        quote
      );

    state.reserveHistory.push({
      t: now(),
      v: state.quoteSol,
    });

    state.lastOnchainAt =
      now();

    return;
  }

  const baseDelta =
    base - state.baseRaw;

  const quoteDelta =
    quote - state.quoteRaw;

  state.baseRaw =
    base;

  state.quoteRaw =
    quote;

  state.quoteSol =
    lamportsToSol(
      quote
    );

  state.reserveHistory.push({
    t: now(),
    v: state.quoteSol,
  });

  state.lastOnchainAt =
    now();

  addEvent(
    baseDelta,
    quoteDelta
  );

  trimHistory();
}

function queueVaultUpdate(
  which,
  value
) {
  if (which === "base") {
    state.pendingBase =
      value;
  } else {
    state.pendingQuote =
      value;
  }

  if (!state.pendingTimer) {
    state.pendingTimer =
      setTimeout(
        flushVaultBatch,
        BATCH_MS
      );
  }
}

// ============================================================
// ÉVÉNEMENTS
// ============================================================

function eventsWithin(
  seconds,
  type = null
) {
  const cutoff =
    now() -
    seconds * 1000;

  return state.events.filter(
    event =>
      event.t >= cutoff &&
      (!type ||
        event.type === type)
  );
}

function sumEvents(
  seconds,
  type
) {
  return eventsWithin(
    seconds,
    type
  ).reduce(
    (sum, event) =>
      sum + event.quoteSol,
    0
  );
}

function countEvents(
  seconds,
  type
) {
  return eventsWithin(
    seconds,
    type
  ).length;
}

function sellRatio(seconds) {
  const events =
    eventsWithin(seconds);

  let sell = 0;
  let buy = 0;

  for (const event of events) {
    if (event.type === "SELL") {
      sell += event.quoteSol;
    }

    if (event.type === "BUY") {
      buy += event.quoteSol;
    }
  }

  const total =
    sell + buy;

  if (total <= 0) {
    return 0;
  }

  return (
    sell / total
  ) * 100;
}

// ============================================================
// CALCUL DU RISQUE V6
// ============================================================

function calculateRisk() {
  const price5 =
    changeWithin(
      state.priceHistory,
      5
    );

  const price10 =
    changeWithin(
      state.priceHistory,
      10
    );

  const liquidity5 =
    changeWithin(
      state.liquidityHistory,
      5
    );

  const liquidity10 =
    changeWithin(
      state.liquidityHistory,
      10
    );

  const reserve5 =
    changeWithin(
      state.reserveHistory,
      5
    );

  const reserve10 =
    changeWithin(
      state.reserveHistory,
      10
    );

  const sell1 =
    sumEvents(
      1,
      "SELL"
    );

  const sell3 =
    sumEvents(
      3,
      "SELL"
    );

  const sell5 =
    sumEvents(
      5,
      "SELL"
    );

  const sell10 =
    sumEvents(
      10,
      "SELL"
    );

  const sellCount10 =
    countEvents(
      10,
      "SELL"
    );

  const ratio10 =
    sellRatio(10);

  const withdrawal10 =
    sumEvents(
      10,
      "WITHDRAWAL"
    );

  const priceBelowHigh =
    getPriceDropFromHigh();

  let score = 0;

  const signals = [];

  // ==========================================================
  // 1. VENTES ABSORBÉES
  //
  // Si le prix continue à monter et que la réserve/liquidité
  // restent stables, les SELL ne sont pas considérés comme
  // dangereux.
  // ==========================================================

  const makingHigh =
    state.price > 0 &&
    state.localHigh > 0 &&
    state.price >=
      state.localHigh * 0.998;

  const healthyMarket =
    price10 >= 0 &&
    liquidity10 > -1 &&
    reserve10 > -1;

  if (
    ratio10 >= 85 &&
    sell10 >= 2
  ) {
    if (
      makingHigh &&
      healthyMarket
    ) {
      score += 3;
    } else {
      score += 6;
    }
  }

  // ==========================================================
  // 2. SELL + BAISSE DU PRIX
  // ==========================================================

  if (
    sell5 >= 5 &&
    price5 < -0.5
  ) {
    score += 15;

    signals.push(
      "SELL + prix en baisse"
    );
  }

  if (
    sell10 >= 10 &&
    price10 < -1
  ) {
    score += 12;

    signals.push(
      "pression vendeuse non absorbée"
    );
  }

  if (
    sell10 >= 20 &&
    price10 < -2
  ) {
    score += 8;

    signals.push(
      "accélération vendeuse toxique"
    );
  }

  // Beaucoup de SELL mais prix toujours positif.
  if (
    sellCount10 >= 20 &&
    price10 >= 0
  ) {
    score -= 3;
  }

  // ==========================================================
  // 3. ÉCHEC DU SOMMET
  // ==========================================================

  if (
    priceBelowHigh >= 1
  ) {
    score += 8;

    signals.push(
      "prix sous le sommet"
    );
  }

  if (
    priceBelowHigh >= 2
  ) {
    score += 10;

    signals.push(
      "perte du sommet local"
    );
  }

  if (
    price10 < -1
  ) {
    score += 10;

    signals.push(
      "prix commence à décrocher"
    );
  }

  if (
    price10 < -3
  ) {
    score += 10;

    signals.push(
      "décrochage rapide du prix"
    );
  }

  // ==========================================================
  // 4. RÉSERVE ON-CHAIN
  //
  // PRIORITÉ V6
  // ==========================================================

  if (
    reserve5 <= -1
  ) {
    score += 12;

    signals.push(
      "réserve WSOL en baisse"
    );
  }

  if (
    reserve10 <= -2
  ) {
    score += 15;

    signals.push(
      "baisse anormale de réserve"
    );
  }

  if (
    reserve10 <= -5
  ) {
    score += 20;

    signals.push(
      "forte sortie de réserve"
    );
  }

  if (
    reserve10 <= -15
  ) {
    score += 30;

    signals.push(
      "sortie structurelle de réserve"
    );
  }

  // ==========================================================
  // 5. LIQUIDITÉ
  // ==========================================================

  if (
    liquidity10 <= -2
  ) {
    score += 8;

    signals.push(
      "liquidité en baisse"
    );
  }

  if (
    liquidity10 <= -5
  ) {
    score += 15;

    signals.push(
      "dégradation rapide de liquidité"
    );
  }

  if (
    liquidity10 <= -15
  ) {
    score += 25;

    signals.push(
      "liquidité fortement retirée"
    );
  }

  // ==========================================================
  // 6. RETRAIT STRUCTUREL
  // ==========================================================

  if (
    withdrawal10 >= 1
  ) {
    score += 25;

    signals.push(
      "retrait de liquidité détecté"
    );
  }

  if (
    withdrawal10 >= 10
  ) {
    score += 30;

    signals.push(
      "retrait structurel important"
    );
  }

  // ==========================================================
  // 7. CONFLUENCE
  // ==========================================================

  const negativeFactors = [
    price10 < -1,
    reserve10 < -1,
    liquidity10 < -1,
    priceBelowHigh >= 1,
    sell10 >= 10 &&
      ratio10 >= 75,
  ].filter(Boolean).length;

  if (
    negativeFactors >= 3
  ) {
    score += 15;

    signals.push(
      "confluence de signaux"
    );
  }

  score =
    clamp(
      Math.round(score),
      0,
      100
    );

  // ==========================================================
  // NIVEAUX
  // ==========================================================

  let level =
    "NORMAL";

  if (
    score >= 80
  ) {
    level =
      "URGENT";
  } else if (
    score >= 60
  ) {
    level =
      "CRITIQUE";
  } else if (
    score >= 40
  ) {
    level =
      "DANGER";
  } else if (
    score >= 25
  ) {
    level =
      "SURVEILLANCE";
  }

  // ==========================================================
  // CRASH CONFIRMÉ
  //
  // Après une vraie chute, on arrête complètement le radar.
  // ==========================================================

  const crash =
    priceBelowHigh >= 50 ||
    liquidity10 <= -50 ||
    reserve10 <= -50;

  return {
    score,
    level,

    price5,
    price10,

    liquidity5,
    liquidity10,

    reserve5,
    reserve10,

    sell1,
    sell3,
    sell5,
    sell10,

    sellCount10,
    ratio10,

    withdrawal10,

    priceBelowHigh,

    signals: [
      ...new Set(signals),
    ],

    crash,
  };
}

// ============================================================
// ALERTES
// ============================================================

function alertTitle(level) {
  if (
    level === "URGENT"
  ) {
    return "🚨 SORTIE URGENTE";
  }

  if (
    level === "CRITIQUE"
  ) {
    return "🔴 CRITIQUE : RISQUE DE CHUTE";
  }

  if (
    level === "DANGER"
  ) {
    return "🟠 DANGER : DÉGRADATION";
  }

  return "🟡 SURVEILLANCE";
}

function buildAlert(risk) {
  return `${alertTitle(risk.level)}

Score risque : ${risk.score}/100

Prix : $${state.price.toFixed(8)}
Liquidité : $${fmtUsd(state.liquidityUsd)}

SELL 1s : ${fmtSol(risk.sell1)} SOL
SELL 3s : ${fmtSol(risk.sell3)} SOL
SELL 5s : ${fmtSol(risk.sell5)} SOL
SELL 10s : ${fmtSol(risk.sell10)} SOL
SELL ratio 10s : ${risk.ratio10.toFixed(1)}%
SELL / 10s : ${risk.sellCount10}

Réserve WSOL :
${fmtSol(state.quoteSol)} SOL

Réserve 5s :
${fmtPct(risk.reserve5)}

Réserve 10s :
${fmtPct(risk.reserve10)}

Prix sous sommet :
${risk.priceBelowHigh.toFixed(1)}%

Liquidité 5s :
${fmtPct(risk.liquidity5)}

Liquidité 10s :
${fmtPct(risk.liquidity10)}

⚠️ Signaux :
${
  risk.signals.length
    ? risk.signals
        .map(x => `• ${x}`)
        .join("\n")
    : "• aucun signal"
}

📡 RADAR V6`;
}

// ============================================================
// ANTI-SPAM
// ============================================================

function shouldAlert(risk) {
  if (
    state.stopped
  ) {
    return false;
  }

  if (
    risk.score < 25
  ) {
    return false;
  }

  const elapsed =
    now() -
    state.lastAlertAt;

  const cooldown =
    risk.level === "URGENT" ||
    risk.level === "CRITIQUE"
      ? 15000
      : 45000;

  if (
    elapsed < cooldown
  ) {
    return false;
  }

  const key = [
    risk.level,
    Math.floor(
      risk.score / 10
    ),
    risk.signals
      .slice(0, 2)
      .join("|"),
  ].join(":");

  if (
    key === state.lastAlertKey &&
    elapsed < 90000
  ) {
    return false;
  }

  return true;
}

async function sendAlert(risk) {
  if (
    !shouldAlert(risk)
  ) {
    return;
  }

  state.lastAlertAt =
    now();

  state.lastAlertKey = [
    risk.level,
    Math.floor(
      risk.score / 10
    ),
    risk.signals
      .slice(0, 2)
      .join("|"),
  ].join(":");

  state.alertCount++;

  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      buildAlert(risk)
    );

    console.log(
      `📨 Telegram : ${risk.level} ${risk.score}/100`
    );
  } catch (error) {
    console.error(
      "❌ Telegram :",
      error.message
    );
  }
}

// ============================================================
// ARRÊT AUTOMATIQUE
// ============================================================

async function stopRadar(
  reason,
  sendMessage = true
) {
  if (
    state.stopped
  ) {
    return;
  }

  state.stopped =
    true;

  state.running =
    false;

  state.stopReason =
    reason;

  if (
    state.pollTimer
  ) {
    clearInterval(
      state.pollTimer
    );

    state.pollTimer =
      null;
  }

  if (
    state.staleTimer
  ) {
    clearInterval(
      state.staleTimer
    );

    state.staleTimer =
      null;
  }

  if (
    state.wsReconnectTimer
  ) {
    clearTimeout(
      state.wsReconnectTimer
    );

    state.wsReconnectTimer =
      null;
  }

  if (
    state.wsPingTimer
  ) {
    clearInterval(
      state.wsPingTimer
    );

    state.wsPingTimer =
      null;
  }

  try {
    if (
      state.ws &&
      state.ws.readyState ===
        WebSocket.OPEN
    ) {
      state.ws.close();
    }
  } catch (_) {}

  state.ws =
    null;

  state.wsReady =
    false;

  console.log(
    `🛑 RADAR ARRÊTÉ : ${reason}`
  );

  if (!sendMessage) {
    return;
  }

  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      `🛑 RADAR V6 ARRÊTÉ

🚨 Chute brutale confirmée.

${reason}

Le token n'est plus surveillé.

Le radar s'arrête automatiquement afin d'éviter les alertes répétitives après le crash.`
    );
  } catch (error) {
    console.error(
      "❌ Telegram arrêt :",
      error.message
    );
  }
}

// ============================================================
// WEBSOCKET HELIUS
// ============================================================

function connectWebSocket() {
  if (
    state.stopped
  ) {
    return;
  }

  if (state.ws) {
    try {
      state.ws.close();
    } catch (_) {}
  }

  const ws =
    new WebSocket(
      WS_URL
    );

  state.ws =
    ws;

  ws.on(
    "open",
    () => {
      console.log(
        "🔌 Helius WSS connecté"
      );

      state.wsReady =
        true;

      const baseRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "accountSubscribe",
        params: [
          state.baseVault,
          {
            commitment:
              "processed",
            encoding:
              "base64",
          },
        ],
      };

      const quoteRequest = {
        jsonrpc: "2.0",
        id: 2,
        method: "accountSubscribe",
        params: [
          state.quoteVault,
          {
            commitment:
              "processed",
            encoding:
              "base64",
          },
        ],
      };

      const logsRequest = {
        jsonrpc: "2.0",
        id: 3,
        method: "logsSubscribe",
        params: [
          {
            mentions: [
              state.pool,
            ],
          },
          {
            commitment:
              "processed",
          },
        ],
      };

      ws.send(
        JSON.stringify(
          baseRequest
        )
      );

      ws.send(
        JSON.stringify(
          quoteRequest
        )
      );

      ws.send(
        JSON.stringify(
          logsRequest
        )
      );

      if (
        state.wsPingTimer
      ) {
        clearInterval(
          state.wsPingTimer
        );
      }

      state.wsPingTimer =
        setInterval(
          () => {
            if (
              state.ws &&
              state.ws.readyState ===
                WebSocket.OPEN
            ) {
              try {
                state.ws.ping();
              } catch (_) {}
            }
          },
          15000
        );
    }
  );

  ws.on(
    "message",
    raw => {
      try {
        const message =
          JSON.parse(
            raw.toString()
          );

        // Réponses des subscriptions
        if (
          message.id === 1 &&
          typeof message.result ===
            "number"
        ) {
          state.baseSub =
            message.result;

          return;
        }

        if (
          message.id === 2 &&
          typeof message.result ===
            "number"
        ) {
          state.quoteSub =
            message.result;

          return;
        }

        if (
          message.id === 3 &&
          typeof message.result ===
            "number"
        ) {
          state.logSub =
            message.result;

          return;
        }

        if (
          message.method !==
          "accountNotification"
        ) {
          return;
        }

        const subscription =
          message?.params?.subscription;

        const data =
          message?.params?.result?.value?.data;

        const buffer =
          dataToBuffer(data);

        if (!buffer) {
          return;
        }

        const amount =
          readSplTokenAccountAmount(
            buffer
          );

        if (
          amount == null
        ) {
          return;
        }

        if (
          subscription ===
          state.baseSub
        ) {
          queueVaultUpdate(
            "base",
            amount
          );
        }

        else if (
          subscription ===
          state.quoteSub
        ) {
          queueVaultUpdate(
            "quote",
            amount
          );
        }

      } catch (error) {
        console.error(
          "⚠️ Message WSS :",
          error.message
        );
      }
    }
  );

  ws.on(
    "error",
    error => {
      console.error(
        "❌ Helius WSS :",
        error.message
      );
    }
  );

  ws.on(
    "close",
    () => {
      state.wsReady =
        false;

      if (
        state.wsPingTimer
      ) {
        clearInterval(
          state.wsPingTimer
        );

        state.wsPingTimer =
          null;
      }

      if (
        state.stopped
      ) {
        return;
      }

      console.log(
        "🔌 WSS fermé, reconnexion dans 2 secondes..."
      );

      clearTimeout(
        state.wsReconnectTimer
      );

      state.wsReconnectTimer =
        setTimeout(
          connectWebSocket,
          2000
        );
    }
  );
}

// ============================================================
// WATCHDOG WSS
// ============================================================

function staleWatchdog() {
  if (
    state.stopped
  ) {
    return;
  }

  if (
    state.lastOnchainAt > 0 &&
    now() -
      state.lastOnchainAt >
      30000
  ) {
    console.log(
      "⚠️ Flux on-chain silencieux > 30s"
    );

    readVaults()
      .catch(
        error =>
          console.error(
            "⚠️ Relecture vaults :",
            error.message
          )
      );
  }
}

// ============================================================
// TICK PRINCIPAL
// ============================================================

async function marketTick() {
  if (
    state.stopped
  ) {
    return;
  }

  try {
    await fetchDex();

    const risk =
      calculateRisk();

    console.log(
      `📊 ${risk.level} ${risk.score}/100 | ` +
      `Prix $${state.price.toFixed(8)} | ` +
      `Liq $${Math.round(state.liquidityUsd)} | ` +
      `Réserve ${fmtSol(state.quoteSol)} SOL | ` +
      `R10 ${risk.reserve10.toFixed(2)}% | ` +
      `High ${risk.priceBelowHigh.toFixed(2)}%`
    );

    // ========================================================
    // CRASH AVANT TOUTE ALERTE
    // ========================================================

    if (
      risk.crash
    ) {
      await stopRadar(
        `Prix sous sommet : ${risk.priceBelowHigh.toFixed(1)}%
Liquidité 10s : ${fmtPct(risk.liquidity10)}
Réserve 10s : ${fmtPct(risk.reserve10)}`,
        true
      );

      return;
    }

    await sendAlert(
      risk
    );

  } catch (error) {
    state.dexErrors++;

    console.error(
      "⚠️ Tick :",
      error.message
    );

    // Le radar on-chain continue même si DexScreener tombe.
    if (
      state.dexErrors >= 5
    ) {
      console.log(
        "⚠️ DexScreener indisponible. Surveillance on-chain maintenue."
      );

      state.dexErrors =
        0;
    }
  }
}

// ============================================================
// DÉMARRAGE RADAR
// ============================================================

async function startRadar(
  mint
) {
  if (
    state.running
  ) {
    await stopRadar(
      "Nouveau token demandé",
      false
    );
  }

  // Reset complet
  state.mint =
    mint;

  state.pool =
    null;

  state.baseVault =
    null;

  state.quoteVault =
    null;

  state.baseSub =
    null;

  state.quoteSub =
    null;

  state.logSub =
    null;

  state.baseRaw =
    null;

  state.quoteRaw =
    null;

  state.quoteSol =
    0;

  state.virtualQuoteRaw =
    0n;

  state.price =
    0;

  state.liquidityUsd =
    0;

  state.priceHistory =
    [];

  state.liquidityHistory =
    [];

  state.reserveHistory =
    [];

  state.events =
    [];

  state.localHigh =
    0;

  state.lastOnchainAt =
    0;

  state.lastDexAt =
    0;

  state.dexErrors =
    0;

  state.lastAlertAt =
    0;

  state.lastAlertKey =
    null;

  state.alertCount =
    0;

  state.pendingBase =
    null;

  state.pendingQuote =
    null;

  state.stopped =
    false;

  state.stopReason =
    null;

  state.running =
    true;

  console.log(
    `\n🚀 RADAR V6 : ${mint}`
  );

  // Découverte
  await discoverPool();

  // Lecture initiale
  await readVaults();

  // Connexion temps réel
  connectWebSocket();

  // Premier tick
  await marketTick();

  // Surveillance Dex
  state.pollTimer =
    setInterval(
      marketTick,
      POLL_MS
    );

  // Surveillance WSS
  state.staleTimer =
    setInterval(
      staleWatchdog,
      10000
    );

  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      `🛰️ RADAR V6 ACTIVÉ

Token :
${mint}

Pool :
${state.pool}

Réserve initiale :
${fmtSol(state.quoteSol)} SOL

Le radar surveille :

• ventes absorbées
• ventes toxiques
• prix sous sommet
• réserve WSOL
• retraits structurels
• liquidité
• confluence de signaux

🛑 Arrêt automatique après crash confirmé.`
    );
  } catch (error) {
    console.error(
      "Telegram démarrage :",
      error.message
    );
  }
}

// ============================================================
// VALIDATION TOKEN
// ============================================================

function isValidMint(
  mint
) {
  try {
    new PublicKey(
      mint
    );

    return (
      mint.length >= 32 &&
      mint.length <= 44
    );

  } catch (_) {
    return false;
  }
}

// ============================================================
// TELEGRAM
// ============================================================

bot.start(
  ctx => {
    ctx.reply(
      `🛰️ RADAR V6

Commandes :

/watch ADRESSE_TOKEN
/status
/unwatch
/help`
    );
  }
);

bot.help(
  ctx => {
    ctx.reply(
      `🛰️ RADAR V6

/watch ADRESSE_TOKEN
→ démarre la surveillance

/status
→ affiche l'état actuel

/unwatch
→ arrête le radar

La V6 cherche surtout les dégradations structurelles et ne considère plus un simple ratio SELL élevé comme un crash.`
    );
  }
);

// ============================================================
// /WATCH
// ============================================================

bot.command(
  "watch",
  async ctx => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    const mint =
      parts[1];

    if (
      !mint ||
      !isValidMint(mint)
    ) {
      await ctx.reply(
        "❌ Adresse du token invalide."
      );

      return;
    }

    try {
      await ctx.reply(
        "🔎 Recherche du pool PumpSwap..."
      );

      await startRadar(
        mint
      );

    } catch (error) {
      console.error(
        "❌ WATCH :",
        error
      );

      await ctx.reply(
        `❌ Impossible de démarrer le radar.

${error.message}`
      );
    }
  }
);

// ============================================================
// /UNWATCH
// ============================================================

bot.command(
  "unwatch",
  async ctx => {
    if (
      !state.running
    ) {
      await ctx.reply(
        "ℹ️ Aucun token n'est actuellement surveillé."
      );

      return;
    }

    await stopRadar(
      "Arrêt manuel",
      false
    );

    await ctx.reply(
      "🛑 Radar arrêté."
    );
  }
);

// ============================================================
// /STATUS
// ============================================================

bot.command(
  "status",
  async ctx => {
    if (
      !state.mint
    ) {
      await ctx.reply(
        "ℹ️ Aucun token surveillé."
      );

      return;
    }

    if (
      state.stopped
    ) {
      await ctx.reply(
        `🛑 RADAR ARRÊTÉ

Token :
${state.mint}

Raison :
${state.stopReason || "arrêt automatique"}`
      );

      return;
    }

    const risk =
      calculateRisk();

    await ctx.reply(
      `🛰️ RADAR V6

Token :
${state.mint}

État :
${risk.level}

Score :
${risk.score}/100

Prix :
$${state.price.toFixed(8)}

Liquidité :
$${fmtUsd(state.liquidityUsd)}

Réserve WSOL :
${fmtSol(state.quoteSol)} SOL

Réserve 10s :
${fmtPct(risk.reserve10)}

Prix sous sommet :
${risk.priceBelowHigh.toFixed(1)}%

SELL 10s :
${fmtSol(risk.sell10)} SOL

Ratio SELL :
${risk.ratio10.toFixed(1)}%

Signaux :
${
  risk.signals.length
    ? risk.signals.join(" | ")
    : "aucun"
}`
    );
  }
);

// ============================================================
// DÉMARRAGE BOT
// ============================================================

bot.launch()
  .then(
    () =>
      console.log(
        "🤖 Telegram RADAR V6 démarré"
      )
  )
  .catch(
    error => {
      console.error(
        "❌ Bot Telegram :",
        error
      );

      process.exit(1);
    }
  );

// ============================================================
// ARRÊT PROPRE
// ============================================================

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
