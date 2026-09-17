const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const MINT =
  process.env.CRASH_MINT ||
  "GutF7Rz8tutEi53gXA5ufNZTcJs7ed32XBbHHQ6ppump";

const CHECK_INTERVAL_MS = 5000;

// Seuils d'alerte
const WATCH_LIQUIDITY_5S = -5;
const WATCH_LIQUIDITY_10S = -10;

const DANGER_LIQUIDITY_5S = -10;
const DANGER_LIQUIDITY_10S = -20;

const CRITICAL_LIQUIDITY_5S = -20;
const CRITICAL_LIQUIDITY_10S = -40;

const WATCH_PRICE_5S = -5;
const DANGER_PRICE_5S = -10;
const CRITICAL_PRICE_5S = -20;

// Une alerte ne doit pas être envoyée toutes les secondes
const ALERT_COOLDOWN_MS = 30000;

const SOLANA_HTTP = "https://api.mainnet-beta.solana.com";
const SOLANA_WS = "wss://api.mainnet-beta.solana.com/";

const DEX_URL =
  `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

const LOG_FILE = path.join(DATA_DIR, "crash_radar.jsonl");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN ou CHAT_ID manquant.");
  process.exit(1);
}

// --------------------------------------------------
// OUTILS
// --------------------------------------------------

function now() {
  return new Date().toISOString();
}

function pctChange(oldValue, newValue) {
  if (!oldValue || oldValue === 0) return 0;
  return ((newValue - oldValue) / oldValue) * 100;
}

function fmt(value, decimals = 2) {
  return Number(value || 0).toFixed(decimals);
}

function logEvent(type, data = {}) {
  const line = JSON.stringify({
    timestamp: Date.now(),
    iso: now(),
    type,
    mint: MINT,
    ...data
  });

  console.log(line);

  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch (err) {
    console.log("⚠️ Impossible d'écrire le log :", err.message);
  }
}

// --------------------------------------------------
// TELEGRAM
// --------------------------------------------------

async function sendTelegram(message) {
  const url =
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message
      })
    });

    if (!response.ok) {
      const text = await response.text();
      console.log("⚠️ Telegram :", text);
    }
  } catch (err) {
    console.log("⚠️ Erreur Telegram :", err.message);
  }
}

// --------------------------------------------------
// DEXSCREENER
// --------------------------------------------------

async function findPumpSwapPool() {
  try {
    const response = await fetch(DEX_URL);

    if (!response.ok) {
      throw new Error(`DexScreener HTTP ${response.status}`);
    }

    const pairs = await response.json();

    if (!Array.isArray(pairs)) {
      return null;
    }

    const pumpPairs = pairs.filter(
      p => p && p.dexId === "pumpswap"
    );

    if (pumpPairs.length === 0) {
      return null;
    }

    pumpPairs.sort((a, b) => {
      const liqA = Number(a?.liquidity?.usd || 0);
      const liqB = Number(b?.liquidity?.usd || 0);
      return liqB - liqA;
    });

    return pumpPairs[0];

  } catch (err) {
    console.log("⚠️ DexScreener :", err.message);
    return null;
  }
}

// --------------------------------------------------
// SOLANA RPC
// --------------------------------------------------

async function rpc(method, params = []) {
  const response = await fetch(SOLANA_HTTP, {
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

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}`);
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(
      `${json.error.code}: ${json.error.message}`
    );
  }

  return json.result;
}

// --------------------------------------------------
// LECTURE DU COMPTE POOL PUMPSWAP
// --------------------------------------------------

function readPubkey(bytes, offset) {
  return Buffer.from(bytes.slice(offset, offset + 32));
}

function pubkeyFromBytes(bytes, offset) {
  const buffer = readPubkey(bytes, offset);

  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let num = BigInt("0x" + buffer.toString("hex"));

  let result = "";

  while (num > 0n) {
    const remainder = Number(num % 58n);
    num = num / 58n;
    result = alphabet[remainder] + result;
  }

  let leadingZeros = 0;

  for (const byte of buffer) {
    if (byte === 0) leadingZeros++;
    else break;
  }

  return "1".repeat(leadingZeros) + result;
}

async function getPoolInfo(poolAddress) {
  const result = await rpc("getAccountInfo", [
    poolAddress,
    {
      encoding: "base64"
    }
  ]);

  if (!result || !result.value) {
    throw new Error("Compte Pool introuvable.");
  }

  if (result.value.owner !== PUMPSWAP_PROGRAM) {
    throw new Error(
      `Le compte ${poolAddress} n'est pas un compte PumpSwap.`
    );
  }

  const raw = Buffer.from(result.value.data[0], "base64");

  if (raw.length < 203) {
    throw new Error(
      `Compte Pool trop court : ${raw.length} octets`
    );
  }

  // Layout PumpSwap actuel :
  //
  // 0   discriminator
  // 8   pool_bump
  // 9   index
  // 11  creator
  // 43  base_mint
  // 75  quote_mint
  // 107 lp_mint
  // 139 pool_base_token_account
  // 171 pool_quote_token_account

  const baseMint = pubkeyFromBytes(raw, 43);
  const quoteMint = pubkeyFromBytes(raw, 75);

  const baseVault = pubkeyFromBytes(raw, 139);
  const quoteVault = pubkeyFromBytes(raw, 171);

  return {
    poolAddress,
    baseMint,
    quoteMint,
    baseVault,
    quoteVault
  };
}

// --------------------------------------------------
// ETAT DU RADAR
// --------------------------------------------------

let poolAddress = null;
let poolInfo = null;

let baseReserve = null;
let quoteReserve = null;

let baseDecimals = null;
let quoteDecimals = null;

const reserveHistory = [];

let lastAlertAt = 0;
let currentLevel = "NORMAL";

let ws = null;

const subscriptions = new Map();

// --------------------------------------------------
// LECTURE D'UN TOKEN ACCOUNT
// --------------------------------------------------

function extractTokenAmount(notification) {
  const value =
    notification?.params?.result?.value;

  if (!value) return null;

  const parsed =
    value?.data?.parsed?.info?.tokenAmount;

  if (!parsed) return null;

  return {
    amountRaw: BigInt(parsed.amount),
    decimals: Number(parsed.decimals),
    uiAmount:
      parsed.uiAmount === null
        ? Number(parsed.amount) /
          Math.pow(10, Number(parsed.decimals))
        : Number(parsed.uiAmount)
  };
}

// --------------------------------------------------
// HISTORIQUE
// --------------------------------------------------

function addSnapshot(snapshot) {
  reserveHistory.push(snapshot);

  const cutoff = Date.now() - 30000;

  while (
    reserveHistory.length &&
    reserveHistory[0].timestamp < cutoff
  ) {
    reserveHistory.shift();
  }
}

function getSnapshotAgo(ms) {
  const target = Date.now() - ms;

  let best = null;

  for (const item of reserveHistory) {
    if (item.timestamp <= target) {
      best = item;
    }
  }

  return best;
}

// --------------------------------------------------
// ANALYSE
// --------------------------------------------------

function analyse() {
  if (
    baseReserve === null ||
    quoteReserve === null ||
    baseReserve <= 0 ||
    quoteReserve <= 0
  ) {
    return;
  }

  const latest = {
    timestamp: Date.now(),
    base: baseReserve,
    quote: quoteReserve,
    price: quoteReserve / baseReserve
  };

  addSnapshot(latest);

  const snap5 = getSnapshotAgo(5000);
  const snap10 = getSnapshotAgo(10000);

  if (!snap5 || !snap10) {
    return;
  }

  const liquidity5 =
    pctChange(snap5.quote, quoteReserve);

  const liquidity10 =
    pctChange(snap10.quote, quoteReserve);

  const price5 =
    pctChange(snap5.price, latest.price);

  const price10 =
    pctChange(snap10.price, latest.price);

  let level = "NORMAL";

  if (
    liquidity5 <= CRITICAL_LIQUIDITY_5S ||
    liquidity10 <= CRITICAL_LIQUIDITY_10S ||
    price5 <= CRITICAL_PRICE_5S
  ) {
    level = "CRITICAL";
  } else if (
    liquidity5 <= DANGER_LIQUIDITY_5S ||
    liquidity10 <= DANGER_LIQUIDITY_10S ||
    price5 <= DANGER_PRICE_5S
  ) {
    level = "DANGER";
  } else if (
    liquidity5 <= WATCH_LIQUIDITY_5S ||
    liquidity10 <= WATCH_LIQUIDITY_10S ||
    price5 <= WATCH_PRICE_5S
  ) {
    level = "WATCH";
  }

  console.log(
    `📡 ${new Date().toLocaleTimeString()} | ` +
    `Prix ${fmt(latest.price, 10)} | ` +
    `Réserve quote ${fmt(quoteReserve, 4)} | ` +
    `5s ${fmt(liquidity5)}% | ` +
    `10s ${fmt(liquidity10)}% | ` +
    `Niveau ${level}`
  );

  if (level !== currentLevel) {
    logEvent("LEVEL_CHANGE", {
      previousLevel: currentLevel,
      level,
      price: latest.price,
      liquidity5,
      liquidity10,
      price5,
      price10
    });

    currentLevel = level;

    if (
      level !== "NORMAL" &&
      Date.now() - lastAlertAt >= ALERT_COOLDOWN_MS
    ) {
      lastAlertAt = Date.now();

      const emoji =
        level === "WATCH"
          ? "🟡"
          : level === "DANGER"
            ? "🟠"
            : "🔴";

      const message =
        `${emoji} CRASH RADAR ${level}\n\n` +
        `Token : ${MINT}\n` +
        `Pool : ${poolAddress}\n\n` +
        `Prix : $${fmt(latest.price, 10)}\n` +
        `Réserve quote : ${fmt(quoteReserve, 4)}\n\n` +
        `5 secondes :\n` +
        `• Liquidité : ${fmt(liquidity5)}%\n` +
        `• Prix : ${fmt(price5)}%\n\n` +
        `10 secondes :\n` +
        `• Liquidité : ${fmt(liquidity10)}%\n` +
        `• Prix : ${fmt(price10)}%\n\n` +
        `⚠️ Signal on-chain, avant analyse DexScreener.`;

      sendTelegram(message);
    }
  }
}

// --------------------------------------------------
// WEBSOCKET
// --------------------------------------------------

function subscribeAccount(account, label) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  const id =
    Math.floor(Math.random() * 100000000);

  subscriptions.set(id, label);

  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "accountSubscribe",
    params: [
      account,
      {
        encoding: "jsonParsed",
        commitment: "processed"
      }
    ]
  }));

  console.log(
    `📡 Abonnement ${label} : ${account}`
  );
}

function connectWebSocket() {
  console.log("🔌 Connexion Solana WebSocket...");

  ws = new WebSocket(SOLANA_WS);

  ws.on("open", () => {
    console.log("✅ WebSocket Solana connecté.");

    subscribeAccount(
      poolInfo.baseVault,
      "BASE_VAULT"
    );

    subscribeAccount(
      poolInfo.quoteVault,
      "QUOTE_VAULT"
    );
  });

  ws.on("message", data => {
    try {
      const message = JSON.parse(data.toString());

      if (message.method === "accountNotification") {
        const subscription =
          message.params?.subscription;

        const label =
          subscriptions.get(subscription);

        const token =
          extractTokenAmount(message);

        if (!token) return;

        if (label === "BASE_VAULT") {
          baseReserve = token.uiAmount;
          baseDecimals = token.decimals;
        }

        if (label === "QUOTE_VAULT") {
          quoteReserve = token.uiAmount;
          quoteDecimals = token.decimals;
        }

        if (
          baseReserve !== null &&
          quoteReserve !== null
        ) {
          analyse();
        }
      }

      if (message.error) {
        console.log(
          "⚠️ WebSocket RPC :",
          message.error
        );
      }

    } catch (err) {
      console.log(
        "⚠️ Message WebSocket invalide :",
        err.message
      );
    }
  });

  ws.on("close", () => {
    console.log(
      "⚠️ WebSocket fermé. Reconnexion dans 3 secondes..."
    );

    setTimeout(connectWebSocket, 3000);
  });

  ws.on("error", err => {
    console.log(
      "⚠️ WebSocket :",
      err.message
    );
  });
}

// --------------------------------------------------
// INITIALISATION
// --------------------------------------------------

async function start() {
  console.log("");
  console.log("========================================");
  console.log("🚨 CRASH RADAR ON-CHAIN");
  console.log("========================================");
  console.log(`Token : ${MINT}`);
  console.log("========================================");

  let pair = null;

  for (;;) {
    pair = await findPumpSwapPool();

    if (pair) {
      break;
    }

    console.log(
      "⏳ Pool PumpSwap introuvable. Nouvelle recherche dans 5s..."
    );

    await new Promise(resolve =>
      setTimeout(resolve, 5000)
    );
  }

  poolAddress = pair.pairAddress;

  console.log("");
  console.log("✅ Pool PumpSwap trouvé !");
  console.log(`Pool : ${poolAddress}`);
  console.log(
    `Liquidité DexScreener : $${fmt(
      pair?.liquidity?.usd || 0
    )}`
  );

  try {
    poolInfo =
      await getPoolInfo(poolAddress);

    console.log("");
    console.log("✅ Pool décodé");
    console.log(`Base mint  : ${poolInfo.baseMint}`);
    console.log(`Quote mint : ${poolInfo.quoteMint}`);
    console.log(`Base vault : ${poolInfo.baseVault}`);
    console.log(`Quote vault: ${poolInfo.quoteVault}`);

    if (poolInfo.baseMint !== MINT) {
      throw new Error(
        `Le base mint du pool (${poolInfo.baseMint}) ne correspond pas au token surveillé (${MINT}).`
      );
    }

    console.log("");
    console.log("🚀 Surveillance ON-CHAIN active.");
    console.log("");

    connectWebSocket();

  } catch (err) {
    console.error(
      "❌ Impossible d'initialiser le radar :",
      err.message
    );

    process.exit(1);
  }
}

start().catch(err => {
  console.error("❌ Erreur fatale :", err);
  process.exit(1);
});
