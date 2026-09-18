"use strict";

/*
===========================================================
CRASH GUARD
===========================================================

Rôle :
- Surveille le pool PumpSwap du token actuellement armé.
- Observe directement les réserves on-chain des vaults.
- Détecte :
    WATCH
    DANGER
    CRITICAL
- CRITICAL = verrouillage immédiat du trading.
- DANGER = blocage des nouveaux achats.
- Expose une API HTTP pour que V5.1 puisse :
    /arm
    /disarm
    /state
    /health
- Peut envoyer le signal directement à V5.1.

IMPORTANT :
Ce module ne fait AUCUNE transaction réelle.
Il ne vend aucun token réellement.
Il transmet uniquement des signaux au bot de simulation V5.1.
===========================================================
*/

const http = require("http");
const WebSocket = require("ws");

/* =========================================================
   CONFIGURATION
========================================================= */

const PORT = Number(process.env.PORT || 3000);

const RPC_HTTP =
  process.env.SOLANA_RPC_HTTP ||
  "https://api.mainnet-beta.solana.com";

const RPC_WS =
  process.env.SOLANA_RPC_WS ||
  "wss://api.mainnet-beta.solana.com";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

const CRASH_GUARD_SECRET =
  process.env.CRASH_GUARD_SECRET || "";

const CRASH_GUARD_TARGET_URL =
  process.env.CRASH_GUARD_TARGET_URL || "";

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

/* =========================================================
   SEUILS
========================================================= */

/*
WATCH
-----
Premier signal.
Aucune action sur V5.1.
*/

const WATCH_DROP_5S = -5;
const WATCH_DROP_10S = -8;

/*
DANGER
------
Bloque les nouveaux achats.
*/

const DANGER_DROP_5S = -10;
const DANGER_DROP_10S = -15;

/*
CRITICAL
--------
Verrouillage total + demande d'urgence à V5.1.
*/

const CRITICAL_DROP_5S = -20;
const CRITICAL_DROP_10S = -30;

/*
Retenue d'un DANGER après disparition du signal.
Cela évite un clignotement DANGER/NORMAL.
*/

const DANGER_HOLD_MS = 15000;

/*
Fréquence de prise des snapshots on-chain.
*/

const SAMPLE_INTERVAL_MS = 1000;

/*
Fréquence des données DexScreener.
*/

const DEX_INTERVAL_MS = 5000;

/*
Taille maximale de l'historique.
*/

const HISTORY_MAX = 120;

/*
Timeout HTTP.
*/

const HTTP_TIMEOUT_MS = 5000;

/* =========================================================
   ÉTAT GLOBAL
========================================================= */

let armed = false;

let currentMint = null;
let currentPool = null;

let baseMint = null;
let quoteMint = null;

let tokenVault = null;
let solVault = null;

let tokenDecimals = 6;

let ws = null;

let tokenVaultSubId = null;
let solVaultSubId = null;

let tokenVaultLamports = null;
let solVaultLamports = null;

let lastSnapshotAt = 0;

let history = [];

let lastDexLiquidityUsd = null;
let lastDexPriceUsd = null;
let lastDexUpdateAt = 0;

let currentLevel = "NORMAL";
let lastLevelChangeAt = 0;
let dangerUntil = 0;

let criticalLatched = false;

let lastSignal = null;

let reconnectTimer = null;
let sampleTimer = null;
let dexTimer = null;

let eventId = 0;

/* =========================================================
   OUTILS
========================================================= */

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function pctChange(oldValue, newValue) {
  if (
    oldValue === null ||
    newValue === null ||
    !Number.isFinite(oldValue) ||
    !Number.isFinite(newValue) ||
    oldValue <= 0
  ) {
    return null;
  }

  return ((newValue - oldValue) / oldValue) * 100;
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body)
  });

  res.end(body);
}

function log(message) {
  console.log(
    `[${new Date().toISOString()}] ${message}`
  );
}

/* =========================================================
   AUTHENTIFICATION API
========================================================= */

function authorized(req) {
  if (!CRASH_GUARD_SECRET) {
    return true;
  }

  const received =
    req.headers["x-crash-guard-secret"];

  return received === CRASH_GUARD_SECRET;
}

/* =========================================================
   RPC HTTP
========================================================= */

async function rpc(method, params = []) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    HTTP_TIMEOUT_MS
  );

  try {
    const response = await fetch(RPC_HTTP, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `RPC HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(
        data.error.message ||
        "RPC error"
      );
    }

    return data.result;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   DEXSCREENER
========================================================= */

async function dexFetch(url) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    HTTP_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(
        `DexScreener HTTP ${response.status}`
      );
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   RECHERCHE DU POOL PUMPSWAP
========================================================= */

async function findPumpSwapPool(mint) {
  const url =
    `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

  const data = await dexFetch(url);

  const pairs = Array.isArray(data)
    ? data
    : [];

  const pumpswapPairs = pairs.filter(pair => {
    return (
      pair &&
      pair.dexId === "pumpswap" &&
      pair.pairAddress
    );
  });

  if (!pumpswapPairs.length) {
    throw new Error(
      "Aucun pool PumpSwap trouvé"
    );
  }

  /*
  On choisit le pool PumpSwap ayant la plus
  grande liquidité disponible au démarrage.
  Puis on le verrouille.
  */

  pumpswapPairs.sort((a, b) => {
    const la =
      Number(a.liquidity?.usd) || 0;

    const lb =
      Number(b.liquidity?.usd) || 0;

    return lb - la;
  });

  const pair = pumpswapPairs[0];

  return {
    poolAddress: pair.pairAddress,
    priceUsd:
      safeNumber(pair.priceUsd),
    liquidityUsd:
      safeNumber(pair.liquidity?.usd),
    baseMint:
      pair.baseToken?.address || null,
    quoteMint:
      pair.quoteToken?.address || null
  };
}

/* =========================================================
   LECTURE DU COMPTE POOL
========================================================= */

function decodePoolAccount(base64Data) {
  const buffer = Buffer.from(
    base64Data,
    "base64"
  );

  if (buffer.length !== 301) {
    throw new Error(
      `Taille compte pool inattendue : ${buffer.length}`
    );
  }

  const baseMint = new (require("@solana/web3.js").PublicKey)(
    buffer.subarray(43, 75)
  ).toBase58();

  const quoteMint = new (require("@solana/web3.js").PublicKey)(
    buffer.subarray(75, 107)
  ).toBase58();

  const baseVault = new (require("@solana/web3.js").PublicKey)(
    buffer.subarray(139, 171)
  ).toBase58();

  const quoteVault = new (require("@solana/web3.js").PublicKey)(
    buffer.subarray(171, 203)
  ).toBase58();

  return {
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
    size: buffer.length
  };
}

/* =========================================================
   DÉCIMALES TOKEN
========================================================= */

async function getTokenDecimals(mint) {
  const result = await rpc(
    "getAccountInfo",
    [
      mint,
      {
        encoding: "jsonParsed"
      }
    ]
  );

  const decimals =
    result?.value?.data?.parsed?.info?.decimals;

  const number = Number(decimals);

  if (!Number.isInteger(number)) {
    throw new Error(
      "Impossible de lire les décimales du token"
    );
  }

  return number;
}

/* =========================================================
   PRIX / LIQUIDITÉ DEX
========================================================= */

async function updateDexData() {
  if (!armed || !currentPool) {
    return;
  }

  try {
    const url =
      `https://api.dexscreener.com/latest/dex/pairs/solana/${currentPool}`;

    const data = await dexFetch(url);

    const pairs = Array.isArray(data?.pairs)
      ? data.pairs
      : [];

    const pair =
      pairs.find(
        p =>
          p &&
          p.dexId === "pumpswap" &&
          p.pairAddress === currentPool
      ) ||
      pairs[0];

    if (!pair) {
      return;
    }

    const liquidity =
      safeNumber(pair.liquidity?.usd);

    const price =
      safeNumber(pair.priceUsd);

    if (
      liquidity !== null &&
      liquidity > 0
    ) {
      lastDexLiquidityUsd = liquidity;
    }

    if (
      price !== null &&
      price > 0
    ) {
      lastDexPriceUsd = price;
    }

    lastDexUpdateAt = now();

  } catch (error) {
    log(
      `⚠️ DexScreener : ${error.message}`
    );
  }
}

/* =========================================================
   WEBSOCKET SOLANA
========================================================= */

function closeWebSocket() {
  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  ws = null;

  tokenVaultSubId = null;
  solVaultSubId = null;
}

function connectWebSocket() {
  if (!armed) {
    return;
  }

  closeWebSocket();

  log("🔌 Connexion WebSocket Solana...");

  ws = new WebSocket(RPC_WS);

  ws.on("open", () => {
    log("🟢 WebSocket Solana connecté");

    subscribeVaults();
  });

  ws.on("message", message => {
    try {
      const data =
        JSON.parse(message.toString());

      handleWebSocketMessage(data);

    } catch (error) {
      log(
        `⚠️ WS message invalide : ${error.message}`
      );
    }
  });

  ws.on("close", () => {
    log("🟡 WebSocket Solana fermé");

    if (armed) {
      scheduleReconnect();
    }
  });

  ws.on("error", error => {
    log(
      `⚠️ WebSocket Solana : ${error.message}`
    );
  });
}

function scheduleReconnect() {
  if (!armed) {
    return;
  }

  if (reconnectTimer) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (armed) {
      connectWebSocket();
    }
  }, 3000);
}

/* =========================================================
   ABONNEMENTS VAULTS
========================================================= */

function subscribeVaults() {
  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN ||
    !tokenVault ||
    !solVault
  ) {
    return;
  }

  tokenVaultSubId = null;
  solVaultSubId = null;

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "accountSubscribe",
      params: [
        tokenVault,
        {
          encoding: "base64",
          commitment: "processed"
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
          commitment: "processed"
        }
      ]
    })
  );

  log(
    `👁️ Surveillance vault token : ${tokenVault}`
  );

  log(
    `👁️ Surveillance vault SOL   : ${solVault}`
  );
}

/* =========================================================
   LECTURE VAULT TOKEN
========================================================= */

function decodeTokenVault(base64Data) {
  const buffer = Buffer.from(
    base64Data,
    "base64"
  );

  if (buffer.length < 72) {
    return null;
  }

  /*
  SPL Token Account :
  amount = offset 64
  */

  const rawAmount =
    buffer.readBigUInt64LE(64);

  return (
    Number(rawAmount) /
    Math.pow(10, tokenDecimals)
  );
}

/* =========================================================
   TRAITEMENT WS
========================================================= */

function handleWebSocketMessage(data) {
  if (
    data.method === "accountNotification"
  ) {
    const subscription =
      data.params?.subscription;

    const value =
      data.params?.result?.value;

    if (!value?.data) {
      return;
    }

    if (
      Array.isArray(value.data) &&
      value.data[0]
    ) {
      const base64Data =
        value.data[0];

      /*
      On identifie la vault grâce
      aux subscriptions retournées.
      */

      if (
        subscription === tokenVaultSubId
      ) {
        const tokenAmount =
          decodeTokenVault(base64Data);

        if (tokenAmount !== null) {
          tokenVaultLamports =
            tokenAmount;
        }
      }

      if (
        subscription === solVaultSubId
      ) {
        const buffer =
          Buffer.from(
            base64Data,
            "base64"
          );

        if (buffer.length >= 8) {
          solVaultLamports =
            Number(
              buffer.readBigUInt64LE(0)
            );
        }
      }
    }
  }

  /*
  Réponse aux accountSubscribe.
  */

  if (
    data.id === 1 &&
    typeof data.result === "number"
  ) {
    tokenVaultSubId = data.result;
  }

  if (
    data.id === 2 &&
    typeof data.result === "number"
  ) {
    solVaultSubId = data.result;
  }
}

/* =========================================================
   SNAPSHOT ON-CHAIN
========================================================= */

function createSnapshot() {
  if (
    tokenVaultLamports === null ||
    solVaultLamports === null
  ) {
    return null;
  }

  const tokenReserve =
    Number(tokenVaultLamports);

  const solLamports =
    Number(solVaultLamports);

  const solReserve =
    solLamports / 1e9;

  if (
    !Number.isFinite(tokenReserve) ||
    !Number.isFinite(solReserve) ||
    tokenReserve <= 0 ||
    solReserve <= 0
  ) {
    return null;
  }

  return {
    timestamp: now(),
    tokenReserve,
    solReserve
  };
}

/* =========================================================
   HISTORIQUE
========================================================= */

function addSnapshot(snapshot) {
  history.push(snapshot);

  while (
    history.length > HISTORY_MAX
  ) {
    history.shift();
  }
}

function findSnapshotAgo(ms) {
  const target =
    now() - ms;

  let best = null;

  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];

    if (item.timestamp <= target) {
      best = item;
      break;
    }
  }

  return best;
}

/* =========================================================
   ANALYSE
========================================================= */

function analyzeSnapshot(snapshot) {
  const old5 =
    findSnapshotAgo(5000);

  const old10 =
    findSnapshotAgo(10000);

  const token5 =
    old5
      ? pctChange(
          old5.tokenReserve,
          snapshot.tokenReserve
        )
      : null;

  const sol5 =
    old5
      ? pctChange(
          old5.solReserve,
          snapshot.solReserve
        )
      : null;

  const token10 =
    old10
      ? pctChange(
          old10.tokenReserve,
          snapshot.tokenReserve
        )
      : null;

  const sol10 =
    old10
      ? pctChange(
          old10.solReserve,
          snapshot.solReserve
        )
      : null;

  return {
    token5,
    sol5,
    token10,
    sol10
  };
}

/* =========================================================
   CLASSIFICATION
========================================================= */

function classify(metrics) {
  const values = [
    metrics.token5,
    metrics.sol5,
    metrics.token10,
    metrics.sol10
  ].filter(
    value =>
      value !== null &&
      Number.isFinite(value)
  );

  if (!values.length) {
    return "NORMAL";
  }

  const min5 = Math.min(
    ...[
      metrics.token5,
      metrics.sol5
    ].filter(
      value =>
        value !== null &&
        Number.isFinite(value)
    )
  );

  const min10 = Math.min(
    ...[
      metrics.token10,
      metrics.sol10
    ].filter(
      value =>
        value !== null &&
        Number.isFinite(value)
    )
  );

  /*
  CRITICAL est sticky.
  */

  if (
    criticalLatched
  ) {
    return "CRITICAL";
  }

  if (
    min5 <= CRITICAL_DROP_5S ||
    min10 <= CRITICAL_DROP_10S
  ) {
    return "CRITICAL";
  }

  if (
    min5 <= DANGER_DROP_5S ||
    min10 <= DANGER_DROP_10S
  ) {
    return "DANGER";
  }

  if (
    min5 <= WATCH_DROP_5S ||
    min10 <= WATCH_DROP_10S
  ) {
    return "WATCH";
  }

  return "NORMAL";
}

/* =========================================================
   SIGNAL
========================================================= */

function buildSignal(level, metrics) {
  const id =
    ++eventId;

  return {
    id,
    level,
    mint: currentMint,
    pool: currentPool,
    timestamp: new Date().toISOString(),

    onchain: {
      token5s: metrics.token5,
      sol5s: metrics.sol5,
      token10s: metrics.token10,
      sol10s: metrics.sol10
    },

    dex: {
      priceUsd: lastDexPriceUsd,
      liquidityUsd: lastDexLiquidityUsd,
      lastUpdate:
        lastDexUpdateAt
          ? new Date(
              lastDexUpdateAt
            ).toISOString()
          : null
    }
  };
}

/* =========================================================
   NOTIFICATION TELEGRAM
========================================================= */

async function sendTelegram(message) {
  if (
    !BOT_TOKEN ||
    !CHAT_ID
  ) {
    return;
  }

  try {
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
  } catch (error) {
    log(
      `⚠️ Telegram : ${error.message}`
    );
  }
}

/* =========================================================
   ENVOI À V5.1
========================================================= */

async function sendSignalToV51(signal) {
  if (!CRASH_GUARD_TARGET_URL) {
    return;
  }

  try {
    const controller =
      new AbortController();

    const timer =
      setTimeout(
        () => controller.abort(),
        HTTP_TIMEOUT_MS
      );

    const response =
      await fetch(
        `${CRASH_GUARD_TARGET_URL.replace(/\/$/, "")}/crash-guard/event`,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json",

            "x-crash-guard-secret":
              CRASH_GUARD_SECRET
          },
          body: JSON.stringify(signal),
          signal: controller.signal
        }
      );

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(
        `V5.1 HTTP ${response.status}`
      );
    }

    log(
      `📡 Signal ${signal.level} envoyé à V5.1`
    );

  } catch (error) {
    log(
      `⚠️ Envoi V5.1 : ${error.message}`
    );
  }
}

/* =========================================================
   CHANGEMENT DE NIVEAU
========================================================= */

async function applyLevel(level, metrics) {
  const previous =
    currentLevel;

  /*
  CRITICAL reste définitivement verrouillé
  jusqu'au DISARM.
  */

  if (
    level === "CRITICAL"
  ) {
    criticalLatched = true;
  }

  /*
  DANGER possède une retenue temporaire.
  */

  if (
    level === "DANGER"
  ) {
    dangerUntil =
      now() + DANGER_HOLD_MS;
  }

  /*
  Si CRITICAL est déjà actif,
  on ne redescend jamais.
  */

  if (
    criticalLatched
  ) {
    level = "CRITICAL";
  }

  /*
  DANGER maintenu pendant la fenêtre.
  */

  if (
    level === "NORMAL" &&
    dangerUntil > now() &&
    !criticalLatched
  ) {
    level = "DANGER";
  }

  if (
    level === previous
  ) {
    return;
  }

  currentLevel =
    level;

  lastLevelChangeAt =
    now();

  lastSignal =
    buildSignal(
      level,
      metrics
    );

  log(
    `🚨 CRASH GUARD : ${previous} → ${level}`
  );

  if (
    level === "WATCH"
  ) {
    await sendTelegram(
      [
        "🟡 CRASH GUARD WATCH",
        "",
        `Token : ${currentMint}`,
        `Pool : ${currentPool}`,
        "",
        `Token 5s : ${formatPct(metrics.token5)}`,
        `SOL 5s : ${formatPct(metrics.sol5)}`,
        `Token 10s : ${formatPct(metrics.token10)}`,
        `SOL 10s : ${formatPct(metrics.sol10)}`
      ].join("\n")
    );
  }

  if (
    level === "DANGER"
  ) {
    await sendTelegram(
      [
        "🟠 CRASH GUARD DANGER",
        "",
        `Token : ${currentMint}`,
        "",
        "⛔ Nouveaux achats à bloquer.",
        "",
        `Token 5s : ${formatPct(metrics.token5)}`,
        `SOL 5s : ${formatPct(metrics.sol5)}`,
        `Token 10s : ${formatPct(metrics.token10)}`,
        `SOL 10s : ${formatPct(metrics.sol10)}`
      ].join("\n")
    );

    await sendSignalToV51(
      lastSignal
    );
  }

  if (
    level === "CRITICAL"
  ) {
    await sendTelegram(
      [
        "🔴 CRASH GUARD CRITICAL",
        "",
        `Token : ${currentMint}`,
        "",
        "🚨 VERROUILLAGE TOTAL",
        "⛔ Achats bloqués",
        "⛔ Ventes normales bloquées",
        "🚨 Sortie d'urgence demandée à V5.1",
        "",
        `Token 5s : ${formatPct(metrics.token5)}`,
        `SOL 5s : ${formatPct(metrics.sol5)}`,
        `Token 10s : ${formatPct(metrics.token10)}`,
        `SOL 10s : ${formatPct(metrics.sol10)}`
      ].join("\n")
    );

    await sendSignalToV51(
      lastSignal
    );
  }
}

function formatPct(value) {
  if (
    value === null ||
    !Number.isFinite(value)
  ) {
    return "N/A";
  }

  return `${value.toFixed(2)}%`;
}

/* =========================================================
   BOUCLE DE SURVEILLANCE ON-CHAIN
========================================================= */

async function sampleOnChain() {
  if (!armed) {
    return;
  }

  const snapshot =
    createSnapshot();

  if (!snapshot) {
    return;
  }

  /*
  Évite de mettre plusieurs snapshots
  dans la même milliseconde.
  */

  if (
    snapshot.timestamp ===
    lastSnapshotAt
  ) {
    return;
  }

  lastSnapshotAt =
    snapshot.timestamp;

  addSnapshot(
    snapshot
  );

  /*
  Il faut suffisamment d'historique
  avant de déclencher un signal.
  */

  if (
    history.length < 6
  ) {
    return;
  }

  const metrics =
    analyzeSnapshot(
      snapshot
    );

  const level =
    classify(metrics);

  await applyLevel(
    level,
    metrics
  );
}

/* =========================================================
   ARM
========================================================= */

async function arm(mint) {
  if (
    !mint ||
    typeof mint !== "string"
  ) {
    throw new Error(
      "Mint invalide"
    );
  }

  await disarm(false);

  log(
    `🎯 ARM Crash Guard : ${mint}`
  );

  const poolInfo =
    await findPumpSwapPool(
      mint
    );

  currentMint =
    mint;

  currentPool =
    poolInfo.poolAddress;

  const poolAccount =
    await rpc(
      "getAccountInfo",
      [
        currentPool,
        {
          encoding: "base64"
        }
      ]
    );

  const encoded =
    poolAccount?.value?.data?.[0];

  if (!encoded) {
    throw new Error(
      "Compte pool introuvable"
    );
  }

  const decoded =
    decodePoolAccount(
      encoded
    );

  baseMint =
    decoded.baseMint;

  quoteMint =
    decoded.quoteMint;

  if (
    baseMint === SOL_MINT
  ) {
    solVault =
      decoded.baseVault;

    tokenVault =
      decoded.quoteVault;
  } else if (
    quoteMint === SOL_MINT
  ) {
    tokenVault =
      decoded.baseVault;

    solVault =
      decoded.quoteVault;
  } else {
    throw new Error(
      "Le pool PumpSwap ne contient pas SOL"
    );
  }

  /*
  Décimales du token.
  */

  tokenDecimals =
    await getTokenDecimals(
      currentMint
    );

  /*
  État initial.
  */

  armed = true;

  currentLevel =
    "NORMAL";

  criticalLatched =
    false;

  dangerUntil = 0;

  lastSignal =
    null;

  history = [];

  tokenVaultLamports =
    null;

  solVaultLamports =
    null;

  lastDexLiquidityUsd =
    poolInfo.liquidityUsd;

  lastDexPriceUsd =
    poolInfo.priceUsd;

  lastDexUpdateAt =
    now();

  log("");
  log("========================================");
  log("🛡️ CRASH GUARD ARMÉ");
  log("========================================");
  log(`Token       : ${currentMint}`);
  log(`Pool        : ${currentPool}`);
  log(`Base mint   : ${baseMint}`);
  log(`Quote mint  : ${quoteMint}`);
  log(`Token vault : ${tokenVault}`);
  log(`SOL vault   : ${solVault}`);
  log(`Décimales   : ${tokenDecimals}`);
  log(
    `Liquidité DEX initiale : ${
      lastDexLiquidityUsd !== null
        ? `$${lastDexLiquidityUsd.toFixed(2)}`
        : "N/A"
    }`
  );
  log("========================================");
  log("");

  connectWebSocket();

  sampleTimer =
    setInterval(
      () => {
        sampleOnChain()
          .catch(error => {
            log(
              `⚠️ Sample : ${error.message}`
            );
          });
      },
      SAMPLE_INTERVAL_MS
    );

  dexTimer =
    setInterval(
      () => {
        updateDexData()
          .catch(error => {
            log(
              `⚠️ DEX : ${error.message}`
            );
          });
      },
      DEX_INTERVAL_MS
    );

  /*
  Première récupération immédiate.
  */

  await updateDexData();

  return getState();
}

/* =========================================================
   DISARM
========================================================= */

async function disarm(logIt = true) {
  armed = false;

  currentMint = null;
  currentPool = null;

  baseMint = null;
  quoteMint = null;

  tokenVault = null;
  solVault = null;

  tokenDecimals = 6;

  tokenVaultLamports = null;
  solVaultLamports = null;

  history = [];

  currentLevel = "NORMAL";

  criticalLatched = false;

  dangerUntil = 0;

  lastSignal = null;

  lastDexLiquidityUsd = null;
  lastDexPriceUsd = null;
  lastDexUpdateAt = 0;

  lastSnapshotAt = 0;

  closeWebSocket();

  if (reconnectTimer) {
    clearTimeout(
      reconnectTimer
    );

    reconnectTimer = null;
  }

  if (sampleTimer) {
    clearInterval(
      sampleTimer
    );

    sampleTimer = null;
  }

  if (dexTimer) {
    clearInterval(
      dexTimer
    );

    dexTimer = null;
  }

  if (logIt) {
    log(
      "🛑 Crash Guard désarmé"
    );
  }
}

/* =========================================================
   ÉTAT PUBLIC
========================================================= */

function getState() {
  return {
    armed,

    level:
      currentLevel,

    criticalLatched,

    dangerUntil,

    mint:
      currentMint,

    pool:
      currentPool,

    tokenVault,
    solVault,

    tokenDecimals,

    websocket:
      ws?.readyState === WebSocket.OPEN
        ? "LIVE"
        : armed
          ? "WAITING"
          : "OFFLINE",

    historySamples:
      history.length,

    dex: {
      priceUsd:
        lastDexPriceUsd,

      liquidityUsd:
        lastDexLiquidityUsd,

      lastUpdate:
        lastDexUpdateAt
          ? new Date(
              lastDexUpdateAt
            ).toISOString()
          : null
    },

    lastSignal,

    timestamp:
      new Date().toISOString()
  };
}

/* =========================================================
   SERVEUR HTTP
========================================================= */

const server =
  http.createServer(
    async (req, res) => {

      /*
      HEALTH
      */

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        return json(
          res,
          200,
          {
            ok: true,
            service:
              "crash-guard",
            timestamp:
              new Date().toISOString()
          }
        );
      }

      /*
      STATE
      */

      if (
        req.method === "GET" &&
        req.url === "/state"
      ) {
        if (!authorized(req)) {
          return json(
            res,
            401,
            {
              ok: false,
              error:
                "Unauthorized"
            }
          );
        }

        return json(
          res,
          200,
          getState()
        );
      }

      /*
      DISARM
      */

      if (
        req.method === "POST" &&
        req.url === "/disarm"
      ) {
        if (!authorized(req)) {
          return json(
            res,
            401,
            {
              ok: false,
              error:
                "Unauthorized"
            }
          );
        }

        await disarm();

        return json(
          res,
          200,
          {
            ok: true,
            state:
              getState()
          }
        );
      }

      /*
      ARM
      */

      if (
        req.method === "POST" &&
        req.url === "/arm"
      ) {
        if (!authorized(req)) {
          return json(
            res,
            401,
            {
              ok: false,
              error:
                "Unauthorized"
            }
          );
        }

        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk.toString();

            /*
            Petite protection contre
            les requêtes anormalement grandes.
            */

            if (
              body.length > 10000
            ) {
              req.destroy();
            }
          }
        );

        req.on(
          "end",
          async () => {
            try {
              const payload =
                JSON.parse(
                  body || "{}"
                );

              const state =
                await arm(
                  payload.mint
                );

              return json(
                res,
                200,
                {
                  ok: true,
                  state
                }
              );

            } catch (error) {
              log(
                `❌ ARM : ${error.message}`
              );

              return json(
                res,
                500,
                {
                  ok: false,
                  error:
                    error.message
                }
              );
            }
          }
        );

        return;
      }

      /*
      404
      */

      return json(
        res,
        404,
        {
          ok: false,
          error:
            "Not found"
        }
      );
    }
  );

/* =========================================================
   START
========================================================= */

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    log("");
    log("========================================");
    log("🛡️ CRASH GUARD DÉMARRÉ");
    log("========================================");
    log(`Port : ${PORT}`);
    log(
      `RPC  : ${RPC_HTTP}`
    );
    log(
      `Target V5.1 : ${
        CRASH_GUARD_TARGET_URL
          ? "CONFIGURÉ"
          : "NON CONFIGURÉ"
      }`
    );
    log("");
    log(
      "En attente de /arm depuis V5.1..."
    );
    log("========================================");
    log("");
  }
);

/* =========================================================
   ARRÊT PROPRE
========================================================= */

async function shutdown() {
  log(
    "🛑 Arrêt Crash Guard..."
  );

  await disarm(false);

  server.close(
    () => {
      process.exit(0);
    }
  );
}

process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
);
