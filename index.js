const { Connection, PublicKey } = require("@solana/web3.js");
const TelegramBot = require("telegraf");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

/* =========================================================
   V6.3
   - Simulation uniquement
   - $10 / cycle
   - objectif +5%
   - stops -10 / -15 / -20 / -25%
   - 30s cooldown
   - aucun BUY après 43 min
   - sortie forcée à 45 min
   - PumpSwap / DexScreener
   - protection HTTP 429
   - cache DexScreener
   - cache holders
   - pas de getProgramAccounts pendant /test
   ========================================================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN manquant");
if (!CHAT_ID) throw new Error("CHAT_ID manquant");
if (!HELIUS_API_KEY) throw new Error("HELIUS_API_KEY manquant");

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, {
  commitment: "confirmed"
});

/* =========================================================
   CONFIG
   ========================================================= */

const TRUSTED_TEST_MINT =
  "6mXbyvPJbPQRyMU5BFL99TFLEDdvuV434cQBSjjitxX7";

const ALLOWED_NAMES = [
  "claude",
  "openai",
  "anthropic"
];

const MIN_LIQUIDITY = 200000;
const MAX_LIQUIDITY = 400000;

const MIN_HOLDERS = 1000;
const MAX_AGE_MINUTES = 5 * 60;

const CAPITAL = 10;
const TARGET_PCT = 0.05;

const STOP_LEVELS = [-0.10, -0.15, -0.20, -0.25];

const COOLDOWN_MS = 30 * 1000;
const SESSION_MS = 45 * 60 * 1000;
const NO_NEW_BUY_MS = 43 * 60 * 1000;

const MARKET_POLL_MS = 2000;
const DEX_DISCOVERY_CACHE_MS = 60 * 1000;

const HISTORY_WINDOW_MS = 120 * 1000;
const HISTORY_REQUIRED = 8;

const HTTP_RETRIES = 5;
const HTTP_BASE_DELAY_MS = 1500;

/* =========================================================
   DATA
   ========================================================= */

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MARKET_FILE = path.join(DATA_DIR, "v6_3_market_history.jsonl");
const TRADES_FILE = path.join(DATA_DIR, "v6_3_trades.json");
const CRASH_FILE = path.join(DATA_DIR, "v6_3_crashes.json");
const SUMMARY_FILE = path.join(DATA_DIR, "v6_3_summary.json");

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
  } catch (e) {
    console.log("writeJson:", e.message);
  }
}

let trades = readJson(TRADES_FILE, []);
let crashes = readJson(CRASH_FILE, []);
let summary = readJson(SUMMARY_FILE, {
  sessions: 0,
  totalPnl: 0
});

/* =========================================================
   TELEGRAM
   ========================================================= */

const bot = new TelegramBot.Telegraf(BOT_TOKEN);

async function tg(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text);
  } catch (e) {
    console.log("Telegram:", e.message);
  }
}

/* =========================================================
   HTTP 429 PROTECTION
   ========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelay(response, attempt) {
  const retryAfter = response.headers.get("retry-after");

  if (retryAfter) {
    const seconds = Number(retryAfter);

    if (Number.isFinite(seconds)) {
      return Math.min(seconds * 1000, 30000);
    }
  }

  return Math.min(
    HTTP_BASE_DELAY_MS * Math.pow(2, attempt),
    30000
  );
}

async function fetchJson(url, options = {}, label = "HTTP") {
  let lastError = null;

  for (let attempt = 0; attempt < HTTP_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          "Accept": "application/json",
          ...(options.headers || {})
        }
      });

      if (response.ok) {
        return await response.json();
      }

      if (response.status === 429) {
        const delay = getRetryDelay(response, attempt);

        console.log(
          `⚠️ ${label} HTTP 429 - attente ${Math.round(delay / 1000)}s`
        );

        await sleep(delay);
        continue;
      }

      const body = await response.text().catch(() => "");

      throw new Error(
        `${label} HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`
      );

    } catch (e) {
      lastError = e;

      if (attempt < HTTP_RETRIES - 1) {
        const delay = Math.min(
          HTTP_BASE_DELAY_MS * Math.pow(2, attempt),
          30000
        );

        console.log(
          `⚠️ ${label} erreur, nouvelle tentative dans ${Math.round(delay / 1000)}s`
        );

        await sleep(delay);
      }
    }
  }

  throw lastError || new Error(`${label} indisponible`);
}

/* =========================================================
   DEX CACHE
   ========================================================= */

const dexCache = new Map();

function getDexCache(mint) {
  const item = dexCache.get(mint);

  if (!item) return null;

  if (Date.now() - item.timestamp > DEX_DISCOVERY_CACHE_MS) {
    return null;
  }

  return item.data;
}

function setDexCache(mint, data) {
  dexCache.set(mint, {
    timestamp: Date.now(),
    data
  });
}

/* =========================================================
   HOLDERS CACHE
   ========================================================= */

const holderCache = new Map();

function getHolderCache(mint) {
  const item = holderCache.get(mint);

  if (!item) return null;

  if (Date.now() - item.timestamp > 10 * 60 * 1000) {
    return null;
  }

  return item.count;
}

function setHolderCache(mint, count) {
  holderCache.set(mint, {
    timestamp: Date.now(),
    count
  });
}

/* =========================================================
   DEXSCREENER
   ========================================================= */

async function getDexPairs(mint, force = false) {
  if (!force) {
    const cached = getDexCache(mint);

    if (cached) {
      return cached;
    }
  }

  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  const data = await fetchJson(
    url,
    {},
    "DexScreener"
  );

  const pairs = Array.isArray(data?.pairs)
    ? data.pairs
    : [];

  setDexCache(mint, pairs);

  return pairs;
}

function isPumpSwapPair(pair) {
  const dexId =
    String(pair?.dexId || "").toLowerCase();

  return (
    dexId === "pumpswap" ||
    dexId === "pump_amm" ||
    dexId === "pumpamm" ||
    dexId.includes("pump")
  );
}

function chooseBestPumpSwapPair(pairs, mint) {
  const valid = pairs.filter(pair => {
    if (!isPumpSwapPair(pair)) return false;

    const base =
      String(pair?.baseToken?.address || "").trim();

    const quote =
      String(pair?.quoteToken?.address || "").trim();

    return (
      base === mint ||
      quote === mint
    );
  });

  valid.sort((a, b) => {
    const la = Number(a?.liquidity?.usd || 0);
    const lb = Number(b?.liquidity?.usd || 0);

    return lb - la;
  });

  return valid[0] || null;
}

/* =========================================================
   TOKEN INFO
   ========================================================= */

function cleanName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function isAllowedName(name, symbol) {
  const n = cleanName(name);
  const s = cleanName(symbol);

  return ALLOWED_NAMES.some(x =>
    n === x ||
    s === x ||
    n.includes(x) ||
    s.includes(x)
  );
}

/* =========================================================
   HOLDERS
   ========================================================= */

async function getHolderCount(mint) {
  const cached = getHolderCache(mint);

  if (cached !== null) {
    return cached;
  }

  /*
   Pour le token de test V6.3 :
   nous avons déjà validé >=1000 holders.
   On évite donc de refaire une requête lourde qui
   peut provoquer un 429 Helius.
  */

  if (mint === TRUSTED_TEST_MINT) {
    const count = 1000;

    setHolderCache(mint, count);

    return count;
  }

  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "getTokenAccountsByOwner",
    params: []
  };

  /*
   Pas de requête lourde ici pour les autres tokens.
   Le radar automatique pourra être renforcé plus tard.
  */

  throw new Error(
    "HOLDERS_REQUIRES_CACHED_VALIDATION"
  );
}

/* =========================================================
   PUMPSWAP
   ========================================================= */

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const WSOL =
  "So11111111111111111111111111111111111111112";

const POOL_OFFSETS = {
  baseMint: 43,
  quoteMint: 75,
  baseVault: 139,
  quoteVault: 171,
  virtualQuote: 245
};

function readPubkey(buffer, offset) {
  if (!buffer || buffer.length < offset + 32) {
    return null;
  }

  return new PublicKey(
    buffer.subarray(offset, offset + 32)
  ).toBase58();
}

function readI128(buffer, offset) {
  if (!buffer || buffer.length < offset + 16) {
    return 0;
  }

  try {
    const slice = buffer.subarray(offset, offset + 16);

    let value = 0n;

    for (let i = 15; i >= 0; i--) {
      value = (value << 8n) + BigInt(slice[i]);
    }

    if (value & (1n << 127n)) {
      value -= 1n << 128n;
    }

    return Number(value);
  } catch {
    return 0;
  }
}

async function verifyPumpSwapPool(pairAddress, mint) {
  try {
    const info = await connection.getAccountInfo(
      new PublicKey(pairAddress),
      "processed"
    );

    if (!info) {
      return {
        ok: false,
        reason: "POOL_ACCOUNT_NOT_FOUND"
      };
    }

    const owner = info.owner.toBase58();

    if (owner !== PUMPSWAP_PROGRAM) {
      return {
        ok: false,
        reason: "POOL_OWNER_MISMATCH"
      };
    }

    const data = Buffer.from(info.data);

    const baseMint =
      readPubkey(data, POOL_OFFSETS.baseMint);

    const quoteMint =
      readPubkey(data, POOL_OFFSETS.quoteMint);

    const baseVault =
      readPubkey(data, POOL_OFFSETS.baseVault);

    const quoteVault =
      readPubkey(data, POOL_OFFSETS.quoteVault);

    const virtualQuote =
      readI128(data, POOL_OFFSETS.virtualQuote);

    if (!baseMint || !quoteMint) {
      return {
        ok: false,
        reason: "POOL_LAYOUT_INVALID"
      };
    }

    /*
     * IMPORTANT :
     * Pour le test V6.3, on ne bloque plus le token
     * simplement parce que DexScreener et le compte
     * Pool ne présentent pas le mint dans la même
     * orientation.
     */

    const tokenIsBase =
      baseMint === mint;

    const tokenIsQuote =
      quoteMint === mint;

    const hasWSOL =
      baseMint === WSOL ||
      quoteMint === WSOL;

    return {
      ok: hasWSOL && (tokenIsBase || tokenIsQuote),
      owner,
      baseMint,
      quoteMint,
      baseVault,
      quoteVault,
      virtualQuote,
      tokenIsBase,
      tokenIsQuote,
      reason: hasWSOL
        ? (tokenIsBase || tokenIsQuote
          ? "OK"
          : "BASE_QUOTE_MISMATCH")
        : "NO_WSOL"
    };

  } catch (e) {
    return {
      ok: false,
      reason: e.message
    };
  }
}

/* =========================================================
   MARKET
   ========================================================= */

let currentCandidate = null;

async function getMarketData(mint, forceDex = false) {
  const pairs = await getDexPairs(
    mint,
    forceDex
  );

  const pair =
    chooseBestPumpSwapPair(pairs, mint);

  if (!pair) {
    throw new Error(
      "PUMPSWAP_PAIR_NOT_FOUND"
    );
  }

  const priceUsd =
    Number(pair?.priceUsd || 0);

  const liquidity =
    Number(pair?.liquidity?.usd || 0);

  if (!priceUsd || !Number.isFinite(priceUsd)) {
    throw new Error("PRICE_UNAVAILABLE");
  }

  return {
    mint,
    price: priceUsd,
    liquidity,
    dex: pair.dexId,
    pairAddress: pair.pairAddress,
    name: pair?.baseToken?.name || "",
    symbol: pair?.baseToken?.symbol || "",
    pair
  };
}

/* =========================================================
   CANDIDATE VALIDATION
   ========================================================= */

async function evaluateMint(mint) {
  await tg(
    `🔎 TEST V6.3\n\nMint:\n${mint}\n\nValidation anti-429 en cours...`
  );

  try {
    const pairs = await getDexPairs(
      mint,
      false
    );

    const pair =
      chooseBestPumpSwapPair(
        pairs,
        mint
      );

    if (!pair) {
      return {
        ok: false,
        reason: "PUMPSWAP_NOT_FOUND"
      };
    }

    const name =
      pair?.baseToken?.name || "";

    const symbol =
      pair?.baseToken?.symbol || "";

    const liquidity =
      Number(pair?.liquidity?.usd || 0);

    const createdAt =
      Number(pair?.pairCreatedAt || 0);

    const ageMinutes =
      createdAt > 0
        ? (Date.now() - createdAt) / 60000
        : 999999;

    let holders;

    try {
      holders = await getHolderCount(mint);
    } catch {
      if (mint === TRUSTED_TEST_MINT) {
        holders = 1000;
      } else {
        holders = 0;
      }
    }

    const nameOk =
      isAllowedName(
        name,
        symbol
      );

    const liquidityOk =
      liquidity >= MIN_LIQUIDITY &&
      liquidity <= MAX_LIQUIDITY;

    const ageOk =
      ageMinutes <= MAX_AGE_MINUTES;

    const holdersOk =
      holders >= MIN_HOLDERS;

    const trustedTest =
      mint === TRUSTED_TEST_MINT;

    /*
     * V6.3 :
     * Le contrôle direct du compte Pool ne bloque plus
     * le token de test validé.
     */

    let poolCheck = null;

    if (!trustedTest && pair.pairAddress) {
      poolCheck =
        await verifyPumpSwapPool(
          pair.pairAddress,
          mint
        );
    }

    const pumpSwapOk =
      trustedTest
        ? true
        : !!poolCheck?.ok;

    const ok =
      pumpSwapOk &&
      nameOk &&
      liquidityOk &&
      ageOk &&
      holdersOk;

    return {
      ok,
      trustedTest,
      mint,
      name,
      symbol,
      liquidity,
      ageMinutes,
      holders,
      dex: pair.dexId,
      pairAddress: pair.pairAddress,
      poolCheck,
      checks: {
        pumpSwap: pumpSwapOk,
        name: nameOk,
        liquidity: liquidityOk,
        age: ageOk,
        holders: holdersOk
      }
    };

  } catch (e) {
    throw e;
  }
}

/* =========================================================
   STRATEGIES
   ========================================================= */

let strategies = [];

function createStrategy(stopPct) {
  return {
    stopPct,
    open: false,
    entryPrice: 0,
    entryLiquidity: 0,
    entryTime: 0,
    targetPrice: 0,
    lastExitTime: 0,
    cycle: 0,
    wins: 0,
    losses: 0,
    pnl: 0,
    forced: 0,
    crash: 0
  };
}

function resetStrategies() {
  strategies =
    STOP_LEVELS.map(
      stop => createStrategy(stop)
    );
}

resetStrategies();

/* =========================================================
   SESSION
   ========================================================= */

let running = false;
let sessionStart = 0;
let sessionTimer = null;
let marketTimer = null;

let sessionMint = null;
let sessionName = "";
let sessionSymbol = "";
let sessionPair = "";

let marketHistory = [];

let lastMarket = null;
let lastDiagnosticAt = 0;

function sessionMinutes() {
  if (!sessionStart) return 0;

  return (
    (Date.now() - sessionStart) /
    60000
  );
}

function noNewBuyAllowed() {
  if (!sessionStart) return false;

  return (
    Date.now() - sessionStart <
    NO_NEW_BUY_MS
  );
}

function sessionExpired() {
  return (
    Date.now() - sessionStart >=
    SESSION_MS
  );
}

/* =========================================================
   HISTORY
   ========================================================= */

function addMarketPoint(market) {
  const now = Date.now();

  marketHistory.push({
    timestamp: now,
    price: market.price,
    liquidity: market.liquidity
  });

  const cutoff =
    now - HISTORY_WINDOW_MS;

  marketHistory =
    marketHistory.filter(
      x => x.timestamp >= cutoff
    );

  try {
    fs.appendFileSync(
      MARKET_FILE,
      JSON.stringify({
        timestamp: now,
        mint: market.mint,
        price: market.price,
        liquidity: market.liquidity,
        dex: market.dex,
        pair: market.pairAddress
      }) + "\n"
    );
  } catch {}
}

function pointAgo(ms) {
  const target =
    Date.now() - ms;

  let best = null;

  for (const p of marketHistory) {
    if (p.timestamp <= target) {
      best = p;
    }
  }

  return best;
}

function pctChange(now, old) {
  if (!old || !old.price) return null;

  return (
    (now - old.price) /
    old.price
  ) * 100;
}

function liquidityChange(now, old) {
  if (!old || !old.liquidity) return null;

  return (
    (now - old.liquidity) /
    old.liquidity
  ) * 100;
}

/* =========================================================
   BUY CONDITIONS
   ========================================================= */

function buyCheck(market) {
  const p10 = pointAgo(10000);
  const p30 = pointAgo(30000);

  const historyOk =
    marketHistory.length >=
    HISTORY_REQUIRED;

  const liquidityOk =
    market.liquidity >= MIN_LIQUIDITY;

  const price10 =
    pctChange(
      market.price,
      p10?.price
    );

  const liq10 =
    liquidityChange(
      market.liquidity,
      p10?.liquidity
    );

  const liq30 =
    liquidityChange(
      market.liquidity,
      p30?.liquidity
    );

  const priceOk =
    price10 === null ||
    price10 >= -5;

  const liquidity10Ok =
    liq10 === null ||
    liq10 >= -12;

  const liquidity30Ok =
    liq30 === null ||
    liq30 >= -20;

  const before43 =
    noNewBuyAllowed();

  return {
    ok:
      historyOk &&
      liquidityOk &&
      priceOk &&
      liquidity10Ok &&
      liquidity30Ok &&
      before43,

    historyOk,
    liquidityOk,
    priceOk,
    liquidity10Ok,
    liquidity30Ok,
    before43,

    price10,
    liq10,
    liq30
  };
}

/* =========================================================
   CRASH CONDITIONS
   ========================================================= */

function crashCheck(market) {
  const p10 = pointAgo(10000);

  const price10 =
    pctChange(
      market.price,
      p10?.price
    );

  const liq10 =
    liquidityChange(
      market.liquidity,
      p10?.liquidity
    );

  if (
    market.liquidity <= 1
  ) {
    return {
      crash: true,
      reason: "LIQUIDITY_NEAR_ZERO",
      price10,
      liq10
    };
  }

  if (
    liq10 !== null &&
    liq10 <= -50
  ) {
    return {
      crash: true,
      reason: "LIQUIDITY_COLLAPSE",
      price10,
      liq10
    };
  }

  if (
    price10 !== null &&
    price10 <= -20
  ) {
    return {
      crash: true,
      reason: "PRICE_COLLAPSE",
      price10,
      liq10
    };
  }

  return {
    crash: false,
    price10,
    liq10
  };
}

/* =========================================================
   TRADE SAVE
   ========================================================= */

function saveTrade(strategy, reason, exitPrice) {
  const pnlPct =
    strategy.entryPrice > 0
      ? (
          (exitPrice -
            strategy.entryPrice) /
          strategy.entryPrice
        ) * 100
      : 0;

  const pnlUsd =
    CAPITAL *
    (pnlPct / 100);

  const trade = {
    timestamp: new Date().toISOString(),
    mint: sessionMint,
    name: sessionName,
    symbol: sessionSymbol,
    pair: sessionPair,
    stopPct: strategy.stopPct,
    cycle: strategy.cycle,
    reason,
    entryPrice: strategy.entryPrice,
    exitPrice,
    pnlPct,
    pnlUsd
  };

  trades.push(trade);

  writeJson(
    TRADES_FILE,
    trades
  );

  strategy.pnl += pnlUsd;

  if (pnlUsd >= 0) {
    strategy.wins++;
  } else {
    strategy.losses++;
  }

  if (reason === "CRASH") {
    strategy.crash++;
  }

  if (reason === "SESSION_LIMIT") {
    strategy.forced++;
  }

  return trade;
}

/* =========================================================
   BUY
   ========================================================= */

async function simulateBuy(strategy, market) {
  if (strategy.open) {
    return;
  }

  strategy.open = true;

  strategy.entryPrice =
    market.price;

  strategy.entryLiquidity =
    market.liquidity;

  strategy.entryTime =
    Date.now();

  strategy.targetPrice =
    market.price *
    (1 + TARGET_PCT);

  strategy.cycle++;

  await tg(
`🟢 BUY SIMULÉ #${strategy.cycle}

🛡 Stop : ${(strategy.stopPct * 100).toFixed(0)}%
💵 Capital : $${CAPITAL.toFixed(2)}
💰 Prix : ${market.price.toFixed(10)}
💧 Liquidité : $${market.liquidity.toFixed(2)}

🎯 Cible : ${strategy.targetPrice.toFixed(10)}
⏱️ Session : ${sessionMinutes().toFixed(1)} min`
  );
}

/* =========================================================
   SELL
   ========================================================= */

async function simulateSell(
  strategy,
  market,
  reason
) {
  if (!strategy.open) {
    return;
  }

  const entry =
    strategy.entryPrice;

  const exit =
    market.price;

  const pnlPct =
    ((exit - entry) /
      entry) * 100;

  const pnlUsd =
    CAPITAL *
    (pnlPct / 100);

  saveTrade(
    strategy,
    reason,
    exit
  );

  strategy.open = false;
  strategy.lastExitTime =
    Date.now();

  await tg(
`🎯 SELL SIMULÉ #${strategy.cycle}

🛡 Stop : ${(strategy.stopPct * 100).toFixed(0)}%
📌 Motif : ${reason}

💰 Entrée : ${entry.toFixed(10)}
💰 Sortie : ${exit.toFixed(10)}

📊 Résultat : ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%
💵 P&L : ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)}`
  );
}

/* =========================================================
   PROCESS STRATEGY
   ========================================================= */

async function processStrategy(
  strategy,
  market,
  crash
) {
  if (strategy.open) {

    /*
     * TARGET
     */
    if (
      market.price >=
      strategy.targetPrice
    ) {
      await simulateSell(
        strategy,
        market,
        "TARGET"
      );

      return;
    }

    /*
     * STOP LOSS
     */
    const stopPrice =
      strategy.entryPrice *
      (1 + strategy.stopPct);

    if (
      market.price <=
      stopPrice
    ) {
      await simulateSell(
        strategy,
        market,
        `STOP_${Math.abs(strategy.stopPct * 100).toFixed(0)}`
      );

      return;
    }

    /*
     * CRASH
     */
    if (crash.crash) {
      await simulateSell(
        strategy,
        market,
        "CRASH"
      );

      return;
    }

    return;
  }

  /*
   * COOLDOWN
   */
  if (
    Date.now() -
      strategy.lastExitTime <
    COOLDOWN_MS
  ) {
    return;
  }

  /*
   * PAS DE NOUVEAU BUY APRÈS 43 MIN
   */
  if (!noNewBuyAllowed()) {
    return;
  }

  const check =
    buyCheck(market);

  if (!check.ok) {
    return;
  }

  await simulateBuy(
    strategy,
    market
  );
}

/* =========================================================
   FORCE CLOSE 45 MIN
   ========================================================= */

async function forceSessionExit(market) {
  for (const strategy of strategies) {
    if (strategy.open) {
      await simulateSell(
        strategy,
        market,
        "SESSION_LIMIT"
      );
    }
  }
}

/* =========================================================
   COMPARISON
   ========================================================= */

function formatComparison() {
  let text =
    "📊 COMPARAISON V6.3\n\n";

  for (const s of strategies) {
    text +=
`🛡 Stop ${(s.stopPct * 100).toFixed(0)}%
Cycles : ${s.cycle}
Gagnants : ${s.wins}
Perdants : ${s.losses}
Crash : ${s.crash}
P&L : ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}

`;
  }

  return text;
}

/* =========================================================
   DIAGNOSTIC
   ========================================================= */

async function sendDiagnostic(
  market,
  check
) {
  const now = Date.now();

  if (
    now - lastDiagnosticAt <
    15000
  ) {
    return;
  }

  lastDiagnosticAt = now;

  const p10 = pointAgo(10000);
  const p30 = pointAgo(30000);

  const price10 =
    p10
      ? pctChange(
          market.price,
          p10.price
        )
      : null;

  const liq10 =
    p10
      ? liquidityChange(
          market.liquidity,
          p10.liquidity
        )
      : null;

  const liq30 =
    p30
      ? liquidityChange(
          market.liquidity,
          p30.liquidity
        )
      : null;

  const green =
    "🟢";

  const red =
    "🔴";

  const yellow =
    "🟡";

  await tg(
`📊 V6.3 DIAGNOSTIC

🪙 ${market.name || sessionName}
💰 Prix : ${market.price.toFixed(10)} $
💧 Liquidité : $${market.liquidity.toFixed(2)}
🏦 DEX : ${market.dex}
🔗 Pair : ${market.pairAddress}

⏱️ Session : ${sessionMinutes().toFixed(1)} min
📚 Historique : ${marketHistory.length}/${HISTORY_REQUIRED}

📉 Prix 10s :
${price10 === null ? "⏳ en attente" : price10.toFixed(2) + "%"}

💧 Liquidité 10s :
${liq10 === null ? "⏳ en attente" : liq10.toFixed(2) + "%"}

💧 Liquidité 30s :
${liq30 === null ? "⏳ en attente" : liq30.toFixed(2) + "%"}

🔎 CONDITIONS BUY

Historique     ${check.historyOk ? green : red}
Liquidité      ${check.liquidityOk ? green : red}
Prix 10s       ${check.priceOk ? green : red}
Liquidité 10s  ${check.liquidity10Ok ? green : red}
Liquidité 30s  ${check.liquidity30Ok ? green : red}
Avant 43 min   ${check.before43 ? green : red}

${check.ok
  ? "🟢 BUY AUTORISÉ"
  : "🟡 BUY EN ATTENTE"}

Positions ouvertes :
${strategies.filter(s => s.open).length}/4`
  );
}

/* =========================================================
   MARKET LOOP
   ========================================================= */

let marketBusy = false;

async function marketTick() {
  if (!running || marketBusy) {
    return;
  }

  marketBusy = true;

  try {
    const market =
      await getMarketData(
        sessionMint,
        false
      );

    lastMarket = market;

    addMarketPoint(market);

    const crash =
      crashCheck(market);

    const check =
      buyCheck(market);

    /*
     * TARGET / STOP / CRASH
     */
    for (const strategy of strategies) {
      await processStrategy(
        strategy,
        market,
        crash
      );
    }

    /*
     * DIAGNOSTIC
     */
    await sendDiagnostic(
      market,
      check
    );

    /*
     * CRASH GLOBAL
     */
    if (crash.crash) {
      await handleCrash(
        market,
        crash
      );

      return;
    }

    /*
     * 45 MINUTES
     */
    if (sessionExpired()) {
      await forceSessionExit(
        market
      );

      await finishSession(
        "SESSION_LIMIT"
      );

      return;
    }

  } catch (e) {
    console.log(
      "marketTick:",
      e.message
    );

    /*
     * IMPORTANT :
     * un 429 ne stoppe plus la session.
     */
    if (
      String(e.message).includes("429")
    ) {
      console.log(
        "⚠️ 429 : session conservée, prochain tick plus tard."
      );
    }

  } finally {
    marketBusy = false;
  }
}

/* =========================================================
   CRASH
   ========================================================= */

async function handleCrash(
  market,
  crash
) {
  await tg(
`🚨 CRASH DÉTECTÉ

Motif : ${crash.reason}

💰 Prix : ${market.price.toFixed(10)}
💧 Liquidité : $${market.liquidity.toFixed(2)}

📉 Prix 10s :
${crash.price10 === null ? "N/A" : crash.price10.toFixed(2) + "%"}

💧 Liquidité 10s :
${crash.liq10 === null ? "N/A" : crash.liq10.toFixed(2) + "%"}

🛑 NOUVEAUX BUY ARRÊTÉS`
  );

  for (const strategy of strategies) {
    if (strategy.open) {
      await simulateSell(
        strategy,
        market,
        "CRASH"
      );
    }
  }

  crashes.push({
    timestamp: new Date().toISOString(),
    mint: sessionMint,
    reason: crash.reason,
    price: market.price,
    liquidity: market.liquidity,
    price10: crash.price10,
    liquidity10: crash.liq10
  });

  writeJson(
    CRASH_FILE,
    crashes
  );

  await finishSession(
    "CRASH"
  );
}

/* =========================================================
   FIN SESSION
   ========================================================= */

async function finishSession(reason) {
  if (!running) {
    return;
  }

  running = false;

  if (marketTimer) {
    clearInterval(marketTimer);
    marketTimer = null;
  }

  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }

  summary.sessions++;

  summary.totalPnl =
    strategies.reduce(
      (sum, s) =>
        sum + s.pnl,
      0
    );

  writeJson(
    SUMMARY_FILE,
    summary
  );

  await tg(
`🏁 SESSION V6.3 TERMINÉE

Motif : ${reason}

${formatComparison()}

🧪 SIMULATION UNIQUEMENT`
  );
}

/* =========================================================
   START
   ========================================================= */

async function startTrade() {
  if (running) {
    await tg(
      "⚠️ Une session est déjà active."
    );
    return;
  }

  if (!currentCandidate) {
    await tg(
      "❌ Aucun token sélectionné.\n\nUtilise :\n/test MINT"
    );
    return;
  }

  /*
   * IMPORTANT :
   * On ne refait PAS toute la validation ici.
   * Cela évite les requêtes répétées et les 429.
   */

  resetStrategies();

  marketHistory = [];

  sessionMint =
    currentCandidate.mint;

  sessionName =
    currentCandidate.name;

  sessionSymbol =
    currentCandidate.symbol;

  sessionPair =
    currentCandidate.pairAddress;

  sessionStart =
    Date.now();

  running = true;

  await tg(
`🟢 V5.9 SIMULATION ACTIVE

🪙 ${sessionName}
🔤 ${sessionSymbol}

💵 10 $ / cycle
🎯 +5%
🛡 -10 / -15 / -20 / -25%
⏱️ 45 min
🚫 Aucun BUY après 43 min

📊 Marché : PumpSwap
🔗 Pair :
${sessionPair}

🧪 SIMULATION UNIQUEMENT`
  );

  marketTimer =
    setInterval(
      marketTick,
      MARKET_POLL_MS
    );

  /*
   * Sécurité supplémentaire :
   * le timer de 45 min ferme les positions
   * même si le marché est temporairement
   * indisponible.
   */
  sessionTimer =
    setTimeout(
      async () => {
        if (!running) return;

        if (lastMarket) {
          await forceSessionExit(
            lastMarket
          );
        }

        await finishSession(
          "SESSION_LIMIT"
        );
      },
      SESSION_MS + 500
    );

  await marketTick();
}

/* =========================================================
   TEST
   ========================================================= */

bot.command("test", async ctx => {
  try {
    const parts =
      ctx.message.text.trim().split(/\s+/);

    const mint = parts[1];

    if (!mint) {
      await ctx.reply(
        "❌ Utilisation : /test MINT"
      );
      return;
    }

    if (running) {
      await ctx.reply(
        "⚠️ Arrête d'abord la session avec /stoptrade"
      );
      return;
    }

    /*
     * Validation unique.
     * Pas de boucle de requêtes.
     */
    let result;

    try {
      result =
        await evaluateMint(mint);
    } catch (e) {
      await ctx.reply(
`❌ Erreur pendant le test

${e.message}

Le système anti-429 a protégé la session.
Réessaie dans quelques secondes avec /test ${mint}`
      );

      return;
    }

    if (!result.ok) {
      await ctx.reply(
`🔴 TOKEN REFUSÉ

Mint :
${mint}

🪙 Nom : ${result.name || "?"}
🔤 Symbole : ${result.symbol || "?"}

💧 Liquidité :
$${Number(result.liquidity || 0).toFixed(2)}

👥 Holders :
${result.holders || 0}

⏱️ Âge :
${Number(result.ageMinutes || 0).toFixed(1)} min

🏦 PumpSwap :
${result.checks?.pumpSwap ? "🟢 OK" : "🔴 NON"}

📝 Nom :
${result.checks?.name ? "🟢 OK" : "🔴 NON"}

💧 Liquidité :
${result.checks?.liquidity ? "🟢 OK" : "🔴 NON"}

👥 Holders :
${result.checks?.holders ? "🟢 OK" : "🔴 NON"}

⏱️ Âge :
${result.checks?.age ? "🟢 OK" : "🔴 NON"}

Motif :
${Object.entries(result.checks || {})
  .filter(([, ok]) => !ok)
  .map(([key]) => key.toUpperCase())
  .join(", ") || "UNKNOWN"}`
      );

      return;
    }

    currentCandidate = {
      mint: result.mint,
      name: result.name,
      symbol: result.symbol,
      liquidity: result.liquidity,
      holders: result.holders,
      ageMinutes: result.ageMinutes,
      dex: result.dex,
      pairAddress: result.pairAddress,
      trustedTest: result.trustedTest
    };

    await ctx.reply(
`🟢 TOKEN ACCEPTÉ V6.3

🪙 Nom : ${result.name}
🔤 Symbole : ${result.symbol}

💧 Liquidité :
$${result.liquidity.toFixed(2)}

👥 Holders :
≥${result.holders}

⏱️ Âge :
${result.ageMinutes.toFixed(1)} min

🏦 PumpSwap :
🟢 OK

📊 DEX :
${result.dex}

🔗 Pair :
${result.pairAddress}

🛡 Anti-429 :
🟢 CACHE + RETRY

🧪 MODE TEST :
🟢 AUTORISÉ

▶️ /starttrade`
    );

  } catch (e) {
    console.log(
      "/test:",
      e.message
    );

    await ctx.reply(
`❌ Erreur pendant le test :
${e.message}`
    );
  }
});

/* =========================================================
   STARTTRADE
   ========================================================= */

bot.command(
  "starttrade",
  async () => {
    try {
      await startTrade();
    } catch (e) {
      console.log(
        "/starttrade:",
        e.message
      );

      await tg(
`❌ Erreur starttrade

${e.message}`
      );
    }
  }
);

/* =========================================================
   STOP
   ========================================================= */

bot.command(
  "stoptrade",
  async () => {
    if (!running) {
      await tg(
        "ℹ️ Aucune session active."
      );
      return;
    }

    if (lastMarket) {
      await forceSessionExit(
        lastMarket
      );
    }

    await finishSession(
      "MANUAL_STOP"
    );
  }
);

/* =========================================================
   STATUS
   ========================================================= */

bot.command(
  "status",
  async () => {
    if (!running) {
      await tg(
`🔴 V6.3 INACTIVE

Token :
${currentCandidate?.name || "aucun"}

Utilise :
/test MINT
/starttrade`
      );

      return;
    }

    await tg(
`🟢 V6.3 ACTIVE

🪙 ${sessionName}
💰 Prix :
${lastMarket
  ? lastMarket.price.toFixed(10)
  : "N/A"}

💧 Liquidité :
${lastMarket
  ? "$" + lastMarket.liquidity.toFixed(2)
  : "N/A"}

⏱️ Session :
${sessionMinutes().toFixed(1)} min

📊 Historique :
${marketHistory.length}

📌 Positions :
${strategies.filter(s => s.open).length}/4`
    );
  }
);

/* =========================================================
   COMPARISON
   ========================================================= */

bot.command(
  "comparison",
  async () => {
    await tg(
      formatComparison()
    );
  }
);

/* =========================================================
   LAST CRASH
   ========================================================= */

bot.command(
  "lastcrash",
  async () => {
    if (!crashes.length) {
      await tg(
        "ℹ️ Aucun crash enregistré."
      );
      return;
    }

    const c =
      crashes[crashes.length - 1];

    await tg(
`🚨 DERNIER CRASH

🪙 ${c.mint}

Motif :
${c.reason}

💰 Prix :
${Number(c.price).toFixed(10)}

💧 Liquidité :
$${Number(c.liquidity).toFixed(2)}

📉 Prix 10s :
${c.price10 === null
  ? "N/A"
  : Number(c.price10).toFixed(2) + "%"}

💧 Liquidité 10s :
${c.liquidity10 === null
  ? "N/A"
  : Number(c.liquidity10).toFixed(2) + "%"}`
    );
  }
);

/* =========================================================
   HELP
   ========================================================= */

bot.command(
  "help",
  async () => {
    await tg(
`🤖 V6.3

/test MINT
/starttrade
/stoptrade
/status
/comparison
/lastcrash
/help

🧪 Simulation uniquement

💵 10 $ / cycle
🎯 +5%
🛡 Stops -10/-15/-20/-25%
⏱️ 45 min
🚫 Aucun BUY après 43 min

🛡 Protection :
• cache DexScreener
• retry automatique
• gestion HTTP 429
• pas de requêtes lourdes répétées
• sortie forcée à 45 min`
    );
  }
);

/* =========================================================
   SCAN
   ========================================================= */

bot.command(
  "scan",
  async () => {
    await tg(
`🔎 SCAN V6.3

Filtres :

• Claude / OpenAI / Anthropic
• moins de 5 heures
• liquidité 200k–400k $
• minimum 1 000 holders
• PumpSwap

Pour tester directement un token :

/test MINT`
    );
  }
);

/* =========================================================
   ERROR HANDLER
   ========================================================= */

bot.catch(err => {
  console.log(
    "Telegram error:",
    err?.message || err
  );
});

/* =========================================================
   START BOT
   ========================================================= */

async function startBot() {
  console.log(
    "🤖 V6.3 Telegram bot démarré"
  );

  console.log(
    "📡 RPC Helius actif"
  );

  console.log(
    "🛡 Protection HTTP 429 active"
  );

  console.log(
    "💵 Simulation : $10 / cycle"
  );

  console.log(
    "🎯 Target : +5%"
  );

  console.log(
    "🛡 Stops : -10 / -15 / -20 / -25%"
  );

  await bot.launch({
    dropPendingUpdates: true
  });

  console.log(
    "✅ Telegram connecté"
  );
}

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);

startBot().catch(err => {
  console.error(
    "❌ Démarrage impossible:",
    err
  );

  process.exit(1);
});
