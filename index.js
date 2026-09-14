const { Telegraf } = require("telegraf");
const WebSocket = require("ws");
const https = require("https");

// ============================================================
// CONFIG
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  console.error("❌ Variables manquantes : BOT_TOKEN / CHAT_ID / HELIUS_API_KEY");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// PumpSwap
const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

// Pool account offsets
const BASE_VAULT_OFFSET = 139;
const QUOTE_VAULT_OFFSET = 171;
const VIRTUAL_QUOTE_OFFSET = 245;

// SPL token account amount offset
const SPL_AMOUNT_OFFSET = 64;

// Timing
const DEX_INTERVAL_MS = 2000;
const BATCH_MS = 100;

const HISTORY_MS = 120000;

const EARLY_WINDOW_MS = 30000;
const PRECRASH_WINDOW_MS = 15000;

const ALERT_COOLDOWN_PRE = 45000;
const ALERT_COOLDOWN_EXIT = 30000;
const ALERT_COOLDOWN_CRITICAL = 15000;

// ============================================================
// STATE
// ============================================================

let watching = false;
let stopped = false;

let mint = null;

let poolAddress = null;
let baseVault = null;
let quoteVault = null;

let ws = null;

let dexTimer = null;
let reconnectTimer = null;

let baseSub = null;
let quoteSub = null;
let poolSub = null;

let rpcId = 1;

let current = {
  price: null,
  liquidity: null,

  baseRaw: null,
  quoteRaw: null,
  virtualQuoteRaw: 0n,
  effectiveQuoteRaw: null,

  updatedAt: 0
};

let previousVault = {
  base: null,
  quote: null,
  effectiveQuote: null,
  timestamp: 0
};

let histories = {
  reserve: [],
  price: [],
  liquidity: [],

  sell: [],
  buy: [],

  withdrawals: [],
  additions: []
};

let pendingVaultChanges = {
  base: null,
  quote: null
};

let lastInstruction = {
  type: null,
  timestamp: 0,
  slot: null,
  signature: null
};

let highPrice = null;

let riskState = "NORMAL";

let lastAlert = {
  type: null,
  timestamp: 0
};

let lastCriticalReason = null;

// ============================================================
// HELPERS
// ============================================================

function now() {
  return Date.now();
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function lamportsToSol(v) {
  if (v === null || v === undefined) return 0;
  return Number(v) / 1e9;
}

function safeNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return Number(v || 0);
}

function trimHistory(arr) {
  const cutoff = now() - HISTORY_MS;

  while (arr.length && arr[0].timestamp < cutoff) {
    arr.shift();
  }
}

function addHistory(arr, value) {
  arr.push({
    timestamp: now(),
    value
  });

  trimHistory(arr);
}

function valueAtOrBefore(arr, timestamp) {
  if (!arr.length) return null;

  let result = null;

  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].timestamp <= timestamp) {
      result = arr[i].value;
      break;
    }
  }

  return result;
}

function percentChange(arr, seconds) {
  const currentValue = arr.length
    ? arr[arr.length - 1].value
    : null;

  if (currentValue === null || currentValue === undefined) {
    return null;
  }

  const oldValue = valueAtOrBefore(
    arr,
    now() - seconds * 1000
  );

  if (
    oldValue === null ||
    oldValue === undefined ||
    oldValue === 0
  ) {
    return null;
  }

  return ((currentValue - oldValue) / oldValue) * 100;
}

function sumWindow(arr, seconds) {
  const cutoff = now() - seconds * 1000;

  let total = 0;

  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].timestamp < cutoff) break;
    total += arr[i].value;
  }

  return total;
}

function countWindow(arr, seconds) {
  const cutoff = now() - seconds * 1000;

  let count = 0;

  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i].timestamp < cutoff) break;
    count++;
  }

  return count;
}

function formatPct(v) {
  if (v === null || v === undefined) return "N/A";

  const sign = v > 0 ? "+" : "";

  return `${sign}${v.toFixed(1)}%`;
}

function formatUsd(v) {
  if (v === null || v === undefined) return "N/A";

  return `$${Number(v).toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4
  })}`;
}

function formatLiquidity(v) {
  if (v === null || v === undefined) return "N/A";

  return `$${Number(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

// ============================================================
// BIGINT PARSING
// ============================================================

function readU64LE(buffer, offset) {
  if (!buffer || buffer.length < offset + 8) return null;

  return buffer.readBigUInt64LE(offset);
}

function readI128LE(buffer, offset) {
  if (!buffer || buffer.length < offset + 16) return 0n;

  const lo = buffer.readBigUInt64LE(offset);
  const hi = buffer.readBigInt64LE(offset + 8);

  return (hi << 64n) + BigInt(lo);
}

function readSplTokenAccountAmount(data) {
  if (!data) return null;

  let buffer = null;

  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (typeof data === "string") {
    try {
      buffer = Buffer.from(data, "base64");
    } catch {
      return null;
    }
  } else if (Array.isArray(data) && typeof data[0] === "string") {
    try {
      buffer = Buffer.from(data[0], "base64");
    } catch {
      return null;
    }
  }

  if (!buffer || buffer.length < SPL_AMOUNT_OFFSET + 8) {
    return null;
  }

  return readU64LE(buffer, SPL_AMOUNT_OFFSET);
}

// ============================================================
// POOL PARSING
// ============================================================

function parsePoolData(data) {
  if (!data) return null;

  let buffer = null;

  if (Buffer.isBuffer(data)) {
    buffer = data;
  } else if (typeof data === "string") {
    try {
      buffer = Buffer.from(data, "base64");
    } catch {
      return null;
    }
  } else if (Array.isArray(data) && typeof data[0] === "string") {
    try {
      buffer = Buffer.from(data[0], "base64");
    } catch {
      return null;
    }
  }

  if (!buffer) return null;

  if (buffer.length < 253) return null;

  const base = readU64LE(buffer, BASE_VAULT_OFFSET);
  const quote = readU64LE(buffer, QUOTE_VAULT_OFFSET);

  let virtualQuote = 0n;

  if (buffer.length >= VIRTUAL_QUOTE_OFFSET + 16) {
    virtualQuote = readI128LE(
      buffer,
      VIRTUAL_QUOTE_OFFSET
    );
  }

  return {
    base,
    quote,
    virtualQuote
  };
}

// ============================================================
// RPC
// ============================================================

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method,
      params
    });

    const req = https.request(
      RPC_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      res => {
        let data = "";

        res.on("data", chunk => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);

            if (parsed.error) {
              reject(
                new Error(
                  parsed.error.message ||
                  JSON.stringify(parsed.error)
                )
              );
              return;
            }

            resolve(parsed.result);
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on("error", reject);

    req.write(body);
    req.end();
  });
}

// ============================================================
// DEXSCREENER
// ============================================================

async function fetchDex() {
  if (!mint) return null;

  try {
    const url =
      `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

    const response = await fetch(url);

    if (!response.ok) return null;

    const pairs = await response.json();

    if (!Array.isArray(pairs)) return null;

    const pumpPairs = pairs.filter(p => {
      return (
        String(p.dexId || "").toLowerCase() === "pumpswap"
      );
    });

    const selected =
      pumpPairs[0] ||
      pairs[0];

    if (!selected) return null;

    return {
      price: Number(selected.priceUsd || 0),
      liquidity: Number(
        selected.liquidity?.usd || 0
      ),
      pairAddress:
        selected.pairAddress || null
    };
  } catch (e) {
    console.log("DexScreener:", e.message);
    return null;
  }
}

// ============================================================
// DISCOVER POOL
// ============================================================

async function discoverPool() {
  const dex = await fetchDex();

  if (!dex || !dex.pairAddress) {
    throw new Error(
      "Impossible de trouver le pool PumpSwap."
    );
  }

  poolAddress = dex.pairAddress;

  console.log("🏊 Pool trouvé :", poolAddress);

  const account = await rpc(
    "getAccountInfo",
    [
      poolAddress,
      {
        encoding: "base64",
        commitment: "processed"
      }
    ]
  );

  if (!account || !account.value) {
    throw new Error(
      "Impossible de lire le compte du pool."
    );
  }

  const parsed = parsePoolData(
    account.value.data
  );

  if (!parsed) {
    throw new Error(
      "Impossible de parser le pool PumpSwap."
    );
  }

  current.baseRaw = parsed.base;
  current.quoteRaw = parsed.quote;
  current.virtualQuoteRaw = parsed.virtualQuote;

  current.effectiveQuoteRaw =
    parsed.quote + parsed.virtualQuote;

  const baseVaultAccount =
    await rpc(
      "getAccountInfo",
      [
        poolAddress,
        {
          encoding: "base64",
          commitment: "processed"
        }
      ]
    );

  if (!baseVaultAccount) {
    throw new Error("Erreur lecture pool.");
  }

  // Les vaults sont stockés dans le compte Pool
  // à leurs offsets respectifs.
  const poolData = parsePoolData(
    baseVaultAccount.value.data
  );

  if (!poolData) {
    throw new Error("Pool data invalide.");
  }

  // Pour obtenir les pubkeys des vaults,
  // on lit directement le compte Pool.
  const rawData =
    Buffer.from(
      poolDataBuffer(
        baseVaultAccount.value.data
      ),
      "base64"
    );

  baseVault =
    rawData
      .subarray(139, 171)
      .toString("base64");

  // Cette partie est remplacée juste après
  // par la lecture correcte des pubkeys.
}

// ============================================================
// POOL BUFFER HELPER
// ============================================================

function poolDataBuffer(data) {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return data[0];
  }

  return null;
}

// ============================================================
// CORRECT POOL DISCOVERY
// ============================================================

async function loadPool() {
  const dex = await fetchDex();

  if (!dex || !dex.pairAddress) {
    throw new Error(
      "Pool PumpSwap introuvable."
    );
  }

  poolAddress = dex.pairAddress;

  console.log(
    "🏊 PumpSwap pool :",
    poolAddress
  );

  const account = await rpc(
    "getAccountInfo",
    [
      poolAddress,
      {
        encoding: "base64",
        commitment: "processed"
      }
    ]
  );

  if (!account?.value?.data) {
    throw new Error(
      "Impossible de lire le compte Pool."
    );
  }

  const encoded =
    Array.isArray(account.value.data)
      ? account.value.data[0]
      : account.value.data;

  const buffer =
    Buffer.from(encoded, "base64");

  if (buffer.length < 245) {
    throw new Error(
      "Compte Pool trop court."
    );
  }

  baseVault =
    new (require("@solana/web3.js").PublicKey)(
      buffer.subarray(43, 75)
    ).toBase58();

  quoteVault =
    new (require("@solana/web3.js").PublicKey)(
      buffer.subarray(75, 107)
    ).toBase58();

  const baseRaw =
    readU64LE(
      buffer,
      BASE_VAULT_OFFSET
    );

  const quoteRaw =
    readU64LE(
      buffer,
      QUOTE_VAULT_OFFSET
    );

  const virtualQuote =
    buffer.length >= VIRTUAL_QUOTE_OFFSET + 16
      ? readI128LE(
          buffer,
          VIRTUAL_QUOTE_OFFSET
        )
      : 0n;

  current.baseRaw = baseRaw;
  current.quoteRaw = quoteRaw;
  current.virtualQuoteRaw = virtualQuote;

  current.effectiveQuoteRaw =
    quoteRaw + virtualQuote;

  console.log(
    "🪙 Base vault :",
    baseVault
  );

  console.log(
    "💧 Quote vault :",
    quoteVault
  );

  console.log(
    "💰 Réserve effective :",
    lamportsToSol(
      current.effectiveQuoteRaw
    ),
    "SOL"
  );
}

// ============================================================
// HISTORY INITIALIZATION
// ============================================================

function resetHistory() {
  histories = {
    reserve: [],
    price: [],
    liquidity: [],
    sell: [],
    buy: [],
    withdrawals: [],
    additions: []
  };

  highPrice = null;

  riskState = "NORMAL";

  lastAlert = {
    type: null,
    timestamp: 0
  };

  lastCriticalReason = null;
}

// ============================================================
// DEX UPDATE
// ============================================================

async function updateMarket() {
  if (!watching || stopped) return;

  const dex = await fetchDex();

  if (!dex) return;

  if (dex.price > 0) {
    current.price = dex.price;

    if (
      highPrice === null ||
      dex.price > highPrice
    ) {
      highPrice = dex.price;
    }

    addHistory(
      histories.price,
      dex.price
    );
  }

  if (dex.liquidity > 0) {
    current.liquidity =
      dex.liquidity;

    addHistory(
      histories.liquidity,
      dex.liquidity
    );
  }

  if (
    current.effectiveQuoteRaw !== null
  ) {
    addHistory(
      histories.reserve,
      lamportsToSol(
        current.effectiveQuoteRaw
      )
    );
  }

  evaluateRisk("MARKET");
}

// ============================================================
// VAULT READING
// ============================================================

async function readVaultAmount(address) {
  const result = await rpc(
    "getAccountInfo",
    [
      address,
      {
        encoding: "base64",
        commitment: "processed"
      }
    ]
  );

  if (!result?.value?.data) {
    return null;
  }

  return readSplTokenAccountAmount(
    result.value.data
  );
}

async function initializeVaults() {
  const base = await readVaultAmount(
    baseVault
  );

  const quote = await readVaultAmount(
    quoteVault
  );

  if (base !== null) {
    current.baseRaw = base;
  }

  if (quote !== null) {
    current.quoteRaw = quote;
  }

  current.effectiveQuoteRaw =
    current.quoteRaw +
    current.virtualQuoteRaw;

  previousVault = {
    base: current.baseRaw,
    quote: current.quoteRaw,
    effectiveQuote:
      current.effectiveQuoteRaw,
    timestamp: now()
  };

  addHistory(
    histories.reserve,
    lamportsToSol(
      current.effectiveQuoteRaw
    )
  );
}

// ============================================================
// WEBSOCKET
// ============================================================

function wsSend(payload) {
  if (!ws) return;

  if (
    ws.readyState !==
    WebSocket.OPEN
  ) {
    return;
  }

  ws.send(
    JSON.stringify(payload)
  );
}

function subscribeAccounts() {
  if (!ws) return;

  wsSend({
    jsonrpc: "2.0",
    id: rpcId++,
    method: "accountSubscribe",
    params: [
      baseVault,
      {
        encoding: "base64",
        commitment: "processed"
      }
    ]
  });

  wsSend({
    jsonrpc: "2.0",
    id: rpcId++,
    method: "accountSubscribe",
    params: [
      quoteVault,
      {
        encoding: "base64",
        commitment: "processed"
      }
    ]
  });

  wsSend({
    jsonrpc: "2.0",
    id: rpcId++,
    method: "logsSubscribe",
    params: [
      {
        mentions: [
          poolAddress
        ]
      },
      {
        commitment: "processed"
      }
    ]
  });
}

function connectWebSocket() {
  if (stopped) return;

  try {
    if (ws) {
      try {
        ws.close();
      } catch {}
    }

    ws = new WebSocket(
      WS_URL
    );

    ws.on("open", () => {
      console.log(
        "🟢 WebSocket V7 connecté"
      );

      subscribeAccounts();
    });

    ws.on("message", raw => {
      try {
        const msg =
          JSON.parse(
            raw.toString()
          );

        // Subscription response
        if (
          msg.id &&
          typeof msg.result === "number"
        ) {
          if (
            !baseSub &&
            msg.result
          ) {
            if (!baseSub) {
              baseSub =
                msg.result;
            } else if (
              !quoteSub
            ) {
              quoteSub =
                msg.result;
            } else {
              poolSub =
                msg.result;
            }
          }

          return;
        }

        // Account notification
        if (
          msg.method ===
          "accountNotification"
        ) {
          const value =
            msg.params?.result?.value;

          const subscription =
            msg.params?.subscription;

          const amount =
            readSplTokenAccountAmount(
              value?.data
            );

          if (amount === null) {
            return;
          }

          if (
            subscription ===
            baseSub
          ) {
            pendingVaultChanges.base =
              amount;
          }

          if (
            subscription ===
            quoteSub
          ) {
            pendingVaultChanges.quote =
              amount;
          }

          return;
        }

        // Pool logs
        if (
          msg.method ===
          "logsNotification"
        ) {
          const value =
            msg.params?.result?.value;

          const logs =
            value?.logs || [];

          const signature =
            value?.signature || null;

          const slot =
            msg.params?.result?.context
              ?.slot || null;

          const text =
            logs.join(" ");

          if (
            /Instruction: Sell/i.test(
              text
            )
          ) {
            lastInstruction = {
              type: "SELL",
              timestamp: now(),
              slot,
              signature
            };
          } else if (
            /Instruction: Buy/i.test(
              text
            )
          ) {
            lastInstruction = {
              type: "BUY",
              timestamp: now(),
              slot,
              signature
            };
          } else if (
            /Instruction: Withdraw/i.test(
              text
            )
          ) {
            lastInstruction = {
              type: "WITHDRAW",
              timestamp: now(),
              slot,
              signature
            };
          } else if (
            /Instruction: Deposit/i.test(
              text
            )
          ) {
            lastInstruction = {
              type: "DEPOSIT",
              timestamp: now(),
              slot,
              signature
            };
          }
        }

      } catch (e) {
        console.log(
          "WS message error:",
          e.message
        );
      }
    });

    ws.on("close", () => {
      console.log(
        "🔴 WebSocket fermé"
      );

      if (
        watching &&
        !stopped
      ) {
        clearTimeout(
          reconnectTimer
        );

        reconnectTimer =
          setTimeout(
            connectWebSocket,
            1500
          );
      }
    });

    ws.on("error", err => {
      console.log(
        "WS error:",
        err.message
      );
    });

  } catch (e) {
    console.log(
      "WS connection:",
      e.message
    );
  }
}

// ============================================================
// VAULT BATCH
// ============================================================

function flushVaultBatch() {
  if (!watching || stopped) return;

  const newBase =
    pendingVaultChanges.base;

  const newQuote =
    pendingVaultChanges.quote;

  pendingVaultChanges.base = null;
  pendingVaultChanges.quote = null;

  if (
    newBase === null &&
    newQuote === null
  ) {
    return;
  }

  const oldBase =
    current.baseRaw;

  const oldQuote =
    current.quoteRaw;

  if (
    newBase !== null
  ) {
    current.baseRaw =
      newBase;
  }

  if (
    newQuote !== null
  ) {
    current.quoteRaw =
      newQuote;
  }

  current.effectiveQuoteRaw =
    current.quoteRaw +
    current.virtualQuoteRaw;

  const baseDelta =
    oldBase === null ||
    oldBase === undefined ||
    newBase === null
      ? 0n
      : newBase - oldBase;

  const quoteDelta =
    oldQuote === null ||
    oldQuote === undefined ||
    newQuote === null
      ? 0n
      : newQuote - oldQuote;

  const quoteSol =
    Math.abs(
      lamportsToSol(
        quoteDelta
      )
    );

  const effectiveReserveSol =
    lamportsToSol(
      current.effectiveQuoteRaw
    );

  addHistory(
    histories.reserve,
    effectiveReserveSol
  );

  // ----------------------------------------------------------
  // Event classification
  // ----------------------------------------------------------

  const minEventSol = 0.01;

  let eventType = null;

  if (
    lastInstruction.timestamp >
    now() - 1500
  ) {
    eventType =
      lastInstruction.type;
  }

  // SELL
  if (
    eventType === "SELL" ||
    (
      baseDelta < 0n &&
      quoteDelta > 0n &&
      quoteSol >= minEventSol
    )
  ) {
    if (quoteSol >= minEventSol) {
      addHistory(
        histories.sell,
        quoteSol
      );
    }
  }

  // BUY
  else if (
    eventType === "BUY" ||
    (
      baseDelta > 0n &&
      quoteDelta < 0n &&
      quoteSol >= minEventSol
    )
  ) {
    if (quoteSol >= minEventSol) {
      addHistory(
        histories.buy,
        quoteSol
      );
    }
  }

  // WITHDRAW
  else if (
    eventType === "WITHDRAW" ||
    (
      baseDelta < 0n &&
      quoteDelta < 0n &&
      quoteSol >= minEventSol
    )
  ) {
    if (quoteSol >= minEventSol) {
      addHistory(
        histories.withdrawals,
        quoteSol
      );
    }
  }

  // DEPOSIT
  else if (
    eventType === "DEPOSIT" ||
    (
      baseDelta > 0n &&
      quoteDelta > 0n &&
      quoteSol >= minEventSol
    )
  ) {
    if (quoteSol >= minEventSol) {
      addHistory(
        histories.additions,
        quoteSol
      );
    }
  }

  previousVault = {
    base: current.baseRaw,
    quote: current.quoteRaw,
    effectiveQuote:
      current.effectiveQuoteRaw,
    timestamp: now()
  };

  // Important :
  // on ne fait PAS confiance uniquement
  // au gros choc de réserve.
  // On cherche une dégradation progressive.
  evaluateRisk("ONCHAIN");
}

// ============================================================
// RISK ENGINE V7
// ============================================================

function calculateRisk() {
  let score = 0;

  const signals = [];

  const reserve5 =
    percentChange(
      histories.reserve,
      5
    );

  const reserve10 =
    percentChange(
      histories.reserve,
      10
    );

  const reserve20 =
    percentChange(
      histories.reserve,
      20
    );

  const reserve30 =
    percentChange(
      histories.reserve,
      30
    );

  const price5 =
    percentChange(
      histories.price,
      5
    );

  const price10 =
    percentChange(
      histories.price,
      10
    );

  const price20 =
    percentChange(
      histories.price,
      20
    );

  const price30 =
    percentChange(
      histories.price,
      30
    );

  const liquidity10 =
    percentChange(
      histories.liquidity,
      10
    );

  const liquidity30 =
    percentChange(
      histories.liquidity,
      30
    );

  const sell5 =
    sumWindow(
      histories.sell,
      5
    );

  const sell10 =
    sumWindow(
      histories.sell,
      10
    );

  const sell20 =
    sumWindow(
      histories.sell,
      20
    );

  const sell30 =
    sumWindow(
      histories.sell,
      30
    );

  const buy10 =
    sumWindow(
      histories.buy,
      10
    );

  const sellCount10 =
    countWindow(
      histories.sell,
      10
    );

  const sellCount30 =
    countWindow(
      histories.sell,
      30
    );

  const withdrawal10 =
    sumWindow(
      histories.withdrawals,
      10
    );

  const withdrawal30 =
    sumWindow(
      histories.withdrawals,
      30
    );

  // ----------------------------------------------------------
  // 1. SELL PRESSURE
  // ----------------------------------------------------------

  const totalFlow10 =
    sell10 + buy10;

  const sellRatio10 =
    totalFlow10 > 0
      ? (sell10 / totalFlow10) * 100
      : 0;

  // Les ventes seules ne suffisent PAS.
  if (
    sellRatio10 >= 75 &&
    sell10 >= 1.0
  ) {
    score += 6;

    signals.push(
      "pression vendeuse confirmée"
    );
  }

  if (
    sellRatio10 >= 85 &&
    sell10 >= 2.5
  ) {
    score += 6;

    signals.push(
      "pression vendeuse persistante"
    );
  }

  // Accélération
  if (
    sell20 >= 1 &&
    sell10 >= sell20 * 0.65
  ) {
    score += 5;

    signals.push(
      "accélération des ventes"
    );
  }

  // Beaucoup de petits événements sans volume
  // ne doivent plus déclencher l'alarme.
  if (
    sellCount10 >= 5 &&
    sell10 >= 1
  ) {
    score += 3;
  }

  // ----------------------------------------------------------
  // 2. MOMENTUM / PRICE FAILURE
  // ----------------------------------------------------------

  const drawdown =
    highPrice &&
    current.price
      ? ((current.price - highPrice) /
          highPrice) *
        100
      : 0;

  // Essoufflement léger
  if (
    price20 !== null &&
    price20 < -1.5 &&
    sell10 >= 0.5
  ) {
    score += 8;

    signals.push(
      "prix qui commence à céder"
    );
  }

  // Dégradation plus nette
  if (
    price10 !== null &&
    price10 < -3 &&
    sell10 >= 1
  ) {
    score += 10;

    signals.push(
      "cassure du momentum"
    );
  }

  // Le prix reste proche du sommet
  // mais les ventes deviennent fortes.
  // Cela peut être un signal précoce.
  if (
    drawdown > -1 &&
    sell20 >= 3 &&
    sellRatio10 >= 70
  ) {
    score += 5;

    signals.push(
      "ventes absorbées mais pression croissante"
    );
  }

  // ----------------------------------------------------------
  // 3. RESERVE TREND
  // ----------------------------------------------------------

  // Petite baisse progressive
  if (
    reserve30 !== null &&
    reserve30 <= -2 &&
    reserve30 > -5
  ) {
    score += 5;

    signals.push(
      "réserve en baisse progressive"
    );
  }

  // Dégradation intermédiaire
  if (
    reserve20 !== null &&
    reserve20 <= -4 &&
    reserve20 > -10
  ) {
    score += 10;

    signals.push(
      "dégradation de réserve"
    );
  }

  // Forte sortie
  if (
    reserve10 !== null &&
    reserve10 <= -8 &&
    reserve10 > -15
  ) {
    score += 15;

    signals.push(
      "sortie importante de réserve"
    );
  }

  // Très gros choc
  if (
    reserve10 !== null &&
    reserve10 <= -15
  ) {
    score += 10;

    signals.push(
      "choc de réserve"
    );
  }

  // ----------------------------------------------------------
  // 4. LIQUIDITY
  // ----------------------------------------------------------

  if (
    liquidity30 !== null &&
    liquidity30 < -3
  ) {
    score += 6;

    signals.push(
      "liquidité en baisse"
    );
  }

  if (
    liquidity10 !== null &&
    liquidity10 < -8
  ) {
    score += 12;

    signals.push(
      "liquidité en forte baisse"
    );
  }

  // ----------------------------------------------------------
  // 5. WITHDRAWALS
  // ----------------------------------------------------------

  if (
    withdrawal30 >= 1
  ) {
    score += 10;

    signals.push(
      "retrait de liquidité détecté"
    );
  }

  if (
    withdrawal10 >= 3
  ) {
    score += 15;

    signals.push(
      "retrait important de liquidité"
    );
  }

  // ----------------------------------------------------------
  // 6. CONFLUENCE
  // ----------------------------------------------------------

  const negativeFactors = [
    reserve20 !== null &&
      reserve20 < -2,

    price20 !== null &&
      price20 < -1,

    liquidity30 !== null &&
      liquidity30 < -2,

    sellRatio10 >= 70 &&
      sell10 >= 1,

    withdrawal30 >= 1
  ].filter(Boolean).length;

  if (
    negativeFactors >= 3
  ) {
    score += 12;

    signals.push(
      "confluence de plusieurs signaux"
    );
  }

  // ----------------------------------------------------------
  // 7. ABSORPTION CHECK
  // ----------------------------------------------------------

  // Si le prix monte encore franchement,
  // la réserve peut bouger sans que le token
  // soit immédiatement en train de mourir.
  if (
    price20 !== null &&
    price20 > 3 &&
    drawdown > -1
  ) {
    score -= 8;
  }

  if (
    price30 !== null &&
    price30 > 5 &&
    liquidity30 !== null &&
    liquidity30 > 0
  ) {
    score -= 8;
  }

  return {
    score: clamp(
      Math.round(score),
      0,
      100
    ),

    signals,

    metrics: {
      reserve5,
      reserve10,
      reserve20,
      reserve30,

      price5,
      price10,
      price20,
      price30,

      liquidity10,
      liquidity30,

      sell5,
      sell10,
      sell20,
      sell30,

      buy10,
      sellRatio10,

      sellCount10,
      sellCount30,

      withdrawal10,
      withdrawal30,

      drawdown
    }
  };
}

// ============================================================
// CRASH DETECTION
// ============================================================

function detectCrash(metrics) {
  const {
    price10,
    liquidity10,
    reserve10,
    reserve5
  } = metrics;

  // Chute de prix
  if (
    price10 !== null &&
    price10 <= -20
  ) {
    return "prix -20% en 10 secondes";
  }

  // Gros effondrement de liquidité
  if (
    liquidity10 !== null &&
    liquidity10 <= -35
  ) {
    return "liquidité -35% en 10 secondes";
  }

  // Gros retrait de réserve
  if (
    reserve10 !== null &&
    reserve10 <= -35
  ) {
    return "réserve -35% en 10 secondes";
  }

  if (
    reserve5 !== null &&
    reserve5 <= -25
  ) {
    return "réserve -25% en 5 secondes";
  }

  return null;
}

// ============================================================
// STATE TRANSITIONS
// ============================================================

function determineState(score, metrics) {
  const crash =
    detectCrash(metrics);

  if (crash) {
    return {
      state: "CRASH",
      crashReason: crash
    };
  }

  // Pré-alerte
  if (
    score >= 30
  ) {
    return {
      state: "PREALERTE",
      crashReason: null
    };
  }

  // Sortie
  if (
    score >= 45
  ) {
    return {
      state: "SORTIE",
      crashReason: null
    };
  }

  // Critique
  if (
    score >= 65
  ) {
    return {
      state: "CRITIQUE",
      crashReason: null
    };
  }

  return {
    state: "NORMAL",
    crashReason: null
  };
}

// ============================================================
// ALERT BUILDER
// ============================================================

function buildAlert(
  state,
  score,
  signals,
  metrics
) {
  const reserve =
    current.effectiveQuoteRaw !== null
      ? lamportsToSol(
          current.effectiveQuoteRaw
        )
      : null;

  const title = {
    PREALERTE:
      "🟡 PRÉ-ALERTE : DÉGRADATION",

    SORTIE:
      "🟠 SORTIE : RISQUE EN HAUSSE",

    CRITIQUE:
      "🔴 CRITIQUE : RISQUE DE CHUTE",

    CRASH:
      "🛑 CRASH : RADAR ARRÊTÉ"
  }[state];

  const signalText =
    signals.length
      ? signals
          .slice(0, 6)
          .map(s => `• ${s}`)
          .join("\n")
      : "• aucun signal majeur";

  return `
${title}

Score risque : ${score}/100

Prix : ${formatUsd(current.price)}
Liquidité : ${formatLiquidity(current.liquidity)}

SELL 5s : ${metrics.sell5.toFixed(4)} SOL
SELL 10s : ${metrics.sell10.toFixed(4)} SOL
SELL 20s : ${metrics.sell20.toFixed(4)} SOL

SELL ratio 10s : ${metrics.sellRatio10.toFixed(1)}%
SELL / 10s : ${metrics.sellCount10}

Réserve WSOL :
${reserve !== null
  ? reserve.toFixed(4)
  : "N/A"} SOL

Réserve 10s :
${formatPct(metrics.reserve10)}

Réserve 20s :
${formatPct(metrics.reserve20)}

Réserve 30s :
${formatPct(metrics.reserve30)}

Prix sous sommet :
${formatPct(metrics.drawdown)}

Prix 10s :
${formatPct(metrics.price10)}

Prix 20s :
${formatPct(metrics.price20)}

Liquidité 10s :
${formatPct(metrics.liquidity10)}

⚠️ Signaux :
${signalText}

📡 RADAR V7
`.trim();
}

// ============================================================
// ALERT SENDING
// ============================================================

async function sendAlert(
  state,
  score,
  signals,
  metrics
) {
  const currentTime =
    now();

  let cooldown =
    ALERT_COOLDOWN_PRE;

  if (state === "SORTIE") {
    cooldown =
      ALERT_COOLDOWN_EXIT;
  }

  if (
    state === "CRITIQUE" ||
    state === "CRASH"
  ) {
    cooldown =
      ALERT_COOLDOWN_CRITICAL;
  }

  if (
    lastAlert.type === state &&
    currentTime -
      lastAlert.timestamp <
      cooldown
  ) {
    return;
  }

  lastAlert = {
    type: state,
    timestamp: currentTime
  };

  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      buildAlert(
        state,
        score,
        signals,
        metrics
      )
    );
  } catch (e) {
    console.log(
      "Telegram:",
      e.message
    );
  }
}

// ============================================================
// RISK EVALUATION
// ============================================================

async function evaluateRisk(source) {
  if (!watching || stopped) {
    return;
  }

  const result =
    calculateRisk();

  const score =
    result.score;

  const metrics =
    result.metrics;

  const transition =
    determineState(
      score,
      metrics
    );

  const nextState =
    transition.state;

  // ----------------------------------------------------------
  // CRASH
  // ----------------------------------------------------------

  if (
    nextState === "CRASH"
  ) {
    await sendAlert(
      "CRASH",
      100,
      [
        "mouvement brutal confirmé",
        transition.crashReason
      ],
      metrics
    );

    await stopRadar(
      transition.crashReason
    );

    return;
  }

  // ----------------------------------------------------------
  // Important :
  // SORTIE avant CRITIQUE.
  // On cherche à donner le temps de sortir.
  // ----------------------------------------------------------

  if (
    nextState === "CRITIQUE"
  ) {
    if (
      riskState !==
      "CRITIQUE"
    ) {
      await sendAlert(
        "CRITIQUE",
        score,
        result.signals,
        metrics
      );
    }

    riskState =
      "CRITIQUE";

    return;
  }

  if (
    nextState === "SORTIE"
  ) {
    if (
      riskState ===
        "NORMAL" ||
      riskState ===
        "PREALERTE"
    ) {
      await sendAlert(
        "SORTIE",
        score,
        result.signals,
        metrics
      );
    }

    riskState =
      "SORTIE";

    return;
  }

  if (
    nextState === "PREALERTE"
  ) {
    if (
      riskState ===
      "NORMAL"
    ) {
      await sendAlert(
        "PREALERTE",
        score,
        result.signals,
        metrics
      );
    }

    riskState =
      "PREALERTE";

    return;
  }

  // Retour au calme
  if (
    nextState === "NORMAL"
  ) {
    riskState =
      "NORMAL";
  }
}

// ============================================================
// STOP RADAR
// ============================================================

async function stopRadar(
  reason
) {
  if (stopped) return;

  stopped = true;
  watching = false;

  clearInterval(
    dexTimer
  );

  clearTimeout(
    reconnectTimer
  );

  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  console.log(
    "🛑 RADAR ARRÊTÉ :",
    reason
  );

  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      `
🛑 RADAR V7 ARRÊTÉ

Token :
${mint}

Cause :
${reason}

Le bot ne suivra plus ce token.
`.trim()
    );
  } catch {}
}

// ============================================================
// START RADAR
// ============================================================

async function startRadar(
  tokenMint
) {
  mint = tokenMint;

  watching = true;
  stopped = false;

  resetHistory();

  current = {
    price: null,
    liquidity: null,

    baseRaw: null,
    quoteRaw: null,
    virtualQuoteRaw: 0n,
    effectiveQuoteRaw: null,

    updatedAt: 0
  };

  previousVault = {
    base: null,
    quote: null,
    effectiveQuote: null,
    timestamp: 0
  };

  baseSub = null;
  quoteSub = null;
  poolSub = null;

  console.log(
    "================================="
  );

  console.log(
    "🚀 RADAR V7"
  );

  console.log(
    "Token :",
    mint
  );

  console.log(
    "================================="
  );

  await loadPool();

  await initializeVaults();

  const dex =
    await fetchDex();

  if (dex) {
    current.price =
      dex.price;

    current.liquidity =
      dex.liquidity;

    if (
      current.price > 0
    ) {
      highPrice =
        current.price;

      addHistory(
        histories.price,
        current.price
      );
    }

    if (
      current.liquidity > 0
    ) {
      addHistory(
        histories.liquidity,
        current.liquidity
      );
    }
  }

  addHistory(
    histories.reserve,
    lamportsToSol(
      current.effectiveQuoteRaw
    )
  );

  connectWebSocket();

  dexTimer =
    setInterval(
      updateMarket,
      DEX_INTERVAL_MS
    );

  await bot.telegram.sendMessage(
    CHAT_ID,
    `
📡 RADAR V7 ACTIVÉ

Token :
${mint}

Pool :
${poolAddress}

💰 Réserve WSOL :
${lamportsToSol(
  current.effectiveQuoteRaw
).toFixed(4)} SOL

🎯 Objectif :
détecter la dégradation AVANT
la chute brutale.

🟢 Surveillance active.
`.trim()
  );
}

// ============================================================
// TELEGRAM COMMANDS
// ============================================================

bot.command(
  "watch",
  async ctx => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    if (
      parts.length < 2
    ) {
      await ctx.reply(
        "Utilisation : /watch ADRESSE_DU_TOKEN"
      );
      return;
    }

    if (watching) {
      await ctx.reply(
        "⚠️ Un radar est déjà actif. Utilise /unwatch d'abord."
      );
      return;
    }

    const token =
      parts[1].trim();

    try {
      await startRadar(
        token
      );
    } catch (e) {
      console.error(e);

      watching = false;
      stopped = false;

      await ctx.reply(
        `❌ Impossible de démarrer V7.\n\n${e.message}`
      );
    }
  }
);

bot.command(
  "unwatch",
  async ctx => {
    if (!watching) {
      await ctx.reply(
        "Aucun radar actif."
      );
      return;
    }

    await stopRadar(
      "arrêt manuel"
    );
  }
);

bot.command(
  "status",
  async ctx => {
    if (
      !watching ||
      stopped
    ) {
      await ctx.reply(
        "📡 Aucun radar actif."
      );
      return;
    }

    const result =
      calculateRisk();

    const reserve =
      current.effectiveQuoteRaw !== null
        ? lamportsToSol(
            current.effectiveQuoteRaw
          )
        : null;

    await ctx.reply(
      `
📡 RADAR V7

État :
${riskState}

Score :
${result.score}/100

Prix :
${formatUsd(current.price)}

Liquidité :
${formatLiquidity(
  current.liquidity
)}

Réserve WSOL :
${reserve !== null
  ? reserve.toFixed(4)
  : "N/A"} SOL

Réserve 10s :
${formatPct(
  result.metrics.reserve10
)}

Réserve 30s :
${formatPct(
  result.metrics.reserve30
)}

Prix 10s :
${formatPct(
  result.metrics.price10
)}

Prix 30s :
${formatPct(
  result.metrics.price30
)}

Prix sous sommet :
${formatPct(
  result.metrics.drawdown
)}

SELL 10s :
${result.metrics.sell10.toFixed(4)} SOL

SELL ratio :
${result.metrics.sellRatio10.toFixed(1)}%
`.trim()
    );
  }
);

bot.command(
  "help",
  async ctx => {
    await ctx.reply(
      `
📡 RADAR V7

/watch ADRESSE
→ démarre le radar

/status
→ état actuel

/unwatch
→ arrête le radar

V7 cherche surtout les signaux
précurseurs et évite de confondre
une grosse variation isolée avec
un crash déjà commencé.
`.trim()
    );
  }
);

// ============================================================
// START
// ============================================================

bot.launch()
  .then(() => {
    console.log(
      "🤖 Telegram V7 démarré"
    );
  })
  .catch(err => {
    console.error(
      "Telegram launch error:",
      err
    );
  });

process.once(
  "SIGINT",
  () => {
    bot.stop(
      "SIGINT"
    );
  }
);

process.once(
  "SIGTERM",
  () => {
    bot.stop(
      "SIGTERM"
    );
  }
);
