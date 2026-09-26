"use strict";

const http = require("http");
const ws = require("ws");

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const RPC_HTTP =
  process.env.RPC_HTTP ||
  "https://api.mainnet-beta.solana.com";

const RPC_WS =
  process.env.RPC_WS ||
  "wss://api.mainnet-beta.solana.com";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

const CRASH_GUARD_SECRET =
  process.env.CRASH_GUARD_SECRET || "";

const CRASH_GUARD_TARGET_URL =
  process.env.CRASH_GUARD_TARGET_URL || "";

// PumpSwap / Pump AMM
const PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

// Native SOL / WSOL mint
const SOL_MINT =
  "So11111111111111111111111111111111111111112";

// ============================================================
// SEUILS CRASH GUARD
// ============================================================

const WATCH_DROP_5S = -5;
const WATCH_DROP_10S = -8;

const DANGER_DROP_5S = -10;
const DANGER_DROP_10S = -15;

const CRITICAL_DROP_5S = -20;
const CRITICAL_DROP_10S = -30;

const DANGER_HOLD_MS = 15000;

// ============================================================
// TIMING
// ============================================================

const SAMPLE_INTERVAL_MS = 1000;
const DEX_REFRESH_INTERVAL_MS = 5000;

const HISTORY_MAX = 120;

const HTTP_TIMEOUT_MS = 5000;

const DEX_RETRY_COUNT = 3;
const DEX_RETRY_BASE_DELAY_MS = 1200;

// ============================================================
// PERSISTENCE
// ============================================================

const DATA_DIR = "/data";

const LOG_FILE =
  `${DATA_DIR}/crash_guard.jsonl`;

function ensureDataDir() {
  try {
    require("fs").mkdirSync(DATA_DIR, {
      recursive: true,
    });
  } catch (_) {}
}

ensureDataDir();

function logEvent(type, data = {}) {
  const row = {
    timestamp: new Date().toISOString(),
    type,
    ...data,
  };

  console.log(JSON.stringify(row));

  try {
    require("fs").appendFileSync(
      LOG_FILE,
      JSON.stringify(row) + "\n"
    );
  } catch (_) {}
}

// ============================================================
// ETAT
// ============================================================

const state = {
  armed: false,

  currentMint: null,
  currentPool: null,

  baseMint: null,
  quoteMint: null,

  baseVault: null,
  quoteVault: null,

  baseDecimals: 6,
  quoteDecimals: 9,

  ws: null,

  subscriptions: {},

  vaultAmounts: {
    base: null,
    quote: null,
  },

  history: [],

  dex: {
    priceUsd: null,
    liquidityUsd: null,
    pairAddress: null,
    updatedAt: 0,
  },

  level: "WATCH",

  dangerUntil: 0,

  criticalLatched: false,

  lastSignal: null,

  timers: {
    sample: null,
    dex: null,
  },

  eventId: 0,

  // Cache DexScreener
  dexCache: {
    pool: null,
    market: null,
    lastSuccessAt: 0,
  },

  // Empêche les rafales de requêtes DexScreener
  dexNextAllowedAt: 0,
};

// ============================================================
// UTILITAIRES
// ============================================================

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function pctChange(oldValue, newValue) {
  if (
    oldValue === null ||
    oldValue === undefined ||
    newValue === null ||
    newValue === undefined
  ) {
    return null;
  }

  if (!Number.isFinite(oldValue) ||
      !Number.isFinite(newValue)) {
    return null;
  }

  if (oldValue === 0) {
    return null;
  }

  return ((newValue - oldValue) / oldValue) * 100;
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pubkeyFromBytes(buffer, offset) {
  return buffer.subarray(offset, offset + 32)
    .toString("base64");
}

function base58Encode(buffer) {
  const ALPHABET =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let digits = [0];

  for (const byte of buffer) {
    let carry = byte;

    for (let i = 0; i < digits.length; i++) {
      const value = digits[i] * 256 + carry;

      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let result = "";

  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    result += "1";
  }

  for (let i = digits.length - 1; i >= 0; i--) {
    result += ALPHABET[digits[i]];
  }

  return result;
}

function pubkeyFromAccountData(buffer, offset) {
  return base58Encode(
    buffer.subarray(offset, offset + 32)
  );
}

// ============================================================
// HTTP / RPC
// ============================================================

async function rpc(method, params = []) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(RPC_HTTP, {
      method: "POST",

      headers: {
        "content-type": "application/json",
      },

      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),

      signal: controller.signal,
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `RPC HTTP ${response.status}: ${text.slice(0, 500)}`
      );
    }

    let json;

    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(
        `RPC réponse JSON invalide: ${text.slice(0, 500)}`
      );
    }

    if (json.error) {
      throw new Error(
        `RPC ${json.error.code}: ${json.error.message}`
      );
    }

    return json.result;
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// DEXSCREENER
// ============================================================

async function dexFetch(url) {
  const now = Date.now();

  if (now < state.dexNextAllowedAt) {
    throw new Error(
      "DexScreener temporisation active"
    );
  }

  let lastError = null;

  for (
    let attempt = 0;
    attempt < DEX_RETRY_COUNT;
    attempt++
  ) {
    try {
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          "user-agent":
            "pump-crash-guard/1.0",
        },
      });

      const text = await response.text();

      if (response.status === 429) {
        const retryAfterHeader =
          response.headers.get("retry-after");

        const retryAfterSeconds =
          Number(retryAfterHeader);

        const delay =
          Number.isFinite(retryAfterSeconds) &&
          retryAfterSeconds > 0
            ? Math.min(
                retryAfterSeconds * 1000,
                15000
              )
            : DEX_RETRY_BASE_DELAY_MS *
              Math.pow(2, attempt);

        state.dexNextAllowedAt =
          Date.now() + delay;

        lastError = new Error(
          "DexScreener HTTP 429"
        );

        logEvent("dex_429", {
          attempt: attempt + 1,
          delay,
          url,
        });

        if (attempt < DEX_RETRY_COUNT - 1) {
          await sleep(delay);
          continue;
        }

        throw lastError;
      }

      if (!response.ok) {
        throw new Error(
          `DexScreener HTTP ${response.status}`
        );
      }

      let json;

      try {
        json = JSON.parse(text);
      } catch (_) {
        throw new Error(
          "DexScreener réponse JSON invalide"
        );
      }

      state.dexNextAllowedAt =
        Date.now() + 250;

      return json;
    } catch (error) {
      lastError = error;

      if (
        attempt < DEX_RETRY_COUNT - 1 &&
        !String(error.message).includes(
          "temporisation active"
        )
      ) {
        const delay =
          DEX_RETRY_BASE_DELAY_MS *
          Math.pow(2, attempt);

        await sleep(delay);
      }
    }
  }

  throw lastError ||
    new Error("DexScreener indisponible");
}

// ============================================================
// RECHERCHE ON-CHAIN DU POOL PUMPSWAP
// ============================================================

function decodePoolAccount(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    buffer = Buffer.from(buffer);
  }

  // Ancien / nouveau layout PumpSwap.
  // Le layout utilisé ici correspond au compte Pool
  // documenté par PumpSwap.

  if (buffer.length < 301) {
    throw new Error(
      `Compte Pool trop petit: ${buffer.length} octets`
    );
  }

  const baseMint =
    pubkeyFromAccountData(buffer, 43);

  const quoteMint =
    pubkeyFromAccountData(buffer, 75);

  const baseVault =
    pubkeyFromAccountData(buffer, 139);

  const quoteVault =
    pubkeyFromAccountData(buffer, 171);

  return {
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
  };
}

async function getProgramPoolCandidates(mint) {
  const filters = [
    {
      dataSize: 301,
    },
  ];

  const results = [];

  // ----------------------------------------------------------
  // Le mint peut être le BASE mint
  // ----------------------------------------------------------

  try {
    const basePools =
      await rpc("getProgramAccounts", [
        PUMPSWAP_PROGRAM_ID,
        {
          encoding: "base64",

          filters: [
            ...filters,

            {
              memcmp: {
                offset: 43,
                bytes: mint,
              },
            },
          ],
        },
      ]);

    for (const item of basePools || []) {
      try {
        const raw =
          Buffer.from(
            item.account.data[0],
            "base64"
          );

        const decoded =
          decodePoolAccount(raw);

        if (
          decoded.baseMint === mint &&
          decoded.quoteMint === SOL_MINT
        ) {
          results.push({
            pool: item.pubkey,
            ...decoded,
          });
        }
      } catch (_) {}
    }
  } catch (error) {
    logEvent(
      "onchain_pool_search_base_error",
      {
        mint,
        error: error.message,
      }
    );
  }

  // ----------------------------------------------------------
  // Le mint peut être le QUOTE mint
  // ----------------------------------------------------------

  try {
    const quotePools =
      await rpc("getProgramAccounts", [
        PUMPSWAP_PROGRAM_ID,
        {
          encoding: "base64",

          filters: [
            ...filters,

            {
              memcmp: {
                offset: 75,
                bytes: mint,
              },
            },
          ],
        },
      ]);

    for (const item of quotePools || []) {
      try {
        const raw =
          Buffer.from(
            item.account.data[0],
            "base64"
          );

        const decoded =
          decodePoolAccount(raw);

        if (
          decoded.quoteMint === mint &&
          decoded.baseMint === SOL_MINT
        ) {
          results.push({
            pool: item.pubkey,
            ...decoded,
          });
        }
      } catch (_) {}
    }
  } catch (error) {
    logEvent(
      "onchain_pool_search_quote_error",
      {
        mint,
        error: error.message,
      }
    );
  }

  return results;
}

async function getTokenAccountRawAmount(address) {
  const result =
    await rpc("getTokenAccountBalance", [
      address,
      {
        commitment: "confirmed",
      },
    ]);

  return {
    raw: BigInt(result.value.amount),
    ui: Number(result.value.uiAmount || 0),
  };
}

async function findBestOnChainPumpSwapPool(mint) {
  const candidates =
    await getProgramPoolCandidates(mint);

  if (!candidates.length) {
    return null;
  }

  const scored = [];

  for (const candidate of candidates) {
    try {
      const quote =
        await getTokenAccountRawAmount(
          candidate.quoteVault
        );

      const base =
        await getTokenAccountRawAmount(
          candidate.baseVault
        );

      scored.push({
        ...candidate,

        quoteReserveRaw:
          quote.raw.toString(),

        quoteReserveUi:
          quote.ui,

        baseReserveRaw:
          base.raw.toString(),

        baseReserveUi:
          base.ui,
      });
    } catch (error) {
      logEvent(
        "onchain_pool_reserve_error",
        {
          pool: candidate.pool,
          error: error.message,
        }
      );
    }
  }

  if (!scored.length) {
    return null;
  }

  // Pour un pool SOL-quoted, la réserve SOL
  // est un bon critère de sélection.
  scored.sort(
    (a, b) =>
      b.quoteReserveUi -
      a.quoteReserveUi
  );

  return scored[0];
}

// ============================================================
// RECHERCHE DU POOL
// ============================================================

async function findPumpSwapPool(mint) {
  // ----------------------------------------------------------
  // 1. Si le cache est encore utilisable, on le garde
  // ----------------------------------------------------------

  if (
    state.dexCache.pool &&
    state.dexCache.pool.mint === mint
  ) {
    return state.dexCache.pool;
  }

  // ----------------------------------------------------------
  // 2. Première source = ON-CHAIN
  // ----------------------------------------------------------

  try {
    const onChain =
      await findBestOnChainPumpSwapPool(mint);

    if (onChain) {
      const result = {
        pool: onChain.pool,
        mint,

        baseMint: onChain.baseMint,
        quoteMint: onChain.quoteMint,

        baseVault: onChain.baseVault,
        quoteVault: onChain.quoteVault,

        priceUsd: null,
        liquidityUsd: null,

        source: "onchain",
      };

      state.dexCache.pool = result;

      logEvent(
        "pool_found_onchain",
        result
      );

      return result;
    }
  } catch (error) {
    logEvent(
      "pool_onchain_failed",
      {
        mint,
        error: error.message,
      }
    );
  }

  // ----------------------------------------------------------
  // 3. Fallback DexScreener
  // ----------------------------------------------------------

  try {
    const data =
      await dexFetch(
        `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`
      );

    const pairs =
      Array.isArray(data)
        ? data
        : Array.isArray(data?.pairs)
          ? data.pairs
          : [];

    const pumpPairs =
      pairs
        .filter(
          (pair) =>
            pair &&
            pair.dexId === "pumpswap" &&
            pair.pairAddress
        )
        .sort(
          (a, b) =>
            Number(
              b?.liquidity?.usd || 0
            ) -
            Number(
              a?.liquidity?.usd || 0
            )
        );

    if (!pumpPairs.length) {
      throw new Error(
        "Aucun pool PumpSwap trouvé"
      );
    }

    const pair =
      pumpPairs[0];

    const result = {
      pool: pair.pairAddress,
      mint,

      baseMint:
        pair.baseToken?.address || null,

      quoteMint:
        pair.quoteToken?.address || null,

      baseVault: null,
      quoteVault: null,

      priceUsd:
        safeNumber(pair.priceUsd),

      liquidityUsd:
        safeNumber(
          pair.liquidity?.usd
        ),

      source: "dexscreener",
    };

    state.dexCache.pool = result;

    state.dexCache.lastSuccessAt =
      Date.now();

    logEvent(
      "pool_found_dex",
      result
    );

    return result;
  } catch (error) {
    throw new Error(
      `Impossible de trouver le pool PumpSwap: ${error.message}`
    );
  }
}

// ============================================================
// DECODAGE DECIMALES
// ============================================================

async function getTokenDecimals(mint) {
  try {
    const result =
      await rpc("getTokenSupply", [
        mint,
      ]);

    return Number(
      result.value.decimals
    );
  } catch (error) {
    logEvent(
      "token_decimals_error",
      {
        mint,
        error: error.message,
      }
    );

    return 6;
  }
}

// ============================================================
// DEX DATA
// ============================================================

async function updateDexData() {
  if (
    !state.currentPool
  ) {
    return;
  }

  try {
    const data =
      await dexFetch(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${state.currentPool}`
      );

    const pair =
      data?.pair || null;

    if (!pair) {
      return;
    }

    state.dex.priceUsd =
      safeNumber(pair.priceUsd);

    state.dex.liquidityUsd =
      safeNumber(
        pair.liquidity?.usd
      );

    state.dex.pairAddress =
      pair.pairAddress ||
      state.currentPool;

    state.dex.updatedAt =
      Date.now();

    state.dexCache.market = {
      priceUsd: state.dex.priceUsd,
      liquidityUsd:
        state.dex.liquidityUsd,
      pairAddress:
        state.dex.pairAddress,
    };

    state.dexCache.lastSuccessAt =
      Date.now();

    logEvent(
      "dex_update",
      {
        pool: state.currentPool,
        priceUsd:
          state.dex.priceUsd,
        liquidityUsd:
          state.dex.liquidityUsd,
      }
    );
  } catch (error) {
    // --------------------------------------------------------
    // IMPORTANT :
    // Un 429 DexScreener ne doit PAS arrêter Crash Guard.
    // On conserve simplement la dernière valeur valide.
    // --------------------------------------------------------

    logEvent(
      "dex_update_failed",
      {
        pool: state.currentPool,
        error: error.message,
        cachedPriceUsd:
          state.dex.priceUsd,
        cachedLiquidityUsd:
          state.dex.liquidityUsd,
      }
    );
  }
}

// ============================================================
// WEBSOCKET SOLANA
// ============================================================

function connectWebSocket() {
  if (!state.armed) {
    return;
  }

  if (state.ws) {
    try {
      state.ws.close();
    } catch (_) {}
  }

  const socket =
    new ws(RPC_WS);

  state.ws = socket;

  socket.on("open", () => {
    logEvent(
      "websocket_connected",
      {
        mint: state.currentMint,
        pool: state.currentPool,
      }
    );

    subscribeVault(
      socket,
      "base",
      state.baseVault
    );

    subscribeVault(
      socket,
      "quote",
      state.quoteVault
    );
  });

  socket.on("message", (message) => {
    try {
      const parsed =
        JSON.parse(
          message.toString()
        );

      handleWebSocketMessage(parsed);
    } catch (error) {
      logEvent(
        "websocket_message_error",
        {
          error: error.message,
        }
      );
    }
  });

  socket.on("close", () => {
    logEvent(
      "websocket_closed"
    );

    if (state.armed) {
      setTimeout(() => {
        if (state.armed) {
          connectWebSocket();
        }
      }, 3000);
    }
  });

  socket.on("error", (error) => {
    logEvent(
      "websocket_error",
      {
        error:
          error.message,
      }
    );
  });
}

function subscribeVault(
  socket,
  type,
  address
) {
  if (!address) {
    return;
  }

  const id =
    Date.now() +
    Math.floor(
      Math.random() * 1000
    );

  state.subscriptions[id] =
    type;

  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id,

      method:
        "accountSubscribe",

      params: [
        address,

        {
          encoding: "base64",
          commitment:
            "confirmed",
        },
      ],
    })
  );
}

// ============================================================
// VAULT DECODING
// ============================================================

function decodeTokenVault(
  base64
) {
  const buffer =
    Buffer.from(
      base64,
      "base64"
    );

  // SPL Token account:
  // amount = uint64 à l'offset 64
  if (buffer.length < 72) {
    return null;
  }

  return buffer.readBigUInt64LE(64);
}

function handleWebSocketMessage(message) {
  if (
    message.method ===
    "accountNotification"
  ) {
    const subscription =
      message.params?.subscription;

    const result =
      message.params?.result;

    if (!subscription || !result) {
      return;
    }

    const type =
      state.subscriptions[
        subscription
      ];

    if (!type) {
      return;
    }

    const value =
      result.value;

    const encoded =
      value?.data?.[0];

    if (
      !encoded ||
      value?.data?.[1] !==
        "base64"
    ) {
      return;
    }

    const amount =
      decodeTokenVault(
        encoded
      );

    if (amount === null) {
      return;
    }

    if (type === "base") {
      state.vaultAmounts.base =
        amount;
    }

    if (type === "quote") {
      state.vaultAmounts.quote =
        amount;
    }
  }

  if (
    message.result &&
    typeof message.id ===
      "number"
  ) {
    const type =
      state.subscriptions[
        message.id
      ];

    if (
      type &&
      typeof message.result ===
        "number"
    ) {
      state.subscriptions[
        message.result
      ] = type;

      delete state.subscriptions[
        message.id
      ];
    }
  }
}

// ============================================================
// SNAPSHOT
// ============================================================

function createSnapshot() {
  if (
    state.vaultAmounts.base ===
      null ||
    state.vaultAmounts.quote ===
      null
  ) {
    return null;
  }

  const baseRaw =
    state.vaultAmounts.base;

  const quoteRaw =
    state.vaultAmounts.quote;

  const base =
    Number(baseRaw) /
    Math.pow(
      10,
      state.baseDecimals
    );

  const quote =
    Number(quoteRaw) /
    Math.pow(
      10,
      state.quoteDecimals
    );

  if (
    !Number.isFinite(base) ||
    !Number.isFinite(quote) ||
    base <= 0 ||
    quote <= 0
  ) {
    return null;
  }

  const timestamp =
    Date.now();

  const price =
    quote / base;

  return {
    timestamp,

    baseReserve: base,
    quoteReserve: quote,

    price,

    dexPriceUsd:
      state.dex.priceUsd,

    dexLiquidityUsd:
      state.dex.liquidityUsd,
  };
}

// ============================================================
// ANALYSE
// ============================================================

function getSnapshotAgo(
  milliseconds
) {
  if (!state.history.length) {
    return null;
  }

  const target =
    Date.now() -
    milliseconds;

  let closest = null;

  for (
    let i =
      state.history.length - 1;
    i >= 0;
    i--
  ) {
    const item =
      state.history[i];

    if (
      item.timestamp <=
      target
    ) {
      closest = item;
      break;
    }
  }

  return closest;
}

function analyzeSnapshot(
  current
) {
  const fiveSec =
    getSnapshotAgo(5000);

  const tenSec =
    getSnapshotAgo(10000);

  if (!fiveSec || !tenSec) {
    return null;
  }

  const price5s =
    pctChange(
      fiveSec.price,
      current.price
    );

  const price10s =
    pctChange(
      tenSec.price,
      current.price
    );

  const quote5s =
    pctChange(
      fiveSec.quoteReserve,
      current.quoteReserve
    );

  const quote10s =
    pctChange(
      tenSec.quoteReserve,
      current.quoteReserve
    );

  const base5s =
    pctChange(
      fiveSec.baseReserve,
      current.baseReserve
    );

  const base10s =
    pctChange(
      tenSec.baseReserve,
      current.baseReserve
    );

  return {
    price5s,
    price10s,

    quote5s,
    quote10s,

    base5s,
    base10s,

    dexPriceUsd:
      current.dexPriceUsd,

    dexLiquidityUsd:
      current.dexLiquidityUsd,
  };
}

// ============================================================
// CLASSIFICATION
// ============================================================

function classify(metrics) {
  if (!metrics) {
    return "WATCH";
  }

  // CRITICAL sticky
  if (state.criticalLatched) {
    return "CRITICAL";
  }

  const critical =
    (
      metrics.price5s !== null &&
      metrics.price5s <=
        CRITICAL_DROP_5S
    ) ||
    (
      metrics.price10s !== null &&
      metrics.price10s <=
        CRITICAL_DROP_10S
    ) ||
    (
      metrics.quote5s !== null &&
      metrics.quote5s <=
        CRITICAL_DROP_5S
    ) ||
    (
      metrics.quote10s !== null &&
      metrics.quote10s <=
        CRITICAL_DROP_10S
    ) ||
    (
      metrics.base5s !== null &&
      metrics.base5s <=
        CRITICAL_DROP_5S
    ) ||
    (
      metrics.base10s !== null &&
      metrics.base10s <=
        CRITICAL_DROP_10S
    );

  if (critical) {
    state.criticalLatched = true;

    return "CRITICAL";
  }

  const danger =
    (
      metrics.price5s !== null &&
      metrics.price5s <=
        DANGER_DROP_5S
    ) ||
    (
      metrics.price10s !== null &&
      metrics.price10s <=
        DANGER_DROP_10S
    ) ||
    (
      metrics.quote5s !== null &&
      metrics.quote5s <=
        DANGER_DROP_5S
    ) ||
    (
      metrics.quote10s !== null &&
      metrics.quote10s <=
        DANGER_DROP_10S
    ) ||
    (
      metrics.base5s !== null &&
      metrics.base5s <=
        DANGER_DROP_5S
    ) ||
    (
      metrics.base10s !== null &&
      metrics.base10s <=
        DANGER_DROP_10S
    );

  if (danger) {
    state.dangerUntil =
      Date.now() +
      DANGER_HOLD_MS;

    return "DANGER";
  }

  if (
    Date.now() <
    state.dangerUntil
  ) {
    return "DANGER";
  }

  const watch =
    (
      metrics.price5s !== null &&
      metrics.price5s <=
        WATCH_DROP_5S
    ) ||
    (
      metrics.price10s !== null &&
      metrics.price10s <=
        WATCH_DROP_10S
    ) ||
    (
      metrics.quote5s !== null &&
      metrics.quote5s <=
        WATCH_DROP_5S
    ) ||
    (
      metrics.quote10s !== null &&
      metrics.quote10s <=
        WATCH_DROP_10S
    ) ||
    (
      metrics.base5s !== null &&
      metrics.base5s <=
        WATCH_DROP_5S
    ) ||
    (
      metrics.base10s !== null &&
      metrics.base10s <=
        WATCH_DROP_10S
    );

  if (watch) {
    return "WATCH";
  }

  return "WATCH";
}

// ============================================================
// SIGNAL
// ============================================================

function buildSignal(
  level,
  metrics
) {
  state.eventId += 1;

  return {
    id:
      state.eventId,

    timestamp:
      new Date().toISOString(),

    level,

    mint:
      state.currentMint,

    pool:
      state.currentPool,

    onchain: {
      price5s:
        metrics?.price5s ?? null,

      price10s:
        metrics?.price10s ?? null,

      quote5s:
        metrics?.quote5s ?? null,

      quote10s:
        metrics?.quote10s ?? null,

      base5s:
        metrics?.base5s ?? null,

      base10s:
        metrics?.base10s ?? null,
    },

    dex: {
      priceUsd:
        state.dex.priceUsd,

      liquidityUsd:
        state.dex.liquidityUsd,

      updatedAt:
        state.dex.updatedAt,
    },
  };
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(
  text
) {
  if (
    !BOT_TOKEN ||
    !CHAT_ID
  ) {
    return;
  }

  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json",
          },

          body: JSON.stringify({
            chat_id: CHAT_ID,
            text,
            disable_web_page_preview:
              true,
          }),
        }
      );

    if (!response.ok) {
      logEvent(
        "telegram_error",
        {
          status:
            response.status,
        }
      );
    }
  } catch (error) {
    logEvent(
      "telegram_exception",
      {
        error:
          error.message,
      }
    );
  }
}

function formatPercent(value) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return "N/A";
  }

  return `${value.toFixed(2)}%`;
}

async function notifyLevel(
  signal
) {
  let emoji = "👀";

  if (signal.level === "DANGER") {
    emoji = "⚠️";
  }

  if (signal.level === "CRITICAL") {
    emoji = "🚨";
  }

  const text =
`${emoji} CRASH GUARD ${signal.level}

Token:
${signal.mint}

Pool:
${signal.pool}

On-chain 5s:
Prix ${formatPercent(signal.onchain.price5s)}
Quote ${formatPercent(signal.onchain.quote5s)}

On-chain 10s:
Prix ${formatPercent(signal.onchain.price10s)}
Quote ${formatPercent(signal.onchain.quote10s)}

DEX:
Prix ${signal.dex.priceUsd ?? "N/A"}
Liquidité ${signal.dex.liquidityUsd ?? "N/A"}

ID:
${signal.id}`;

  await sendTelegram(text);
}

// ============================================================
// COMMUNICATION V5.1
// ============================================================

async function sendSignalToV51(
  signal
) {
  if (
    !CRASH_GUARD_TARGET_URL ||
    !CRASH_GUARD_SECRET
  ) {
    logEvent(
      "v51_signal_skipped",
      {
        reason:
          "CRASH_GUARD_TARGET_URL ou CRASH_GUARD_SECRET absent",
      }
    );

    return;
  }

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      HTTP_TIMEOUT_MS
    );

  try {
    const response =
      await fetch(
        `${CRASH_GUARD_TARGET_URL}/crash-guard/event`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json",

            "x-crash-guard-secret":
              CRASH_GUARD_SECRET,
          },

          body:
            JSON.stringify(signal),

          signal:
            controller.signal,
        }
      );

    const text =
      await response.text();

    logEvent(
      "v51_signal_sent",
      {
        level:
          signal.level,

        status:
          response.status,

        response:
          text.slice(0, 500),
      }
    );
  } catch (error) {
    logEvent(
      "v51_signal_failed",
      {
        level:
          signal.level,

        error:
          error.message,
      }
    );
  } finally {
    clearTimeout(timer);
  }
}

// ============================================================
// APPLICATION DU NIVEAU
// ============================================================

async function applyLevel(
  level,
  metrics
) {
  const previous =
    state.level;

  state.level =
    level;

  // Aucun changement
  if (
    previous === level &&
    level !== "CRITICAL"
  ) {
    return;
  }

  const signal =
    buildSignal(
      level,
      metrics
    );

  state.lastSignal =
    signal;

  logEvent(
    "crash_guard_level",
    {
      previous,
      level,
      signal,
    }
  );

  // WATCH = information seulement
  if (
    level === "WATCH"
  ) {
    await notifyLevel(
      signal
    );

    return;
  }

  // DANGER = bloque les nouveaux achats
  if (
    level === "DANGER"
  ) {
    await notifyLevel(
      signal
    );

    await sendSignalToV51(
      signal
    );

    return;
  }

  // CRITICAL = bloque + sortie d'urgence
  if (
    level === "CRITICAL"
  ) {
    await notifyLevel(
      signal
    );

    await sendSignalToV51(
      signal
    );

    return;
  }
}

// ============================================================
// SAMPLE ON-CHAIN
// ============================================================

async function sampleOnChain() {
  if (!state.armed) {
    return;
  }

  const snapshot =
    createSnapshot();

  if (!snapshot) {
    return;
  }

  state.history.push(
    snapshot
  );

  while (
    state.history.length >
    HISTORY_MAX
  ) {
    state.history.shift();
  }

  const metrics =
    analyzeSnapshot(
      snapshot
    );

  if (!metrics) {
    return;
  }

  const level =
    classify(metrics);

  await applyLevel(
    level,
    metrics
  );
}

// ============================================================
// ARM
// ============================================================

async function arm(mint) {
  if (!mint) {
    throw new Error(
      "Mint manquant"
    );
  }

  // Désarme proprement avant de réarmer
  if (state.armed) {
    await disarm();
  }

  logEvent(
    "arm_start",
    {
      mint,
    }
  );

  // ----------------------------------------------------------
  // Recherche du pool
  // ----------------------------------------------------------

  const pool =
    await findPumpSwapPool(
      mint
    );

  if (!pool) {
    throw new Error(
      "Aucun pool PumpSwap trouvé"
    );
  }

  // Crash Guard surveille actuellement
  // les pools SOL-quoted.
  if (
    pool.quoteMint &&
    pool.quoteMint !== SOL_MINT
  ) {
    throw new Error(
      `Pool trouvé mais quoteMint non-SOL: ${pool.quoteMint}`
    );
  }

  state.currentMint =
    mint;

  state.currentPool =
    pool.pool;

  // ----------------------------------------------------------
  // On récupère les données Pool directement on-chain
  // ----------------------------------------------------------

  const accountInfo =
    await rpc(
      "getAccountInfo",
      [
        state.currentPool,
        {
          encoding: "base64",
        },
      ]
    );

  if (
    !accountInfo ||
    !accountInfo.value
  ) {
    throw new Error(
      "Compte Pool introuvable on-chain"
    );
  }

  const poolData =
    Buffer.from(
      accountInfo.value.data[0],
      "base64"
    );

  const decoded =
    decodePoolAccount(
      poolData
    );

  state.baseMint =
    decoded.baseMint;

  state.quoteMint =
    decoded.quoteMint;

  state.baseVault =
    decoded.baseVault;

  state.quoteVault =
    decoded.quoteVault;

  // ----------------------------------------------------------
  // Vérification orientation
  // ----------------------------------------------------------

  if (
    state.baseMint !==
      mint &&
    state.quoteMint !==
      mint
  ) {
    throw new Error(
      "Le pool trouvé ne correspond pas au mint demandé"
    );
  }

  if (
    state.quoteMint !==
    SOL_MINT
  ) {
    throw new Error(
      `Le pool n'est pas SOL-quoted. quoteMint=${state.quoteMint}`
    );
  }

  // ----------------------------------------------------------
  // Décimales
  // ----------------------------------------------------------

  state.baseDecimals =
    await getTokenDecimals(
      state.baseMint
    );

  state.quoteDecimals = 9;

  // ----------------------------------------------------------
  // RESET
  // ----------------------------------------------------------

  state.vaultAmounts = {
    base: null,
    quote: null,
  };

  state.history = [];

  state.level =
    "WATCH";

  state.dangerUntil =
    0;

  state.criticalLatched =
    false;

  state.lastSignal =
    null;

  state.subscriptions =
    {};

  state.dex = {
    priceUsd:
      pool.priceUsd ?? null,

    liquidityUsd:
      pool.liquidityUsd ?? null,

    pairAddress:
      pool.pool,

    updatedAt:
      pool.priceUsd ||
      pool.liquidityUsd
        ? Date.now()
        : 0,
  };

  state.armed =
    true;

  // ----------------------------------------------------------
  // LOG
  // ----------------------------------------------------------

  logEvent(
    "armed",
    {
      mint:
        state.currentMint,

      pool:
        state.currentPool,

      baseMint:
        state.baseMint,

      quoteMint:
        state.quoteMint,

      baseVault:
        state.baseVault,

      quoteVault:
        state.quoteVault,

      baseDecimals:
        state.baseDecimals,

      quoteDecimals:
        state.quoteDecimals,

      poolSource:
        pool.source,
    }
  );

  // ----------------------------------------------------------
  // WEBSOCKET
  // ----------------------------------------------------------

  connectWebSocket();

  // ----------------------------------------------------------
  // DEX initial
  //
  // IMPORTANT :
  // cette opération est NON BLOQUANTE.
  // Un 429 ne bloque donc plus /starttrade.
  // ----------------------------------------------------------

  await updateDexData();

  // ----------------------------------------------------------
  // TIMERS
  // ----------------------------------------------------------

  state.timers.sample =
    setInterval(
      () => {
        sampleOnChain()
          .catch((error) => {
            logEvent(
              "sample_error",
              {
                error:
                  error.message,
              }
            );
          });
      },
      SAMPLE_INTERVAL_MS
    );

  state.timers.dex =
    setInterval(
      () => {
        updateDexData()
          .catch((error) => {
            logEvent(
              "dex_timer_error",
              {
                error:
                  error.message,
              }
            );
          });
      },
      DEX_REFRESH_INTERVAL_MS
    );

  return {
    ok: true,

    mint:
      state.currentMint,

    pool:
      state.currentPool,

    poolSource:
      pool.source,

    baseMint:
      state.baseMint,

    quoteMint:
      state.quoteMint,
  };
}

// ============================================================
// DISARM
// ============================================================

async function disarm() {
  state.armed =
    false;

  if (
    state.timers.sample
  ) {
    clearInterval(
      state.timers.sample
    );

    state.timers.sample =
      null;
  }

  if (
    state.timers.dex
  ) {
    clearInterval(
      state.timers.dex
    );

    state.timers.dex =
      null;
  }

  if (state.ws) {
    try {
      state.ws.close();
    } catch (_) {}
  }

  state.ws =
    null;

  state.subscriptions =
    {};

  state.history =
    [];

  state.vaultAmounts = {
    base: null,
    quote: null,
  };

  state.currentMint =
    null;

  state.currentPool =
    null;

  state.baseMint =
    null;

  state.quoteMint =
    null;

  state.baseVault =
    null;

  state.quoteVault =
    null;

  state.level =
    "WATCH";

  state.dangerUntil =
    0;

  state.criticalLatched =
    false;

  state.lastSignal =
    null;

  logEvent(
    "disarmed"
  );

  return {
    ok: true,
  };
}

// ============================================================
// HTTP SERVER
// ============================================================

function authorized(req) {
  if (!CRASH_GUARD_SECRET) {
    return false;
  }

  const provided =
    req.headers[
      "x-crash-guard-secret"
    ];

  return (
    typeof provided ===
      "string" &&
    provided ===
      CRASH_GUARD_SECRET
  );
}

function sendJson(
  res,
  status,
  body
) {
  res.writeHead(
    status,
    {
      "content-type":
        "application/json; charset=utf-8",
    }
  );

  res.end(
    JSON.stringify(body)
  );
}

function readBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        (chunk) => {
          body += chunk;

          if (
            body.length >
            100000
          ) {
            reject(
              new Error(
                "Body trop volumineux"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {
          try {
            resolve(
              body
                ? JSON.parse(body)
                : {}
            );
          } catch (error) {
            reject(
              new Error(
                "JSON invalide"
              )
            );
          }
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

const server =
  http.createServer(
    async (req, res) => {
      try {
        // ------------------------------------------------------
        // HEALTH
        // ------------------------------------------------------

        if (
          req.method === "GET" &&
          req.url === "/health"
        ) {
          return sendJson(
            res,
            200,
            {
              ok: true,

              armed:
                state.armed,

              level:
                state.level,

              mint:
                state.currentMint,

              pool:
                state.currentPool,
            }
          );
        }

        // ------------------------------------------------------
        // STATE
        // ------------------------------------------------------

        if (
          req.method === "GET" &&
          req.url === "/state"
        ) {
          if (
            !authorized(req)
          ) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized",
              }
            );
          }

          return sendJson(
            res,
            200,
            {
              ok: true,

              armed:
                state.armed,

              mint:
                state.currentMint,

              pool:
                state.currentPool,

              level:
                state.level,

              criticalLatched:
                state.criticalLatched,

              dangerUntil:
                state.dangerUntil,

              lastSignal:
                state.lastSignal,

              dex:
                state.dex,

              historyLength:
                state.history.length,
            }
          );
        }

        // ------------------------------------------------------
        // DISARM
        // ------------------------------------------------------

        if (
          req.method === "POST" &&
          req.url === "/disarm"
        ) {
          if (
            !authorized(req)
          ) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized",
              }
            );
          }

          await disarm();

          return sendJson(
            res,
            200,
            {
              ok: true,
            }
          );
        }

        // ------------------------------------------------------
        // ARM
        // ------------------------------------------------------

        if (
          req.method === "POST" &&
          req.url === "/arm"
        ) {
          if (
            !authorized(req)
          ) {
            return sendJson(
              res,
              401,
              {
                ok: false,
                error:
                  "Unauthorized",
              }
            );
          }

          const body =
            await readBody(req);

          if (
            !body.mint
          ) {
            return sendJson(
              res,
              400,
              {
                ok: false,
                error:
                  "mint manquant",
              }
            );
          }

          try {
            const result =
              await arm(
                body.mint
              );

            return sendJson(
              res,
              200,
              result
            );
          } catch (error) {
            logEvent(
              "arm_failed",
              {
                mint:
                  body.mint,

                error:
                  error.message,
              }
            );

            return sendJson(
              res,
              500,
              {
                ok: false,
                error:
                  error.message,
              }
            );
          }
        }

        // ------------------------------------------------------
        // 404
        // ------------------------------------------------------

        return sendJson(
          res,
          404,
          {
            ok: false,
            error:
              "Not found",
          }
        );
      } catch (error) {
        logEvent(
          "http_error",
          {
            error:
              error.message,
          }
        );

        return sendJson(
          res,
          500,
          {
            ok: false,
            error:
              error.message,
          }
        );
      }
    }
  );

// ============================================================
// START
// ============================================================

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `🛡️ Crash Guard démarré sur le port ${PORT}`
    );

    console.log(
      `RPC HTTP: ${RPC_HTTP}`
    );

    console.log(
      `RPC WS: ${RPC_WS}`
    );

    console.log(
      `PumpSwap: ${PUMPSWAP_PROGRAM_ID}`
    );
  }
);

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown(
  signal
) {
  logEvent(
    "shutdown",
    {
      signal,
    }
  );

  try {
    await disarm();
  } catch (_) {}

  server.close(
    () => {
      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(0);
    },
    3000
  );
}

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);
