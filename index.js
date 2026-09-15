require("dotenv").config();

const { Telegraf } = require("telegraf");
const { Connection, PublicKey } = require("@solana/web3.js");
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
// RPC
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
// PROGRAMS
// ============================================================

const PUMPSWAP_PROGRAM = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// ============================================================
// TEST TOKEN
// ============================================================
//
// Ce token est explicitement autorisé pour notre test.
// Le contrôle PumpSwap on-chain ne peut donc plus bloquer
// la simulation si DexScreener confirme bien PumpSwap.
//
// ============================================================

const TRUSTED_TEST_MINT =
  "6mXbyvPJbPQRyMU5BFL99TFLEDdvuV434cQBSjjitxX7";

// ============================================================
// API
// ============================================================

const DEX_TOKEN_API =
  "https://api.dexscreener.com/latest/dex/tokens";

const PUMPFUN_API =
  "https://frontend-api-v3.pump.fun/coins";

// ============================================================
// FILTERS
// ============================================================

const ALLOWED_NAMES = [
  "claude",
  "openai",
  "anthropic",
];

const MIN_LIQUIDITY = 200000;
const MAX_LIQUIDITY = 400000;

const MIN_HOLDERS = 1000;

const MAX_AGE_MS =
  5 * 60 * 60 * 1000;

// ============================================================
// STRATEGY
// ============================================================

const CAPITAL = 10;

const TARGET_PERCENT = 5;

const STOP_LEVELS = [
  -10,
  -15,
  -20,
  -25,
];

const MARKET_INTERVAL_MS = 2000;

const POST_SELL_COOLDOWN_MS =
  30000;

const NO_NEW_BUY_AFTER_MS =
  43 * 60 * 1000;

const MAX_SESSION_MS =
  45 * 60 * 1000;

const MIN_TRADE_LIQUIDITY = 3000;

const HISTORY_MS = 120000;

const CRASH_LIQUIDITY = 1;

const CRASH_LIQUIDITY_DROP_10S = -50;

const CRASH_PRICE_DROP_10S = -20;

// ============================================================
// DATA
// ============================================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });
}

const MARKET_FILE =
  path.join(
    DATA_DIR,
    "v6_2_market_history.jsonl"
  );

const TRADES_FILE =
  path.join(
    DATA_DIR,
    "v6_2_trades.json"
  );

const COMPARISON_FILE =
  path.join(
    DATA_DIR,
    "v6_2_comparison.json"
  );

const CRASH_FILE =
  path.join(
    DATA_DIR,
    "v6_2_crashes.json"
  );

// ============================================================
// TELEGRAM
// ============================================================

const bot =
  new Telegraf(
    BOT_TOKEN
  );

// ============================================================
// STATE
// ============================================================

let currentCandidate = null;
let currentPair = null;
let currentPool = null;

let tradeRunning = false;

let sessionStartedAt = null;

let marketTimer = null;
let poolTimer = null;

let heliusWs = null;

let marketHistory = [];

let trades = [];

let crashes = [];

let lastMarket = null;

let lastDiagnosticAt = 0;

let evaluationLock = false;

const poolCache =
  new Map();

// ============================================================
// STRATEGIES
// ============================================================

let strategies = [];

function resetStrategies() {
  strategies =
    STOP_LEVELS.map(
      (
        stopPercent,
        index
      ) => ({
        id:
          index + 1,

        name:
          `STOP ${stopPercent}%`,

        capital:
          CAPITAL,

        targetPercent:
          TARGET_PERCENT,

        stopPercent,

        open:
          false,

        entryPrice:
          null,

        entryLiquidity:
          null,

        entryAt:
          null,

        targetPrice:
          null,

        stopPrice:
          null,

        lastSellAt:
          0,

        wins:
          0,

        losses:
          0,

        crashes:
          0,

        sessionLimit:
          0,

        totalPnl:
          0,

        totalInvested:
          0,

        totalReturned:
          0,

        trades:
          [],
      })
    );
}

resetStrategies();

// ============================================================
// UTILS
// ============================================================

function now() {
  return Date.now();
}

function safeNumber(
  value
) {
  const n =
    Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function appendJsonLine(
  file,
  data
) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(data) +
        "\n"
    );
  } catch (e) {
    console.log(
      "write error:",
      e.message
    );
  }
}

function saveJson(
  file,
  data
) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(
        data,
        null,
        2
      )
    );
  } catch (e) {
    console.log(
      "save error:",
      e.message
    );
  }
}

async function sendTelegram(
  text
) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (e) {
    console.log(
      "Telegram error:",
      e.message
    );
  }
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexPairs(
  mint
) {
  const response =
    await fetch(
      `${DEX_TOKEN_API}/${mint}`
    );

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  return Array.isArray(
    json.pairs
  )
    ? json.pairs
    : [];
}

function isPumpSwapPair(
  pair
) {
  const dex =
    String(
      pair?.dexId || ""
    ).toLowerCase();

  return (
    dex === "pumpswap" ||
    dex === "pump_amm" ||
    dex === "pumpamm" ||
    dex.includes("pump")
  );
}

function chooseBestPumpSwapPair(
  pairs,
  mint
) {
  const candidates =
    pairs.filter(
      pair => {
        if (
          !isPumpSwapPair(
            pair
          )
        ) {
          return false;
        }

        const base =
          pair?.baseToken
            ?.address ||
          "";

        const quote =
          pair?.quoteToken
            ?.address ||
          "";

        return (
          base === mint ||
          quote === mint
        );
      }
    );

  if (
    !candidates.length
  ) {
    return null;
  }

  candidates.sort(
    (a, b) => {
      const la =
        safeNumber(
          a?.liquidity?.usd
        ) || 0;

      const lb =
        safeNumber(
          b?.liquidity?.usd
        ) || 0;

      return lb - la;
    }
  );

  return candidates[0];
}

// ============================================================
// PUMPSWAP PARSER
// ============================================================

function readPubkey(
  data,
  offset
) {
  if (
    !data ||
    data.length <
      offset + 32
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

function readU16(
  data,
  offset
) {
  if (
    !data ||
    data.length <
      offset + 2
  ) {
    return null;
  }

  return data.readUInt16LE(
    offset
  );
}

function readU64(
  data,
  offset
) {
  if (
    !data ||
    data.length <
      offset + 8
  ) {
    return null;
  }

  return Number(
    data.readBigUInt64LE(
      offset
    )
  );
}

function readI128(
  data,
  offset
) {
  if (
    !data ||
    data.length <
      offset + 16
  ) {
    return 0;
  }

  try {
    const low =
      data.readBigUInt64LE(
        offset
      );

    const high =
      data.readBigInt64LE(
        offset + 8
      );

    return Number(
      high *
        18446744073709551616n +
        BigInt(low)
    );
  } catch {
    return 0;
  }
}

function parsePumpSwapPool(
  accountInfo
) {
  if (
    !accountInfo?.data
  ) {
    return null;
  }

  let data;

  if (
    Buffer.isBuffer(
      accountInfo.data
    )
  ) {
    data =
      accountInfo.data;
  } else if (
    Array.isArray(
      accountInfo.data
    )
  ) {
    try {
      data =
        Buffer.from(
          accountInfo.data[0],
          "base64"
        );
    } catch {
      return null;
    }
  } else {
    return null;
  }

  if (
    data.length < 211
  ) {
    return null;
  }

  return {
    index:
      readU16(
        data,
        9
      ),

    creator:
      readPubkey(
        data,
        11
      ),

    baseMint:
      readPubkey(
        data,
        43
      ),

    quoteMint:
      readPubkey(
        data,
        75
      ),

    lpMint:
      readPubkey(
        data,
        107
      ),

    baseVault:
      readPubkey(
        data,
        139
      ),

    quoteVault:
      readPubkey(
        data,
        171
      ),

    lpSupply:
      readU64(
        data,
        203
      ),

    coinCreator:
      readPubkey(
        data,
        211
      ),

    virtualQuoteReserves:
      data.length >= 261
        ? readI128(
            data,
            245
          )
        : 0,

    dataLength:
      data.length,
  };
}

// ============================================================
// DIRECT PROGRAM SEARCH
// ============================================================

async function findDirectPumpSwapPool(
  mint
) {
  const cached =
    poolCache.get(
      mint
    );

  if (
    cached &&
    now() -
      cached.timestamp <
      5 * 60 * 1000
  ) {
    return cached.pool;
  }

  try {
    const accounts =
      await connection.getProgramAccounts(
        PUMPSWAP_PROGRAM,
        {
          commitment:
            "confirmed",

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

          encoding:
            "base64",
        }
      );

    const valid =
      [];

    for (
      const item
      of accounts
    ) {
      const parsed =
        parsePumpSwapPool(
          item.account
        );

      if (!parsed) {
        continue;
      }

      if (
        parsed.baseMint !==
        mint
      ) {
        continue;
      }

      if (
        parsed.quoteMint !==
        WSOL_MINT
      ) {
        continue;
      }

      valid.push({
        poolAddress:
          item.pubkey.toBase58(),

        ...parsed,
      });
    }

    if (
      !valid.length
    ) {
      return null;
    }

    let best =
      valid[0];

    let bestQuote =
      0;

    for (
      const pool
      of valid
    ) {
      const amount =
        await getVaultAmount(
          pool.quoteVault
        );

      if (
        amount >
        bestQuote
      ) {
        bestQuote =
          amount;

        best =
          pool;
      }
    }

    poolCache.set(
      mint,
      {
        timestamp:
          now(),

        pool:
          best,
      }
    );

    return best;
  } catch (e) {
    console.log(
      "Direct PumpSwap search:",
      e.message
    );

    return null;
  }
}

// ============================================================
// VAULT
// ============================================================

async function getVaultAmount(
  vault
) {
  try {
    const account =
      await connection.getAccountInfo(
        new PublicKey(
          vault
        ),
        "confirmed"
      );

    if (
      !account?.data ||
      account.data.length <
        72
    ) {
      return 0;
    }

    return Number(
      account.data.readBigUInt64LE(
        64
      )
    );
  } catch {
    return 0;
  }
}

// ============================================================
// HOLDER COUNT
// ============================================================

async function getHolderCount(
  mint
) {
  try {
    const accounts =
      await connection.getParsedProgramAccounts(
        new PublicKey(
          "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        ),
        {
          commitment:
            "confirmed",

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

    const owners =
      new Set();

    for (
      const account
      of accounts
    ) {
      try {
        const info =
          account.account
            .data
            .parsed
            .info;

        const amount =
          Number(
            info
              ?.tokenAmount
              ?.uiAmount ||
              0
          );

        if (
          amount > 0 &&
          info?.owner
        ) {
          owners.add(
            info.owner
          );
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
  } catch (e) {
    console.log(
      "Holder error:",
      e.message
    );

    return 0;
  }
}

// ============================================================
// NAME
// ============================================================

function normalizeName(
  value
) {
  return String(
    value || ""
  )
    .trim()
    .toLowerCase();
}

function nameMatches(
  name,
  symbol
) {
  const n =
    normalizeName(
      name
    );

  const s =
    normalizeName(
      symbol
    );

  return ALLOWED_NAMES.some(
    allowed =>
      n === allowed ||
      s === allowed
  );
}

// ============================================================
// AGE
// ============================================================

function getPairAgeMs(
  pair
) {
  const created =
    safeNumber(
      pair?.pairCreatedAt
    );

  if (!created) {
    return null;
  }

  return (
    now() -
    created
  );
}

// ============================================================
// EVALUATION
// ============================================================

async function evaluateMint(
  mint,
  options = {}
) {
  if (
    evaluationLock &&
    !options.force
  ) {
    return {
      ok: false,
      reason:
        "EVALUATION_BUSY",
    };
  }

  evaluationLock = true;

  try {
    let pairs;

    try {
      pairs =
        await getDexPairs(
          mint
        );
    } catch (e) {
      return {
        ok: false,
        reason:
          `DEX_ERROR: ${e.message}`,
      };
    }

    const pair =
      chooseBestPumpSwapPair(
        pairs,
        mint
      );

    if (!pair) {
      return {
        ok: false,
        reason:
          "NO_PUMPSWAP_PAIR",
      };
    }

    const name =
      pair?.baseToken
        ?.address === mint
        ? pair?.baseToken?.name
        : pair?.quoteToken?.name;

    const symbol =
      pair?.baseToken
        ?.address === mint
        ? pair?.baseToken?.symbol
        : pair?.quoteToken?.symbol;

    const liquidity =
      safeNumber(
        pair?.liquidity?.usd
      ) || 0;

    const ageMs =
      getPairAgeMs(
        pair
      );

    // ========================================================
    // FILTRES NORMAUX
    // ========================================================

    if (
      !nameMatches(
        name,
        symbol
      )
    ) {
      return {
        ok: false,
        reason:
          "NAME_NOT_ALLOWED",
        name,
        symbol,
        pair,
      };
    }

    if (
      liquidity <
        MIN_LIQUIDITY ||
      liquidity >
        MAX_LIQUIDITY
    ) {
      return {
        ok: false,
        reason:
          "LIQUIDITY_OUT_OF_RANGE",
        name,
        symbol,
        liquidity,
        pair,
      };
    }

    if (
      ageMs === null
    ) {
      return {
        ok: false,
        reason:
          "AGE_UNKNOWN",
        name,
        symbol,
        liquidity,
        pair,
      };
    }

    if (
      ageMs >
      MAX_AGE_MS
    ) {
      return {
        ok: false,
        reason:
          "TOKEN_TOO_OLD",
        name,
        symbol,
        liquidity,
        ageMs,
        pair,
      };
    }

    const holders =
      await getHolderCount(
        mint
      );

    if (
      holders <
      MIN_HOLDERS
    ) {
      return {
        ok: false,
        reason:
          "NOT_ENOUGH_HOLDERS",
        name,
        symbol,
        liquidity,
        ageMs,
        holders,
        pair,
      };
    }

    // ========================================================
    // POOL DIRECT
    // ========================================================

    const directPool =
      await findDirectPumpSwapPool(
        mint
      );

    // ========================================================
    // EXCEPTION EXPLICITE POUR LE TOKEN DE TEST
    // ========================================================
    //
    // Le token a déjà passé:
    //
    // - nom OpenAI
    // - PumpSwap DexScreener
    // - liquidité
    // - holders
    // - âge
    //
    // Si le compte Pool ne peut pas être retrouvé par notre
    // RPC, on NE BLOQUE PAS notre test.
    //
    // Le marché utilisé pour la simulation reste celui de
    // DexScreener PumpSwap.
    //
    // ========================================================

    if (
      !directPool &&
      mint === TRUSTED_TEST_MINT
    ) {
      return {
        ok: true,

        mint,

        name,
        symbol,

        liquidity,
        ageMs,
        holders,

        pair,

        pairAddress:
          pair.pairAddress,

        pool: null,

        onchain: false,

        testOverride: true,

        onchainSource:
          "DEXSCREENER_PUMPSWAP_TEST_OVERRIDE",
      };
    }

    if (
      !directPool
    ) {
      return {
        ok: false,
        reason:
          "NO_VALID_DIRECT_PUMPSWAP_POOL",
        name,
        symbol,
        liquidity,
        ageMs,
        holders,
        pair,
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

      pair,

      pairAddress:
        pair.pairAddress,

      pool:
        directPool,

      onchain: true,

      testOverride: false,

      onchainSource:
        "DIRECT_PUMPSWAP_POOL",
    };
  } finally {
    evaluationLock =
      false;
  }
}

// ============================================================
// MARKET DATA
// ============================================================

async function getMarketData() {
  if (
    !currentCandidate
  ) {
    return null;
  }

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

  currentPair =
    pair;

  const market = {
    timestamp:
      now(),

    price,

    liquidity,

    dexId:
      pair?.dexId ||
      null,

    pairAddress:
      pair?.pairAddress ||
      null,

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

  marketHistory.push(
    market
  );

  const cutoff =
    now() -
    HISTORY_MS;

  marketHistory =
    marketHistory.filter(
      item =>
        item.timestamp >=
        cutoff
    );

  appendJsonLine(
    MARKET_FILE,
    market
  );

  return market;
}

// ============================================================
// HISTORY
// ============================================================

function getOldestWithin(
  ms
) {
  const cutoff =
    now() - ms;

  return (
    marketHistory.find(
      item =>
        item.timestamp >=
        cutoff
    ) || null
  );
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
    ((newValue -
      oldValue) /
      oldValue) *
    100
  );
}

function priceDrop10s(
  market
) {
  const old =
    getOldestWithin(
      10000
    );

  if (!old) {
    return null;
  }

  return changePercent(
    old.price,
    market.price
  );
}

function liquidityDrop10s(
  market
) {
  const old =
    getOldestWithin(
      10000
    );

  if (!old) {
    return null;
  }

  return changePercent(
    old.liquidity,
    market.liquidity
  );
}

function liquidityDrop30s(
  market
) {
  const old =
    getOldestWithin(
      30000
    );

  if (!old) {
    return null;
  }

  return changePercent(
    old.liquidity,
    market.liquidity
  );
}

// ============================================================
// ENTRY
// ============================================================

function entryHealth(
  market
) {
  if (!market) {
    return {
      ok: false,
      reason:
        "NO_MARKET",
    };
  }

  if (
    market.liquidity <
    MIN_TRADE_LIQUIDITY
  ) {
    return {
      ok: false,
      reason:
        "LIQUIDITY_TOO_LOW",
    };
  }

  if (
    marketHistory.length <
    8
  ) {
    return {
      ok: false,
      reason:
        `HISTORY_WARMUP (${marketHistory.length}/8)`,
    };
  }

  const p10 =
    priceDrop10s(
      market
    );

  const l10 =
    liquidityDrop10s(
      market
    );

  const l30 =
    liquidityDrop30s(
      market
    );

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
    reason:
      "HEALTHY",
  };
}

// ============================================================
// CRASH
// ============================================================

function detectCrash(
  market
) {
  if (!market) {
    return null;
  }

  if (
    market.liquidity <=
    CRASH_LIQUIDITY
  ) {
    return {
      type:
        "LIQUIDITY_NEAR_ZERO",

      price:
        market.price,

      liquidity:
        market.liquidity,
    };
  }

  const l10 =
    liquidityDrop10s(
      market
    );

  if (
    l10 !== null &&
    l10 <=
      CRASH_LIQUIDITY_DROP_10S
  ) {
    return {
      type:
        "LIQUIDITY_COLLAPSE",

      price:
        market.price,

      liquidity:
        market.liquidity,

      liquidityDrop10s:
        l10,
    };
  }

  const p10 =
    priceDrop10s(
      market
    );

  if (
    p10 !== null &&
    p10 <=
      CRASH_PRICE_DROP_10S
  ) {
    return {
      type:
        "PRICE_CRASH",

      price:
        market.price,

      liquidity:
        market.liquidity,

      priceDrop10s:
        p10,
    };
  }

  return null;
}

// ============================================================
// BUY
// ============================================================

function canBuy(
  strategy
) {
  if (
    strategy.open
  ) {
    return false;
  }

  if (
    now() -
      strategy.lastSellAt <
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
    now() -
      sessionStartedAt >=
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
  strategy.open =
    true;

  strategy.entryPrice =
    market.price;

  strategy.entryLiquidity =
    market.liquidity;

  strategy.entryAt =
    now();

  strategy.targetPrice =
    strategy.entryPrice *
    1.05;

  strategy.stopPrice =
    strategy.entryPrice *
    (
      1 +
      strategy.stopPercent /
        100
    );

  strategy.totalInvested +=
    CAPITAL;

  console.log(
    `🟢 BUY SIMULÉ ${strategy.name} @ ${market.price}`
  );
}

// ============================================================
// SELL
// ============================================================

function simulateSell(
  strategy,
  market,
  reason
) {
  if (
    !strategy.open
  ) {
    return;
  }

  const entry =
    strategy.entryPrice;

  const exit =
    market.price;

  const resultPercent =
    (
      (exit - entry) /
      entry
    ) * 100;

  const pnl =
    CAPITAL *
    (
      resultPercent /
      100
    );

  strategy.totalPnl +=
    pnl;

  strategy.totalReturned +=
    CAPITAL + pnl;

  strategy.open =
    false;

  strategy.lastSellAt =
    now();

  if (
    reason ===
    "TARGET"
  ) {
    strategy.wins++;
  }

  if (
    reason ===
    "STOP"
  ) {
    strategy.losses++;
  }

  if (
    reason ===
    "CRASH"
  ) {
    strategy.losses++;
    strategy.crashes++;
  }

  if (
    reason ===
    "SESSION_LIMIT"
  ) {
    strategy.sessionLimit++;
  }

  const trade = {
    strategy:
      strategy.name,

    strategyId:
      strategy.id,

    reason,

    entryPrice:
      entry,

    exitPrice:
      exit,

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
    `🎯 SELL ${strategy.name} ${reason} ${resultPercent.toFixed(2)}%`
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
    if (
      strategy.open
    ) {
      simulateSell(
        strategy,
        market,
        reason
      );
    }
  }
}

// ============================================================
// COMPARISON
// ============================================================

function formatComparison() {
  return strategies
    .map(
      s =>
        `${s.name}: ${s.wins}W / ${s.losses}L / ${s.sessionLimit}SL | P&L ${
          s.totalPnl >= 0
            ? "+"
            : ""
        }${s.totalPnl.toFixed(
          2
        )} $`
    )
    .join("\n");
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
        strategies.map(
          s => ({
            strategy:
              s.name,

            stop:
              s.stopPercent,

            target:
              s.targetPercent,

            wins:
              s.wins,

            losses:
              s.losses,

            crashes:
              s.crashes,

            sessionLimit:
              s.sessionLimit,

            pnl:
              Number(
                s.totalPnl.toFixed(
                  4
                )
              ),
          })
        ),
    }
  );
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
      strategies.map(
        s => ({
          name:
            s.name,

          wins:
            s.wins,

          losses:
            s.losses,

          crashes:
            s.crashes,

          sessionLimit:
            s.sessionLimit,

          totalPnl:
            s.totalPnl,

          open:
            s.open,
        })
      ),

    history:
      marketHistory.slice(
        -100
      ),
  };

  crashes.push(
    report
  );

  saveJson(
    CRASH_FILE,
    crashes
  );
}

// ============================================================
// SESSION
// ============================================================

function sessionLimitReached() {
  if (
    !sessionStartedAt
  ) {
    return false;
  }

  return (
    now() -
      sessionStartedAt >=
    MAX_SESSION_MS
  );
}

function noMoreBuys() {
  if (
    !sessionStartedAt
  ) {
    return false;
  }

  return (
    now() -
      sessionStartedAt >=
    NO_NEW_BUY_AFTER_MS
  );
}

// ============================================================
// MARKET TICK
// ============================================================

async function marketTick() {
  if (
    !tradeRunning
  ) {
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

    // TARGET / STOP
    for (
      const strategy
      of strategies
    ) {
      if (
        !strategy.open
      ) {
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

    // CRASH
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

      stopTrade();

      saveComparison();

      await sendTelegram(
        `🚨 CRASH V6.2\n\n` +
        `🪙 ${
          currentCandidate?.name ||
          "Token"
        }\n` +
        `💰 Prix: ${market.price}\n` +
        `💧 Liquidité: $${market.liquidity.toFixed(
          2
        )}\n` +
        `⚠️ ${crash.type}\n\n` +
        `🛑 Nouveaux BUY arrêtés.\n\n` +
        formatComparison()
      );

      return;
    }

    // 45 MINUTES
    if (
      sessionLimitReached()
    ) {
      forceCloseAll(
        market,
        "SESSION_LIMIT"
      );

      stopTrade();

      saveComparison();

      await sendTelegram(
        `⏱️ FIN SESSION\n\n` +
        `45 minutes atteintes.\n` +
        `Toute position ouverte a été fermée.\n\n` +
        formatComparison()
      );

      return;
    }

    // BUY
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
            canBuy(
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

    // DIAGNOSTIC
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
        `📊 Prix ${market.price} | ` +
        `Liquidité $${market.liquidity.toFixed(
          2
        )} | ` +
        `P10 ${
          p10 === null
            ? "N/A"
            : p10.toFixed(2) +
              "%"
        } | ` +
        `L10 ${
          l10 === null
            ? "N/A"
            : l10.toFixed(2) +
              "%"
        }`
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
// POOL REFRESH
// ============================================================

async function refreshPool() {
  if (
    !tradeRunning ||
    !currentCandidate
  ) {
    return;
  }

  try {
    const pool =
      await findDirectPumpSwapPool(
        currentCandidate.mint
      );

    if (pool) {
      currentPool =
        pool;
    }
  } catch (e) {
    console.log(
      "Pool refresh:",
      e.message
    );
  }
}

// ============================================================
// HELIUS
// ============================================================

function startHeliusLogs() {
  try {
    if (
      heliusWs
    ) {
      try {
        heliusWs.close();
      } catch {}
    }

    heliusWs =
      new WebSocket(
        WSS_URL
      );

    heliusWs.onopen =
      () => {
        try {
          heliusWs.send(
            JSON.stringify({
              jsonrpc:
                "2.0",

              id:
                1,

              method:
                "logsSubscribe",

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

    heliusWs.onmessage =
      event => {
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
              data?.params
                ?.result
                ?.value
                ?.logs;

            if (
              Array.isArray(
                logs
              )
            ) {
              const text =
                logs.join(
                  " "
                );

              if (
                text.includes(
                  "Instruction: Buy"
                ) ||
                text.includes(
                  "Instruction: Sell"
                )
              ) {
                console.log(
                  "⚡ PumpSwap trade"
                );
              }
            }
          }
        } catch {}
      };

    heliusWs.onerror =
      () => {
        console.log(
          "Helius WS error"
        );
      };

    heliusWs.onclose =
      () => {
        heliusWs =
          null;
      };
  } catch (e) {
    console.log(
      "Helius WS error:",
      e.message
    );
  }
}

// ============================================================
// STOP
// ============================================================

function stopTrade() {
  tradeRunning =
    false;

  if (
    marketTimer
  ) {
    clearInterval(
      marketTimer
    );

    marketTimer =
      null;
  }

  if (
    poolTimer
  ) {
    clearInterval(
      poolTimer
    );

    poolTimer =
      null;
  }

  if (
    heliusWs
  ) {
    try {
      heliusWs.close();
    } catch {}

    heliusWs =
      null;
  }
}

// ============================================================
// START TRADE
// ============================================================

async function startTrade() {
  if (
    !currentCandidate
  ) {
    return {
      ok: false,

      message:
        "Aucun token. Utilise /test MINT.",
    };
  }

  if (
    tradeRunning
  ) {
    return {
      ok: false,

      message:
        "Simulation déjà active.",
    };
  }

  const validation =
    await evaluateMint(
      currentCandidate.mint,
      {
        force: true,
      }
    );

  if (
    !validation.ok
  ) {
    return {
      ok: false,

      message:
        `Token refusé: ${validation.reason}`,
    };
  }

  currentCandidate =
    validation;

  currentPair =
    validation.pair;

  currentPool =
    validation.pool;

  marketHistory =
    [];

  lastMarket =
    null;

  resetStrategies();

  sessionStartedAt =
    now();

  tradeRunning =
    true;

  startHeliusLogs();

  marketTimer =
    setInterval(
      marketTick,
      MARKET_INTERVAL_MS
    );

  poolTimer =
    setInterval(
      refreshPool,
      30000
    );

  return {
    ok: true,
  };
}

// ============================================================
// SCAN
// ============================================================

async function scanPumpFun() {
  try {
    const response =
      await fetch(
        `${PUMPFUN_API}?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false`
      );

    if (!response.ok) {
      throw new Error(
        `Pump.fun HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !Array.isArray(
        data
      )
    ) {
      return [];
    }

    return data.filter(
      token =>
        token?.mint &&
        nameMatches(
          token?.name,
          token?.symbol
        )
    );
  } catch (e) {
    console.log(
      "Scan error:",
      e.message
    );

    return [];
  }
}

async function runScan() {
  const candidates =
    await scanPumpFun();

  if (
    !candidates.length
  ) {
    await sendTelegram(
      "🔎 Aucun candidat trouvé."
    );

    return;
  }

  for (
    const token
    of candidates
  ) {
    const result =
      await evaluateMint(
        token.mint
      );

    if (
      result.ok
    ) {
      currentCandidate =
        result;

      currentPair =
        result.pair;

      currentPool =
        result.pool;

      await sendTelegram(
        `🎯 CANDIDAT VALIDÉ\n\n` +
        `🪙 ${result.name}\n` +
        `🔤 ${result.symbol}\n` +
        `💧 $${result.liquidity.toFixed(
          2
        )}\n` +
        `👥 ≥${result.holders}\n` +
        `⏱️ ${(result.ageMs / 60000).toFixed(
          1
        )} min\n` +
        `🏦 PumpSwap 🟢\n` +
        `📡 Source: ${result.onchainSource}\n\n` +
        `Mint:\n${result.mint}\n\n` +
        `Pair:\n${result.pairAddress}\n\n` +
        `▶️ /starttrade`
      );

      return;
    }
  }

  await sendTelegram(
    "🔎 Scan terminé.\n\nAucun token ne respecte les filtres."
  );
}

// ============================================================
// /START
// ============================================================

bot.start(
  async ctx => {
    await ctx.reply(
      `🤖 V6.2 RADAR\n\n` +
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
      `/scan\n` +
      `/test MINT\n` +
      `/starttrade\n` +
      `/stoptrade\n` +
      `/status\n` +
      `/comparison\n` +
      `/lastcrash`
    );
  }
);

// ============================================================
// /TEST
// ============================================================

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
        "Utilise:\n/test MINT"
      );

      return;
    }

    try {
      new PublicKey(
        mint
      );
    } catch {
      await ctx.reply(
        "❌ Mint invalide."
      );

      return;
    }

    await ctx.reply(
      `🔎 TEST V6.2\n\n` +
      `Mint:\n${mint}\n\n` +
      `Validation marché PumpSwap...`
    );

    const result =
      await evaluateMint(
        mint,
        {
          force: true,
        }
      );

    if (
      !result.ok
    ) {
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
          `\n💧 Liquidité: $${Number(
            result.liquidity
          ).toFixed(
            2
          )}`;
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
          `\n⏱️ Âge: ${(result.ageMs / 60000).toFixed(
            1
          )} min`;
      }

      if (
        result.pair
          ?.pairAddress
      ) {
        text +=
          `\n\nPair Dex:\n${result.pair.pairAddress}`;
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

    let text =
      `🟢 TOKEN ACCEPTÉ V6.2\n\n` +
      `🪙 Nom: ${result.name}\n` +
      `🔤 Symbole: ${result.symbol}\n\n` +
      `💧 Liquidité: $${result.liquidity.toFixed(
        2
      )}\n` +
      `👥 Holders: ≥${result.holders}\n` +
      `⏱️ Âge: ${(result.ageMs / 60000).toFixed(
        1
      )} min\n\n` +
      `🏦 PumpSwap: 🟢 OK\n` +
      `📊 DEX: ${result.pair.dexId}\n` +
      `⛓️ Pool direct: ${
        result.pool
          ? "🟢 OK"
          : "⚠️ non trouvé"
      }\n`;

    if (
      result.testOverride
    ) {
      text +=
        `\n🧪 MODE TEST: 🟢 AUTORISÉ\n` +
        `La vérification du compte Pool ne bloque plus ce token.\n` +
        `La simulation utilisera les données PumpSwap de DexScreener.\n`;
    }

    text +=
      `\nPair Dex:\n${result.pairAddress}\n\n` +
      `Mint:\n${result.mint}\n\n` +
      `▶️ /starttrade`;

    if (
      result.pool
    ) {
      text +=
        `\n\nPool:\n${result.pool.poolAddress}` +
        `\nIndex: ${result.pool.index}`;
    }

    await ctx.reply(
      text
    );
  }
);

// ============================================================
// /SCAN
// ============================================================

bot.command(
  "scan",
  async () => {
    await runScan();
  }
);

// ============================================================
// /STARTTRADE
// ============================================================

bot.command(
  "starttrade",
  async ctx => {
    const result =
      await startTrade();

    if (
      !result.ok
    ) {
      await ctx.reply(
        `❌ ${result.message}`
      );

      return;
    }

    await ctx.reply(
      `🟢 V5.9 SIMULATION ACTIVE\n\n` +
      `🪙 ${currentCandidate.name}\n` +
      `🔤 ${currentCandidate.symbol}\n\n` +
      `💵 10 $ / cycle\n` +
      `🎯 +5%\n` +
      `🛡️ -10 / -15 / -20 / -25%\n` +
      `⏱️ 45 min\n` +
      `🚫 Aucun BUY après 43 min\n\n` +
      `📊 Marché: PumpSwap\n` +
      `Pair:\n${currentCandidate.pairAddress}\n\n` +
      `🧪 SIMULATION UNIQUEMENT`
    );
  }
);

// ============================================================
// /STOPTRADE
// ============================================================

bot.command(
  "stoptrade",
  async ctx => {
    if (
      !tradeRunning
    ) {
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
  }
);

// ============================================================
// /STATUS
// ============================================================

bot.command(
  "status",
  async ctx => {
    let text =
      `📊 STATUS V6.2\n\n`;

    text +=
      `Simulation: ${
        tradeRunning
          ? "🟢 ACTIVE"
          : "🔴 STOP"
      }\n`;

    if (
      currentCandidate
    ) {
      text +=
        `🪙 ${currentCandidate.name}\n`;

      text +=
        `Mint:\n${currentCandidate.mint}\n\n`;

      text +=
        `📊 DEX: ${
          currentCandidate
            .pair?.dexId ||
          "N/A"
        }\n`;

      text +=
        `🧪 Test override: ${
          currentCandidate.testOverride
            ? "OUI"
            : "NON"
        }\n\n`;
    }

    if (
      lastMarket
    ) {
      text +=
        `💰 Prix: ${lastMarket.price}\n`;

      text +=
        `💧 Liquidité: $${lastMarket.liquidity.toFixed(
          2
        )}\n\n`;
    }

    text +=
      formatComparison();

    await ctx.reply(
      text
    );
  }
);

// ============================================================
// /COMPARISON
// ============================================================

bot.command(
  "comparison",
  async ctx => {
    await ctx.reply(
      `📊 COMPARAISON V5.9\n\n` +
      formatComparison()
    );

    saveComparison();
  }
);

// ============================================================
// /LASTCRASH
// ============================================================

bot.command(
  "lastcrash",
  async ctx => {
    if (
      !crashes.length
    ) {
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
      `🪙 ${
        crash.name ||
        "N/A"
      }\n` +
      `⚠️ ${
        crash.crash
          ?.type ||
        "N/A"
      }\n` +
      `💰 Prix: ${
        crash.market
          ?.price ||
        "N/A"
      }\n` +
      `💧 Liquidité: $${Number(
        crash.market
          ?.liquidity ||
        0
      ).toFixed(
        2
      )}\n\n` +
      formatComparison()
    );
  }
);

// ============================================================
// /HELP
// ============================================================

bot.help(
  async ctx => {
    await ctx.reply(
      `🤖 V6.2\n\n` +
      `/scan\n` +
      `/test MINT\n` +
      `/starttrade\n` +
      `/stoptrade\n` +
      `/status\n` +
      `/comparison\n` +
      `/lastcrash`
    );
  }
);

// ============================================================
// LAUNCH
// ============================================================

async function startBot() {
  console.log(
    "🤖 V6.2 Telegram bot démarré"
  );

  await bot.launch({
    dropPendingUpdates:
      true,
  });

  console.log(
    "🟢 Telegram polling actif"
  );
}

startBot().catch(
  error => {
    console.error(
      "❌ Telegram launch:",
      error
    );
  }
);

// ============================================================
// SHUTDOWN
// ============================================================

process.once(
  "SIGINT",
  () => {
    stopTrade();
    bot.stop(
      "SIGINT"
    );
  }
);

process.once(
  "SIGTERM",
  () => {
    stopTrade();
    bot.stop(
      "SIGTERM"
    );
  }
);
