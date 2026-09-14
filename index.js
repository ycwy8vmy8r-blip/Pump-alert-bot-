const { Telegraf } = require("telegraf");
const WebSocket = require("ws");
const https = require("https");
const { PublicKey } = require("@solana/web3.js");

// ============================================================
// CONFIG
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  console.error(
    "❌ Variables manquantes : BOT_TOKEN / CHAT_ID / HELIUS_API_KEY"
  );
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// ============================================================
// PUMPSWAP
// ============================================================

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

// ============================================================
// PUMPSWAP POOL ACCOUNT LAYOUT
//
// 8 bytes Anchor discriminator AVANT ces offsets.
//
// Vérifié avec la structure officielle PumpSwap.
// ============================================================

const POOL = {
  bump: 8,
  index: 9,
  creator: 11,

  baseMint: 43,
  quoteMint: 75,

  lpMint: 107,

  baseVault: 139,
  quoteVault: 171,

  lpSupply: 203,

  coinCreator: 211,

  isMayhemMode: 243,
  isCashbackCoin: 244,

  virtualQuoteReserves: 245
};

// SPL Token Account amount
const SPL_AMOUNT_OFFSET = 64;

// ============================================================
// TIMING
// ============================================================

const HISTORY_MS = 120000;

const DEX_INTERVAL_MS = 2000;

const BATCH_MS = 80;

const WARMUP_MS = 20000;

const ALERT_COOLDOWN_MS = 45000;

const CRITICAL_COOLDOWN_MS = 15000;

// ============================================================
// GLOBAL STATE
// ============================================================

let watching = false;
let stopped = false;

let mint = null;

let poolAddress = null;

let baseVault = null;
let quoteVault = null;

let ws = null;

let dexTimer = null;
let batchTimer = null;
let reconnectTimer = null;

let rpcId = 1;

let wsRequestMap = new Map();

let subscriptions = {
  base: null,
  quote: null,
  logs: null
};

let pending = {
  base: null,
  quote: null
};

let warmupUntil = 0;

let state = "NORMAL";

let lastAlertAt = 0;
let lastAlertState = null;

let highPrice = null;

let lastLogType = null;
let lastLogAt = 0;

// ============================================================
// CURRENT MARKET STATE
// ============================================================

let current = {
  price: null,
  liquidity: null,

  baseRaw: null,
  quoteRaw: null,

  virtualQuoteRaw: 0n,

  effectiveQuoteRaw: null
};

// ============================================================
// HISTORY
// ============================================================

let history = {
  reserve: [],
  price: [],
  liquidity: [],

  sell: [],
  buy: [],

  withdraw: []
};

// ============================================================
// BASIC HELPERS
// ============================================================

function now() {
  return Date.now();
}

function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}

function sol(raw) {
  return Number(raw || 0n) / 1e9;
}

function fmtPct(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "N/A";
  }

  return (
    `${value >= 0 ? "+" : ""}` +
    `${value.toFixed(1)}%`
  );
}

function fmtUsd(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "N/A";
  }

  return (
    "$" +
    Number(value).toLocaleString(
      "en-US",
      {
        minimumFractionDigits: 4,
        maximumFractionDigits: 8
      }
    )
  );
}

function fmtLiquidity(value) {
  if (
    value === null ||
    value === undefined
  ) {
    return "N/A";
  }

  return (
    "$" +
    Number(value).toLocaleString(
      "en-US",
      {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }
    )
  );
}

// ============================================================
// HISTORY HELPERS
// ============================================================

function trimHistory(array) {
  const cutoff =
    now() - HISTORY_MS;

  while (
    array.length &&
    array[0].t < cutoff
  ) {
    array.shift();
  }
}

function pushHistory(
  array,
  value
) {
  if (
    value === null ||
    value === undefined
  ) {
    return;
  }

  const number =
    Number(value);

  if (!Number.isFinite(number)) {
    return;
  }

  array.push({
    t: now(),
    v: number
  });

  trimHistory(array);
}

function valueBefore(
  array,
  milliseconds
) {
  const target =
    now() - milliseconds;

  for (
    let i = array.length - 1;
    i >= 0;
    i--
  ) {
    if (
      array[i].t <= target
    ) {
      return array[i].v;
    }
  }

  return null;
}

function percentageChange(
  array,
  seconds
) {
  if (!array.length) {
    return null;
  }

  const oldValue =
    valueBefore(
      array,
      seconds * 1000
    );

  const currentValue =
    array[array.length - 1].v;

  if (
    oldValue === null ||
    oldValue === 0
  ) {
    return null;
  }

  return (
    ((currentValue - oldValue) /
      oldValue) *
    100
  );
}

function sumWindow(
  array,
  seconds
) {
  const cutoff =
    now() - seconds * 1000;

  let total = 0;

  for (
    let i = array.length - 1;
    i >= 0;
    i--
  ) {
    if (
      array[i].t < cutoff
    ) {
      break;
    }

    total += array[i].v;
  }

  return total;
}

function countWindow(
  array,
  seconds
) {
  const cutoff =
    now() - seconds * 1000;

  let count = 0;

  for (
    let i = array.length - 1;
    i >= 0;
    i--
  ) {
    if (
      array[i].t < cutoff
    ) {
      break;
    }

    count++;
  }

  return count;
}

// ============================================================
// BINARY PARSING
// ============================================================

function readU64LE(
  buffer,
  offset
) {
  if (
    !buffer ||
    buffer.length < offset + 8
  ) {
    return null;
  }

  return buffer.readBigUInt64LE(
    offset
  );
}

function readI128LE(
  buffer,
  offset
) {
  if (
    !buffer ||
    buffer.length < offset + 16
  ) {
    return 0n;
  }

  const low =
    buffer.readBigUInt64LE(
      offset
    );

  const high =
    buffer.readBigInt64LE(
      offset + 8
    );

  return (
    (high << 64n) +
    BigInt(low)
  );
}

function decodeBase64Data(
  data
) {
  if (
    typeof data === "string"
  ) {
    return Buffer.from(
      data,
      "base64"
    );
  }

  if (
    Array.isArray(data) &&
    typeof data[0] === "string"
  ) {
    return Buffer.from(
      data[0],
      "base64"
    );
  }

  return null;
}

function readSplTokenAmount(
  data
) {
  const buffer =
    decodeBase64Data(data);

  return readU64LE(
    buffer,
    SPL_AMOUNT_OFFSET
  );
}

function readPubkey(
  buffer,
  offset
) {
  if (
    !buffer ||
    buffer.length < offset + 32
  ) {
    return null;
  }

  return new PublicKey(
    buffer.subarray(
      offset,
      offset + 32
    )
  ).toBase58();
}

// ============================================================
// RPC
// ============================================================

function rpc(
  method,
  params = []
) {
  return new Promise(
    (resolve, reject) => {
      const body =
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId++,
          method,
          params
        });

      const request =
        https.request(
          RPC_URL,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "Content-Length":
                Buffer.byteLength(
                  body
                )
            }
          },
          response => {
            let data = "";

            response.on(
              "data",
              chunk => {
                data += chunk;
              }
            );

            response.on(
              "end",
              () => {
                try {
                  const json =
                    JSON.parse(
                      data
                    );

                  if (
                    json.error
                  ) {
                    reject(
                      new Error(
                        json.error.message ||
                        JSON.stringify(
                          json.error
                        )
                      )
                    );

                    return;
                  }

                  resolve(
                    json.result
                  );
                } catch (error) {
                  reject(error);
                }
              }
            );
          }
        );

      request.on(
        "error",
        reject
      );

      request.write(body);

      request.end();
    }
  );
}

// ============================================================
// DEXSCREENER
// ============================================================

async function fetchDex() {
  if (!mint) {
    return null;
  }

  try {
    const response =
      await fetch(
        `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`
      );

    if (!response.ok) {
      return null;
    }

    const pairs =
      await response.json();

    if (
      !Array.isArray(pairs)
    ) {
      return null;
    }

    const pumpPairs =
      pairs.filter(
        pair =>
          String(
            pair.dexId || ""
          ).toLowerCase() ===
          "pumpswap"
      );

    const pair =
      pumpPairs[0] ||
      pairs[0];

    if (!pair) {
      return null;
    }

    return {
      price:
        Number(
          pair.priceUsd || 0
        ),

      liquidity:
        Number(
          pair.liquidity?.usd ||
          0
        ),

      pairAddress:
        pair.pairAddress ||
        null,

      dexId:
        String(
          pair.dexId || ""
        ).toLowerCase()
    };

  } catch (error) {
    console.log(
      "DexScreener:",
      error.message
    );

    return null;
  }
}

// ============================================================
// LOAD PUMPSWAP POOL
// ============================================================

async function loadPool() {
  const dex =
    await fetchDex();

  if (
    !dex ||
    !dex.pairAddress
  ) {
    throw new Error(
      "Pool PumpSwap introuvable."
    );
  }

  const account =
    await rpc(
      "getAccountInfo",
      [
        dex.pairAddress,
        {
          encoding: "base64",
          commitment: "processed"
        }
      ]
    );

  if (
    !account ||
    !account.value ||
    !account.value.data
  ) {
    throw new Error(
      "Impossible de lire le compte du pool."
    );
  }

  // Vérification essentielle :
  // le compte doit appartenir au programme PumpSwap.
  if (
    account.value.owner !==
    PUMPSWAP_PROGRAM
  ) {
    throw new Error(
      "Le pair trouvé n'est pas un compte PumpSwap officiel."
    );
  }

  const buffer =
    decodeBase64Data(
      account.value.data
    );

  if (
    !buffer ||
    buffer.length <
      POOL.virtualQuoteReserves +
        16
  ) {
    throw new Error(
      "Compte Pool PumpSwap trop court ou format inattendu."
    );
  }

  poolAddress =
    dex.pairAddress;

  const poolBaseMint =
    readPubkey(
      buffer,
      POOL.baseMint
    );

  const poolQuoteMint =
    readPubkey(
      buffer,
      POOL.quoteMint
    );

  baseVault =
    readPubkey(
      buffer,
      POOL.baseVault
    );

  quoteVault =
    readPubkey(
      buffer,
      POOL.quoteVault
    );

  current.virtualQuoteRaw =
    readI128LE(
      buffer,
      POOL.virtualQuoteReserves
    );

  if (
    !baseVault ||
    !quoteVault
  ) {
    throw new Error(
      "Impossible de lire les vaults PumpSwap."
    );
  }

  if (
    poolBaseMint !==
    mint
  ) {
    throw new Error(
      "Le pool trouvé ne correspond pas au token surveillé."
    );
  }

  if (
    poolQuoteMint !==
    SOL_MINT
  ) {
    throw new Error(
      "Le pool trouvé n'est pas appairé avec WSOL."
    );
  }

  console.log(
    "🏊 Pool PumpSwap :",
    poolAddress
  );

  console.log(
    "🪙 Base vault :",
    baseVault
  );

  console.log(
    "💧 Quote vault :",
    quoteVault
  );

  console.log(
    "🧩 Virtual quote :",
    current.virtualQuoteRaw.toString()
  );
}

// ============================================================
// INITIAL VAULT READ
// ============================================================

async function initializeVaults() {
  const results =
    await Promise.all([
      rpc(
        "getAccountInfo",
        [
          baseVault,
          {
            encoding: "base64",
            commitment: "processed"
          }
        ]
      ),

      rpc(
        "getAccountInfo",
        [
          quoteVault,
          {
            encoding: "base64",
            commitment: "processed"
          }
        ]
      )
    ]);

  current.baseRaw =
    readSplTokenAmount(
      results[0]?.value?.data
    );

  current.quoteRaw =
    readSplTokenAmount(
      results[1]?.value?.data
    );

  if (
    current.baseRaw === null ||
    current.quoteRaw === null
  ) {
    throw new Error(
      "Impossible de lire les réserves des vaults."
    );
  }

  current.effectiveQuoteRaw =
    current.quoteRaw +
    current.virtualQuoteRaw;

  pushHistory(
    history.reserve,
    sol(
      current.effectiveQuoteRaw
    )
  );
}

// ============================================================
// RESET
// ============================================================

function resetRadarState() {
  history = {
    reserve: [],
    price: [],
    liquidity: [],
    sell: [],
    buy: [],
    withdraw: []
  };

  current = {
    price: null,
    liquidity: null,

    baseRaw: null,
    quoteRaw: null,

    virtualQuoteRaw: 0n,

    effectiveQuoteRaw: null
  };

  pending = {
    base: null,
    quote: null
  };

  subscriptions = {
    base: null,
    quote: null,
    logs: null
  };

  wsRequestMap =
    new Map();

  state = "NORMAL";

  lastAlertAt = 0;

  lastAlertState = null;

  highPrice = null;

  lastLogType = null;

  lastLogAt = 0;
}

// ============================================================
// WEBSOCKET SEND
// ============================================================

function wsSend(
  method,
  params,
  type
) {
  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  const id =
    rpcId++;

  wsRequestMap.set(
    id,
    type
  );

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })
  );
}

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

function connectWebSocket() {
  if (stopped) {
    return;
  }

  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  ws =
    new WebSocket(
      WS_URL
    );

  ws.on(
    "open",
    () => {
      console.log(
        "🟢 WebSocket V7 connecté"
      );

      wsSend(
        "accountSubscribe",
        [
          baseVault,
          {
            encoding: "base64",
            commitment: "processed"
          }
        ],
        "base"
      );

      wsSend(
        "accountSubscribe",
        [
          quoteVault,
          {
            encoding: "base64",
            commitment: "processed"
          }
        ],
        "quote"
      );

      wsSend(
        "logsSubscribe",
        [
          {
            mentions: [
              poolAddress
            ]
          },
          {
            commitment: "processed"
          }
        ],
        "logs"
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

        // ----------------------------------------------------
        // Subscription response
        // ----------------------------------------------------

        if (
          message.id &&
          typeof message.result ===
            "number" &&
          wsRequestMap.has(
            message.id
          )
        ) {
          const type =
            wsRequestMap.get(
              message.id
            );

          wsRequestMap.delete(
            message.id
          );

          subscriptions[type] =
            message.result;

          return;
        }

        // ----------------------------------------------------
        // Account notification
        // ----------------------------------------------------

        if (
          message.method ===
          "accountNotification"
        ) {
          const subscription =
            message.params
              ?.subscription;

          const amount =
            readSplTokenAmount(
              message.params
                ?.result
                ?.value
                ?.data
            );

          if (
            amount === null
          ) {
            return;
          }

          if (
            subscription ===
            subscriptions.base
          ) {
            pending.base =
              amount;
          }

          if (
            subscription ===
            subscriptions.quote
          ) {
            pending.quote =
              amount;
          }

          return;
        }

        // ----------------------------------------------------
        // PumpSwap logs
        // ----------------------------------------------------

        if (
          message.method ===
          "logsNotification"
        ) {
          const value =
            message.params
              ?.result
              ?.value;

          if (
            value?.err
          ) {
            return;
          }

          const logs =
            value?.logs || [];

          const text =
            logs.join(" ");

          let type =
            null;

          if (
            /Instruction: Sell/i.test(
              text
            )
          ) {
            type = "SELL";
          }

          else if (
            /Instruction: Buy/i.test(
              text
            )
          ) {
            type = "BUY";
          }

          else if (
            /Instruction: Withdraw/i.test(
              text
            )
          ) {
            type = "WITHDRAW";
          }

          else if (
            /Instruction: Deposit/i.test(
              text
            )
          ) {
            type = "DEPOSIT";
          }

          if (type) {
            lastLogType =
              type;

            lastLogAt =
              now();
          }
        }

      } catch (error) {
        console.log(
          "WS parse:",
          error.message
        );
      }
    }
  );

  ws.on(
    "close",
    () => {
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
            1200
          );
      }
    }
  );

  ws.on(
    "error",
    error => {
      console.log(
        "WS error:",
        error.message
      );
    }
  );
}

// ============================================================
// EVENT CLASSIFICATION
// ============================================================

function classifyEvent(
  baseDelta,
  quoteDelta,
  quoteSol
) {
  const recentLog =
    lastLogAt >
    now() - 1200
      ? lastLogType
      : null;

  if (
    recentLog === "SELL"
  ) {
    return quoteSol >=
      0.01
      ? "SELL"
      : null;
  }

  if (
    recentLog === "BUY"
  ) {
    return quoteSol >=
      0.01
      ? "BUY"
      : null;
  }

  if (
    recentLog === "WITHDRAW"
  ) {
    return quoteSol >=
      0.01
      ? "WITHDRAW"
      : null;
  }

  if (
    recentLog === "DEPOSIT"
  ) {
    return quoteSol >=
      0.01
      ? "DEPOSIT"
      : null;
  }

  // Fallback structurel
  if (
    baseDelta < 0n &&
    quoteDelta > 0n &&
    quoteSol >= 0.01
  ) {
    return "SELL";
  }

  if (
    baseDelta > 0n &&
    quoteDelta < 0n &&
    quoteSol >= 0.01
  ) {
    return "BUY";
  }

  if (
    baseDelta < 0n &&
    quoteDelta < 0n &&
    quoteSol >= 0.01
  ) {
    return "WITHDRAW";
  }

  return null;
}

// ============================================================
// VAULT BATCH
// ============================================================

function flushVaults() {
  if (
    !watching ||
    stopped
  ) {
    return;
  }

  const newBase =
    pending.base;

  const newQuote =
    pending.quote;

  pending.base = null;
  pending.quote = null;

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

  pushHistory(
    history.reserve,
    sol(
      current.effectiveQuoteRaw
    )
  );

  // We only classify a trade when both vaults
  // changed in the same short batch.
  if (
    oldBase !== null &&
    oldQuote !== null &&
    newBase !== null &&
    newQuote !== null
  ) {
    const baseDelta =
      newBase -
      oldBase;

    const quoteDelta =
      newQuote -
      oldQuote;

    const quoteSol =
      Math.abs(
        sol(
          quoteDelta
        )
      );

    const event =
      classifyEvent(
        baseDelta,
        quoteDelta,
        quoteSol
      );

    if (
      event === "SELL"
    ) {
      pushHistory(
        history.sell,
        quoteSol
      );
    }

    if (
      event === "BUY"
    ) {
      pushHistory(
        history.buy,
        quoteSol
      );
    }

    if (
      event === "WITHDRAW"
    ) {
      pushHistory(
        history.withdraw,
        quoteSol
      );
    }
  }

  evaluateRisk(
    "ONCHAIN"
  );
}

// ============================================================
// RISK ENGINE
// ============================================================

function calculateRisk() {
  const reserve5 =
    percentageChange(
      history.reserve,
      5
    );

  const reserve10 =
    percentageChange(
      history.reserve,
      10
    );

  const reserve20 =
    percentageChange(
      history.reserve,
      20
    );

  const reserve30 =
    percentageChange(
      history.reserve,
      30
    );

  const price5 =
    percentageChange(
      history.price,
      5
    );

  const price10 =
    percentageChange(
      history.price,
      10
    );

  const price20 =
    percentageChange(
      history.price,
      20
    );

  const price30 =
    percentageChange(
      history.price,
      30
    );

  const liquidity10 =
    percentageChange(
      history.liquidity,
      10
    );

  const liquidity30 =
    percentageChange(
      history.liquidity,
      30
    );

  const sell5 =
    sumWindow(
      history.sell,
      5
    );

  const sell10 =
    sumWindow(
      history.sell,
      10
    );

  const sell20 =
    sumWindow(
      history.sell,
      20
    );

  const sell30 =
    sumWindow(
      history.sell,
      30
    );

  const buy10 =
    sumWindow(
      history.buy,
      10
    );

  const withdraw10 =
    sumWindow(
      history.withdraw,
      10
    );

  const withdraw30 =
    sumWindow(
      history.withdraw,
      30
    );

  const sellCount10 =
    countWindow(
      history.sell,
      10
    );

  const totalFlow10 =
    sell10 +
    buy10;

  const sellRatio10 =
    totalFlow10 > 0
      ? (
          sell10 /
          totalFlow10
        ) * 100
      : 0;

  const drawdown =
    highPrice &&
    current.price
      ? (
          (
            current.price -
            highPrice
          ) /
          highPrice
        ) * 100
      : 0;

  let score = 0;

  const signals = [];

  // ----------------------------------------------------------
  // 1. SELL PRESSURE
  // ----------------------------------------------------------

  if (
    sellRatio10 >= 70 &&
    sell20 >= 1
  ) {
    score += 5;

    signals.push(
      "pression vendeuse"
    );
  }

  if (
    sellRatio10 >= 80 &&
    sell10 >= 2
  ) {
    score += 7;

    signals.push(
      "pression vendeuse persistante"
    );
  }

  if (
    sell20 >= 2 &&
    sell10 >=
      sell20 * 0.60
  ) {
    score += 6;

    signals.push(
      "accélération des ventes"
    );
  }

  // ----------------------------------------------------------
  // 2. PRICE FAILURE
  // ----------------------------------------------------------

  if (
    price20 !== null &&
    price20 < -1 &&
    sell20 >= 0.8
  ) {
    score += 8;

    signals.push(
      "momentum qui se dégrade"
    );
  }

  if (
    price10 !== null &&
    price10 < -2.5 &&
    sell10 >= 0.8
  ) {
    score += 10;

    signals.push(
      "cassure du momentum"
    );
  }

  if (
    drawdown < -3
  ) {
    score += 5;

    signals.push(
      "prix sous le sommet"
    );
  }

  if (
    drawdown < -7
  ) {
    score += 8;

    signals.push(
      "perte du sommet confirmée"
    );
  }

  // ----------------------------------------------------------
  // 3. RESERVE TREND
  // ----------------------------------------------------------

  if (
    reserve30 !== null &&
    reserve30 <= -2 &&
    reserve30 > -5
  ) {
    score += 4;

    signals.push(
      "réserve en baisse progressive"
    );
  }

  if (
    reserve20 !== null &&
    reserve20 <= -4 &&
    reserve20 > -10
  ) {
    score += 8;

    signals.push(
      "dégradation de réserve"
    );
  }

  if (
    reserve10 !== null &&
    reserve10 <= -8 &&
    reserve10 > -15
  ) {
    score += 12;

    signals.push(
      "sortie importante de réserve"
    );
  }

  // Un choc brutal seul n'obtient PAS
  // automatiquement un score critique.
  if (
    reserve10 !== null &&
    reserve10 <= -15
  ) {
    score += 8;

    signals.push(
      "choc de réserve"
    );
  }

  // ----------------------------------------------------------
  // 4. LIQUIDITY
  // ----------------------------------------------------------

  if (
    liquidity30 !== null &&
    liquidity30 <= -3
  ) {
    score += 5;

    signals.push(
      "liquidité en baisse"
    );
  }

  if (
    liquidity10 !== null &&
    liquidity10 <= -8
  ) {
    score += 10;

    signals.push(
      "liquidité en forte baisse"
    );
  }

  // ----------------------------------------------------------
  // 5. WITHDRAWALS
  // ----------------------------------------------------------

  if (
    withdraw30 >= 1
  ) {
    score += 8;

    signals.push(
      "retrait de liquidité"
    );
  }

  if (
    withdraw10 >= 3
  ) {
    score += 10;

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

    withdraw30 >= 1

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
  // 7. HEALTHY ABSORPTION
  // ----------------------------------------------------------

  // Si le token continue franchement
  // à monter avec une liquidité stable,
  // on réduit le risque.
  if (
    price20 !== null &&
    price20 > 3 &&
    liquidity30 !== null &&
    liquidity30 >= 0 &&
    drawdown > -1
  ) {
    score -= 10;
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
    score:
      clamp(
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

      withdraw10,
      withdraw30,

      drawdown
    }
  };
}

// ============================================================
// CRASH DETECTION
// ============================================================

function detectCrash(
  metrics
) {
  // Prix -20% en 10 secondes
  if (
    metrics.price10 !== null &&
    metrics.price10 <= -20
  ) {
    return (
      "prix -20% en 10 secondes"
    );
  }

  // Liquidité -35%
  if (
    metrics.liquidity10 !== null &&
    metrics.liquidity10 <= -35
  ) {
    return (
      "liquidité -35% en 10 secondes"
    );
  }

  // Réserve -35%
  if (
    metrics.reserve10 !== null &&
    metrics.reserve10 <= -35
  ) {
    return (
      "réserve -35% en 10 secondes"
    );
  }

  // Réserve -25% en 5 secondes
  if (
    metrics.reserve5 !== null &&
    metrics.reserve5 <= -25
  ) {
    return (
      "réserve -25% en 5 secondes"
    );
  }

  return null;
}

// ============================================================
// STATE
// ============================================================

function determineState(
  result
) {
  const crash =
    detectCrash(
      result.metrics
    );

  if (crash) {
    return {
      state: "CRASH",
      reason: crash
    };
  }

  if (
    result.score >= 60
  ) {
    return {
      state: "CRITIQUE",
      reason: null
    };
  }

  if (
    result.score >= 42
  ) {
    return {
      state: "SORTIE",
      reason: null
    };
  }

  if (
    result.score >= 28
  ) {
    return {
      state: "PREALERTE",
      reason: null
    };
  }

  return {
    state: "NORMAL",
    reason: null
  };
}

// ============================================================
// ALERT MESSAGE
// ============================================================

function buildAlert(
  type,
  result,
  reason = null
) {
  const m =
    result.metrics;

  const reserve =
    current.effectiveQuoteRaw !==
    null
      ? sol(
          current.effectiveQuoteRaw
        )
      : null;

  const titles = {
    PREALERTE:
      "🟡 PRÉ-ALERTE : DÉGRADATION",

    SORTIE:
      "🟠 SORTIE : RISQUE EN HAUSSE",

    CRITIQUE:
      "🔴 CRITIQUE : RISQUE DE CHUTE",

    CRASH:
      "🛑 CRASH : RADAR ARRÊTÉ"
  };

  const title =
    titles[type];

  const signalText =
    result.signals.length
      ? result.signals
          .slice(0, 6)
          .map(
            signal =>
              `• ${signal}`
          )
          .join("\n")
      : "• aucun signal majeur";

  return `
${title}

Score risque : ${result.score}/100

Prix : ${fmtUsd(current.price)}
Liquidité : ${fmtLiquidity(current.liquidity)}

SELL 5s : ${m.sell5.toFixed(4)} SOL
SELL 10s : ${m.sell10.toFixed(4)} SOL
SELL 20s : ${m.sell20.toFixed(4)} SOL

SELL ratio 10s : ${m.sellRatio10.toFixed(1)}%
SELL / 10s : ${m.sellCount10}

Réserve WSOL :
${reserve === null
  ? "N/A"
  : reserve.toFixed(4)} SOL

Réserve 5s :
${fmtPct(m.reserve5)}

Réserve 10s :
${fmtPct(m.reserve10)}

Réserve 20s :
${fmtPct(m.reserve20)}

Réserve 30s :
${fmtPct(m.reserve30)}

Prix sous sommet :
${fmtPct(m.drawdown)}

Prix 10s :
${fmtPct(m.price10)}

Prix 20s :
${fmtPct(m.price20)}

Liquidité 10s :
${fmtPct(m.liquidity10)}

⚠️ Signaux :
${signalText}

${
  reason
    ? `Cause : ${reason}\n`
    : ""
}
📡 RADAR V7
`.trim();
}

// ============================================================
// SEND ALERT
// ============================================================

async function sendAlert(
  type,
  result,
  reason = null,
  force = false
) {
  const currentTime =
    now();

  const cooldown =
    type === "CRITIQUE" ||
    type === "CRASH"
      ? CRITICAL_COOLDOWN_MS
      : ALERT_COOLDOWN_MS;

  if (
    !force &&
    lastAlertState === type &&
    currentTime -
      lastAlertAt <
      cooldown
  ) {
    return;
  }

  lastAlertState =
    type;

  lastAlertAt =
    currentTime;

  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      buildAlert(
        type,
        result,
        reason
      )
    );
  } catch (error) {
    console.log(
      "Telegram:",
      error.message
    );
  }
}

// ============================================================
// RISK EVALUATION
// ============================================================

async function evaluateRisk(
  source
) {
  if (
    !watching ||
    stopped
  ) {
    return;
  }

  // Calibration initiale
  if (
    now() <
    warmupUntil
  ) {
    return;
  }

  const result =
    calculateRisk();

  const next =
    determineState(
      result
    );

  // ----------------------------------------------------------
  // CRASH
  // ----------------------------------------------------------

  if (
    next.state ===
    "CRASH"
  ) {
    await sendAlert(
      "CRASH",
      result,
      next.reason,
      true
    );

    await stopRadar(
      next.reason
    );

    return;
  }

  // ----------------------------------------------------------
  // STATE RANK
  // ----------------------------------------------------------

  const rank = {
    NORMAL: 0,
    PREALERTE: 1,
    SORTIE: 2,
    CRITIQUE: 3
  };

  // Alerte uniquement lors d'une
  // montée de niveau.
  if (
    rank[next.state] >
    rank[state]
  ) {
    await sendAlert(
      next.state,
      result
    );
  }

  state =
    next.state;
}

// ============================================================
// MARKET UPDATE
// ============================================================

async function updateMarket() {
  if (
    !watching ||
    stopped
  ) {
    return;
  }

  const dex =
    await fetchDex();

  if (!dex) {
    return;
  }

  if (
    dex.price > 0
  ) {
    current.price =
      dex.price;

    if (
      highPrice ===
        null ||
      dex.price >
        highPrice
    ) {
      highPrice =
        dex.price;
    }

    pushHistory(
      history.price,
      dex.price
    );
  }

  if (
    dex.liquidity > 0
  ) {
    current.liquidity =
      dex.liquidity;

    pushHistory(
      history.liquidity,
      dex.liquidity
    );
  }

  await evaluateRisk(
    "MARKET"
  );
}

// ============================================================
// STOP RADAR
// ============================================================

async function stopRadar(
  reason
) {
  if (stopped) {
    return;
  }

  stopped = true;
  watching = false;

  clearInterval(
    dexTimer
  );

  clearInterval(
    batchTimer
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
  mint =
    tokenMint.trim();

  // Vérifie que l'adresse est valide.
  new PublicKey(mint);

  resetRadarState();

  watching = true;
  stopped = false;

  warmupUntil =
    now() +
    WARMUP_MS;

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
    if (
      dex.price > 0
    ) {
      current.price =
        dex.price;

      highPrice =
        dex.price;

      pushHistory(
        history.price,
        dex.price
      );
    }

    if (
      dex.liquidity > 0
    ) {
      current.liquidity =
        dex.liquidity;

      pushHistory(
        history.liquidity,
        dex.liquidity
      );
    }
  }

  connectWebSocket();

  batchTimer =
    setInterval(
      flushVaults,
      BATCH_MS
    );

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
${sol(
  current.effectiveQuoteRaw
).toFixed(4)} SOL

⏱️ Calibration :
${WARMUP_MS / 1000}s

🎯 Objectif :
détecter la dégradation
avant la chute.

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

    try {
      await startRadar(
        parts[1]
      );

    } catch (error) {
      watching = false;
      stopped = false;

      console.error(
        error
      );

      await ctx.reply(
        `❌ Impossible de démarrer V7.\n\n${error.message}`
      );
    }
  }
);

bot.command(
  "unwatch",
  async () => {
    if (!watching) {
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

    const m =
      result.metrics;

    const reserve =
      sol(
        current.effectiveQuoteRaw
      );

    await ctx.reply(
      `
📡 RADAR V7

État :
${state}

Score :
${result.score}/100

Prix :
${fmtUsd(current.price)}

Liquidité :
${fmtLiquidity(
  current.liquidity
)}

Réserve WSOL :
${reserve.toFixed(4)} SOL

Réserve 10s :
${fmtPct(m.reserve10)}

Réserve 30s :
${fmtPct(m.reserve30)}

Prix 10s :
${fmtPct(m.price10)}

Prix 30s :
${fmtPct(m.price30)}

Prix sous sommet :
${fmtPct(m.drawdown)}

SELL 10s :
${m.sell10.toFixed(4)} SOL

SELL ratio 10s :
${m.sellRatio10.toFixed(1)}%
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

/help
→ aide
`.trim()
    );
  }
);

// ============================================================
// START TELEGRAM
// ============================================================

bot.launch()
  .then(() => {
    console.log(
      "🤖 Telegram V7 démarré"
    );
  })
  .catch(
    console.error
  );

// ============================================================
// SHUTDOWN
// ============================================================

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
