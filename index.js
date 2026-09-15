require("dotenv").config();

const { Telegraf } = require("telegraf");
const {
  Connection,
  PublicKey,
} = require("@solana/web3.js");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ============================================================
// V6.3
// RADAR + V5.9 COMPARAISON + DIAGNOSTIC BUY
// SIMULATION UNIQUEMENT
// ============================================================

// ------------------------------------------------------------
// ENV
// ------------------------------------------------------------

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN manquant");
if (!CHAT_ID) throw new Error("CHAT_ID manquant");
if (!HELIUS_API_KEY) throw new Error("HELIUS_API_KEY manquant");

// ------------------------------------------------------------
// SOLANA
// ------------------------------------------------------------

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, "confirmed");

// ------------------------------------------------------------
// PROGRAMMES
// ------------------------------------------------------------

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const PUMP_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const WSOL =
  "So11111111111111111111111111111111111111112";

const TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// ------------------------------------------------------------
// TOKEN DE TEST
// ------------------------------------------------------------

const TRUSTED_TEST_MINT =
  "6mXbyvPJbPQRyMU5BFL99TFLEDdvuV434cQBSjjitxX7";

// ------------------------------------------------------------
// FILTRES V6
// ------------------------------------------------------------

const ALLOWED_NAMES = [
  "claude",
  "openai",
  "anthropic",
];

const MIN_LIQUIDITY = 200000;
const MAX_LIQUIDITY = 400000;
const MIN_HOLDERS = 1000;
const MAX_AGE_MINUTES = 5 * 60;

// ------------------------------------------------------------
// V5.9 STRATEGIE
// ------------------------------------------------------------

const CAPITAL_PER_CYCLE = 10;

const TARGET_PERCENT = 5;

const STOP_LEVELS = [
  -10,
  -15,
  -20,
  -25,
];

const COOLDOWN_SECONDS = 30;

const MAX_SESSION_MINUTES = 45;

const NO_NEW_BUY_MINUTES = 43;

// ------------------------------------------------------------
// MARCHÉ
// ------------------------------------------------------------

const MARKET_POLL_MS = 2000;

const PAIR_REFRESH_MS = 30000;

const HISTORY_SECONDS = 120;

const HISTORY_WARMUP_POINTS = 8;

const PRICE_DROP_10S_MAX = -5;

const LIQ_DROP_10S_MAX = -12;

const LIQ_DROP_30S_MAX = -20;

const CRASH_LIQUIDITY_USD = 1;

const CRASH_LIQ_DROP_10S = -50;

const CRASH_PRICE_DROP_10S = -20;

// ------------------------------------------------------------
// DIAGNOSTIC
// ------------------------------------------------------------

const DIAGNOSTIC_EVERY_SECONDS = 10;

// ------------------------------------------------------------
// DATA
// ------------------------------------------------------------

const DATA_DIR =
  fs.existsSync("/data")
    ? "/data"
    : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const FILE_MARKET =
  path.join(DATA_DIR, "v6_3_market_history.jsonl");

const FILE_TRADES =
  path.join(DATA_DIR, "v6_3_trades.json");

const FILE_COMPARISON =
  path.join(DATA_DIR, "v6_3_comparison.json");

const FILE_CRASHES =
  path.join(DATA_DIR, "v6_3_crash_reports.json");

// ------------------------------------------------------------
// TELEGRAM
// ------------------------------------------------------------

const bot = new Telegraf(BOT_TOKEN);

// ------------------------------------------------------------
// ETAT GLOBAL
// ------------------------------------------------------------

let currentCandidate = null;

let tradeRunning = false;

let sessionStartedAt = null;

let sessionEndedAt = null;

let lastMarket = null;

let lastPairRefresh = 0;

let selectedPair = null;

let pairInfo = null;

let marketHistory = [];

let tradeHistory = [];

let crashReports = [];

let lastDiagnosticAt = 0;

let lastDiagnosticKey = "";

let marketTimer = null;

let sessionTimer = null;

let heliusWs = null;

let heliusReconnectTimer = null;

let stopRequested = false;

let crashDetected = false;

// ------------------------------------------------------------
// STRATEGIES
// ------------------------------------------------------------

let strategies = [];

// ------------------------------------------------------------
// UTILS
// ------------------------------------------------------------

function nowMs() {
  return Date.now();
}

function minutesSince(timestamp) {
  if (!timestamp) return 0;
  return (Date.now() - timestamp) / 60000;
}

function secondsSince(timestamp) {
  if (!timestamp) return 0;
  return (Date.now() - timestamp) / 1000;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function money(value) {
  return Number(value || 0).toFixed(2);
}

function price(value) {
  return Number(value || 0).toFixed(10);
}

function percent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function shortMint(mint) {
  if (!mint) return "-";
  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

function shortAddress(address) {
  if (!address) return "-";
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function appendJsonLine(file, object) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(object) + "\n"
    );
  } catch (err) {
    console.error("Erreur écriture JSONL:", err.message);
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) return fallback;

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(file, object) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(object, null, 2)
    );
  } catch (err) {
    console.error("Erreur écriture JSON:", err.message);
  }
}

// ------------------------------------------------------------
// TELEGRAM SEND
// ------------------------------------------------------------

async function sendTelegram(text) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (err) {
    console.error(
      "Erreur Telegram:",
      err.message
    );
  }
}

// ------------------------------------------------------------
// NOM AUTORISÉ
// ------------------------------------------------------------

function isAllowedName(name) {
  if (!name) return false;

  const normalized =
    String(name)
      .trim()
      .toLowerCase();

  return ALLOWED_NAMES.some(
    allowed =>
      normalized === allowed ||
      normalized.includes(allowed)
  );
}

// ------------------------------------------------------------
// DEXSCREENER
// ------------------------------------------------------------

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "V6.3-Radar/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  return response.json();
}

function isPumpSwapPair(pair) {
  if (!pair) return false;

  const dexId =
    String(pair.dexId || "")
      .toLowerCase();

  return (
    dexId === "pumpswap" ||
    dexId === "pump_amm" ||
    dexId === "pumpamm" ||
    dexId.includes("pump")
  );
}

function pairContainsMint(pair, mint) {
  if (!pair || !mint) return false;

  const base =
    pair.baseToken?.address;

  const quote =
    pair.quoteToken?.address;

  return (
    base === mint ||
    quote === mint
  );
}

function pairHasMintAsBase(pair, mint) {
  return (
    pair &&
    pair.baseToken &&
    pair.baseToken.address === mint
  );
}

async function getDexPairs(mint) {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  const data =
    await fetchJson(url);

  return Array.isArray(data.pairs)
    ? data.pairs
    : [];
}

function chooseBestPumpSwapPair(
  pairs,
  mint
) {
  const candidates =
    pairs.filter(pair => {
      if (!isPumpSwapPair(pair)) {
        return false;
      }

      if (!pairContainsMint(pair, mint)) {
        return false;
      }

      const liquidity =
        safeNumber(
          pair.liquidity?.usd
        );

      return liquidity > 0;
    });

  if (!candidates.length) {
    return null;
  }

  // Pour notre simulation, on privilégie
  // une paire où le token est BASE.
  const baseCandidates =
    candidates.filter(pair =>
      pairHasMintAsBase(pair, mint)
    );

  const usable =
    baseCandidates.length
      ? baseCandidates
      : candidates;

  usable.sort(
    (a, b) =>
      safeNumber(b.liquidity?.usd) -
      safeNumber(a.liquidity?.usd)
  );

  return usable[0];
}

// ------------------------------------------------------------
// AGE
// ------------------------------------------------------------

function getPairAgeMinutes(pair) {
  if (!pair) return Infinity;

  if (pair.pairCreatedAt) {
    const created =
      safeNumber(pair.pairCreatedAt);

    if (created > 0) {
      const timestamp =
        created < 100000000000
          ? created * 1000
          : created;

      return Math.max(
        0,
        (Date.now() - timestamp) /
          60000
      );
    }
  }

  return Infinity;
}

// ------------------------------------------------------------
// HOLDERS
// ------------------------------------------------------------

async function getHolderCount(mint) {
  try {
    const pubkey =
      new PublicKey(mint);

    const accounts =
      await connection.getParsedProgramAccounts(
        new PublicKey(TOKEN_PROGRAM),
        {
          filters: [
            {
              dataSize: 165,
            },
            {
              memcmp: {
                offset: 0,
                bytes: pubkey.toBase58(),
              },
            },
          ],
        }
      );

    const owners = new Set();

    for (const item of accounts) {
      try {
        const info =
          item.account.data.parsed.info;

        const tokenAmount =
          safeNumber(
            info.tokenAmount?.uiAmount
          );

        if (tokenAmount <= 0) {
          continue;
        }

        if (info.owner) {
          owners.add(info.owner);
        }

        if (owners.size >= MIN_HOLDERS) {
          return MIN_HOLDERS;
        }
      } catch {}
    }

    return owners.size;
  } catch (err) {
    console.error(
      "Erreur holders:",
      err.message
    );

    return 0;
  }
}

// ------------------------------------------------------------
// PUMPSWAP POOL PARSER
// ------------------------------------------------------------

function readPubkey(
  data,
  offset
) {
  if (
    !data ||
    data.length < offset + 32
  ) {
    return null;
  }

  return new PublicKey(
    data.subarray(
      offset,
      offset + 32
    )
  ).toBase58();
}

function readU64LE(
  data,
  offset
) {
  if (
    !data ||
    data.length < offset + 8
  ) {
    return 0;
  }

  let value = 0n;

  for (let i = 0; i < 8; i++) {
    value |=
      BigInt(data[offset + i]) <<
      BigInt(8 * i);
  }

  return Number(value);
}

function readI128LE(
  data,
  offset
) {
  if (
    !data ||
    data.length < offset + 16
  ) {
    return 0;
  }

  let value = 0n;

  for (let i = 0; i < 16; i++) {
    value |=
      BigInt(data[offset + i]) <<
      BigInt(8 * i);
  }

  const sign =
    1n << 127n;

  if (value & sign) {
    value -= 1n << 128n;
  }

  return Number(value);
}

function parsePumpSwapPool(
  accountInfo
) {
  if (!accountInfo?.data) {
    return null;
  }

  const data =
    Buffer.from(accountInfo.data);

  if (data.length < 203) {
    return null;
  }

  const bump = data[8];

  const index =
    Number(
      data.readUInt16LE(9)
    );

  const creator =
    readPubkey(data, 11);

  const baseMint =
    readPubkey(data, 43);

  const quoteMint =
    readPubkey(data, 75);

  const lpMint =
    readPubkey(data, 107);

  const baseVault =
    readPubkey(data, 139);

  const quoteVault =
    readPubkey(data, 171);

  const lpSupply =
    readU64LE(data, 203);

  const coinCreator =
    readPubkey(data, 211);

  const isMayhemMode =
    data.length > 243
      ? Boolean(data[243])
      : false;

  const isCashbackCoin =
    data.length > 244
      ? Boolean(data[244])
      : false;

  const virtualQuoteReserves =
    data.length >= 261
      ? readI128LE(data, 245)
      : 0;

  return {
    bump,
    index,
    creator,
    baseMint,
    quoteMint,
    lpMint,
    baseVault,
    quoteVault,
    lpSupply,
    coinCreator,
    isMayhemMode,
    isCashbackCoin,
    virtualQuoteReserves,
    dataLength: data.length,
  };
}

// ------------------------------------------------------------
// VALIDATION POOL DIRECT
// ------------------------------------------------------------

async function validatePumpSwapPool(
  pairAddress,
  mint
) {
  try {
    const pubkey =
      new PublicKey(pairAddress);

    const info =
      await connection.getAccountInfo(
        pubkey,
        "confirmed"
      );

    if (!info) {
      return {
        ok: false,
        reason: "POOL_ACCOUNT_NOT_FOUND",
      };
    }

    const owner =
      info.owner.toBase58();

    if (owner !== PUMPSWAP_PROGRAM) {
      return {
        ok: false,
        reason: "OWNER_NOT_PUMPSWAP",
        owner,
      };
    }

    const pool =
      parsePumpSwapPool(info);

    if (!pool) {
      return {
        ok: false,
        reason: "POOL_PARSE_FAILED",
      };
    }

    if (pool.baseMint !== mint) {
      return {
        ok: false,
        reason: "BASE_MINT_MISMATCH",
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        pool,
      };
    }

    if (pool.quoteMint !== WSOL) {
      return {
        ok: false,
        reason: "QUOTE_NOT_WSOL",
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        pool,
      };
    }

    return {
      ok: true,
      pool,
    };
  } catch (err) {
    return {
      ok: false,
      reason: "POOL_VALIDATION_ERROR",
      error: err.message,
    };
  }
}

// ------------------------------------------------------------
// RECHERCHE POOL DIRECTE
// ------------------------------------------------------------

async function findDirectPumpSwapPool(
  mint
) {
  try {
    const accounts =
      await connection.getProgramAccounts(
        new PublicKey(PUMPSWAP_PROGRAM),
        {
          commitment: "confirmed",
          filters: [
            {
              memcmp: {
                offset: 43,
                bytes: mint,
              },
            },
            {
              memcmp: {
                offset: 75,
                bytes: WSOL,
              },
            },
          ],
        }
      );

    if (!accounts.length) {
      return null;
    }

    const pools = [];

    for (const account of accounts) {
      const parsed =
        parsePumpSwapPool(
          account.account
        );

      if (!parsed) continue;

      if (
        parsed.baseMint !== mint ||
        parsed.quoteMint !== WSOL
      ) {
        continue;
      }

      pools.push({
        address:
          account.pubkey.toBase58(),
        pool: parsed,
      });
    }

    if (!pools.length) {
      return null;
    }

    return pools[0];
  } catch (err) {
    console.error(
      "Recherche pool directe:",
      err.message
    );

    return null;
  }
}

// ------------------------------------------------------------
// VAULT SPL
// ------------------------------------------------------------

async function getTokenAccountAmount(
  address
) {
  try {
    const info =
      await connection.getAccountInfo(
        new PublicKey(address),
        "processed"
      );

    if (!info?.data) {
      return 0;
    }

    const data =
      Buffer.from(info.data);

    // SPL Token Account:
    // mint      0..31
    // owner    32..63
    // amount   64..71
    if (data.length < 72) {
      return 0;
    }

    return readU64LE(
      data,
      64
    );
  } catch {
    return 0;
  }
}

// ------------------------------------------------------------
// MARKET DATA
// ------------------------------------------------------------

async function getMarketData(
  mint
) {
  const now =
    Date.now();

  let pair = null;

  if (
    !selectedPair ||
    !pairInfo ||
    now - lastPairRefresh >
      PAIR_REFRESH_MS
  ) {
    try {
      const pairs =
        await getDexPairs(mint);

      pair =
        chooseBestPumpSwapPair(
          pairs,
          mint
        );

      if (!pair) {
        return null;
      }

      selectedPair =
        pair.pairAddress;

      pairInfo =
        pair;

      lastPairRefresh =
        now;
    } catch (err) {
      console.error(
        "DexScreener:",
        err.message
      );

      return null;
    }
  } else {
    pair = pairInfo;
  }

  const priceUsd =
    safeNumber(
      pair.priceUsd
    );

  const liquidityUsd =
    safeNumber(
      pair.liquidity?.usd
    );

  if (
    priceUsd <= 0 ||
    liquidityUsd <= 0
  ) {
    return null;
  }

  return {
    timestamp: now,
    price: priceUsd,
    liquidity: liquidityUsd,
    dexId: pair.dexId || "unknown",
    pairAddress:
      pair.pairAddress ||
      selectedPair,
    volume24h:
      safeNumber(
        pair.volume?.h24
      ),
    buys5m:
      safeNumber(
        pair.txns?.m5?.buys
      ),
    sells5m:
      safeNumber(
        pair.txns?.m5?.sells
      ),
    baseToken:
      pair.baseToken?.address,
    quoteToken:
      pair.quoteToken?.address,
  };
}

// ------------------------------------------------------------
// HISTORIQUE
// ------------------------------------------------------------

function addMarketPoint(market) {
  marketHistory.push(market);

  const cutoff =
    Date.now() -
    HISTORY_SECONDS * 1000;

  marketHistory =
    marketHistory.filter(
      item =>
        item.timestamp >= cutoff
    );

  appendJsonLine(
    FILE_MARKET,
    market
  );
}

function getPointSecondsAgo(
  seconds
) {
  const target =
    Date.now() -
    seconds * 1000;

  let best = null;

  for (const point of marketHistory) {
    if (point.timestamp <= target) {
      best = point;
    }
  }

  return best;
}

function getChangePercent(
  current,
  previous
) {
  if (
    !previous ||
    previous === 0
  ) {
    return 0;
  }

  return (
    (current - previous) /
    previous *
    100
  );
}

function getPriceDrop10s() {
  const old =
    getPointSecondsAgo(10);

  if (!old || !lastMarket) {
    return null;
  }

  return getChangePercent(
    lastMarket.price,
    old.price
  );
}

function getLiquidityDrop10s() {
  const old =
    getPointSecondsAgo(10);

  if (!old || !lastMarket) {
    return null;
  }

  return getChangePercent(
    lastMarket.liquidity,
    old.liquidity
  );
}

function getLiquidityDrop30s() {
  const old =
    getPointSecondsAgo(30);

  if (!old || !lastMarket) {
    return null;
  }

  return getChangePercent(
    lastMarket.liquidity,
    old.liquidity
  );
}

// ------------------------------------------------------------
// ENTRY ANALYSIS
// ------------------------------------------------------------

function analyzeEntry() {
  if (!lastMarket) {
    return {
      ok: false,
      reason: "NO_MARKET_DATA",
    };
  }

  if (
    marketHistory.length <
    HISTORY_WARMUP_POINTS
  ) {
    return {
      ok: false,
      reason: "HISTORY_WARMUP",
      history:
        marketHistory.length,
      required:
        HISTORY_WARMUP_POINTS,
    };
  }

  if (
    lastMarket.liquidity <
    MIN_LIQUIDITY
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_TOO_LOW",
      liquidity:
        lastMarket.liquidity,
    };
  }

  if (
    lastMarket.liquidity >
    MAX_LIQUIDITY
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_TOO_HIGH",
      liquidity:
        lastMarket.liquidity,
    };
  }

  const priceDrop10 =
    getPriceDrop10s();

  const liqDrop10 =
    getLiquidityDrop10s();

  const liqDrop30 =
    getLiquidityDrop30s();

  if (
    priceDrop10 !== null &&
    priceDrop10 < PRICE_DROP_10S_MAX
  ) {
    return {
      ok: false,
      reason: "PRICE_DROP",
      priceDrop10,
      liqDrop10,
      liqDrop30,
    };
  }

  if (
    liqDrop10 !== null &&
    liqDrop10 < LIQ_DROP_10S_MAX
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_DROP_10S",
      priceDrop10,
      liqDrop10,
      liqDrop30,
    };
  }

  if (
    liqDrop30 !== null &&
    liqDrop30 < LIQ_DROP_30S_MAX
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_DROP_30S",
      priceDrop10,
      liqDrop10,
      liqDrop30,
    };
  }

  return {
    ok: true,
    reason: "READY",
    priceDrop10,
    liqDrop10,
    liqDrop30,
  };
}

// ------------------------------------------------------------
// CRASH
// ------------------------------------------------------------

function analyzeCrash() {
  if (!lastMarket) {
    return {
      crash: false,
    };
  }

  const priceDrop10 =
    getPriceDrop10s();

  const liqDrop10 =
    getLiquidityDrop10s();

  if (
    lastMarket.liquidity <=
    CRASH_LIQUIDITY_USD
  ) {
    return {
      crash: true,
      reason: "LIQUIDITY_NEAR_ZERO",
      priceDrop10,
      liqDrop10,
    };
  }

  if (
    liqDrop10 !== null &&
    liqDrop10 <=
      CRASH_LIQ_DROP_10S
  ) {
    return {
      crash: true,
      reason: "LIQUIDITY_CRASH",
      priceDrop10,
      liqDrop10,
    };
  }

  if (
    priceDrop10 !== null &&
    priceDrop10 <=
      CRASH_PRICE_DROP_10S
  ) {
    return {
      crash: true,
      reason: "PRICE_CRASH",
      priceDrop10,
      liqDrop10,
    };
  }

  return {
    crash: false,
    priceDrop10,
    liqDrop10,
  };
}

// ------------------------------------------------------------
// STRATEGIES
// ------------------------------------------------------------

function createStrategy(stopPercent) {
  return {
    id: `STOP_${Math.abs(stopPercent)}`,

    stopPercent,

    capital:
      CAPITAL_PER_CYCLE,

    targetPercent:
      TARGET_PERCENT,

    cycleNumber: 0,

    wins: 0,

    losses: 0,

    pnl: 0,

    open: false,

    entryPrice: null,

    entryTime: null,

    lastExitTime: null,

    lastReason: null,

    lastPnl: 0,

    totalInvested: 0,

    totalReturned: 0,
  };
}

function resetStrategies() {
  strategies =
    STOP_LEVELS.map(
      createStrategy
    );
}

// ------------------------------------------------------------
// BUY
// ------------------------------------------------------------

function canStrategyBuy(
  strategy
) {
  if (!tradeRunning) {
    return false;
  }

  if (crashDetected) {
    return false;
  }

  if (strategy.open) {
    return false;
  }

  const elapsed =
    minutesSince(
      sessionStartedAt
    );

  if (
    elapsed >=
    NO_NEW_BUY_MINUTES
  ) {
    return false;
  }

  if (
    strategy.lastExitTime &&
    secondsSince(
      strategy.lastExitTime
    ) < COOLDOWN_SECONDS
  ) {
    return false;
  }

  return true;
}

function simulateBuy(strategy) {
  if (!lastMarket) return;

  strategy.cycleNumber++;

  strategy.open = true;

  strategy.entryPrice =
    lastMarket.price;

  strategy.entryTime =
    Date.now();

  strategy.lastReason =
    "OPEN";

  strategy.lastPnl = 0;

  strategy.totalInvested +=
    strategy.capital;

  const targetPrice =
    strategy.entryPrice *
    (
      1 +
      strategy.targetPercent /
      100
    );

  console.log(
    `BUY ${strategy.id}`,
    price(strategy.entryPrice)
  );

  sendTelegram(
`🟢 BUY SIMULÉ #${strategy.cycleNumber}

🛡️ Stop : ${strategy.stopPercent}%
💵 Capital : $${money(strategy.capital)}
💰 Prix : ${price(strategy.entryPrice)}
💧 Liquidité : $${money(lastMarket.liquidity)}

🎯 Cible : ${price(targetPrice)}
⏱️ Session : ${minutesSince(sessionStartedAt).toFixed(1)} min`
  );
}

// ------------------------------------------------------------
// SELL
// ------------------------------------------------------------

function simulateSell(
  strategy,
  reason
) {
  if (
    !strategy.open ||
    !lastMarket
  ) {
    return;
  }

  const entry =
    strategy.entryPrice;

  const exit =
    lastMarket.price;

  const resultPercent =
    getChangePercent(
      exit,
      entry
    );

  const pnl =
    strategy.capital *
    (
      resultPercent / 100
    );

  strategy.open = false;

  strategy.lastExitTime =
    Date.now();

  strategy.lastReason =
    reason;

  strategy.lastPnl =
    pnl;

  strategy.pnl += pnl;

  strategy.totalReturned +=
    strategy.capital + pnl;

  if (
    reason === "TARGET"
  ) {
    strategy.wins++;
  } else {
    strategy.losses++;
  }

  const trade = {
    timestamp:
      new Date().toISOString(),

    strategy:
      strategy.id,

    stopPercent:
      strategy.stopPercent,

    cycle:
      strategy.cycleNumber,

    reason,

    entryPrice:
      entry,

    exitPrice:
      exit,

    resultPercent,

    pnl,

    liquidity:
      lastMarket.liquidity,

    sessionMinutes:
      minutesSince(
        sessionStartedAt
      ),
  };

  tradeHistory.push(trade);

  writeJson(
    FILE_TRADES,
    tradeHistory
  );

  const icon =
    reason === "TARGET"
      ? "🎯"
      : reason === "STOP"
        ? "🛡️"
        : reason === "CRASH"
          ? "🚨"
          : "⏱️";

  sendTelegram(
`${icon} SELL SIMULÉ #${strategy.cycleNumber}

🛡️ Stop : ${strategy.stopPercent}%
Motif : ${reason}

Entrée : ${price(entry)}
Sortie : ${price(exit)}

Résultat : ${percent(resultPercent)}
P&L : ${pnl >= 0 ? "+" : ""}$${money(pnl)}

💰 Cumul stratégie : ${strategy.pnl >= 0 ? "+" : ""}$${money(strategy.pnl)}`
  );
}

// ------------------------------------------------------------
// TARGET / STOP
// ------------------------------------------------------------

function processOpenStrategy(
  strategy
) {
  if (
    !strategy.open ||
    !lastMarket
  ) {
    return;
  }

  const resultPercent =
    getChangePercent(
      lastMarket.price,
      strategy.entryPrice
    );

  // TARGET
  if (
    resultPercent >=
    strategy.targetPercent
  ) {
    simulateSell(
      strategy,
      "TARGET"
    );

    return;
  }

  // STOP
  if (
    resultPercent <=
    strategy.stopPercent
  ) {
    simulateSell(
      strategy,
      "STOP"
    );
  }
}

// ------------------------------------------------------------
// BUY DECISION
// ------------------------------------------------------------

function processNewBuys() {
  if (!tradeRunning) {
    return;
  }

  if (crashDetected) {
    return;
  }

  const elapsed =
    minutesSince(
      sessionStartedAt
    );

  if (
    elapsed >=
    NO_NEW_BUY_MINUTES
  ) {
    return;
  }

  const analysis =
    analyzeEntry();

  if (!analysis.ok) {
    return;
  }

  for (const strategy of strategies) {
    if (
      canStrategyBuy(strategy)
    ) {
      simulateBuy(strategy);
    }
  }
}

// ------------------------------------------------------------
// DIAGNOSTIC BUY
// ------------------------------------------------------------

async function sendBuyDiagnostic(
  force = false
) {
  if (!tradeRunning) {
    return;
  }

  if (!lastMarket) {
    return;
  }

  const now =
    Date.now();

  if (
    !force &&
    now - lastDiagnosticAt <
      DIAGNOSTIC_EVERY_SECONDS * 1000
  ) {
    return;
  }

  lastDiagnosticAt =
    now;

  const analysis =
    analyzeEntry();

  const priceDrop10 =
    getPriceDrop10s();

  const liqDrop10 =
    getLiquidityDrop10s();

  const liqDrop30 =
    getLiquidityDrop30s();

  const historyCount =
    marketHistory.length;

  const elapsed =
    minutesSince(
      sessionStartedAt
    );

  const historyOk =
    historyCount >=
    HISTORY_WARMUP_POINTS;

  const liquidityOk =
    lastMarket.liquidity >=
      MIN_LIQUIDITY &&
    lastMarket.liquidity <=
      MAX_LIQUIDITY;

  const priceOk =
    priceDrop10 === null ||
    priceDrop10 >=
      PRICE_DROP_10S_MAX;

  const liq10Ok =
    liqDrop10 === null ||
    liqDrop10 >=
      LIQ_DROP_10S_MAX;

  const liq30Ok =
    liqDrop30 === null ||
    liqDrop30 >=
      LIQ_DROP_30S_MAX;

  const ready =
    historyOk &&
    liquidityOk &&
    priceOk &&
    liq10Ok &&
    liq30Ok &&
    elapsed <
      NO_NEW_BUY_MINUTES;

  const key =
    [
      historyOk,
      liquidityOk,
      priceOk,
      liq10Ok,
      liq30Ok,
      ready,
    ].join("|");

  // Évite de répéter exactement le même diagnostic
  // trop souvent.
  if (
    !force &&
    key === lastDiagnosticKey &&
    now - lastDiagnosticAt <
      20000
  ) {
    return;
  }

  lastDiagnosticKey =
    key;

  function check(value) {
    return value ? "🟢" : "🔴";
  }

  let blockedReason =
    analysis.reason;

  if (
    elapsed >=
    NO_NEW_BUY_MINUTES
  ) {
    blockedReason =
      "NO_NEW_BUY_AFTER_43_MIN";
  }

  const openCount =
    strategies.filter(
      s => s.open
    ).length;

  await sendTelegram(
`📊 V6.3 DIAGNOSTIC BUY

🪙 ${currentCandidate?.name || "Token"}
💰 Prix : ${price(lastMarket.price)} $
💧 Liquidité : $${money(lastMarket.liquidity)}
🏦 DEX : ${lastMarket.dexId}
🔗 Pair : ${shortAddress(lastMarket.pairAddress)}

⏱️ Session : ${elapsed.toFixed(1)} min
📚 Historique : ${historyCount}/${HISTORY_WARMUP_POINTS}

📉 Prix 10s :
${priceDrop10 === null ? "⏳ en attente" : percent(priceDrop10)}

💧 Liquidité 10s :
${liqDrop10 === null ? "⏳ en attente" : percent(liqDrop10)}

💧 Liquidité 30s :
${liqDrop30 === null ? "⏳ en attente" : percent(liqDrop30)}

🔎 CONDITIONS BUY

Historique       ${check(historyOk)}
Liquidité        ${check(liquidityOk)}
Prix 10s         ${check(priceOk)}
Liquidité 10s    ${check(liq10Ok)}
Liquidité 30s    ${check(liq30Ok)}
Avant 43 min     ${check(elapsed < NO_NEW_BUY_MINUTES)}

${ready
  ? "🟢 BUY AUTORISÉ"
  : `🟡 BUY REFUSÉ : ${blockedReason}`}

Positions ouvertes :
${openCount}/4`
  );
}

// ------------------------------------------------------------
// CRASH
// ------------------------------------------------------------

async function handleCrash(
  crash
) {
  if (crashDetected) {
    return;
  }

  crashDetected =
    true;

  console.log(
    "CRASH:",
    crash.reason
  );

  for (const strategy of strategies) {
    if (strategy.open) {
      simulateSell(
        strategy,
        "CRASH"
      );
    }
  }

  const report = {
    timestamp:
      new Date().toISOString(),

    token:
      currentCandidate,

    reason:
      crash.reason,

    price:
      lastMarket?.price || null,

    liquidity:
      lastMarket?.liquidity || null,

    priceDrop10:
      crash.priceDrop10,

    liquidityDrop10:
      crash.liqDrop10,

    sessionMinutes:
      minutesSince(
        sessionStartedAt
      ),

    comparison:
      getComparisonData(),
  };

  crashReports.push(report);

  writeJson(
    FILE_CRASHES,
    crashReports
  );

  await sendTelegram(
`🚨 CRASH DÉTECTÉ

🪙 ${currentCandidate?.name || "Token"}

Motif :
${crash.reason}

💰 Prix :
${lastMarket ? price(lastMarket.price) : "-"}

💧 Liquidité :
$${lastMarket ? money(lastMarket.liquidity) : "-"}

📉 Prix 10s :
${crash.priceDrop10 === null
  ? "-"
  : percent(crash.priceDrop10)}

💧 Liquidité 10s :
${crash.liqDrop10 === null
  ? "-"
  : percent(crash.liqDrop10)}

🛑 NOUVEAUX BUY ARRÊTÉS

📊 COMPARAISON FINALE
${formatComparison()}`
  );

  stopTradingInternal();
}

// ------------------------------------------------------------
// SESSION LIMIT
// ------------------------------------------------------------

async function handleSessionLimit() {
  if (!tradeRunning) {
    return;
  }

  const elapsed =
    minutesSince(
      sessionStartedAt
    );

  if (
    elapsed <
    MAX_SESSION_MINUTES
  ) {
    return;
  }

  console.log(
    "⏱️ Limite 45 minutes atteinte"
  );

  for (const strategy of strategies) {
    if (strategy.open) {
      simulateSell(
        strategy,
        "SESSION_LIMIT"
      );
    }
  }

  await sendTelegram(
`⏱️ SESSION TERMINÉE

Limite maximale :
${MAX_SESSION_MINUTES} minutes

🛡️ Toute position encore ouverte a été fermée en sécurité au dernier prix observé.

📊 COMPARAISON

${formatComparison()}`
  );

  stopTradingInternal();
}

// ------------------------------------------------------------
// COMPARISON
// ------------------------------------------------------------

function getComparisonData() {
  return strategies.map(
    strategy => ({
      stop:
        strategy.stopPercent,

      wins:
        strategy.wins,

      losses:
        strategy.losses,

      pnl:
        Number(
          strategy.pnl.toFixed(4)
        ),

      cycles:
        strategy.cycleNumber,

      open:
        strategy.open,

      totalInvested:
        Number(
          strategy.totalInvested.toFixed(4)
        ),

      totalReturned:
        Number(
          strategy.totalReturned.toFixed(4)
        ),
    })
  );
}

function formatComparison() {
  if (!strategies.length) {
    return "Aucune donnée.";
  }

  return strategies
    .map(strategy => {
      const total =
        strategy.wins +
        strategy.losses;

      return (
`🛡️ Stop ${strategy.stopPercent}%
Cycles : ${strategy.cycleNumber}
Gagnants : ${strategy.wins}
Pertes : ${strategy.losses}
P&L : ${strategy.pnl >= 0 ? "+" : ""}$${money(strategy.pnl)}
${total > 0
  ? `Win rate : ${((strategy.wins / total) * 100).toFixed(1)}%`
  : "Win rate : -"}`
      );
    })
    .join("\n\n");
}

// ------------------------------------------------------------
// MARKET TICK
// ------------------------------------------------------------

async function marketTick() {
  if (!tradeRunning) {
    return;
  }

  try {
    const market =
      await getMarketData(
        currentCandidate.mint
      );

    if (!market) {
      console.log(
        "⚠️ Données marché indisponibles"
      );

      return;
    }

    lastMarket =
      market;

    addMarketPoint(
      market
    );

    // --------------------------------------------------------
    // 1. TARGET / STOP
    // --------------------------------------------------------

    for (const strategy of strategies) {
      processOpenStrategy(
        strategy
      );
    }

    // --------------------------------------------------------
    // 2. CRASH
    // --------------------------------------------------------

    const crash =
      analyzeCrash();

    if (crash.crash) {
      await handleCrash(
        crash
      );

      return;
    }

    // --------------------------------------------------------
    // 3. BUY
    // --------------------------------------------------------

    processNewBuys();

    // --------------------------------------------------------
    // 4. DIAGNOSTIC
    // --------------------------------------------------------

    await sendBuyDiagnostic(
      false
    );

    // --------------------------------------------------------
    // 5. SESSION
    // --------------------------------------------------------

    await handleSessionLimit();
  } catch (err) {
    console.error(
      "marketTick:",
      err.message
    );
  }
}

// ------------------------------------------------------------
// SESSION TIMER
// ------------------------------------------------------------

async function sessionSafetyTimer() {
  if (!tradeRunning) {
    return;
  }

  const elapsed =
    minutesSince(
      sessionStartedAt
    );

  // Force safety exit exactement à 45 min,
  // même si DexScreener n'a momentanément
  // pas répondu.
  if (
    elapsed >=
    MAX_SESSION_MINUTES
  ) {
    if (
      lastMarket &&
      strategies.some(
        s => s.open
      )
    ) {
      for (const strategy of strategies) {
        if (strategy.open) {
          simulateSell(
            strategy,
            "SESSION_LIMIT"
          );
        }
      }

      await sendTelegram(
`⏱️ SÉCURITÉ 45 MIN

Toutes les positions ouvertes ont été fermées au dernier prix observé.

📊 COMPARAISON

${formatComparison()}`
      );
    }

    stopTradingInternal();
  }
}

// ------------------------------------------------------------
// START SESSION
// ------------------------------------------------------------

function startSession() {
  if (tradeRunning) {
    return false;
  }

  tradeRunning =
    true;

  stopRequested =
    false;

  crashDetected =
    false;

  sessionStartedAt =
    Date.now();

  sessionEndedAt =
    null;

  lastMarket =
    null;

  marketHistory =
    [];

  selectedPair =
    null;

  pairInfo =
    null;

  lastPairRefresh =
    0;

  lastDiagnosticAt =
    0;

  lastDiagnosticKey =
    "";

  resetStrategies();

  marketTimer =
    setInterval(
      marketTick,
      MARKET_POLL_MS
    );

  sessionTimer =
    setInterval(
      sessionSafetyTimer,
      1000
    );

  startHeliusLogs();

  return true;
}

// ------------------------------------------------------------
// STOP SESSION
// ------------------------------------------------------------

function stopTradingInternal() {
  if (!tradeRunning) {
    return;
  }

  tradeRunning =
    false;

  stopRequested =
    true;

  sessionEndedAt =
    Date.now();

  if (marketTimer) {
    clearInterval(
      marketTimer
    );

    marketTimer =
      null;
  }

  if (sessionTimer) {
    clearInterval(
      sessionTimer
    );

    sessionTimer =
      null;
  }

  stopHeliusLogs();

  writeJson(
    FILE_COMPARISON,
    {
      timestamp:
        new Date().toISOString(),

      token:
        currentCandidate,

      comparison:
        getComparisonData(),
    }
  );
}

// ------------------------------------------------------------
// HELIUS
// ------------------------------------------------------------

function startHeliusLogs() {
  stopHeliusLogs();

  try {
    heliusWs =
      new WebSocket(
        WSS_URL
      );

    heliusWs.on(
      "open",
      () => {
        console.log(
          "📡 Helius WebSocket connecté"
        );

        const request = {
          jsonrpc: "2.0",
          id: 1,
          method: "logsSubscribe",
          params: [
            {
              mentions: [
                PUMPSWAP_PROGRAM
              ],
            },
            {
              commitment: "processed"
            }
          ]
        };

        try {
          heliusWs.send(
            JSON.stringify(
              request
            )
          );
        } catch {}
      }
    );

    heliusWs.on(
      "message",
      data => {
        try {
          const message =
            JSON.parse(
              data.toString()
            );

          if (
            message?.params?.result
          ) {
            const value =
              message.params.result.value;

            const logs =
              value?.logs || [];

            const joined =
              logs.join(" ");

            if (
              joined
                .toLowerCase()
                .includes("pumpswap")
            ) {
              console.log(
                "⚡ PumpSwap activité détectée"
              );
            }
          }
        } catch {}
      }
    );

    heliusWs.on(
      "close",
      () => {
        console.log(
          "📡 Helius WebSocket fermé"
        );

        if (
          tradeRunning &&
          !stopRequested
        ) {
          scheduleHeliusReconnect();
        }
      }
    );

    heliusWs.on(
      "error",
      err => {
        console.error(
          "Helius WS:",
          err.message
        );
      }
    );
  } catch (err) {
    console.error(
      "Helius WS init:",
      err.message
    );
  }
}

function scheduleHeliusReconnect() {
  if (
    heliusReconnectTimer ||
    !tradeRunning
  ) {
    return;
  }

  heliusReconnectTimer =
    setTimeout(
      () => {
        heliusReconnectTimer =
          null;

        if (tradeRunning) {
          startHeliusLogs();
        }
      },
      5000
    );
}

function stopHeliusLogs() {
  if (heliusReconnectTimer) {
    clearTimeout(
      heliusReconnectTimer
    );

    heliusReconnectTimer =
      null;
  }

  if (heliusWs) {
    try {
      heliusWs.removeAllListeners();

      if (
        heliusWs.readyState ===
        WebSocket.OPEN
      ) {
        heliusWs.close();
      }
    } catch {}
  }

  heliusWs =
    null;
}

// ------------------------------------------------------------
// EVALUATION TOKEN
// ------------------------------------------------------------

async function evaluateMint(
  mint,
  options = {}
) {
  const trusted =
    mint === TRUSTED_TEST_MINT;

  await sendTelegram(
`🔎 TEST V6.3

Mint :
${mint}

Validation marché PumpSwap...`
  );

  let pairs = [];

  try {
    pairs =
      await getDexPairs(
        mint
      );
  } catch (err) {
    await sendTelegram(
`❌ DexScreener inaccessible

Erreur :
${err.message}`
    );

    return null;
  }

  const pumpPairs =
    pairs.filter(
      pair =>
        isPumpSwapPair(pair) &&
        pairContainsMint(
          pair,
          mint
        )
    );

  if (!pumpPairs.length) {
    await sendTelegram(
`🔴 TOKEN REFUSÉ

Mint :
${mint}

Motif :
NO_PUMPSWAP_MARKET`
    );

    return null;
  }

  const pair =
    chooseBestPumpSwapPair(
      pumpPairs,
      mint
    );

  if (!pair) {
    return null;
  }

  const name =
    pair.baseToken?.address === mint
      ? pair.baseToken?.name
      : pair.quoteToken?.name;

  const symbol =
    pair.baseToken?.address === mint
      ? pair.baseToken?.symbol
      : pair.quoteToken?.symbol;

  const liquidity =
    safeNumber(
      pair.liquidity?.usd
    );

  const ageMinutes =
    getPairAgeMinutes(
      pair
    );

  const holders =
    await getHolderCount(
      mint
    );

  const nameOk =
    isAllowedName(
      name
    );

  const liquidityOk =
    liquidity >= MIN_LIQUIDITY &&
    liquidity <= MAX_LIQUIDITY;

  const ageOk =
    ageMinutes <
    MAX_AGE_MINUTES;

  const holdersOk =
    holders >= MIN_HOLDERS;

  const dexOk =
    isPumpSwapPair(
      pair
    );

  // ----------------------------------------------------------
  // Vérification on-chain
  // ----------------------------------------------------------

  let directPool =
    await findDirectPumpSwapPool(
      mint
    );

  let onchain =
    null;

  if (directPool) {
    onchain = {
      ok: true,
      source: "DIRECT_POOL",
      pairAddress:
        directPool.address,
      pool:
        directPool.pool,
    };
  } else {
    onchain = {
      ok: false,
      reason:
        "NO_VALID_DIRECT_PUMPSWAP_POOL",
    };
  }

  // Le mode test autorise notre token
  // exact même si le compte pool direct
  // n'est pas retrouvé.
  const onchainOk =
    onchain.ok || trusted;

  const accepted =
    dexOk &&
    nameOk &&
    liquidityOk &&
    ageOk &&
    holdersOk &&
    onchainOk;

  if (!accepted) {
    await sendTelegram(
`❌ TOKEN REFUSÉ

Mint :
${mint}

🪙 Nom :
${name || "-"}

🔤 Symbole :
${symbol || "-"}

💧 Liquidité :
$${money(liquidity)}

👥 Holders :
${holders >= MIN_HOLDERS
  ? "≥1000"
  : holders}

⏱️ Âge :
${Number.isFinite(ageMinutes)
  ? ageMinutes.toFixed(1)
  : "inconnu"} min

🏦 PumpSwap :
${dexOk ? "🟢 OK" : "🔴 NON"}

📝 Nom :
${nameOk ? "🟢 OK" : "🔴 NON"}

💧 Liquidité :
${liquidityOk ? "🟢 OK" : "🔴 NON"}

👥 Holders :
${holdersOk ? "🟢 OK" : "🔴 NON"}

⏱️ Âge :
${ageOk ? "🟢 OK" : "🔴 NON"}

⛓️ On-chain :
${onchain.ok ? "🟢 OK" : "🔴 NON"}

Motif :
${!nameOk
  ? "NAME_FILTER"
  : !liquidityOk
    ? "LIQUIDITY_FILTER"
    : !ageOk
      ? "AGE_FILTER"
      : !holdersOk
        ? "HOLDERS_FILTER"
        : !onchain.ok
          ? onchain.reason
          : "UNKNOWN"}`
    );

    return null;
  }

  currentCandidate = {
    mint,
    name:
      name || "Unknown",
    symbol:
      symbol || "Unknown",
    liquidity,
    holders,
    ageMinutes,
    pairAddress:
      pair.pairAddress,
    dexId:
      pair.dexId,
    trustedTest:
      trusted,
    onchain,
  };

  selectedPair =
    pair.pairAddress;

  pairInfo =
    pair;

  lastPairRefresh =
    Date.now();

  await sendTelegram(
`🟢 TOKEN ACCEPTÉ V6.3

🪙 Nom : ${name || "-"}
🔤 Symbole : ${symbol || "-"}

💧 Liquidité : $${money(liquidity)}
👥 Holders : ${holders >= MIN_HOLDERS ? "≥1000" : holders}
⏱️ Âge : ${Number.isFinite(ageMinutes) ? ageMinutes.toFixed(1) : "?"} min

🏦 PumpSwap : 🟢 OK
📊 DEX : ${pair.dexId}

⛓️ Pool direct :
${onchain.ok
  ? "🟢 OK"
  : "⚠️ non trouvé"}

🧪 MODE TEST :
${trusted
  ? "🟢 AUTORISÉ"
  : "🔵 normal"}

${trusted
  ? "La vérification du compte Pool ne bloque pas ce token de test.\nLa simulation utilisera les données PumpSwap de DexScreener."
  : "Toutes les validations sont requises."}

Pair Dex :
${pair.pairAddress}

Mint :
${mint}

▶️ /starttrade`
  );

  return currentCandidate;
}

// ------------------------------------------------------------
// SCAN PUMP.FUN
// ------------------------------------------------------------

async function scanPumpFun() {
  try {
    const url =
      "https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false";

    const data =
      await fetchJson(url);

    if (!Array.isArray(data)) {
      return [];
    }

    return data;
  } catch (err) {
    console.error(
      "Pump.fun scan:",
      err.message
    );

    return [];
  }
}

// ------------------------------------------------------------
// SCAN AUTOMATIQUE
// ------------------------------------------------------------

async function runRadarScan() {
  await sendTelegram(
`🔎 RADAR V6.3

Recherche :

• Claude / OpenAI / Anthropic
• Liquidité 200k–400k $
• ≥ 1 000 holders
• < 5 heures
• PumpSwap`
  );

  const coins =
    await scanPumpFun();

  if (!coins.length) {
    await sendTelegram(
      "⚠️ Aucun nouveau token Pump.fun récupéré."
    );

    return;
  }

  let checked = 0;

  for (const coin of coins) {
    const mint =
      coin.mint ||
      coin.address;

    if (!mint) continue;

    const name =
      coin.name ||
      "";

    if (!isAllowedName(name)) {
      continue;
    }

    checked++;

    const result =
      await evaluateMint(
        mint,
        {
          automatic: true,
        }
      );

    if (result) {
      await sendTelegram(
`🎯 CANDIDAT TROUVÉ

${result.name}
${result.symbol}

💧 $${money(result.liquidity)}
👥 ≥${result.holders}
⏱️ ${result.ageMinutes.toFixed(1)} min
🏦 PumpSwap

Utilise :
/starttrade`
      );

      return result;
    }

    await sleep(500);
  }

  await sendTelegram(
`🔎 SCAN TERMINÉ

Tokens correspondant au nom examinés :
${checked}

Aucun candidat n'a passé tous les filtres.`
  );
}

// ------------------------------------------------------------
// COMMANDES TELEGRAM
// ------------------------------------------------------------

bot.start(async ctx => {
  await ctx.reply(
`🤖 V6.3 RADAR

Filtres :
• Claude / OpenAI / Anthropic
• moins de 5 heures
• liquidité 200k–400k $
• minimum 1 000 holders
• PumpSwap

V5.9 :
• 10 $ / cycle
• +5% target
• stops -10 / -15 / -20 / -25%
• cooldown 30 s
• 45 min maximum
• aucun nouveau BUY après 43 min

📊 V6.3 :
• diagnostic BUY détaillé
• explique chaque refus
• 4 stratégies comparées
• simulation uniquement

Commandes :
/scan
/test MINT
/starttrade
/stoptrade
/status
/comparison
/lastcrash
/help`
  );
});

// ------------------------------------------------------------
// /TEST
// ------------------------------------------------------------

bot.command(
  "test",
  async ctx => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    const mint =
      parts[1];

    if (!mint) {
      await ctx.reply(
        "Utilise : /test MINT"
      );

      return;
    }

    if (tradeRunning) {
      await ctx.reply(
        "🟡 Une simulation est déjà active. Utilise /stoptrade."
      );

      return;
    }

    await evaluateMint(
      mint
    );
  }
);

// ------------------------------------------------------------
// /SCAN
// ------------------------------------------------------------

bot.command(
  "scan",
  async ctx => {
    if (tradeRunning) {
      await ctx.reply(
        "🟡 Simulation déjà active."
      );

      return;
    }

    await runRadarScan();
  }
);

// ------------------------------------------------------------
// /STARTTRADE
// ------------------------------------------------------------

bot.command(
  "starttrade",
  async ctx => {
    if (!currentCandidate) {
      await ctx.reply(
`🔴 Aucun candidat sélectionné.

Utilise :
/scan

ou :

/test MINT`
      );

      return;
    }

    if (tradeRunning) {
      await ctx.reply(
        "🟢 La simulation est déjà active."
      );

      return;
    }

    // Réévaluation légère du marché
    try {
      const pairs =
        await getDexPairs(
          currentCandidate.mint
        );

      const pair =
        chooseBestPumpSwapPair(
          pairs,
          currentCandidate.mint
        );

      if (!pair) {
        await ctx.reply(
          "🔴 Marché PumpSwap introuvable au démarrage."
        );

        return;
      }

      selectedPair =
        pair.pairAddress;

      pairInfo =
        pair;

      lastPairRefresh =
        Date.now();
    } catch (err) {
      await ctx.reply(
`⚠️ Impossible de rafraîchir le marché.

${err.message}`
      );

      return;
    }

    startSession();

    await ctx.reply(
`🟢 V5.9 SIMULATION ACTIVE

🪙 ${currentCandidate.name}
🔤 ${currentCandidate.symbol}

💵 10 $ / cycle
🎯 +5%
🛡️ -10 / -15 / -20 / -25%

⏱️ 45 min
🚫 Aucun BUY après 43 min
⏸️ Cooldown : 30 s

📊 Diagnostic BUY toutes les ~10 s
🧪 SIMULATION UNIQUEMENT

🏦 PumpSwap
Pair :
${currentCandidate.pairAddress}`
    );

    // Premier diagnostic forcé dès que
    // les premières données sont disponibles.
  }
);

// ------------------------------------------------------------
// /STOPTRADE
// ------------------------------------------------------------

bot.command(
  "stoptrade",
  async ctx => {
    if (!tradeRunning) {
      await ctx.reply(
        "🟡 Aucune simulation active."
      );

      return;
    }

    if (lastMarket) {
      for (const strategy of strategies) {
        if (strategy.open) {
          simulateSell(
            strategy,
            "MANUAL_STOP"
          );
        }
      }
    }

    stopTradingInternal();

    await ctx.reply(
`🛑 SIMULATION ARRÊTÉE

${formatComparison()}`
    );
  }
);

// ------------------------------------------------------------
// /STATUS
// ------------------------------------------------------------

bot.command(
  "status",
  async ctx => {
    if (!tradeRunning) {
      await ctx.reply(
`🟡 Simulation inactive

Candidat :
${currentCandidate
  ? `${currentCandidate.name} (${shortMint(currentCandidate.mint)})`
  : "aucun"}

/scan
/test MINT
/starttrade`
      );

      return;
    }

    const elapsed =
      minutesSince(
        sessionStartedAt
      );

    const open =
      strategies.filter(
        s => s.open
      );

    await ctx.reply(
`🟢 SIMULATION ACTIVE

🪙 ${currentCandidate.name}
💰 Prix :
${lastMarket ? price(lastMarket.price) : "⏳"}

💧 Liquidité :
$${lastMarket ? money(lastMarket.liquidity) : "⏳"}

⏱️ Session :
${elapsed.toFixed(1)} / ${MAX_SESSION_MINUTES} min

📚 Historique :
${marketHistory.length}

📂 Positions ouvertes :
${open.length}/4

${formatComparison()}`
    );
  }
);

// ------------------------------------------------------------
// /COMPARISON
// ------------------------------------------------------------

bot.command(
  "comparison",
  async ctx => {
    await ctx.reply(
`📊 COMPARAISON V5.9

${formatComparison()}`
    );
  }
);

// ------------------------------------------------------------
// /LASTCRASH
// ------------------------------------------------------------

bot.command(
  "lastcrash",
  async ctx => {
    if (!crashReports.length) {
      await ctx.reply(
        "🟢 Aucun crash enregistré."
      );

      return;
    }

    const crash =
      crashReports[
        crashReports.length - 1
      ];

    await ctx.reply(
`🚨 DERNIER CRASH

Motif :
${crash.reason}

Prix :
${crash.price
  ? price(crash.price)
  : "-"}

Liquidité :
$${crash.liquidity
  ? money(crash.liquidity)
  : "-"}

Prix 10s :
${crash.priceDrop10 === null
  ? "-"
  : percent(crash.priceDrop10)}

Liquidité 10s :
${crash.liquidityDrop10 === null
  ? "-"
  : percent(crash.liquidityDrop10)}

Session :
${Number(
  crash.sessionMinutes || 0
).toFixed(1)} min`
    );
  }
);

// ------------------------------------------------------------
// /HELP
// ------------------------------------------------------------

bot.help(async ctx => {
  await ctx.reply(
`🤖 V6.3

/scan
Recherche automatiquement un candidat.

/test MINT
Teste un token précis.

/starttrade
Lance la simulation.

/stoptrade
Arrête la simulation.

/status
État actuel.

/comparison
Compare les 4 stops.

/lastcrash
Dernier crash enregistré.

/help
Cette aide.

⚠️ Aucun ordre réel n'est envoyé.
Tout est en simulation.`
  );
});

// ------------------------------------------------------------
// ERREURS TELEGRAM
// ------------------------------------------------------------

bot.catch(err => {
  console.error(
    "Erreur Telegraf:",
    err
  );
});

// ------------------------------------------------------------
// CHARGEMENT HISTORIQUE
// ------------------------------------------------------------

tradeHistory =
  readJson(
    FILE_TRADES,
    []
  );

crashReports =
  readJson(
    FILE_CRASHES,
    []
  );

resetStrategies();

// ------------------------------------------------------------
// LANCEMENT
// ------------------------------------------------------------

(async () => {
  console.log(
    "🚀 V6.3 RADAR DÉMARRÉ"
  );

  console.log(
    "📡 RPC:",
    RPC_URL.replace(
      HELIUS_API_KEY,
      "***"
    )
  );

  console.log(
    "🧪 SIMULATION UNIQUEMENT"
  );

  await bot.launch({
    dropPendingUpdates: true,
  });

  console.log(
    "🤖 Telegram connecté"
  );

  await sendTelegram(
`🟢 V6.3 EN LIGNE

📊 Diagnostic BUY activé
💵 10 $ / cycle
🎯 +5%
🛡️ Stops -10/-15/-20/-25%
⏱️ 45 min
🚫 Aucun BUY après 43 min

🧪 Simulation uniquement.

Utilise :
/test MINT
ou
/scan`
  );
})();

// ------------------------------------------------------------
// ARRÊT PROPRE
// ------------------------------------------------------------

process.once(
  "SIGINT",
  () => {
    console.log(
      "🛑 SIGINT"
    );

    stopTradingInternal();

    bot.stop(
      "SIGINT"
    );
  }
);

process.once(
  "SIGTERM",
  () => {
    console.log(
      "🛑 SIGTERM"
    );

    stopTradingInternal();

    bot.stop(
      "SIGTERM"
    );
  }
);
