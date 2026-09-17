const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ============================================================
// TOKEN À SURVEILLER
// ============================================================

const MINT =
  "GE4EfPtjfYfA8AmFsfJ6GBE7XAtxHSWsfwmaiQQLh2YS";

// ============================================================
// CONFIGURATION
// ============================================================

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const RPC_HTTP =
  "https://api.mainnet-beta.solana.com";

const RPC_WS =
  "wss://api.mainnet-beta.solana.com/";

const DEXSCREENER_URL =
  `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;

const CHECK_INTERVAL_MS = 1000;

const ALERT_COOLDOWN_MS = 30000;

// ============================================================
// SEUILS RADAR
// ============================================================

const WATCH_LIQUIDITY_5S = -5;
const WATCH_LIQUIDITY_10S = -10;
const WATCH_PRICE_5S = -5;

const DANGER_LIQUIDITY_5S = -10;
const DANGER_LIQUIDITY_10S = -20;
const DANGER_PRICE_5S = -10;

const CRITICAL_LIQUIDITY_5S = -20;
const CRITICAL_LIQUIDITY_10S = -40;
const CRITICAL_PRICE_5S = -20;

// ============================================================
// FICHIERS
// ============================================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const LOG_FILE = path.join(
  DATA_DIR,
  "crash_radar.jsonl"
);

// ============================================================
// VARIABLES
// ============================================================

let ws = null;

let poolAddress = null;

let tokenVault = null;
let solVault = null;

let tokenDecimals = 0;
let solDecimals = 9;

let tokenReserve = null;
let solReserve = null;

let currentPriceUsd = null;
let currentLiquidityUsd = null;

let lastAlertTime = 0;
let currentLevel = "NORMAL";

let history = [];

// ============================================================
// BASE58
// ============================================================

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buffer) {
  let num = 0n;

  for (const byte of buffer) {
    num = (num << 8n) + BigInt(byte);
  }

  let result = "";

  while (num > 0n) {
    const remainder = Number(num % 58n);
    result = BASE58_ALPHABET[remainder] + result;
    num = num / 58n;
  }

  for (const byte of buffer) {
    if (byte === 0) {
      result = "1" + result;
    } else {
      break;
    }
  }

  return result || "1";
}

// ============================================================
// LECTURE UINT64
// ============================================================

function readUInt64LE(buffer, offset) {
  let value = 0n;

  for (let i = 0; i < 8; i++) {
    value += BigInt(buffer[offset + i]) << BigInt(8 * i);
  }

  return value;
}

// ============================================================
// LECTURE PUBKEY
// ============================================================

function readPubkey(buffer, offset) {
  const bytes = buffer.subarray(offset, offset + 32);

  if (bytes.length !== 32) {
    throw new Error(
      `Impossible de lire la pubkey à l'offset ${offset}`
    );
  }

  return base58Encode(bytes);
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(
      "⚠️ BOT_TOKEN ou CHAT_ID absent. Telegram désactivé."
    );
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
      const text = await response.text();

      console.log(
        "⚠️ Erreur Telegram :",
        response.status,
        text
      );

      return;
    }

    console.log("📨 Alerte Telegram envoyée.");
  } catch (error) {
    console.log(
      "⚠️ Erreur envoi Telegram :",
      error.message
    );
  }
}

// ============================================================
// RPC SOLANA
// ============================================================

async function rpcRequest(method, params = []) {
  const response = await fetch(RPC_HTTP, {
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
      `RPC HTTP ${response.status}`
    );
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(
      `RPC ${json.error.message}`
    );
  }

  return json.result;
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexPair() {
  const response = await fetch(
    DEXSCREENER_URL
  );

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const pairs = await response.json();

  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error(
      "Aucune paire trouvée sur DexScreener."
    );
  }

  const pumpPairs = pairs.filter(
    pair =>
      String(pair.dexId || "").toLowerCase() ===
      "pumpswap"
  );

  if (pumpPairs.length === 0) {
    throw new Error(
      "Aucune paire PumpSwap trouvée."
    );
  }

  pumpPairs.sort((a, b) => {
    const liquidityA =
      Number(a.liquidity?.usd || 0);

    const liquidityB =
      Number(b.liquidity?.usd || 0);

    return liquidityB - liquidityA;
  });

  return pumpPairs[0];
}

// ============================================================
// TROUVER LE POOL
// ============================================================

async function findPool() {
  console.log("");
  console.log("🔎 Recherche du pool PumpSwap...");
  console.log("");
  console.log("Token surveillé :", MINT);

  const pair = await getDexPair();

  poolAddress = pair.pairAddress;

  console.log("");
  console.log("✅ Pool PumpSwap trouvé");
  console.log("Pool :", poolAddress);

  console.log("");
  console.log("Base mint  :", pair.baseToken?.address);
  console.log("Quote mint :", pair.quoteToken?.address);

  const baseMint =
    pair.baseToken?.address;

  const quoteMint =
    pair.quoteToken?.address;

  if (
    baseMint !== MINT &&
    quoteMint !== MINT
  ) {
    throw new Error(
      `Le token surveillé ${MINT} n'est présent dans aucun des deux côtés du pool.`
    );
  }

  if (
    baseMint === SOL_MINT &&
    quoteMint === MINT
  ) {
    console.log("");
    console.log(
      "🔄 Orientation détectée : SOL → TOKEN"
    );
  } else if (
    baseMint === MINT &&
    quoteMint === SOL_MINT
  ) {
    console.log("");
    console.log(
      "🔄 Orientation détectée : TOKEN → SOL"
    );
  } else {
    console.log("");
    console.log(
      "⚠️ Le pool utilise un autre actif comme quote."
    );
  }

  return pair;
}

// ============================================================
// DÉCODAGE DU POOL
// ============================================================

async function decodePool() {
  console.log("");
  console.log("🔎 Lecture du compte pool...");

  const result = await rpcRequest(
    "getAccountInfo",
    [
      poolAddress,
      {
        encoding: "base64"
      }
    ]
  );

  if (!result?.value?.data) {
    throw new Error(
      "Impossible de récupérer les données du pool."
    );
  }

  const encoded =
    result.value.data[0];

  const buffer =
    Buffer.from(encoded, "base64");

  console.log(
    "Taille du compte pool :",
    buffer.length,
    "bytes"
  );

  if (buffer.length < 203) {
    throw new Error(
      `Compte pool trop petit : ${buffer.length} bytes`
    );
  }

  // ==========================================================
  // LAYOUT PUMPSWAP
  //
  // 0   : discriminator
  // 8   : pool bump
  // 9   : index
  // 11  : creator
  // 43  : base mint
  // 75  : quote mint
  // 107 : lp mint
  // 139 : base vault
  // 171 : quote vault
  // ==========================================================

  const baseMint =
    readPubkey(buffer, 43);

  const quoteMint =
    readPubkey(buffer, 75);

  const baseVault =
    readPubkey(buffer, 139);

  const quoteVault =
    readPubkey(buffer, 171);

  console.log("");
  console.log("✅ Pool décodé");
  console.log("Base mint  :", baseMint);
  console.log("Quote mint :", quoteMint);
  console.log("Base vault :", baseVault);
  console.log("Quote vault:", quoteVault);

  if (
    baseMint !== MINT &&
    quoteMint !== MINT
  ) {
    throw new Error(
      `Le token surveillé ${MINT} n'est pas présent dans le pool décodé.`
    );
  }

  // ==========================================================
  // CORRECTION IMPORTANTE
  //
  // Le token peut être BASE ou QUOTE.
  // On détermine donc automatiquement les deux vaults.
  // ==========================================================

  if (baseMint === MINT) {
    tokenVault = baseVault;

    if (quoteMint === SOL_MINT) {
      solVault = quoteVault;
    } else {
      solVault = quoteVault;
    }

    console.log("");
    console.log(
      "🟢 Token surveillé = BASE"
    );
  } else if (quoteMint === MINT) {
    tokenVault = quoteVault;

    if (baseMint === SOL_MINT) {
      solVault = baseVault;
    } else {
      solVault = baseVault;
    }

    console.log("");
    console.log(
      "🟢 Token surveillé = QUOTE"
    );
  }

  console.log("");
  console.log("Token vault :", tokenVault);
  console.log("SOL vault   :", solVault);

  return {
    baseMint,
    quoteMint,
    baseVault,
    quoteVault
  };
}

// ============================================================
// DÉCIMALES TOKEN
// ============================================================

async function getTokenDecimals() {
  const result = await rpcRequest(
    "getTokenSupply",
    [MINT]
  );

  if (
    !result?.value?.decimals &&
    result?.value?.decimals !== 0
  ) {
    throw new Error(
      "Impossible de récupérer les décimales du token."
    );
  }

  tokenDecimals =
    result.value.decimals;

  console.log(
    "Décimales token :",
    tokenDecimals
  );
}

// ============================================================
// RÉCUPÉRATION SOL VAULT
// ============================================================

async function getVaultBalance(vault) {
  const result = await rpcRequest(
    "getTokenAccountBalance",
    [vault]
  );

  if (!result?.value) {
    throw new Error(
      `Impossible de lire le solde du vault ${vault}`
    );
  }

  return {
    raw: BigInt(
      result.value.amount
    ),
    decimals:
      result.value.decimals
  };
}

// ============================================================
// PRIX TOKEN VIA DEXSCREENER
// ============================================================

async function getTokenPriceUsd() {
  const pair = await getDexPair();

  const price =
    Number(pair.priceUsd || 0);

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      "Prix USD invalide sur DexScreener."
    );
  }

  return price;
}

// ============================================================
// CALCUL DU PRIX PAR RÉSERVES
// ============================================================

function calculateReservePrice(
  tokenAmount,
  solAmount
) {
  if (
    !Number.isFinite(tokenAmount) ||
    !Number.isFinite(solAmount) ||
    tokenAmount <= 0 ||
    solAmount <= 0
  ) {
    return null;
  }

  return solAmount / tokenAmount;
}

// ============================================================
// PRIX USD DE SOL
// ============================================================

async function getSolPriceUsd() {
  const pair = await getDexPair();

  const baseMint =
    pair.baseToken?.address;

  const quoteMint =
    pair.quoteToken?.address;

  let price = null;

  if (
    baseMint === SOL_MINT
  ) {
    price =
      Number(pair.priceUsd || 0);
  } else if (
    quoteMint === SOL_MINT
  ) {
    price =
      Number(pair.priceUsd || 0);

    // DexScreener priceUsd reste le prix du
    // baseToken. Si SOL est le quote, il faut
    // récupérer le prix SOL séparément.
    price = null;
  }

  if (
    price &&
    Number.isFinite(price) &&
    price > 0
  ) {
    return price;
  }

  // Fallback : paire SOL/USDC ou SOL/USDT
  const response = await fetch(
    "https://api.dexscreener.com/latest/dex/search/?q=SOL"
  );

  if (!response.ok) {
    throw new Error(
      `Impossible de récupérer le prix SOL : HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const pairs =
    Array.isArray(data.pairs)
      ? data.pairs
      : [];

  const solPairs =
    pairs.filter(pair => {
      const base =
        pair.baseToken?.address;

      const quote =
        pair.quoteToken?.address;

      return (
        (
          base === SOL_MINT &&
          (
            quote ===
              "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" ||
            quote ===
              "Es9vMFrzaCERmJfrF4H2FYD4FhM4X4uF5V8w6j5Qf9g"
          )
        )
      );
    });

  solPairs.sort((a, b) => {
    const la =
      Number(a.liquidity?.usd || 0);

    const lb =
      Number(b.liquidity?.usd || 0);

    return lb - la;
  });

  if (solPairs.length === 0) {
    throw new Error(
      "Impossible de trouver une paire SOL/USD."
    );
  }

  const solPrice =
    Number(
      solPairs[0].priceUsd || 0
    );

  if (
    !Number.isFinite(solPrice) ||
    solPrice <= 0
  ) {
    throw new Error(
      "Prix SOL invalide."
    );
  }

  return solPrice;
}

// ============================================================
// MISE À JOUR DES RÉSERVES
// ============================================================

async function updateReserves() {
  const tokenBalance =
    await getVaultBalance(
      tokenVault
    );

  const solBalance =
    await getVaultBalance(
      solVault
    );

  const tokenAmount =
    Number(tokenBalance.raw) /
    Math.pow(
      10,
      tokenBalance.decimals
    );

  const solAmount =
    Number(solBalance.raw) /
    Math.pow(
      10,
      solBalance.decimals
    );

  tokenReserve =
    tokenAmount;

  solReserve =
    solAmount;

  return {
    tokenAmount,
    solAmount
  };
}

// ============================================================
// CALCUL LIQUIDITÉ / PRIX
// ============================================================

async function calculateMarketData() {
  const reserves =
    await updateReserves();

  const tokenAmount =
    reserves.tokenAmount;

  const solAmount =
    reserves.solAmount;

  const solPriceUsd =
    await getSolPriceUsd();

  // Prix théorique du token en SOL
  const tokenPriceSol =
    calculateReservePrice(
      tokenAmount,
      solAmount
    );

  let tokenPriceUsd = null;

  if (tokenPriceSol !== null) {
    tokenPriceUsd =
      tokenPriceSol *
      solPriceUsd;
  }

  // ==========================================================
  // Fallback DexScreener
  // ==========================================================

  if (
    !Number.isFinite(tokenPriceUsd) ||
    tokenPriceUsd <= 0
  ) {
    tokenPriceUsd =
      await getTokenPriceUsd();
  }

  // Liquidité approximative du pool
  //
  // Pour un pool constant-product équilibré :
  // liquidité ≈ 2 × réserve SOL × prix SOL
  //
  // On garde cette mesure cohérente avec les
  // mouvements de réserves.
  const liquidityUsd =
    solAmount *
    solPriceUsd *
    2;

  currentPriceUsd =
    tokenPriceUsd;

  currentLiquidityUsd =
    liquidityUsd;

  return {
    tokenAmount,
    solAmount,
    solPriceUsd,
    tokenPriceUsd,
    liquidityUsd
  };
}

// ============================================================
// HISTORIQUE
// ============================================================

function addHistory(data) {
  const now = Date.now();

  history.push({
    timestamp: now,
    price: data.tokenPriceUsd,
    liquidity: data.liquidityUsd
  });

  const cutoff =
    now - 60000;

  history =
    history.filter(
      item =>
        item.timestamp >= cutoff
    );
}

// ============================================================
// TROUVER VALEUR HISTORIQUE
// ============================================================

function findPrevious(seconds) {
  const target =
    Date.now() -
    seconds * 1000;

  if (history.length === 0) {
    return null;
  }

  let closest = null;
  let smallestDifference =
    Infinity;

  for (const item of history) {
    const difference =
      Math.abs(
        item.timestamp -
          target
      );

    if (
      difference <
      smallestDifference
    ) {
      smallestDifference =
        difference;

      closest = item;
    }
  }

  return closest;
}

// ============================================================
// POURCENTAGE
// ============================================================

function percentChange(
  current,
  previous
) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }

  return (
    ((current - previous) /
      previous) *
    100
  );
}

// ============================================================
// ANALYSE RADAR
// ============================================================

function analyzeRadar() {
  const previous5 =
    findPrevious(5);

  const previous10 =
    findPrevious(10);

  const price5 =
    previous5
      ? percentChange(
          currentPriceUsd,
          previous5.price
        )
      : null;

  const price10 =
    previous10
      ? percentChange(
          currentPriceUsd,
          previous10.price
        )
      : null;

  const liquidity5 =
    previous5
      ? percentChange(
          currentLiquidityUsd,
          previous5.liquidity
        )
      : null;

  const liquidity10 =
    previous10
      ? percentChange(
          currentLiquidityUsd,
          previous10.liquidity
        )
      : null;

  let level = "NORMAL";

  // ==========================================================
  // CRITICAL
  // ==========================================================

  if (
    (liquidity5 !== null &&
      liquidity5 <=
        CRITICAL_LIQUIDITY_5S) ||
    (liquidity10 !== null &&
      liquidity10 <=
        CRITICAL_LIQUIDITY_10S) ||
    (price5 !== null &&
      price5 <=
        CRITICAL_PRICE_5S)
  ) {
    level = "CRITICAL";
  }

  // ==========================================================
  // DANGER
  // ==========================================================

  else if (
    (liquidity5 !== null &&
      liquidity5 <=
        DANGER_LIQUIDITY_5S) ||
    (liquidity10 !== null &&
      liquidity10 <=
        DANGER_LIQUIDITY_10S) ||
    (price5 !== null &&
      price5 <=
        DANGER_PRICE_5S)
  ) {
    level = "DANGER";
  }

  // ==========================================================
  // WATCH
  // ==========================================================

  else if (
    (liquidity5 !== null &&
      liquidity5 <=
        WATCH_LIQUIDITY_5S) ||
    (liquidity10 !== null &&
      liquidity10 <=
        WATCH_LIQUIDITY_10S) ||
    (price5 !== null &&
      price5 <=
        WATCH_PRICE_5S)
  ) {
    level = "WATCH";
  }

  return {
    level,
    price5,
    price10,
    liquidity5,
    liquidity10
  };
}

// ============================================================
// ALERTE
// ============================================================

async function handleAlert(
  analysis
) {
  const now = Date.now();

  if (
    analysis.level ===
    "NORMAL"
  ) {
    currentLevel =
      "NORMAL";

    return;
  }

  if (
    analysis.level ===
    currentLevel
  ) {
    return;
  }

  currentLevel =
    analysis.level;

  if (
    now - lastAlertTime <
    ALERT_COOLDOWN_MS
  ) {
    return;
  }

  lastAlertTime = now;

  let emoji = "⚠️";

  if (
    analysis.level ===
    "DANGER"
  ) {
    emoji = "🚨";
  }

  if (
    analysis.level ===
    "CRITICAL"
  ) {
    emoji = "🔴";
  }

  const message = [
    `${emoji} CRASH RADAR ${analysis.level}`,
    "",
    `Token : ${MINT}`,
    "",
    `💵 Prix : $${formatNumber(
      currentPriceUsd
    )}`,
    `💧 Liquidité : $${formatNumber(
      currentLiquidityUsd
    )}`,
    "",
    `Prix 5s : ${formatPercent(
      analysis.price5
    )}`,
    `Prix 10s : ${formatPercent(
      analysis.price10
    )}`,
    "",
    `Liquidité 5s : ${formatPercent(
      analysis.liquidity5
    )}`,
    `Liquidité 10s : ${formatPercent(
      analysis.liquidity10
    )}`,
    "",
    "⚡ Mouvement détecté par le Crash Radar."
  ].join("\n");

  console.log("");
  console.log(
    "🚨 ALERTE",
    analysis.level
  );
  console.log(message);

  await sendTelegram(message);
}

// ============================================================
// FORMATAGE
// ============================================================

function formatNumber(value) {
  if (
    !Number.isFinite(value)
  ) {
    return "N/A";
  }

  if (value < 0.000001) {
    return value.toExponential(4);
  }

  if (value < 0.01) {
    return value.toFixed(8);
  }

  if (value < 1) {
    return value.toFixed(6);
  }

  return value.toFixed(4);
}

function formatPercent(value) {
  if (
    value === null ||
    !Number.isFinite(value)
  ) {
    return "N/A";
  }

  return `${value >= 0 ? "+" : ""}${value.toFixed(
    2
  )}%`;
}

// ============================================================
// LOG
// ============================================================

function saveLog(data) {
  try {
    const entry = {
      timestamp:
        new Date().toISOString(),

      mint: MINT,

      pool: poolAddress,

      tokenVault,

      solVault,

      price:
        currentPriceUsd,

      liquidity:
        currentLiquidityUsd,

      level:
        data.level,

      price5:
        data.price5,

      price10:
        data.price10,

      liquidity5:
        data.liquidity5,

      liquidity10:
        data.liquidity10
    };

    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify(entry) +
        "\n"
    );
  } catch (error) {
    console.log(
      "⚠️ Impossible d'écrire le log :",
      error.message
    );
  }
}

// ============================================================
// WEBSOCKET
// ============================================================

function subscribeToVault(
  vault,
  label
) {
  if (!ws) {
    return;
  }

  const id =
    Math.floor(
      Math.random() *
        1000000
    );

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method:
        "accountSubscribe",
      params: [
        vault,
        {
          encoding: "base64",
          commitment:
            "processed"
        }
      ]
    })
  );

  console.log(
    `📡 Subscription ${label} : ${vault}`
  );
}

// ============================================================
// WEBSOCKET
// ============================================================

function startWebSocket() {
  console.log("");
  console.log(
    "🔌 Connexion WebSocket Solana..."
  );

  ws = new WebSocket(
    RPC_WS
  );

  ws.on(
    "open",
    () => {
      console.log(
        "✅ WebSocket Solana connecté."
      );

      subscribeToVault(
        tokenVault,
        "TOKEN"
      );

      subscribeToVault(
        solVault,
        "SOL"
      );
    }
  );

  ws.on(
    "message",
    async raw => {
      try {
        const message =
          JSON.parse(
            raw.toString()
          );

        if (
          !message.params ||
          !message.params.result
        ) {
          return;
        }

        const value =
          message.params.result.value;

        if (!value?.data) {
          return;
        }

        const encoded =
          value.data[0];

        const buffer =
          Buffer.from(
            encoded,
            "base64"
          );

        if (
          buffer.length < 165
        ) {
          return;
        }

        const amount =
          readUInt64LE(
            buffer,
            64
          );

        const pubkey =
          message.params.subscription;

        // On ne peut pas toujours connaître
        // directement le vault depuis l'ID de
        // subscription. On force donc une
        // actualisation des réserves.

        const data =
          await calculateMarketData();

        addHistory(data);

        const analysis =
          analyzeRadar();

        saveLog(
          analysis
        );

        console.log(
          `[${new Date().toLocaleTimeString()}]`,
          `Prix $${formatNumber(
            data.tokenPriceUsd
          )}`,
          `| Liq $${formatNumber(
            data.liquidityUsd
          )}`,
          `| ${analysis.level}`
        );

        await handleAlert(
          analysis
        );
      } catch (error) {
        console.log(
          "⚠️ Erreur traitement WebSocket :",
          error.message
        );
      }
    }
  );

  ws.on(
    "error",
    error => {
      console.log(
        "⚠️ WebSocket erreur :",
        error.message
      );
    }
  );

  ws.on(
    "close",
    () => {
      console.log(
        "⚠️ WebSocket fermé. Reconnexion dans 5 secondes..."
      );

      setTimeout(
        startWebSocket,
        5000
      );
    }
  );
}

// ============================================================
// BOUCLE DE SÉCURITÉ
// ============================================================

async function monitoringLoop() {
  try {
    if (
      !tokenVault ||
      !solVault
    ) {
      return;
    }

    const data =
      await calculateMarketData();

    addHistory(data);

    const analysis =
      analyzeRadar();

    saveLog(
      analysis
    );

    console.log(
      `[RADAR]`,
      `Prix $${formatNumber(
        data.tokenPriceUsd
      )}`,
      `| Liquidité $${formatNumber(
        data.liquidityUsd
      )}`,
      `| ${analysis.level}`
    );

    await handleAlert(
      analysis
    );
  } catch (error) {
    console.log(
      "⚠️ Erreur monitoring :",
      error.message
    );
  }
}

// ============================================================
// INITIALISATION
// ============================================================

async function init() {
  console.log("");
  console.log(
    "=================================================="
  );
  console.log(
    "🚨 CRASH RADAR"
  );
  console.log(
    "=================================================="
  );
  console.log("");
  console.log(
    "Token surveillé :"
  );
  console.log(MINT);
  console.log("");

  if (!BOT_TOKEN) {
    console.log(
      "⚠️ BOT_TOKEN absent."
    );
  }

  if (!CHAT_ID) {
    console.log(
      "⚠️ CHAT_ID absent."
    );
  }

  try {
    // ----------------------------------------------------------
    // 1. Trouver le pool
    // ----------------------------------------------------------

    await findPool();

    // ----------------------------------------------------------
    // 2. Décoder le pool
    // ----------------------------------------------------------

    await decodePool();

    // ----------------------------------------------------------
    // 3. Décimales
    // ----------------------------------------------------------

    await getTokenDecimals();

    // ----------------------------------------------------------
    // 4. Premier calcul
    // ----------------------------------------------------------

    const data =
      await calculateMarketData();

    console.log("");
    console.log(
      "=================================================="
    );
    console.log(
      "📊 PREMIÈRE MESURE"
    );
    console.log(
      "=================================================="
    );

    console.log(
      "Prix token :",
      `$${formatNumber(
        data.tokenPriceUsd
      )}`
    );

    console.log(
      "Prix SOL :",
      `$${formatNumber(
        data.solPriceUsd
      )}`
    );

    console.log(
      "Réserve token :",
      formatNumber(
        data.tokenAmount
      )
    );

    console.log(
      "Réserve SOL :",
      formatNumber(
        data.solAmount
      )
    );

    console.log(
      "Liquidité :",
      `$${formatNumber(
        data.liquidityUsd
      )}`
    );

    console.log(
      "=================================================="
    );

    addHistory(data);

    // ----------------------------------------------------------
    // 5. WebSocket
    // ----------------------------------------------------------

    startWebSocket();

    // ----------------------------------------------------------
    // 6. Boucle de sécurité
    // ----------------------------------------------------------

    setInterval(
      monitoringLoop,
      CHECK_INTERVAL_MS
    );

    console.log("");
    console.log(
      "🟢 Crash Radar actif."
    );
    console.log(
      "📡 Surveillance des réserves PumpSwap..."
    );
    console.log("");
  } catch (error) {
    console.log("");
    console.log(
      "❌ Impossible d'initialiser le radar :",
      error.message
    );
    console.log("");

    setTimeout(
      init,
      10000
    );
  }
}

// ============================================================
// START
// ============================================================

init();
