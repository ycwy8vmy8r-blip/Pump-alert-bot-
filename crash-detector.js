require("dotenv").config();

const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ============================================================
// CONFIG
// ============================================================

const MINT = "Rcopty53MejswAzB26spbwggKxtJf59cHefbwCzpump";

const PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SOLANA_HTTP =
  "https://api.mainnet-beta.solana.com";

const SOLANA_WS =
  "wss://api.mainnet-beta.solana.com/";

const DEX_TOKEN_PAIRS_URL =
  `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;

const DEX_SEARCH_URL =
  "https://api.dexscreener.com/latest/dex/search?q=SOL%2FUSDC";

const DATA_DIR =
  fs.existsSync("/data")
    ? "/data"
    : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const LOG_FILE =
  path.join(DATA_DIR, "crash_radar_v3.jsonl");

// ============================================================
// RADAR SETTINGS
// ============================================================

const SAMPLE_INTERVAL_MS = 5000;

const HISTORY_WINDOW_MS = 30000;

const EVENT_MEMORY_MS = 120000;

const DEX_CONFIRMATION_DROP = -5;

// On-chain liquidity removal
const ONCHAIN_WARNING_5S = -5;
const ONCHAIN_DANGER_5S = -10;
const ONCHAIN_CRITICAL_5S = -20;

// 10 seconds, used as confirmation
const ONCHAIN_WARNING_10S = -8;
const ONCHAIN_DANGER_10S = -15;
const ONCHAIN_CRITICAL_10S = -30;

// Sell pressure
const SELL_PRESSURE_SOL_5S = -5;
const STRONG_SELL_PRESSURE_SOL_5S = -10;

// WebSocket reconnect
const WS_RECONNECT_MS = 5000;

// ============================================================
// STATE
// ============================================================

let poolAddress = null;

let poolBaseMint = null;
let poolQuoteMint = null;

let tokenVault = null;
let solVault = null;

let tokenDecimals = 6;

let solPriceUsd = null;

let lastValidDexPrice = null;
let lastValidDexLiquidity = null;

let lastDexTimestamp = null;

let lastTokenReserve = null;
let lastSolReserve = null;

let ws = null;

let tokenSubscriptionId = null;
let solSubscriptionId = null;

let wsConnected = false;
let wsLastMessageAt = 0;

let tokenReserveRaw = null;
let solReserveLamports = null;

let history = [];

let activeEvent = null;

let lastTelegramAlertAt = 0;

let shuttingDown = false;

// ============================================================
// UTILS
// ============================================================

function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "N/A";
  }

  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function appendLog(data) {
  try {
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...data
      }) + "\n"
    );
  } catch (err) {
    console.log(
      "⚠️ Impossible d'écrire le log :",
      err.message
    );
  }
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("⚠️ Telegram non configuré.");
    return;
  }

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message
        })
      }
    );

    if (!response.ok) {
      const body = await response.text();

      console.log(
        "⚠️ Telegram erreur :",
        response.status,
        body
      );
    }
  } catch (err) {
    console.log(
      "⚠️ Telegram indisponible :",
      err.message
    );
  }
}

// ============================================================
// SOLANA RPC
// ============================================================

async function solanaRpc(method, params = []) {
  const response = await fetch(SOLANA_HTTP, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(
      `Solana RPC HTTP ${response.status}`
    );
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(
      json.error.message || "Solana RPC error"
    );
  }

  return json.result;
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexTokenPairs() {
  const response = await fetch(
    DEX_TOKEN_PAIRS_URL
  );

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  return response.json();
}

// ============================================================
// SOL/USD
// ============================================================

async function getSolPriceUsd() {
  try {
    const url =
      `https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT},${USDC_MINT}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `DexScreener SOL/USD HTTP ${response.status}`
      );
    }

    const data = await response.json();

    const pairs = Array.isArray(data)
      ? data
      : [];

    const validPairs = pairs.filter(pair => {
      if (!pair) return false;

      if (pair.chainId !== "solana") {
        return false;
      }

      if (!pair.baseToken || !pair.quoteToken) {
        return false;
      }

      const base =
        pair.baseToken.address;

      const quote =
        pair.quoteToken.address;

      const isSolUsdc =
        (base === SOL_MINT && quote === USDC_MINT) ||
        (base === USDC_MINT && quote === SOL_MINT);

      if (!isSolUsdc) {
        return false;
      }

      const price =
        Number(pair.priceUsd);

      return (
        Number.isFinite(price) &&
        price > 0
      );
    });

    if (!validPairs.length) {
      throw new Error(
        "Aucune paire SOL/USDC valide trouvée"
      );
    }

    // On prend la paire SOL/USDC
    // avec la plus grosse liquidité.
    validPairs.sort((a, b) => {
      const liquidityA =
        Number(a.liquidity?.usd) || 0;

      const liquidityB =
        Number(b.liquidity?.usd) || 0;

      return liquidityB - liquidityA;
    });

    const price =
      Number(validPairs[0].priceUsd);

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      throw new Error(
        "Prix SOL/USD invalide"
      );
    }

    solPriceUsd = price;

    return price;

  } catch (err) {

    // Si DexScreener répond temporairement mal,
    // on conserve le dernier prix connu.
    if (
      solPriceUsd !== null &&
      Number.isFinite(solPriceUsd)
    ) {
      console.log(
        `⚠️ SOL/USD indisponible, conservation de $${formatNumber(solPriceUsd, 4)}`
      );

      return solPriceUsd;
    }

    throw err;
  }
}

// ============================================================
// FIND PUMPSWAP POOL
// ============================================================

async function findPool() {
  const data = await getDexTokenPairs();

  const pairs = Array.isArray(data)
    ? data
    : [];

  const pumpPairs = pairs.filter(
    pair =>
      pair &&
      pair.dexId === "pumpswap" &&
      pair.pairAddress
  );

  if (!pumpPairs.length) {
    throw new Error(
      "Aucune paire PumpSwap trouvée"
    );
  }

  pumpPairs.sort((a, b) => {
    const liqA =
      Number(a.liquidity?.usd) || 0;

    const liqB =
      Number(b.liquidity?.usd) || 0;

    return liqB - liqA;
  });

  return pumpPairs[0];
}

// ============================================================
// GET PINNED POOL DATA
// ============================================================

async function getPinnedPoolData() {
  if (!poolAddress) {
    throw new Error(
      "Pool PumpSwap non défini"
    );
  }

  const url =
    `https://api.dexscreener.com/latest/dex/pairs/solana/${poolAddress}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `DexScreener pool HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const pair =
    data.pair ||
    (Array.isArray(data.pairs)
      ? data.pairs[0]
      : null);

  if (!pair) {
    throw new Error(
      "Données DEX introuvables pour le pool"
    );
  }

  let priceUsd =
    Number(pair.priceUsd);

  let liquidityUsd =
    Number(pair.liquidity?.usd);

  if (
    !Number.isFinite(priceUsd) ||
    priceUsd <= 0
  ) {
    priceUsd = lastValidDexPrice;
  }

  if (
    !Number.isFinite(liquidityUsd) ||
    liquidityUsd <= 0
  ) {
    liquidityUsd =
      lastValidDexLiquidity;
  }

  const validPrice =
    Number.isFinite(priceUsd) &&
    priceUsd > 0;

  const validLiquidity =
    Number.isFinite(liquidityUsd) &&
    liquidityUsd > 0;

  if (validPrice) {
    lastValidDexPrice = priceUsd;
  }

  if (validLiquidity) {
    lastValidDexLiquidity = liquidityUsd;
  }

  lastDexTimestamp = Date.now();

  return {
    priceUsd:
      validPrice
        ? priceUsd
        : null,

    liquidityUsd:
      validLiquidity
        ? liquidityUsd
        : null,

    dataGap:
      !validPrice ||
      !validLiquidity,

    pair
  };
}

// ============================================================
// POOL ACCOUNT DECODING
// ============================================================

function readPubkey(buffer, offset) {
  return new (require("@solana/web3.js").PublicKey)(
    buffer.slice(offset, offset + 32)
  ).toBase58();
}

async function decodePool(poolPubkey) {
  const result =
    await solanaRpc(
      "getAccountInfo",
      [
        poolPubkey,
        {
          encoding: "base64"
        }
      ]
    );

  if (!result || !result.value) {
    throw new Error(
      "Compte pool introuvable"
    );
  }

  const data =
    Buffer.from(
      result.value.data[0],
      "base64"
    );

  console.log(
    `Taille du compte pool : ${data.length} bytes`
  );

  if (data.length < 203) {
    throw new Error(
      "Compte pool trop petit"
    );
  }

  const baseMint =
    readPubkey(data, 43);

  const quoteMint =
    readPubkey(data, 75);

  const baseVault =
    readPubkey(data, 139);

  const quoteVault =
    readPubkey(data, 171);

  console.log(
    `Base mint  : ${baseMint}`
  );

  console.log(
    `Quote mint : ${quoteMint}`
  );

  if (
    baseMint === MINT &&
    quoteMint === SOL_MINT
  ) {
    console.log(
      "🟢 Orientation : TOKEN → SOL"
    );

    tokenVault = baseVault;
    solVault = quoteVault;

  } else if (
    baseMint === SOL_MINT &&
    quoteMint === MINT
  ) {
    console.log(
      "🟢 Orientation : SOL → TOKEN"
    );

    solVault = baseVault;
    tokenVault = quoteVault;

  } else {
    throw new Error(
      "Le pool ne correspond pas au token surveillé"
    );
  }

  poolBaseMint = baseMint;
  poolQuoteMint = quoteMint;

  console.log(
    `Token vault : ${tokenVault}`
  );

  console.log(
    `SOL vault   : ${solVault}`
  );
}

// ============================================================
// TOKEN DECIMALS
// ============================================================

async function getTokenDecimals() {
  try {
    const result =
      await solanaRpc(
        "getTokenSupply",
        [MINT]
      );

    const decimals =
      Number(
        result?.value?.decimals
      );

    if (
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 18
    ) {
      tokenDecimals = decimals;
    }
  } catch (err) {
    console.log(
      "⚠️ Impossible de récupérer les décimales, utilisation de 6."
    );

    tokenDecimals = 6;
  }

  console.log(
    `Décimales token : ${tokenDecimals}`
  );
}

// ============================================================
// ACCOUNT DATA DECODING
// ============================================================

function decodeTokenVault(data) {
  if (!data || data.length < 72) {
    return null;
  }

  const amount =
    data.readBigUInt64LE(64);

  return (
    Number(amount) /
    Math.pow(10, tokenDecimals)
  );
}

function decodeSolVault(lamports) {
  return (
    Number(lamports) /
    1_000_000_000
  );
}

// ============================================================
// READ VAULTS
// ============================================================

async function readInitialVaults() {
  const result =
    await solanaRpc(
      "getMultipleAccounts",
      [
        [
          tokenVault,
          solVault
        ],
        {
          encoding: "base64"
        }
      ]
    );

  const accounts =
    result?.value || [];

  if (accounts.length !== 2) {
    throw new Error(
      "Impossible de lire les deux vaults"
    );
  }

  const tokenAccount =
    accounts[0];

  const solAccount =
    accounts[1];

  if (
    !tokenAccount ||
    !tokenAccount.data
  ) {
    throw new Error(
      "Token vault introuvable"
    );
  }

  if (
    !solAccount ||
    solAccount.lamports === undefined
  ) {
    throw new Error(
      "SOL vault introuvable"
    );
  }

  const tokenBuffer =
    Buffer.from(
      tokenAccount.data[0],
      "base64"
    );

  tokenReserveRaw =
    tokenBuffer.readBigUInt64LE(64);

  solReserveLamports =
    BigInt(solAccount.lamports);

  lastTokenReserve =
    Number(tokenReserveRaw) /
    Math.pow(10, tokenDecimals);

  lastSolReserve =
    Number(solReserveLamports) /
    1_000_000_000;

  return {
    tokenReserve: lastTokenReserve,
    solReserve: lastSolReserve
  };
}

// ============================================================
// WEBSOCKET
// ============================================================

function connectWebSocket() {
  if (shuttingDown) {
    return;
  }

  console.log(
    "🔌 Connexion WebSocket Solana..."
  );

  ws = new WebSocket(SOLANA_WS);

  ws.on("open", () => {
    wsConnected = true;
    wsLastMessageAt = Date.now();

    console.log(
      "🟢 WebSocket Solana connecté."
    );

    subscribeVaults();
  });

  ws.on("message", message => {
    wsLastMessageAt = Date.now();

    try {
      const data =
        JSON.parse(
          message.toString()
        );

      handleWsMessage(data);

    } catch (err) {
      console.log(
        "⚠️ Message WebSocket invalide :",
        err.message
      );
    }
  });

  ws.on("close", () => {
    wsConnected = false;

    tokenSubscriptionId = null;
    solSubscriptionId = null;

    console.log(
      "⚠️ WebSocket fermé."
    );

    if (!shuttingDown) {
      setTimeout(
        connectWebSocket,
        WS_RECONNECT_MS
      );
    }
  });

  ws.on("error", err => {
    console.log(
      "⚠️ WebSocket erreur :",
      err.message
    );
  });
}

// ============================================================
// SUBSCRIPTIONS
// ============================================================

function subscribeVaults() {
  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "accountSubscribe",
      params: [
        tokenVault,
        {
          encoding: "base64",
          commitment: "confirmed"
        }
      ]
    })
  );

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "accountSubscribe",
      params: [
        solVault,
        {
          encoding: "base64",
          commitment: "confirmed"
        }
      ]
    })
  );
}

// ============================================================
// WEBSOCKET MESSAGE HANDLER
// ============================================================

function handleWsMessage(data) {
  if (
    data.id === 1 &&
    data.result !== undefined
  ) {
    tokenSubscriptionId =
      data.result;

    return;
  }

  if (
    data.id === 2 &&
    data.result !== undefined
  ) {
    solSubscriptionId =
      data.result;

    return;
  }

  if (
    !data.params ||
    !data.params.result
  ) {
    return;
  }

  const subscription =
    data.params.subscription;

  const account =
    data.params.result.value;

  if (!account) {
    return;
  }

  if (
    subscription ===
    tokenSubscriptionId
  ) {
    try {
      const buffer =
        Buffer.from(
          account.data[0],
          "base64"
        );

      tokenReserveRaw =
        buffer.readBigUInt64LE(64);

    } catch (err) {
      console.log(
        "⚠️ Décodage token vault :",
        err.message
      );
    }

  } else if (
    subscription ===
    solSubscriptionId
  ) {
    try {
      solReserveLamports =
        BigInt(account.lamports);

    } catch (err) {
      console.log(
        "⚠️ Décodage SOL vault :",
        err.message
      );
    }
  }
}

// ============================================================
// CURRENT RESERVES
// ============================================================

function getCurrentReserves() {
  let tokenReserve =
    lastTokenReserve;

  let solReserve =
    lastSolReserve;

  if (tokenReserveRaw !== null) {
    tokenReserve =
      Number(tokenReserveRaw) /
      Math.pow(10, tokenDecimals);
  }

  if (solReserveLamports !== null) {
    solReserve =
      Number(solReserveLamports) /
      1_000_000_000;
  }

  return {
    tokenReserve,
    solReserve
  };
}

// ============================================================
// CHANGE CALCULATIONS
// ============================================================

function percentChange(oldValue, newValue) {
  if (
    oldValue === null ||
    oldValue === undefined ||
    oldValue === 0 ||
    newValue === null ||
    newValue === undefined
  ) {
    return null;
  }

  return (
    ((newValue - oldValue) /
      oldValue) *
    100
  );
}

function getPreviousSnapshot(msAgo) {
  const target =
    Date.now() - msAgo;

  let best = null;

  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].timestamp <= target) {
      best = history[i];
      break;
    }
  }

  return best;
}

// ============================================================
// ON-CHAIN CLASSIFICATION
// ============================================================

function classifyOnchain(
  sol5,
  token5,
  sol10,
  token10
) {
  const simultaneousRemoval =
    sol5 !== null &&
    token5 !== null &&
    sol5 <= ONCHAIN_WARNING_5S &&
    token5 <= ONCHAIN_WARNING_5S;

  const criticalRemoval =
    sol5 !== null &&
    token5 !== null &&
    (
      sol5 <= ONCHAIN_CRITICAL_5S ||
      token5 <= ONCHAIN_CRITICAL_5S ||
      (
        sol10 !== null &&
        token10 !== null &&
        (
          sol10 <= ONCHAIN_CRITICAL_10S ||
          token10 <= ONCHAIN_CRITICAL_10S
        )
      )
    );

  const dangerRemoval =
    sol5 !== null &&
    token5 !== null &&
    (
      sol5 <= ONCHAIN_DANGER_5S ||
      token5 <= ONCHAIN_DANGER_5S ||
      (
        sol10 !== null &&
        token10 !== null &&
        (
          sol10 <= ONCHAIN_DANGER_10S ||
          token10 <= ONCHAIN_DANGER_10S
        )
      )
    );

  const warningRemoval =
    simultaneousRemoval;

  if (criticalRemoval) {
    return {
      level: "CRITICAL",
      type: "LIQUIDITY_REMOVAL_SUSPECTED"
    };
  }

  if (dangerRemoval) {
    return {
      level: "DANGER",
      type: "LIQUIDITY_REMOVAL_SUSPECTED"
    };
  }

  if (warningRemoval) {
    return {
      level: "WATCH",
      type: "LIQUIDITY_REMOVAL_SUSPECTED"
    };
  }

  const strongSell =
    sol5 !== null &&
    sol5 <= STRONG_SELL_PRESSURE_SOL_5S &&
    token5 !== null &&
    token5 >= 0;

  if (strongSell) {
    return {
      level: "DANGER",
      type: "STRONG_SELL_PRESSURE"
    };
  }

  const sellPressure =
    sol5 !== null &&
    sol5 <= SELL_PRESSURE_SOL_5S &&
    token5 !== null &&
    token5 >= 0;

  if (sellPressure) {
    return {
      level: "WATCH",
      type: "SELL_PRESSURE"
    };
  }

  return {
    level: "NORMAL",
    type: null
  };
}

// ============================================================
// LEVEL RANKING
// ============================================================

function levelRank(level) {
  switch (level) {
    case "CRITICAL":
      return 3;

    case "DANGER":
      return 2;

    case "WATCH":
      return 1;

    default:
      return 0;
  }
}

function maxLevel(a, b) {
  return levelRank(a) >= levelRank(b)
    ? a
    : b;
}

// ============================================================
// EVENT MANAGEMENT
// ============================================================

function createEvent(
  classification,
  snapshot
) {
  const now =
    Date.now();

  if (
    activeEvent &&
    now -
      activeEvent.lastDetectedAt <
      EVENT_MEMORY_MS
  ) {
    activeEvent.lastDetectedAt =
      now;

    activeEvent.level =
      maxLevel(
        activeEvent.level,
        classification.level
      );

    activeEvent.detections =
      (activeEvent.detections || 0) + 1;

    return activeEvent;
  }

  activeEvent = {
    id:
      `${now}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,

    createdAt:
      new Date(now).toISOString(),

    firstDetectedAt:
      now,

    lastDetectedAt:
      now,

    level:
      classification.level,

    type:
      classification.type,

    detections: 1,

    dexConfirmed: false,

    telegramSent: false,

    telegramDexSent: false,

    onchainSnapshot:
      snapshot
  };

  appendLog({
    event: "ONCHAIN_EARLY_WARNING",
    eventId: activeEvent.id,
    type: activeEvent.type,
    level: activeEvent.level,
    snapshot
  });

  return activeEvent;
}

// ============================================================
// EVENT UPDATE
// ============================================================

async function updateEvent(
  classification,
  snapshot,
  dexData
) {
  const now =
    Date.now();

  if (
    activeEvent &&
    now -
      activeEvent.lastDetectedAt >
      EVENT_MEMORY_MS
  ) {
    activeEvent = null;
  }

  if (
    classification.level !==
    "NORMAL"
  ) {
    const event =
      createEvent(
        classification,
        snapshot
      );

    event.level =
      maxLevel(
        event.level,
        classification.level
      );

    event.lastSnapshot =
      snapshot;

    if (
      !event.telegramSent &&
      now - lastTelegramAlertAt > 30000
    ) {
      event.telegramSent = true;
      lastTelegramAlertAt = now;

      await sendTelegram(
        `🚨 CRASH RADAR V3\n\n` +
        `🪙 ${MINT}\n` +
        `🏊 Pool : ${poolAddress}\n\n` +
        `⚠️ ${event.type}\n` +
        `🔴 Niveau : ${event.level}\n\n` +
        `📉 SOL reserve / 5s : ${formatNumber(snapshot.sol5, 2)}%\n` +
        `📉 Token reserve / 5s : ${formatNumber(snapshot.token5, 2)}%\n\n` +
        `💵 Prix DEX : $${formatNumber(dexData.priceUsd, 8)}\n` +
        `💧 Liquidité DEX : $${formatNumber(dexData.liquidityUsd, 2)}`
      );
    }
  }

  if (
    activeEvent &&
    !activeEvent.dexConfirmed &&
    dexData.liquidityUsd !== null &&
    lastValidDexLiquidity !== null
  ) {
    const dexDrop =
      percentChange(
        activeEvent.dexReferenceLiquidity ||
          dexData.previousLiquidity ||
          dexData.liquidityUsd,
        dexData.liquidityUsd
      );

    if (
      activeEvent.dexReferenceLiquidity === undefined
    ) {
      activeEvent.dexReferenceLiquidity =
        dexData.liquidityUsd;
    }
  }
}

// ============================================================
// DEX CONFIRMATION
// ============================================================

async function checkDexConfirmation(
  event,
  dexData,
  snapshot
) {
  if (!event) {
    return;
  }

  if (
    event.dexConfirmed
  ) {
    return;
  }

  if (
    dexData.liquidityUsd === null
  ) {
    return;
  }

  if (
    event.dexReferenceLiquidity === undefined
  ) {
    event.dexReferenceLiquidity =
      dexData.liquidityUsd;

    return;
  }

  const dexDrop =
    percentChange(
      event.dexReferenceLiquidity,
      dexData.liquidityUsd
    );

  if (
    dexDrop !== null &&
    dexDrop <= DEX_CONFIRMATION_DROP
  ) {
    event.dexConfirmed = true;

    const leadTime =
      Date.now() -
      event.firstDetectedAt;

    appendLog({
      event: "DEX_CONFIRMED",
      eventId: event.id,
      dexDrop,
      leadTimeMs: leadTime,
      leadTimeSeconds:
        leadTime / 1000,
      snapshot
    });

    await sendTelegram(
      `📡 DEX CONFIRMATION\n\n` +
      `🪙 ${MINT}\n` +
      `🏊 Pool : ${poolAddress}\n\n` +
      `🟥 Liquidité DEX : -${Math.abs(dexDrop).toFixed(2)}%\n` +
      `⏱️ Détection on-chain → DEX : ${(leadTime / 1000).toFixed(1)} s\n\n` +
      `💧 Liquidité actuelle : $${formatNumber(dexData.liquidityUsd, 2)}`
    );
  }
}

// ============================================================
// MAIN MONITOR
// ============================================================

async function monitor() {
  try {
    const reserves =
      getCurrentReserves();

    if (
      !Number.isFinite(
        reserves.tokenReserve
      ) ||
      !Number.isFinite(
        reserves.solReserve
      )
    ) {
      return;
    }

    const timestamp =
      Date.now();

    const previous5 =
      getPreviousSnapshot(5000);

    const previous10 =
      getPreviousSnapshot(10000);

    const sol5 =
      previous5
        ? percentChange(
            previous5.solReserve,
            reserves.solReserve
          )
        : null;

    const token5 =
      previous5
        ? percentChange(
            previous5.tokenReserve,
            reserves.tokenReserve
          )
        : null;

    const sol10 =
      previous10
        ? percentChange(
            previous10.solReserve,
            reserves.solReserve
          )
        : null;

    const token10 =
      previous10
        ? percentChange(
            previous10.tokenReserve,
            reserves.tokenReserve
          )
        : null;

    const dexData =
      await getPinnedPoolData();

    const classification =
      classifyOnchain(
        sol5,
        token5,
        sol10,
        token10
      );

    const snapshot = {
      timestamp,

      solReserve:
        reserves.solReserve,

      tokenReserve:
        reserves.tokenReserve,

      sol5,
      token5,

      sol10,
      token10,

      dexPrice:
        dexData.priceUsd,

      dexLiquidity:
        dexData.liquidityUsd,

      dexDataGap:
        dexData.dataGap,

      wsConnected,

      wsLastMessageAt
    };

    history.push(snapshot);

    const cutoff =
      timestamp -
      HISTORY_WINDOW_MS;

    history =
      history.filter(
        item =>
          item.timestamp >= cutoff
      );

    await updateEvent(
      classification,
      snapshot,
      dexData
    );

    await checkDexConfirmation(
      activeEvent,
      dexData,
      snapshot
    );

    const activeLevel =
      activeEvent
        ? activeEvent.level
        : "NORMAL";

    let displayLevel =
      maxLevel(
        classification.level,
        activeLevel
      );

    if (
      activeEvent &&
      activeEvent.dexConfirmed &&
      displayLevel === "NORMAL"
    ) {
      displayLevel =
        activeEvent.level;
    }

    const eventType =
      activeEvent?.type ||
      classification.type ||
      null;

    console.log(
      `[RADAR] Prix $${formatNumber(dexData.priceUsd, 8)} | ` +
      `DEX Liq $${formatNumber(dexData.liquidityUsd, 2)} | ` +
      `ONCHAIN ${classification.level} | ` +
      `${displayLevel} | ` +
      `${eventType || "NORMAL"} | ` +
      `WS ${wsConnected ? "LIVE" : "OFFLINE"}`
    );

    console.log(
      `[VAULT] SOL ${formatNumber(reserves.solReserve, 6)} | ` +
      `TOKEN ${formatNumber(reserves.tokenReserve, 4)} | ` +
      `SOL5 ${formatNumber(sol5, 2)}% | ` +
      `TOKEN5 ${formatNumber(token5, 2)}% | ` +
      `SOL10 ${formatNumber(sol10, 2)}% | ` +
      `TOKEN10 ${formatNumber(token10, 2)}%`
    );

    appendLog({
      event: "SNAPSHOT",
      level: displayLevel,
      eventType,
      activeEvent:
        activeEvent
          ? activeEvent.id
          : null,
      snapshot
    });

  } catch (err) {
    console.log(
      "⚠️ Erreur radar :",
      err.message
    );

    appendLog({
      event: "ERROR",
      message: err.message
    });
  }
}

// ============================================================
// INITIALIZATION
// ============================================================

async function init() {
  console.log("");
  console.log("================================");
  console.log("      CRASH RADAR V3");
  console.log("================================");

  console.log(
    `🪙 Token : ${MINT}`
  );

  // ----------------------------------------------------------
  // Find PumpSwap pool
  // ----------------------------------------------------------

  const pair =
    await findPool();

  poolAddress =
    pair.pairAddress;

  console.log(
    `🏊 Pool PumpSwap : ${poolAddress}`
  );

  // ----------------------------------------------------------
  // Decode pool
  // ----------------------------------------------------------

  await decodePool(
    poolAddress
  );

  // ----------------------------------------------------------
  // Token decimals
  // ----------------------------------------------------------

  await getTokenDecimals();

  // ----------------------------------------------------------
  // SOL/USD
  // ----------------------------------------------------------

  const price =
    await getSolPriceUsd();

  console.log(
    `💵 SOL/USD : $${formatNumber(price, 4)}`
  );

  // ----------------------------------------------------------
  // Initial vaults
  // ----------------------------------------------------------

  const reserves =
    await readInitialVaults();

  console.log(
    `💰 Réserve SOL initiale : ${formatNumber(reserves.solReserve, 6)} SOL`
  );

  console.log(
    `🪙 Réserve token initiale : ${formatNumber(reserves.tokenReserve, 4)}`
  );

  // ----------------------------------------------------------
  // DEX initial data
  // ----------------------------------------------------------

  const dexData =
    await getPinnedPoolData();

  console.log(
    `💰 Prix initial : $${formatNumber(dexData.priceUsd, 8)}`
  );

  console.log(
    `💧 Liquidité initiale : $${formatNumber(dexData.liquidityUsd, 2)}`
  );

  if (dexData.dataGap) {
    console.log(
      "⚠️ Données DEX partiellement indisponibles au démarrage."
    );
  }

  // ----------------------------------------------------------
  // Initial snapshot
  // ----------------------------------------------------------

  const now =
    Date.now();

  history.push({
    timestamp: now,

    solReserve:
      reserves.solReserve,

    tokenReserve:
      reserves.tokenReserve,

    sol5: null,
    token5: null,

    sol10: null,
    token10: null,

    dexPrice:
      dexData.priceUsd,

    dexLiquidity:
      dexData.liquidityUsd,

    dexDataGap:
      dexData.dataGap,

    wsConnected: false,

    wsLastMessageAt: 0
  });

  // ----------------------------------------------------------
  // WebSocket
  // ----------------------------------------------------------

  connectWebSocket();

  console.log(
    "🚀 Radar démarré."
  );

  console.log(
    "⏱️ Surveillance toutes les 5s"
  );

  console.log(
    "🛡️ Détection on-chain + confirmation DEX activée."
  );

  console.log("");
}

// ============================================================
// PERIODIC SOL PRICE UPDATE
// ============================================================

setInterval(
  async () => {
    try {
      await getSolPriceUsd();

    } catch (err) {
      console.log(
        "⚠️ Mise à jour SOL/USD impossible :",
        err.message
      );
    }
  },
  60000
);

// ============================================================
// RADAR LOOP
// ============================================================

let monitorRunning = false;

setInterval(
  async () => {
    if (monitorRunning) {
      return;
    }

    monitorRunning = true;

    try {
      await monitor();

    } finally {
      monitorRunning = false;
    }
  },
  SAMPLE_INTERVAL_MS
);

// ============================================================
// SHUTDOWN
// ============================================================

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log(
    `\n🛑 Arrêt demandé (${signal})`
  );

  try {
    if (ws) {
      ws.close();
    }
  } catch (_) {}

  process.exit(0);
}

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

// ============================================================
// START
// ============================================================

init().catch(err => {
  console.log(
    `❌ Impossible d'initialiser le radar : ${err.message}`
  );

  appendLog({
    event: "INIT_ERROR",
    message: err.message
  });

  process.exit(1);
});
