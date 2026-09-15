require("dotenv").config();

const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const {
  Connection,
  PublicKey,
} = require("@solana/web3.js");

const { Telegraf } = require("telegraf");

// ============================================================
// CONFIGURATION
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

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, "processed");

// ============================================================
// PUMPSWAP
// ============================================================

const PUMPSWAP_PROGRAM_ID =
  new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

const WSOL_MINT =
  new PublicKey("So11111111111111111111111111111111111111112");

// PumpSwap Pool layout
const OFFSET_BASE_MINT = 43;
const OFFSET_QUOTE_MINT = 75;
const OFFSET_BASE_VAULT = 139;
const OFFSET_QUOTE_VAULT = 171;
const OFFSET_VIRTUAL_QUOTE = 245;

// ============================================================
// STRATÉGIE
// ============================================================

const CAPITAL_PER_CYCLE = 10;
const TARGET_PROFIT = 0.05;

const POLL_INTERVAL_MS = 2000;

const OBSERVATION_AFTER_SELL_MS = 30 * 1000;

const NO_NEW_BUY_AFTER_MS = 43 * 60 * 1000;
const MAX_SESSION_MS = 45 * 60 * 1000;

const MIN_LIQUIDITY_USD = 3000;

const ENTRY_MAX_PRICE_DROP_10S = -4;
const ENTRY_MAX_LIQUIDITY_DROP_10S = -10;
const ENTRY_MAX_LIQUIDITY_DROP_30S = -15;

const CRASH_PRICE_DROP_10S = -20;
const CRASH_LIQUIDITY_DROP_10S = -50;

const ONCHAIN_RESERVE_SHOCK = -5;

const MIN_ONCHAIN_MOVE_SOL = 0.01;

// ============================================================
// DONNÉES
// ============================================================

const DATA_DIR =
  fs.existsSync("/data")
    ? "/data"
    : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MARKET_FILE =
  path.join(DATA_DIR, "market_history.jsonl");

const TRADE_FILE =
  path.join(DATA_DIR, "trade_history.json");

const CRASH_FILE =
  path.join(DATA_DIR, "crash_reports.json");

const ONCHAIN_FILE =
  path.join(DATA_DIR, "onchain_events.jsonl");

// ============================================================
// ÉTAT
// ============================================================

let active = false;
let mintAddress = null;

let sessionStart = null;
let sessionTimer = null;
let pollTimer = null;

let marketHistory = [];

let tradeHistory = [];

let currentPosition = null;

let cycleNumber = 0;
let totalProfit = 0;

let observationUntil = 0;

let noNewBuyAfter = null;

let healthScore = 100;
let favorableConfirmations = 0;

let lastMarketData = null;

let sessionStopReason = null;

let emergencyTriggered = false;

// ============================================================
// POOL
// ============================================================

let selectedPool = null;

let poolBaseVault = null;
let poolQuoteVault = null;

let poolBaseReserve = null;
let poolQuoteReserve = null;
let poolVirtualQuoteReserve = 0;

let effectiveQuoteReserve = null;

// ============================================================
// WEBSOCKET
// ============================================================

let ws = null;

let wsBaseSubscriptionId = null;
let wsQuoteSubscriptionId = null;
let wsPoolSubscriptionId = null;

let wsRequestId = 1;

let lastBaseVault = null;
let lastQuoteVault = null;
let lastPoolData = null;

let lastOnchainEvent = null;

let onchainEvents = [];

let onchainReady = false;

let lastOnchainShockTime = 0;

// ============================================================
// UTILITAIRES
// ============================================================

function now() {
  return Date.now();
}

function shortMint(mint) {
  if (!mint) return "null";
  return `${mint.slice(0, 8)}...${mint.slice(-6)}`;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(decimals));
}

function pct(value) {
  if (!Number.isFinite(value)) return "0.00%";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeReadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function appendJsonLine(file, object) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(object) + "\n"
    );
  } catch (error) {
    console.error("❌ Erreur sauvegarde :", error.message);
  }
}

// ============================================================
// CHARGEMENT
// ============================================================

tradeHistory = safeReadJson(TRADE_FILE, []);

if (!Array.isArray(tradeHistory)) {
  tradeHistory = [];
}

totalProfit = tradeHistory.reduce(
  (sum, trade) =>
    sum + (Number(trade.profit) || 0),
  0
);

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(text) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (error) {
    console.error(
      "❌ Telegram :",
      error.message
    );
  }
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexMetrics() {
  if (!mintAddress) return null;

  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const json = await response.json();

    const pairs =
      Array.isArray(json.pairs)
        ? json.pairs
        : [];

    const pumpPairs =
      pairs.filter(pair =>
        String(pair.dexId || "").toLowerCase()
          .includes("pump")
      );

    const candidates =
      pumpPairs.length > 0
        ? pumpPairs
        : pairs;

    if (!candidates.length) {
      return null;
    }

    candidates.sort(
      (a, b) =>
        Number(b.liquidity?.usd || 0) -
        Number(a.liquidity?.usd || 0)
    );

    const pair = candidates[0];

    const price =
      Number(pair.priceUsd);

    const liquidity =
      Number(pair.liquidity?.usd || 0);

    if (!Number.isFinite(price)) {
      return null;
    }

    return {
      timestamp: now(),
      price,
      liquidity,
      pairAddress:
        pair.pairAddress || null,
      volume24h:
        Number(pair.volume?.h24 || 0),
      buys5m:
        Number(pair.txns?.m5?.buys || 0),
      sells5m:
        Number(pair.txns?.m5?.sells || 0),
    };

  } catch (error) {
    console.error(
      "❌ DEXScreener :",
      error.message
    );

    return null;
  }
}

// ============================================================
// LECTURE POOL
// ============================================================

function readPubkey(buffer, offset) {
  if (!buffer || buffer.length < offset + 32) {
    return null;
  }

  return new PublicKey(
    buffer.subarray(offset, offset + 32)
  );
}

function readU64LE(buffer, offset) {
  if (!buffer || buffer.length < offset + 8) {
    return null;
  }

  return Number(
    buffer.readBigUInt64LE(offset)
  );
}

function readI128LE(buffer, offset) {
  if (!buffer || buffer.length < offset + 16) {
    return 0;
  }

  const low =
    buffer.readBigUInt64LE(offset);

  const high =
    buffer.readBigInt64LE(offset + 8);

  return Number(
    high * 18446744073709551616n +
    BigInt(low)
  );
}

// ============================================================
// RECHERCHE DIRECTE DES POOLS PUMPSWAP
// ============================================================

async function discoverPumpSwapPool() {
  if (!mintAddress) return null;

  try {
    console.log(
      "🔎 Recherche directe PumpSwap..."
    );

    const accounts =
      await connection.getProgramAccounts(
        PUMPSWAP_PROGRAM_ID,
        {
          filters: [
            {
              memcmp: {
                offset: OFFSET_BASE_MINT,
                bytes: mintAddress,
              },
            },
          ],
          commitment: "processed",
        }
      );

    if (!accounts.length) {
      console.log(
        "❌ Aucun pool PumpSwap trouvé."
      );

      return null;
    }

    const candidates = [];

    for (const account of accounts) {
      try {
        const data = account.account.data;

        const baseMint =
          readPubkey(
            data,
            OFFSET_BASE_MINT
          );

        const quoteMint =
          readPubkey(
            data,
            OFFSET_QUOTE_MINT
          );

        if (!baseMint || !quoteMint) {
          continue;
        }

        if (
          baseMint.toBase58() !== mintAddress
        ) {
          continue;
        }

        if (
          !quoteMint.equals(WSOL_MINT)
        ) {
          continue;
        }

        const baseVault =
          readPubkey(
            data,
            OFFSET_BASE_VAULT
          );

        const quoteVault =
          readPubkey(
            data,
            OFFSET_QUOTE_VAULT
          );

        if (!baseVault || !quoteVault) {
          continue;
        }

        const quoteAccount =
          await connection.getTokenAccountBalance(
            quoteVault,
            "processed"
          );

        const quoteReserve =
          Number(
            quoteAccount.value.amount
          ) / 1e9;

        const virtualQuote =
          readI128LE(
            data,
            OFFSET_VIRTUAL_QUOTE
          );

        const effective =
          quoteReserve +
          Math.max(0, virtualQuote / 1e9);

        candidates.push({
          pool: account.pubkey,
          baseMint,
          quoteMint,
          baseVault,
          quoteVault,
          quoteReserve,
          virtualQuote,
          effective,
        });

      } catch (error) {
        console.error(
          "⚠️ Pool ignoré :",
          error.message
        );
      }
    }

    if (!candidates.length) {
      console.log(
        "❌ Aucun pool PumpSwap SOL valide."
      );

      return null;
    }

    candidates.sort(
      (a, b) =>
        b.effective -
        a.effective
    );

    const selected =
      candidates[0];

    selectedPool =
      selected.pool.toBase58();

    poolBaseVault =
      selected.baseVault.toBase58();

    poolQuoteVault =
      selected.quoteVault.toBase58();

    poolQuoteReserve =
      selected.quoteReserve;

    poolVirtualQuoteReserve =
      selected.virtualQuote;

    effectiveQuoteReserve =
      selected.effective;

    console.log(
      "✅ Pool PumpSwap trouvé :",
      selectedPool
    );

    console.log(
      "🪙 Base vault :",
      poolBaseVault
    );

    console.log(
      "💧 Quote vault :",
      poolQuoteVault
    );

    console.log(
      "💧 Réserve quote effective :",
      effectiveQuoteReserve,
      "SOL"
    );

    return selected;

  } catch (error) {
    console.error(
      "❌ Recherche pool :",
      error.message
    );

    return null;
  }
}

// ============================================================
// WEBSOCKET
// ============================================================

function sendWs(message) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(
      JSON.stringify(message)
    );
  }
}

function connectPumpSwapWebSocket() {
  if (
    !poolBaseVault ||
    !poolQuoteVault ||
    !selectedPool
  ) {
    console.log(
      "⚠️ Impossible d'ouvrir WSS : pool incomplet."
    );

    return;
  }

  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  ws = new WebSocket(WSS_URL);

  ws.on("open", () => {
    console.log(
      "⛓️ WSS PumpSwap connecté"
    );

    wsRequestId = 1;

    wsBaseSubscriptionId = null;
    wsQuoteSubscriptionId = null;
    wsPoolSubscriptionId = null;

    sendWs({
      jsonrpc: "2.0",
      id: 1001,
      method: "accountSubscribe",
      params: [
        poolBaseVault,
        {
          encoding: "base64",
          commitment: "processed",
        },
      ],
    });

    sendWs({
      jsonrpc: "2.0",
      id: 1002,
      method: "accountSubscribe",
      params: [
        poolQuoteVault,
        {
          encoding: "base64",
          commitment: "processed",
        },
      ],
    });

    sendWs({
      jsonrpc: "2.0",
      id: 1003,
      method: "accountSubscribe",
      params: [
        selectedPool,
        {
          encoding: "base64",
          commitment: "processed",
        },
      ],
    });
  });

  ws.on("message", raw => {
    const receivedAt =
      process.hrtime.bigint();

    try {
      const message =
        JSON.parse(
          raw.toString()
        );

      // --------------------------------------------------------
      // RÉPONSES AUX ABONNEMENTS
      // --------------------------------------------------------

      if (
        message.id === 1001 &&
        message.result
      ) {
        wsBaseSubscriptionId =
          message.result;

        console.log(
          "⛓️ Base vault subscription :",
          wsBaseSubscriptionId
        );
      }

      if (
        message.id === 1002 &&
        message.result
      ) {
        wsQuoteSubscriptionId =
          message.result;

        console.log(
          "⛓️ Quote vault subscription :",
          wsQuoteSubscriptionId
        );
      }

      if (
        message.id === 1003 &&
        message.result
      ) {
        wsPoolSubscriptionId =
          message.result;

        console.log(
          "⛓️ Pool subscription :",
          wsPoolSubscriptionId
        );

        onchainReady = true;

        console.log(
          "🟢 Surveillance on-chain ACTIVE"
        );
      }

      // --------------------------------------------------------
      // NOTIFICATION COMPTE
      // --------------------------------------------------------

      if (
        message.method ===
        "accountNotification"
      ) {
        handleAccountNotification(
          message,
          receivedAt
        );
      }

    } catch (error) {
      console.error(
        "❌ WSS message :",
        error.message
      );
    }
  });

  ws.on("error", error => {
    console.error(
      "❌ WSS :",
      error.message
    );
  });

  ws.on("close", () => {
    console.log(
      "⚠️ WSS PumpSwap fermé"
    );

    onchainReady = false;

    if (active && !emergencyTriggered) {
      setTimeout(() => {
        if (active && !emergencyTriggered) {
          connectPumpSwapWebSocket();
        }
      }, 2000);
    }
  });
}

// ============================================================
// DÉCODAGE DES VAULTS
// ============================================================

function extractTokenAmount(notification) {
  try {
    const value =
      notification?.params?.result?.value;

    const data =
      value?.data;

    if (
      !Array.isArray(data) ||
      data.length < 1
    ) {
      return null;
    }

    const raw =
      Buffer.from(
        data[0],
        "base64"
      );

    // SPL Token Account amount = offset 64
    if (raw.length < 72) {
      return null;
    }

    return Number(
      raw.readBigUInt64LE(64)
    );

  } catch {
    return null;
  }
}

function extractSlot(message) {
  return Number(
    message?.params?.result?.context?.slot ||
    0
  );
}

// ============================================================
// ANALYSE ON-CHAIN
// ============================================================

function handleAccountNotification(
  message,
  receivedAt
) {
  const subscription =
    message?.params?.subscription;

  const amount =
    extractTokenAmount(message);

  if (amount === null) {
    return;
  }

  const slot =
    extractSlot(message);

  let side = null;

  if (
    subscription ===
    wsBaseSubscriptionId
  ) {
    const previous =
      lastBaseVault;

    lastBaseVault = amount;

    if (
      previous !== null &&
      previous !== amount
    ) {
      processVaultPairChange(
        "base",
        previous,
        amount,
        slot,
        receivedAt
      );
    }

    return;
  }

  if (
    subscription ===
    wsQuoteSubscriptionId
  ) {
    const previous =
      lastQuoteVault;

    lastQuoteVault = amount;

    if (
      previous !== null &&
      previous !== amount
    ) {
      processVaultPairChange(
        "quote",
        previous,
        amount,
        slot,
        receivedAt
      );
    }

    return;
  }

  if (
    subscription ===
    wsPoolSubscriptionId
  ) {
    lastPoolData = {
      timestamp: now(),
      slot,
    };

    return;
  }
}

// ============================================================
// PAIRE DE MODIFICATIONS VAULTS
// ============================================================

let pendingBaseChange = null;
let pendingQuoteChange = null;

function processVaultPairChange(
  type,
  previous,
  current,
  slot,
  receivedAt
) {
  const delta =
    current - previous;

  const deltaSol =
    Math.abs(delta) / 1e9;

  if (
    deltaSol <
    MIN_ONCHAIN_MOVE_SOL
  ) {
    return;
  }

  const event = {
    timestamp: now(),
    slot,
    type,
    previous,
    current,
    delta,
    deltaSol,
    receivedAtNs:
      receivedAt.toString(),
  };

  if (type === "base") {
    pendingBaseChange = event;
  }

  if (type === "quote") {
    pendingQuoteChange = event;
  }

  classifyPairedChange();
}

function classifyPairedChange() {
  if (
    !pendingBaseChange ||
    !pendingQuoteChange
  ) {
    return;
  }

  const base =
    pendingBaseChange;

  const quote =
    pendingQuoteChange;

  // On ne rapproche que des changements très proches.
  if (
    Math.abs(
      base.timestamp -
      quote.timestamp
    ) > 500
  ) {
    if (
      base.timestamp >
      quote.timestamp
    ) {
      pendingQuoteChange = null;
    } else {
      pendingBaseChange = null;
    }

    return;
  }

  let type =
    "UNKNOWN";

  const baseDown =
    base.delta < 0;

  const baseUp =
    base.delta > 0;

  const quoteDown =
    quote.delta < 0;

  const quoteUp =
    quote.delta > 0;

  if (
    baseDown &&
    quoteUp
  ) {
    type = "SELL";
  } else if (
    baseUp &&
    quoteDown
  ) {
    type = "BUY";
  } else if (
    baseDown &&
    quoteDown
  ) {
    type = "WITHDRAWAL";
  } else if (
    baseUp &&
    quoteUp
  ) {
    type = "ADD_LIQUIDITY";
  }

  const event = {
    timestamp: now(),
    slot:
      Math.max(
        base.slot,
        quote.slot
      ),
    type,
    baseDelta:
      base.delta,
    quoteDelta:
      quote.delta,
    baseDeltaSol:
      base.deltaSol,
    quoteDeltaSol:
      quote.deltaSol,
    reactionTimestamp:
      now(),
  };

  onchainEvents.push(event);

  if (onchainEvents.length > 500) {
    onchainEvents.shift();
  }

  appendJsonLine(
    ONCHAIN_FILE,
    event
  );

  console.log(
    `⚡ ON-CHAIN ${type}`,
    `base=${base.deltaSol.toFixed(4)}`,
    `quote=${quote.deltaSol.toFixed(4)} SOL`
  );

  lastOnchainEvent = event;

  // ----------------------------------------------------------
  // SIGNAL DE PROTECTION
  // ----------------------------------------------------------

  if (
    type === "WITHDRAWAL"
  ) {
    triggerOnchainProtection(
      "RETRAIT DE LIQUIDITÉ PUMPSWAP",
      event
    );
  }

  // Un SELL massif est également surveillé,
  // mais on ne déclenche pas sur un petit sell.
  if (
    type === "SELL" &&
    quote.deltaSol >= 0.5
  ) {
    triggerOnchainProtection(
      "SELL ON-CHAIN IMPORTANT",
      event
    );
  }

  pendingBaseChange = null;
  pendingQuoteChange = null;
}

// ============================================================
// PROTECTION ON-CHAIN
// ============================================================

function triggerOnchainProtection(
  reason,
  event
) {
  if (!active) return;
  if (!currentPosition) return;
  if (emergencyTriggered) return;

  emergencyTriggered = true;

  const reactionMs =
    event?.reactionTimestamp
      ? event.reactionTimestamp -
        event.timestamp
      : 0;

  console.log("");
  console.log(
    "🚨🚨 PROTECTION ON-CHAIN"
  );

  console.log(
    "🚨",
    reason
  );

  console.log(
    "⚡ Position ouverte :",
    currentPosition.cycle
  );

  console.log(
    "⚡ Temps de réaction interne :",
    reactionMs,
    "ms"
  );

  sendTelegram(
    `🚨 PROTECTION ON-CHAIN V5.4\n\n` +
    `Token :\n${mintAddress}\n\n` +
    `Signal : ${reason}\n\n` +
    `Cycle : #${currentPosition.cycle}\n` +
    `Mise : $${currentPosition.capital.toFixed(4)}\n\n` +
    `⚡ Détection on-chain immédiate\n` +
    `🧪 Simulation uniquement\n\n` +
    `⛔ Aucun nouveau cycle.`
  );

  /*
   * IMPORTANT :
   *
   * Nous ne faisons PAS de fausse vente au prix courant.
   * Le prix DEX peut déjà être en train de s'effondrer.
   *
   * En simulation, nous marquons la position comme
   * "sortie d'urgence non valorisée".
   */

  saveCrashReport(
    `ONCHAIN_${reason}`,
    event
  );

  stopSession(
    `protection on-chain : ${reason}`
  );
}

// ============================================================
// HISTORIQUE
// ============================================================

function addMarketPoint(data) {
  if (!data) return;

  marketHistory.push(data);

  const cutoff =
    now() - 120000;

  marketHistory =
    marketHistory.filter(
      item =>
        item.timestamp >= cutoff
    );

  appendJsonLine(
    MARKET_FILE,
    data
  );
}

// ============================================================
// VARIATIONS
// ============================================================

function getPointAgo(ms) {
  const target =
    now() - ms;

  let best = null;

  for (
    let i = marketHistory.length - 1;
    i >= 0;
    i--
  ) {
    const item =
      marketHistory[i];

    if (
      item.timestamp <= target
    ) {
      best = item;
      break;
    }
  }

  return best;
}

function changePercent(
  current,
  previous
) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return 0;
  }

  return (
    (current - previous) /
    previous
  ) *
  100;
}

// ============================================================
// SCORE
// ============================================================

function calculateHealthScore(data) {
  let score = 100;

  const p10 =
    changePercent(
      data.price,
      getPointAgo(10000)?.price
    );

  const l10 =
    changePercent(
      data.liquidity,
      getPointAgo(10000)?.liquidity
    );

  const l30 =
    changePercent(
      data.liquidity,
      getPointAgo(30000)?.liquidity
    );

  if (
    l10 < -5
  ) {
    score -= 20;
  }

  if (
    l10 < -10
  ) {
    score -= 20;
  }

  if (
    l30 < -15
  ) {
    score -= 25;
  }

  if (
    p10 < -4
  ) {
    score -= 20;
  }

  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    score -= 30;
  }

  if (
    data.sells5m >
    data.buys5m * 1.5
  ) {
    score -= 10;
  }

  if (score < 0) {
    score = 0;
  }

  return score;
}

// ============================================================
// CONDITIONS D'ENTRÉE
// ============================================================

function entryHealthy(data) {
  if (!data) {
    return false;
  }

  if (
    marketHistory.length < 8
  ) {
    return false;
  }

  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    return false;
  }

  const p10 =
    changePercent(
      data.price,
      getPointAgo(10000)?.price
    );

  const l10 =
    changePercent(
      data.liquidity,
      getPointAgo(10000)?.liquidity
    );

  const l30 =
    changePercent(
      data.liquidity,
      getPointAgo(30000)?.liquidity
    );

  if (
    p10 < ENTRY_MAX_PRICE_DROP_10S
  ) {
    return false;
  }

  if (
    l10 <
    ENTRY_MAX_LIQUIDITY_DROP_10S
  ) {
    return false;
  }

  if (
    l30 <
    ENTRY_MAX_LIQUIDITY_DROP_30S
  ) {
    return false;
  }

  if (
    healthScore < 80
  ) {
    return false;
  }

  if (
    favorableConfirmations < 4
  ) {
    return false;
  }

  if (
    Date.now() <
    observationUntil
  ) {
    return false;
  }

  // Aucun achat après 43 minutes
  if (
    noNewBuyAfter &&
    Date.now() >=
    noNewBuyAfter
  ) {
    return false;
  }

  if (
    lastOnchainEvent &&
    Date.now() -
      lastOnchainEvent.timestamp <
      30000 &&
    (
      lastOnchainEvent.type ===
        "WITHDRAWAL" ||
      lastOnchainEvent.type ===
        "SELL"
    )
  ) {
    return false;
  }

  return true;
}

// ============================================================
// CRASH
// ============================================================

function detectCrash(data) {
  if (!data) return null;

  const p10 =
    changePercent(
      data.price,
      getPointAgo(10000)?.price
    );

  const l10 =
    changePercent(
      data.liquidity,
      getPointAgo(10000)?.liquidity
    );

  if (
    data.liquidity <= 1
  ) {
    return {
      reason: "liquidité quasi nulle",
      p10,
      l10,
    };
  }

  if (
    p10 <= CRASH_PRICE_DROP_10S
  ) {
    return {
      reason: `prix ${p10.toFixed(2)}% / 10s`,
      p10,
      l10,
    };
  }

  if (
    l10 <= CRASH_LIQUIDITY_DROP_10S
  ) {
    return {
      reason: `liquidité ${l10.toFixed(2)}% / 10s`,
      p10,
      l10,
    };
  }

  return null;
}

// ============================================================
// ACHAT SIMULÉ
// ============================================================

function simulateBuy(data) {
  if (currentPosition) {
    return;
  }

  const tokens =
    CAPITAL_PER_CYCLE /
    data.price;

  const targetPrice =
    data.price *
    (1 + TARGET_PROFIT);

  currentPosition = {
    cycle:
      cycleNumber + 1,

    entryTime:
      now(),

    entryPrice:
      data.price,

    capital:
      CAPITAL_PER_CYCLE,

    tokens,

    targetPrice,
  };

  cycleNumber++;

  favorableConfirmations = 0;

  console.log("");
  console.log(
    `🟢 ACHAT TEST V5.4 #${currentPosition.cycle}`
  );

  console.log(
    "Token :",
    mintAddress
  );

  console.log(
    "Mise fixe :",
    `$${CAPITAL_PER_CYCLE.toFixed(4)}`
  );

  console.log(
    "Prix :",
    data.price.toFixed(10)
  );

  console.log(
    "Tokens :",
    tokens.toFixed(8)
  );

  console.log(
    "🎯 Objectif :",
    pct(TARGET_PROFIT * 100)
  );

  console.log(
    "Prix cible :",
    targetPrice.toFixed(10)
  );

  console.log(
    "💧 Liquidité :",
    `$${data.liquidity.toFixed(2)}`
  );

  console.log(
    "🧠 Score :",
    `${healthScore}/100`
  );

  console.log(
    "⛓️ Pool PumpSwap :",
    selectedPool || "null"
  );

  console.log(
    "🛡️ Confirmation :",
    `${favorableConfirmations}/4`
  );

  console.log(
    "🧪 Simulation uniquement."
  );

  sendTelegram(
    `🟢 ACHAT TEST V5.4 #${currentPosition.cycle}\n\n` +
    `Token :\n${mintAddress}\n\n` +
    `Mise fixe : $${CAPITAL_PER_CYCLE.toFixed(4)}\n` +
    `Prix : ${data.price.toFixed(10)}\n` +
    `Tokens : ${tokens.toFixed(8)}\n\n` +
    `🎯 Objectif : +5.00%\n` +
    `Prix cible : ${targetPrice.toFixed(10)}\n\n` +
    `💧 Liquidité : $${data.liquidity.toFixed(2)}\n` +
    `🧠 Score : ${healthScore}/100\n` +
    `⛓️ Pool : ${selectedPool || "null"}\n\n` +
    `🧪 Simulation uniquement.`
  );
}

// ============================================================
// VENTE SIMULÉE
// ============================================================

function simulateSell(
  data,
  reason = "TARGET"
) {
  if (!currentPosition) {
    return;
  }

  const position =
    currentPosition;

  let exitPrice =
    data.price;

  if (
    reason === "TARGET"
  ) {
    exitPrice =
      position.targetPrice;
  }

  if (
    !Number.isFinite(exitPrice) ||
    exitPrice <= 0
  ) {
    console.log(
      "⚠️ Prix de sortie invalide."
    );

    return;
  }

  const amount =
    position.tokens *
    exitPrice;

  const profit =
    amount -
    position.capital;

  const profitPct =
    (profit /
      position.capital) *
    100;

  const trade = {
    timestamp:
      new Date().toISOString(),

    mint:
      mintAddress,

    cycle:
      position.cycle,

    type:
      reason,

    entryPrice:
      position.entryPrice,

    exitPrice,

    capital:
      position.capital,

    amount,

    profit,

    profitPct,
  };

  tradeHistory.push(trade);

  totalProfit += profit;

  fs.writeFileSync(
    TRADE_FILE,
    JSON.stringify(
      tradeHistory,
      null,
      2
    )
  );

  console.log("");
  console.log(
    `🔴 VENTE TEST V5.4 #${position.cycle}`
  );

  console.log(
    "Type :",
    reason === "TARGET"
      ? "🎯 OBJECTIF"
      : "🟡 SORTIE DE SÉCURITÉ"
  );

  console.log(
    "Prix :",
    exitPrice.toFixed(10)
  );

  console.log(
    "Montant simulé :",
    `$${amount.toFixed(4)}`
  );

  console.log(
    "Résultat :",
    pct(profitPct)
  );

  console.log(
    "Bénéfice :",
    `${profit >= 0 ? "+" : ""}$${profit.toFixed(4)}`
  );

  console.log(
    "💰 Bénéfices cumulés :",
    `$${totalProfit.toFixed(4)}`
  );

  currentPosition = null;

  observationUntil =
    now() +
    OBSERVATION_AFTER_SELL_MS;

  favorableConfirmations = 0;

  sendTelegram(
    `🔴 VENTE TEST V5.4 #${position.cycle}\n\n` +
    `Type : ${
      reason === "TARGET"
        ? "🎯 OBJECTIF"
        : "🟡 SORTIE DE SÉCURITÉ"
    }\n\n` +
    `Prix : ${exitPrice.toFixed(10)}\n` +
    `Montant simulé : $${amount.toFixed(4)}\n` +
    `Résultat : ${pct(profitPct)}\n` +
    `Bénéfice : ${profit >= 0 ? "+" : ""}$${profit.toFixed(4)}\n\n` +
    `💰 Bénéfices cumulés : $${totalProfit.toFixed(4)}\n\n` +
    `⏳ Observation pendant 30 secondes.\n` +
    `❌ Aucun rachat immédiat.\n\n` +
    `🧪 Simulation uniquement.`
  );
}

// ============================================================
// RAPPORT CRASH
// ============================================================

function saveCrashReport(
  reason,
  event = null
) {
  const reports =
    safeReadJson(
      CRASH_FILE,
      []
    );

  const report = {
    id:
      `crash_${Date.now()}`,

    timestamp:
      new Date().toISOString(),

    sessionStart:
      sessionStart
        ? new Date(sessionStart).toISOString()
        : null,

    mint:
      mintAddress,

    pool:
      selectedPool,

    cyclesCompleted:
      cycleNumber,

    sessionProfit:
      totalProfit,

    reason,

    crashMarket:
      lastMarketData
        ? {
            price:
              lastMarketData.price,

            liquidity:
              lastMarketData.liquidity,

            score:
              healthScore,
          }
        : null,

    onchainEvent:
      event,

    openPosition:
      currentPosition
        ? {
            cycle:
              currentPosition.cycle,

            entryPrice:
              currentPosition.entryPrice,

            tokens:
              currentPosition.tokens,

            capital:
              currentPosition.capital,
          }
        : null,

    last60Seconds:
      marketHistory.filter(
        item =>
          item.timestamp >=
          now() - 60000
      ),

    onchainLastEvents:
      onchainEvents.slice(-50),
  };

  reports.push(report);

  fs.writeFileSync(
    CRASH_FILE,
    JSON.stringify(
      reports,
      null,
      2
    )
  );

  console.log(
    "📊 Rapport sauvegardé :",
    CRASH_FILE
  );
}

// ============================================================
// TICK PRINCIPAL
// ============================================================

let tickBusy = false;

async function marketTick() {
  if (!active) return;

  if (tickBusy) {
    return;
  }

  tickBusy = true;

  try {
    const data =
      await getDexMetrics();

    if (!data) {
      return;
    }

    lastMarketData =
      data;

    addMarketPoint(data);

    healthScore =
      calculateHealthScore(data);

    const p10 =
      changePercent(
        data.price,
        getPointAgo(10000)?.price
      );

    const l10 =
      changePercent(
        data.liquidity,
        getPointAgo(10000)?.liquidity
      );

    if (
      healthScore >= 80
    ) {
      favorableConfirmations++;

      if (
        favorableConfirmations > 4
      ) {
        favorableConfirmations = 4;
      }
    } else {
      favorableConfirmations = 0;
    }

    // --------------------------------------------------------
    // CRASH
    // --------------------------------------------------------

    const crash =
      detectCrash(data);

    if (
      crash &&
      currentPosition &&
      !emergencyTriggered
    ) {
      emergencyTriggered = true;

      console.log("");
      console.log(
        "🚨 STOP CRASH V5.4"
      );

      console.log(
        "Prix :",
        data.price.toFixed(10)
      );

      console.log(
        "Variation prix ~10s :",
        pct(crash.p10)
      );

      console.log(
        "Liquidité :",
        `$${data.liquidity.toFixed(2)}`
      );

      console.log(
        "Variation liquidité ~10s :",
        pct(crash.l10)
      );

      console.log(
        "🧠 Score :",
        `${healthScore}/100`
      );

      console.log(
        "⚠️ Position restante :",
        currentPosition.tokens
      );

      console.log(
        "⚠️ Prix de sortie NON considéré fiable."
      );

      saveCrashReport(
        crash.reason,
        lastOnchainEvent
      );

      await sendTelegram(
        `🚨 STOP CRASH V5.4\n\n` +
        `Token :\n${mintAddress}\n\n` +
        `Prix : ${data.price.toFixed(10)}\n` +
        `Variation prix ~10s : ${pct(crash.p10)}\n` +
        `Liquidité : $${data.liquidity.toFixed(2)}\n` +
        `Variation liquidité ~10s : ${pct(crash.l10)}\n\n` +
        `🧠 Score : ${healthScore}/100\n` +
        `⛓️ Pool : ${selectedPool || "null"}\n\n` +
        `⚠️ Position restante : ${currentPosition.tokens.toFixed(4)} tokens\n` +
        `⚠️ Prix de sortie NON considéré fiable.\n` +
        `⚠️ Aucun bénéfice fictif ajouté.\n\n` +
        `📊 Rapport sauvegardé.\n` +
        `⛔ Nouveau cycle bloqué.\n\n` +
        `🧪 Simulation uniquement.`
      );

      stopSession(
        `crash : ${crash.reason}`
      );

      return;
    }

    // --------------------------------------------------------
    // POSITION OUVERTE
    // --------------------------------------------------------

    if (currentPosition) {

      // Objectif atteint
      if (
        data.price >=
        currentPosition.targetPrice
      ) {
        simulateSell(
          data,
          "TARGET"
        );

        return;
      }

      // ------------------------------------------------------
      // LIMITE 45 MINUTES
      // ------------------------------------------------------

      if (
        now() -
          currentPosition.entryTime >=
        MAX_SESSION_MS
      ) {
        console.log("");
        console.log(
          "⏱️ LIMITE DE TEMPS ATTEINTE AVEC POSITION OUVERTE"
        );

        console.log(
          "🛡️ SORTIE DE SÉCURITÉ OBLIGATOIRE"
        );

        /*
         * Très important :
         * on ne laisse jamais la position orpheline.
         */

        simulateSell(
          data,
          "SESSION_LIMIT"
        );

        return;
      }

      return;
    }

    // --------------------------------------------------------
    // FIN DE SESSION À 45 MINUTES
    // --------------------------------------------------------

    if (
      sessionStart &&
      now() -
        sessionStart >=
      MAX_SESSION_MS
    ) {
      stopSession(
        "limite de session 45 minutes"
      );

      return;
    }

    // --------------------------------------------------------
    // PAS DE NOUVEL ACHAT APRÈS 43 MINUTES
    // --------------------------------------------------------

    if (
      noNewBuyAfter &&
      now() >=
      noNewBuyAfter
    ) {
      return;
    }

    // --------------------------------------------------------
    // ACHAT
    // --------------------------------------------------------

    if (
      entryHealthy(data)
    ) {
      simulateBuy(data);
    }

  } finally {
    tickBusy = false;
  }
}

// ============================================================
// DÉMARRER SESSION
// ============================================================

async function startSession(
  tokenMint
) {
  if (active) {
    await sendTelegram(
      "⚠️ Une session est déjà active."
    );

    return;
  }

  try {
    mintAddress =
      new PublicKey(
        tokenMint.trim()
      ).toBase58();

  } catch {
    await sendTelegram(
      "❌ Adresse token invalide."
    );

    return;
  }

  active = true;

  emergencyTriggered = false;

  sessionStart =
    now();

  cycleNumber = 0;

  currentPosition = null;

  marketHistory = [];

  favorableConfirmations = 0;

  observationUntil = 0;

  /*
   * IMPORTANT :
   *
   * V5.3 avait une erreur ici :
   * il bloquait les achats pendant les
   * premières 43 minutes.
   *
   * Maintenant :
   * les achats sont autorisés immédiatement,
   * puis interdits à partir de la 43e minute.
   */

  noNewBuyAfter =
    sessionStart +
    NO_NEW_BUY_AFTER_MS;

  selectedPool = null;

  poolBaseVault = null;
  poolQuoteVault = null;

  poolQuoteReserve = null;
  poolVirtualQuoteReserve = 0;
  effectiveQuoteReserve = null;

  onchainReady = false;

  lastBaseVault = null;
  lastQuoteVault = null;

  pendingBaseChange = null;
  pendingQuoteChange = null;

  lastOnchainEvent = null;

  onchainEvents = [];

  healthScore = 100;

  // ----------------------------------------------------------
  // RECHERCHE DU POOL
  // ----------------------------------------------------------

  const pool =
    await discoverPumpSwapPool();

  if (!pool) {
    active = false;

    await sendTelegram(
      `❌ V5.4 ARRÊTÉE\n\n` +
      `Token :\n${mintAddress}\n\n` +
      `Aucun pool PumpSwap SOL valide trouvé.\n\n` +
      `Le bot ne lance pas la surveillance on-chain sans pool confirmé.`
    );

    return;
  }

  // ----------------------------------------------------------
  // WSS
  // ----------------------------------------------------------

  connectPumpSwapWebSocket();

  // ----------------------------------------------------------
  // TELEGRAM
  // ----------------------------------------------------------

  await sendTelegram(
    `🚀 V5.4 DÉMARRÉE\n\n` +
    `Token :\n${mintAddress}\n\n` +
    `💵 Capital : $${CAPITAL_PER_CYCLE.toFixed(4)}\n` +
    `🎯 Objectif : +5.00%\n\n` +
    `🔎 Pool PumpSwap :\n${selectedPool}\n\n` +
    `⛓️ Surveillance :\nbase vault + quote vault + pool\n\n` +
    `⚡ Protection :\nretrait / mouvement on-chain\n\n` +
    `⏳ Observation après vente : 30 secondes\n` +
    `⏱️ Aucun nouvel achat après 43 minutes\n` +
    `🛑 Fin de session : 45 minutes\n\n` +
    `🧪 SIMULATION UNIQUEMENT`
  );

  pollTimer =
    setInterval(
      marketTick,
      POLL_INTERVAL_MS
    );

  sessionTimer =
    setTimeout(
      () => {

        /*
         * Si une position est encore ouverte,
         * on NE coupe PAS brutalement ici.
         *
         * marketTick va effectuer la sortie
         * de sécurité au prochain passage.
         */

        if (!currentPosition) {
          stopSession(
            "limite de session 45 minutes"
          );
        }

      },
      MAX_SESSION_MS + 3000
    );

  await marketTick();
}

// ============================================================
// ARRÊT SESSION
// ============================================================

function stopSession(reason) {
  if (!active) {
    return;
  }

  active = false;

  sessionStopReason =
    reason;

  if (pollTimer) {
    clearInterval(
      pollTimer
    );

    pollTimer = null;
  }

  if (sessionTimer) {
    clearTimeout(
      sessionTimer
    );

    sessionTimer = null;
  }

  if (ws) {
    try {
      ws.close();
    } catch {}

    ws = null;
  }

  onchainReady = false;

  console.log("");
  console.log(
    "⛔ SESSION V5.4 ARRÊTÉE"
  );

  console.log(
    "Token :",
    mintAddress
  );

  console.log(
    "Raison :",
    reason
  );

  console.log(
    "Cycles :",
    cycleNumber
  );

  console.log(
    "💰 Bénéfices :",
    `$${totalProfit.toFixed(4)}`
  );

  if (currentPosition) {
    console.log(
      "⚠️ ATTENTION : position encore ouverte."
    );
  } else {
    console.log(
      "⚪ Aucune position ouverte."
    );
  }

  sendTelegram(
    `⛔ SESSION V5.4 ARRÊTÉE\n\n` +
    `Token :\n${mintAddress}\n\n` +
    `Raison : ${reason}\n\n` +
    `Cycles : ${cycleNumber}\n` +
    `💰 Bénéfices : $${totalProfit.toFixed(4)}\n\n` +
    (
      currentPosition
        ? `⚠️ Position encore ouverte.\n`
        : `⚪ Aucune position ouverte.\n`
    ) +
    `\n🧪 Simulation uniquement.`
  );
}

// ============================================================
// COMMANDES TELEGRAM
// ============================================================

bot.command(
  "starttrade",
  async ctx => {

    const args =
      ctx.message.text
        .split(/\s+/)
        .slice(1);

    if (!args[0]) {
      await ctx.reply(
        "Utilisation :\n/starttrade MINT"
      );

      return;
    }

    await startSession(
      args[0]
    );
  }
);

bot.command(
  "stoptrade",
  async ctx => {

    if (!active) {
      await ctx.reply(
        "⚪ Aucune session active."
      );

      return;
    }

    stopSession(
      "arrêt manuel"
    );
  }
);

bot.command(
  "status",
  async ctx => {

    await ctx.reply(
      `📊 STATUS V5.4\n\n` +
      `Actif : ${active ? "🟢 OUI" : "🔴 NON"}\n` +
      `Token : ${mintAddress || "aucun"}\n` +
      `Pool : ${selectedPool || "null"}\n` +
      `On-chain : ${onchainReady ? "🟢 ACTIVE" : "🔴 INACTIVE"}\n` +
      `Position : ${currentPosition ? "🟢 OUVERTE" : "⚪ AUCUNE"}\n` +
      `Cycle : ${currentPosition?.cycle || "-"}\n` +
      `Score : ${healthScore}/100\n` +
      `Cycles terminés : ${cycleNumber}\n` +
      `Bénéfices : $${totalProfit.toFixed(4)}\n\n` +
      `🧪 Simulation uniquement.`
    );
  }
);

bot.command(
  "lastcrash",
  async ctx => {

    const reports =
      safeReadJson(
        CRASH_FILE,
        []
      );

    if (
      !reports.length
    ) {
      await ctx.reply(
        "⚪ Aucun rapport de crash."
      );

      return;
    }

    const last =
      reports[
        reports.length - 1
      ];

    await ctx.reply(
      `📊 DERNIER RAPPORT\n\n` +
      `Token : ${shortMint(last.mint)}\n` +
      `Date : ${last.timestamp}\n` +
      `Raison : ${last.reason}\n` +
      `Pool : ${last.pool || "null"}\n` +
      `Cycles : ${last.cyclesCompleted}\n` +
      `Profit : $${Number(last.sessionProfit || 0).toFixed(4)}\n\n` +
      `🧪 Simulation uniquement.`
    );
  }
);

bot.command(
  "help",
  async ctx => {

    await ctx.reply(
      `🤖 V5.4\n\n` +
      `/starttrade MINT\n` +
      `/stoptrade\n` +
      `/status\n` +
      `/lastcrash\n` +
      `/help\n\n` +
      `💵 Mise : $10\n` +
      `🎯 Objectif : +5%\n` +
      `⏳ Observation : 30s\n` +
      `⏱️ Pas de nouvel achat après 43 min\n` +
      `🛑 Sortie obligatoire si position à 45 min\n` +
      `⚡ Protection on-chain PumpSwap\n\n` +
      `🧪 Simulation uniquement.`
    );
  }
);

// ============================================================
// DÉMARRAGE
// ============================================================

bot.launch()
  .then(() => {
    console.log(
      "🤖 Bot Telegram V5.4 démarré."
    );
  })
  .catch(error => {
    console.error(
      "❌ Bot launch :",
      error.message
    );
  });

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
