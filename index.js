require("dotenv").config();

const {
  Connection,
  PublicKey,
} = require("@solana/web3.js");

const { Telegraf } = require("telegraf");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ============================================================
// ENV
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN manquant");
if (!CHAT_ID) throw new Error("CHAT_ID manquant");
if (!HELIUS_API_KEY) throw new Error("HELIUS_API_KEY manquant");

// ============================================================
// CONFIG
// ============================================================

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, "processed");

const bot = new Telegraf(BOT_TOKEN);

// ============================================================
// PROGRAMMES / MINTS
// ============================================================

const PUMPSWAP_PROGRAM_ID =
  new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");

const PUMP_PROGRAM_ID =
  new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

const WSOL_MINT =
  new PublicKey("So11111111111111111111111111111111111111112");

// ============================================================
// PUMPSWAP POOL LAYOUT
// ============================================================
//
// 0   discriminator      8
// 8   bump                1
// 9   index               2
// 11  creator            32
// 43  base_mint          32
// 75  quote_mint         32
// 107 lp_mint            32
// 139 pool_base_vault    32
// 171 pool_quote_vault   32
// 203 lp_supply           8
// 211 coin_creator       32
//
// On accepte les comptes dont la taille est >= 243.
// On ne dépend volontairement plus de dataSize=211.
//

const OFF = {
  baseMint: 43,
  quoteMint: 75,
  baseVault: 139,
  quoteVault: 171,
  lpSupply: 203,
  coinCreator: 211,
};

// ============================================================
// STRATÉGIE
// ============================================================

const CAPITAL_USD = 10;
const TARGET_GAIN = 0.05;

const MARKET_POLL_MS = 2000;

const OBSERVATION_MS = 30000;

const NO_NEW_BUY_AFTER_MS = 43 * 60 * 1000;
const MAX_SESSION_MS = 45 * 60 * 1000;

const MIN_LIQUIDITY_USD = 3000;

const MIN_HEALTH_SCORE = 80;
const REQUIRED_CONFIRMATIONS = 4;

const COOLDOWN_AFTER_SELL_MS = 15000;

// Protection crash
const CRASH_PRICE_DROP_10S = -0.20;
const CRASH_LIQUIDITY_DROP_10S = -0.50;

const HARD_LIQUIDITY_USD = 1;

// Entrée
const ENTRY_MAX_PRICE_DROP_10S = -0.05;
const ENTRY_MAX_LIQUIDITY_DROP_10S = -0.12;
const ENTRY_MAX_LIQUIDITY_DROP_30S = -0.20;

// ============================================================
// DATA
// ============================================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MARKET_FILE = path.join(DATA_DIR, "market_history.jsonl");
const TRADES_FILE = path.join(DATA_DIR, "trade_history.json");
const CRASH_FILE = path.join(DATA_DIR, "crash_reports.json");
const SUMMARY_FILE = path.join(DATA_DIR, "v5_7_summary.json");

// ============================================================
// ÉTAT
// ============================================================

let running = false;
let tokenMint = null;

let sessionStartedAt = 0;
let sessionEnded = false;

let marketTimer = null;
let sessionTimer = null;
let websocket = null;

let dexPair = null;
let poolInfo = null;

let position = null;

let cycleNumber = 0;
let wins = 0;
let losses = 0;

let cooldownUntil = 0;

let lastMarket = null;
let lastOnchain = null;

let history = [];

let crashReport = null;

let wsSubscriptionIds = {
  baseVault: null,
  quoteVault: null,
  pool: null,
};

let pendingVaultUpdates = {
  base: null,
  quote: null,
};

let previousVaultSnapshot = null;

let lastDexFetch = 0;
let cachedDexPairs = [];

let healthConfirmationCount = 0;

// ============================================================
// UTILITAIRES
// ============================================================

function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pct(current, previous) {
  if (
    current === null ||
    current === undefined ||
    previous === null ||
    previous === undefined ||
    previous === 0
  ) {
    return 0;
  }

  return ((current - previous) / previous) * 100;
}

function pctDecimal(current, previous) {
  return pct(current, previous) / 100;
}

function shortMint(mint) {
  if (!mint) return "N/A";
  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

function shortAddress(address) {
  if (!address) return "N/A";
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function usd(value) {
  if (!Number.isFinite(value)) return "N/A";

  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

function sol(value) {
  if (!Number.isFinite(value)) return "N/A";

  return `${value.toFixed(4)} SOL`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

async function telegram(message) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, message);
  } catch (err) {
    console.error("Telegram error:", err.message);
  }
}

// ============================================================
// FICHIERS
// ============================================================

function appendJsonl(file, data) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(data) + "\n",
      "utf8"
    );
  } catch (err) {
    console.error("Erreur écriture JSONL:", err.message);
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;

    const content = fs.readFileSync(file, "utf8");

    if (!content.trim()) return fallback;

    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (err) {
    console.error("Erreur écriture JSON:", err.message);
  }
}

function saveTrade(trade) {
  const trades = readJson(TRADES_FILE, []);
  trades.push(trade);

  writeJson(TRADES_FILE, trades);
}

function saveCrash(report) {
  const crashes = readJson(CRASH_FILE, []);
  crashes.push(report);

  writeJson(CRASH_FILE, crashes);
}

// ============================================================
// HISTORIQUE
// ============================================================

function addHistory(point) {
  history.push(point);

  const cutoff = now() - 120000;

  history = history.filter(p => p.ts >= cutoff);

  appendJsonl(MARKET_FILE, point);
}

function pointAgo(ms) {
  const target = now() - ms;

  if (!history.length) return null;

  let closest = null;
  let distance = Infinity;

  for (const p of history) {
    const d = Math.abs(p.ts - target);

    if (d < distance) {
      distance = d;
      closest = p;
    }
  }

  if (distance > Math.max(ms * 0.5, 5000)) {
    return null;
  }

  return closest;
}

function getPointAgo(ms) {
  return pointAgo(ms);
}

// ============================================================
// DEXSCREENER
// ============================================================

async function fetchDexTokenPairs(mint) {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const json = await response.json();

  return Array.isArray(json.pairs)
    ? json.pairs
    : [];
}

function isPumpSwapPair(pair, mint) {
  if (!pair) return false;

  const dexId =
    String(pair.dexId || "").toLowerCase();

  const base =
    pair.baseToken?.address || "";

  const quote =
    pair.quoteToken?.address || "";

  const dexLooksPumpSwap =
    dexId === "pumpswap" ||
    dexId === "pump_amm" ||
    dexId === "pumpamm" ||
    dexId.includes("pump");

  if (!dexLooksPumpSwap) {
    return false;
  }

  return base === mint || quote === mint;
}

function chooseBestPumpSwapPair(pairs, mint) {
  const candidates = pairs.filter(pair =>
    isPumpSwapPair(pair, mint)
  );

  if (!candidates.length) {
    return null;
  }

  candidates.sort((a, b) => {
    const la =
      Number(a.liquidity?.usd || 0);

    const lb =
      Number(b.liquidity?.usd || 0);

    return lb - la;
  });

  return candidates[0];
}

async function discoverPumpSwapFromDex(mint) {
  console.log("\n🔎 DexScreener : recherche des marchés...");

  try {
    const pairs = await fetchDexTokenPairs(mint);

    cachedDexPairs = pairs;
    lastDexFetch = now();

    console.log(
      `📊 DexScreener : ${pairs.length} paire(s) trouvée(s)`
    );

    if (pairs.length) {
      for (const [i, pair] of pairs.slice(0, 10).entries()) {
        console.log(
          `${i + 1}. dex=${pair.dexId} ` +
          `pair=${shortAddress(pair.pairAddress)} ` +
          `liq=${usd(Number(pair.liquidity?.usd || 0))}`
        );
      }
    }

    const pumpPairs = pairs.filter(pair =>
      isPumpSwapPair(pair, mint)
    );

    if (!pumpPairs.length) {
      return {
        pair: null,
        allPairs: pairs,
      };
    }

    const best = chooseBestPumpSwapPair(
      pumpPairs,
      mint
    );

    return {
      pair: best,
      allPairs: pairs,
    };

  } catch (err) {
    console.error(
      "❌ DexScreener erreur:",
      err.message
    );

    return {
      pair: null,
      allPairs: [],
      error: err.message,
    };
  }
}

// ============================================================
// LECTURE POOL PUMPSWAP
// ============================================================

function readPubkey(data, offset) {
  if (!data || data.length < offset + 32) {
    return null;
  }

  try {
    return new PublicKey(
      data.subarray(offset, offset + 32)
    );
  } catch {
    return null;
  }
}

function parsePoolAccount(pubkey, accountInfo) {
  if (!accountInfo?.data) {
    return null;
  }

  const data = Buffer.from(accountInfo.data);

  if (data.length < 203) {
    return null;
  }

  const baseMint = readPubkey(
    data,
    OFF.baseMint
  );

  const quoteMint = readPubkey(
    data,
    OFF.quoteMint
  );

  const baseVault = readPubkey(
    data,
    OFF.baseVault
  );

  const quoteVault = readPubkey(
    data,
    OFF.quoteVault
  );

  if (
    !baseMint ||
    !quoteMint ||
    !baseVault ||
    !quoteVault
  ) {
    return null;
  }

  return {
    address: pubkey,
    dataLength: data.length,

    baseMint,
    quoteMint,

    baseVault,
    quoteVault,

    coinCreator:
      readPubkey(data, OFF.coinCreator),

    lpSupply:
      data.length >= 211
        ? data.readBigUInt64LE(OFF.lpSupply)
        : 0n,
  };
}

// ============================================================
// VALIDATION POOL
// ============================================================

async function readVaultSol(vault) {
  try {
    const balance =
      await connection.getBalance(
        vault,
        "processed"
      );

    return balance / 1e9;
  } catch (err) {
    console.error(
      "Vault SOL error:",
      err.message
    );

    return null;
  }
}

async function readTokenVault(vault) {
  try {
    const result =
      await connection.getTokenAccountBalance(
        vault,
        "processed"
      );

    return Number(
      result.value.uiAmount || 0
    );
  } catch (err) {
    console.error(
      "Token vault error:",
      err.message
    );

    return null;
  }
}

async function validatePool(pool) {
  if (!pool) {
    return {
      valid: false,
      reason: "pool_null",
    };
  }

  try {
    const account =
      await connection.getAccountInfo(
        pool.address,
        "processed"
      );

    if (!account) {
      return {
        valid: false,
        reason: "pool_account_not_found",
      };
    }

    if (!account.owner.equals(
      PUMPSWAP_PROGRAM_ID
    )) {
      return {
        valid: false,
        reason:
          `owner_incorrect_${account.owner.toBase58()}`,
      };
    }

    const parsed =
      parsePoolAccount(
        pool.address,
        account
      );

    if (!parsed) {
      return {
        valid: false,
        reason: "pool_layout_invalid",
      };
    }

    const tokenMint =
      new PublicKey(tokenMintGlobal);

    const baseIsToken =
      parsed.baseMint.equals(tokenMint);

    const quoteIsToken =
      parsed.quoteMint.equals(tokenMint);

    const baseIsWsol =
      parsed.baseMint.equals(WSOL_MINT);

    const quoteIsWsol =
      parsed.quoteMint.equals(WSOL_MINT);

    if (
      !(
        (baseIsToken && quoteIsWsol) ||
        (quoteIsToken && baseIsWsol)
      )
    ) {
      return {
        valid: false,
        reason:
          "pool_not_token_wsol_pair",
        details: {
          base: parsed.baseMint.toBase58(),
          quote: parsed.quoteMint.toBase58(),
        },
      };
    }

    let wsolVault;
    let tokenVault;

    if (baseIsWsol) {
      wsolVault = parsed.baseVault;
      tokenVault = parsed.quoteVault;
    } else {
      wsolVault = parsed.quoteVault;
      tokenVault = parsed.baseVault;
    }

    const [solReserve, tokenReserve] =
      await Promise.all([
        readVaultSol(wsolVault),
        readTokenVault(tokenVault),
      ]);

    if (
      solReserve === null ||
      tokenReserve === null
    ) {
      return {
        valid: false,
        reason: "vault_read_failed",
      };
    }

    return {
      valid: true,

      address: parsed.address,

      baseMint: parsed.baseMint,
      quoteMint: parsed.quoteMint,

      baseVault: parsed.baseVault,
      quoteVault: parsed.quoteVault,

      wsolVault,
      tokenVault,

      solReserve,
      tokenReserve,

      dataLength: parsed.dataLength,

      owner: account.owner,
    };

  } catch (err) {
    return {
      valid: false,
      reason: err.message,
    };
  }
}

// ============================================================
// DÉCOUVERTE DIRECTE ON-CHAIN
// ============================================================

async function discoverPoolsOnchain(mint) {
  console.log(
    "\n🔍 Recherche directe dans PumpSwap..."
  );

  const candidates = [];

  async function searchOffset(offset) {
    try {
      const accounts =
        await connection.getProgramAccounts(
          PUMPSWAP_PROGRAM_ID,
          {
            commitment: "processed",

            filters: [
              {
                memcmp: {
                  offset,
                  bytes: mint,
                },
              },
            ],
          }
        );

      console.log(
        `📡 Offset ${offset}: ${accounts.length} compte(s)`
      );

      for (const account of accounts) {
        const parsed =
          parsePoolAccount(
            account.pubkey,
            account.account
          );

        if (!parsed) continue;

        const base =
          parsed.baseMint.toBase58();

        const quote =
          parsed.quoteMint.toBase58();

        const isPair =
          (
            base === mint &&
            quote === WSOL_MINT.toBase58()
          ) ||
          (
            quote === mint &&
            base === WSOL_MINT.toBase58()
          );

        if (!isPair) continue;

        candidates.push(parsed);
      }

    } catch (err) {
      console.error(
        `❌ Recherche offset ${offset}:`,
        err.message
      );
    }
  }

  // Les deux orientations possibles.
  await Promise.all([
    searchOffset(OFF.baseMint),
    searchOffset(OFF.quoteMint),
  ]);

  // Supprimer doublons
  const unique = [];

  const seen = new Set();

  for (const candidate of candidates) {
    const key =
      candidate.address.toBase58();

    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(candidate);
  }

  console.log(
    `🧩 Pools SOL/token trouvés on-chain: ${unique.length}`
  );

  if (!unique.length) {
    return null;
  }

  // Chercher le pool avec le plus de SOL.
  const evaluated = [];

  for (const candidate of unique) {
    try {
      const baseIsWsol =
        candidate.baseMint.equals(WSOL_MINT);

      const wsolVault =
        baseIsWsol
          ? candidate.baseVault
          : candidate.quoteVault;

      const tokenVault =
        baseIsWsol
          ? candidate.quoteVault
          : candidate.baseVault;

      const [solReserve, tokenReserve] =
        await Promise.all([
          readVaultSol(wsolVault),
          readTokenVault(tokenVault),
        ]);

      if (
        solReserve === null ||
        tokenReserve === null
      ) {
        continue;
      }

      evaluated.push({
        ...candidate,

        wsolVault,
        tokenVault,

        solReserve,
        tokenReserve,
      });

    } catch (err) {
      console.error(
        "Pool evaluation error:",
        err.message
      );
    }
  }

  evaluated.sort(
    (a, b) =>
      b.solReserve - a.solReserve
  );

  return evaluated[0] || null;
}

// ============================================================
// DISCOVERY V5.7
// ============================================================

let tokenMintGlobal = null;

async function discoverMarket(mint) {
  tokenMintGlobal = mint;

  console.log("\n=================================");
  console.log("🔎 V5.7 DISCOVERY");
  console.log("Token:", mint);
  console.log("=================================\n");

  // ----------------------------------------------------------
  // ÉTAPE 1 : DexScreener
  // ----------------------------------------------------------

  const dexResult =
    await discoverPumpSwapFromDex(mint);

  if (dexResult.pair) {

    const pair = dexResult.pair;

    console.log(
      "\n🟢 PumpSwap trouvé via DexScreener"
    );

    console.log(
      "DEX:",
      pair.dexId
    );

    console.log(
      "Pair:",
      pair.pairAddress
    );

    console.log(
      "Liquidity:",
      usd(Number(pair.liquidity?.usd || 0))
    );

    const poolAddress =
      pair.pairAddress;

    try {
      const poolPubkey =
        new PublicKey(poolAddress);

      const poolAccount =
        await connection.getAccountInfo(
          poolPubkey,
          "processed"
        );

      if (poolAccount) {

        if (
          poolAccount.owner.equals(
            PUMPSWAP_PROGRAM_ID
          )
        ) {

          const parsed =
            parsePoolAccount(
              poolPubkey,
              poolAccount
            );

          if (parsed) {

            const validation =
              await validatePool(parsed);

            if (validation.valid) {

              console.log(
                "\n✅ Pool DexScreener confirmé on-chain"
              );

              return {
                dexPair: pair,
                pool: validation,
                source: "dexscreener",
              };
            }

            console.log(
              "⚠️ Pair DexScreener refusée:",
              validation.reason
            );

          } else {
            console.log(
              "⚠️ Impossible de décoder le compte Pool"
            );
          }

        } else {
          console.log(
            "⚠️ PairAddress DexScreener n'est pas un compte PumpSwap"
          );
        }

      } else {
        console.log(
          "⚠️ PairAddress introuvable on-chain"
        );
      }

    } catch (err) {
      console.log(
        "⚠️ Vérification pair Dex error:",
        err.message
      );
    }
  }

  // ----------------------------------------------------------
  // ÉTAPE 2 : recherche directe PumpSwap
  // ----------------------------------------------------------

  console.log(
    "\n🔄 Fallback direct PumpSwap..."
  );

  const directPool =
    await discoverPoolsOnchain(mint);

  if (directPool) {

    const validation =
      await validatePool(directPool);

    if (validation.valid) {

      console.log(
        "\n✅ Pool PumpSwap trouvé directement on-chain"
      );

      console.log(
        "Pool:",
        validation.address.toBase58()
      );

      return {
        dexPair: null,

        pool: validation,

        source: "onchain",
      };
    }
  }

  // ----------------------------------------------------------
  // Aucun marché
  // ----------------------------------------------------------

  console.log(
    "\n❌ Aucun marché PumpSwap valide"
  );

  const allPairs =
    dexResult.allPairs || [];

  if (!allPairs.length) {

    console.log(
      "🟡 DexScreener ne renvoie aucune paire."
    );

  } else {

    console.log(
      "\n📋 Marchés trouvés:"
    );

    for (const pair of allPairs.slice(0, 10)) {

      console.log(
        `- ${pair.dexId || "unknown"} ` +
        `${shortAddress(pair.pairAddress)}`
      );
    }
  }

  return null;
}

// ============================================================
// MARKET DATA
// ============================================================

async function readCurrentPoolData() {
  if (!poolInfo) return null;

  const [
    solReserve,
    tokenReserve
  ] = await Promise.all([
    readVaultSol(poolInfo.wsolVault),
    readTokenVault(poolInfo.tokenVault),
  ]);

  if (
    solReserve === null ||
    tokenReserve === null
  ) {
    return null;
  }

  if (
    solReserve <= 0 ||
    tokenReserve <= 0
  ) {
    return {
      liquidityUsd: 0,
      solReserve,
      tokenReserve,
      price: 0,
    };
  }

  // Estimation SOL/USD depuis DexScreener
  let solUsd = 0;

  if (dexPair?.priceNative) {
    const tokenPriceNative =
      Number(dexPair.priceNative || 0);

    const tokenPriceUsd =
      Number(dexPair.priceUsd || 0);

    if (
      tokenPriceNative > 0 &&
      tokenPriceUsd > 0
    ) {
      solUsd =
        tokenPriceUsd /
        tokenPriceNative;
    }
  }

  // Si DexScreener n'a pas le prix,
  // on utilise le dernier prix connu.
  if (
    !Number.isFinite(solUsd) ||
    solUsd <= 0
  ) {
    if (
      lastMarket?.solUsd &&
      lastMarket.solUsd > 0
    ) {
      solUsd = lastMarket.solUsd;
    }
  }

  if (
    !Number.isFinite(solUsd) ||
    solUsd <= 0
  ) {
    return null;
  }

  const price =
    (solReserve / tokenReserve) *
    solUsd;

  const liquidityUsd =
    solReserve *
    solUsd *
    2;

  return {
    price,
    liquidityUsd,
    solReserve,
    tokenReserve,
    solUsd,
  };
}

async function refreshDexPair() {
  if (!tokenMint) return;

  try {
    const pairs =
      await fetchDexTokenPairs(
        tokenMint
      );

    cachedDexPairs = pairs;
    lastDexFetch = now();

    const best =
      chooseBestPumpSwapPair(
        pairs,
        tokenMint
      );

    if (best) {
      dexPair = best;
    }

  } catch (err) {
    console.error(
      "Dex refresh:",
      err.message
    );
  }
}

async function getMarketData() {

  // DexScreener n'est rafraîchi que toutes les 10 sec.
  // Le prix/liquidité on-chain peut être lu toutes les 2 sec.

  if (
    !lastDexFetch ||
    now() - lastDexFetch > 10000
  ) {
    await refreshDexPair();
  }

  const poolData =
    await readCurrentPoolData();

  if (!poolData) {
    return null;
  }

  const point = {
    ts: now(),

    price: poolData.price,

    liquidityUsd:
      poolData.liquidityUsd,

    solReserve:
      poolData.solReserve,

    tokenReserve:
      poolData.tokenReserve,

    solUsd:
      poolData.solUsd,

    pool:
      poolInfo?.address?.toBase58() ||
      null,

    dex:
      dexPair?.dexId ||
      "pumpswap",
  };

  return point;
}

// ============================================================
// HEALTH SCORE
// ============================================================

function calculateHealthScore(point) {

  if (!point) return 0;

  let score = 100;

  const p10 =
    getPointAgo(10000);

  const p30 =
    getPointAgo(30000);

  const p60 =
    getPointAgo(60000);

  if (p10) {

    const price10 =
      pct(
        point.price,
        p10.price
      );

    const liq10 =
      pct(
        point.liquidityUsd,
        p10.liquidityUsd
      );

    if (price10 < -3) score -= 10;
    if (price10 < -7) score -= 20;
    if (price10 < -12) score -= 30;

    if (liq10 < -5) score -= 10;
    if (liq10 < -12) score -= 20;
    if (liq10 < -25) score -= 35;
  }

  if (p30) {

    const liq30 =
      pct(
        point.liquidityUsd,
        p30.liquidityUsd
      );

    if (liq30 < -10) score -= 10;
    if (liq30 < -20) score -= 25;
    if (liq30 < -35) score -= 40;
  }

  if (p60) {

    const price60 =
      pct(
        point.price,
        p60.price
      );

    if (price60 < -10) score -= 10;
    if (price60 < -20) score -= 20;
  }

  if (
    point.liquidityUsd <
    MIN_LIQUIDITY_USD
  ) {
    score -= 30;
  }

  return Math.max(
    0,
    Math.min(100, score)
  );
}

// ============================================================
// ENTRY FILTER
// ============================================================

function healthyConfirmation(point) {

  const score =
    calculateHealthScore(point);

  return score >= MIN_HEALTH_SCORE;
}

function entryCheck(point) {

  if (!point) {
    return {
      ok: false,
      reason: "market_unavailable",
    };
  }

  if (
    point.liquidityUsd <
    MIN_LIQUIDITY_USD
  ) {
    return {
      ok: false,
      reason: "liquidity_too_low",
    };
  }

  const p10 =
    getPointAgo(10000);

  const p30 =
    getPointAgo(30000);

  if (p10) {

    const priceDrop =
      pct(
        point.price,
        p10.price
      ) / 100;

    const liqDrop =
      pct(
        point.liquidityUsd,
        p10.liquidityUsd
      ) / 100;

    if (
      priceDrop <
      ENTRY_MAX_PRICE_DROP_10S
    ) {
      return {
        ok: false,
        reason: "price_drop_10s",
      };
    }

    if (
      liqDrop <
      ENTRY_MAX_LIQUIDITY_DROP_10S
    ) {
      return {
        ok: false,
        reason: "liquidity_drop_10s",
      };
    }
  }

  if (p30) {

    const liqDrop30 =
      pct(
        point.liquidityUsd,
        p30.liquidityUsd
      ) / 100;

    if (
      liqDrop30 <
      ENTRY_MAX_LIQUIDITY_DROP_30S
    ) {
      return {
        ok: false,
        reason: "liquidity_drop_30s",
      };
    }
  }

  if (!healthyConfirmation(point)) {

    return {
      ok: false,
      reason: "health_score_low",
    };
  }

  return {
    ok: true,
    reason: "healthy",
  };
}

// ============================================================
// CRASH DETECTION
// ============================================================

function detectCrash(point) {

  if (!point) {
    return {
      crash: false,
      reason: null,
    };
  }

  if (
    point.liquidityUsd <=
    HARD_LIQUIDITY_USD
  ) {

    return {
      crash: true,
      reason: "LIQUIDITY_NEAR_ZERO",
    };
  }

  const p10 =
    getPointAgo(10000);

  if (p10) {

    const priceDrop =
      pct(
        point.price,
        p10.price
      ) / 100;

    const liqDrop =
      pct(
        point.liquidityUsd,
        p10.liquidityUsd
      ) / 100;

    if (
      liqDrop <=
      CRASH_LIQUIDITY_DROP_10S
    ) {

      return {
        crash: true,
        reason:
          "LIQUIDITY_CRASH_10S",
        priceDrop,
        liqDrop,
      };
    }

    if (
      priceDrop <=
      CRASH_PRICE_DROP_10S
    ) {

      return {
        crash: true,
        reason:
          "PRICE_CRASH_10S",
        priceDrop,
        liqDrop,
      };
    }
  }

  return {
    crash: false,
    reason: null,
  };
}

// ============================================================
// ON-CHAIN WEBSOCKET
// ============================================================

function closeWebSocket() {

  try {
    if (websocket) {
      websocket.close();
    }
  } catch {}

  websocket = null;

  wsSubscriptionIds = {
    baseVault: null,
    quoteVault: null,
    pool: null,
  };

  pendingVaultUpdates = {
    base: null,
    quote: null,
  };
}

function classifyVaultChange(baseOld, baseNew, quoteOld, quoteNew) {

  if (
    baseOld === null ||
    baseNew === null ||
    quoteOld === null ||
    quoteNew === null
  ) {
    return "UNKNOWN";
  }

  const baseDelta =
    baseNew - baseOld;

  const quoteDelta =
    quoteNew - quoteOld;

  const baseChange =
    Math.abs(baseDelta);

  const quoteChange =
    Math.abs(quoteDelta);

  // Protection contre poussière
  if (
    baseChange < 0.00001 &&
    quoteChange < 0.00001
  ) {
    return "TINY";
  }

  // Base = WSOL dans notre monitoring.
  // Quote = token dans le cas classique.

  // SELL token -> SOL :
  // SOL augmente, token diminue
  if (
    baseDelta > 0 &&
    quoteDelta < 0
  ) {
    return "SELL";
  }

  // BUY token :
  // SOL diminue, token augmente
  if (
    baseDelta < 0 &&
    quoteDelta > 0
  ) {
    return "BUY";
  }

  // Retrait de liquidité
  if (
    baseDelta < 0 &&
    quoteDelta < 0
  ) {
    return "WITHDRAWAL";
  }

  // Ajout de liquidité
  if (
    baseDelta > 0 &&
    quoteDelta > 0
  ) {
    return "DEPOSIT";
  }

  return "UNKNOWN";
}

async function processVaultPair() {

  const base =
    pendingVaultUpdates.base;

  const quote =
    pendingVaultUpdates.quote;

  if (
    base === null ||
    quote === null
  ) {
    return;
  }

  const previous =
    previousVaultSnapshot;

  previousVaultSnapshot = {
    base: base.sol,
    quote: quote.tokens,
    ts: now(),
  };

  pendingVaultUpdates = {
    base: null,
    quote: null,
  };

  if (!previous) {
    return;
  }

  const type =
    classifyVaultChange(
      previous.base,
      base.sol,
      previous.quote,
      quote.tokens
    );

  const baseDelta =
    base.sol - previous.base;

  const quoteDelta =
    quote.tokens - previous.quote;

  console.log(
    `⛓️ ${type} | ` +
    `SOL ${baseDelta.toFixed(5)} | ` +
    `TOKEN ${quoteDelta.toFixed(5)}`
  );

  lastOnchain = {
    ts: now(),
    type,
    baseDelta,
    quoteDelta,
  };

  // Retrait brutal de liquidité
  if (type === "WITHDRAWAL") {

    const baseDropPct =
      previous.base !== 0
        ? (baseDelta / previous.base)
        : 0;

    if (baseDropPct <= -0.30) {

      console.log(
        "🚨 RETRAIT ON-CHAIN IMPORTANT"
      );

      if (position) {

        await forceSafetySell(
          "ONCHAIN_WITHDRAWAL"
        );
      }
    }
  }

  // Gros SELL
  if (type === "SELL") {

    const solIncrease =
      previous.base !== 0
        ? baseDelta / previous.base
        : 0;

    if (solIncrease > 0.10) {

      console.log(
        "⚠️ GROS SELL ON-CHAIN"
      );
    }
  }
}

function subscribeAccount(ws, pubkey, label) {

  const id =
    Math.floor(
      Math.random() * 100000000
    );

  ws.send(JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "accountSubscribe",
    params: [
      pubkey.toBase58(),
      {
        commitment: "processed",
        encoding: "jsonParsed",
      },
    ],
  }));

  console.log(
    `📡 accountSubscribe envoyé: ${label}`
  );
}

function startWebSocket() {

  closeWebSocket();

  if (!poolInfo) {
    console.log(
      "⚠️ Pas de pool pour WebSocket"
    );
    return;
  }

  websocket = new WebSocket(WSS_URL);

  websocket.on("open", () => {

    console.log(
      "🟢 Helius WebSocket connecté"
    );

    subscribeAccount(
      websocket,
      poolInfo.wsolVault,
      "WSOL VAULT"
    );

    subscribeAccount(
      websocket,
      poolInfo.tokenVault,
      "TOKEN VAULT"
    );

    subscribeAccount(
      websocket,
      poolInfo.address,
      "POOL"
    );
  });

  websocket.on("message", async raw => {

    try {

      const msg =
        JSON.parse(raw.toString());

      // Confirmation abonnement
      if (
        msg.result &&
        typeof msg.id === "number"
      ) {

        console.log(
          "📡 Subscription ID:",
          msg.result
        );

        return;
      }

      const value =
        msg.params?.result?.value;

      if (!value) return;

      const pubkey =
        msg.params?.result?.context
          ? null
          : null;

      const account =
        msg.params?.result?.value;

      if (!account) return;

      // Pour identifier le compte,
      // on compare les données reçues
      // avec les vaults connus.

      if (
        msg.params?.subscription &&
        account.data
      ) {

        const subscription =
          msg.params.subscription;

        // Les IDs sont attribués par
        // le serveur. On récupère donc
        // l'identification par le mapping
        // ci-dessous.

        if (
          subscription ===
          wsSubscriptionIds.baseVault
        ) {
          // handled below
        }
      }

      // Solana retourne jsonParsed.
      const parsedInfo =
        account.data?.parsed?.info;

      if (!parsedInfo) return;

      const tokenAmount =
        parsedInfo.tokenAmount;

      // Vault SOL
      if (
        tokenAmount === undefined &&
        account.lamports !== undefined
      ) {

        pendingVaultUpdates.base = {
          sol:
            Number(account.lamports) / 1e9,
          tokens: 0,
        };

        await processVaultPair();

        return;
      }

      // Vault token
      if (tokenAmount) {

        pendingVaultUpdates.quote = {
          sol: 0,
          tokens:
            Number(
              tokenAmount.uiAmount || 0
            ),
        };

        await processVaultPair();
      }

    } catch (err) {

      console.error(
        "WS message error:",
        err.message
      );
    }
  });

  websocket.on("error", err => {

    console.error(
      "❌ Helius WS:",
      err.message
    );
  });

  websocket.on("close", () => {

    console.log(
      "🔴 Helius WebSocket fermé"
    );

    if (running) {

      setTimeout(() => {

        if (running) {
          startWebSocket();
        }

      }, 3000);
    }
  });
}

// ============================================================
// SIMULATION BUY
// ============================================================

function simulateBuy(point) {

  cycleNumber++;

  position = {
    cycle: cycleNumber,

    entryTime: now(),

    entryPrice: point.price,

    capitalUsd: CAPITAL_USD,

    targetPrice:
      point.price *
      (1 + TARGET_GAIN),
  };

  console.log(
    `\n🟢 SIMULATION BUY #${cycleNumber}`
  );

  console.log(
    `💵 Capital: ${usd(CAPITAL_USD)}`
  );

  console.log(
    `💰 Prix entrée: ${point.price}`
  );

  console.log(
    `🎯 Objectif: ${point.price * (1 + TARGET_GAIN)}`
  );

  saveTrade({
    type: "BUY",
    mode: "SIMULATION",
    cycle: cycleNumber,
    time: new Date().toISOString(),
    price: point.price,
    capitalUsd: CAPITAL_USD,
    pool:
      poolInfo?.address?.toBase58() ||
      null,
  });

  telegram(
    `🟢 BUY SIMULATION #${cycleNumber}\n\n` +
    `💵 Capital : ${usd(CAPITAL_USD)}\n` +
    `💰 Prix : ${point.price}\n` +
    `🎯 Objectif +5% : ${position.targetPrice}\n\n` +
    `Pool : ${shortAddress(
      poolInfo?.address?.toBase58()
    )}`
  );
}

// ============================================================
// SIMULATION SELL
// ============================================================

function simulateSell(point, reason = "TARGET") {

  if (!position) return;

  const entry =
    position.entryPrice;

  const exit =
    point.price;

  const gainPct =
    ((exit - entry) / entry) * 100;

  const gainUsd =
    CAPITAL_USD *
    (gainPct / 100);

  const cycle =
    position.cycle;

  const trade = {
    type: "SELL",
    mode: "SIMULATION",

    cycle,

    reason,

    time:
      new Date().toISOString(),

    entryPrice: entry,

    exitPrice: exit,

    gainPct,

    gainUsd,

    capitalUsd:
      CAPITAL_USD,

    pool:
      poolInfo?.address?.toBase58() ||
      null,
  };

  saveTrade(trade);

  if (reason === "TARGET") {
    wins++;
  } else {
    losses++;
  }

  console.log(
    `\n🔴 SIMULATION SELL #${cycle}`
  );

  console.log(
    `📈 Résultat : ${gainPct.toFixed(2)}%`
  );

  console.log(
    `💵 Résultat : ${gainUsd.toFixed(4)} USD`
  );

  telegram(
    `${reason === "TARGET"
      ? "🎯"
      : "🛡️"} SELL SIMULATION #${cycle}\n\n` +
    `Entrée : ${entry}\n` +
    `Sortie : ${exit}\n` +
    `Résultat : ${gainPct.toFixed(2)}%\n` +
    `P&L : ${gainUsd.toFixed(4)} USD\n\n` +
    `Raison : ${reason}`
  );

  position = null;

  cooldownUntil =
    now() +
    COOLDOWN_AFTER_SELL_MS;
}

// ============================================================
// SAFETY SELL
// ============================================================

async function forceSafetySell(reason) {

  if (!position) return;

  console.log(
    `🛡️ SORTIE DE SÉCURITÉ : ${reason}`
  );

  const market =
    await getMarketData();

  if (!market) {

    console.error(
      "❌ Impossible de récupérer le prix pour la sortie de sécurité."
    );

    // On NE considère pas la position comme
    // fermée si nous n'avons pas de prix.
    // Elle reste en mémoire.

    return;
  }

  simulateSell(
    market,
    reason
  );
}

// ============================================================
// SESSION LIMIT
// ============================================================

async function sessionLimitReached() {

  if (!running) return;

  console.log(
    "\n⏰ LIMITE SESSION 45 MINUTES"
  );

  // RÈGLE ABSOLUE :
  // une position ouverte doit être fermée
  // avant l'arrêt.

  if (position) {

    console.log(
      "🛡️ Position ouverte détectée."
    );

    await forceSafetySell(
      "SESSION_LIMIT"
    );

    // Si la sortie échoue,
    // on garde la surveillance active
    // et on réessaie.
    if (position) {

      console.log(
        "⚠️ Position toujours ouverte."
      );

      telegram(
        `🚨 SESSION 45 MIN\n\n` +
        `Position encore ouverte.\n` +
        `Le bot NE S'ARRÊTE PAS tant que la sortie de sécurité n'est pas possible.`
      );

      return;
    }
  }

  await stopTrade(
    "SESSION_LIMIT"
  );
}

// ============================================================
// MARKET LOOP
// ============================================================

async function marketLoop() {

  if (!running) return;

  try {

    const point =
      await getMarketData();

    if (!point) {

      console.log(
        "⚠️ Données marché indisponibles"
      );

      return;
    }

    lastMarket = point;

    addHistory(point);

    const score =
      calculateHealthScore(point);

    const crash =
      detectCrash(point);

    console.log(
      `📊 ${usd(point.price)} | ` +
      `liq ${usd(point.liquidityUsd)} | ` +
      `SOL ${point.solReserve.toFixed(3)} | ` +
      `score ${score}`
    );

    // --------------------------------------------------------
    // CRASH
    // --------------------------------------------------------

    if (crash.crash) {

      console.log(
        "\n🚨 CRASH DÉTECTÉ"
      );

      console.log(
        "Raison:",
        crash.reason
      );

      crashReport = {

        time:
          new Date().toISOString(),

        token: tokenMint,

        reason:
          crash.reason,

        price:
          point.price,

        liquidityUsd:
          point.liquidityUsd,

        history:
          history.slice(-60),

        position:
          position
            ? {
                ...position,
              }
            : null,
      };

      saveCrash(crashReport);

      telegram(
        `🚨 CRASH DÉTECTÉ\n\n` +
        `Token : ${shortMint(tokenMint)}\n` +
        `Prix : ${point.price}\n` +
        `Liquidité : ${usd(point.liquidityUsd)}\n\n` +
        `Raison : ${crash.reason}\n\n` +
        `${position
          ? "🛡️ Position ouverte : sortie de sécurité."
          : "Aucune position ouverte."}`
      );

      if (position) {
        await forceSafetySell(
          "CRASH_PROTECTION"
        );
      }

      await stopTrade(
        "CRASH"
      );

      return;
    }

    // --------------------------------------------------------
    // POSITION OUVERTE
    // --------------------------------------------------------

    if (position) {

      const target =
        position.targetPrice;

      if (
        point.price >= target
      ) {

        simulateSell(
          point,
          "TARGET"
        );

        return;
      }

      // Protection si la position commence
      // à perdre fortement.
      const drawdown =
        ((point.price -
          position.entryPrice) /
          position.entryPrice) *
        100;

      if (drawdown <= -20) {

        await forceSafetySell(
          "POSITION_CRASH_PROTECTION"
        );

        if (
          point.liquidityUsd <=
          HARD_LIQUIDITY_USD
        ) {
          await stopTrade(
            "CRASH"
          );
        }
      }

      return;
    }

    // --------------------------------------------------------
    // COOLDOWN
    // --------------------------------------------------------

    if (
      now() < cooldownUntil
    ) {

      console.log(
        "⏳ Cooldown..."
      );

      return;
    }

    // --------------------------------------------------------
    // 43 MINUTES
    // --------------------------------------------------------

    if (
      now() -
      sessionStartedAt >=
      NO_NEW_BUY_AFTER_MS
    ) {

      console.log(
        "⏰ 43 min atteintes : aucun nouveau BUY."
      );

      return;
    }

    // --------------------------------------------------------
    // ENTRY
    // --------------------------------------------------------

    if (
      history.length <
      8
    ) {

      console.log(
        "⏳ Warmup..."
      );

      return;
    }

    const entry =
      entryCheck(point);

    if (!entry.ok) {

      console.log(
        `🟡 Pas d'entrée : ${entry.reason}`
      );

      return;
    }

    // Confirmation santé
    if (healthyConfirmation(point)) {
      healthConfirmationCount++;
    } else {
      healthConfirmationCount = 0;
    }

    if (
      healthConfirmationCount <
      REQUIRED_CONFIRMATIONS
    ) {

      console.log(
        `🟡 Confirmation santé ` +
        `${healthConfirmationCount}/${REQUIRED_CONFIRMATIONS}`
      );

      return;
    }

    // On reset pour le prochain cycle.
    healthConfirmationCount = 0;

    simulateBuy(point);

  } catch (err) {

    console.error(
      "❌ marketLoop:",
      err.message
    );
  }
}

// ============================================================
// START TRADE
// ============================================================

async function startTrade(mint) {

  if (running) {

    await telegram(
      "⚠️ Une surveillance est déjà active."
    );

    return;
  }

  try {
    new PublicKey(mint);
  } catch {

    await telegram(
      "❌ Adresse token Solana invalide."
    );

    return;
  }

  running = true;
  sessionEnded = false;

  tokenMint = mint;

  tokenMintGlobal = mint;

  sessionStartedAt = now();

  cycleNumber = 0;
  wins = 0;
  losses = 0;

  cooldownUntil = 0;

  position = null;

  history = [];

  dexPair = null;
  poolInfo = null;

  lastMarket = null;
  lastOnchain = null;

  previousVaultSnapshot = null;

  healthConfirmationCount = 0;

  console.log(
    "\n================================="
  );

  console.log(
    "🚀 V5.7 DÉMARRAGE"
  );

  console.log(
    "Token:",
    mint
  );

  console.log(
    "=================================\n"
  );

  await telegram(
    `🚀 V5.7 DÉMARRAGE\n\n` +
    `Token :\n${mint}\n\n` +
    `💵 Capital/cycle : ${usd(CAPITAL_USD)}\n` +
    `🎯 Objectif : +5%\n` +
    `⏱️ Session max : 45 min\n` +
    `🚫 Nouveau BUY après : 43 min\n\n` +
    `🔎 Recherche du marché PumpSwap...`
  );

  // ----------------------------------------------------------
  // DISCOVERY
  // ----------------------------------------------------------

  const market =
    await discoverMarket(mint);

  if (!market) {

    running = false;

    console.log(
      "\n❌ V5.7 ARRÊTÉE : aucun pool."
    );

    const allPairs =
      cachedDexPairs || [];

    let diagnostic =
      "";

    if (!allPairs.length) {

      diagnostic =
        "DexScreener ne renvoie aucune paire.";

    } else {

      diagnostic =
        "Marchés trouvés :\n" +
        allPairs
          .slice(0, 8)
          .map(
            p =>
              `• ${p.dexId || "unknown"}`
          )
          .join("\n");
    }

    await telegram(
      `❌ V5.7 ARRÊTÉE\n\n` +
      `Token :\n${mint}\n\n` +
      `🟡 Aucun pool PumpSwap SOL valide trouvé.\n\n` +
      `🔎 Diagnostic :\n${diagnostic}\n\n` +
      `⛔ Surveillance on-chain NON lancée.`
    );

    return;
  }

  dexPair =
    market.dexPair;

  poolInfo =
    market.pool;

  console.log(
    "\n================================="
  );

  console.log(
    "✅ MARCHÉ VALIDÉ"
  );

  console.log(
    "Source:",
    market.source
  );

  console.log(
    "Pool:",
    poolInfo.address.toBase58()
  );

  console.log(
    "WSOL vault:",
    poolInfo.wsolVault.toBase58()
  );

  console.log(
    "Token vault:",
    poolInfo.tokenVault.toBase58()
  );

  console.log(
    "SOL reserve:",
    poolInfo.solReserve
  );

  console.log(
    "=================================\n"
  );

  await telegram(
    `✅ PUMPSWAP VALIDÉ\n\n` +
    `Token : ${shortMint(mint)}\n\n` +
    `🏊 Pool : ${shortAddress(
      poolInfo.address.toBase58()
    )}\n` +
    `💧 Réserve SOL : ${sol(poolInfo.solReserve)}\n` +
    `🔎 Source : ${market.source}\n\n` +
    `⛓️ Surveillance Helius en préparation...`
  );

  // ----------------------------------------------------------
  // WEBSOCKET
  // ----------------------------------------------------------

  startWebSocket();

  // ----------------------------------------------------------
  // MARKET LOOP
  // ----------------------------------------------------------

  marketTimer =
    setInterval(
      marketLoop,
      MARKET_POLL_MS
    );

  // Première lecture immédiate
  await marketLoop();

  // ----------------------------------------------------------
  // 45 MINUTES
  // ----------------------------------------------------------

  sessionTimer =
    setTimeout(
      sessionLimitReached,
      MAX_SESSION_MS
    );

  await telegram(
    `🟢 V5.7 SURVEILLANCE ACTIVE\n\n` +
    `💵 ${usd(CAPITAL_USD)} / cycle\n` +
    `🎯 +5% cible\n` +
    `⏱️ 45 min maximum\n` +
    `🚫 Aucun nouveau BUY après 43 min\n\n` +
    `Simulation uniquement.`
  );
}

// ============================================================
// STOP TRADE
// ============================================================

async function stopTrade(reason = "MANUAL") {

  if (!running) {
    return;
  }

  // Protection : ne jamais arrêter
  // avec une position ouverte.
  if (position) {

    console.log(
      "🛡️ stopTrade demandé avec position ouverte."
    );

    await forceSafetySell(
      `STOP_${reason}`
    );

    if (position) {

      console.log(
        "🚨 ARRÊT REFUSÉ : position toujours ouverte."
      );

      return;
    }
  }

  running = false;

  if (marketTimer) {
    clearInterval(marketTimer);
    marketTimer = null;
  }

  if (sessionTimer) {
    clearTimeout(sessionTimer);
    sessionTimer = null;
  }

  closeWebSocket();

  const duration =
    sessionStartedAt
      ? now() - sessionStartedAt
      : 0;

  const summary = {

    time:
      new Date().toISOString(),

    reason,

    token:
      tokenMint,

    durationSeconds:
      Math.floor(duration / 1000),

    cycles:
      cycleNumber,

    wins,

    losses,

    positionOpen:
      !!position,

    pool:
      poolInfo?.address?.toBase58() ||
      null,
  };

  writeJson(
    SUMMARY_FILE,
    summary
  );

  console.log(
    "\n================================="
  );

  console.log(
    "🛑 V5.7 ARRÊT"
  );

  console.log(
    "Raison:",
    reason
  );

  console.log(
    "Cycles:",
    cycleNumber
  );

  console.log(
    "Wins:",
    wins
  );

  console.log(
    "Losses:",
    losses
  );

  console.log(
    "=================================\n"
  );

  await telegram(
    `🛑 V5.7 ARRÊTÉE\n\n` +
    `Raison : ${reason}\n` +
    `Cycles : ${cycleNumber}\n` +
    `🎯 Gains : ${wins}\n` +
    `🛡️ Sorties protection : ${losses}`
  );
}

// ============================================================
// STATUS
// ============================================================

async function statusText() {

  if (!running) {

    return (
      `🔴 V5.7 INACTIVE\n\n` +
      `Dernier token : ` +
      `${tokenMint || "aucun"}`
    );
  }

  const elapsed =
    now() -
    sessionStartedAt;

  const minutes =
    Math.floor(
      elapsed / 60000
    );

  let text =
    `🟢 V5.7 ACTIVE\n\n` +
    `Token : ${shortMint(tokenMint)}\n` +
    `⏱️ Session : ${minutes} min\n` +
    `🔁 Cycles : ${cycleNumber}\n` +
    `🎯 Gains : ${wins}\n` +
    `🛡️ Protections : ${losses}\n`;

  if (poolInfo) {

    text +=
      `\n🏊 Pool : ${shortAddress(
        poolInfo.address.toBase58()
      )}\n` +
      `💧 SOL : ${poolInfo.solReserve.toFixed(4)}\n`;
  }

  if (lastMarket) {

    text +=
      `\n💰 Prix : ${lastMarket.price}\n` +
      `💧 Liquidité : ${usd(
        lastMarket.liquidityUsd
      )}\n` +
      `❤️ Score : ${calculateHealthScore(
        lastMarket
      )}/100\n`;
  }

  if (position) {

    text +=
      `\n📈 POSITION OUVERTE\n` +
      `Entrée : ${position.entryPrice}\n` +
      `🎯 Cible : ${position.targetPrice}`;
  } else {

    text +=
      `\n📭 Aucune position`;
  }

  return text;
}

// ============================================================
// LAST CRASH
// ============================================================

function lastCrashText() {

  const crashes =
    readJson(
      CRASH_FILE,
      []
    );

  if (!crashes.length) {
    return "🟢 Aucun crash enregistré.";
  }

  const crash =
    crashes[crashes.length - 1];

  return (
    `🚨 DERNIER CRASH\n\n` +
    `Token : ${shortMint(
      crash.token
    )}\n` +
    `Date : ${crash.time}\n` +
    `Raison : ${crash.reason}\n` +
    `Prix : ${crash.price}\n` +
    `Liquidité : ${usd(
      crash.liquidityUsd
    )}`
  );
}

// ============================================================
// TELEGRAM COMMANDS
// ============================================================

bot.command("starttrade", async ctx => {

  const parts =
    ctx.message.text
      .trim()
      .split(/\s+/);

  if (parts.length < 2) {

    await ctx.reply(
      "❌ Utilisation :\n/starttrade ADRESSE_TOKEN"
    );

    return;
  }

  const mint =
    parts[1].trim();

  await startTrade(mint);
});

bot.command("stoptrade", async ctx => {

  await stopTrade(
    "MANUAL"
  );
});

bot.command("status", async ctx => {

  await ctx.reply(
    await statusText()
  );
});

bot.command("lastcrash", async ctx => {

  await ctx.reply(
    lastCrashText()
  );
});

bot.command("help", async ctx => {

  await ctx.reply(
    `🤖 V5.7\n\n` +
    `/starttrade TOKEN\n` +
    `/stoptrade\n` +
    `/status\n` +
    `/lastcrash\n` +
    `/help\n\n` +
    `💵 Simulation : ${usd(CAPITAL_USD)}\n` +
    `🎯 Cible : +5%\n` +
    `⏱️ Session : 45 min\n` +
    `🚫 Nouveaux achats après 43 min`
  );
});

// ============================================================
// ERROR HANDLERS
// ============================================================

bot.catch(err => {

  console.error(
    "Telegram bot error:",
    err
  );
});

process.on(
  "uncaughtException",
  err => {

    console.error(
      "UNCAUGHT EXCEPTION:",
      err
    );
  }
);

process.on(
  "unhandledRejection",
  err => {

    console.error(
      "UNHANDLED REJECTION:",
      err
    );
  }
);

// ============================================================
// START BOT
// ============================================================

console.log(
  "🤖 V5.7 Telegram bot démarré"
);

console.log(
  "📡 RPC:",
  RPC_URL.replace(
    HELIUS_API_KEY,
    "***"
  )
);

bot.launch()
  .then(() => {

    console.log(
      "🟢 Telegram connecté"
    );

  })
  .catch(err => {

    console.error(
      "❌ Telegram launch:",
      err.message
    );
  });

// Arrêt propre
process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
