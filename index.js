const { Telegraf } = require("telegraf");

// ============================================================
// RADAR TRADING V2 - MODE TEST
// ============================================================
//
// ⚠️ CETTE VERSION NE FAIT AUCUN TRADE RÉEL.
//
// STRATÉGIE :
// 1. Achat simulé de 1 $
// 2. Objectif +50 %
// 3. Vente simulée si objectif atteint
// 4. Bénéfice conservé, jamais réinvesti
// 5. Nouveau cycle de 1 $
// 6. Surveillance permanente de la liquidité
// 7. Sortie d'urgence si la liquidité s'effondre
// 8. Arrêt définitif après crash
//
// ============================================================

// ------------------------------------------------------------
// CONFIGURATION
// ------------------------------------------------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN manquant.");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("❌ CHAT_ID manquant.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ------------------------------------------------------------
// PARAMÈTRES DE LA STRATÉGIE
// ------------------------------------------------------------

const CAPITAL_PER_CYCLE_USD = 10.00;
const TARGET_NET_PERCENT = 5.00;

// ------------------------------------------------------------
// PROTECTION LIQUIDITÉ
// ------------------------------------------------------------

// Surveillance toutes les 2 secondes.
const POLL_INTERVAL_MS = 2_000;

// Historique conservé.
const HISTORY_MAX_MS = 120_000;

// Fenêtre courte pour la protection.
const LIQUIDITY_WINDOW_MS = 10_000;

// Niveaux d'urgence.
const LIQUIDITY_WARNING_PERCENT = -20;
const LIQUIDITY_DANGER_PERCENT = -35;
const LIQUIDITY_CRITICAL_PERCENT = -50;

// Crash immédiat si disparition quasi totale.
const LIQUIDITY_ZERO_USD = 1;

// Crash prix classique.
const CRASH_PRICE_DROP_PERCENT = -20;

// ------------------------------------------------------------
// ETAT
// ------------------------------------------------------------

let trading = false;
let stoppedByCrash = false;

let watchedMint = null;

let timer = null;
let requestInProgress = false;

let market = {
  priceUsd: null,
  liquidityUsd: null,
  pairAddress: null,
  dexId: null,
  updatedAt: 0
};

let history = [];

let strategy = {
  state: "IDLE",

  cycle: 0,

  tokensHeld: 0,

  entryPrice: 0,
  entryTime: 0,

  realizedProfit: 0,

  totalInvested: 0,
  totalReturned: 0,

  completedCycles: 0,

  lastBuyPrice: 0,
  lastSellPrice: 0,

  lastActionAt: 0,

  crashReason: null
};

// ------------------------------------------------------------
// OUTILS
// ------------------------------------------------------------

function fmtUsd(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  if (value >= 1) {
    return `$${value.toFixed(4)}`;
  }

  if (value >= 0.01) {
    return `$${value.toFixed(6)}`;
  }

  return `$${value.toFixed(10)}`;
}

function fmtMoney(value) {
  if (!Number.isFinite(value)) {
    return "$0.00";
  }

  return `$${value.toFixed(4)}`;
}

function fmtPercent(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function shortenMint(mint) {
  if (!mint) {
    return "N/A";
  }

  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

function getChatId(ctx) {
  return String(ctx.chat.id);
}

function isAuthorized(ctx) {
  return getChatId(ctx) === String(CHAT_ID);
}

async function send(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text);
  } catch (err) {
    console.error(
      "❌ Telegram send error:",
      err.message
    );
  }
}

// ------------------------------------------------------------
// DEXSCREENER
// ------------------------------------------------------------

async function fetchPumpSwapMarket(mint) {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;

  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 8000);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `DexScreener HTTP ${response.status}`
      );
    }

    const data = await response.json();

    const pairs = Array.isArray(data.pairs)
      ? data.pairs
      : [];

    const pumpPairs = pairs.filter(pair => {
      return String(pair.dexId || "").toLowerCase() === "pumpswap";
    });

    if (pumpPairs.length === 0) {
      throw new Error(
        "Aucune paire PumpSwap trouvée."
      );
    }

    pumpPairs.sort((a, b) => {
      const liqA =
        Number(a?.liquidity?.usd || 0);

      const liqB =
        Number(b?.liquidity?.usd || 0);

      return liqB - liqA;
    });

    const pair = pumpPairs[0];

    const priceUsd =
      Number(pair.priceUsd);

    const liquidityUsd =
      Number(pair?.liquidity?.usd || 0);

    if (
      !Number.isFinite(priceUsd) ||
      priceUsd <= 0
    ) {
      throw new Error(
        "Prix PumpSwap invalide."
      );
    }

    return {
      priceUsd,
      liquidityUsd,
      pairAddress:
        pair.pairAddress || null,
      dexId:
        pair.dexId || "pumpswap"
    };

  } finally {
    clearTimeout(timeout);
  }
}

// ------------------------------------------------------------
// HISTORIQUE
// ------------------------------------------------------------

function addMarketPoint() {
  if (
    !Number.isFinite(market.priceUsd) ||
    !Number.isFinite(market.liquidityUsd)
  ) {
    return;
  }

  const now = Date.now();

  history.push({
    time: now,
    price: market.priceUsd,
    liquidity: market.liquidityUsd
  });

  const cutoff =
    now - HISTORY_MAX_MS;

  history = history.filter(
    point => point.time >= cutoff
  );
}

function getOldestPointWithin(windowMs) {
  const now = Date.now();
  const target =
    now - windowMs;

  let candidate = null;

  for (const point of history) {
    if (point.time <= target) {
      candidate = point;
    }
  }

  if (candidate) {
    return candidate;
  }

  return history.length > 0
    ? history[0]
    : null;
}

function percentageChange(
  current,
  previous
) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous <= 0
  ) {
    return null;
  }

  return (
    ((current - previous) / previous) *
    100
  );
}

function getPriceChange(windowMs) {
  const old =
    getOldestPointWithin(windowMs);

  if (!old) {
    return null;
  }

  return percentageChange(
    market.priceUsd,
    old.price
  );
}

function getLiquidityChange(windowMs) {
  const old =
    getOldestPointWithin(windowMs);

  if (!old) {
    return null;
  }

  return percentageChange(
    market.liquidityUsd,
    old.liquidity
  );
}

// ------------------------------------------------------------
// ANALYSE DE LA LIQUIDITÉ
// ------------------------------------------------------------

function analyseLiquidity() {
  const change =
    getLiquidityChange(
      LIQUIDITY_WINDOW_MS
    );

  const reasons = [];

  if (
    Number.isFinite(change) &&
    change <= LIQUIDITY_CRITICAL_PERCENT
  ) {
    reasons.push(
      `liquidité ${fmtPercent(change)} sur ~10s`
    );
  }

  if (
    Number.isFinite(change) &&
    change <= LIQUIDITY_DANGER_PERCENT
  ) {
    reasons.push(
      `forte baisse de liquidité ${fmtPercent(change)}`
    );
  }

  if (
    Number.isFinite(change) &&
    change <= LIQUIDITY_WARNING_PERCENT
  ) {
    reasons.push(
      `baisse rapide de liquidité ${fmtPercent(change)}`
    );
  }

  if (
    Number.isFinite(market.liquidityUsd) &&
    market.liquidityUsd <= LIQUIDITY_ZERO_USD
  ) {
    reasons.push(
      "liquidité pratiquement inexistante"
    );
  }

  return {
    change,
    reasons
  };
}

// ------------------------------------------------------------
// DETECTION DU CRASH
// ------------------------------------------------------------

function detectCrash() {
  const priceChange =
    getPriceChange(
      LIQUIDITY_WINDOW_MS
    );

  const liquidity =
    analyseLiquidity();

  const reasons = [];

  // Liquidité pratiquement disparue.
  if (
    Number.isFinite(market.liquidityUsd) &&
    market.liquidityUsd <= LIQUIDITY_ZERO_USD
  ) {
    reasons.push(
      "liquidité pratiquement disparue"
    );
  }

  // Baisse liquidité >= 50 %.
  if (
    Number.isFinite(liquidity.change) &&
    liquidity.change <=
      LIQUIDITY_CRITICAL_PERCENT
  ) {
    reasons.push(
      `liquidité ${fmtPercent(liquidity.change)} sur ~10s`
    );
  }

  // Crash prix.
  if (
    Number.isFinite(priceChange) &&
    priceChange <=
      CRASH_PRICE_DROP_PERCENT
  ) {
    reasons.push(
      `prix ${fmtPercent(priceChange)} sur ~10s`
    );
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    priceChange,
    liquidityChange:
      liquidity.change,
    reasons
  };
}

// ------------------------------------------------------------
// ACHAT SIMULÉ
// ------------------------------------------------------------

async function simulatedBuy() {
  if (!trading) {
    return;
  }

  if (stoppedByCrash) {
    return;
  }

  if (
    !Number.isFinite(market.priceUsd) ||
    market.priceUsd <= 0
  ) {
    return;
  }

  // Protection importante :
  // aucune nouvelle entrée si la liquidité
  // est déjà très mauvaise.
  if (
    Number.isFinite(market.liquidityUsd) &&
    market.liquidityUsd <=
      LIQUIDITY_ZERO_USD
  ) {
    return;
  }

  const liquidityAnalysis =
    analyseLiquidity();

  if (
    Number.isFinite(
      liquidityAnalysis.change
    ) &&
    liquidityAnalysis.change <=
      LIQUIDITY_DANGER_PERCENT
  ) {
    console.log(
      "🛑 Nouveau cycle refusé : liquidité dégradée."
    );

    return;
  }

  strategy.cycle += 1;

  strategy.state = "HOLDING";

  strategy.entryPrice =
    market.priceUsd;

  strategy.lastBuyPrice =
    market.priceUsd;

  strategy.entryTime =
    Date.now();

  strategy.tokensHeld =
    CAPITAL_PER_CYCLE_USD /
    market.priceUsd;

  strategy.totalInvested +=
    CAPITAL_PER_CYCLE_USD;

  strategy.lastActionAt =
    Date.now();

  console.log(
    `🟢 BUY TEST #${strategy.cycle}` +
    ` | ${fmtMoney(CAPITAL_PER_CYCLE_USD)}` +
    ` | prix ${fmtUsd(market.priceUsd)}`
  );

  await send(
    `🟢 ACHAT TEST #${strategy.cycle}\n\n` +
    `Token : ${shortenMint(watchedMint)}\n` +
    `Mise fixe : ${fmtMoney(CAPITAL_PER_CYCLE_USD)}\n` +
    `Prix simulé : ${fmtUsd(market.priceUsd)}\n` +
    `Tokens : ${strategy.tokensHeld.toFixed(8)}\n\n` +
    `🎯 Objectif : +${TARGET_NET_PERCENT.toFixed(2)}%`
  );
}

// ------------------------------------------------------------
// VENTE NORMALE À +50 %
// ------------------------------------------------------------

async function simulatedTargetSell() {
  if (!trading) {
    return;
  }

  if (stoppedByCrash) {
    return;
  }

  if (
    strategy.state !== "HOLDING"
  ) {
    return;
  }

  if (
    !Number.isFinite(strategy.entryPrice) ||
    strategy.entryPrice <= 0
  ) {
    return;
  }

  if (
    !Number.isFinite(market.priceUsd) ||
    market.priceUsd <= 0
  ) {
    return;
  }

  const targetPrice =
    strategy.entryPrice *
    (1 + TARGET_NET_PERCENT / 100);

  if (
    market.priceUsd < targetPrice
  ) {
    return;
  }

  // Vérification liquidité avant vente.
  const liquidityAnalysis =
    analyseLiquidity();

  if (
    Number.isFinite(
      liquidityAnalysis.change
    ) &&
    liquidityAnalysis.change <=
      LIQUIDITY_CRITICAL_PERCENT
  ) {
    console.log(
      "⚠️ Objectif atteint mais liquidité critique."
    );

    return;
  }

  const grossValue =
    strategy.tokensHeld *
    market.priceUsd;

  const invested =
    CAPITAL_PER_CYCLE_USD;

  const grossProfit =
    grossValue - invested;

  const actualPercent =
    (grossProfit / invested) * 100;

  strategy.realizedProfit +=
    grossProfit;

  strategy.totalReturned +=
    grossValue;

  strategy.completedCycles += 1;

  strategy.lastSellPrice =
    market.priceUsd;

  strategy.lastActionAt =
    Date.now();

  strategy.tokensHeld = 0;

  strategy.state = "SOLD";

  await send(
    `🔴 VENTE TEST #${strategy.cycle}\n\n` +
    `Token : ${shortenMint(watchedMint)}\n` +
    `Prix : ${fmtUsd(market.priceUsd)}\n` +
    `Montant simulé : ${fmtMoney(grossValue)}\n` +
    `Résultat : ${fmtPercent(actualPercent)}\n` +
    `Bénéfice réalisé : ${fmtMoney(grossProfit)}\n\n` +
    `💰 Bénéfices cumulés : ${fmtMoney(strategy.realizedProfit)}\n\n` +
    `🔄 Prochain cycle : ${fmtMoney(CAPITAL_PER_CYCLE_USD)}`
  );
}

// ------------------------------------------------------------
// SORTIE D'URGENCE
// ------------------------------------------------------------

async function emergencyStop(crash) {
  if (stoppedByCrash) {
    return;
  }

  stoppedByCrash = true;
  trading = false;

  strategy.state = "CRASH";

  strategy.crashReason =
    crash.reasons.join(" + ");

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  let positionMessage =
    "Aucune position simulée.";

  // ----------------------------------------------------------
  // IMPORTANT :
  //
  // Si la liquidité est très faible ou nulle,
  // on NE FAIT PAS semblant d'avoir vendu au prix affiché.
  // ----------------------------------------------------------

  const liquidityIsCritical =
    !Number.isFinite(
      market.liquidityUsd
    ) ||
    market.liquidityUsd <=
      LIQUIDITY_ZERO_USD ||
    (
      Number.isFinite(
        crash.liquidityChange
      ) &&
      crash.liquidityChange <=
        LIQUIDITY_CRITICAL_PERCENT
    );

  if (
    strategy.tokensHeld > 0 &&
    liquidityIsCritical
  ) {
    positionMessage =
      `⚠️ Position restante : ${strategy.tokensHeld.toFixed(8)} tokens\n\n` +
      `⚠️ Prix de sortie NON considéré fiable.\n` +
      `⚠️ Liquidité trop faible pour simuler une vente honnête.\n` +
      `⚠️ Aucun bénéfice fictif ajouté.`;

    strategy.tokensHeld = 0;
  }

  else if (
    strategy.tokensHeld > 0 &&
    Number.isFinite(
      market.priceUsd
    )
  ) {
    const exitValue =
      strategy.tokensHeld *
      market.priceUsd;

    const pnl =
      exitValue -
      CAPITAL_PER_CYCLE_USD;

    strategy.realizedProfit +=
      pnl;

    strategy.totalReturned +=
      exitValue;

    positionMessage =
      `Position simulée liquidée : ${fmtMoney(exitValue)}\n` +
      `Résultat du dernier cycle : ${fmtMoney(pnl)}`;

    strategy.tokensHeld = 0;
  }

  await send(
    `🚨 STOP CRASH - MODE TEST\n\n` +
    `Token : ${shortenMint(watchedMint)}\n\n` +

    `Prix : ${fmtUsd(market.priceUsd)}\n` +
    `Variation ~10s : ${fmtPercent(crash.priceChange)}\n\n` +

    `Liquidité : ${fmtMoney(market.liquidityUsd)}\n` +
    `Variation ~10s : ${fmtPercent(crash.liquidityChange)}\n\n` +

    `⚠️ Signaux :\n` +
    crash.reasons
      .map(reason => `• ${reason}`)
      .join("\n") +

    `\n\n` +

    `${positionMessage}\n\n` +

    `⛔ NOUVEAU CYCLE BLOQUÉ\n` +
    `⛔ RADAR ARRÊTÉ\n\n` +

    `Cycles terminés : ${strategy.completedCycles}\n` +
    `💰 Bénéfices réellement simulés : ${fmtMoney(strategy.realizedProfit)}\n\n` +

    `⚠️ Ceci reste une simulation.`
  );

  console.log(
    "🛑 STOP CRASH",
    crash
  );
}

// ------------------------------------------------------------
// BOUCLE PRINCIPALE
// ------------------------------------------------------------

async function tick() {
  if (!trading) {
    return;
  }

  if (stoppedByCrash) {
    return;
  }

  if (!watchedMint) {
    return;
  }

  if (requestInProgress) {
    return;
  }

  requestInProgress = true;

  try {
    const data =
      await fetchPumpSwapMarket(
        watchedMint
      );

    market = {
      ...data,
      updatedAt: Date.now()
    };

    addMarketPoint();

    console.log(
      `📡 ${shortenMint(watchedMint)}` +
      ` | prix ${fmtUsd(market.priceUsd)}` +
      ` | liq ${fmtMoney(market.liquidityUsd)}` +
      ` | état ${strategy.state}`
    );

    // --------------------------------------------------------
    // PRIORITÉ 1 : CRASH
    // --------------------------------------------------------

    const crash =
      detectCrash();

    if (crash) {
      await emergencyStop(crash);
      return;
    }

    // --------------------------------------------------------
    // PRIORITÉ 2 : ACHAT
    // --------------------------------------------------------

    if (
      strategy.state === "IDLE" ||
      strategy.state === "SOLD"
    ) {
      await simulatedBuy();
      return;
    }

    // --------------------------------------------------------
    // PRIORITÉ 3 : OBJECTIF +50 %
    // --------------------------------------------------------

    if (
      strategy.state === "HOLDING"
    ) {
      await simulatedTargetSell();
    }

  } catch (err) {
    console.error(
      "❌ Erreur marché :",
      err.message
    );

    // Une erreur réseau ne provoque
    // jamais un achat ou une vente.
  } finally {
    requestInProgress = false;
  }
}

// ------------------------------------------------------------
// DEMARRAGE
// ------------------------------------------------------------

async function startTrading(mint) {
  if (trading) {
    await send(
      `⚠️ Un test est déjà actif.\n\n` +
      `Token : ${shortenMint(watchedMint)}\n\n` +
      `Utilise /stoptrade avant de changer de token.`
    );

    return;
  }

  if (
    !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(
      mint
    )
  ) {
    await send(
      `❌ Adresse de token invalide.\n\n` +
      `Utilise l'adresse Solana complète.`
    );

    return;
  }

  try {
    const data =
      await fetchPumpSwapMarket(
        mint
      );

    watchedMint = mint;

    market = {
      ...data,
      updatedAt: Date.now()
    };

    history = [];

    strategy = {
      state: "IDLE",

      cycle: 0,

      tokensHeld: 0,

      entryPrice: 0,
      entryTime: 0,

      realizedProfit: 0,

      totalInvested: 0,
      totalReturned: 0,

      completedCycles: 0,

      lastBuyPrice: 0,
      lastSellPrice: 0,

      lastActionAt: 0,

      crashReason: null
    };

    stoppedByCrash = false;
    trading = true;

    addMarketPoint();

    await send(
      `🧪 TRADING TEST V2 DÉMARRÉ\n\n` +

      `Token : ${shortenMint(mint)}\n` +
      `DEX : ${market.dexId}\n\n` +

      `💵 Mise par cycle : ${fmtMoney(CAPITAL_PER_CYCLE_USD)}\n` +
      `🎯 Objectif : +${TARGET_NET_PERCENT.toFixed(2)}%\n\n` +

      `🛡️ PROTECTION LIQUIDITÉ\n` +
      `• Surveillance toutes les 2s\n` +
      `• Alerte dégradation : ${LIQUIDITY_WARNING_PERCENT}%\n` +
      `• Danger : ${LIQUIDITY_DANGER_PERCENT}%\n` +
      `• Critique : ${LIQUIDITY_CRITICAL_PERCENT}%\n` +
      `• Quasi zéro : STOP\n\n` +

      `⚠️ Aucun achat réel.\n` +
      `⚠️ Aucune vente réelle.\n\n` +

      `Prix actuel : ${fmtUsd(market.priceUsd)}\n` +
      `Liquidité : ${fmtMoney(market.liquidityUsd)}\n\n` +

      `⏳ Premier cycle...`
    );

    timer = setInterval(
      tick,
      POLL_INTERVAL_MS
    );

    await tick();

  } catch (err) {
    console.error(
      "❌ Impossible de démarrer :",
      err.message
    );

    await send(
      `❌ IMPOSSIBLE DE DÉMARRER\n\n` +
      `Token : ${shortenMint(mint)}\n\n` +
      `${err.message}\n\n` +
      `Le bot exige une paire PumpSwap détectable.`
    );
  }
}

// ------------------------------------------------------------
// ARRET MANUEL
// ------------------------------------------------------------

async function stopTrading(
  sendMessage = true
) {
  trading = false;

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  strategy.state = "IDLE";

  if (sendMessage) {
    await send(
      `🛑 TEST ARRÊTÉ\n\n` +
      `Token : ${shortenMint(watchedMint)}\n\n` +
      `Cycles terminés : ${strategy.completedCycles}\n` +
      `Bénéfices simulés : ${fmtMoney(strategy.realizedProfit)}\n\n` +
      `Aucune transaction réelle n'a été effectuée.`
    );
  }
}

// ------------------------------------------------------------
// STATUS
// ------------------------------------------------------------

async function sendStatus() {
  if (
    !trading &&
    !watchedMint
  ) {
    await send(
      `📊 TRADING TEST V2\n\n` +
      `Aucun test actif.\n\n` +
      `/starttrade ADRESSE_TOKEN`
    );

    return;
  }

  const targetPrice =
    strategy.state === "HOLDING"
      ? strategy.entryPrice *
        (1 + TARGET_NET_PERCENT / 100)
      : null;

  const priceChange =
    getPriceChange(
      LIQUIDITY_WINDOW_MS
    );

  const liquidityChange =
    getLiquidityChange(
      LIQUIDITY_WINDOW_MS
    );

  await send(
    `📊 STATUS TEST V2\n\n` +

    `Token : ${shortenMint(watchedMint)}\n` +
    `État : ${strategy.state}\n` +
    `Trading : ${trading ? "ACTIF" : "ARRÊTÉ"}\n\n` +

    `💵 Cycle : ${fmtMoney(CAPITAL_PER_CYCLE_USD)}\n` +
    `🎯 Objectif : +${TARGET_NET_PERCENT.toFixed(2)}%\n\n` +

    `Prix : ${fmtUsd(market.priceUsd)}\n` +
    `Liquidité : ${fmtMoney(market.liquidityUsd)}\n\n` +

    `Prix ~10s : ${fmtPercent(priceChange)}\n` +
    `Liquidité ~10s : ${fmtPercent(liquidityChange)}\n\n` +

    (
      strategy.state === "HOLDING"
        ? `🟢 Position simulée\n` +
          `Cycle : #${strategy.cycle}\n` +
          `Prix achat : ${fmtUsd(strategy.entryPrice)}\n` +
          `Objectif : ${fmtUsd(targetPrice)}\n` +
          `Tokens : ${strategy.tokensHeld.toFixed(8)}\n\n`
        : ""
    ) +

    `🔄 Cycles terminés : ${strategy.completedCycles}\n` +
    `💰 Bénéfices cumulés : ${fmtMoney(strategy.realizedProfit)}`
  );
}

// ------------------------------------------------------------
// COMMANDES
// ------------------------------------------------------------

bot.command(
  "starttrade",
  async ctx => {
    if (!isAuthorized(ctx)) {
      return;
    }

    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    if (parts.length < 2) {
      await ctx.reply(
        `❌ Adresse du token manquante.\n\n` +
        `/starttrade ADRESSE_DU_TOKEN`
      );

      return;
    }

    await startTrading(
      parts[1].trim()
    );
  }
);

bot.command(
  "stoptrade",
  async ctx => {
    if (!isAuthorized(ctx)) {
      return;
    }

    await stopTrading(true);
  }
);

bot.command(
  "status",
  async ctx => {
    if (!isAuthorized(ctx)) {
      return;
    }

    await sendStatus();
  }
);

bot.command(
  "help",
  async ctx => {
    if (!isAuthorized(ctx)) {
      return;
    }

    await ctx.reply(
      `🤖 TRADING TEST V2\n\n` +

      `/starttrade ADRESSE\n` +
      `Lance une simulation.\n\n` +

      `/status\n` +
      `Affiche le cycle actuel.\n\n` +

      `/stoptrade\n` +
      `Arrête le test.\n\n` +

      `💵 Mise : $1 fixe\n` +
      `🎯 Objectif : +50 %\n` +
      `🛡️ Protection liquidité\n` +
      `🚨 STOP automatique sur crash\n\n` +

      `⚠️ MODE TEST UNIQUEMENT.`
    );
  }
);

// ------------------------------------------------------------
// ERREURS TELEGRAM
// ------------------------------------------------------------

bot.catch(err => {
  console.error(
    "❌ Erreur Telegram :",
    err.message
  );
});

// ------------------------------------------------------------
// ARRET PROPRE
// ------------------------------------------------------------

async function shutdown(signal) {
  console.log(
    `🛑 Arrêt reçu : ${signal}`
  );

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  trading = false;

  try {
    bot.stop(signal);
  } catch (err) {
    console.error(
      "Erreur arrêt Telegram :",
      err.message
    );
  }

  process.exit(0);
}

process.once(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.once(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

// ------------------------------------------------------------
// LANCEMENT
// ------------------------------------------------------------

(async () => {
  console.log(
    "========================================"
  );

  console.log(
    "🧪 TRADING V2 - MODE TEST"
  );

  console.log(
    "========================================"
  );

  console.log(
    "💵 Capital par cycle : $1"
  );

  console.log(
    "🎯 Objectif : +50%"
  );

  console.log(
    "🛡️ Protection liquidité activée"
  );

  console.log(
    "🚨 Aucun trade réel"
  );

  console.log(
    "========================================"
  );

  await bot.launch();

  console.log(
    "🤖 Bot Telegram connecté."
  );
})();
