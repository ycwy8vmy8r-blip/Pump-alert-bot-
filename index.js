const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const {
  Connection,
  PublicKey
} = require("@solana/web3.js");
const { Telegraf } = require("telegraf");

/*
===========================================================
 PUMP TEST BOT V5.3
===========================================================

 SIMULATION UNIQUEMENT

 Capital :
   10 $

 Objectif :
   +5 %

 Nouveauté majeure :

   V5.2 :
      DexScreener -> pairAddress -> vérification

   V5.3 :
      PumpSwap directement
      ↓
      recherche des Pool accounts
      dont baseMint = token
      ↓
      vérification quoteMint = WSOL
      ↓
      sélection du meilleur pool
      ↓
      surveillance directe des vaults

 Aucun wallet.
 Aucune clé privée.
 Aucune transaction réelle.
===========================================================
*/

// ========================================================
// CONFIG
// ========================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const DEFAULT_MINT =
  "DJaLFMuqBa4JupES5KzRV5YHLRPMTQM2spm1jurt6Fa9";

const CAPITAL_USD = 10;
const TARGET_PROFIT = 0.05;

const POLL_MS = 2000;

const HISTORY_MS = 120000;
const CRASH_HISTORY_MS = 60000;

const OBSERVATION_AFTER_SELL_MS = 30000;

const NO_NEW_BUY_AFTER_MS =
  43 * 60 * 1000;

const MAX_SESSION_MS =
  45 * 60 * 1000;

// Entrée
const MIN_LIQUIDITY_USD = 3000;
const MIN_HEALTH_SCORE = 80;
const REQUIRED_CONFIRMATIONS = 4;

// Dégradation DEX
const ENTRY_PRICE_DROP_10S = -0.04;
const ENTRY_LIQ_DROP_10S = -0.10;
const ENTRY_LIQ_DROP_30S = -0.15;

// Crash
const CRASH_PRICE_DROP_10S = -0.20;
const CRASH_LIQ_DROP_10S = -0.50;
const CRASH_MIN_LIQUIDITY = 1;

// On-chain
const ONCHAIN_BATCH_MS = 80;
const ONCHAIN_BLOCK_MS = 30000;

const ONCHAIN_RESERVE_SHOCK_5S = -0.05;

const ONCHAIN_MIN_CHANGE_SOL = 0.01;

// ========================================================
// PROGRAMMES
// ========================================================

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// ========================================================
// DATA
// ========================================================

const DATA_DIR =
  fs.existsSync("/data")
    ? "/data"
    : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

const MARKET_FILE =
  path.join(
    DATA_DIR,
    "market_history.jsonl"
  );

const TRADES_FILE =
  path.join(
    DATA_DIR,
    "trade_history.json"
  );

const CRASH_FILE =
  path.join(
    DATA_DIR,
    "crash_reports.json"
  );

const SUMMARY_FILE =
  path.join(
    DATA_DIR,
    "v53_summary.json"
  );

// ========================================================
// CHECK ENV
// ========================================================

if (!BOT_TOKEN) {
  console.error(
    "❌ BOT_TOKEN manquant."
  );
  process.exit(1);
}

if (!CHAT_ID) {
  console.error(
    "❌ CHAT_ID manquant."
  );
  process.exit(1);
}

if (!HELIUS_API_KEY) {
  console.error(
    "❌ HELIUS_API_KEY manquant."
  );
  process.exit(1);
}

// ========================================================
// TELEGRAM
// ========================================================

const bot =
  new Telegraf(
    BOT_TOKEN
  );

// ========================================================
// SOLANA
// ========================================================

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection =
  new Connection(
    RPC_URL,
    {
      commitment: "processed"
    }
  );

// ========================================================
// STATE
// ========================================================

let running = false;

let mint =
  DEFAULT_MINT;

let marketTimer = null;
let sessionTimer = null;

let sessionStart = null;

let currentPrice = null;
let currentLiquidity = null;

let position = null;

let cycleNumber = 0;
let totalProfit = 0;

let observationUntil = 0;
let noNewBuyUntil = 0;

let favorableConfirmations = 0;

let healthScore = 100;

let marketHistory = [];
let onchainHistory = [];

let tradeHistory = [];
let crashReports = [];

// ========================================================
// POOL STATE
// ========================================================

let poolAddress = null;

let baseVaultAddress = null;
let quoteVaultAddress = null;

let poolBaseMint = null;
let poolQuoteMint = null;

let virtualQuoteReserves = 0n;

let selectedPoolQuoteReserve = 0n;

// ========================================================
// WEBSOCKET
// ========================================================

let ws = null;

let wsReconnectTimer = null;
let wsReconnectAttempts = 0;

let onchainBatchTimer = null;

let wsBaseSubscriptionId = null;
let wsQuoteSubscriptionId = null;
let wsPoolSubscriptionId = null;

// ========================================================
// VAULT STATE
// ========================================================

let baseVaultState = {
  amount: null,
  slot: null
};

let quoteVaultState = {
  amount: null,
  slot: null
};

let lastProcessedVaults = {
  base: null,
  quote: null
};

let lastOnchainEvent = null;
let lastOnchainRisk = null;

let onchainBlockedUntil = 0;

// ========================================================
// UTILS
// ========================================================

function shortMint(value) {
  if (!value) {
    return "???";
  }

  return (
    value.slice(0, 6) +
    "..." +
    value.slice(-6)
  );
}

function money(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return (
    "$" +
    value.toFixed(4)
  );
}

function pct(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return (
    value.toFixed(2) +
    "%"
  );
}

function formatPrice(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  if (value < 0.001) {
    return value.toFixed(10);
  }

  return value.toFixed(8);
}

function sleep(ms) {
  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}

// ========================================================
// FILES
// ========================================================

function loadJson(
  file,
  fallback
) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(
        file,
        "utf8"
      )
    );
  } catch {
    return fallback;
  }
}

function saveJson(
  file,
  data
) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(
        data,
        null,
        2
      )
    );
  } catch (error) {
    console.error(
      "❌ Sauvegarde:",
      error.message
    );
  }
}

function appendMarketPoint(
  point
) {
  try {
    fs.appendFileSync(
      MARKET_FILE,
      JSON.stringify(point) +
        "\n"
    );
  } catch (error) {
    console.error(
      "❌ market_history:",
      error.message
    );
  }
}

function saveSummary() {
  saveJson(
    SUMMARY_FILE,
    {
      updatedAt:
        new Date().toISOString(),

      mint,

      totalProfit,

      cyclesCompleted:
        cycleNumber,

      sessionStart,

      poolAddress
    }
  );
}

tradeHistory =
  loadJson(
    TRADES_FILE,
    []
  );

crashReports =
  loadJson(
    CRASH_FILE,
    []
  );

// ========================================================
// TELEGRAM
// ========================================================

async function telegram(
  message
) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      message
    );
  } catch (error) {
    console.error(
      "❌ Telegram:",
      error.message
    );
  }
}

// ========================================================
// DEXSCREENER
// ========================================================

async function getMarketData() {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  try {
    const response =
      await fetch(url);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !data ||
      !Array.isArray(
        data.pairs
      )
    ) {
      return null;
    }

    const pumpPairs =
      data.pairs.filter(
        pair =>
          String(
            pair.dexId || ""
          ).toLowerCase() ===
          "pumpswap"
      );

    if (
      pumpPairs.length === 0
    ) {
      return null;
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

    const pair =
      pumpPairs[0];

    const price =
      Number(
        pair.priceUsd || 0
      );

    const liquidity =
      Number(
        pair.liquidity?.usd || 0
      );

    if (
      !Number.isFinite(
        price
      ) ||
      price <= 0
    ) {
      return null;
    }

    return {
      timestamp:
        Date.now(),

      price,

      liquidity,

      pairAddress:
        pair.pairAddress ||
        null,

      volume24h:
        Number(
          pair.volume?.h24 || 0
        ),

      buys5m:
        Number(
          pair.txns?.m5?.buys || 0
        ),

      sells5m:
        Number(
          pair.txns?.m5?.sells || 0
        ),

      priceChange5m:
        Number(
          pair.priceChange?.m5 || 0
        ),

      priceChange1h:
        Number(
          pair.priceChange?.h1 || 0
        )
    };

  } catch (error) {
    console.error(
      "⚠️ DexScreener:",
      error.message
    );

    return null;
  }
}

// ========================================================
// HISTORY
// ========================================================

function cleanupHistory() {
  const cutoff =
    Date.now() -
    HISTORY_MS;

  marketHistory =
    marketHistory.filter(
      x =>
        x.timestamp >=
        cutoff
    );

  onchainHistory =
    onchainHistory.filter(
      x =>
        x.timestamp >=
        cutoff
    );
}

function getPreviousPoint(
  msAgo
) {
  const target =
    Date.now() -
    msAgo;

  for (
    let i =
      marketHistory.length - 1;
    i >= 0;
    i--
  ) {
    if (
      marketHistory[i]
        .timestamp <=
      target
    ) {
      return marketHistory[i];
    }
  }

  return null;
}

function percentageChange(
  current,
  previous
) {
  if (
    !Number.isFinite(
      current
    ) ||
    !Number.isFinite(
      previous
    ) ||
    previous <= 0
  ) {
    return null;
  }

  return (
    (current - previous) /
    previous
  );
}

function getDexMetrics() {
  const p10 =
    getPreviousPoint(
      10000
    );

  const p30 =
    getPreviousPoint(
      30000
    );

  return {
    price10:
      p10
        ? percentageChange(
            currentPrice,
            p10.price
          )
        : null,

    liquidity10:
      p10
        ? percentageChange(
            currentLiquidity,
            p10.liquidity
          )
        : null,

    liquidity30:
      p30
        ? percentageChange(
            currentLiquidity,
            p30.liquidity
          )
        : null
  };
}

// ========================================================
// HEALTH
// ========================================================

function calculateHealthScore() {
  if (
    !Number.isFinite(
      currentLiquidity
    ) ||
    currentLiquidity <= 0
  ) {
    return 0;
  }

  let score = 100;

  const metrics =
    getDexMetrics();

  if (
    metrics.liquidity10 !== null &&
    metrics.liquidity10 < -0.05
  ) {
    score -= 20;
  }

  if (
    metrics.liquidity10 !== null &&
    metrics.liquidity10 < -0.10
  ) {
    score -= 20;
  }

  if (
    metrics.liquidity30 !== null &&
    metrics.liquidity30 < -0.15
  ) {
    score -= 20;
  }

  if (
    metrics.price10 !== null &&
    metrics.price10 < -0.03
  ) {
    score -= 15;
  }

  if (
    metrics.price10 !== null &&
    metrics.price10 < -0.05
  ) {
    score -= 20;
  }

  if (
    Date.now() <
    onchainBlockedUntil
  ) {
    score -= 40;
  }

  if (
    lastOnchainRisk &&
    Date.now() -
      lastOnchainRisk.timestamp <
      30000
  ) {
    score -= 20;
  }

  return Math.max(
    0,
    Math.min(
      100,
      score
    )
  );
}

// ========================================================
// ENTRY
// ========================================================

function entryHealthy() {
  if (
    !Number.isFinite(
      currentPrice
    ) ||
    currentPrice <= 0
  ) {
    return false;
  }

  if (
    !Number.isFinite(
      currentLiquidity
    ) ||
    currentLiquidity <
      MIN_LIQUIDITY_USD
  ) {
    return false;
  }

  if (
    Date.now() <
    observationUntil
  ) {
    return false;
  }

  if (
    Date.now() <
    noNewBuyUntil
  ) {
    return false;
  }

  if (
    Date.now() <
    onchainBlockedUntil
  ) {
    return false;
  }

  const metrics =
    getDexMetrics();

  if (
    metrics.price10 !== null &&
    metrics.price10 <
      ENTRY_PRICE_DROP_10S
  ) {
    return false;
  }

  if (
    metrics.liquidity10 !== null &&
    metrics.liquidity10 <
      ENTRY_LIQ_DROP_10S
  ) {
    return false;
  }

  if (
    metrics.liquidity30 !== null &&
    metrics.liquidity30 <
      ENTRY_LIQ_DROP_30S
  ) {
    return false;
  }

  healthScore =
    calculateHealthScore();

  if (
    healthScore <
    MIN_HEALTH_SCORE
  ) {
    return false;
  }

  if (
    favorableConfirmations <
    REQUIRED_CONFIRMATIONS
  ) {
    return false;
  }

  return true;
}

// ========================================================
// CRASH
// ========================================================

function detectCrash() {
  if (
    !Number.isFinite(
      currentPrice
    ) ||
    !Number.isFinite(
      currentLiquidity
    )
  ) {
    return null;
  }

  const metrics =
    getDexMetrics();

  const reasons = [];

  if (
    currentLiquidity <=
    CRASH_MIN_LIQUIDITY
  ) {
    reasons.push(
      "liquidité quasi nulle"
    );
  }

  if (
    metrics.liquidity10 !== null &&
    metrics.liquidity10 <=
      CRASH_LIQ_DROP_10S
  ) {
    reasons.push(
      `liquidité ${pct(
        metrics.liquidity10 *
          100
      )} / 10s`
    );
  }

  if (
    metrics.price10 !== null &&
    metrics.price10 <=
      CRASH_PRICE_DROP_10S
  ) {
    reasons.push(
      `prix ${pct(
        metrics.price10 *
          100
      )} / 10s`
    );
  }

  if (
    lastOnchainRisk &&
    lastOnchainRisk.level ===
      "CRITICAL_WITHDRAWAL"
  ) {
    reasons.push(
      "retrait de liquidité détecté on-chain"
    );
  }

  if (
    reasons.length === 0
  ) {
    return null;
  }

  return {
    reasons,
    metrics
  };
}

// ========================================================
// PUBLIC KEY
// ========================================================

function readPubkey(
  buffer,
  offset
) {
  if (
    buffer.length <
    offset + 32
  ) {
    return null;
  }

  return new PublicKey(
    buffer.subarray(
      offset,
      offset + 32
    )
  );
}

// ========================================================
// SIGNED I128
// ========================================================

function readI128LE(
  buffer,
  offset
) {
  if (
    buffer.length <
    offset + 16
  ) {
    return 0n;
  }

  let value = 0n;

  for (
    let i = 0;
    i < 16;
    i++
  ) {
    value |=
      BigInt(
        buffer[
          offset + i
        ]
      ) <<
      BigInt(
        8 * i
      );
  }

  const sign =
    1n << 127n;

  const mask =
    (1n << 128n) - 1n;

  if (
    value & sign
  ) {
    value =
      -(
        (~value & mask) +
        1n
      );
  }

  return value;
}

// ========================================================
// POOL DECODER
// ========================================================

function decodePool(
  buffer
) {
  /*
    PumpSwap Pool

    discriminator: 0-8
    bump: 8
    index: 9-11
    creator: 11-43
    base_mint: 43-75
    quote_mint: 75-107
    lp_mint: 107-139
    pool_base_token_account: 139-171
    pool_quote_token_account: 171-203
    lp_supply: 203-211
    coin_creator: 211-243
    is_mayhem_mode: 243
    is_cashback_coin: 244
    virtual_quote_reserves: 245-261
  */

  if (
    !Buffer.isBuffer(
      buffer
    ) ||
    buffer.length < 203
  ) {
    throw new Error(
      "Compte Pool trop court."
    );
  }

  const baseMint =
    readPubkey(
      buffer,
      43
    );

  const quoteMint =
    readPubkey(
      buffer,
      75
    );

  const baseVault =
    readPubkey(
      buffer,
      139
    );

  const quoteVault =
    readPubkey(
      buffer,
      171
    );

  const virtualQuote =
    buffer.length >= 261
      ? readI128LE(
          buffer,
          245
        )
      : 0n;

  return {
    baseMint:
      baseMint?.toBase58(),

    quoteMint:
      quoteMint?.toBase58(),

    baseVault:
      baseVault?.toBase58(),

    quoteVault:
      quoteVault?.toBase58(),

    virtualQuoteReserves:
      virtualQuote
  };
}

// ========================================================
// DISCOVERY PUMPSWAP
// ========================================================

async function discoverPumpSwapPools() {
  console.log(
    "🔎 Recherche directe des pools PumpSwap..."
  );

  try {
    const tokenPk =
      new PublicKey(
        mint
      );

    /*
     IMPORTANT :

     On ne dépend plus de pairAddress.

     On demande directement au programme
     PumpSwap les comptes dont :

       offset 43 = baseMint

     C'est précisément le champ base_mint
     du compte Pool.
    */

    const accounts =
      await connection.getProgramAccounts(
        new PublicKey(
          PUMPSWAP_PROGRAM
        ),
        {
          commitment:
            "processed",

          filters: [
            {
              memcmp: {
                offset: 43,
                bytes:
                  tokenPk.toBase58()
              }
            }
          ]
        }
      );

    console.log(
      `🔎 ${accounts.length} pool(s) PumpSwap trouvé(s).`
    );

    if (
      accounts.length === 0
    ) {
      console.log(
        "❌ Aucun pool PumpSwap avec ce baseMint."
      );

      return null;
    }

    const candidates = [];

    for (
      const account of accounts
    ) {
      try {
        const decoded =
          decodePool(
            account.account.data
          );

        const address =
          account.pubkey.toBase58();

        console.log(
          `🔍 Pool ${shortMint(address)}`
        );

        console.log(
          `   base : ${shortMint(
            decoded.baseMint
          )}`
        );

        console.log(
          `   quote : ${shortMint(
            decoded.quoteMint
          )}`
        );

        if (
          decoded.baseMint !==
          mint
        ) {
          console.log(
            "   ❌ baseMint différent"
          );

          continue;
        }

        if (
          decoded.quoteMint !==
          WSOL_MINT
        ) {
          console.log(
            "   ❌ quote différent de WSOL"
          );

          continue;
        }

        if (
          !decoded.baseVault ||
          !decoded.quoteVault
        ) {
          console.log(
            "   ❌ vault manquant"
          );

          continue;
        }

        /*
         On lit la réserve quote
         pour choisir le pool le plus
         liquide si plusieurs existent.
        */

        let quoteReserve =
          0n;

        try {
          const vault =
            await connection.getAccountInfo(
              new PublicKey(
                decoded.quoteVault
              ),
              "processed"
            );

          if (
            vault &&
            vault.data.length >= 72
          ) {
            quoteReserve =
              vault.data.readBigUInt64LE(
                64
              );
          }
        } catch {}

        candidates.push({
          address,
          decoded,
          quoteReserve
        });

        console.log(
          "   ✅ CANDIDAT VALIDE"
        );

      } catch (error) {
        console.log(
          "   ❌ Pool illisible :",
          error.message
        );
      }
    }

    if (
      candidates.length === 0
    ) {
      console.log(
        "❌ Aucun pool PumpSwap WSOL valide."
      );

      return null;
    }

    /*
     Meilleur pool =
     plus grosse réserve WSOL.
    */

    candidates.sort(
      (a, b) => {
        if (
          a.quoteReserve ===
          b.quoteReserve
        ) {
          return 0;
        }

        return a.quoteReserve >
          b.quoteReserve
          ? -1
          : 1;
      }
    );

    const selected =
      candidates[0];

    poolAddress =
      selected.address;

    poolBaseMint =
      selected.decoded.baseMint;

    poolQuoteMint =
      selected.decoded.quoteMint;

    baseVaultAddress =
      selected.decoded.baseVault;

    quoteVaultAddress =
      selected.decoded.quoteVault;

    virtualQuoteReserves =
      selected.decoded
        .virtualQuoteReserves;

    selectedPoolQuoteReserve =
      selected.quoteReserve;

    console.log(
      ""
    );

    console.log(
      "✅ POOL PUMPSWAP SÉLECTIONNÉ"
    );

    console.log(
      `⛓️ Pool : ${poolAddress}`
    );

    console.log(
      `🪙 Base : ${poolBaseMint}`
    );

    console.log(
      `💧 Base vault : ${baseVaultAddress}`
    );

    console.log(
      `💧 Quote vault : ${quoteVaultAddress}`
    );

    console.log(
      `💧 Réserve quote : ${
        Number(
          selectedPoolQuoteReserve
        ) / 1e9
      } SOL`
    );

    console.log(
      `🧮 Virtual quote : ${
        virtualQuoteReserves.toString()
      }`
    );

    return selected;

  } catch (error) {
    console.error(
      "❌ Recherche pools PumpSwap:",
      error.message
    );

    return null;
  }
}

// ========================================================
// TOKEN ACCOUNT
// ========================================================

function decodeTokenAmount(
  base64
) {
  try {
    const buffer =
      Buffer.from(
        base64,
        "base64"
      );

    if (
      buffer.length < 72
    ) {
      return null;
    }

    return buffer.readBigUInt64LE(
      64
    );

  } catch {
    return null;
  }
}

// ========================================================
// INITIAL VAULT STATE
// ========================================================

async function initializeVaultState() {
  if (
    !baseVaultAddress ||
    !quoteVaultAddress
  ) {
    return false;
  }

  try {
    const accounts =
      await connection.getMultipleAccountsInfo(
        [
          new PublicKey(
            baseVaultAddress
          ),

          new PublicKey(
            quoteVaultAddress
          )
        ],
        "processed"
      );

    if (
      !accounts ||
      accounts.length !== 2 ||
      !accounts[0] ||
      !accounts[1]
    ) {
      return false;
    }

    if (
      accounts[0].data.length < 72 ||
      accounts[1].data.length < 72
    ) {
      return false;
    }

    const baseAmount =
      accounts[0].data.readBigUInt64LE(
        64
      );

    const quoteAmount =
      accounts[1].data.readBigUInt64LE(
        64
      );

    const slot =
      await connection.getSlot(
        "processed"
      );

    baseVaultState = {
      amount:
        baseAmount,
      slot
    };

    quoteVaultState = {
      amount:
        quoteAmount,
      slot
    };

    lastProcessedVaults = {
      base:
        baseAmount,

      quote:
        quoteAmount
    };

    console.log(
      "⛓️ Réserves initiales chargées."
    );

    console.log(
      `   Base : ${
        Number(
          baseAmount
        ) / 1e9
      }`
    );

    console.log(
      `   Quote : ${
        Number(
          quoteAmount
        ) / 1e9
      } SOL`
    );

    return true;

  } catch (error) {
    console.error(
      "❌ Initialisation vaults:",
      error.message
    );

    return false;
  }
}

// ========================================================
// WS CLOSE
// ========================================================

function closeOnchainWs() {
  if (
    onchainBatchTimer
  ) {
    clearTimeout(
      onchainBatchTimer
    );

    onchainBatchTimer = null;
  }

  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch {}

    ws = null;
  }

  wsBaseSubscriptionId =
    null;

  wsQuoteSubscriptionId =
    null;

  wsPoolSubscriptionId =
    null;
}

// ========================================================
// WS BATCH
// ========================================================

function scheduleOnchainBatch() {
  if (
    onchainBatchTimer
  ) {
    return;
  }

  onchainBatchTimer =
    setTimeout(
      () => {
        onchainBatchTimer =
          null;

        processOnchainBatch();
      },
      ONCHAIN_BATCH_MS
    );
}

// ========================================================
// WS VAULT MESSAGE
// ========================================================

function handleVaultNotification(
  type,
  result
) {
  try {
    const slot =
      Number(
        result.context?.slot ||
        0
      );

    const value =
      result.value;

    if (
      !value ||
      !value.data ||
      !Array.isArray(
        value.data
      )
    ) {
      return;
    }

    const amount =
      decodeTokenAmount(
        value.data[0]
      );

    if (
      amount === null
    ) {
      return;
    }

    if (
      type === "base"
    ) {
      baseVaultState = {
        amount,
        slot
      };
    }

    if (
      type === "quote"
    ) {
      quoteVaultState = {
        amount,
        slot
      };
    }

    scheduleOnchainBatch();

  } catch (error) {
    console.error(
      "⚠️ Vault message:",
      error.message
    );
  }
}

// ========================================================
// CLASSIFICATION
// ========================================================

function classifyOnchainDelta(
  deltaBase,
  deltaQuote
) {
  const baseSol =
    Number(
      deltaBase
    ) / 1e9;

  const quoteSol =
    Number(
      deltaQuote
    ) / 1e9;

  if (
    Math.abs(
      baseSol
    ) < ONCHAIN_MIN_CHANGE_SOL &&
    Math.abs(
      quoteSol
    ) < ONCHAIN_MIN_CHANGE_SOL
  ) {
    return {
      type: "SMALL",
      baseSol,
      quoteSol
    };
  }

  /*
   BUY :

      pool token base augmente
      pool WSOL quote diminue
  */

  if (
    deltaBase > 0n &&
    deltaQuote < 0n
  ) {
    return {
      type: "BUY",
      baseSol,
      quoteSol
    };
  }

  /*
   SELL :

      pool token base diminue
      pool WSOL quote augmente
  */

  if (
    deltaBase < 0n &&
    deltaQuote > 0n
  ) {
    return {
      type: "SELL",
      baseSol,
      quoteSol
    };
  }

  /*
   RETRAIT :

      les deux réserves diminuent
  */

  if (
    deltaBase < 0n &&
    deltaQuote < 0n
  ) {
    return {
      type: "WITHDRAWAL",
      baseSol,
      quoteSol
    };
  }

  /*
   AJOUT :

      les deux réserves augmentent
  */

  if (
    deltaBase > 0n &&
    deltaQuote > 0n
  ) {
    return {
      type: "ADD_LIQUIDITY",
      baseSol,
      quoteSol
    };
  }

  return {
    type: "OTHER",
    baseSol,
    quoteSol
  };
}

// ========================================================
// PROCESS ONCHAIN
// ========================================================

function processOnchainBatch() {
  if (
    baseVaultState.amount === null ||
    quoteVaultState.amount === null
  ) {
    return;
  }

  if (
    baseVaultState.slot === null ||
    quoteVaultState.slot === null
  ) {
    return;
  }

  /*
   On attend que les deux vaults
   soient observés sur le même slot.
  */

  if (
    baseVaultState.slot !==
    quoteVaultState.slot
  ) {
    return;
  }

  const base =
    baseVaultState.amount;

  const quote =
    quoteVaultState.amount;

  if (
    lastProcessedVaults.base === null ||
    lastProcessedVaults.quote === null
  ) {
    lastProcessedVaults = {
      base,
      quote
    };

    return;
  }

  const deltaBase =
    base -
    lastProcessedVaults.base;

  const deltaQuote =
    quote -
    lastProcessedVaults.quote;

  if (
    deltaBase === 0n &&
    deltaQuote === 0n
  ) {
    return;
  }

  const classification =
    classifyOnchainDelta(
      deltaBase,
      deltaQuote
    );

  const event = {
    timestamp:
      Date.now(),

    slot:
      baseVaultState.slot,

    type:
      classification.type,

    deltaBase:
      deltaBase.toString(),

    deltaQuote:
      deltaQuote.toString(),

    deltaBaseSOL:
      classification.baseSol,

    deltaQuoteSOL:
      classification.quoteSol,

    baseReserve:
      base.toString(),

    quoteReserve:
      quote.toString(),

    virtualQuoteReserves:
      virtualQuoteReserves.toString(),

    effectiveQuoteReserve:
      (
        quote +
        virtualQuoteReserves
      ).toString()
  };

  onchainHistory.push(
    event
  );

  lastOnchainEvent =
    event;

  lastProcessedVaults = {
    base,
    quote
  };

  console.log(
    `⛓️ ${event.type} | ` +
    `base ${event.deltaBaseSOL.toFixed(4)} SOL | ` +
    `quote ${event.deltaQuoteSOL.toFixed(4)} SOL`
  );

  evaluateOnchainRisk(
    event
  );
}

// ========================================================
// ONCHAIN PREVIOUS
// ========================================================

function getPreviousOnchain(
  timestamp,
  msAgo
) {
  const target =
    timestamp -
    msAgo;

  for (
    let i =
      onchainHistory.length - 1;
    i >= 0;
    i--
  ) {
    if (
      onchainHistory[i]
        .timestamp <=
      target
    ) {
      return onchainHistory[i];
    }
  }

  return null;
}

// ========================================================
// ONCHAIN RISK
// ========================================================

function evaluateOnchainRisk(
  event
) {
  const now =
    Date.now();

  /*
   RETRAIT DIRECT
  */

  if (
    event.type ===
    "WITHDRAWAL"
  ) {
    onchainBlockedUntil =
      Math.max(
        onchainBlockedUntil,
        now +
          ONCHAIN_BLOCK_MS
      );

    lastOnchainRisk = {
      timestamp: now,
      level:
        "CRITICAL_WITHDRAWAL",
      event
    };

    console.log(
      "🚨 RETRAIT DE LIQUIDITÉ ON-CHAIN"
    );

    telegram(
`🚨 ANOMALIE ON-CHAIN

Token :
${mint}

Pool :
${poolAddress}

⚠️ RETRAIT DE LIQUIDITÉ DÉTECTÉ

Base :
${event.deltaBaseSOL.toFixed(4)} SOL

Quote :
${event.deltaQuoteSOL.toFixed(4)} SOL

⛔ Nouvel achat bloqué pendant 30 secondes.

Simulation uniquement.`
    );

    return;
  }

  /*
   CHOC DES RÉSERVES
  */

  const previous =
    getPreviousOnchain(
      event.timestamp,
      5000
    );

  if (!previous) {
    return;
  }

  const currentBase =
    Number(
      event.baseReserve
    );

  const previousBase =
    Number(
      previous.baseReserve
    );

  const currentQuote =
    Number(
      event.quoteReserve
    );

  const previousQuote =
    Number(
      previous.quoteReserve
    );

  if (
    previousBase <= 0 ||
    previousQuote <= 0
  ) {
    return;
  }

  const baseChange =
    (
      currentBase -
      previousBase
    ) /
    previousBase;

  const quoteChange =
    (
      currentQuote -
      previousQuote
    ) /
    previousQuote;

  if (
    baseChange <=
      ONCHAIN_RESERVE_SHOCK_5S &&
    quoteChange <=
      ONCHAIN_RESERVE_SHOCK_5S
  ) {
    onchainBlockedUntil =
      Math.max(
        onchainBlockedUntil,
        now +
          ONCHAIN_BLOCK_MS
      );

    lastOnchainRisk = {
      timestamp: now,
      level:
        "RESERVE_SHOCK",

      baseChange,

      quoteChange,

      event
    };

    console.log(
      "🚨 CHOC DES RÉSERVES ON-CHAIN"
    );

    telegram(
`🚨 CHOC DES RÉSERVES

Token :
${mint}

Base :
${pct(
  baseChange * 100
)}

Quote :
${pct(
  quoteChange * 100
)}

⛔ Nouvel achat temporairement bloqué.`
    );
  }
}

// ========================================================
// WS CONNECT
// ========================================================

async function connectOnchainMonitor() {
  if (
    !poolAddress ||
    !baseVaultAddress ||
    !quoteVaultAddress
  ) {
    return;
  }

  closeOnchainWs();

  ws =
    new WebSocket(
      WSS_URL
    );

  ws.on(
    "open",
    () => {
      console.log(
        "⛓️ Helius WSS connecté."
      );

      wsReconnectAttempts =
        0;

      subscribeAccounts();
    }
  );

  ws.on(
    "message",
    raw => {
      try {
        const message =
          JSON.parse(
            raw.toString()
          );

        /*
         Réponses aux demandes
         de subscription.
        */

        if (
          message.id === 1001 &&
          message.result
        ) {
          wsBaseSubscriptionId =
            message.result;

          return;
        }

        if (
          message.id === 1002 &&
          message.result
        ) {
          wsQuoteSubscriptionId =
            message.result;

          return;
        }

        if (
          message.id === 1003 &&
          message.result
        ) {
          wsPoolSubscriptionId =
            message.result;

          return;
        }

        if (
          !message.params ||
          !message.params.result
        ) {
          return;
        }

        const subscription =
          message.params
            .subscription;

        const result =
          message.params
            .result;

        if (
          subscription ===
          wsBaseSubscriptionId
        ) {
          handleVaultNotification(
            "base",
            result
          );
        }

        if (
          subscription ===
          wsQuoteSubscriptionId
        ) {
          handleVaultNotification(
            "quote",
            result
          );
        }

        if (
          subscription ===
          wsPoolSubscriptionId
        ) {
          handlePoolUpdate(
            result
          );
        }

      } catch (error) {
        console.error(
          "⚠️ Message WSS:",
          error.message
        );
      }
    }
  );

  ws.on(
    "close",
    () => {
      if (!running) {
        return;
      }

      console.log(
        "⚠️ Helius WSS fermé."
      );

      scheduleReconnect();
    }
  );

  ws.on(
    "error",
    error => {
      console.error(
        "⚠️ Helius WSS:",
        error.message
      );
    }
  );
}

// ========================================================
// SUBSCRIPTIONS
// ========================================================

function subscribeAccounts() {
  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1001,

      method:
        "accountSubscribe",

      params: [
        baseVaultAddress,

        {
          encoding:
            "base64",

          commitment:
            "processed"
        }
      ]
    })
  );

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1002,

      method:
        "accountSubscribe",

      params: [
        quoteVaultAddress,

        {
          encoding:
            "base64",

          commitment:
            "processed"
        }
      ]
    })
  );

  /*
   Pool lui-même :
   utile pour virtual_quote_reserves.
  */

  ws.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1003,

      method:
        "accountSubscribe",

      params: [
        poolAddress,

        {
          encoding:
            "base64",

          commitment:
            "processed"
        }
      ]
    })
  );
}

// ========================================================
// POOL UPDATE
// ========================================================

function handlePoolUpdate(
  result
) {
  try {
    const value =
      result.value;

    if (
      !value ||
      !value.data ||
      !Array.isArray(
        value.data
      )
    ) {
      return;
    }

    const buffer =
      Buffer.from(
        value.data[0],
        "base64"
      );

    const decoded =
      decodePool(
        buffer
      );

    if (
      decoded.baseMint !==
      mint
    ) {
      return;
    }

    if (
      decoded.quoteMint !==
      WSOL_MINT
    ) {
      return;
    }

    if (
      decoded.baseVault !==
      baseVaultAddress
    ) {
      return;
    }

    if (
      decoded.quoteVault !==
      quoteVaultAddress
    ) {
      return;
    }

    virtualQuoteReserves =
      decoded.virtualQuoteReserves;

  } catch (error) {
    console.error(
      "⚠️ Pool update:",
      error.message
    );
  }
}

// ========================================================
// RECONNECT
// ========================================================

function scheduleReconnect() {
  if (
    wsReconnectTimer ||
    !running
  ) {
    return;
  }

  wsReconnectAttempts++;

  const delay =
    Math.min(
      30000,
      1000 *
        Math.pow(
          2,
          Math.min(
            wsReconnectAttempts,
            5
          )
        )
    );

  wsReconnectTimer =
    setTimeout(
      async () => {
        wsReconnectTimer =
          null;

        if (!running) {
          return;
        }

        console.log(
          "🔄 Reconnexion Helius..."
        );

        await connectOnchainMonitor();

      },
      delay
    );
}

// ========================================================
// BUY
// ========================================================

async function simulateBuy() {
  if (position) {
    return;
  }

  if (
    !entryHealthy()
  ) {
    return;
  }

  cycleNumber++;

  const entryPrice =
    currentPrice;

  const tokens =
    CAPITAL_USD /
    entryPrice;

  const targetPrice =
    entryPrice *
    (
      1 +
      TARGET_PROFIT
    );

  position = {
    cycle:
      cycleNumber,

    mint,

    entryPrice,

    tokens,

    capital:
      CAPITAL_USD,

    targetPrice,

    timestamp:
      Date.now()
  };

  await telegram(
`🟢 ACHAT TEST V5.3 #${cycleNumber}

Token :
${mint}

Mise fixe :
${money(CAPITAL_USD)}

Prix :
${formatPrice(
  entryPrice
)}

Tokens :
${tokens.toFixed(8)}

🎯 Objectif :
+${(
  TARGET_PROFIT *
  100
).toFixed(2)}%

Prix cible :
${formatPrice(
  targetPrice
)}

💧 Liquidité :
${money(
  currentLiquidity
)}

🧠 Score :
${healthScore}/100

⛓️ Pool PumpSwap :
${poolAddress}

🛡️ Confirmation :
${favorableConfirmations}/${REQUIRED_CONFIRMATIONS}

Simulation uniquement.`
  );
}

// ========================================================
// SELL
// ========================================================

async function simulateSell(
  reason = "TARGET"
) {
  if (!position) {
    return;
  }

  if (
    currentLiquidity <=
      CRASH_MIN_LIQUIDITY ||
    healthScore <= 20
  ) {
    return;
  }

  const entryPrice =
    position.entryPrice;

  const targetPrice =
    entryPrice *
    (
      1 +
      TARGET_PROFIT
    );

  const exitPrice =
    reason === "TARGET"
      ? targetPrice
      : currentPrice;

  const exitAmount =
    position.tokens *
    exitPrice;

  const profit =
    exitAmount -
    position.capital;

  totalProfit +=
    profit;

  tradeHistory.push({
    timestamp:
      new Date().toISOString(),

    cycle:
      position.cycle,

    mint,

    entryPrice,

    exitPrice,

    capital:
      position.capital,

    exitAmount,

    profit,

    reason
  });

  saveJson(
    TRADES_FILE,
    tradeHistory
  );

  await telegram(
`🔴 VENTE TEST V5.3 #${position.cycle}

Prix :
${formatPrice(
  exitPrice
)}

Montant simulé :
${money(
  exitAmount
)}

Résultat :
${pct(
  (
    profit /
    position.capital
  ) * 100
)}

Bénéfice :
${profit >= 0 ? "+" : ""}${money(
  profit
)}

💰 Bénéfices cumulés :
${money(
  totalProfit
)}

🛡️ PHASE DE SÉCURITÉ

⏳ Observation :
30 secondes

❌ Aucun rachat immédiat.`
  );

  position = null;

  observationUntil =
    Date.now() +
    OBSERVATION_AFTER_SELL_MS;

  favorableConfirmations =
    0;

  saveSummary();
}

// ========================================================
// CRASH REPORT
// ========================================================

function getLast60Seconds() {
  const cutoff =
    Date.now() -
    CRASH_HISTORY_MS;

  return {
    market:
      marketHistory.filter(
        x =>
          x.timestamp >=
          cutoff
      ),

    onchain:
      onchainHistory.filter(
        x =>
          x.timestamp >=
          cutoff
      )
  };
}

async function saveCrashReport(
  crashInfo
) {
  const snapshot =
    getLast60Seconds();

  const report = {
    id:
      `crash_${Date.now()}`,

    timestamp:
      new Date().toISOString(),

    sessionStart,

    mint,

    cyclesCompleted:
      cycleNumber,

    sessionProfit:
      totalProfit,

    pool: {
      address:
        poolAddress,

      baseMint:
        poolBaseMint,

      quoteMint:
        poolQuoteMint,

      baseVault:
        baseVaultAddress,

      quoteVault:
        quoteVaultAddress,

      virtualQuoteReserves:
        virtualQuoteReserves.toString()
    },

    crashMarket: {
      price:
        currentPrice,

      liquidity:
        currentLiquidity,

      priceChange10s:
        crashInfo.metrics
          .price10 !== null
          ? crashInfo.metrics
              .price10 * 100
          : null,

      liquidityChange10s:
        crashInfo.metrics
          .liquidity10 !== null
          ? crashInfo.metrics
              .liquidity10 * 100
          : null,

      score:
        healthScore
    },

    lastOnchainEvent,

    lastOnchainRisk,

    reasons:
      crashInfo.reasons,

    openPosition:
      position,

    last60Seconds:
      snapshot
  };

  crashReports.push(
    report
  );

  saveJson(
    CRASH_FILE,
    crashReports
  );

  console.log(
    `🚨 CRASH enregistré : ${report.id}`
  );

  await telegram(
`🚨 STOP CRASH - V5.3

Token :
${mint}

Prix :
${formatPrice(
  currentPrice
)}

Liquidité :
${money(
  currentLiquidity
)}

Prix / 10s :
${pct(
  crashInfo.metrics
    .price10 !== null
    ? crashInfo.metrics
        .price10 * 100
    : null
)}

Liquidité / 10s :
${pct(
  crashInfo.metrics
    .liquidity10 !== null
    ? crashInfo.metrics
        .liquidity10 * 100
    : null
)}

🧠 Score :
${healthScore}/100

⛓️ Pool :
${poolAddress}

⛓️ Dernier événement :
${
  lastOnchainEvent
    ? lastOnchainEvent.type
    : "aucun"
}

⚠️ Signaux :
${crashInfo.reasons
  .map(
    x =>
      "• " + x
  )
  .join("\n")}

⚠️ Position restante :
${
  position
    ? position.tokens
    : "aucune"
}

📊 60 secondes sauvegardées.

💰 Bénéfices simulés :
${money(
  totalProfit
)}

⛔ RADAR ARRÊTÉ

Simulation uniquement.`
  );
}

// ========================================================
// CRASH STOP
// ========================================================

async function crashStop(
  crashInfo
) {
  if (!running) {
    return;
  }

  running = false;

  if (marketTimer) {
    clearInterval(
      marketTimer
    );

    marketTimer = null;
  }

  if (sessionTimer) {
    clearTimeout(
      sessionTimer
    );

    sessionTimer = null;
  }

  closeOnchainWs();

  await saveCrashReport(
    crashInfo
  );

  saveSummary();

  console.log(
    "⛔ Radar arrêté."
  );
}

// ========================================================
// MARKET LOOP
// ========================================================

async function marketTick() {
  if (!running) {
    return;
  }

  const data =
    await getMarketData();

  if (!data) {
    console.log(
      "⚠️ Aucune donnée DEX disponible."
    );

    return;
  }

  currentPrice =
    data.price;

  currentLiquidity =
    data.liquidity;

  const point = {
    ...data,

    poolAddress,

    onchainEvent:
      lastOnchainEvent
        ? lastOnchainEvent.type
        : null,

    onchainBlocked:
      Date.now() <
      onchainBlockedUntil,

    healthScore
  };

  marketHistory.push(
    point
  );

  cleanupHistory();

  appendMarketPoint(
    point
  );

  /*
   Si aucun pool n'est encore trouvé,
   on lance la découverte directement
   depuis PumpSwap.
  */

  if (!poolAddress) {
    const pool =
      await discoverPumpSwapPools();

    if (pool) {
      await initializeVaultState();

      await connectOnchainMonitor();

      await telegram(
`⛓️ POOL PUMPSWAP TROUVÉ

Token :
${mint}

Pool :
${poolAddress}

Base vault :
${baseVaultAddress}

Quote vault :
${quoteVaultAddress}

💧 Réserve quote :
${
  (
    Number(
      selectedPoolQuoteReserve
    ) / 1e9
  ).toFixed(4)
} SOL

🟢 Surveillance on-chain active.`
      );
    }
  }

  healthScore =
    calculateHealthScore();

  /*
   Confirmation entrée
  */

  if (
    currentLiquidity >=
      MIN_LIQUIDITY_USD &&

    healthScore >=
      MIN_HEALTH_SCORE &&

    Date.now() >=
      observationUntil &&

    Date.now() >=
      noNewBuyUntil &&

    Date.now() >=
      onchainBlockedUntil
  ) {
    favorableConfirmations =
      Math.min(
        REQUIRED_CONFIRMATIONS,
        favorableConfirmations +
          1
      );
  } else {
    favorableConfirmations =
      0;
  }

  /*
   Crash
  */

  const crash =
    detectCrash();

  if (crash) {
    await crashStop(
      crash
    );

    return;
  }

  /*
   Position ouverte
  */

  if (position) {
    if (
      currentPrice >=
      position.targetPrice
    ) {
      await simulateSell(
        "TARGET"
      );
    }

    return;
  }

  /*
   Pas de position
  */

  if (
    entryHealthy()
  ) {
    await simulateBuy();
  } else {
    /*
     Affichage de diagnostic,
     mais seulement toutes les ~10 secondes.
    */

    if (
      marketHistory.length %
        5 ===
      0
    ) {
      console.log(
        `🔎 Entrée refusée | ` +
        `liq=${money(
          currentLiquidity
        )} | ` +
        `score=${healthScore}/100 | ` +
        `confirm=${favorableConfirmations}/${REQUIRED_CONFIRMATIONS} | ` +
        `onchain=${
          Date.now() <
          onchainBlockedUntil
            ? "BLOQUÉ"
            : "OK"
        }`
      );
    }
  }
}

// ========================================================
// START SESSION
// ========================================================

async function startSession(
  requestedMint
) {
  if (running) {
    await telegram(
      "⚠️ Une session est déjà active."
    );

    return;
  }

  mint =
    requestedMint ||
    DEFAULT_MINT;

  try {
    new PublicKey(
      mint
    );
  } catch {
    await telegram(
      "❌ Mint Solana invalide."
    );

    return;
  }

  running = true;

  sessionStart =
    new Date().toISOString();

  cycleNumber = 0;
  totalProfit = 0;

  position = null;

  marketHistory = [];
  onchainHistory = [];

  favorableConfirmations = 0;

  observationUntil = 0;

  noNewBuyUntil =
    Date.now() +
    NO_NEW_BUY_AFTER_MS;

  healthScore = 100;

  poolAddress = null;

  baseVaultAddress = null;
  quoteVaultAddress = null;

  poolBaseMint = null;
  poolQuoteMint = null;

  virtualQuoteReserves = 0n;

  selectedPoolQuoteReserve =
    0n;

  resetVaultState();

  await telegram(
`🚀 V5.3 DÉMARRÉE

Token :
${mint}

💵 Capital :
${money(
  CAPITAL_USD
)}

🎯 Objectif :
+${(
  TARGET_PROFIT *
  100
).toFixed(2)}%

🔎 Recherche directe :
PumpSwap Pool accounts

⛓️ Surveillance :
vaults base + quote

💧 Détection :
retrait de liquidité

⏳ Observation après vente :
30 secondes

⏱️ Pas de nouvel achat après :
43 minutes

🛑 Session maximale :
45 minutes

🧪 SIMULATION UNIQUEMENT`
  );

  await marketTick();

  if (!running) {
    return;
  }

  marketTimer =
    setInterval(
      marketTick,
      POLL_MS
    );

  sessionTimer =
    setTimeout(
      async () => {
        if (!running) {
          return;
        }

        if (
          position &&
          currentLiquidity >
            MIN_LIQUIDITY_USD &&
          healthScore >= 60
        ) {
          await simulateSell(
            "SESSION_LIMIT"
          );
        }

        await stopSession(
          "limite de session 45 minutes"
        );
      },
      MAX_SESSION_MS
    );
}

// ========================================================
// RESET VAULT
// ========================================================

function resetVaultState() {
  baseVaultState = {
    amount: null,
    slot: null
  };

  quoteVaultState = {
    amount: null,
    slot: null
  };

  lastProcessedVaults = {
    base: null,
    quote: null
  };

  lastOnchainEvent = null;
  lastOnchainRisk = null;

  onchainBlockedUntil = 0;
}

// ========================================================
// STOP
// ========================================================

async function stopSession(
  reason
) {
  if (!running) {
    return;
  }

  running = false;

  if (marketTimer) {
    clearInterval(
      marketTimer
    );

    marketTimer = null;
  }

  if (sessionTimer) {
    clearTimeout(
      sessionTimer
    );

    sessionTimer = null;
  }

  closeOnchainWs();

  await telegram(
`⛔ SESSION V5.3 ARRÊTÉE

Token :
${mint}

Raison :
${reason}

Cycles :
${cycleNumber}

💰 Bénéfices :
${money(
  totalProfit
)}

${
  position
    ? "⚠️ Position ouverte non vendue."
    : "⚪ Aucune position ouverte."
}

Simulation uniquement.`
  );

  saveSummary();
}

// ========================================================
// STATUS
// ========================================================

async function sendStatus() {
  if (!running) {
    await telegram(
`⚪ V5.3 inactive

Profit :
${money(
  totalProfit
)}

Cycles :
${cycleNumber}

Pool :
${poolAddress || "aucun"}

Crash :
${
  crashReports.length
    ? crashReports[
        crashReports.length - 1
      ].id
    : "aucun"
}`
    );

    return;
  }

  const observation =
    Math.max(
      0,
      observationUntil -
        Date.now()
    );

  const noBuy =
    Math.max(
      0,
      noNewBuyUntil -
        Date.now()
    );

  await telegram(
`📊 STATUS V5.3

Token :
${mint}

Prix :
${formatPrice(
  currentPrice
)}

Liquidité :
${money(
  currentLiquidity
)}

🧠 Score :
${healthScore}/100

🛡️ Confirmation :
${favorableConfirmations}/${REQUIRED_CONFIRMATIONS}

💰 Profit :
${money(
  totalProfit
)}

Cycles :
${cycleNumber}

⛓️ Pool :
${poolAddress || "recherche..."}

⛓️ Base vault :
${baseVaultAddress || "..."}

⛓️ Quote vault :
${quoteVaultAddress || "..."}

⛓️ Dernier événement :
${
  lastOnchainEvent
    ? lastOnchainEvent.type
    : "aucun"
}

🛡️ Blocage on-chain :
${
  Date.now() <
  onchainBlockedUntil
    ? "OUI"
    : "NON"
}

⏳ Observation :
${
  observation > 0
    ? Math.ceil(
        observation / 1000
      ) + "s"
    : "terminée"
}

⛔ Nouvel achat :
${
  noBuy > 0
    ? Math.ceil(
        noBuy / 60000
      ) + " min"
    : "autorisé"
}

${
  position
    ? `🟢 Position #${position.cycle}

Entrée :
${formatPrice(
  position.entryPrice
)}

Cible :
${formatPrice(
  position.targetPrice
)}`
    : "⚪ Aucune position"
}`
  );
}

// ========================================================
// LAST CRASH
// ========================================================

async function sendLastCrash() {
  if (
    crashReports.length === 0
  ) {
    await telegram(
      "📭 Aucun crash enregistré."
    );

    return;
  }

  const report =
    crashReports[
      crashReports.length - 1
    ];

  await telegram(
`📋 DERNIER CRASH V5.3

Token :
${report.mint}

Date :
${report.timestamp}

Prix :
${formatPrice(
  report.crashMarket.price
)}

Liquidité :
${money(
  report.crashMarket.liquidity
)}

Prix / 10s :
${pct(
  report.crashMarket
    .priceChange10s
)}

Liquidité / 10s :
${pct(
  report.crashMarket
    .liquidityChange10s
)}

🧠 Score :
${report.crashMarket.score}/100

⛓️ Pool :
${report.pool?.address || "N/A"}

⛓️ Dernier événement :
${
  report.lastOnchainEvent
    ? report.lastOnchainEvent.type
    : "aucun"
}

💰 Profit :
${money(
  report.sessionProfit
)}

Cycles :
${report.cyclesCompleted}

📁 Rapport complet :
crash_reports.json`
  );
}

// ========================================================
// COMMANDS
// ========================================================

bot.command(
  "starttrade",
  async ctx => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    const requestedMint =
      parts[1] ||
      DEFAULT_MINT;

    await startSession(
      requestedMint
    );
  }
);

bot.command(
  "stoptrade",
  async () => {
    await stopSession(
      "arrêt manuel"
    );
  }
);

bot.command(
  "status",
  async () => {
    await sendStatus();
  }
);

bot.command(
  "lastcrash",
  async () => {
    await sendLastCrash();
  }
);

bot.command(
  "help",
  async () => {
    await telegram(
`🤖 V5.3

/starttrade MINT
Démarrer un test

/status
État actuel

/stoptrade
Arrêter

/lastcrash
Dernier crash

/help
Aide

💵 Capital :
10 $

🎯 Objectif :
+5 %

🧪 Simulation uniquement.`
    );
  }
);

// ========================================================
// TELEGRAM START
// ========================================================

bot.launch()
  .then(() => {
    console.log(
      "🤖 Bot Telegram V5.3 prêt."
    );
  })
  .catch(error => {
    console.error(
      "❌ Telegram:",
      error.message
    );

    process.exit(1);
  });

// ========================================================
// SHUTDOWN
// ========================================================

async function shutdown() {
  console.log(
    "🛑 Arrêt..."
  );

  running = false;

  if (marketTimer) {
    clearInterval(
      marketTimer
    );
  }

  if (sessionTimer) {
    clearTimeout(
      sessionTimer
    );
  }

  closeOnchainWs();

  if (
    wsReconnectTimer
  ) {
    clearTimeout(
      wsReconnectTimer
    );
  }

  try {
    bot.stop(
      "shutdown"
    );
  } catch {}

  process.exit(0);
}

process.once(
  "SIGINT",
  shutdown
);

process.once(
  "SIGTERM",
  shutdown
);
