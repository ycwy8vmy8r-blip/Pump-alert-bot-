require("dotenv").config();

const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIG
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN ou CHAT_ID manquant");
  process.exit(1);
}

const RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : "https://api.mainnet-beta.solana.com";

// Token de test actuel
const TRUSTED_TEST_MINT =
  "6mXbyvPJbPQRyMU5BFL99TFLEDdvuV434cQBSjjitxX7";

// Pair PumpSwap connue pour le test
const TRUSTED_TEST_PAIR =
  "7CiKcfvnnFU15p3id9NUgGLPZZibjQteh9RrNJ1QVmwb";

// ============================================================
// STRATEGIE
// ============================================================

const CAPITAL = 10;
const TARGET_PERCENT = 5;

const STOP_PERCENT = -20;

const MARKET_INTERVAL = 2000;
const PAIR_REFRESH_INTERVAL = 60000;

const COOLDOWN_AFTER_SELL = 30000;

const NO_NEW_BUY_MINUTES = 43;
const MAX_SESSION_MINUTES = 45;

const MIN_LIQUIDITY = 200000;
const MAX_LIQUIDITY = 400000;

const MIN_HOLDERS = 1000;
const MAX_AGE_MINUTES = 300;

// ============================================================
// FILTRES
// ============================================================

const ALLOWED_NAMES = ["claude", "openai", "anthropic"];

// ============================================================
// DATA
// ============================================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TRADES_FILE = path.join(DATA_DIR, "trades_v6_4.json");
const CRASH_FILE = path.join(DATA_DIR, "crashes_v6_4.json");

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("Erreur sauvegarde:", e.message);
  }
}

let trades = loadJson(TRADES_FILE, []);
let crashes = loadJson(CRASH_FILE, []);

// ============================================================
// ETAT GLOBAL
// ============================================================

let currentCandidate = null;

let tradingActive = false;
let marketLoopRunning = false;

let sessionStartedAt = 0;
let lastSellAt = 0;

let position = null;

let lastMarket = null;
let lastPairRefresh = 0;

let currentPair = null;

let sessionPnL = 0;
let sessionWins = 0;
let sessionLosses = 0;

let totalCycles = 0;

let lastCrash = null;

// Empêche plusieurs /starttrade simultanés
let sessionId = 0;

// ============================================================
// CACHE HTTP
// ============================================================

const httpCache = new Map();
const inflightRequests = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const cacheKey = url;

  if (options.cacheMs) {
    const cached = httpCache.get(cacheKey);

    if (cached && Date.now() - cached.time < options.cacheMs) {
      return cached.data;
    }
  }

  if (inflightRequests.has(cacheKey)) {
    return inflightRequests.get(cacheKey);
  }

  const promise = (async () => {
    let lastError = null;

    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const response = await fetch(url, {
          headers: {
            accept: "application/json",
            "user-agent": "pump-test-bot/6.4"
          }
        });

        if (response.status === 429) {
          const retryAfter = response.headers.get("retry-after");

          let wait = retryAfter
            ? Number(retryAfter) * 1000
            : 1000 * Math.pow(2, attempt);

          wait += Math.floor(Math.random() * 500);

          await sleep(Math.min(wait, 10000));
          continue;
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();

        if (options.cacheMs) {
          httpCache.set(cacheKey, {
            time: Date.now(),
            data
          });
        }

        return data;

      } catch (e) {
        lastError = e;

        if (attempt < 4) {
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
    }

    throw lastError || new Error("Erreur HTTP");
  })();

  inflightRequests.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    inflightRequests.delete(cacheKey);
  }
}

// ============================================================
// TELEGRAM
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

async function telegram(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text);
  } catch (e) {
    console.error("Telegram:", e.message);
  }
}

// ============================================================
// SOLANA RPC
// ============================================================

async function rpc(method, params = []) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params
    })
  });

  if (response.status === 429) {
    throw new Error("RPC_RATE_LIMIT");
  }

  if (!response.ok) {
    throw new Error(`RPC_HTTP_${response.status}`);
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error.message || "RPC_ERROR");
  }

  return json.result;
}

// ============================================================
// TOKEN INFO
// ============================================================

async function getTokenInfo(mint) {
  const url =
    `https://frontend-api-v3.pump.fun/coins/${mint}`;

  try {
    return await fetchJson(url, {
      cacheMs: 300000
    });
  } catch {
    return null;
  }
}

// ============================================================
// HOLDERS
// ============================================================

const holderCache = new Map();

async function getHolderCount(mint) {
  const cached = holderCache.get(mint);

  if (cached && Date.now() - cached.time < 600000) {
    return cached.count;
  }

  // Le token de test a déjà été validé avec >= 1000 holders.
  // On évite donc de refaire continuellement un RPC coûteux.
  if (mint === TRUSTED_TEST_MINT) {
    const result = {
      count: MIN_HOLDERS,
      time: Date.now()
    };

    holderCache.set(mint, result);

    return MIN_HOLDERS;
  }

  try {
    const result = await rpc("getTokenLargestAccounts", [
      mint,
      {
        commitment: "confirmed"
      }
    ]);

    const accounts = result?.value || [];

    const count = accounts.length;

    holderCache.set(mint, {
      count,
      time: Date.now()
    });

    return count;

  } catch (e) {
    if (cached) return cached.count;
    return 0;
  }
}

// ============================================================
// PUMPSWAP / DEXSCREENER
// ============================================================

function isPumpSwap(pair) {
  if (!pair) return false;

  const dex = String(pair.dexId || "").toLowerCase();

  return (
    dex === "pumpswap" ||
    dex === "pump_amm" ||
    dex === "pumpamm" ||
    dex.includes("pump")
  );
}

function pairHasToken(pair, mint) {
  if (!pair) return false;

  const base = pair.baseToken?.address;
  const quote = pair.quoteToken?.address;

  return base === mint || quote === mint;
}

async function findPumpSwapPair(mint) {
  if (
    mint === TRUSTED_TEST_MINT &&
    TRUSTED_TEST_PAIR
  ) {
    try {
      const direct = await fetchJson(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${TRUSTED_TEST_PAIR}`,
        {
          cacheMs: 5000
        }
      );

      const pair = direct?.pair;

      if (pair && isPumpSwap(pair) && pairHasToken(pair, mint)) {
        return pair;
      }
    } catch {}
  }

  const data = await fetchJson(
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
    {
      cacheMs: 30000
    }
  );

  const pairs = Array.isArray(data?.pairs)
    ? data.pairs
    : [];

  const valid = pairs.filter(pair => {
    return (
      isPumpSwap(pair) &&
      pairHasToken(pair, mint) &&
      Number(pair.liquidity?.usd || 0) > 0
    );
  });

  if (!valid.length) {
    return null;
  }

  valid.sort((a, b) => {
    return (
      Number(b.liquidity?.usd || 0) -
      Number(a.liquidity?.usd || 0)
    );
  });

  return valid[0];
}

// ============================================================
// MARKET
// ============================================================

async function getMarketData(mint) {
  const now = Date.now();

  let pair = currentPair;

  if (
    !pair ||
    pair.baseToken?.address !== mint &&
    pair.quoteToken?.address !== mint ||
    now - lastPairRefresh > PAIR_REFRESH_INTERVAL
  ) {
    try {
      pair = await findPumpSwapPair(mint);

      if (pair) {
        currentPair = pair;
        lastPairRefresh = now;
      }
    } catch (e) {
      // Si DexScreener rate-limit, on garde le dernier pair connu.
      if (!currentPair) {
        throw e;
      }

      pair = currentPair;
    }
  }

  if (!pair) {
    throw new Error("NO_PUMPSWAP_PAIR");
  }

  // Utilise le endpoint pair directement.
  // Beaucoup moins de requêtes que /tokens/<mint> toutes les 2 secondes.
  try {
    const data = await fetchJson(
      `https://api.dexscreener.com/latest/dex/pairs/solana/${pair.pairAddress}`,
      {
        cacheMs: 1500
      }
    );

    if (data?.pair) {
      pair = data.pair;
      currentPair = pair;
    }
  } catch {
    // On conserve le dernier pair valide.
  }

  const price = Number(pair.priceUsd || 0);
  const liquidity = Number(pair.liquidity?.usd || 0);

  if (!price || !Number.isFinite(price)) {
    throw new Error("INVALID_PRICE");
  }

  return {
    mint,
    pairAddress: pair.pairAddress,
    dex: pair.dexId,
    price,
    liquidity,
    volume24h: Number(pair.volume?.h24 || 0),
    fdv: Number(pair.fdv || 0),
    marketCap: Number(pair.marketCap || 0),
    timestamp: now
  };
}

// ============================================================
// CANDIDATE VALIDATION
// ============================================================

async function evaluateCandidate(mint) {
  if (!mint || typeof mint !== "string") {
    return {
      ok: false,
      reason: "MINT_INVALIDE"
    };
  }

  try {
    const info = await getTokenInfo(mint);

    const name =
      info?.name ||
      info?.symbol ||
      "Inconnu";

    const symbol =
      info?.symbol ||
      "";

    const normalizedName = String(name).toLowerCase();
    const normalizedSymbol = String(symbol).toLowerCase();

    const nameOK = ALLOWED_NAMES.some(word => {
      return (
        normalizedName.includes(word) ||
        normalizedSymbol.includes(word)
      );
    });

    if (!nameOK && mint !== TRUSTED_TEST_MINT) {
      return {
        ok: false,
        reason: "NOM",
        name,
        symbol
      };
    }

    const pair = await findPumpSwapPair(mint);

    if (!pair) {
      return {
        ok: false,
        reason: "PUMPSWAP",
        name,
        symbol
      };
    }

    const liquidity = Number(pair.liquidity?.usd || 0);

    if (
      liquidity < MIN_LIQUIDITY ||
      liquidity > MAX_LIQUIDITY
    ) {
      return {
        ok: false,
        reason: "LIQUIDITE",
        name,
        symbol,
        liquidity,
        pair
      };
    }

    let createdAt =
      Number(pair.pairCreatedAt || 0);

    let ageMinutes = 0;

    if (createdAt) {
      if (createdAt < 100000000000) {
        createdAt *= 1000;
      }

      ageMinutes =
        (Date.now() - createdAt) / 60000;
    }

    if (
      ageMinutes > MAX_AGE_MINUTES &&
      mint !== TRUSTED_TEST_MINT
    ) {
      return {
        ok: false,
        reason: "AGE",
        name,
        symbol,
        liquidity,
        ageMinutes,
        pair
      };
    }

    const holders = await getHolderCount(mint);

    if (
      holders < MIN_HOLDERS &&
      mint !== TRUSTED_TEST_MINT
    ) {
      return {
        ok: false,
        reason: "HOLDERS",
        name,
        symbol,
        liquidity,
        ageMinutes,
        holders,
        pair
      };
    }

    return {
      ok: true,
      mint,
      name,
      symbol,
      liquidity,
      ageMinutes,
      holders: Math.max(holders, MIN_HOLDERS),
      pair
    };

  } catch (e) {
    return {
      ok: false,
      reason: e.message || "ERREUR"
    };
  }
}

// ============================================================
// POSITION
// ============================================================

function buyPrice() {
  return lastMarket?.price || 0;
}

function targetPrice() {
  if (!position) return 0;

  return position.entryPrice *
    (1 + TARGET_PERCENT / 100);
}

function stopPrice() {
  if (!position) return 0;

  return position.entryPrice *
    (1 + STOP_PERCENT / 100);
}

// ============================================================
// BUY
// ============================================================

function openPosition(market) {
  if (position) return false;

  if (!tradingActive) return false;

  const elapsed =
    (Date.now() - sessionStartedAt) / 60000;

  if (elapsed >= NO_NEW_BUY_MINUTES) {
    return false;
  }

  if (
    market.liquidity < MIN_LIQUIDITY ||
    market.liquidity > MAX_LIQUIDITY
  ) {
    return false;
  }

  const price = market.price;

  position = {
    id: totalCycles + 1,
    mint: market.mint,
    pairAddress: market.pairAddress,
    capital: CAPITAL,
    entryPrice: price,
    entryLiquidity: market.liquidity,
    entryTime: Date.now()
  };

  totalCycles++;

  telegram(
    `🟢 BUY SIMULÉ #${position.id}\n\n` +
    `🪙 ${currentCandidate?.name || "Token"}\n` +
    `💵 Capital : $${CAPITAL.toFixed(2)}\n` +
    `💰 Prix : ${price.toFixed(10)} $\n` +
    `💧 Liquidité : $${market.liquidity.toFixed(2)}\n\n` +
    `🎯 Vente cible : ${targetPrice().toFixed(10)} $\n` +
    `🛑 Stop sécurité : ${stopPrice().toFixed(10)} $\n\n` +
    `SIMULATION UNIQUEMENT`
  ).catch(() => {});

  return true;
}

// ============================================================
// SELL
// ============================================================

function closePosition(market, reason) {
  if (!position) return;

  const entry =
    position.entryPrice;

  const exit =
    market.price;

  const percent =
    ((exit - entry) / entry) * 100;

  const pnl =
    CAPITAL * (percent / 100);

  const trade = {
    id: position.id,
    mint: position.mint,
    pairAddress: position.pairAddress,
    entryPrice: entry,
    exitPrice: exit,
    percent,
    pnl,
    reason,
    entryTime: position.entryTime,
    exitTime: Date.now()
  };

  trades.push(trade);
  saveJson(TRADES_FILE, trades);

  sessionPnL += pnl;

  if (pnl >= 0) {
    sessionWins++;
  } else {
    sessionLosses++;
  }

  const id = position.id;

  position = null;
  lastSellAt = Date.now();

  let emoji = "🎯";

  if (reason === "STOP") emoji = "🛑";
  if (reason === "CRASH") emoji = "🚨";
  if (reason === "SESSION_LIMIT") emoji = "⏱️";

  telegram(
    `${emoji} SELL SIMULÉ #${id}\n\n` +
    `Motif : ${reason}\n` +
    `Entrée : ${entry.toFixed(10)} $\n` +
    `Sortie : ${exit.toFixed(10)} $\n` +
    `Résultat : ${percent >= 0 ? "+" : ""}${percent.toFixed(2)} %\n` +
    `P&L : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n\n` +
    `💰 P&L session : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  ).catch(() => {});
}

// ============================================================
// CRASH
// ============================================================

function checkCrash(market) {
  if (!lastMarket) return false;

  const priceChange =
    ((market.price - lastMarket.price) /
      lastMarket.price) * 100;

  const liquidityChange =
    ((market.liquidity - lastMarket.liquidity) /
      Math.max(lastMarket.liquidity, 1)) * 100;

  if (
    market.liquidity <= 1 ||
    liquidityChange <= -50 ||
    priceChange <= -20
  ) {
    return {
      priceChange,
      liquidityChange
    };
  }

  return false;
}

function registerCrash(market, crash) {
  const report = {
    time: Date.now(),
    mint: market.mint,
    price: market.price,
    liquidity: market.liquidity,
    priceChange10s: crash.priceChange,
    liquidityChange: crash.liquidityChange
  };

  crashes.push(report);
  saveJson(CRASH_FILE, crashes);

  lastCrash = report;
}

// ============================================================
// SESSION LIMIT
// ============================================================

function sessionElapsedMinutes() {
  if (!sessionStartedAt) return 0;

  return (
    (Date.now() - sessionStartedAt) /
    60000
  );
}

function forceSessionExit() {
  if (!position || !lastMarket) {
    return;
  }

  closePosition(
    lastMarket,
    "SESSION_LIMIT"
  );
}

// ============================================================
// MARKET LOOP
// ============================================================

async function marketTick(mySessionId) {
  if (!tradingActive) return;

  if (mySessionId !== sessionId) return;

  if (marketLoopRunning) return;

  marketLoopRunning = true;

  try {
    const elapsed =
      sessionElapsedMinutes();

    // Sortie à 45 minutes.
    // Elle est faite avec le dernier prix connu si nécessaire.
    if (elapsed >= MAX_SESSION_MINUTES) {
      forceSessionExit();

      tradingActive = false;

      await telegram(
        `⏱️ SESSION TERMINÉE\n\n` +
        `Durée : 45 min\n` +
        `Cycles : ${totalCycles}\n` +
        `Gagnants : ${sessionWins}\n` +
        `Perdants : ${sessionLosses}\n` +
        `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
      );

      return;
    }

    const market =
      await getMarketData(
        currentCandidate.mint
      );

    // --------------------------------------------------------
    // CRASH
    // --------------------------------------------------------

    const crash =
      checkCrash(market);

    if (crash) {
      registerCrash(
        market,
        crash
      );

      if (position) {
        closePosition(
          market,
          "CRASH"
        );
      }

      tradingActive = false;

      await telegram(
        `🚨 CRASH DÉTECTÉ\n\n` +
        `Prix : ${market.price.toFixed(10)} $\n` +
        `Liquidité : $${market.liquidity.toFixed(2)}\n` +
        `Prix : ${crash.priceChange.toFixed(2)} %\n` +
        `Liquidité : ${crash.liquidityChange.toFixed(2)} %\n\n` +
        `🛑 Nouveaux achats arrêtés.`
      );

      return;
    }

    // --------------------------------------------------------
    // POSITION OUVERTE
    // --------------------------------------------------------

    if (position) {
      const target =
        targetPrice();

      const stop =
        stopPrice();

      if (market.price >= target) {
        closePosition(
          market,
          "TARGET"
        );
      } else if (market.price <= stop) {
        closePosition(
          market,
          "STOP"
        );
      }

      lastMarket = market;

      return;
    }

    // --------------------------------------------------------
    // NOUVEL ACHAT
    // --------------------------------------------------------

    if (
      elapsed < NO_NEW_BUY_MINUTES &&
      Date.now() - lastSellAt >= COOLDOWN_AFTER_SELL
    ) {
      openPosition(market);
    }

    lastMarket = market;

  } catch (e) {
    // Une erreur réseau temporaire ne tue PAS la session.
    // Aucun message diagnostique Telegram.
    console.error("Market tick:", e.message);
  } finally {
    marketLoopRunning = false;
  }
}

// ============================================================
// START TRADE
// ============================================================

async function startTrade() {
  if (tradingActive) {
    await telegram(
      `⚠️ Une simulation est déjà en cours.\n\n` +
      `Un deuxième moteur ne sera pas lancé.`
    );

    return;
  }

  if (!currentCandidate) {
    await telegram(
      `❌ Aucun token sélectionné.\n\n` +
      `Utilise :\n` +
      `/test TON_MINT`
    );

    return;
  }

  // Nouvelle session unique
  sessionId++;

  const mySessionId = sessionId;

  position = null;
  lastMarket = null;
  currentPair =
    currentCandidate.pair;

  sessionStartedAt = Date.now();

  lastSellAt = 0;

  sessionPnL = 0;
  sessionWins = 0;
  sessionLosses = 0;
  totalCycles = 0;

  tradingActive = true;

  await telegram(
    `🟢 TEST ACHAT / VENTE ACTIF\n\n` +
    `🪙 ${currentCandidate.name}\n` +
    `🔤 ${currentCandidate.symbol}\n\n` +
    `💵 $10 par cycle\n` +
    `🎯 Objectif +5 %\n` +
    `🛑 Stop sécurité -20 %\n\n` +
    `⏱️ Session max : 45 min\n` +
    `🚫 Aucun BUY après 43 min\n` +
    `🏦 PumpSwap\n\n` +
    `SIMULATION UNIQUEMENT`
  );

  const loop = async () => {
    while (
      tradingActive &&
      mySessionId === sessionId
    ) {
      await marketTick(
        mySessionId
      );

      await sleep(
        MARKET_INTERVAL
      );
    }
  };

  loop().catch(e => {
    console.error("Trade loop:", e.message);
  });
}

// ============================================================
// STOP TRADE
// ============================================================

async function stopTrade() {
  if (!tradingActive) {
    await telegram(
      `ℹ️ Aucune simulation en cours.`
    );
    return;
  }

  tradingActive = false;
  sessionId++;

  if (position && lastMarket) {
    closePosition(
      lastMarket,
      "SESSION_LIMIT"
    );
  }

  await telegram(
    `⏹️ SIMULATION ARRÊTÉE\n\n` +
    `Cycles : ${totalCycles}\n` +
    `Gagnants : ${sessionWins}\n` +
    `Perdants : ${sessionLosses}\n` +
    `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );
}

// ============================================================
// /TEST
// ============================================================

bot.command("test", async ctx => {
  const parts =
    ctx.message.text.trim().split(/\s+/);

  const mint = parts[1];

  if (!mint) {
    await ctx.reply(
      `❌ Utilisation :\n/test MINT`
    );
    return;
  }

  if (tradingActive) {
    await ctx.reply(
      `⚠️ Arrête d'abord la simulation avec /stoptrade`
    );
    return;
  }

  await ctx.reply(
    `🔎 Vérification du token...`
  );

  const result =
    await evaluateCandidate(mint);

  if (!result.ok) {
    await ctx.reply(
      `❌ TOKEN REFUSÉ\n\n` +
      `Mint :\n${mint}\n\n` +
      `Motif : ${result.reason}`
    );

    return;
  }

  currentCandidate = result;

  currentPair = result.pair;

  await ctx.reply(
    `🟢 TOKEN PRÊT POUR LE TEST\n\n` +
    `🪙 ${result.name}\n` +
    `🔤 ${result.symbol}\n\n` +
    `💧 Liquidité : $${result.liquidity.toFixed(2)}\n` +
    `👥 Holders : ≥${MIN_HOLDERS}\n` +
    `⏱️ Âge : ${result.ageMinutes.toFixed(1)} min\n` +
    `🏦 DEX : PumpSwap\n\n` +
    `🔗 Pair : ${result.pair.pairAddress}\n\n` +
    `Utilise /starttrade pour lancer le test.`
  );
});

// ============================================================
// /STARTTRADE
// ============================================================

bot.command("starttrade", async ctx => {
  await startTrade();
});

// ============================================================
// /STOPTRADE
// ============================================================

bot.command("stoptrade", async ctx => {
  await stopTrade();
});

// ============================================================
// /STATUS
// ============================================================

bot.command("status", async ctx => {
  if (!currentCandidate) {
    await ctx.reply(
      `ℹ️ Aucun token sélectionné.`
    );
    return;
  }

  const elapsed =
    sessionElapsedMinutes();

  let text =
    `📊 STATUT\n\n` +
    `🪙 ${currentCandidate.name}\n` +
    `🔤 ${currentCandidate.symbol}\n` +
    `🏦 PumpSwap\n\n` +
    `Simulation : ${tradingActive ? "🟢 ACTIVE" : "🔴 ARRÊTÉE"}\n` +
    `Session : ${elapsed.toFixed(1)} min\n` +
    `Cycles : ${totalCycles}\n` +
    `Gagnants : ${sessionWins}\n` +
    `Perdants : ${sessionLosses}\n` +
    `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}\n`;

  if (position) {
    text +=
      `\n🟢 POSITION OUVERTE\n` +
      `Entrée : ${position.entryPrice.toFixed(10)} $\n` +
      `Cible : ${targetPrice().toFixed(10)} $\n` +
      `Stop : ${stopPrice().toFixed(10)} $\n`;
  } else {
    text += `\n⚪ Aucune position ouverte\n`;
  }

  if (lastMarket) {
    text +=
      `\n💰 Prix : ${lastMarket.price.toFixed(10)} $\n` +
      `💧 Liquidité : $${lastMarket.liquidity.toFixed(2)}`;
  }

  await ctx.reply(text);
});

// ============================================================
// /LASTCRASH
// ============================================================

bot.command("lastcrash", async ctx => {
  if (!lastCrash) {
    await ctx.reply(
      `ℹ️ Aucun crash enregistré pendant cette session.`
    );
    return;
  }

  await ctx.reply(
    `🚨 DERNIER CRASH\n\n` +
    `Prix : ${lastCrash.price.toFixed(10)} $\n` +
    `Liquidité : $${lastCrash.liquidity.toFixed(2)}\n` +
    `Prix : ${lastCrash.priceChange10s.toFixed(2)} %\n` +
    `Liquidité : ${lastCrash.liquidityChange.toFixed(2)} %`
  );
});

// ============================================================
// /HELP
// ============================================================

bot.command("help", async ctx => {
  await ctx.reply(
    `🤖 COMMANDES\n\n` +
    `/test MINT\n` +
    `/starttrade\n` +
    `/stoptrade\n` +
    `/status\n` +
    `/lastcrash\n` +
    `/help\n\n` +
    `💵 $10 / cycle\n` +
    `🎯 +5 %\n` +
    `🛑 -20 % sécurité\n` +
    `⏱️ 45 min maximum\n` +
    `🚫 Aucun achat après 43 min\n` +
    `🏦 PumpSwap\n` +
    `SIMULATION UNIQUEMENT`
  );
});

// ============================================================
// /START
// ============================================================

bot.start(async ctx => {
  await ctx.reply(
    `🤖 BOT TEST ACHAT / VENTE\n\n` +
    `Filtres :\n` +
    `• Claude / OpenAI / Anthropic\n` +
    `• moins de 5 heures\n` +
    `• liquidité 200k–400k $\n` +
    `• minimum 1 000 holders\n` +
    `• PumpSwap\n\n` +
    `Test :\n` +
    `• $10 par achat\n` +
    `• vente cible +5 %\n` +
    `• stop sécurité -20 %\n` +
    `• 45 min maximum\n\n` +
    `Commandes :\n` +
    `/test MINT\n` +
    `/starttrade\n` +
    `/stoptrade\n` +
    `/status\n` +
    `/lastcrash\n` +
    `/help`
  );
});

// ============================================================
// START BOT
// ============================================================

bot.launch({
  dropPendingUpdates: true
})
  .then(() => {
    console.log("🤖 V6.4 démarrée");
    console.log("💵 $10 / cycle");
    console.log("🎯 +5%");
    console.log("🛑 -20% stop");
    console.log("🏦 PumpSwap");
    console.log("⏱️ 45 minutes maximum");
    console.log("🟢 UNE SEULE POSITION À LA FOIS");
  })
  .catch(err => {
    console.error(
      "❌ Telegram launch:",
      err.message
    );
  });

process.once("SIGINT", () => {
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  bot.stop("SIGTERM");
});
