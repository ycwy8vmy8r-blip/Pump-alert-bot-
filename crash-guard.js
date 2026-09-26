"use strict";

const http = require("http");
const WebSocket = require("ws");
const { PublicKey } = require("@solana/web3.js");

// ============================================================
// CONFIGURATION
// ============================================================

const PORT = Number(process.env.PORT || 3000);

const RPC_HTTP =
  process.env.RPC_HTTP || "https://api.mainnet-beta.solana.com";

const RPC_WS =
  process.env.RPC_WS || "wss://api.mainnet-beta.solana.com";

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

const CRASH_GUARD_SECRET =
  process.env.CRASH_GUARD_SECRET || "";

const CRASH_GUARD_TARGET_URL =
  (process.env.CRASH_GUARD_TARGET_URL || "").replace(/\/+$/, "");

const PUMP_SWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const SOL_MINT = "So11111111111111111111111111111111111111112";

// Seuils de variation des réserves on-chain.
const WATCH_DROP_5S = Number(process.env.WATCH_DROP_5S || -5);
const WATCH_DROP_10S = Number(process.env.WATCH_DROP_10S || -8);

const DANGER_DROP_5S = Number(process.env.DANGER_DROP_5S || -10);
const DANGER_DROP_10S = Number(process.env.DANGER_DROP_10S || -15);

const CRITICAL_DROP_5S = Number(process.env.CRITICAL_DROP_5S || -20);
const CRITICAL_DROP_10S = Number(process.env.CRITICAL_DROP_10S || -30);

const DANGER_HOLD_MS = Number(process.env.DANGER_HOLD_MS || 15000);

const SAMPLE_INTERVAL_MS = 1000;
const DEX_INTERVAL_MS = 15000;
const DEX_BACKOFF_MS = 15000;
const DEX_CACHE_TTL_MS = 10000;
const HISTORY_MAX = 120;
const HTTP_TIMEOUT_MS = 10000;

const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

const POOL_BASE_MINT_OFFSET = 43;
const POOL_QUOTE_MINT_OFFSET = 75;
const POOL_BASE_VAULT_OFFSET = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;

// ============================================================
// STATE
// ============================================================

let armed = false;
let currentMint = null;
let currentPool = null;

let baseMint = null;
let quoteMint = null;
let baseVault = null;
let quoteVault = null;
let tokenVault = null;
let solVault = null;
let tokenDecimals = 0;
let tokenIsBase = true;

let ws = null;
let reconnectTimer = null;
let sampleTimer = null;
let dexTimer = null;

let reconnectAttempts = 0;
let subscriptionIds = new Map();
let vaultAmounts = {
  token: null,
  sol: null,
};

let history = [];
let dexData = null;
let dexUnavailable = false;
let dexLastError = null;
let dexBlockedUntil = 0;
let dexLastRequestAt = 0;
let dexCacheAt = 0;
let dexErrorLogged = false;

let level = "NORMAL";
let dangerUntil = 0;
let criticalLatched = false;
let lastSignal = null;
let eventId = 0;

let starting = false;
let stopping = false;

// ============================================================
// UTILITIES
// ============================================================

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPubkey(data, offset) {
  if (!data || data.length < offset + 32) {
    throw new Error(`Données de pool insuffisantes à l'offset ${offset}`);
  }

  return new PublicKey(data.subarray(offset, offset + 32)).toBase58();
}

function readTokenAmount(data) {
  if (!data || data.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) {
    return null;
  }

  return data.readBigUInt64LE(TOKEN_ACCOUNT_AMOUNT_OFFSET);
}

function rawToNumber(raw, decimals = 0) {
  if (raw === null || raw === undefined) return null;
  return Number(raw) / Math.pow(10, decimals);
}

function percentChange(oldValue, newValue) {
  if (
    oldValue === null ||
    oldValue === undefined ||
    newValue === null ||
    newValue === undefined ||
    oldValue === 0
  ) {
    return null;
  }

  return ((newValue - oldValue) / oldValue) * 100;
}

function safeNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  return Number(value);
}

function parseBase64Account(account) {
  if (!account || !account.data || !account.data[0]) {
    return null;
  }

  return Buffer.from(account.data[0], "base64");
}

function isWsolMint(mint) {
  return mint === SOL_MINT;
}

function validateMint(mint) {
  try {
    new PublicKey(mint);
    return true;
  } catch {
    return false;
  }
}

// ============================================================
// HTTP / RPC
// ============================================================

async function fetchJson(url, options = {}, timeoutMs = HTTP_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const text = await response.text();
    let json = null;

    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`Réponse JSON invalide, HTTP ${response.status}`);
    }

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;

      const retryAfter = response.headers.get("retry-after");
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (Number.isFinite(seconds)) {
          error.retryAfterMs = Math.max(0, seconds * 1000);
        }
      }

      throw error;
    }

    return json;
  } finally {
    clearTimeout(timeout);
  }
}

async function rpc(method, params) {
  const json = await fetchJson(
    RPC_HTTP,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        params,
      }),
    },
    HTTP_TIMEOUT_MS
  );

  if (json.error) {
    throw new Error(
      `RPC ${method}: ${json.error.message || JSON.stringify(json.error)}`
    );
  }

  return json.result;
}

async function getAccountInfo(address) {
  return rpc("getAccountInfo", [
    address,
    {
      encoding: "base64",
      commitment: "confirmed",
    },
  ]);
}

// ============================================================
// DEXSCREENER
// ============================================================

function getRetryAfterMs(error) {
  if (error && Number.isFinite(error.retryAfterMs)) {
    return Math.max(error.retryAfterMs, DEX_BACKOFF_MS);
  }

  return DEX_BACKOFF_MS;
}

async function dexFetch(url) {
  const now = Date.now();

  if (now < dexBlockedUntil) {
    const error = new Error("DexScreener temporairement limité");
    error.status = 429;
    throw error;
  }

  try {
    const result = await fetchJson(url, {}, HTTP_TIMEOUT_MS);

    if (dexUnavailable) {
      log("DexScreener de nouveau disponible.");
    }

    dexUnavailable = false;
    dexLastError = null;
    dexErrorLogged = false;

    return result;
  } catch (error) {
    if (error.status === 429) {
      dexBlockedUntil = Date.now() + getRetryAfterMs(error);
      dexUnavailable = true;
      dexLastError = "HTTP 429";

      if (!dexErrorLogged) {
        log(
          "DexScreener HTTP 429. Pause des requêtes jusqu'à",
          new Date(dexBlockedUntil).toISOString()
        );
        dexErrorLogged = true;
      }
    }

    throw error;
  }
}

function normalizeDexPair(pair) {
  if (!pair) return null;

  return {
    pairAddress: pair.pairAddress || null,
    dexId: pair.dexId || null,
    priceUsd: safeNumber(Number(pair.priceUsd)),
    liquidityUsd: safeNumber(Number(pair.liquidity?.usd)),
    volume24hUsd: safeNumber(Number(pair.volume?.h24)),
    priceChange5m: safeNumber(Number(pair.priceChange?.m5)),
    priceChange1h: safeNumber(Number(pair.priceChange?.h1)),
    baseMint: pair.baseToken?.address || null,
    quoteMint: pair.quoteToken?.address || null,
    updatedAt: Date.now(),
  };
}

function selectSolPair(pairs, mint) {
  if (!Array.isArray(pairs)) return null;

  const candidates = pairs.filter((pair) => {
    if (!pair || pair.chainId !== "solana") return false;
    if (String(pair.dexId || "").toLowerCase() !== "pumpswap") {
      return false;
    }

    const base = pair.baseToken?.address;
    const quote = pair.quoteToken?.address;

    return (
      (base === mint && isWsolMint(quote)) ||
      (quote === mint && isWsolMint(base))
    );
  });

  candidates.sort(
    (a, b) =>
      Number(b.liquidity?.usd || 0) -
      Number(a.liquidity?.usd || 0)
  );

  return candidates[0] || null;
}

async function findPoolWithDexScreener(mint) {
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;
  const pairs = await dexFetch(url);
  const pair = selectSolPair(pairs, mint);

  if (!pair) {
    throw new Error("Aucun pool PumpSwap avec WSOL trouvé sur DexScreener");
  }

  return {
    poolAddress: pair.pairAddress,
    dexPair: normalizeDexPair(pair),
  };
}

// ============================================================
// PUMPSWAP POOL DISCOVERY VIA SOLANA RPC
// ============================================================

function decodePoolAccount(pubkey, account) {
  const data = parseBase64Account(account);

  // Accepte les versions de compte dont la taille a évolué,
  // mais exige que tous les champs utilisés soient présents.
  const minLength = POOL_QUOTE_VAULT_OFFSET + 32;

  if (!data || data.length < minLength) {
    return null;
  }

  try {
    const decodedBaseMint = readPubkey(data, POOL_BASE_MINT_OFFSET);
    const decodedQuoteMint = readPubkey(data, POOL_QUOTE_MINT_OFFSET);
    const decodedBaseVault = readPubkey(data, POOL_BASE_VAULT_OFFSET);
    const decodedQuoteVault = readPubkey(data, POOL_QUOTE_VAULT_OFFSET);

    return {
      poolAddress: pubkey,
      baseMint: decodedBaseMint,
      quoteMint: decodedQuoteMint,
      baseVault: decodedBaseVault,
      quoteVault: decodedQuoteVault,
    };
  } catch {
    return null;
  }
}

async function getPoolsByMintOffset(mint, offset) {
  const accounts = await rpc("getProgramAccounts", [
    PUMP_SWAP_PROGRAM_ID,
    {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        {
          memcmp: {
            offset,
            bytes: mint,
          },
        },
      ],
    },
  ]);

  if (!Array.isArray(accounts)) return [];

  return accounts
    .map((entry) => decodePoolAccount(entry.pubkey, entry.account))
    .filter(Boolean);
}

async function getTokenDecimals(mint) {
  const result = await getAccountInfo(mint);
  const data = parseBase64Account(result?.value);

  if (!data || data.length < 45) {
    throw new Error(`Impossible de lire les décimales du mint ${mint}`);
  }

  return data[44];
}

async function getVaultRawAmount(address) {
  const result = await getAccountInfo(address);
  const data = parseBase64Account(result?.value);

  if (!data) {
    throw new Error(`Compte de réserve introuvable: ${address}`);
  }

  const amount = readTokenAmount(data);

  if (amount === null) {
    throw new Error(`Compte de réserve invalide: ${address}`);
  }

  return amount;
}

async function getSolPoolCandidates(mint) {
  const [baseCandidates, quoteCandidates] = await Promise.all([
    getPoolsByMintOffset(mint, POOL_BASE_MINT_OFFSET),
    getPoolsByMintOffset(mint, POOL_QUOTE_MINT_OFFSET),
  ]);

  const combined = new Map();

  for (const pool of [...baseCandidates, ...quoteCandidates]) {
    if (!pool || !pool.poolAddress) continue;

    const validOrientation =
      (pool.baseMint === mint && isWsolMint(pool.quoteMint)) ||
      (pool.quoteMint === mint && isWsolMint(pool.baseMint));

    // IMPORTANT : les pools USDC et les autres quotes sont rejetés ici.
    if (!validOrientation) continue;

    combined.set(pool.poolAddress, pool);
  }

  return [...combined.values()];
}

async function findPoolWithRpc(mint) {
  log("Recherche RPC de pools PumpSwap SOL pour", mint);

  const candidates = await getSolPoolCandidates(mint);

  if (candidates.length === 0) {
    throw new Error(
      "Aucun pool PumpSwap SOL/WSOL trouvé pour ce token. " +
      "Les pools USDC et autres quotes ont été ignorés."
    );
  }

  // Le pool avec la réserve WSOL la plus élevée est retenu.
  // Cela évite de sélectionner un pool USDC par erreur.
  const scored = await Promise.all(
    candidates.map(async (pool) => {
      try {
        const tokenIsBase = pool.baseMint === mint;
        const candidateTokenVault = tokenIsBase
          ? pool.baseVault
          : pool.quoteVault;
        const candidateSolVault = tokenIsBase
          ? pool.quoteVault
          : pool.baseVault;

        const solRaw = await getVaultRawAmount(candidateSolVault);

        return {
          ...pool,
          tokenIsBase,
          tokenVault: candidateTokenVault,
          solVault: candidateSolVault,
          solRaw,
        };
      } catch (error) {
        log(
          "Pool ignoré, lecture de réserve impossible:",
          pool.poolAddress,
          error.message
        );
        return null;
      }
    })
  );

  const valid = scored.filter(Boolean);

  if (valid.length === 0) {
    throw new Error(
      "Pools PumpSwap SOL trouvés, mais leurs réserves WSOL sont illisibles."
    );
  }

  valid.sort((a, b) => {
    if (a.solRaw > b.solRaw) return -1;
    if (a.solRaw < b.solRaw) return 1;
    return 0;
  });

  const selected = valid[0];

  log(
    "Pool SOL sélectionné via RPC:",
    selected.poolAddress,
    "réserve WSOL brute:",
    selected.solRaw.toString()
  );

  return {
    poolAddress: selected.poolAddress,
    pool: selected,
  };
}

async function discoverPool(mint) {
  try {
    const result = await findPoolWithDexScreener(mint);

    log("Pool PumpSwap SOL trouvé via DexScreener:", result.poolAddress);

    return {
      poolAddress: result.poolAddress,
      dexPair: result.dexPair,
    };
  } catch (error) {
    log(
      "Découverte DexScreener indisponible ou sans pool SOL:",
      error.message
    );
  }

  // DexScreener n'est pas indispensable à la découverte du pool.
  return findPoolWithRpc(mint);
}

// ============================================================
// POOL INITIALIZATION
// ============================================================

async function initializePool(mint, poolAddress) {
  const result = await getAccountInfo(poolAddress);
  const decoded = decodePoolAccount(poolAddress, result?.value);

  if (!decoded) {
    throw new Error(
      `Impossible de décoder le compte du pool PumpSwap ${poolAddress}`
    );
  }

  const tokenIsBase = decoded.baseMint === mint;
  const tokenIsQuote = decoded.quoteMint === mint;

  if (!tokenIsBase && !tokenIsQuote) {
    throw new Error("Le pool trouvé ne contient pas le token demandé.");
  }

  const quoteIsSol =
    (tokenIsBase && isWsolMint(decoded.quoteMint)) ||
    (tokenIsQuote && isWsolMint(decoded.baseMint));

  if (!quoteIsSol) {
    throw new Error(
      `Pool non accepté : quoteMint/baseMint n'est pas WSOL. ` +
      `baseMint=${decoded.baseMint}, quoteMint=${decoded.quoteMint}`
    );
  }

  const selectedTokenVault = tokenIsBase
    ? decoded.baseVault
    : decoded.quoteVault;

  const selectedSolVault = tokenIsBase
    ? decoded.quoteVault
    : decoded.baseVault;

  const decimals = await getTokenDecimals(mint);

  // Vérifie que les deux comptes de réserve sont lisibles.
  const [tokenRaw, solRaw] = await Promise.all([
    getVaultRawAmount(selectedTokenVault),
    getVaultRawAmount(selectedSolVault),
  ]);

  return {
    poolAddress,
    baseMint: decoded.baseMint,
    quoteMint: decoded.quoteMint,
    baseVault: decoded.baseVault,
    quoteVault: decoded.quoteVault,
    tokenVault: selectedTokenVault,
    solVault: selectedSolVault,
    tokenDecimals: decimals,
    tokenIsBase: tokenIsBase,
    initialTokenRaw: tokenRaw,
    initialSolRaw: solRaw,
  };
}

// ============================================================
// DEX DATA REFRESH
// ============================================================

async function updateDexData() {
  if (!armed || !currentPool) return;

  const now = Date.now();

  if (now < dexBlockedUntil) {
    dexUnavailable = true;
    dexLastError = "DexScreener en pause après limitation de débit";
    return;
  }

  if (now - dexLastRequestAt < DEX_CACHE_TTL_MS) {
    return;
  }

  dexLastRequestAt = now;

  try {
    const url =
      `https://api.dexscreener.com/latest/dex/pairs/solana/${currentPool}`;

    const json = await dexFetch(url);
    const pairs = Array.isArray(json?.pairs) ? json.pairs : [];

    const pair = pairs.find((item) => {
      if (!item || item.chainId !== "solana") return false;
      if (String(item.dexId || "").toLowerCase() !== "pumpswap") {
        return false;
      }

      const base = item.baseToken?.address;
      const quote = item.quoteToken?.address;

      return (
        (base === currentMint && isWsolMint(quote)) ||
        (quote === currentMint && isWsolMint(base))
      );
    });

    if (!pair) {
      throw new Error("Pair SOL/WSOL non trouvée dans la réponse DexScreener");
    }

    dexData = normalizeDexPair(pair);
    dexCacheAt = Date.now();
    dexUnavailable = false;
    dexLastError = null;
  } catch (error) {
    dexUnavailable = true;
    dexLastError = error.message;

    // Ne pas supprimer les dernières données valides en cas de 429.
    if (error.status !== 429) {
      log("Mise à jour DexScreener impossible:", error.message);
    }
  }
}

// ============================================================
// WEBSOCKET SUBSCRIPTIONS
// ============================================================

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function closeWebSocket() {
  clearReconnectTimer();

  if (ws) {
    const old = ws;
    ws = null;

    try {
      old.removeAllListeners();
      old.close();
    } catch {
      // Ignorer une fermeture déjà effectuée.
    }
  }

  subscriptionIds.clear();
}

function connectWebSocket() {
  if (!armed || !tokenVault || !solVault) return;

  clearReconnectTimer();

  try {
    ws = new WebSocket(RPC_WS);
  } catch (error) {
    scheduleReconnect(error.message);
    return;
  }

  ws.on("open", () => {
    reconnectAttempts = 0;
    log("Crash Guard WebSocket connecté.");

    subscribeVault("token", tokenVault);
    subscribeVault("sol", solVault);
  });

  ws.on("message", (buffer) => {
    handleWebSocketMessage(buffer.toString());
  });

  ws.on("error", (error) => {
    log("WebSocket:", error.message);
  });

  ws.on("close", () => {
    if (ws) ws = null;
    subscriptionIds.clear();

    if (armed) {
      scheduleReconnect("WebSocket fermé");
    }
  });
}

function subscribeVault(kind, address) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const requestId = kind === "token" ? 101 : 102;

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method: "accountSubscribe",
      params: [
        address,
        {
          encoding: "base64",
          commitment: "confirmed",
        },
      ],
    })
  );

  subscriptionIds.set(requestId, kind);
}

function scheduleReconnect(reason) {
  if (!armed || reconnectTimer) return;

  reconnectAttempts += 1;

  const delay = Math.min(
    30000,
    1000 * Math.pow(2, Math.min(reconnectAttempts - 1, 5))
  );

  log(
    `Reconnexion WebSocket dans ${delay} ms (${reason}).`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (armed) connectWebSocket();
  }, delay);
}

function handleWebSocketMessage(text) {
  let message;

  try {
    message = JSON.parse(text);
  } catch {
    return;
  }

  if (message.id !== undefined && message.result !== undefined) {
    const kind = subscriptionIds.get(message.id);

    if (kind) {
      subscriptionIds.set(message.result, kind);
      subscriptionIds.delete(message.id);
    }

    return;
  }

  if (message.method !== "accountNotification") return;

  const subscription = message.params?.subscription;
  const kind = subscriptionIds.get(subscription);

  if (!kind) return;

  const account = message.params?.result?.value;
  const data = parseBase64Account(account);

  if (!data) return;

  const amount = readTokenAmount(data);

  if (amount === null) return;

  if (kind === "token") {
    vaultAmounts.token = amount;
  } else if (kind === "sol") {
    vaultAmounts.sol = amount;
  }
}

// ============================================================
// ON-CHAIN SNAPSHOTS AND CLASSIFICATION
// ============================================================

async function refreshVaultAmounts() {
  const [tokenRaw, solRaw] = await Promise.all([
    getVaultRawAmount(tokenVault),
    getVaultRawAmount(solVault),
  ]);

  vaultAmounts.token = tokenRaw;
  vaultAmounts.sol = solRaw;
}

function createSnapshot() {
  if (vaultAmounts.token === null || vaultAmounts.sol === null) {
    return null;
  }

  const now = Date.now();

  const tokenReserve = rawToNumber(
    vaultAmounts.token,
    tokenDecimals
  );

  const solReserve = rawToNumber(vaultAmounts.sol, 9);

  if (
    !Number.isFinite(tokenReserve) ||
    !Number.isFinite(solReserve) ||
    tokenReserve <= 0 ||
    solReserve <= 0
  ) {
    return null;
  }

  return {
    timestamp: now,
    tokenReserve,
    solReserve,
    tokenRaw: vaultAmounts.token.toString(),
    solRaw: vaultAmounts.sol.toString(),
    dexPriceUsd: dexData?.priceUsd ?? null,
    dexLiquidityUsd: dexData?.liquidityUsd ?? null,
    dexUnavailable,
    dexLastError,
  };
}

function getSnapshotAtOrBefore(targetTimestamp) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].timestamp <= targetTimestamp) {
      return history[i];
    }
  }

  return null;
}

function analyzeSnapshot(snapshot) {
  const fiveSecondsAgo = getSnapshotAtOrBefore(
    snapshot.timestamp - 5000
  );

  const tenSecondsAgo = getSnapshotAtOrBefore(
    snapshot.timestamp - 10000
  );

  const token5 = fiveSecondsAgo
    ? percentChange(
        fiveSecondsAgo.tokenReserve,
        snapshot.tokenReserve
      )
    : null;

  const token10 = tenSecondsAgo
    ? percentChange(
        tenSecondsAgo.tokenReserve,
        snapshot.tokenReserve
      )
    : null;

  const sol5 = fiveSecondsAgo
    ? percentChange(
        fiveSecondsAgo.solReserve,
        snapshot.solReserve
      )
    : null;

  const sol10 = tenSecondsAgo
    ? percentChange(
        tenSecondsAgo.solReserve,
        snapshot.solReserve
      )
    : null;

  return {
    tokenChange5s: token5,
    tokenChange10s: token10,
    solChange5s: sol5,
    solChange10s: sol10,
    historyReady: Boolean(fiveSecondsAgo && tenSecondsAgo),
  };
}

function classify(metrics) {
  if (!metrics.historyReady) {
    return "NORMAL";
  }

  const changes = [
    metrics.tokenChange5s,
    metrics.tokenChange10s,
    metrics.solChange5s,
    metrics.solChange10s,
  ].filter((value) => value !== null && Number.isFinite(value));

  if (changes.length === 0) return "NORMAL";

  const worst5 = Math.min(
    metrics.tokenChange5s ?? 0,
    metrics.solChange5s ?? 0
  );

  const worst10 = Math.min(
    metrics.tokenChange10s ?? 0,
    metrics.solChange10s ?? 0
  );

  if (
    criticalLatched ||
    worst5 <= CRITICAL_DROP_5S ||
    worst10 <= CRITICAL_DROP_10S
  ) {
    criticalLatched = true;
    return "CRITICAL";
  }

  if (
    worst5 <= DANGER_DROP_5S ||
    worst10 <= DANGER_DROP_10S
  ) {
    dangerUntil = Date.now() + DANGER_HOLD_MS;
    return "DANGER";
  }

  if (Date.now() < dangerUntil) {
    return "DANGER";
  }

  if (
    worst5 <= WATCH_DROP_5S ||
    worst10 <= WATCH_DROP_10S
  ) {
    return "WATCH";
  }

  return "NORMAL";
}

// ============================================================
// SIGNALS
// ============================================================

function buildSignal(nextLevel, snapshot, metrics) {
  return {
    id: `${currentMint}-${Date.now()}-${++eventId}`,
    level: nextLevel,
    mint: currentMint,
    pool: currentPool,
    timestamp: new Date().toISOString(),
    onchain: {
      tokenReserve: snapshot.tokenReserve,
      solReserve: snapshot.solReserve,
      tokenChange5s: metrics.tokenChange5s,
      tokenChange10s: metrics.tokenChange10s,
      solChange5s: metrics.solChange5s,
      solChange10s: metrics.solChange10s,
    },
    dex: dexData
      ? {
          priceUsd: dexData.priceUsd,
          liquidityUsd: dexData.liquidityUsd,
          volume24hUsd: dexData.volume24hUsd,
          priceChange5m: dexData.priceChange5m,
          updatedAt: dexData.updatedAt,
          stale: Date.now() - dexCacheAt > DEX_CACHE_TTL_MS,
        }
      : null,
    dexUnavailable,
    dexLastError,
  };
}

async function sendTelegram(text) {
  if (!BOT_TOKEN || !CHAT_ID) return;

  try {
    await fetchJson(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      },
      HTTP_TIMEOUT_MS
    );
  } catch (error) {
    log("Telegram envoi impossible:", error.message);
  }
}

async function sendSignalToV51(signal) {
  if (!CRASH_GUARD_TARGET_URL || !CRASH_GUARD_SECRET) {
    log("Signal non transmis : URL ou secret Crash Guard manquant.");
    return;
  }

  try {
    await fetchJson(
      `${CRASH_GUARD_TARGET_URL}/crash-guard/event`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-crash-guard-secret": CRASH_GUARD_SECRET,
        },
        body: JSON.stringify(signal),
      },
      HTTP_TIMEOUT_MS
    );
  } catch (error) {
    log("Transmission du signal à V5.1 impossible:", error.message);
  }
}

function formatPercent(value) {
  return value === null || value === undefined
    ? "N/D"
    : `${value.toFixed(2)} %`;
}

async function applyLevel(nextLevel, snapshot, metrics) {
  const previousLevel = level;

  if (nextLevel === previousLevel) return;

  level = nextLevel;

  const signal = buildSignal(nextLevel, snapshot, metrics);
  lastSignal = signal;

  if (nextLevel === "NORMAL") {
    log("Niveau revenu à NORMAL.");
    return;
  }

  const text =
    `🚨 CRASH GUARD : ${nextLevel}\n` +
    `Token : ${currentMint}\n` +
    `Pool : ${currentPool}\n` +
    `Réserve token, 5 s : ${formatPercent(metrics.tokenChange5s)}\n` +
    `Réserve token, 10 s : ${formatPercent(metrics.tokenChange10s)}\n` +
    `Réserve WSOL, 5 s : ${formatPercent(metrics.solChange5s)}\n` +
    `Réserve WSOL, 10 s : ${formatPercent(metrics.solChange10s)}\n` +
    `Prix DexScreener : ${
      dexData?.priceUsd == null ? "N/D" : `$${dexData.priceUsd}`
    }\n` +
    `Liquidité DexScreener : ${
      dexData?.liquidityUsd == null
        ? "N/D"
        : `$${dexData.liquidityUsd}`
    }\n` +
    `Données DEX indisponibles : ${dexUnavailable ? "oui" : "non"}`;

  log(text.replace(/\n/g, " | "));

  await sendTelegram(text);

  if (nextLevel === "DANGER" || nextLevel === "CRITICAL") {
    await sendSignalToV51(signal);
  }
}

// ============================================================
// SAMPLING
// ============================================================

let sampleInProgress = false;

async function sampleOnChain() {
  if (!armed || sampleInProgress) return;

  sampleInProgress = true;

  try {
    // Le WebSocket apporte les changements rapidement.
    // Le RPC périodique maintient les réserves à jour si le WS décroche.
    if (
      vaultAmounts.token === null ||
      vaultAmounts.sol === null ||
      !ws ||
      ws.readyState !== WebSocket.OPEN
    ) {
      await refreshVaultAmounts();
    }

    const snapshot = createSnapshot();
    if (!snapshot) return;

    history.push(snapshot);

    const cutoff = Date.now() - HISTORY_MAX * 1000;

    history = history.filter(
      (item) => item.timestamp >= cutoff
    );

    const metrics = analyzeSnapshot(snapshot);

    if (!metrics.historyReady) return;

    const nextLevel = classify(metrics);

    await applyLevel(nextLevel, snapshot, metrics);
  } catch (error) {
    log("Échantillonnage on-chain impossible:", error.message);
  } finally {
    sampleInProgress = false;
  }
}

// ============================================================
// ARM / DISARM
// ============================================================

async function arm(mint) {
  if (starting) {
    throw new Error("Un démarrage Crash Guard est déjà en cours.");
  }

  if (!validateMint(mint)) {
    throw new Error("Adresse de token Solana invalide.");
  }

  starting = true;

  try {
    await disarm();

    log("Armement du Crash Guard pour", mint);

    // La découverte DEX est facultative.
    // Si DexScreener renvoie 429, la découverte RPC prend le relais.
    const discovered = await discoverPool(mint);

    if (!discovered?.poolAddress) {
      throw new Error("Aucun pool PumpSwap SOL utilisable trouvé.");
    }

    const initialized = await initializePool(
      mint,
      discovered.poolAddress
    );

    currentMint = mint;
    currentPool = initialized.poolAddress;

    baseMint = initialized.baseMint;
    quoteMint = initialized.quoteMint;
    baseVault = initialized.baseVault;
    quoteVault = initialized.quoteVault;
    tokenVault = initialized.tokenVault;
    solVault = initialized.solVault;
    tokenDecimals = initialized.tokenDecimals;
    tokenIsBase = initialized.tokenIsBase;

    vaultAmounts.token = initialized.initialTokenRaw;
    vaultAmounts.sol = initialized.initialSolRaw;

    history = [];
    dexData = discovered.dexPair || null;
    dexUnavailable = false;
    dexLastError = null;
    dexBlockedUntil = 0;
    dexCacheAt = dexData ? Date.now() : 0;
    dexLastRequestAt = 0;
    dexErrorLogged = false;

    level = "NORMAL";
    dangerUntil = 0;
    criticalLatched = false;
    lastSignal = null;
    eventId = 0;

    armed = true;

    log("Crash Guard armé.", {
      mint: currentMint,
      pool: currentPool,
      baseMint,
      quoteMint,
      tokenVault,
      solVault,
      tokenDecimals,
      tokenIsBase,
    });

    connectWebSocket();

    sampleTimer = setInterval(
      sampleOnChain,
      SAMPLE_INTERVAL_MS
    );

    dexTimer = setInterval(
      updateDexData,
      DEX_INTERVAL_MS
    );

    // Mise à jour DEX non bloquante : une limitation 429 ne désarme pas.
    updateDexData().catch((error) => {
      log("Mise à jour DEX initiale ignorée:", error.message);
    });

    return {
      ok: true,
      armed: true,
      mint: currentMint,
      pool: currentPool,
      quoteMint,
      tokenDecimals,
      dexAvailable: Boolean(dexData),
    };
  } catch (error) {
    await disarm();
    throw error;
  } finally {
    starting = false;
  }
}

async function disarm() {
  armed = false;

  if (sampleTimer) {
    clearInterval(sampleTimer);
    sampleTimer = null;
  }

  if (dexTimer) {
    clearInterval(dexTimer);
    dexTimer = null;
  }

  closeWebSocket();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  currentMint = null;
  currentPool = null;

  baseMint = null;
  quoteMint = null;
  baseVault = null;
  quoteVault = null;
  tokenVault = null;
  solVault = null;
  tokenDecimals = 0;
  tokenIsBase = true;

  vaultAmounts = {
    token: null,
    sol: null,
  };

  history = [];
  dexData = null;
  dexUnavailable = false;
  dexLastError = null;
  dexBlockedUntil = 0;
  dexCacheAt = 0;
  dexLastRequestAt = 0;
  dexErrorLogged = false;

  level = "NORMAL";
  dangerUntil = 0;
  criticalLatched = false;
  lastSignal = null;

  return { ok: true, armed: false };
}

// ============================================================
// HTTP API
// ============================================================

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;

      if (body.length > 1024 * 1024) {
        reject(new Error("Corps de requête trop volumineux."));
        req.destroy();
      }
    });

    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("JSON de requête invalide."));
      }
    });

    req.on("error", reject);
  });
}

function authorized(req) {
  if (!CRASH_GUARD_SECRET) return false;

  return (
    req.headers["x-crash-guard-secret"] === CRASH_GUARD_SECRET
  );
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });

  res.end(JSON.stringify(body));
}

async function handleRequest(req, res) {
  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "crash-guard",
      armed,
      timestamp: new Date().toISOString(),
    });
  }

  if (!authorized(req)) {
    return sendJson(res, 401, {
      ok: false,
      error: "Non autorisé.",
    });
  }

  if (req.method === "GET" && url.pathname === "/state") {
    return sendJson(res, 200, {
      ok: true,
      armed,
      mint: currentMint,
      pool: currentPool,
      baseMint,
      quoteMint,
      tokenVault,
      solVault,
      tokenDecimals,
      level,
      criticalLatched,
      dangerUntil,
      dexUnavailable,
      dexLastError,
      dexBlockedUntil:
        dexBlockedUntil > Date.now()
          ? new Date(dexBlockedUntil).toISOString()
          : null,
      dexData,
      lastSignal,
      historySamples: history.length,
    });
  }

  if (req.method === "POST" && url.pathname === "/disarm") {
    await disarm();

    return sendJson(res, 200, {
      ok: true,
      armed: false,
    });
  }

  if (req.method === "POST" && url.pathname === "/arm") {
    if (starting) {
      return sendJson(res, 409, {
        ok: false,
        error: "Un démarrage est déjà en cours.",
      });
    }

    const body = await readRequestBody(req);
    const mint = String(body.mint || "").trim();

    if (!mint) {
      return sendJson(res, 400, {
        ok: false,
        error: "Le champ mint est obligatoire.",
      });
    }

    try {
      const result = await arm(mint);
      return sendJson(res, 200, result);
    } catch (error) {
      log("Armement impossible:", error.message);

      return sendJson(res, 500, {
        ok: false,
        error: error.message,
      });
    }
  }

  return sendJson(res, 404, {
    ok: false,
    error: "Route introuvable.",
  });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    log("Erreur HTTP:", error.message);

    if (!res.headersSent) {
      sendJson(res, 500, {
        ok: false,
        error: error.message || "Erreur interne.",
      });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  log(`Crash Guard démarré sur le port ${PORT}.`);
});

async function shutdown(signal) {
  if (stopping) return;

  stopping = true;
  log(`Arrêt demandé (${signal}).`);

  await disarm();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
