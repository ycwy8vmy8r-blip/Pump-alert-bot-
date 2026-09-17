const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// TOKEN À SURVEILLER
const MINT =
  "GE4EfPtjfYfA8AmFsfJ6GBE7XAtxHSWsfwmaiQQLh2YS";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const RPC_HTTP =
  "https://api.mainnet-beta.solana.com";

const RPC_WS =
  "wss://api.mainnet-beta.solana.com/";

const DEX_URL =
  `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;

const CHECK_INTERVAL_MS = 1000;
const ALERT_COOLDOWN_MS = 30000;

// ============================================================
// SEUILS
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
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

const LOG_FILE =
  path.join(DATA_DIR, "crash_radar.jsonl");

// ============================================================
// VARIABLES
// ============================================================

let poolAddress = null;

let tokenVault = null;
let solVault = null;

let tokenDecimals = 0;

let currentPriceUsd = null;
let currentLiquidityUsd = null;

let currentLevel = "NORMAL";

let lastAlertTime = 0;

let history = [];

let ws = null;

// ============================================================
// BASE58
// ============================================================

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buffer) {
  let num = 0n;

  for (const byte of buffer) {
    num =
      (num << 8n) +
      BigInt(byte);
  }

  let result = "";

  while (num > 0n) {
    const remainder =
      Number(num % 58n);

    result =
      BASE58_ALPHABET[remainder] +
      result;

    num =
      num / 58n;
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
// PUBKEY
// ============================================================

function readPubkey(buffer, offset) {
  const bytes =
    buffer.subarray(
      offset,
      offset + 32
    );

  if (bytes.length !== 32) {
    throw new Error(
      `Pubkey invalide à l'offset ${offset}`
    );
  }

  return base58Encode(bytes);
}

// ============================================================
// RPC
// ============================================================

async function rpcRequest(
  method,
  params = []
) {
  const response =
    await fetch(
      RPC_HTTP,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method,
          params
        })
      }
    );

  if (!response.ok) {
    throw new Error(
      `RPC HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  if (json.error) {
    throw new Error(
      `RPC ${json.error.message}`
    );
  }

  return json.result;
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(
  message
) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(
      "⚠️ BOT_TOKEN ou CHAT_ID absent."
    );

    return;
  }

  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: message
          })
        }
      );

    if (!response.ok) {
      console.log(
        "⚠️ Telegram HTTP",
        response.status
      );
    } else {
      console.log(
        "📨 Alerte Telegram envoyée."
      );
    }
  } catch (error) {
    console.log(
      "⚠️ Erreur Telegram :",
      error.message
    );
  }
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexPair() {
  const response =
    await fetch(DexURL());

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const pairs =
    await response.json();

  if (
    !Array.isArray(pairs) ||
    pairs.length === 0
  ) {
    throw new Error(
      "Aucune paire trouvée sur DexScreener."
    );
  }

  const pumpPairs =
    pairs.filter(
      pair =>
        String(
          pair.dexId || ""
        ).toLowerCase() ===
        "pumpswap"
    );

  if (
    pumpPairs.length === 0
  ) {
    throw new Error(
      "Aucune paire PumpSwap trouvée."
    );
  }

  pumpPairs.sort(
    (a, b) =>
      Number(
        b.liquidity?.usd || 0
      ) -
      Number(
        a.liquidity?.usd || 0
      )
  );

  return pumpPairs[0];
}

function DexURL() {
  return DEX_URL;
}

// ============================================================
// TROUVER LE POOL
// ============================================================

async function findPool() {
  console.log("");
  console.log(
    "🔎 Recherche du pool PumpSwap..."
  );

  const pair =
    await getDexPair();

  poolAddress =
    pair.pairAddress;

  const baseMint =
    pair.baseToken?.address;

  const quoteMint =
    pair.quoteToken?.address;

  console.log(
    "Pool :",
    poolAddress
  );

  console.log(
    "Base mint  :",
    baseMint
  );

  console.log(
    "Quote mint :",
    quoteMint
  );

  if (
    baseMint !== MINT &&
    quoteMint !== MINT
  ) {
    throw new Error(
      `Le token ${MINT} n'est pas présent dans cette paire.`
    );
  }

  if (
    baseMint === MINT &&
    quoteMint === SOL_MINT
  ) {
    console.log(
      "🔄 Orientation DexScreener : TOKEN → SOL"
    );
  } else if (
    baseMint === SOL_MINT &&
    quoteMint === MINT
  ) {
    console.log(
      "🔄 Orientation DexScreener : SOL → TOKEN"
    );
  } else {
    console.log(
      "⚠️ Le pool n'est pas directement TOKEN/SOL."
    );
  }
}

// ============================================================
// DÉCODER LE POOL
// ============================================================

async function decodePool() {
  console.log("");
  console.log(
    "🔎 Lecture du compte pool..."
  );

  const result =
    await rpcRequest(
      "getAccountInfo",
      [
        poolAddress,
        {
          encoding: "base64"
        }
      ]
    );

  if (
    !result?.value?.data
  ) {
    throw new Error(
      "Impossible de lire le compte pool."
    );
  }

  const encoded =
    result.value.data[0];

  const buffer =
    Buffer.from(
      encoded,
      "base64"
    );

  console.log(
    "Taille du compte pool :",
    buffer.length,
    "bytes"
  );

  if (
    buffer.length < 203
  ) {
    throw new Error(
      `Compte pool trop petit : ${buffer.length} bytes`
    );
  }

  // Layout PumpSwap
  const baseMint =
    readPubkey(buffer, 43);

  const quoteMint =
    readPubkey(buffer, 75);

  const baseVault =
    readPubkey(buffer, 139);

  const quoteVault =
    readPubkey(buffer, 171);

  console.log("");
  console.log(
    "✅ Pool décodé"
  );

  console.log(
    "Base mint  :",
    baseMint
  );

  console.log(
    "Quote mint :",
    quoteMint
  );

  console.log(
    "Base vault :",
    baseVault
  );

  console.log(
    "Quote vault:",
    quoteVault
  );

  // ==========================================================
  // IDENTIFICATION AUTOMATIQUE
  // ==========================================================

  if (
    baseMint === MINT
  ) {
    tokenVault =
      baseVault;

    if (
      quoteMint === SOL_MINT
    ) {
      solVault =
        quoteVault;
    } else {
      throw new Error(
        "Le quote mint du pool n'est pas SOL."
      );
    }

    console.log("");
    console.log(
      "🟢 Token surveillé = BASE"
    );
  }

  else if (
    quoteMint === MINT
  ) {
    tokenVault =
      quoteVault;

    if (
      baseMint === SOL_MINT
    ) {
      solVault =
        baseVault;
    } else {
      throw new Error(
        "Le base mint du pool n'est pas SOL."
      );
    }

    console.log("");
    console.log(
      "🟢 Token surveillé = QUOTE"
    );
  }

  else {
    throw new Error(
      "Le token surveillé n'est pas présent dans le pool."
    );
  }

  console.log(
    "Token vault :",
    tokenVault
  );

  console.log(
    "SOL vault   :",
    solVault
  );
}

// ============================================================
// DÉCIMALES
// ============================================================

async function getTokenDecimals() {
  const result =
    await rpcRequest(
      "getTokenSupply",
      [MINT]
    );

  if (
    !result?.value
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
// SOL/USD
// ============================================================

async function getSolPriceUsd() {
  // ----------------------------------------------------------
  // On utilise une paire SOL/USDC directe.
  // L'adresse USDC est connue et stable sur Solana.
  // ----------------------------------------------------------

  const USDC =
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${SOL_MINT}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Prix SOL indisponible : HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const pairs =
    Array.isArray(data.pairs)
      ? data.pairs
      : [];

  const solUsdPairs =
    pairs.filter(pair => {
      const base =
        pair.baseToken?.address;

      const quote =
        pair.quoteToken?.address;

      return (
        base === SOL_MINT &&
        quote === USDC
      );
    });

  if (
    solUsdPairs.length === 0
  ) {
    throw new Error(
      "Impossible de trouver une paire SOL/USDC."
    );
  }

  solUsdPairs.sort(
    (a, b) =>
      Number(
        b.liquidity?.usd || 0
      ) -
      Number(
        a.liquidity?.usd || 0
      )
  );

  const price =
    Number(
      solUsdPairs[0].priceUsd
    );

  if (
    !Number.isFinite(price) ||
    price <= 0
  ) {
    throw new Error(
      "Prix SOL invalide."
    );
  }

  return price;
}

// ============================================================
// VAULT BALANCE
// ============================================================

async function getVaultBalance(
  vault
) {
  const result =
    await rpcRequest(
      "getTokenAccountBalance",
      [vault]
    );

  if (
    !result?.value
  ) {
    throw new Error(
      `Impossible de lire le vault ${vault}`
    );
  }

  return {
    amount:
      Number(
        result.value.amount
      ),
    decimals:
      result.value.decimals
  };
}

// ============================================================
// RÉSERVES
// ============================================================

async function getReserves() {
  const token =
    await getVaultBalance(
      tokenVault
    );

  const sol =
    await getVaultBalance(
      solVault
    );

  const tokenAmount =
    token.amount /
    Math.pow(
      10,
      token.decimals
    );

  const solAmount =
    sol.amount /
    Math.pow(
      10,
      sol.decimals
    );

  return {
    tokenAmount,
    solAmount
  };
}

// ============================================================
// DONNÉES MARCHÉ
// ============================================================

async function calculateMarketData() {
  const reserves =
    await getReserves();

  const solPriceUsd =
    await getSolPriceUsd();

  if (
    reserves.tokenAmount <= 0 ||
    reserves.solAmount <= 0
  ) {
    throw new Error(
      "Réserves invalides."
    );
  }

  // Prix du token en SOL
  const tokenPriceSol =
    reserves.solAmount /
    reserves.tokenAmount;

  // Prix USD
  const tokenPriceUsd =
    tokenPriceSol *
    solPriceUsd;

  // Liquidité approximative
  const liquidityUsd =
    reserves.solAmount *
    solPriceUsd *
    2;

  return {
    tokenAmount:
      reserves.tokenAmount,

    solAmount:
      reserves.solAmount,

    solPriceUsd,

    tokenPriceSol,

    tokenPriceUsd,

    liquidityUsd
  };
}

// ============================================================
// HISTORIQUE
// ============================================================

function addHistory(data) {
  const now =
    Date.now();

  history.push({
    timestamp: now,

    price:
      data.tokenPriceUsd,

    liquidity:
      data.liquidityUsd
  });

  const cutoff =
    now - 60000;

  history =
    history.filter(
      item =>
        item.timestamp >=
        cutoff
    );
}

// ============================================================
// VALEUR HISTORIQUE
// ============================================================

function findPrevious(
  seconds
) {
  const target =
    Date.now() -
    seconds * 1000;

  let closest = null;

  let smallest =
    Infinity;

  for (
    const item of history
  ) {
    const difference =
      Math.abs(
        item.timestamp -
          target
      );

    if (
      difference <
      smallest
    ) {
      smallest =
        difference;

      closest =
        item;
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
// ANALYSE
// ============================================================

function analyzeRadar() {
  const p5 =
    findPrevious(5);

  const p10 =
    findPrevious(10);

  const price5 =
    p5
      ? percentChange(
          currentPriceUsd,
          p5.price
        )
      : null;

  const price10 =
    p10
      ? percentChange(
          currentPriceUsd,
          p10.price
        )
      : null;

  const liquidity5 =
    p5
      ? percentChange(
          currentLiquidityUsd,
          p5.liquidity
        )
      : null;

  const liquidity10 =
    p10
      ? percentChange(
          currentLiquidityUsd,
          p10.liquidity
        )
      : null;

  let level =
    "NORMAL";

  // CRITICAL
  if (
    (
      liquidity5 !== null &&
      liquidity5 <=
        CRITICAL_LIQUIDITY_5S
    ) ||
    (
      liquidity10 !== null &&
      liquidity10 <=
        CRITICAL_LIQUIDITY_10S
    ) ||
    (
      price5 !== null &&
      price5 <=
        CRITICAL_PRICE_5S
    )
  ) {
    level =
      "CRITICAL";
  }

  // DANGER
  else if (
    (
      liquidity5 !== null &&
      liquidity5 <=
        DANGER_LIQUIDITY_5S
    ) ||
    (
      liquidity10 !== null &&
      liquidity10 <=
        DANGER_LIQUIDITY_10S
    ) ||
    (
      price5 !== null &&
      price5 <=
        DANGER_PRICE_5S
    )
  ) {
    level =
      "DANGER";
  }

  // WATCH
  else if (
    (
      liquidity5 !== null &&
      liquidity5 <=
        WATCH_LIQUIDITY_5S
    ) ||
    (
      liquidity10 !== null &&
      liquidity10 <=
        WATCH_LIQUIDITY_10S
    ) ||
    (
      price5 !== null &&
      price5 <=
        WATCH_PRICE_5S
    )
  ) {
    level =
      "WATCH";
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

  const now =
    Date.now();

  if (
    now - lastAlertTime <
    ALERT_COOLDOWN_MS
  ) {
    return;
  }

  lastAlertTime =
    now;

  let emoji =
    "⚠️";

  if (
    analysis.level ===
    "DANGER"
  ) {
    emoji =
      "🚨";
  }

  if (
    analysis.level ===
    "CRITICAL"
  ) {
    emoji =
      "🔴";
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
  console.log(message);

  await sendTelegram(
    message
  );
}

// ============================================================
// LOG
// ============================================================

function saveLog(
  analysis
) {
  try {
    const entry = {
      timestamp:
        new Date().toISOString(),

      mint:
        MINT,

      pool:
        poolAddress,

      tokenVault:
        tokenVault,

      solVault:
        solVault,

      price:
        currentPriceUsd,

      liquidity:
        currentLiquidityUsd,

      level:
        analysis.level,

      price5:
        analysis.price5,

      price10:
        analysis.price10,

      liquidity5:
        analysis.liquidity5,

      liquidity10:
        analysis.liquidity10
    };

    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify(entry) +
        "\n"
    );
  } catch (error) {
    console.log(
      "⚠️ Erreur écriture log :",
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
          encoding:
            "base64",
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

  ws =
    new WebSocket(
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

      console.log(
        "📡 Surveillance des deux vaults active."
      );
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
        "⚠️ WebSocket fermé."
      );

      setTimeout(
        startWebSocket,
        5000
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

        const data =
          await calculateMarketData();

        currentPriceUsd =
          data.tokenPriceUsd;

        currentLiquidityUsd =
          data.liquidityUsd;

        addHistory(data);

        const analysis =
          analyzeRadar();

        saveLog(
          analysis
        );

        console.log(
          `[RADAR] Prix $${formatNumber(
            currentPriceUsd
          )} | Liq $${formatNumber(
            currentLiquidityUsd
          )} | ${analysis.level}`
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

    currentPriceUsd =
      data.tokenPriceUsd;

    currentLiquidityUsd =
      data.liquidityUsd;

    addHistory(data);

    const analysis =
      analyzeRadar();

    saveLog(
      analysis
    );

    console.log(
      `[RADAR] Prix $${formatNumber(
        currentPriceUsd
      )} | Liq $${formatNumber(
        currentLiquidityUsd
      )} | ${analysis.level}`
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
function formatNumber(value) {
  if (!Number.isFinite(value)) {
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
  console.log(
    MINT
  );

  try {
    // 1. Trouver le pool
    await findPool();

    // 2. Décoder le pool
    await decodePool();

    // 3. Décimales
    await getTokenDecimals();

    // 4. Première mesure
    const data =
      await calculateMarketData();

    currentPriceUsd =
      data.tokenPriceUsd;

    currentLiquidityUsd =
      data.liquidityUsd;

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
      "Prix SOL :",
      `$${formatNumber(
        data.solPriceUsd
      )}`
    );

    console.log(
      "Prix token :",
      `$${formatNumber(
        data.tokenPriceUsd
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

    // 5. WebSocket
    startWebSocket();

    // 6. Boucle de sécurité
    setInterval(
      monitoringLoop,
      CHECK_INTERVAL_MS
    );

    console.log("");
    console.log(
      "🟢 CRASH RADAR ACTIF"
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

    console.log(
      "🔄 Nouvelle tentative dans 10 secondes..."
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
