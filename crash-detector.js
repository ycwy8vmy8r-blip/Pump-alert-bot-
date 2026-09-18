require("dotenv").config();

const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const MINT = "Rcopty53MejswAzB26spbwggKxtJf59cHefbwCzpump";

const PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const HTTP_RPC = "https://api.mainnet-beta.solana.com";
const WS_RPC = "wss://api.mainnet-beta.solana.com/";

const DEX_API =
  `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;

const DATA_DIR = fs.existsSync("/data") ? "/data" : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const EVENT_LOG = path.join(DATA_DIR, "crash_radar_v3.jsonl");

// ============================================================
// RÉGLAGES V3
// ============================================================

// Fenêtres de surveillance
const SAMPLE_INTERVAL_MS = 5000;
const HISTORY_WINDOW_MS = 120000;

// Détection retrait simultané des deux réserves
const REMOVAL_WARNING_5S = -5;
const REMOVAL_DANGER_5S = -10;
const REMOVAL_CRITICAL_5S = -20;

// Pression vendeuse : SOL ↓ et TOKEN ↑
const SELL_WARNING_SOL_5S = -3;
const SELL_WARNING_TOKEN_5S = 1;

const SELL_DANGER_SOL_5S = -5;
const SELL_DANGER_TOKEN_5S = 3;

const SELL_CRITICAL_SOL_5S = -10;
const SELL_CRITICAL_TOKEN_5S = 5;

// Persistance d'un événement
const EVENT_CONFIRMATION_MS = 5000;
const EVENT_MEMORY_MS = 120000;

// Confirmation DEX
const DEX_CONFIRM_DROP_PERCENT = -5;

// Anti-spam Telegram
const TELEGRAM_COOLDOWN_MS = 30000;

// WebSocket
const WS_STALE_MS = 15000;
const WS_RECONNECT_MS = 5000;

// ============================================================
// ÉTAT
// ============================================================

let poolAddress = null;
let tokenVault = null;
let solVault = null;

let tokenDecimals = 6;
let solPriceUsd = 0;

let lastValidDexLiquidity = null;
let lastDexPrice = null;

let ws = null;
let wsState = "OFFLINE";

let tokenSubscriptionId = null;
let solSubscriptionId = null;

let tokenReserve = null;
let solReserve = null;

let lastVaultUpdateAt = 0;

let history = [];

let activeEvent = null;
let lastTelegramAt = 0;

let lastCombinedLevel = "NORMAL";

let reconnectTimer = null;
let sampleTimer = null;
let initialized = false;

// ============================================================
// OUTILS
// ============================================================

function now() {
  return Date.now();
}

function formatNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return "N/A";

  return new Intl.NumberFormat("fr-FR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "N/A";

  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function pctChange(current, previous) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }

  return ((current - previous) / previous) * 100;
}

function severityRank(level) {
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

function maxSeverity(a, b) {
  return severityRank(a) >= severityRank(b) ? a : b;
}

function appendEvent(event) {
  try {
    fs.appendFileSync(
      EVENT_LOG,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...event,
      }) + "\n"
    );
  } catch (err) {
    console.log("⚠️ Erreur écriture journal :", err.message);
  }
}

// ============================================================
// RPC
// ============================================================

async function rpc(method, params = []) {
  const response = await fetch(HTTP_RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(json.error.message || "Erreur RPC");
  }

  return json.result;
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexData() {
  const response = await fetch(DEX_API);

  if (!response.ok) {
    throw new Error(`DexScreener HTTP ${response.status}`);
  }

  const pairs = await response.json();

  if (!Array.isArray(pairs)) {
    throw new Error("Réponse DexScreener invalide");
  }

  const pumpswapPairs = pairs.filter(
    (pair) =>
      pair &&
      pair.dexId === "pumpswap" &&
      pair.baseToken &&
      pair.quoteToken
  );

  if (!pumpswapPairs.length) {
    throw new Error("Aucune paire PumpSwap trouvée");
  }

  pumpswapPairs.sort(
    (a, b) =>
      Number(b.liquidity?.usd || 0) -
      Number(a.liquidity?.usd || 0)
  );

  const pair = pumpswapPairs[0];

  return {
    pairAddress: pair.pairAddress,
    priceUsd: Number(pair.priceUsd || 0),
    liquidityUsd: Number(pair.liquidity?.usd || 0),
    baseMint: pair.baseToken.address,
    quoteMint: pair.quoteToken.address,
  };
}

// ============================================================
// SOL/USD
// ============================================================

async function getSolPriceUsd() {
  // Endpoint le plus fiable actuellement
  const urls = [
    "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
    "https://api.dexscreener.com/latest/dex/search?q=SOL%20USDC",
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url);

      if (!response.ok) continue;

      const data = await response.json();

      const pairs = Array.isArray(data?.pairs) ? data.pairs : [];

      const valid = pairs
        .filter((pair) => {
          if (!pair?.priceUsd) return false;

          const base = pair.baseToken?.address;
          const quote = pair.quoteToken?.address;
          const chain = pair.chainId;

          // On ne garde que les paires Solana qui contiennent vraiment le mint SOL
          return (
            chain === "solana" &&
            (base === SOL_MINT || quote === SOL_MINT)
          );
        })
        .sort(
          (a, b) =>
            Number(b.liquidity?.usd || 0) -
            Number(a.liquidity?.usd || 0)
        );

      if (valid.length) {
        const price = Number(valid[0].priceUsd);

        if (Number.isFinite(price) && price > 0) {
          return price;
        }
      }
    } catch (_) {}
  }

  throw new Error("Impossible de trouver le prix SOL/USD");
}

// ============================================================
// POOL PUMPSWAP
// ============================================================

function readPubkey(buffer, offset) {
  return buffer.subarray(offset, offset + 32).toString("base64");
}

function decodePubkeyBase58(buffer, offset) {
  const bytes = buffer.subarray(offset, offset + 32);

  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let value = 0n;

  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let result = "";

  while (value > 0n) {
    const remainder = Number(value % 58n);
    result = alphabet[remainder] + result;
    value /= 58n;
  }

  for (const byte of bytes) {
    if (byte === 0) {
      result = "1" + result;
    } else {
      break;
    }
  }

  return result;
}

async function decodePool(address) {
  const result = await rpc("getAccountInfo", [
    address,
    {
      encoding: "base64",
      commitment: "processed",
    },
  ]);

  if (!result?.value?.data?.[0]) {
    throw new Error("Compte pool introuvable");
  }

  const buffer = Buffer.from(result.value.data[0], "base64");

  console.log(`Taille du compte pool : ${buffer.length} bytes`);

  if (buffer.length < 203) {
    throw new Error("Compte pool trop petit");
  }

  // Offsets validés avec le pool PumpSwap utilisé pendant V2
  const baseMint = decodePubkeyBase58(buffer, 43);
  const quoteMint = decodePubkeyBase58(buffer, 75);
  const baseVault = decodePubkeyBase58(buffer, 139);
  const quoteVault = decodePubkeyBase58(buffer, 171);

  return {
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
  };
}

async function findPool() {
  const dex = await getDexData();

  poolAddress = dex.pairAddress;

  console.log(`🏊 Pool PumpSwap : ${poolAddress}`);

  const decoded = await decodePool(poolAddress);

  console.log(`Base mint  : ${decoded.baseMint}`);
  console.log(`Quote mint : ${decoded.quoteMint}`);

  if (
    decoded.baseMint !== MINT &&
    decoded.quoteMint !== MINT
  ) {
    throw new Error(
      "Le token surveillé n'est pas présent dans le pool"
    );
  }

  if (decoded.baseMint === MINT) {
    tokenVault = decoded.baseVault;
    solVault = decoded.quoteVault;

    console.log("🟢 Orientation : TOKEN → SOL");
  } else {
    tokenVault = decoded.quoteVault;
    solVault = decoded.baseVault;

    console.log("🟢 Orientation : SOL → TOKEN");
  }

  console.log(`Token vault : ${tokenVault}`);
  console.log(`SOL vault   : ${solVault}`);
}

// ============================================================
// DÉCIMALES TOKEN
// ============================================================

async function getTokenDecimals() {
  try {
    const result = await rpc("getTokenSupply", [
      MINT,
      {
        commitment: "processed",
      },
    ]);

    const decimals = result?.value?.decimals;

    if (Number.isInteger(decimals)) {
      tokenDecimals = decimals;
    }
  } catch (_) {
    tokenDecimals = 6;
  }

  console.log(`Décimales token : ${tokenDecimals}`);
}

// ============================================================
// LECTURE VAULT
// ============================================================

function decodeTokenAccount(data) {
  if (!data || data.length < 72) return null;

  const rawAmount = data.readBigUInt64LE(64);

  return Number(rawAmount) / Math.pow(10, tokenDecimals);
}

function decodeSolAccount(data) {
  if (!data) return null;

  return Number(data.lamports || 0) / 1e9;
}

// ============================================================
// HISTORIQUE ON-CHAIN UNIFIÉ
// ============================================================

function addSnapshot() {
  if (
    !Number.isFinite(solReserve) ||
    !Number.isFinite(tokenReserve)
  ) {
    return;
  }

  const timestamp = now();

  history.push({
    timestamp,
    sol: solReserve,
    token: tokenReserve,
  });

  const cutoff = timestamp - HISTORY_WINDOW_MS;

  history = history.filter(
    (item) => item.timestamp >= cutoff
  );
}

function getSnapshotAgo(ms) {
  if (!history.length) return null;

  const target = now() - ms;

  let best = history[0];
  let bestDistance = Math.abs(best.timestamp - target);

  for (const item of history) {
    const distance = Math.abs(item.timestamp - target);

    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }

  return best;
}

function getOnchainChanges() {
  const snap5 = getSnapshotAgo(5000);
  const snap10 = getSnapshotAgo(10000);

  if (!snap5) {
    return {
      sol5: null,
      token5: null,
      sol10: null,
      token10: null,
    };
  }

  return {
    sol5: pctChange(solReserve, snap5.sol),
    token5: pctChange(tokenReserve, snap5.token),
    sol10: snap10
      ? pctChange(solReserve, snap10.sol)
      : null,
    token10: snap10
      ? pctChange(tokenReserve, snap10.token)
      : null,
  };
}

// ============================================================
// ANALYSE ON-CHAIN
// ============================================================

function analyseOnchain() {
  const {
    sol5,
    token5,
    sol10,
    token10,
  } = getOnchainChanges();

  let level = "NORMAL";
  let event = null;

  if (
    sol5 !== null &&
    token5 !== null
  ) {
    // Retrait simultané des deux réserves
    if (
      sol5 <= REMOVAL_CRITICAL_5S &&
      token5 <= REMOVAL_CRITICAL_5S
    ) {
      level = "CRITICAL";
      event = "LIQUIDITY_REMOVAL_SUSPECTED";
    } else if (
      sol5 <= REMOVAL_DANGER_5S &&
      token5 <= REMOVAL_DANGER_5S
    ) {
      level = "DANGER";
      event = "LIQUIDITY_REMOVAL_SUSPECTED";
    } else if (
      sol5 <= REMOVAL_WARNING_5S &&
      token5 <= REMOVAL_WARNING_5S
    ) {
      level = "WATCH";
      event = "LIQUIDITY_REMOVAL_SUSPECTED";
    }

    // Pression vendeuse
    if (
      !event &&
      sol5 <= SELL_CRITICAL_SOL_5S &&
      token5 >= SELL_CRITICAL_TOKEN_5S
    ) {
      level = "CRITICAL";
      event = "STRONG_SELL_PRESSURE";
    } else if (
      !event &&
      sol5 <= SELL_DANGER_SOL_5S &&
      token5 >= SELL_DANGER_TOKEN_5S
    ) {
      level = "DANGER";
      event = "SELL_PRESSURE";
    } else if (
      !event &&
      sol5 <= SELL_WARNING_SOL_5S &&
      token5 >= SELL_WARNING_TOKEN_5S
    ) {
      level = "WATCH";
      event = "SELL_PRESSURE";
    }
  }

  return {
    level,
    event,
    sol5,
    token5,
    sol10,
    token10,
  };
}

// ============================================================
// RADAR DEX
// ============================================================

async function getDexRadar() {
  try {
    const dex = await getDexData();

    const price = dex.priceUsd;
    const liquidity = dex.liquidityUsd;

    let dexLevel = "NORMAL";
    let dexDrop = null;

    // Ne jamais considérer une liquidité 0 comme réelle
    if (
      Number.isFinite(liquidity) &&
      liquidity > 0
    ) {
      if (lastValidDexLiquidity !== null) {
        dexDrop = pctChange(
          liquidity,
          lastValidDexLiquidity
        );
      }

      lastValidDexLiquidity = liquidity;
    }

    if (
      lastDexPrice !== null &&
      price > 0
    ) {
      const priceDrop = pctChange(
        price,
        lastDexPrice
      );

      if (priceDrop <= -20) {
        dexLevel = "CRITICAL";
      } else if (priceDrop <= -10) {
        dexLevel = "DANGER";
      } else if (priceDrop <= -5) {
        dexLevel = "WATCH";
      }
    }

    if (
      dexDrop !== null &&
      dexDrop <= -20
    ) {
      dexLevel = "CRITICAL";
    } else if (
      dexDrop !== null &&
      dexDrop <= -10
    ) {
      dexLevel = maxSeverity(
        dexLevel,
        "DANGER"
      );
    } else if (
      dexDrop !== null &&
      dexDrop <= DEX_CONFIRM_DROP_PERCENT
    ) {
      dexLevel = maxSeverity(
        dexLevel,
        "WATCH"
      );
    }

    lastDexPrice = price;

    return {
      price,
      liquidity,
      dexLevel,
      dexDrop,
      valid: liquidity > 0,
    };
  } catch (err) {
    return {
      price: lastDexPrice || 0,
      liquidity: lastValidDexLiquidity || 0,
      dexLevel: "NORMAL",
      dexDrop: null,
      valid: false,
      error: err.message,
    };
  }
}

// ============================================================
// ÉVÉNEMENTS PERSISTANTS
// ============================================================

function createEvent(onchain) {
  if (!onchain.event) return;

  const timestamp = now();

  if (
    activeEvent &&
    timestamp - activeEvent.startedAt <
      EVENT_MEMORY_MS
  ) {
    return;
  }

  activeEvent = {
    id: `${timestamp}-${onchain.event}`,
    type: onchain.event,
    startedAt: timestamp,
    confirmedAt: null,
    lastSeenAt: timestamp,

    initialSol: solReserve,
    initialToken: tokenReserve,

    maxSolDrop: onchain.sol5,
    maxTokenDrop: onchain.token5,

    dexConfirmed: false,
    dexConfirmedAt: null,
  };

  appendEvent({
    type: "ONCHAIN_EVENT_DETECTED",
    event: activeEvent,
    mint: MINT,
    pool: poolAddress,
  });

  console.log(
    `🚨 ÉVÉNEMENT ON-CHAIN : ${onchain.event}`
  );
}

function updateActiveEvent(onchain, dex) {
  if (!activeEvent) return;

  const timestamp = now();

  activeEvent.lastSeenAt = timestamp;

  if (
    onchain.sol5 !== null &&
    onchain.sol5 < activeEvent.maxSolDrop
  ) {
    activeEvent.maxSolDrop = onchain.sol5;
  }

  if (
    onchain.token5 !== null &&
    onchain.token5 < activeEvent.maxTokenDrop
  ) {
    activeEvent.maxTokenDrop = onchain.token5;
  }

  if (
    !activeEvent.confirmedAt &&
    timestamp - activeEvent.startedAt >=
      EVENT_CONFIRMATION_MS
  ) {
    activeEvent.confirmedAt = timestamp;

    appendEvent({
      type: "ONCHAIN_EVENT_CONFIRMED",
      event: activeEvent,
      mint: MINT,
      pool: poolAddress,
    });

    console.log(
      `✅ ÉVÉNEMENT ON-CHAIN CONFIRMÉ : ${activeEvent.type}`
    );
  }

  if (
    !activeEvent.dexConfirmed &&
    dex.dexDrop !== null &&
    dex.dexDrop <= DEX_CONFIRM_DROP_PERCENT
  ) {
    activeEvent.dexConfirmed = true;
    activeEvent.dexConfirmedAt = timestamp;

    const leadTime =
      timestamp - activeEvent.startedAt;

    appendEvent({
      type: "DEX_CONFIRMED",
      event: activeEvent,
      dexLiquidityDrop: dex.dexDrop,
      leadTimeMs: leadTime,
      leadTimeSeconds: leadTime / 1000,
      mint: MINT,
      pool: poolAddress,
    });

    console.log(
      `📡 DEX CONFIRMÉ après ${(
        leadTime / 1000
      ).toFixed(1)}s`
    );
  }

  if (
    timestamp - activeEvent.lastSeenAt >
      EVENT_MEMORY_MS
  ) {
    activeEvent = null;
  }
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  if (
    now() - lastTelegramAt <
    TELEGRAM_COOLDOWN_MS
  ) {
    return;
  }

  lastTelegramAt = now();

  try {
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: message,
          disable_web_page_preview: true,
        }),
      }
    );
  } catch (err) {
    console.log(
      "⚠️ Telegram :",
      err.message
    );
  }
}

// ============================================================
// MESSAGE ALERTE
// ============================================================

function buildAlert(
  combined,
  onchain,
  dex
) {
  const eventText =
    activeEvent?.type ||
    onchain.event ||
    "MOUVEMENT";

  let message =
    `🚨 CRASH RADAR V3\n\n` +
    `🪙 Token\n${MINT}\n\n` +
    `🎯 Niveau : ${combined}\n` +
    `⚡ Événement : ${eventText}\n\n` +
    `💰 Prix : ${formatUsd(dex.price)}\n` +
    `💧 DEX : ${formatUsd(dex.liquidity)}\n\n` +
    `🔗 ON-CHAIN\n` +
    `SOL : ${formatNumber(solReserve, 6)}\n` +
    `TOKEN : ${formatNumber(tokenReserve, 4)}\n\n`;

  if (onchain.sol5 !== null) {
    message +=
      `SOL / 5s : ${onchain.sol5.toFixed(2)}%\n`;
  }

  if (onchain.token5 !== null) {
    message +=
      `TOKEN / 5s : ${onchain.token5.toFixed(2)}%\n`;
  }

  if (onchain.sol10 !== null) {
    message +=
      `SOL / 10s : ${onchain.sol10.toFixed(2)}%\n`;
  }

  if (onchain.token10 !== null) {
    message +=
      `TOKEN / 10s : ${onchain.token10.toFixed(2)}%\n`;
  }

  if (activeEvent) {
    message +=
      `\n📌 ÉVÉNEMENT MÉMORISÉ\n` +
      `Retrait SOL max : ${formatNumber(
        activeEvent.maxSolDrop,
        2
      )}%\n` +
      `Retrait TOKEN max : ${formatNumber(
        activeEvent.maxTokenDrop,
        2
      )}%\n`;

    if (activeEvent.dexConfirmed) {
      message += `\n✅ DEX CONFIRMÉ`;
    } else {
      message += `\n⏳ DEX en attente de confirmation`;
    }
  }

  return message;
}

// ============================================================
// WEBSOCKET
// ============================================================

function subscribeAccount(
  socket,
  address,
  type
) {
  const requestId =
    type === "token"
      ? 1001
      : 1002;

  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "accountSubscribe",
      params: [
        address,
        {
          encoding: "base64",
          commitment: "processed",
        },
      ],
    })
  );
}

function startWebSocket() {
  if (ws) {
    try {
      ws.close();
    } catch (_) {}
  }

  wsState = "WAITING";

  console.log(
    "🔌 Connexion WebSocket Solana..."
  );

  ws = new WebSocket(WS_RPC);

  ws.on("open", () => {
    wsState = "LIVE";

    console.log(
      "🟢 WebSocket Solana LIVE"
    );

    subscribeAccount(
      ws,
      tokenVault,
      "token"
    );

    subscribeAccount(
      ws,
      solVault,
      "sol"
    );
  });

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (
        msg.id === 1001 &&
        msg.result
      ) {
        tokenSubscriptionId =
          msg.result;

        return;
      }

      if (
        msg.id === 1002 &&
        msg.result
      ) {
        solSubscriptionId =
          msg.result;

        return;
      }

      if (
        msg.method !==
        "accountNotification"
      ) {
        return;
      }

      const subscription =
        msg.params?.subscription;

      const value =
        msg.params?.result?.value;

      if (!value) return;

      const data = value.data;

      if (
        !Array.isArray(data) ||
        data[0] === undefined
      ) {
        return;
      }

      const buffer =
        Buffer.from(
          data[0],
          "base64"
        );

      if (
        subscription ===
        tokenSubscriptionId
      ) {
        const amount =
          decodeTokenAccount(
            buffer
          );

        if (
          Number.isFinite(amount)
        ) {
          tokenReserve = amount;
          lastVaultUpdateAt = now();
        }
      }

      if (
        subscription ===
        solSubscriptionId
      ) {
        const lamports =
          Number(
            value.lamports || 0
          );

        solReserve =
          lamports / 1e9;

        lastVaultUpdateAt = now();
      }
    } catch (err) {
      console.log(
        "⚠️ WS message :",
        err.message
      );
    }
  });

  ws.on("close", () => {
    wsState = "OFFLINE";

    tokenSubscriptionId = null;
    solSubscriptionId = null;

    console.log(
      "⚠️ WebSocket fermé."
    );

    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.log(
      "⚠️ WebSocket :",
      err.message
    );
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (
      initialized
    ) {
      startWebSocket();
    }
  }, WS_RECONNECT_MS);
}

// ============================================================
// SURVEILLANCE PRINCIPALE
// ============================================================

async function monitor() {
  if (
    Number.isFinite(solReserve) &&
    Number.isFinite(tokenReserve)
  ) {
    addSnapshot();
  }

  const onchain =
    analyseOnchain();

  const dex =
    await getDexRadar();

  createEvent(onchain);

  updateActiveEvent(
    onchain,
    dex
  );

  const combined =
    maxSeverity(
      dex.dexLevel,
      onchain.level
    );

  const event =
    activeEvent?.type ||
    onchain.event ||
    "NONE";

  console.log(
    `[RADAR] Prix ${formatUsd(
      dex.price
    )} | DEX Liq ${
      dex.liquidity > 0
        ? formatUsd(dex.liquidity)
        : "DATA GAP"
    } | DEX ${
      dex.dexLevel
    } | ONCHAIN ${
      onchain.level
    } | ${combined} | ${event} | WS ${
      wsState
    }`
  );

  if (
    Number.isFinite(solReserve) &&
    Number.isFinite(tokenReserve)
  ) {
    console.log(
      `[VAULT] SOL ${solReserve.toFixed(
        6
      )} | TOKEN ${tokenReserve.toFixed(
        4
      )} | SOL5 ${
        onchain.sol5 === null
          ? "N/A"
          : onchain.sol5.toFixed(2) + "%"
      } | TOKEN5 ${
        onchain.token5 === null
          ? "N/A"
          : onchain.token5.toFixed(2) + "%"
      }`
    );
  }

  if (
    combined !== lastCombinedLevel
  ) {
    console.log(
      `🚨 RADAR ${lastCombinedLevel} → ${combined}`
    );

    if (
      severityRank(combined) >
      severityRank(lastCombinedLevel)
    ) {
      await sendTelegram(
        buildAlert(
          combined,
          onchain,
          dex
        )
      );
    }

    lastCombinedLevel =
      combined;
  }

  // Alerte spécifique lorsqu'un événement
  // on-chain apparaît même sans changement
  // de niveau global.
  if (
    onchain.event &&
    activeEvent &&
    !activeEvent.telegramSent
  ) {
    activeEvent.telegramSent = true;

    await sendTelegram(
      buildAlert(
        combined,
        onchain,
        dex
      )
    );
  }

  appendEvent({
    type: "RADAR_SAMPLE",
    mint: MINT,
    pool: poolAddress,
    price: dex.price,
    dexLiquidity: dex.liquidity,
    dexLiquidityValid: dex.valid,

    dexLevel: dex.dexLevel,
    onchainLevel: onchain.level,
    combinedLevel: combined,

    event,

    solReserve,
    tokenReserve,

    sol5: onchain.sol5,
    token5: onchain.token5,
    sol10: onchain.sol10,
    token10: onchain.token10,

    wsState,

    activeEvent: activeEvent
      ? {
          id: activeEvent.id,
          type: activeEvent.type,
          startedAt:
            new Date(
              activeEvent.startedAt
            ).toISOString(),
          confirmedAt:
            activeEvent.confirmedAt
              ? new Date(
                  activeEvent.confirmedAt
                ).toISOString()
              : null,
          maxSolDrop:
            activeEvent.maxSolDrop,
          maxTokenDrop:
            activeEvent.maxTokenDrop,
          dexConfirmed:
            activeEvent.dexConfirmed,
          dexConfirmedAt:
            activeEvent.dexConfirmedAt
              ? new Date(
                  activeEvent.dexConfirmedAt
                ).toISOString()
              : null,
        }
      : null,
  });
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
    "🚀 CRASH RADAR V3"
  );
  console.log(
    "=================================================="
  );
  console.log(
    `🪙 Token : ${MINT}`
  );
  console.log("");

  try {
    await findPool();

    await getTokenDecimals();

    solPriceUsd =
      await getSolPriceUsd();

    console.log(
      `💵 SOL/USD : $${solPriceUsd.toFixed(
        4
      )}`
    );

    const dex =
      await getDexData();

    lastValidDexLiquidity =
      dex.liquidityUsd;

    lastDexPrice =
      dex.priceUsd;

    console.log(
      `💰 Prix initial : ${formatUsd(
        dex.priceUsd
      )}`
    );

    console.log(
      `💧 Liquidité initiale : ${formatUsd(
        dex.liquidityUsd
      )}`
    );

    initialized = true;

    startWebSocket();

    sampleTimer = setInterval(
      monitor,
      SAMPLE_INTERVAL_MS
    );

    console.log(
      "🚀 Radar V3 démarré."
    );

    console.log(
      "⏱️ Surveillance toutes les 5s"
    );

    console.log(
      "🧠 Détection on-chain persistante activée."
    );

    console.log(
      "🛡️ Protection contre les faux DEX liquidity = 0 activée."
    );

    console.log("");
  } catch (err) {
    console.error(
      "❌ Impossible d'initialiser le radar :",
      err.message
    );

    process.exit(1);
  }
}

// ============================================================
// ARRÊT PROPRE
// ============================================================

process.on(
  "SIGTERM",
  () => {
    console.log(
      "🛑 Arrêt Crash Radar V3..."
    );

    initialized = false;

    if (sampleTimer) {
      clearInterval(sampleTimer);
    }

    if (reconnectTimer) {
      clearTimeout(
        reconnectTimer
      );
    }

    if (ws) {
      try {
        ws.close();
      } catch (_) {}
    }

    process.exit(0);
  }
);

process.on(
  "SIGINT",
  () => {
    process.emit(
      "SIGTERM"
    );
  }
);

init();
