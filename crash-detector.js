const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Token surveillé
const MINT = "GE4EfPtjfYfA8AmFsfJ6GBE7XAtxHSWsfwmaiQQLh2YS";

// PumpSwap
const PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

// SOL
const SOL_MINT = "So11111111111111111111111111111111111111112";

// USDC
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// RPC publics Solana
const HTTP_RPC = "https://api.mainnet-beta.solana.com";
const WS_RPC = "wss://api.mainnet-beta.solana.com/";

// DexScreener
const DEX_API =
  `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;

// Intervalle de surveillance
const MONITOR_INTERVAL_MS = 5000;

// Minimum entre deux lectures RPC des vaults
const VAULT_REFRESH_MS = 5000;

// En cas de 429, attendre avant nouvelle requête
const RPC_BACKOFF_MS = 15000;

// Cooldown Telegram
const TELEGRAM_COOLDOWN_MS = 30000;

// ============================================================
// SEUILS RADAR
// ============================================================

const WATCH_LIQ_5S = -5;
const WATCH_LIQ_10S = -10;
const WATCH_PRICE_5S = -5;

const DANGER_LIQ_5S = -10;
const DANGER_LIQ_10S = -20;
const DANGER_PRICE_5S = -10;

const CRITICAL_LIQ_5S = -20;
const CRITICAL_LIQ_10S = -40;
const CRITICAL_PRICE_5S = -20;

// ============================================================
// DATA
// ============================================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const LOG_FILE = path.join(DATA_DIR, "crash_radar.jsonl");

// ============================================================
// ETAT
// ============================================================

let poolAddress = null;

let tokenVault = null;
let solVault = null;

let tokenDecimals = 6;

let currentPriceUsd = null;
let currentLiquidityUsd = null;
let currentSolPriceUsd = null;

let lastVaultRefresh = 0;
let rpcBackoffUntil = 0;

let history = [];

let currentLevel = "NORMAL";
let lastTelegramTime = 0;

let ws = null;
let reconnectTimer = null;

let monitoring = false;

// ============================================================
// UTILITAIRES
// ============================================================

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  if (Math.abs(value) < 0.000001) {
    return value.toExponential(4);
  }

  if (Math.abs(value) < 0.01) {
    return value.toFixed(8);
  }

  if (Math.abs(value) < 1) {
    return value.toFixed(6);
  }

  return value.toFixed(4);
}

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(2)}M`;
  }

  if (value >= 1000) {
    return `$${(value / 1000).toFixed(2)}k`;
  }

  return `$${value.toFixed(2)}`;
}

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("⚠️ BOT_TOKEN ou CHAT_ID absent.");
    return;
  }

  try {
    const url =
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        disable_web_page_preview: true
      })
    });

    if (!response.ok) {
      console.log(
        `⚠️ Telegram HTTP ${response.status}`
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
// RPC SOLANA
// ============================================================

async function rpcRequest(method, params = []) {
  if (Date.now() < rpcBackoffUntil) {
    throw new Error("RPC en cooldown après HTTP 429");
  }

  try {
    const response = await fetch(HTTP_RPC, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params
      })
    });

    if (response.status === 429) {
      rpcBackoffUntil = Date.now() + RPC_BACKOFF_MS;

      throw new Error("RPC HTTP 429");
    }

    if (!response.ok) {
      throw new Error(
        `RPC HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(
        data.error.message || "Erreur RPC"
      );
    }

    return data.result;
  } catch (error) {
    if (error.message.includes("429")) {
      rpcBackoffUntil = Date.now() + RPC_BACKOFF_MS;
    }

    throw error;
  }
}

// ============================================================
// LECTURE SOLANA VAULT
// ============================================================

async function getTokenAccountBalance(address) {
  const result = await rpcRequest(
    "getTokenAccountBalance",
    [address]
  );

  if (
    !result ||
    !result.value
  ) {
    throw new Error(
      `Solde introuvable pour ${address}`
    );
  }

  const amount = Number(result.value.uiAmount);

  if (!Number.isFinite(amount)) {
    throw new Error(
      `Solde invalide pour ${address}`
    );
  }

  return amount;
}

async function getSolBalance(address) {
  const result = await rpcRequest(
    "getBalance",
    [
      address,
      {
        commitment: "processed"
      }
    ]
  );

  if (
    !result ||
    !Number.isFinite(result.value)
  ) {
    throw new Error(
      `Solde SOL introuvable pour ${address}`
    );
  }

  return result.value / 1e9;
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexData() {
  const response = await fetch(DEX_API, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error(
      "Réponse DexScreener invalide"
    );
  }

  const pumpswapPairs = data.filter(
    pair =>
      pair &&
      pair.dexId === "pumpswap"
  );

  if (pumpswapPairs.length === 0) {
    throw new Error(
      "Aucune paire PumpSwap trouvée"
    );
  }

  pumpswapPairs.sort((a, b) => {
    const liqA =
      Number(a?.liquidity?.usd) || 0;

    const liqB =
      Number(b?.liquidity?.usd) || 0;

    return liqB - liqA;
  });

  const pair = pumpswapPairs[0];

  const priceUsd =
    Number(pair.priceUsd);

  const liquidityUsd =
    Number(pair?.liquidity?.usd);

  if (!Number.isFinite(priceUsd)) {
    throw new Error(
      "Prix USD invalide"
    );
  }

  if (!Number.isFinite(liquidityUsd)) {
    throw new Error(
      "Liquidité USD invalide"
    );
  }

  return {
    pair,
    priceUsd,
    liquidityUsd
  };
}

// ============================================================
// SOL PRICE
// ============================================================

async function getSolPriceUsd() {
  try {
    const url =
      "https://api.dexscreener.com/token-pairs/v1/solana/" +
      SOL_MINT;

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(
        `DexScreener SOL HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (!Array.isArray(data)) {
      throw new Error(
        "Réponse SOL DexScreener invalide"
      );
    }

    const stableMints = new Set([
      USDC_MINT,
      "Es9vMFrzaCERmJfrF4H2FYD4mHfFqZ2eXfWm6gkT9Q",
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    ]);

    const candidates = data.filter(pair => {
      if (!pair) {
        return false;
      }

      const base =
        pair.baseToken?.address;

      const quote =
        pair.quoteToken?.address;

      return (
        (base === SOL_MINT &&
          stableMints.has(quote)) ||
        (quote === SOL_MINT &&
          stableMints.has(base))
      );
    });

    candidates.sort((a, b) => {
      const liqA =
        Number(a?.liquidity?.usd) || 0;

      const liqB =
        Number(b?.liquidity?.usd) || 0;

      return liqB - liqA;
    });

    if (candidates.length > 0) {
      const pair = candidates[0];

      const price =
        Number(pair.priceUsd);

      if (Number.isFinite(price)) {
        return price;
      }
    }

    // Fallback : chercher une paire SOL très liquide
    // même si le stablecoin n'est pas directement identifié.
    const fallback = data
      .filter(pair => {
        if (!pair) {
          return false;
        }

        return (
          pair.baseToken?.address === SOL_MINT ||
          pair.quoteToken?.address === SOL_MINT
        );
      })
      .sort((a, b) => {
        const liqA =
          Number(a?.liquidity?.usd) || 0;

        const liqB =
          Number(b?.liquidity?.usd) || 0;

        return liqB - liqA;
      });

    if (fallback.length > 0) {
      const price =
        Number(fallback[0].priceUsd);

      if (Number.isFinite(price)) {
        return price;
      }
    }

    throw new Error(
      "Impossible de trouver le prix SOL/USD"
    );
  } catch (error) {
    console.log(
      "⚠️ Prix SOL indisponible :",
      error.message
    );

    return currentSolPriceUsd;
  }
}

// ============================================================
// RECHERCHE DU POOL PUMPSWAP
// ============================================================

async function findPool() {
  const dexData = await getDexData();

  const pair = dexData.pair;

  if (!pair.pairAddress) {
    throw new Error(
      "Adresse du pool absente"
    );
  }

  poolAddress = pair.pairAddress;

  const baseMint =
    pair.baseToken?.address;

  const quoteMint =
    pair.quoteToken?.address;

  console.log(
    `Base mint  : ${baseMint}`
  );

  console.log(
    `Quote mint : ${quoteMint}`
  );

  console.log(
    `Pool       : ${poolAddress}`
  );

  if (
    baseMint !== MINT &&
    quoteMint !== MINT
  ) {
    throw new Error(
      "Le token surveillé ne correspond pas au pool"
    );
  }

  if (
    baseMint === MINT &&
    quoteMint === SOL_MINT
  ) {
    console.log(
      "🔄 Orientation détectée : TOKEN → SOL"
    );
  } else if (
    baseMint === SOL_MINT &&
    quoteMint === MINT
  ) {
    console.log(
      "🔄 Orientation détectée : SOL → TOKEN"
    );
  }

  return {
    poolAddress,
    baseMint,
    quoteMint
  };
}

// ============================================================
// DECODAGE DU POOL PUMPSWAP
// ============================================================

function decodePublicKey(buffer, offset) {
  if (
    !buffer ||
    offset < 0 ||
    offset + 32 > buffer.length
  ) {
    throw new Error(
      `Offset PublicKey invalide : ${offset}`
    );
  }

  return bs58Encode(
    buffer.subarray(
      offset,
      offset + 32
    )
  );
}

// Base58 minimal
const ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58Encode(buffer) {
  if (!buffer || buffer.length === 0) {
    return "";
  }

  const digits = [0];

  for (const byte of buffer) {
    let carry = byte;

    for (
      let i = 0;
      i < digits.length;
      i++
    ) {
      const value =
        digits[i] * 256 + carry;

      digits[i] =
        value % 58;

      carry =
        Math.floor(value / 58);
    }

    while (carry > 0) {
      digits.push(
        carry % 58
      );

      carry =
        Math.floor(carry / 58);
    }
  }

  let result = "";

  for (
    let i = 0;
    i < buffer.length &&
    buffer[i] === 0;
    i++
  ) {
    result += "1";
  }

  for (
    let i = digits.length - 1;
    i >= 0;
    i--
  ) {
    result += ALPHABET[digits[i]];
  }

  return result;
}

async function decodePool() {
  const result = await rpcRequest(
    "getAccountInfo",
    [
      poolAddress,
      {
        encoding: "base64",
        commitment: "processed"
      }
    ]
  );

  if (
    !result ||
    !result.value ||
    !result.value.data
  ) {
    throw new Error(
      "Compte pool introuvable"
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
    `Taille du compte pool : ${buffer.length} bytes`
  );

  if (buffer.length < 203) {
    throw new Error(
      "Compte pool trop petit"
    );
  }

  // Layout PumpSwap utilisé par le radar
  const baseMint =
    decodePublicKey(buffer, 43);

  const quoteMint =
    decodePublicKey(buffer, 75);

  const baseVault =
    decodePublicKey(buffer, 139);

  const quoteVault =
    decodePublicKey(buffer, 171);

  console.log("✅ Pool décodé");

  console.log(
    `Base mint  : ${baseMint}`
  );

  console.log(
    `Quote mint : ${quoteMint}`
  );

  console.log(
    `Base vault : ${baseVault}`
  );

  console.log(
    `Quote vault: ${quoteVault}`
  );

  if (
    baseMint === MINT &&
    quoteMint === SOL_MINT
  ) {
    tokenVault = baseVault;
    solVault = quoteVault;

    console.log(
      "🟢 Token surveillé = BASE"
    );
  } else if (
    baseMint === SOL_MINT &&
    quoteMint === MINT
  ) {
    tokenVault = quoteVault;
    solVault = baseVault;

    console.log(
      "🟢 Token surveillé = QUOTE"
    );
  } else {
    throw new Error(
      "Impossible de déterminer les vaults token/SOL"
    );
  }

  console.log(
    `Token vault : ${tokenVault}`
  );

  console.log(
    `SOL vault   : ${solVault}`
  );
}

// ============================================================
// DECIMALES TOKEN
// ============================================================

async function getTokenDecimals() {
  try {
    const result = await rpcRequest(
      "getTokenAccountBalance",
      [
        tokenVault,
        {
          commitment: "processed"
        }
      ]
    );

    const decimals =
      Number(
        result?.value?.decimals
      );

    if (
      Number.isFinite(decimals)
    ) {
      tokenDecimals = decimals;
    }
  } catch (error) {
    console.log(
      "⚠️ Impossible de lire les décimales :",
      error.message
    );

    tokenDecimals = 6;
  }

  console.log(
    `Décimales token : ${tokenDecimals}`
  );
}

// ============================================================
// LECTURE DES RESERVES
// ============================================================

async function refreshVaults() {
  const timestamp = Date.now();

  // Protection supplémentaire contre les appels trop rapprochés
  if (
    timestamp - lastVaultRefresh <
    VAULT_REFRESH_MS
  ) {
    return;
  }

  // Si le RPC est en cooldown après un 429,
  // on ne fait absolument aucune requête.
  if (
    timestamp < rpcBackoffUntil
  ) {
    return;
  }

  lastVaultRefresh = timestamp;

  try {
    const [
      tokenAmount,
      solAmount
    ] = await Promise.all([
      getTokenAccountBalance(tokenVault),
      getSolBalance(solVault)
    ]);

    if (
      !Number.isFinite(tokenAmount) ||
      !Number.isFinite(solAmount)
    ) {
      return;
    }

    return {
      tokenAmount,
      solAmount
    };
  } catch (error) {
    if (
      error.message.includes("429")
    ) {
      console.log(
        `⏳ RPC limité, pause ${RPC_BACKOFF_MS / 1000}s`
      );
    } else {
      console.log(
        "⚠️ Erreur lecture vaults :",
        error.message
      );
    }

    return null;
  }
}

// ============================================================
// HISTORIQUE
// ============================================================

function addHistory(price, liquidity) {
  const timestamp = Date.now();

  history.push({
    timestamp,
    price,
    liquidity
  });

  // Garder seulement les 2 dernières minutes
  const cutoff =
    timestamp - 120000;

  history =
    history.filter(
      item =>
        item.timestamp >= cutoff
    );
}

function findHistorical(seconds) {
  const target =
    Date.now() - seconds * 1000;

  if (history.length === 0) {
    return null;
  }

  let closest =
    history[0];

  let smallestDiff =
    Math.abs(
      closest.timestamp -
      target
    );

  for (const item of history) {
    const diff =
      Math.abs(
        item.timestamp -
        target
      );

    if (diff < smallestDiff) {
      smallestDiff = diff;
      closest = item;
    }
  }

  return closest;
}

function percentChange(current, previous) {
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
// NIVEAU RADAR
// ============================================================

function calculateLevel() {
  const h5 =
    findHistorical(5);

  const h10 =
    findHistorical(10);

  const price5 =
    h5
      ? percentChange(
          currentPriceUsd,
          h5.price
        )
      : null;

  const price10 =
    h10
      ? percentChange(
          currentPriceUsd,
          h10.price
        )
      : null;

  const liq5 =
    h5
      ? percentChange(
          currentLiquidityUsd,
          h5.liquidity
        )
      : null;

  const liq10 =
    h10
      ? percentChange(
          currentLiquidityUsd,
          h10.liquidity
        )
      : null;

  let level = "NORMAL";

  if (
    (
      Number.isFinite(liq10) &&
      liq10 <= CRITICAL_LIQ_10S
    ) ||
    (
      Number.isFinite(liq5) &&
      liq5 <= CRITICAL_LIQ_5S
    ) ||
    (
      Number.isFinite(price5) &&
      price5 <= CRITICAL_PRICE_5S
    )
  ) {
    level = "CRITICAL";
  } else if (
    (
      Number.isFinite(liq10) &&
      liq10 <= DANGER_LIQ_10S
    ) ||
    (
      Number.isFinite(liq5) &&
      liq5 <= DANGER_LIQ_5S
    ) ||
    (
      Number.isFinite(price5) &&
      price5 <= DANGER_PRICE_5S
    )
  ) {
    level = "DANGER";
  } else if (
    (
      Number.isFinite(liq10) &&
      liq10 <= WATCH_LIQ_10S
    ) ||
    (
      Number.isFinite(liq5) &&
      liq5 <= WATCH_LIQ_5S
    ) ||
    (
      Number.isFinite(price5) &&
      price5 <= WATCH_PRICE_5S
    )
  ) {
    level = "WATCH";
  }

  return {
    level,
    price5,
    price10,
    liq5,
    liq10
  };
}

// ============================================================
// LOG
// ============================================================

function writeLog(data) {
  try {
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify(data) +
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
// TELEGRAM ALERT
// ============================================================

async function alertLevel(
  radar
) {
  const timestamp =
    Date.now();

  if (
    radar.level === currentLevel
  ) {
    return;
  }

  const previousLevel =
    currentLevel;

  currentLevel =
    radar.level;

  console.log(
    `🚨 RADAR ${previousLevel} → ${radar.level}`
  );

  if (
    timestamp - lastTelegramTime <
    TELEGRAM_COOLDOWN_MS
  ) {
    return;
  }

  lastTelegramTime =
    timestamp;

  let emoji = "⚠️";

  if (
    radar.level === "DANGER"
  ) {
    emoji = "🔴";
  }

  if (
    radar.level === "CRITICAL"
  ) {
    emoji = "🚨";
  }

  if (
    radar.level === "NORMAL"
  ) {
    emoji = "🟢";
  }

  const message =
`${emoji} CRASH RADAR

Niveau : ${radar.level}

Prix : $${formatNumber(currentPriceUsd)}
Liquidité : ${formatUsd(currentLiquidityUsd)}

Prix 5s : ${
  Number.isFinite(radar.price5)
    ? radar.price5.toFixed(2) + "%"
    : "N/A"
}

Prix 10s : ${
  Number.isFinite(radar.price10)
    ? radar.price10.toFixed(2) + "%"
    : "N/A"
}

Liquidité 5s : ${
  Number.isFinite(radar.liq5)
    ? radar.liq5.toFixed(2) + "%"
    : "N/A"
}

Liquidité 10s : ${
  Number.isFinite(radar.liq10)
    ? radar.liq10.toFixed(2) + "%"
    : "N/A"
}`;

  await sendTelegram(message);
}

// ============================================================
// CYCLE PRINCIPAL
// ============================================================

async function monitorCycle() {
  if (!monitoring) {
    return;
  }

  try {
    // --------------------------------------------------------
    // 1. DexScreener
    // --------------------------------------------------------

    const dex =
      await getDexData();

    currentPriceUsd =
      dex.priceUsd;

    currentLiquidityUsd =
      dex.liquidityUsd;

    // --------------------------------------------------------
    // 2. SOL price
    // --------------------------------------------------------

    const solPrice =
      await getSolPriceUsd();

    if (
      Number.isFinite(solPrice)
    ) {
      currentSolPriceUsd =
        solPrice;
    }

    // --------------------------------------------------------
    // 3. Historique
    // --------------------------------------------------------

    addHistory(
      currentPriceUsd,
      currentLiquidityUsd
    );

    // --------------------------------------------------------
    // 4. Radar
    // --------------------------------------------------------

    const radar =
      calculateLevel();

    console.log(
      `[RADAR] Prix $${formatNumber(currentPriceUsd)} | Liq ${currentLiquidityUsd} | ${radar.level}`
    );

    // --------------------------------------------------------
    // 5. Alertes
    // --------------------------------------------------------

    await alertLevel(
      radar
    );

    // --------------------------------------------------------
    // 6. RPC vaults
    // --------------------------------------------------------

    // Les vaults sont maintenant lus à intervalle contrôlé.
    // Ils ne sont PAS lus à chaque événement WebSocket.
    const reserves =
      await refreshVaults();

    if (reserves) {
      const impliedLiquidity =
        reserves.solAmount *
        (currentSolPriceUsd || 0);

      writeLog({
        timestamp:
          new Date().toISOString(),

        mint: MINT,

        pool: poolAddress,

        priceUsd:
          currentPriceUsd,

        dexscreenerLiquidityUsd:
          currentLiquidityUsd,

        solPriceUsd:
          currentSolPriceUsd,

        tokenReserve:
          reserves.tokenAmount,

        solReserve:
          reserves.solAmount,

        solReserveUsd:
          impliedLiquidity,

        level:
          radar.level,

        priceChange5s:
          radar.price5,

        priceChange10s:
          radar.price10,

        liquidityChange5s:
          radar.liq5,

        liquidityChange10s:
          radar.liq10
      });
    }
  } catch (error) {
    if (
      error.message.includes("429")
    ) {
      console.log(
        "⚠️ Erreur monitoring : RPC HTTP 429"
      );
    } else {
      console.log(
        "⚠️ Erreur monitoring :",
        error.message
      );
    }
  }
}

// ============================================================
// WEBSOCKET
// ============================================================

function subscribeVault(address) {
  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  const message = {
    jsonrpc: "2.0",
    id:
      Math.floor(
        Math.random() * 1000000
      ),
    method: "accountSubscribe",
    params: [
      address,
      {
        encoding: "base64",
        commitment: "processed"
      }
    ]
  };

  ws.send(
    JSON.stringify(message)
  );
}

function connectWebSocket() {
  if (
    ws &&
    (
      ws.readyState ===
        WebSocket.OPEN ||
      ws.readyState ===
        WebSocket.CONNECTING
    )
  ) {
    return;
  }

  console.log(
    "🔌 Connexion WebSocket Solana..."
  );

  ws =
    new WebSocket(
      WS_RPC
    );

  ws.on(
    "open",
    () => {
      console.log(
        "✅ WebSocket Solana connecté"
      );

      subscribeVault(
        tokenVault
      );

      subscribeVault(
        solVault
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
          message.method ===
          "accountNotification"
        ) {
          /*
           * IMPORTANT :
           *
           * On ne fait PLUS de requête HTTP RPC ici.
           *
           * Avant, chaque notification WebSocket
           * pouvait provoquer plusieurs appels RPC.
           *
           * C'était la cause principale des 429.
           *
           * Le monitoring principal tourne maintenant
           * toutes les 5 secondes et décide lui-même
           * quand lire les vaults.
           */
        }
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
        "⚠️ WebSocket :",
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

      if (
        reconnectTimer
      ) {
        return;
      }

      reconnectTimer =
        setTimeout(
          () => {
            reconnectTimer =
              null;

            connectWebSocket();
          },
          10000
        );
    }
  );
}

// ============================================================
// INITIALISATION
// ============================================================

async function init() {
  try {
    console.log(
      "======================================"
    );

    console.log(
      "🚨 CRASH RADAR"
    );

    console.log(
      `Token : ${MINT}`
    );

    console.log(
      "======================================"
    );

    // --------------------------------------------------------
    // Pool
    // --------------------------------------------------------

    await findPool();

    console.log(
      "🔎 Lecture du compte pool..."
    );

    await decodePool();

    // --------------------------------------------------------
    // Décimales
    // --------------------------------------------------------

    await getTokenDecimals();

    // --------------------------------------------------------
    // Prix SOL
    // --------------------------------------------------------

    currentSolPriceUsd =
      await getSolPriceUsd();

    console.log(
      `💵 SOL/USD : $${formatNumber(currentSolPriceUsd)}`
    );

    // --------------------------------------------------------
    // Première lecture Dex
    // --------------------------------------------------------

    const dex =
      await getDexData();

    currentPriceUsd =
      dex.priceUsd;

    currentLiquidityUsd =
      dex.liquidityUsd;

    addHistory(
      currentPriceUsd,
      currentLiquidityUsd
    );

    console.log(
      `💰 Prix initial : $${formatNumber(currentPriceUsd)}`
    );

    console.log(
      `💧 Liquidité initiale : ${formatUsd(currentLiquidityUsd)}`
    );

    // --------------------------------------------------------
    // Démarrage
    // --------------------------------------------------------

    monitoring = true;

    connectWebSocket();

    console.log(
      "🚀 Radar démarré."
    );

    console.log(
      `⏱️ Surveillance toutes les ${MONITOR_INTERVAL_MS / 1000}s`
    );

    console.log(
      "🛡️ Protection RPC anti-429 activée."
    );

    // Premier cycle
    await monitorCycle();

    setInterval(
      monitorCycle,
      MONITOR_INTERVAL_MS
    );
  } catch (error) {
    console.log(
      `❌ Impossible d'initialiser le radar : ${error.message}`
    );

    console.log(
      "🔄 Nouvelle tentative dans 10 secondes..."
    );

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
