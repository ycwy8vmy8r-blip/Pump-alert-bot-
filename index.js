const { Telegraf } = require("telegraf");

// ============================================================
// RADAR TRADING V1 - MODE TEST
// ============================================================
//
// IMPORTANT :
// Cette version NE FAIT AUCUN achat ni aucune vente réelle.
// Elle simule uniquement la stratégie.
//
// STRATEGIE :
// 5 $ fixes
// -> objectif +2,5 %
// -> vente simulée
// -> bénéfice conservé
// -> nouveau cycle de 5 $
//
// Le radar surveille aussi une chute brutale.
// En cas de crash : arrêt immédiat des nouveaux cycles.
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
// STRATEGIE
// ------------------------------------------------------------

const CAPITAL_PER_CYCLE_USD = 5.00;
const TARGET_NET_PERCENT = 2.5;

// On considère une chute brutale si le prix perd au moins 20 %
// sur une fenêtre très courte.
const CRASH_PRICE_DROP_PERCENT = -20;

// Protection supplémentaire avec la liquidité.
const CRASH_LIQUIDITY_DROP_PERCENT = -35;

// Fenêtre utilisée pour détecter le crash.
const CRASH_WINDOW_MS = 10_000;

// Prix/liquidité actualisés toutes les 2 secondes.
const POLL_INTERVAL_MS = 2_000;

// Nombre maximum de données conservées.
const HISTORY_MAX_MS = 120_000;

// ------------------------------------------------------------
// ETAT DU BOT
// ------------------------------------------------------------

let trading = false;
let stoppedByCrash = false;

let watchedMint = null;

let timer = null;
let requestInProgress = false;

// Données marché
let market = {
  priceUsd: null,
  liquidityUsd: null,
  pairAddress: null,
  dexId: null,
  updatedAt: 0
};

// Historique prix/liquidité
let history = [];

// Etat de la stratégie
let strategy = {
  state: "IDLE",

  cycle: 0,

  // Position simulée
  tokensHeld: 0,

  entryPrice: 0,
  entryTime: 0,

  // Argent
  capitalPerCycle: CAPITAL_PER_CYCLE_USD,

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmtUsd(value) {
  if (!Number.isFinite(value)) return "N/A";

  if (value >= 1) {
    return `$${value.toFixed(4)}`;
  }

  if (value >= 0.01) {
    return `$${value.toFixed(6)}`;
  }

  return `$${value.toFixed(10)}`;
}

function fmtMoney(value) {
  if (!Number.isFinite(value)) return "$0.00";
  return `$${value.toFixed(4)}`;
}

function fmtPercent(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function shortenMint(mint) {
  if (!mint) return "N/A";
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
    console.error("Telegram send error:", err.message);
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
        "accept": "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`DexScreener HTTP ${response.status}`);
    }

    const data = await response.json();

    const pairs = Array.isArray(data.pairs)
      ? data.pairs
      : [];

    // On ne veut que PumpSwap.
    const pumpPairs = pairs.filter(pair => {
      return String(pair.dexId || "").toLowerCase() === "pumpswap";
    });

    if (pumpPairs.length === 0) {
      throw new Error("Aucune paire PumpSwap trouvée.");
    }

    // On choisit la paire avec la plus grosse liquidité.
    pumpPairs.sort((a, b) => {
      const liqA = Number(a?.liquidity?.usd || 0);
      const liqB = Number(b?.liquidity?.usd || 0);

      return liqB - liqA;
    });

    const pair = pumpPairs[0];

    const priceUsd = Number(pair.priceUsd);
    const liquidityUsd = Number(pair?.liquidity?.usd || 0);

    if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw new Error("Prix PumpSwap invalide.");
    }

    return {
      priceUsd,
      liquidityUsd,
      pairAddress: pair.pairAddress || null,
      dexId: pair.dexId || "pumpswap"
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

  const cutoff = now - HISTORY_MAX_MS;

  history = history.filter(point => point.time >= cutoff);
}

function getOldestPointWithin(windowMs) {
  const now = Date.now();
  const target = now - windowMs;

  let candidate = null;

  for (const point of history) {
    if (point.time <= target) {
      candidate = point;
    }
  }

  if (candidate) {
    return candidate;
  }

  // Si on n'a pas encore exactement la fenêtre,
  // on utilise le point le plus ancien disponible.
  return history.length > 0 ? history[0] : null;
}

function percentageChange(current, previous) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous <= 0
  ) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

function getPriceChange(windowMs) {
  const old = getOldestPointWithin(windowMs);

  if (!old) return null;

  return percentageChange(
    market.priceUsd,
    old.price
  );
}

function getLiquidityChange(windowMs) {
  const old = getOldestPointWithin(windowMs);

  if (!old) return null;

  return percentageChange(
    market.liquidityUsd,
    old.liquidity
  );
}

// ------------------------------------------------------------
// DETECTION CRASH
// ------------------------------------------------------------

function detectCrash() {
  const priceChange = getPriceChange(CRASH_WINDOW_MS);
  const liquidityChange = getLiquidityChange(CRASH_WINDOW_MS);

  const reasons = [];

  if (
    Number.isFinite(priceChange) &&
    priceChange <= CRASH_PRICE_DROP_PERCENT
  ) {
    reasons.push(
      `Prix ${fmtPercent(priceChange)} sur ~10s`
    );
  }

  if (
    Number.isFinite(liquidityChange) &&
    liquidityChange <= CRASH_LIQUIDITY_DROP_PERCENT
  ) {
    reasons.push(
      `Liquidité ${fmtPercent(liquidityChange)} sur ~10s`
    );
  }

  if (reasons.length === 0) {
    return null;
  }

  return {
    priceChange,
    liquidityChange,
    reasons
  };
}

// ------------------------------------------------------------
// STRATEGIE : ACHAT SIMULE
// ------------------------------------------------------------

async function simulatedBuy() {
  if (!trading) return;
  if (stoppedByCrash) return;

  if (!Number.isFinite(market.priceUsd)) {
    console.log("⏳ Prix indisponible, achat impossible.");
    return;
  }

  if (market.priceUsd <= 0) {
    return;
  }

  strategy.cycle += 1;

  strategy.state = "HOLDING";

  strategy.entryPrice = market.priceUsd;
  strategy.lastBuyPrice = market.priceUsd;
  strategy.entryTime = Date.now();

  strategy.tokensHeld =
    CAPITAL_PER_CYCLE_USD / market.priceUsd;

  strategy.totalInvested += CAPITAL_PER_CYCLE_USD;

  strategy.lastActionAt = Date.now();

  console.log(
    `🟢 BUY TEST #${strategy.cycle}` +
    ` | ${fmtMoney(CAPITAL_PER_CYCLE_USD)}` +
    ` | prix ${fmtUsd(market.priceUsd)}` +
    ` | tokens ${strategy.tokensHeld}`
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
// STRATEGIE : VENTE SIMULEE
// ------------------------------------------------------------

async function simulatedSell(reason = "TARGET") {
  if (!trading) return;
  if (stoppedByCrash) return;

  if (strategy.state !== "HOLDING") {
    return;
  }

  if (!Number.isFinite(strategy.entryPrice)) {
    return;
  }

  if (strategy.tokensHeld <= 0) {
    return;
  }

  const currentPrice = market.priceUsd;

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return;
  }

  const grossValue =
    strategy.tokensHeld * currentPrice;

  const invested =
    CAPITAL_PER_CYCLE_USD;

  const grossProfit =
    grossValue - invested;

  const actualPercent =
    (grossProfit / invested) * 100;

  strategy.realizedProfit += grossProfit;
  strategy.totalReturned += grossValue;

  strategy.completedCycles += 1;

  strategy.lastSellPrice = currentPrice;
  strategy.lastActionAt = Date.now();

  strategy.tokensHeld = 0;

  strategy.state = "SOLD";

  console.log(
    `🔴 SELL TEST #${strategy.cycle}` +
    ` | ${fmtMoney(grossValue)}` +
    ` | ${fmtPercent(actualPercent)}` +
    ` | profit ${fmtMoney(grossProfit)}`
  );

  await send(
    `🔴 VENTE TEST #${strategy.cycle}\n\n` +
    `Token : ${shortenMint(watchedMint)}\n` +
    `Prix : ${fmtUsd(currentPrice)}\n` +
    `Montant simulé : ${fmtMoney(grossValue)}\n` +
    `Résultat : ${fmtPercent(actualPercent)}\n` +
    `Bénéfice réalisé : ${fmtMoney(grossProfit)}\n\n` +
    `💰 Bénéfices cumulés : ${fmtMoney(strategy.realizedProfit)}\n\n` +
    `🔄 Prochain cycle : ${fmtMoney(CAPITAL_PER_CYCLE_USD)}`
  );

  // Nouveau cycle immédiatement après la vente.
  // Dans cette V1 TEST, on attend simplement la prochaine
  // mise à jour de marché avant de simuler le nouvel achat.
}

// ------------------------------------------------------------
// CONTROLE OBJECTIF
// ------------------------------------------------------------

function getTargetPrice() {
  if (
    !Number.isFinite(strategy.entryPrice) ||
    strategy.entryPrice <= 0
  ) {
    return null;
  }

  return strategy.entryPrice *
    (1 + TARGET_NET_PERCENT / 100);
}

async function checkTarget() {
  if (!trading) return;
  if (stoppedByCrash) return;

  if (strategy.state !== "HOLDING") {
    return;
  }

  const targetPrice = getTargetPrice();

  if (!Number.isFinite(targetPrice)) {
    return;
  }

  if (market.priceUsd >= targetPrice) {
    await simulatedSell("TARGET");
  }
}

// ------------------------------------------------------------
// STOP CRASH
// ------------------------------------------------------------

async function stopBecauseCrash(crash) {
  if (stoppedByCrash) return;

  stoppedByCrash = true;
  trading = false;

  strategy.state = "CRASH";
  strategy.crashReason = crash.reasons.join(" + ");

  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  let positionText = "Aucune position.";

  // En mode TEST, on simule aussi la liquidation
  // de la position restante au prix observé.
  if (strategy.tokensHeld > 0 && Number.isFinite(market.priceUsd)) {
    const exitValue =
      strategy.tokensHeld * market.priceUsd;

    const pnl =
      exitValue - CAPITAL_PER_CYCLE_USD;

    positionText =
      `Position simulée liquidée : ${fmtMoney(exitValue)}\n` +
      `Résultat du dernier cycle : ${fmtMoney(pnl)}`;

    strategy.realizedProfit += pnl;
    strategy.totalReturned += exitValue;

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
    crash.reasons.map(x => `• ${x}`).join("\n") +
    `\n\n` +
    `${positionText}\n\n` +
    `⛔ NOUVEAU CYCLE BLOQUÉ\n` +
    `⛔ RADAR ARRÊTÉ\n\n` +
    `Cycles terminés : ${strategy.completedCycles}\n` +
    `Bénéfices cumulés : ${fmtMoney(strategy.realizedProfit)}`
  );

  console.log("🛑 STOP CRASH", crash);
}

// ------------------------------------------------------------
// BOUCLE PRINCIPALE
// ------------------------------------------------------------

async function tick() {
  if (!trading) return;
  if (stoppedByCrash) return;
  if (!watchedMint) return;

  if (requestInProgress) {
    return;
  }

  requestInProgress = true;

  try {
    const data = await fetchPumpSwapMarket(watchedMint);

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

    // Le crash est prioritaire.
    const crash = detectCrash();

    if (crash) {
      await stopBecauseCrash(crash);
      return;
    }

    // Si aucune position n'existe, on achète 5 $.
    if (
      strategy.state === "IDLE" ||
      strategy.state === "SOLD"
    ) {
      await simulatedBuy();
      return;
    }

    // Si une position existe, on vérifie l'objectif.
    if (strategy.state === "HOLDING") {
      await checkTarget();
    }

  } catch (err) {
    console.error(
      "❌ Erreur marché :",
      err.message
    );

    // Une erreur réseau ne doit surtout PAS déclencher
    // un achat ou une vente.
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
      `Token : ${shortenMint(watchedMint)}\n` +
      `Utilise /stoptrade avant de changer de token.`
    );

    return;
  }

  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    await send(
      `❌ Adresse de token invalide.\n\n` +
      `Utilise une adresse Solana complète.`
    );

    return;
  }

  console.log(
    `🔎 Vérification PumpSwap : ${mint}`
  );

  try {
    const data =
      await fetchPumpSwapMarket(mint);

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

      capitalPerCycle: CAPITAL_PER_CYCLE_USD,

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
      `🧪 TRADING TEST DÉMARRÉ\n\n` +
      `Token : ${shortenMint(mint)}\n` +
      `DEX : ${market.dexId}\n\n` +
      `💵 Mise par cycle : ${fmtMoney(CAPITAL_PER_CYCLE_USD)}\n` +
      `🎯 Objectif : +${TARGET_NET_PERCENT.toFixed(2)}%\n\n` +
      `⚠️ Aucun achat réel.\n` +
      `⚠️ Aucune vente réelle.\n\n` +
      `🚨 STOP CRASH activé à partir de :\n` +
      `• Prix ≤ ${CRASH_PRICE_DROP_PERCENT}% / ~10s\n` +
      `• Liquidité ≤ ${CRASH_LIQUIDITY_DROP_PERCENT}% / ~10s\n\n` +
      `Prix actuel : ${fmtUsd(market.priceUsd)}\n` +
      `Liquidité : ${fmtMoney(market.liquidityUsd)}\n\n` +
      `⏳ Démarrage du premier cycle...`
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

async function stopTrading(sendMessage = true) {
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
  if (!trading && !watchedMint) {
    await send(
      `📊 RADAR TEST\n\n` +
      `Aucun test actif.\n\n` +
      `Commande :\n` +
      `/starttrade ADRESSE_TOKEN`
    );

    return;
  }

  const targetPrice =
    strategy.state === "HOLDING"
      ? getTargetPrice()
      : null;

  const priceChange10 =
    getPriceChange(CRASH_WINDOW_MS);

  const liquidityChange10 =
    getLiquidityChange(CRASH_WINDOW_MS);

  await send(
    `📊 STATUS TEST\n\n` +
    `Token : ${shortenMint(watchedMint)}\n` +
    `État : ${strategy.state}\n` +
    `Trading : ${trading ? "ACTIF" : "ARRÊTÉ"}\n\n` +

    `💵 Mise fixe : ${fmtMoney(CAPITAL_PER_CYCLE_USD)}\n` +
    `🎯 Objectif : +${TARGET_NET_PERCENT.toFixed(2)}%\n\n` +

    `Prix : ${fmtUsd(market.priceUsd)}\n` +
    `Liquidité : ${fmtMoney(market.liquidityUsd)}\n` +
    `Prix ~10s : ${fmtPercent(priceChange10)}\n` +
    `Liquidité ~10s : ${fmtPercent(liquidityChange10)}\n\n` +

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
    `💰 Bénéfices cumulés : ${fmtMoney(strategy.realizedProfit)}\n` +
    `💵 Total simulé investi : ${fmtMoney(strategy.totalInvested)}\n` +
    `💵 Total simulé retourné : ${fmtMoney(strategy.totalReturned)}`
  );
}

// ------------------------------------------------------------
// COMMANDES TELEGRAM
// ------------------------------------------------------------

bot.command("starttrade", async ctx => {
  if (!isAuthorized(ctx)) {
    return;
  }

  const parts =
    ctx.message.text.trim().split(/\s+/);

  if (parts.length < 2) {
    await ctx.reply(
      `❌ Il manque l'adresse du token.\n\n` +
      `Exemple :\n` +
      `/starttrade ADRESSE_DU_TOKEN`
    );

    return;
  }

  const mint = parts[1].trim();

  await startTrading(mint);
});

bot.command("stoptrade", async ctx => {
  if (!isAuthorized(ctx)) {
    return;
  }

  await stopTrading(true);
});

bot.command("status", async ctx => {
  if (!isAuthorized(ctx)) {
    return;
  }

  await sendStatus();
});

bot.command("help", async ctx => {
  if (!isAuthorized(ctx)) {
    return;
  }

  await ctx.reply(
    `🤖 TRADING TEST V1\n\n` +

    `/starttrade ADRESSE\n` +
    `Lance une simulation sur PumpSwap.\n\n` +

    `/status\n` +
    `Affiche l'état du cycle.\n\n` +

    `/stoptrade\n` +
    `Arrête la simulation.\n\n` +

    `💵 Mise : $5 fixes\n` +
    `🎯 Objectif : +2,5 %\n` +
    `🚨 Crash : arrêt automatique\n\n` +

    `⚠️ MODE TEST UNIQUEMENT.\n` +
    `Aucune transaction réelle.`
  );
});

// ------------------------------------------------------------
// GESTION ERREURS TELEGRAM
// ------------------------------------------------------------

bot.catch(async (err) => {
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
    `\n🛑 Arrêt reçu : ${signal}`
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
      "Erreur arrêt Telegram:",
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
    "🧪 RADAR TRADING V1 - MODE TEST"
  );

  console.log(
    "========================================"
  );

  console.log(
    `💵 Capital par cycle : $${CAPITAL_PER_CYCLE_USD}`
  );

  console.log(
    `🎯 Objectif : +${TARGET_NET_PERCENT}%`
  );

  console.log(
    "🛑 Aucun trade réel."
  );

  console.log(
    "========================================"
  );

  await bot.launch();

  console.log(
    "🤖 Bot Telegram connecté."
  );
})();
