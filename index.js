require("dotenv").config();

const { Telegraf } = require("telegraf");
const {
  Connection,
  PublicKey,
} = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

// ============================================================
// ENV
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN manquant");
if (!CHAT_ID) throw new Error("CHAT_ID manquant");
if (!HELIUS_API_KEY) throw new Error("HELIUS_API_KEY manquant");

// ============================================================
// CONNECTION
// ============================================================

const RPC_URL =
  process.env.RPC_URL ||
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  process.env.WSS_URL ||
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, {
  commitment: "confirmed",
  wsEndpoint: WSS_URL,
});

// ============================================================
// CONSTANTS
// ============================================================

const PUMPSWAP_PROGRAM = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

const WSOL_MINT = "So11111111111111111111111111111111111111112";

const PUMPFUN_API =
  "https://frontend-api-v3.pump.fun/coins";

const DEX_TOKEN_API =
  "https://api.dexscreener.com/latest/dex/tokens";

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ============================================================
// V6 FILTERS
// ============================================================

const ALLOWED_NAMES = ["claude", "openai", "anthropic"];

const MIN_LIQUIDITY = 200000;
const MAX_LIQUIDITY = 400000;

const MIN_HOLDERS = 1000;

const MAX_AGE_MS = 5 * 60 * 60 * 1000;

// ============================================================
// V5.9 STRATEGY
// ============================================================

const CAPITAL = 10;

const TARGET_PERCENT = 5;

const STOP_LEVELS = [-10, -15, -20, -25];

const MARKET_INTERVAL_MS = 2000;

const POST_SELL_COOLDOWN_MS = 30000;

const NO_NEW_BUY_AFTER_MS = 43 * 60 * 1000;

const MAX_SESSION_MS = 45 * 60 * 1000;

const MIN_TRADE_LIQUIDITY = 3000;

const HISTORY_MS = 120000;

const CRASH_LIQUIDITY = 1;

const CRASH_LIQUIDITY_DROP_10S = -50;

const CRASH_PRICE_DROP_10S = -20;

// ============================================================
// FILES
// ============================================================

const MARKET_FILE = path.join(
  DATA_DIR,
  "v6_market_history.jsonl"
);

const TRADES_FILE = path.join(
  DATA_DIR,
  "v6_trades.json"
);

const COMPARISON_FILE = path.join(
  DATA_DIR,
  "v6_comparison.json"
);

const CRASH_FILE = path.join(
  DATA_DIR,
  "v6_crashes.json"
);

// ============================================================
// TELEGRAM
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

async function sendTelegram(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text);
  } catch (e) {
    console.log("Telegram error:", e.message);
  }
}

// ============================================================
// STATE
// ============================================================

let currentCandidate = null;

let tradeRunning = false;

let sessionStartedAt = null;

let marketTimer = null;

let pairDiscoveryTimer = null;

let heliusWs = null;

let currentPair = null;

let currentPool = null;

let marketHistory = [];

let trades = [];

let crashes = [];

let lastMarket = null;

let lastDiagnosticAt = 0;

let poolCache = new Map();

let evaluationLock = false;

// ============================================================
// STRATEGIES
// ============================================================

let strategies = [];

function resetStrategies() {
  strategies = STOP_LEVELS.map((stopPercent, index) => ({
    id: index + 1,
    name: `STOP ${stopPercent}%`,
    capital: CAPITAL,
    targetPercent: TARGET_PERCENT,
    stopPercent,

    open: false,

    entryPrice: null,
    entryLiquidity: null,
    entryAt: null,

    targetPrice: null,
    stopPrice: null,

    lastSellAt: 0,

    wins: 0,
    losses: 0,
    sessionLimit: 0,
    crashes: 0,

    totalPnl: 0,
    totalInvested: 0,
    totalReturned: 0,

    trades: [],
  }));
}

resetStrategies();

// ============================================================
// UTILS
// ============================================================

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function shortMint(mint) {
  if (!mint) return "N/A";
  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

function shortAddress(address) {
  if (!address) return "N/A";
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function appendJsonLine(file, data) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(data) + "\n"
    );
  } catch (e) {
    console.log("write error:", e.message);
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2)
    );
  } catch (e) {
    console.log("save error:", e.message);
  }
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexPairs(mint) {
  const url = `${DEX_TOKEN_API}/${mint}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const json = await response.json();

  return Array.isArray(json.pairs)
    ? json.pairs
    : [];
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
  const candidates = pairs.filter(pair => {
    if (!isPumpSwapPair(pair)) return false;

    const base =
      pair?.baseToken?.address || "";

    const quote =
      pair?.quoteToken?.address || "";

    return (
      base === mint ||
      quote === mint
    );
  });

  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => {
    const la =
      safeNumber(a?.liquidity?.usd) || 0;

    const lb =
      safeNumber(b?.liquidity?.usd) || 0;

    return lb - la;
  });

  return candidates[0];
}

async function getBestPumpSwapPair(mint) {
  const pairs = await getDexPairs(mint);

  return chooseBestPumpSwapPair(
    pairs,
    mint
  );
}

// ============================================================
// SOLANA ACCOUNT HELPERS
// ============================================================

function readPubkey(data, offset) {
  if (!data || data.length < offset + 32) {
    return null;
  }

  return new PublicKey(
    data.subarray(offset, offset + 32)
  ).toBase58();
}

function readU64LE(data, offset) {
  if (!data || data.length < offset + 8) {
    return null;
  }

  return Number(
    data.readBigUInt64LE(offset)
  );
}

function readI128LE(data, offset) {
  if (!data || data.length < offset + 16) {
    return 0;
  }

  try {
    return Number(
      data.readBigInt64LE(offset)
    );
  } catch {
    try {
      const low =
        data.readBigUInt64LE(offset);

      const high =
        data.readBigInt64LE(offset + 8);

      return Number(
        high * 18446744073709551616n + BigInt(low)
      );
    } catch {
      return 0;
    }
  }
}

// ============================================================
// PUMPSWAP POOL PARSER
// ============================================================

function parsePumpSwapPool(accountInfo) {
  if (!accountInfo?.data) {
    return null;
  }

  let data;

  if (Buffer.isBuffer(accountInfo.data)) {
    data = accountInfo.data;
  } else if (Array.isArray(accountInfo.data)) {
    try {
      data = Buffer.from(
        accountInfo.data[0],
        "base64"
      );
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (data.length < 203) {
    return null;
  }

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

  let virtualQuoteReserves = 0;

  if (data.length >= 261) {
    virtualQuoteReserves =
      readI128LE(data, 245);
  }

  return {
    baseMint,
    quoteMint,
    lpMint,
    baseVault,
    quoteVault,
    lpSupply,
    virtualQuoteReserves,
    dataLength: data.length,
  };
}

// ============================================================
// DIRECT PUMPSWAP DISCOVERY
// ============================================================

async function findDirectPumpSwapPools(mint) {
  const cacheKey = mint;

  const cached =
    poolCache.get(cacheKey);

  if (
    cached &&
    now() - cached.timestamp < 5 * 60 * 1000
  ) {
    return cached.pools;
  }

  const accounts =
    await connection.getProgramAccounts(
      PUMPSWAP_PROGRAM,
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
              bytes: WSOL_MINT,
            },
          },
        ],

        encoding: "base64",
      }
    );

  const pools = [];

  for (const item of accounts) {
    try {
      const parsed =
        parsePumpSwapPool(
          item.account
        );

      if (!parsed) continue;

      if (
        parsed.baseMint !== mint
      ) {
        continue;
      }

      if (
        parsed.quoteMint !== WSOL_MINT
      ) {
        continue;
      }

      if (!parsed.baseVault) {
        continue;
      }

      if (!parsed.quoteVault) {
        continue;
      }

      pools.push({
        poolAddress:
          item.pubkey.toBase58(),

        ...parsed,
      });
    } catch (e) {
      console.log(
        "Pool parse error:",
        e.message
      );
    }
  }

  poolCache.set(cacheKey, {
    timestamp: now(),
    pools,
  });

  return pools;
}

async function getTokenAccountAmount(address) {
  try {
    const info =
      await connection.getAccountInfo(
        new PublicKey(address),
        "confirmed"
      );

    if (!info?.data) {
      return 0;
    }

    if (info.data.length < 72) {
      return 0;
    }

    return Number(
      info.data.readBigUInt64LE(64)
    );
  } catch {
    return 0;
  }
}

async function selectBestDirectPool(
  mint,
  dexPair = null
) {
  const pools =
    await findDirectPumpSwapPools(
      mint
    );

  if (!pools.length) {
    return null;
  }

  const scored = [];

  for (const pool of pools) {
    const quoteAmount =
      await getTokenAccountAmount(
        pool.quoteVault
      );

    const baseAmount =
      await getTokenAccountAmount(
        pool.baseVault
      );

    scored.push({
      ...pool,
      quoteAmount,
      baseAmount,

      effectiveQuoteAmount:
        quoteAmount +
        (pool.virtualQuoteReserves || 0),
    });
  }

  scored.sort(
    (a, b) =>
      b.effectiveQuoteAmount -
      a.effectiveQuoteAmount
  );

  return scored[0];
}

// ============================================================
// VERIFY DEX POOL DIRECTLY
// ============================================================

async function verifyDexPairOnChain(
  pair,
  mint
) {
  if (!pair?.pairAddress) {
    return {
      ok: false,
      reason: "PAIR_ADDRESS_MISSING",
    };
  }

  try {
    const pairPubkey =
      new PublicKey(
        pair.pairAddress
      );

    const account =
      await connection.getAccountInfo(
        pairPubkey,
        "confirmed"
      );

    if (!account) {
      return {
        ok: false,
        reason: "POOL_ACCOUNT_NOT_FOUND",
      };
    }

    if (
      !account.owner.equals(
        PUMPSWAP_PROGRAM
      )
    ) {
      return {
        ok: false,
        reason: "OWNER_NOT_PUMPSWAP",
      };
    }

    const parsed =
      parsePumpSwapPool(account);

    if (!parsed) {
      return {
        ok: false,
        reason: "POOL_PARSE_FAILED",
      };
    }

    if (
      parsed.baseMint !== mint
    ) {
      return {
        ok: false,
        reason: "BASE_MINT_MISMATCH",
        parsed,
      };
    }

    if (
      parsed.quoteMint !== WSOL_MINT
    ) {
      return {
        ok: false,
        reason: "QUOTE_NOT_WSOL",
        parsed,
      };
    }

    return {
      ok: true,
      pool: {
        poolAddress:
          pair.pairAddress,
        ...parsed,
      },
    };
  } catch (e) {
    return {
      ok: false,
      reason: e.message,
    };
  }
}

// ============================================================
// TOKEN HOLDERS
// ============================================================

async function getHolderCount(mint) {
  try {
    const accounts =
      await connection.getTokenLargestAccounts(
        new PublicKey(mint),
        "confirmed"
      );

    if (!accounts?.value) {
      return 0;
    }

    let count = 0;

    for (const item of accounts.value) {
      const amount =
        safeNumber(
          item?.uiAmount
        );

      if (
        amount !== null &&
        amount > 0
      ) {
        count++;
      }
    }

    if (count >= MIN_HOLDERS) {
      return MIN_HOLDERS;
    }

    try {
      const tokenAccounts =
        await connection.getParsedProgramAccounts(
          new PublicKey(
            "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
          ),
          {
            commitment: "confirmed",

            filters: [
              {
                dataSize: 165,
              },
              {
                memcmp: {
                  offset: 0,
                  bytes: mint,
                },
              },
            ],
          }
        );

      const owners = new Set();

      for (
        const account
        of tokenAccounts
      ) {
        try {
          const info =
            account.account.data.parsed.info;

          const amount =
            info?.tokenAmount?.uiAmount;

          if (
            Number(amount) > 0 &&
            info?.owner
          ) {
            owners.add(info.owner);
          }

          if (
            owners.size >=
            MIN_HOLDERS
          ) {
            return MIN_HOLDERS;
          }
        } catch {}
      }

      return owners.size;
    } catch {
      return count;
    }
  } catch (e) {
    console.log(
      "Holder count error:",
      e.message
    );

    return 0;
  }
}

// ============================================================
// TOKEN METADATA
// ============================================================

function normalizeName(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function nameMatches(
  name,
  symbol
) {
  const n =
    normalizeName(name);

  const s =
    normalizeName(symbol);

  return ALLOWED_NAMES.some(
    allowed =>
      n === allowed ||
      s === allowed
  );
}

// ============================================================
// MARKET AGE
// ============================================================

function getPairAgeMs(pair) {
  const created =
    safeNumber(
      pair?.pairCreatedAt
    );

  if (!created) {
    return null;
  }

  return now() - created;
}

// ============================================================
// EVALUATE TOKEN
// ============================================================

async function evaluateMint(
  mint,
  options = {}
) {
  if (evaluationLock && !options.force) {
    return {
      ok: false,
      reason: "EVALUATION_BUSY",
    };
  }

  evaluationLock = true;

  try {
    let dexPairs;

    try {
      dexPairs =
        await getDexPairs(mint);
    } catch (e) {
      return {
        ok: false,
        reason:
          `DEX_ERROR: ${e.message}`,
      };
    }

    const pumpPair =
      chooseBestPumpSwapPair(
        dexPairs,
        mint
      );

    if (!pumpPair) {
      return {
        ok: false,
        reason: "NO_PUMPSWAP_PAIR",
      };
    }

    const name =
      pumpPair?.baseToken?.address === mint
        ? pumpPair?.baseToken?.name
        : pumpPair?.quoteToken?.name;

    const symbol =
      pumpPair?.baseToken?.address === mint
        ? pumpPair?.baseToken?.symbol
        : pumpPair?.quoteToken?.symbol;

    if (
      !nameMatches(
        name,
        symbol
      )
    ) {
      return {
        ok: false,
        reason: "NAME_NOT_ALLOWED",
        pair: pumpPair,
        name,
        symbol,
      };
    }

    const liquidity =
      safeNumber(
        pumpPair?.liquidity?.usd
      ) || 0;

    if (
      liquidity < MIN_LIQUIDITY ||
      liquidity > MAX_LIQUIDITY
    ) {
      return {
        ok: false,
        reason: "LIQUIDITY_OUT_OF_RANGE",
        pair: pumpPair,
        name,
        symbol,
        liquidity,
      };
    }

    const ageMs =
      getPairAgeMs(
        pumpPair
      );

    if (
      ageMs === null
    ) {
      return {
        ok: false,
        reason: "AGE_UNKNOWN",
        pair: pumpPair,
        name,
        symbol,
        liquidity,
      };
    }

    if (
      ageMs > MAX_AGE_MS
    ) {
      return {
        ok: false,
        reason: "TOKEN_TOO_OLD",
        pair: pumpPair,
        name,
        symbol,
        liquidity,
        ageMs,
      };
    }

    const holders =
      await getHolderCount(
        mint
      );

    if (
      holders < MIN_HOLDERS
    ) {
      return {
        ok: false,
        reason: "NOT_ENOUGH_HOLDERS",
        pair: pumpPair,
        name,
        symbol,
        liquidity,
        ageMs,
        holders,
      };
    }

    // --------------------------------------------------------
    // IMPORTANT FIX V6.1
    // --------------------------------------------------------
    // On ne rejette plus le token parce que l'adresse
    // pair de DexScreener ne correspond pas directement
    // au base_mint du compte.
    //
    // On recherche maintenant directement les vrais pools
    // PumpSwap ayant:
    // offset 43 = mint
    // offset 75 = WSOL
    // --------------------------------------------------------

    let directPool = null;

    const dexVerification =
      await verifyDexPairOnChain(
        pumpPair,
        mint
      );

    if (
      dexVerification.ok
    ) {
      directPool =
        dexVerification.pool;
    } else {
      console.log(
        `DEX pool non concordant (${dexVerification.reason}), recherche directe PumpSwap...`
      );

      directPool =
        await selectBestDirectPool(
          mint,
          pumpPair
        );
    }

    if (!directPool) {
      return {
        ok: false,
        reason: "NO_VALID_DIRECT_PUMPSWAP_POOL",
        pair: pumpPair,
        name,
        symbol,
        liquidity,
        ageMs,
        holders,
        onchain: false,
        dexVerification:
          dexVerification.reason,
      };
    }

    return {
      ok: true,

      mint,

      name,
      symbol,

      liquidity,

      ageMs,

      holders,

      pair: pumpPair,

      pairAddress:
        pumpPair.pairAddress,

      pool:
        directPool,

      onchain: true,

      onchainSource:
        dexVerification.ok
          ? "DEX_PAIR"
          : "DIRECT_PROGRAM_SCAN",
    };
  } finally {
    evaluationLock = false;
  }
}

// ============================================================
// MARKET DATA
// ============================================================

async function getMarketData() {
  if (!currentCandidate) {
    return null;
  }

  const mint =
    currentCandidate.mint;

  const pairs =
    await getDexPairs(mint);

  const pair =
    chooseBestPumpSwapPair(
      pairs,
      mint
    );

  if (!pair) {
    return null;
  }

  const price =
    safeNumber(
      pair?.priceUsd
    );

  const liquidity =
    safeNumber(
      pair?.liquidity?.usd
    );

  if (
    price === null ||
    liquidity === null
  ) {
    return null;
  }

  currentPair = pair;

  const item = {
    timestamp: now(),
    price,
    liquidity,

    dexId:
      pair?.dexId || null,

    pairAddress:
      pair?.pairAddress || null,

    volume5m:
      safeNumber(
        pair?.volume?.m5
      ) || 0,

    buys5m:
      safeNumber(
        pair?.txns?.m5?.buys
      ) || 0,

    sells5m:
      safeNumber(
        pair?.txns?.m5?.sells
      ) || 0,
  };

  marketHistory.push(item);

  const cutoff =
    now() - HISTORY_MS;

  marketHistory =
    marketHistory.filter(
      x =>
        x.timestamp >= cutoff
    );

  appendJsonLine(
    MARKET_FILE,
    item
  );

  return item;
}

// ============================================================
// HISTORY METRICS
// ============================================================

function getOldestWithin(ms) {
  const cutoff =
    now() - ms;

  for (
    let i = 0;
    i < marketHistory.length;
    i++
  ) {
    if (
      marketHistory[i].timestamp >=
      cutoff
    ) {
      return marketHistory[i];
    }
  }

  return null;
}

function changePercent(
  oldValue,
  newValue
) {
  if (
    oldValue === null ||
    oldValue === undefined ||
    oldValue === 0
  ) {
    return null;
  }

  return (
    ((newValue - oldValue) /
      oldValue) *
    100
  );
}

function priceDrop10s(current) {
  const old =
    getOldestWithin(10000);

  if (!old) return null;

  return changePercent(
    old.price,
    current.price
  );
}

function liquidityDrop10s(current) {
  const old =
    getOldestWithin(10000);

  if (!old) return null;

  return changePercent(
    old.liquidity,
    current.liquidity
  );
}

function liquidityDrop30s(current) {
  const old =
    getOldestWithin(30000);

  if (!old) return null;

  return changePercent(
    old.liquidity,
    current.liquidity
  );
}

// ============================================================
// ENTRY FILTER
// ============================================================

function entryHealth(current) {
  if (!current) {
    return {
      ok: false,
      reason: "NO_MARKET",
    };
  }

  if (
    current.liquidity <
    MIN_TRADE_LIQUIDITY
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_TOO_LOW",
    };
  }

  if (
    marketHistory.length < 8
  ) {
    return {
      ok: false,
      reason:
        `HISTORY_WARMUP (${marketHistory.length}/8)`,
    };
  }

  const p10 =
    priceDrop10s(current);

  const l10 =
    liquidityDrop10s(current);

  const l30 =
    liquidityDrop30s(current);

  if (
    p10 !== null &&
    p10 <= -5
  ) {
    return {
      ok: false,
      reason:
        `PRICE_DROP_10S ${p10.toFixed(2)}%`,
    };
  }

  if (
    l10 !== null &&
    l10 <= -12
  ) {
    return {
      ok: false,
      reason:
        `LIQUIDITY_DROP_10S ${l10.toFixed(2)}%`,
    };
  }

  if (
    l30 !== null &&
    l30 <= -20
  ) {
    return {
      ok: false,
      reason:
        `LIQUIDITY_DROP_30S ${l30.toFixed(2)}%`,
    };
  }

  return {
    ok: true,
    reason: "HEALTHY",
  };
}

// ============================================================
// CRASH DETECTION
// ============================================================

function detectCrash(current) {
  if (!current) {
    return null;
  }

  if (
    current.liquidity <=
    CRASH_LIQUIDITY
  ) {
    return {
      type: "LIQUIDITY_NEAR_ZERO",
      price: current.price,
      liquidity:
        current.liquidity,
    };
  }

  const l10 =
    liquidityDrop10s(current);

  if (
    l10 !== null &&
    l10 <=
      CRASH_LIQUIDITY_DROP_10S
  ) {
    return {
      type: "LIQUIDITY_COLLAPSE",
      price: current.price,
      liquidity:
        current.liquidity,
      liquidityDrop10s: l10,
    };
  }

  const p10 =
    priceDrop10s(current);

  if (
    p10 !== null &&
    p10 <=
      CRASH_PRICE_DROP_10S
  ) {
    return {
      type: "PRICE_CRASH",
      price: current.price,
      liquidity:
        current.liquidity,
      priceDrop10s: p10,
    };
  }

  return null;
}

// ============================================================
// SIMULATED BUY
// ============================================================

function canBuyStrategy(strategy) {
  if (strategy.open) {
    return false;
  }

  if (
    now() - strategy.lastSellAt <
    POST_SELL_COOLDOWN_MS
  ) {
    return false;
  }

  if (
    !sessionStartedAt
  ) {
    return false;
  }

  if (
    now() - sessionStartedAt >=
    NO_NEW_BUY_AFTER_MS
  ) {
    return false;
  }

  return true;
}

function simulateBuy(
  strategy,
  market
) {
  strategy.open = true;

  strategy.entryPrice =
    market.price;

  strategy.entryLiquidity =
    market.liquidity;

  strategy.entryAt =
    now();

  strategy.targetPrice =
    strategy.entryPrice *
    (1 + TARGET_PERCENT / 100);

  strategy.stopPrice =
    strategy.entryPrice *
    (1 + strategy.stopPercent / 100);

  strategy.totalInvested +=
    CAPITAL;

  console.log(
    `BUY #${strategy.id}`,
    strategy.entryPrice
  );
}

// ============================================================
// SIMULATED SELL
// ============================================================

function simulateSell(
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

  const resultPercent =
    ((exit - entry) /
      entry) *
    100;

  const pnl =
    CAPITAL *
    (resultPercent / 100);

  strategy.totalPnl +=
    pnl;

  strategy.totalReturned +=
    CAPITAL + pnl;

  strategy.open = false;

  strategy.lastSellAt =
    now();

  if (reason === "TARGET") {
    strategy.wins++;
  } else if (
    reason === "STOP"
  ) {
    strategy.losses++;
  } else if (
    reason === "CRASH"
  ) {
    strategy.crashes++;
    strategy.losses++;
  } else if (
    reason === "SESSION_LIMIT"
  ) {
    strategy.sessionLimit++;
  }

  const trade = {
    strategy:
      strategy.name,

    strategyId:
      strategy.id,

    reason,

    entryPrice: entry,

    exitPrice: exit,

    resultPercent,

    pnl,

    entryLiquidity:
      strategy.entryLiquidity,

    exitLiquidity:
      market.liquidity,

    entryAt:
      strategy.entryAt,

    exitAt:
      now(),
  };

  strategy.trades.push(
    trade
  );

  trades.push(
    trade
  );

  saveJson(
    TRADES_FILE,
    trades
  );

  console.log(
    `SELL ${strategy.name}`,
    reason,
    resultPercent.toFixed(2),
    pnl.toFixed(2)
  );
}

// ============================================================
// FORCE CLOSE
// ============================================================

function forceCloseAll(
  market,
  reason
) {
  for (
    const strategy
    of strategies
  ) {
    if (strategy.open) {
      simulateSell(
        strategy,
        market,
        reason
      );
    }
  }
}

// ============================================================
// CRASH REPORT
// ============================================================

function createCrashReport(
  market,
  crash
) {
  const report = {
    timestamp:
      new Date().toISOString(),

    mint:
      currentCandidate?.mint ||
      null,

    name:
      currentCandidate?.name ||
      null,

    symbol:
      currentCandidate?.symbol ||
      null,

    crash,

    market,

    strategies:
      strategies.map(s => ({
        name: s.name,
        wins: s.wins,
        losses: s.losses,
        crashes: s.crashes,
        sessionLimit:
          s.sessionLimit,
        totalPnl:
          s.totalPnl,
        open:
          s.open,
      })),

    history:
      marketHistory.slice(-100),
  };

  crashes.push(
    report
  );

  saveJson(
    CRASH_FILE,
    crashes
  );

  return report;
}

// ============================================================
// SESSION LIMIT
// ============================================================

function sessionLimitReached() {
  if (!sessionStartedAt) {
    return false;
  }

  return (
    now() -
      sessionStartedAt >=
    MAX_SESSION_MS
  );
}

function noMoreBuys() {
  if (!sessionStartedAt) {
    return false;
  }

  return (
    now() -
      sessionStartedAt >=
    NO_NEW_BUY_AFTER_MS
  );
}

// ============================================================
// COMPARISON
// ============================================================

function getComparison() {
  return strategies.map(
    strategy => ({
      strategy:
        strategy.name,

      stopPercent:
        strategy.stopPercent,

      targetPercent:
        strategy.targetPercent,

      wins:
        strategy.wins,

      losses:
        strategy.losses,

      crashes:
        strategy.crashes,

      sessionLimit:
        strategy.sessionLimit,

      totalTrades:
        strategy.trades.length,

      pnl:
        Number(
          strategy.totalPnl.toFixed(4)
        ),
    })
  );
}

function saveComparison() {
  saveJson(
    COMPARISON_FILE,
    {
      timestamp:
        new Date().toISOString(),

      mint:
        currentCandidate?.mint ||
        null,

      comparison:
        getComparison(),
    }
  );
}

// ============================================================
// MARKET TICK
// ============================================================

async function marketTick() {
  if (!tradeRunning) {
    return;
  }

  try {
    const market =
      await getMarketData();

    if (!market) {
      return;
    }

    lastMarket =
      market;

    // --------------------------------------------------------
    // TARGET / STOP FIRST
    // --------------------------------------------------------

    for (
      const strategy
      of strategies
    ) {
      if (!strategy.open) {
        continue;
      }

      if (
        market.price >=
        strategy.targetPrice
      ) {
        simulateSell(
          strategy,
          market,
          "TARGET"
        );

        continue;
      }

      if (
        market.price <=
        strategy.stopPrice
      ) {
        simulateSell(
          strategy,
          market,
          "STOP"
        );
      }
    }

    // --------------------------------------------------------
    // CRASH
    // --------------------------------------------------------

    const crash =
      detectCrash(
        market
      );

    if (crash) {
      forceCloseAll(
        market,
        "CRASH"
      );

      createCrashReport(
        market,
        crash
      );

      tradeRunning = false;

      if (marketTimer) {
        clearInterval(
          marketTimer
        );

        marketTimer = null;
      }

      if (
        pairDiscoveryTimer
      ) {
        clearInterval(
          pairDiscoveryTimer
        );

        pairDiscoveryTimer = null;
      }

      saveComparison();

      await sendTelegram(
        `🚨 CRASH V6\n\n` +
        `🪙 ${currentCandidate?.name || "Token"}\n` +
        `💰 Prix : ${market.price}\n` +
        `💧 Liquidité : $${market.liquidity.toFixed(2)}\n` +
        `⚠️ ${crash.type}\n\n` +
        `🛑 Nouveaux BUY arrêtés.\n\n` +
        formatComparison()
      );

      return;
    }

    // --------------------------------------------------------
    // 45 MINUTES
    // --------------------------------------------------------

    if (
      sessionLimitReached()
    ) {
      forceCloseAll(
        market,
        "SESSION_LIMIT"
      );

      tradeRunning = false;

      saveComparison();

      if (marketTimer) {
        clearInterval(
          marketTimer
        );

        marketTimer = null;
      }

      if (
        pairDiscoveryTimer
      ) {
        clearInterval(
          pairDiscoveryTimer
        );

        pairDiscoveryTimer = null;
      }

      await sendTelegram(
        `⏱️ FIN SESSION V6\n\n` +
        `45 minutes atteintes.\n` +
        `Toute position ouverte a été fermée en sécurité.\n\n` +
        formatComparison()
      );

      return;
    }

    // --------------------------------------------------------
    // NEW BUY
    // --------------------------------------------------------

    if (
      !noMoreBuys()
    ) {
      const health =
        entryHealth(
          market
        );

      if (
        health.ok
      ) {
        for (
          const strategy
          of strategies
        ) {
          if (
            canBuyStrategy(
              strategy
            )
          ) {
            simulateBuy(
              strategy,
              market
            );
          }
        }
      }
    }

    // --------------------------------------------------------
    // DIAGNOSTIC
    // --------------------------------------------------------

    if (
      now() -
        lastDiagnosticAt >
      30000
    ) {
      lastDiagnosticAt =
        now();

      const p10 =
        priceDrop10s(
          market
        );

      const l10 =
        liquidityDrop10s(
          market
        );

      console.log(
        `📊 ${market.price} | ` +
        `$${market.liquidity.toFixed(2)} | ` +
        `P10 ${p10 === null ? "N/A" : p10.toFixed(2) + "%"} | ` +
        `L10 ${l10 === null ? "N/A" : l10.toFixed(2) + "%"}`
      );
    }
  } catch (e) {
    console.log(
      "Market tick error:",
      e.message
    );
  }
}

// ============================================================
// PAIR REFRESH
// ============================================================

async function refreshCurrentPool() {
  if (!tradeRunning) {
    return;
  }

  if (!currentCandidate) {
    return;
  }

  try {
    const pair =
      await getBestPumpSwapPair(
        currentCandidate.mint
      );

    if (!pair) {
      return;
    }

    currentPair =
      pair;

    const verified =
      await verifyDexPairOnChain(
        pair,
        currentCandidate.mint
      );

    if (
      verified.ok
    ) {
      currentPool =
        verified.pool;

      return;
    }

    const directPool =
      await selectBestDirectPool(
        currentCandidate.mint,
        pair
      );

    if (directPool) {
      currentPool =
        directPool;
    }
  } catch (e) {
    console.log(
      "Pool refresh:",
      e.message
    );
  }
}

// ============================================================
// HELIUS LOGS
// ============================================================

function startHeliusLogs() {
  try {
    if (heliusWs) {
      try {
        heliusWs.close();
      } catch {}
    }

    heliusWs =
      new WebSocket(
        WSS_URL
      );

    heliusWs.onopen = () => {
      try {
        heliusWs.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "logsSubscribe",
            params: [
              {
                mentions: [
                  PUMPSWAP_PROGRAM.toBase58(),
                ],
              },
              {
                commitment:
                  "processed",
              },
            ],
          })
        );
      } catch {}
    };

    heliusWs.onmessage = event => {
      try {
        const data =
          JSON.parse(
            event.data
          );

        if (
          data?.method ===
          "logsNotification"
        ) {
          const logs =
            data?.params?.result?.value?.logs;

          if (
            Array.isArray(logs)
          ) {
            const joined =
              logs.join(" ");

            if (
              joined.includes(
                "Instruction: Buy"
              ) ||
              joined.includes(
                "Instruction: Sell"
              )
            ) {
              console.log(
                "⚡ PumpSwap trade event"
              );
            }
          }
        }
      } catch {}
    };

    heliusWs.onerror = () => {
      console.log(
        "Helius WS error"
      );
    };

    heliusWs.onclose = () => {
      heliusWs = null;
    };
  } catch (e) {
    console.log(
      "Helius WS start error:",
      e.message
    );
  }
}

// ============================================================
// STOP
// ============================================================

function stopTrade() {
  tradeRunning = false;

  if (marketTimer) {
    clearInterval(
      marketTimer
    );

    marketTimer = null;
  }

  if (
    pairDiscoveryTimer
  ) {
    clearInterval(
      pairDiscoveryTimer
    );

    pairDiscoveryTimer = null;
  }

  if (heliusWs) {
    try {
      heliusWs.close();
    } catch {}

    heliusWs = null;
  }
}

// ============================================================
// START TRADE
// ============================================================

async function startTrade() {
  if (!currentCandidate) {
    return {
      ok: false,
      message:
        "Aucun token candidat. Utilise /scan ou /test MINT.",
    };
  }

  if (tradeRunning) {
    return {
      ok: false,
      message:
        "Une simulation est déjà active.",
    };
  }

  const validation =
    await evaluateMint(
      currentCandidate.mint,
      {
        force: true,
      }
    );

  if (!validation.ok) {
    return {
      ok: false,
      message:
        `Token refusé au démarrage.\nMotif: ${validation.reason}`,
    };
  }

  currentCandidate =
    validation;

  currentPool =
    validation.pool;

  currentPair =
    validation.pair;

  marketHistory = [];

  lastMarket = null;

  resetStrategies();

  sessionStartedAt =
    now();

  tradeRunning = true;

  startHeliusLogs();

  marketTimer =
    setInterval(
      marketTick,
      MARKET_INTERVAL_MS
    );

  pairDiscoveryTimer =
    setInterval(
      refreshCurrentPool,
      30000
    );

  return {
    ok: true,
  };
}

// ============================================================
// SCAN PUMP.FUN
// ============================================================

async function scanPumpFun() {
  try {
    const url =
      `${PUMPFUN_API}?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false`;

    const response =
      await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Pump.fun HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (!Array.isArray(data)) {
      return [];
    }

    const results = [];

    for (
      const token
      of data
    ) {
      const mint =
        token?.mint;

      if (!mint) {
        continue;
      }

      const name =
        token?.name ||
        "";

      const symbol =
        token?.symbol ||
        "";

      if (
        !nameMatches(
          name,
          symbol
        )
      ) {
        continue;
      }

      results.push({
        mint,
        name,
        symbol,
      });
    }

    return results;
  } catch (e) {
    console.log(
      "Pump.fun scan error:",
      e.message
    );

    return [];
  }
}

async function runScan() {
  const candidates =
    await scanPumpFun();

  if (!candidates.length) {
    await sendTelegram(
      "🔎 SCAN\n\nAucun Claude / OpenAI / Anthropic récent trouvé."
    );

    return;
  }

  await sendTelegram(
    `🔎 SCAN\n\n${candidates.length} candidat(s) trouvé(s).\nÉvaluation en cours...`
  );

  for (
    const candidate
    of candidates
  ) {
    const result =
      await evaluateMint(
        candidate.mint
      );

    if (
      result.ok
    ) {
      currentCandidate =
        result;

      await sendTelegram(
        `🎯 CANDIDAT VALIDÉ\n\n` +
        `🪙 ${result.name}\n` +
        `🔤 ${result.symbol}\n` +
        `💧 $${result.liquidity.toFixed(2)}\n` +
        `👥 ≥ ${result.holders}\n` +
        `⏱️ ${(result.ageMs / 60000).toFixed(1)} min\n` +
        `🏦 PumpSwap 🟢\n` +
        `⛓️ On-chain 🟢\n\n` +
        `Mint:\n${result.mint}\n\n` +
        `Pool:\n${result.pool.poolAddress}\n\n` +
        `Utilise /starttrade`
      );

      return;
    }

    await sleep(250);
  }

  await sendTelegram(
    "🔎 SCAN terminé.\n\nAucun token ne respecte tous les filtres."
  );
}

// ============================================================
// FORMAT COMPARISON
// ============================================================

function formatComparison() {
  return strategies
    .map(
      s =>
        `${s.name}: ` +
        `${s.wins}W / ` +
        `${s.losses}L / ` +
        `${s.sessionLimit}SL | ` +
        `P&L ${s.totalPnl >= 0 ? "+" : ""}${s.totalPnl.toFixed(2)} $`
    )
    .join("\n");
}

// ============================================================
// TELEGRAM COMMANDS
// ============================================================

bot.start(async ctx => {
  await ctx.reply(
    `🤖 V6 RADAR\n\n` +
    `Filtres:\n` +
    `• Claude / OpenAI / Anthropic\n` +
    `• moins de 5 heures\n` +
    `• liquidité 200k–400k $\n` +
    `• minimum 1 000 holders\n` +
    `• PumpSwap\n\n` +
    `V5.9:\n` +
    `10 $ / cycle\n` +
    `+5% target\n` +
    `stops -10/-15/-20/-25%\n` +
    `45 min maximum\n\n` +
    `Commandes:\n` +
    `/status\n` +
    `/scan\n` +
    `/test MINT\n` +
    `/starttrade\n` +
    `/stoptrade\n` +
    `/comparison\n` +
    `/lastcrash\n` +
    `/help`
  );
});

// ============================================================
// /TEST
// ============================================================

bot.command("test", async ctx => {
  const parts =
    ctx.message.text
      .trim()
      .split(/\s+/);

  const mint =
    parts[1];

  if (!mint) {
    await ctx.reply(
      "Utilise:\n/test MINT"
    );

    return;
  }

  try {
    new PublicKey(mint);
  } catch {
    await ctx.reply(
      "❌ Mint Solana invalide."
    );

    return;
  }

  await ctx.reply(
    `🔎 TEST V6.1\n\n` +
    `Mint:\n${mint}\n\n` +
    `Recherche PumpSwap directe...`
  );

  const result =
    await evaluateMint(
      mint,
      {
        force: true,
      }
    );

  if (!result.ok) {
    let text =
      `❌ TOKEN REFUSÉ\n\n` +
      `Mint:\n${mint}\n\n` +
      `Motif:\n${result.reason}`;

    if (
      result.name
    ) {
      text +=
        `\n\n🪙 Nom: ${result.name}`;
    }

    if (
      result.symbol
    ) {
      text +=
        `\n🔤 Symbole: ${result.symbol}`;
    }

    if (
      result.liquidity !==
      undefined
    ) {
      text +=
        `\n💧 Liquidité: $${Number(result.liquidity).toFixed(2)}`;
    }

    if (
      result.holders !==
      undefined
    ) {
      text +=
        `\n👥 Holders: ${result.holders}`;
    }

    if (
      result.ageMs !==
      undefined
    ) {
      text +=
        `\n⏱️ Âge: ${(result.ageMs / 60000).toFixed(1)} min`;
    }

    if (
      result.pair?.pairAddress
    ) {
      text +=
        `\n\nPair Dex:\n${result.pair.pairAddress}`;
    }

    if (
      result.dexVerification
    ) {
      text +=
        `\n\nDex on-chain:\n${result.dexVerification}`;
    }

    await ctx.reply(
      text
    );

    return;
  }

  currentCandidate =
    result;

  currentPair =
    result.pair;

  currentPool =
    result.pool;

  await ctx.reply(
    `🟢 TOKEN VALIDÉ V6.1\n\n` +
    `🪙 Nom: ${result.name}\n` +
    `🔤 Symbole: ${result.symbol}\n\n` +
    `💧 Liquidité: $${result.liquidity.toFixed(2)}\n` +
    `👥 Holders: ≥${result.holders}\n` +
    `⏱️ Âge: ${(result.ageMs / 60000).toFixed(1)} min\n\n` +
    `🏦 PumpSwap: 🟢 OK\n` +
    `⛓️ On-chain: 🟢 OK\n` +
    `🔎 Source pool: ${result.onchainSource}\n\n` +
    `Pair Dex:\n${result.pairAddress}\n\n` +
    `Pool PumpSwap:\n${result.pool.poolAddress}\n\n` +
    `Base vault:\n${result.pool.baseVault}\n\n` +
    `Quote vault:\n${result.pool.quoteVault}\n\n` +
    `Mint:\n${result.mint}\n\n` +
    `▶️ Utilise /starttrade`
  );
});

// ============================================================
// /SCAN
// ============================================================

bot.command("scan", async ctx => {
  await runScan();
});

// ============================================================
// /STARTTRADE
// ============================================================

bot.command("starttrade", async ctx => {
  const result =
    await startTrade();

  if (!result.ok) {
    await ctx.reply(
      `❌ ${result.message}`
    );

    return;
  }

  await ctx.reply(
    `🟢 V5.9 SIMULATION ACTIVE\n\n` +
    `🪙 ${currentCandidate.name}\n` +
    `🔤 ${currentCandidate.symbol}\n\n` +
    `💵 Capital: 10 $ / cycle\n` +
    `🎯 Target: +5%\n` +
    `🛡️ Stops: -10% / -15% / -20% / -25%\n` +
    `⏱️ Max session: 45 min\n` +
    `🚫 Aucun nouveau BUY après 43 min\n\n` +
    `🏦 PumpSwap: ${currentPool.poolAddress}\n\n` +
    `🧪 Simulation uniquement`
  );
});

// ============================================================
// /STOPTRADE
// ============================================================

bot.command("stoptrade", async ctx => {
  if (!tradeRunning) {
    await ctx.reply(
      "ℹ️ Aucune simulation active."
    );

    return;
  }

  if (
    lastMarket
  ) {
    forceCloseAll(
      lastMarket,
      "SESSION_LIMIT"
    );
  }

  stopTrade();

  saveComparison();

  await ctx.reply(
    `🛑 SIMULATION ARRÊTÉE\n\n` +
    formatComparison()
  );
});

// ============================================================
// /STATUS
// ============================================================

bot.command("status", async ctx => {
  let text =
    `📊 STATUS V6.1\n\n`;

  text +=
    `Radar: ${tradeRunning ? "🟢 ACTIF" : "🔴 STOP"}\n`;

  if (
    currentCandidate
  ) {
    text +=
      `🪙 ${currentCandidate.name || "N/A"}\n`;

    text +=
      `Mint:\n${currentCandidate.mint}\n\n`;
  }

  if (
    lastMarket
  ) {
    text +=
      `💰 Prix: ${lastMarket.price}\n`;

    text +=
      `💧 Liquidité: $${lastMarket.liquidity.toFixed(2)}\n`;

    text +=
      `DEX: ${lastMarket.dexId || "N/A"}\n\n`;
  }

  text +=
    formatComparison();

  await ctx.reply(
    text
  );
});

// ============================================================
// /COMPARISON
// ============================================================

bot.command("comparison", async ctx => {
  await ctx.reply(
    `📊 COMPARAISON V5.9\n\n` +
    formatComparison()
  );

  saveComparison();
});

// ============================================================
// /LASTCRASH
// ============================================================

bot.command("lastcrash", async ctx => {
  if (!crashes.length) {
    await ctx.reply(
      "Aucun crash enregistré."
    );

    return;
  }

  const crash =
    crashes[
      crashes.length - 1
    ];

  await ctx.reply(
    `🚨 DERNIER CRASH\n\n` +
    `🪙 ${crash.name || "N/A"}\n` +
    `⚠️ ${crash.crash?.type || "N/A"}\n` +
    `💰 Prix: ${crash.market?.price || "N/A"}\n` +
    `💧 Liquidité: $${Number(crash.market?.liquidity || 0).toFixed(2)}\n\n` +
    formatComparison()
  );
});

// ============================================================
// /HELP
// ============================================================

bot.help(async ctx => {
  await ctx.reply(
    `🤖 V6.1\n\n` +
    `/scan\n` +
    `/test MINT\n` +
    `/starttrade\n` +
    `/stoptrade\n` +
    `/status\n` +
    `/comparison\n` +
    `/lastcrash\n\n` +
    `Filtres:\n` +
    `Claude / OpenAI / Anthropic\n` +
    `Liquidité 200k–400k $\n` +
    `≥ 1 000 holders\n` +
    `< 5 heures\n` +
    `PumpSwap\n\n` +
    `Simulation uniquement.`
  );
});

// ============================================================
// TELEGRAM LAUNCH
// ============================================================

async function startBot() {
  console.log(
    "🤖 V6.1 Telegram bot démarré"
  );

  console.log(
    "📡 RPC:",
    RPC_URL.replace(
      HELIUS_API_KEY,
      "***"
    )
  );

  await bot.launch({
    dropPendingUpdates: true,
  });

  console.log(
    "🟢 Telegram polling actif"
  );
}

startBot().catch(
  e => {
    console.error(
      "❌ Telegram launch:",
      e
    );
  }
);

// ============================================================
// PROCESS
// ============================================================

process.once(
  "SIGINT",
  () => {
    stopTrade();
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    stopTrade();
    bot.stop("SIGTERM");
  }
);
