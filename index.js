require("dotenv").config();

const { Telegraf } = require("telegraf");
const {
  Connection,
  PublicKey,
} = require("@solana/web3.js");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

/* =========================================================
   CONFIGURATION
========================================================= */

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN manquant");
}

if (!CHAT_ID) {
  throw new Error("CHAT_ID manquant");
}

if (!HELIUS_API_KEY) {
  throw new Error("HELIUS_API_KEY manquant");
}

/* =========================================================
   SOLANA / PUMPSWAP
========================================================= */

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, {
  commitment: "processed",
});

const PUMPSWAP_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

/*
  PumpSwap Pool layout officiel :

  0   discriminator 8 bytes
  8   bump           1
  9   index          2
  11  creator       32
  43  base_mint     32
  75  quote_mint    32
  107 lp_mint       32
  139 base vault    32
  171 quote vault   32
  203 lp_supply     8
  211 coin_creator 32
  243 flags...
  245 virtual quote reserves i128
*/

const POOL_BASE_MINT_OFFSET = 43;
const POOL_QUOTE_MINT_OFFSET = 75;
const POOL_BASE_VAULT_OFFSET = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;
const POOL_VIRTUAL_QUOTE_OFFSET = 245;

/* =========================================================
   STRATEGIE
========================================================= */

const CAPITAL_USD = 10;
const TARGET_GAIN = 0.05;

const MARKET_INTERVAL_MS = 2000;

const OBSERVATION_AFTER_SELL_MS = 30 * 1000;

const NO_NEW_BUY_AFTER_MS = 43 * 60 * 1000;

const MAX_SESSION_MS = 45 * 60 * 1000;

const MIN_LIQUIDITY_USD = 3000;

const MIN_HEALTH_SCORE = 80;

const REQUIRED_CONFIRMATIONS = 4;

/* Crash */

const CRASH_PRICE_10S = -20;

const CRASH_LIQUIDITY_10S = -50;

const CRASH_MIN_LIQUIDITY = 1;

/* Entrée */

const ENTRY_PRICE_10S = -4;

const ENTRY_LIQUIDITY_10S = -10;

const ENTRY_LIQUIDITY_30S = -15;

/* On-chain */

const LARGE_SELL_SOL = 0.5;

const ONCHAIN_PAIR_WINDOW_MS = 350;

/* =========================================================
   TELEGRAM
========================================================= */

const bot = new Telegraf(BOT_TOKEN);

/* =========================================================
   DONNEES
========================================================= */

const DATA_DIR =
  fs.existsSync("/data")
    ? "/data"
    : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const TRADE_FILE =
  path.join(DATA_DIR, "trade_history.json");

const CRASH_FILE =
  path.join(DATA_DIR, "crash_reports.json");

const MARKET_FILE =
  path.join(DATA_DIR, "market_history.jsonl");

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.log("Erreur lecture JSON :", error.message);
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2)
    );
  } catch (error) {
    console.log("Erreur écriture JSON :", error.message);
  }
}

function appendJsonLine(file, data) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(data) + "\n"
    );
  } catch (error) {
    console.log("Erreur écriture historique :", error.message);
  }
}

/* =========================================================
   ETAT GLOBAL
========================================================= */

let running = false;

let tokenMint = null;

let sessionStart = null;

let sessionTimer = null;

let marketTimer = null;

let ws = null;

let stopReason = null;

let tickBusy = false;

let currentPosition = null;

let cyclesCompleted = 0;

let sessionProfit = 0;

let observationUntil = 0;

let noNewBuyUntil = 0;

let lastCrashReport = null;

let marketHistory = [];

let poolInfo = null;

let heliusConnected = false;

let wsSubscriptionIds = {
  base: null,
  quote: null,
  pool: null,
};

let onchainState = {
  lastBase: null,
  lastQuote: null,

  pendingBase: null,
  pendingQuote: null,

  lastEvent: null,
};

/* =========================================================
   UTILITAIRES
========================================================= */

function now() {
  return Date.now();
}

function shortMint(mint) {
  if (!mint) return "N/A";

  return (
    mint.slice(0, 8) +
    "..." +
    mint.slice(-6)
  );
}

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pct(current, previous) {
  if (
    previous === null ||
    previous === undefined ||
    previous === 0
  ) {
    return 0;
  }

  return ((current - previous) / previous) * 100;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "N/A";

  return `$${value.toFixed(4)}`;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "N/A";

  return value.toFixed(10);
}

async function telegram(text) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (error) {
    console.log(
      "Erreur Telegram :",
      error.message
    );
  }
}

/* =========================================================
   EXTRACTION DES PUBKEYS DU POOL
========================================================= */

function pubkeyFromBuffer(buffer, offset) {
  if (
    !buffer ||
    buffer.length < offset + 32
  ) {
    return null;
  }

  return new PublicKey(
    buffer.subarray(
      offset,
      offset + 32
    )
  ).toBase58();
}

/* =========================================================
   VIRTUAL QUOTE RESERVES
========================================================= */

function readI128LE(buffer, offset) {
  try {
    if (
      !buffer ||
      buffer.length < offset + 16
    ) {
      return 0;
    }

    const low =
      buffer.readBigUInt64LE(offset);

    const high =
      buffer.readBigInt64LE(offset + 8);

    const value =
      high * 18446744073709551616n +
      BigInt(low);

    return Number(value);
  } catch (error) {
    return 0;
  }
}

/* =========================================================
   PARSING POOL
========================================================= */

function parsePoolAccount(address, data) {
  const buffer = Buffer.from(data);

  const baseMint =
    pubkeyFromBuffer(
      buffer,
      POOL_BASE_MINT_OFFSET
    );

  const quoteMint =
    pubkeyFromBuffer(
      buffer,
      POOL_QUOTE_MINT_OFFSET
    );

  const baseVault =
    pubkeyFromBuffer(
      buffer,
      POOL_BASE_VAULT_OFFSET
    );

  const quoteVault =
    pubkeyFromBuffer(
      buffer,
      POOL_QUOTE_VAULT_OFFSET
    );

  const virtualQuote =
    readI128LE(
      buffer,
      POOL_VIRTUAL_QUOTE_OFFSET
    );

  return {
    pool: address,
    dataLength: buffer.length,
    baseMint,
    quoteMint,
    baseVault,
    quoteVault,
    virtualQuote,
  };
}

/* =========================================================
   RECHERCHE PUMPSWAP
========================================================= */

async function discoverPumpSwapPools(mint) {
  console.log("");
  console.log("========================================");
  console.log("🔎 RECHERCHE PUMPSWAP");
  console.log("Token :", mint);
  console.log("========================================");

  const accounts =
    await connection.getProgramAccounts(
      PUMPSWAP_PROGRAM_ID,
      {
        commitment: "processed",

        /*
          IMPORTANT :
          Aucun dataSize ici.

          Les Pool accounts PumpSwap peuvent
          désormais avoir des champs ajoutés à
          la fin du compte.
        */

        filters: [
          {
            memcmp: {
              offset: POOL_BASE_MINT_OFFSET,
              bytes: mint,
            },
          },
        ],
      }
    );

  console.log(
    "Comptes candidats trouvés :",
    accounts.length
  );

  const validPools = [];

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];

    try {
      const parsed = parsePoolAccount(
        account.pubkey.toBase58(),
        account.account.data
      );

      console.log("");
      console.log(
        `🔎 Pool candidat #${i + 1}`
      );

      console.log(
        "Pool :",
        parsed.pool
      );

      console.log(
        "Taille compte :",
        parsed.dataLength
      );

      console.log(
        "Base mint :",
        parsed.baseMint
      );

      console.log(
        "Quote mint :",
        parsed.quoteMint
      );

      if (
        parsed.baseMint !== mint
      ) {
        console.log(
          "❌ Rejet : base mint différent"
        );
        continue;
      }

      if (
        parsed.quoteMint !== WSOL_MINT
      ) {
        console.log(
          "❌ Rejet : quote mint différent de WSOL"
        );
        continue;
      }

      if (
        !parsed.baseVault ||
        !parsed.quoteVault
      ) {
        console.log(
          "❌ Rejet : vault manquant"
        );
        continue;
      }

      let baseBalance = 0;
      let quoteBalance = 0;

      try {
        const baseResult =
          await connection.getTokenAccountBalance(
            new PublicKey(parsed.baseVault),
            "processed"
          );

        baseBalance =
          Number(baseResult.value.amount) /
          Math.pow(
            10,
            baseResult.value.decimals
          );
      } catch (error) {
        console.log(
          "⚠️ Impossible de lire vault base :",
          error.message
        );
        continue;
      }

      try {
        const quoteResult =
          await connection.getTokenAccountBalance(
            new PublicKey(parsed.quoteVault),
            "processed"
          );

        quoteBalance =
          Number(quoteResult.value.amount) /
          Math.pow(
            10,
            quoteResult.value.decimals
          );
      } catch (error) {
        console.log(
          "⚠️ Impossible de lire vault quote :",
          error.message
        );
        continue;
      }

      const effectiveQuote =
        quoteBalance +
        parsed.virtualQuote / 1e9;

      console.log(
        "Vault base :",
        baseBalance
      );

      console.log(
        "Vault quote :",
        quoteBalance,
        "SOL"
      );

      console.log(
        "Quote effective :",
        effectiveQuote,
        "SOL"
      );

      if (
        !Number.isFinite(effectiveQuote) ||
        effectiveQuote <= 0
      ) {
        console.log(
          "❌ Rejet : réserve SOL invalide"
        );
        continue;
      }

      console.log(
        "✅ POOL PUMPSWAP SOL VALIDE"
      );

      validPools.push({
        ...parsed,

        baseBalance,
        quoteBalance,
        effectiveQuote,

        /*
          Pour comparer plusieurs pools,
          on utilise la réserve SOL effective.
        */
        scoreReserve: effectiveQuote,
      });
    } catch (error) {
      console.log(
        "⚠️ Erreur parsing pool :",
        error.message
      );
    }
  }

  validPools.sort(
    (a, b) =>
      b.scoreReserve -
      a.scoreReserve
  );

  console.log("");
  console.log(
    "Pools PumpSwap SOL valides :",
    validPools.length
  );

  return validPools;
}

/* =========================================================
   SELECTION DU POOL
========================================================= */

async function findBestPumpSwapPool(mint) {
  try {
    const pools =
      await discoverPumpSwapPools(mint);

    if (!pools.length) {
      return null;
    }

    const selected = pools[0];

    console.log("");
    console.log(
      "========================================"
    );

    console.log(
      "✅ POOL RETENU"
    );

    console.log(
      "Pool :",
      selected.pool
    );

    console.log(
      "Base vault :",
      selected.baseVault
    );

    console.log(
      "Quote vault :",
      selected.quoteVault
    );

    console.log(
      "Réserve SOL :",
      selected.effectiveQuote
    );

    console.log(
      "========================================"
    );

    return selected;
  } catch (error) {
    console.log(
      "❌ Erreur recherche PumpSwap :",
      error.message
    );

    return null;
  }
}

/* =========================================================
   DEXSCREENER
========================================================= */

async function getMarketData(mint) {
  const url =
    `https://api.dexscreener.com/latest/dex/tokens/${mint}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  const pairs =
    Array.isArray(json.pairs)
      ? json.pairs
      : [];

  const pumpPairs =
    pairs.filter(
      (pair) =>
        pair &&
        pair.dexId === "pump_amm" &&
        pair.baseToken &&
        pair.baseToken.address === mint
    );

  if (!pumpPairs.length) {
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

  const pair = pumpPairs[0];

  return {
    price: Number(pair.priceUsd || 0),

    liquidity:
      Number(
        pair.liquidity?.usd || 0
      ),

    pairAddress:
      pair.pairAddress || null,

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
  };
}

/* =========================================================
   HISTORIQUE
========================================================= */

function addMarketPoint(data) {
  const point = {
    timestamp: now(),

    price: data.price,

    liquidity: data.liquidity,

    pairAddress:
      data.pairAddress,

    volume24h:
      data.volume24h,

    buys5m:
      data.buys5m,

    sells5m:
      data.sells5m,
  };

  marketHistory.push(point);

  const cutoff =
    now() - 120000;

  marketHistory =
    marketHistory.filter(
      (item) =>
        item.timestamp >= cutoff
    );

  appendJsonLine(
    MARKET_FILE,
    {
      mint: tokenMint,
      ...point,
    }
  );
}

/* =========================================================
   HISTORIQUE MARKET
========================================================= */

function getPointAgo(ms) {
  const target =
    now() - ms;

  let best = null;

  for (
    let i = marketHistory.length - 1;
    i >= 0;
    i--
  ) {
    const point =
      marketHistory[i];

    if (
      point.timestamp <= target
    ) {
      best = point;
      break;
    }
  }

  return best;
}

/* =========================================================
   SCORE
========================================================= */

function calculateHealthScore(data) {
  let score = 100;

  const p10 =
    pct(
      data.price,
      getPointAgo(10000)?.price
    );

  const l10 =
    pct(
      data.liquidity,
      getPointAgo(10000)?.liquidity
    );

  const l30 =
    pct(
      data.liquidity,
      getPointAgo(30000)?.liquidity
    );

  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    score -= 40;
  } else if (
    data.liquidity <
    MIN_LIQUIDITY_USD * 2
  ) {
    score -= 10;
  }

  if (p10 <= -4) {
    score -= 20;
  }

  if (p10 <= -8) {
    score -= 20;
  }

  if (l10 <= -10) {
    score -= 20;
  }

  if (l10 <= -20) {
    score -= 20;
  }

  if (l30 <= -15) {
    score -= 20;
  }

  const buys =
    Number(data.buys5m || 0);

  const sells =
    Number(data.sells5m || 0);

  if (
    sells > buys * 1.5 &&
    sells > 20
  ) {
    score -= 10;
  }

  if (
    buys > sells * 1.5 &&
    buys > 20
  ) {
    score += 5;
  }

  return clamp(
    Math.round(score),
    0,
    100
  );
}

/* =========================================================
   CRASH
========================================================= */

function getCrashSignals(data) {
  const reasons = [];

  const p10 =
    pct(
      data.price,
      getPointAgo(10000)?.price
    );

  const l10 =
    pct(
      data.liquidity,
      getPointAgo(10000)?.liquidity
    );

  if (
    data.liquidity <=
    CRASH_MIN_LIQUIDITY
  ) {
    reasons.push(
      "liquidité quasi nulle"
    );
  }

  if (
    l10 <=
    CRASH_LIQUIDITY_10S
  ) {
    reasons.push(
      `liquidité ${l10.toFixed(2)}% / 10s`
    );
  }

  if (
    p10 <=
    CRASH_PRICE_10S
  ) {
    reasons.push(
      `prix ${p10.toFixed(2)}% / 10s`
    );
  }

  return {
    crash: reasons.length > 0,
    reasons,
    p10,
    l10,
  };
}

/* =========================================================
   FILTRE D'ENTREE
========================================================= */

function entryCheck(data) {
  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    return {
      ok: false,
      reason:
        `liquidité trop faible (${formatUsd(data.liquidity)})`,
    };
  }

  const p10 =
    pct(
      data.price,
      getPointAgo(10000)?.price
    );

  const l10 =
    pct(
      data.liquidity,
      getPointAgo(10000)?.liquidity
    );

  const l30 =
    pct(
      data.liquidity,
      getPointAgo(30000)?.liquidity
    );

  if (p10 <= ENTRY_PRICE_10S) {
    return {
      ok: false,
      reason:
        `prix ${p10.toFixed(2)}% / 10s`,
    };
  }

  if (l10 <= ENTRY_LIQUIDITY_10S) {
    return {
      ok: false,
      reason:
        `liquidité ${l10.toFixed(2)}% / 10s`,
    };
  }

  if (l30 <= ENTRY_LIQUIDITY_30S) {
    return {
      ok: false,
      reason:
        `liquidité ${l30.toFixed(2)}% / 30s`,
    };
  }

  const score =
    calculateHealthScore(data);

  if (
    score <
    MIN_HEALTH_SCORE
  ) {
    return {
      ok: false,
      reason:
        `score ${score}/100`,
    };
  }

  return {
    ok: true,
    reason: "OK",
  };
}

/* =========================================================
   CONFIRMATIONS
========================================================= */

function hasEnoughHistory() {
  return marketHistory.length >= 8;
}

function healthyConfirmation() {
  if (!hasEnoughHistory()) {
    return 0;
  }

  let count = 0;

  const recent =
    marketHistory.slice(-REQUIRED_CONFIRMATIONS);

  for (const point of recent) {
    const score =
      calculateHealthScore(point);

    if (
      score >=
      MIN_HEALTH_SCORE
    ) {
      count++;
    }
  }

  return count;
}

/* =========================================================
   ACCELERATION
========================================================= */

function accelerationLevel(data) {
  const p5 =
    pct(
      data.price,
      getPointAgo(5000)?.price
    );

  const p10 =
    pct(
      data.price,
      getPointAgo(10000)?.price
    );

  const l10 =
    pct(
      data.liquidity,
      getPointAgo(10000)?.liquidity
    );

  const reasons = [];

  /*
    On s'intéresse surtout ici à une accélération
    négative rapide.
  */

  if (p5 <= -10) {
    reasons.push(
      `prix ${p5.toFixed(2)}% / 5s`
    );
  }

  if (p10 <= -15) {
    reasons.push(
      `prix ${p10.toFixed(2)}% / 10s`
    );
  }

  if (l10 <= -20) {
    reasons.push(
      `liquidité ${l10.toFixed(2)}% / 10s`
    );
  }

  let level = "NORMAL";

  if (reasons.length >= 2) {
    level = "CRITIQUE";
  } else if (reasons.length === 1) {
    level = "ALERTE";
  }

  return {
    level,
    p5,
    p10,
    l10,
    reasons,
  };
}

/* =========================================================
   SAUVEGARDE TRADE
========================================================= */

function saveTrade(trade) {
  const history =
    readJson(
      TRADE_FILE,
      []
    );

  history.push(trade);

  writeJson(
    TRADE_FILE,
    history
  );
}

/* =========================================================
   ACHAT SIMULE
========================================================= */

async function simulateBuy(data) {
  if (currentPosition) {
    return;
  }

  if (
    now() <
    observationUntil
  ) {
    return;
  }

  if (
    now() >=
    noNewBuyUntil
  ) {
    return;
  }

  const check =
    entryCheck(data);

  if (!check.ok) {
    return;
  }

  const confirmations =
    healthyConfirmation();

  if (
    confirmations <
    REQUIRED_CONFIRMATIONS
  ) {
    return;
  }

  if (
    !poolInfo
  ) {
    return;
  }

  const tokens =
    CAPITAL_USD /
    data.price;

  const targetPrice =
    data.price *
    (1 + TARGET_GAIN);

  currentPosition = {
    cycle:
      cyclesCompleted + 1,

    entryPrice:
      data.price,

    tokens,

    capital:
      CAPITAL_USD,

    targetPrice,

    entryLiquidity:
      data.liquidity,

    entryTimestamp:
      now(),
  };

  console.log("");
  console.log(
    "🟢 ACHAT TEST V5.5"
  );

  console.log(
    "Cycle :",
    currentPosition.cycle
  );

  console.log(
    "Token :",
    tokenMint
  );

  console.log(
    "Mise fixe :",
    formatUsd(CAPITAL_USD)
  );

  console.log(
    "Prix :",
    formatPrice(data.price)
  );

  console.log(
    "Tokens :",
    tokens.toFixed(8)
  );

  console.log(
    "Objectif :",
    `${(TARGET_GAIN * 100).toFixed(2)}%`
  );

  console.log(
    "Prix cible :",
    formatPrice(targetPrice)
  );

  console.log(
    "Liquidité :",
    formatUsd(data.liquidity)
  );

  console.log(
    "Score :",
    calculateHealthScore(data) +
      "/100"
  );

  console.log(
    "Confirmation :",
    `${confirmations}/${REQUIRED_CONFIRMATIONS}`
  );

  console.log(
    "Pool PumpSwap :",
    poolInfo.pool
  );

  await telegram(
`🟢 ACHAT TEST V5.5

Token :
${tokenMint}

Mise fixe :
$${CAPITAL_USD.toFixed(4)}

Prix :
${formatPrice(data.price)}

Tokens :
${tokens.toFixed(8)}

🎯 Objectif :
+${(TARGET_GAIN * 100).toFixed(2)}%

Prix cible :
${formatPrice(targetPrice)}

💧 Liquidité :
${formatUsd(data.liquidity)}

🧠 Score :
${calculateHealthScore(data)}/100

🛡️ Confirmation :
${confirmations}/${REQUIRED_CONFIRMATIONS}

🔗 Pool PumpSwap :
${poolInfo.pool}

🧪 Simulation uniquement.`
  );
}

/* =========================================================
   VENTE OBJECTIF
========================================================= */

async function simulateTargetSell(data) {
  if (!currentPosition) {
    return;
  }

  if (
    data.price <
    currentPosition.targetPrice
  ) {
    return;
  }

  /*
    Vente exactement au prix cible.
    Cela évite de surestimer le gain à cause
    du polling de 2 secondes.
  */

  const exitPrice =
    currentPosition.targetPrice;

  const amount =
    currentPosition.tokens *
    exitPrice;

  const profit =
    amount -
    currentPosition.capital;

  const cycle =
    currentPosition.cycle;

  cyclesCompleted++;

  sessionProfit += profit;

  saveTrade({
    type: "TARGET_SELL",

    timestamp:
      new Date().toISOString(),

    mint:
      tokenMint,

    cycle,

    entryPrice:
      currentPosition.entryPrice,

    exitPrice,

    capital:
      currentPosition.capital,

    amount,

    profit,

    sessionProfit,

    pool:
      poolInfo?.pool || null,
  });

  console.log("");
  console.log(
    "🔴 VENTE TEST V5.5"
  );

  console.log(
    "Cycle :",
    cycle
  );

  console.log(
    "Prix de vente :",
    formatPrice(exitPrice)
  );

  console.log(
    "Montant simulé :",
    formatUsd(amount)
  );

  console.log(
    "Résultat :",
    `+${((profit / CAPITAL_USD) * 100).toFixed(2)}%`
  );

  console.log(
    "Bénéfice :",
    `+$${profit.toFixed(4)}`
  );

  console.log(
    "Bénéfices cumulés :",
    `+$${sessionProfit.toFixed(4)}`
  );

  currentPosition = null;

  observationUntil =
    now() +
    OBSERVATION_AFTER_SELL_MS;

  await telegram(
`🔴 VENTE TEST V5.5

Cycle :
#${cycle}

Token :
${tokenMint}

Prix :
${formatPrice(exitPrice)}

Montant simulé :
$${amount.toFixed(4)}

Résultat :
+${((profit / CAPITAL_USD) * 100).toFixed(2)}%

Bénéfice :
+$${profit.toFixed(4)}

💰 Bénéfices cumulés :
+$${sessionProfit.toFixed(4)}

🛡️ NOUVELLE PHASE DE SÉCURITÉ

⏳ Observation :
30 secondes

❌ Aucun rachat immédiat.

🧪 Simulation uniquement.`
  );
}

/* =========================================================
   VENTE SECURITE 45 MIN
========================================================= */

async function forceSessionExit(data) {
  if (!currentPosition) {
    return;
  }

  const position =
    currentPosition;

  const exitPrice =
    Number(data.price);

  const amount =
    position.tokens *
    exitPrice;

  const profit =
    amount -
    position.capital;

  cyclesCompleted++;

  sessionProfit += profit;

  saveTrade({
    type: "SESSION_LIMIT",

    timestamp:
      new Date().toISOString(),

    mint:
      tokenMint,

    cycle:
      position.cycle,

    entryPrice:
      position.entryPrice,

    exitPrice,

    capital:
      position.capital,

    amount,

    profit,

    sessionProfit,

    pool:
      poolInfo?.pool || null,
  });

  console.log("");
  console.log(
    "🛑 SORTIE SECURITE 45 MIN"
  );

  console.log(
    "Cycle :",
    position.cycle
  );

  console.log(
    "Prix entrée :",
    formatPrice(
      position.entryPrice
    )
  );

  console.log(
    "Prix sortie :",
    formatPrice(exitPrice)
  );

  console.log(
    "Résultat :",
    `${((profit / CAPITAL_USD) * 100).toFixed(2)}%`
  );

  console.log(
    "Bénéfice/perte simulé :",
    `${profit >= 0 ? "+" : ""}$${profit.toFixed(4)}`
  );

  currentPosition = null;

  await telegram(
`🛑 SORTIE SECURITE 45 MIN

Token :
${tokenMint}

Cycle :
#${position.cycle}

Prix entrée :
${formatPrice(position.entryPrice)}

Prix sortie :
${formatPrice(exitPrice)}

Résultat :
${((profit / CAPITAL_USD) * 100).toFixed(2)}%

Résultat simulé :
${profit >= 0 ? "+" : ""}$${profit.toFixed(4)}

💰 Résultat session :
${sessionProfit >= 0 ? "+" : ""}$${sessionProfit.toFixed(4)}

⛔ Session arrêtée.

🧪 Simulation uniquement.`
  );
}

/* =========================================================
   CRASH REPORT
========================================================= */

async function triggerCrash(data, crash) {
  if (!running) {
    return;
  }

  stopReason =
    "CRASH";

  const report = {
    id:
      `crash_${Date.now()}`,

    timestamp:
      new Date().toISOString(),

    sessionStart:
      sessionStart
        ? new Date(sessionStart).toISOString()
        : null,

    mint:
      tokenMint,

    cyclesCompleted,

    sessionProfit,

    crashMarket: {
      price:
        data.price,

      liquidity:
        data.liquidity,

      priceChange10s:
        crash.p10,

      liquidityChange10s:
        crash.l10,

      score:
        calculateHealthScore(data),
    },

    acceleration:
      accelerationLevel(data),

    reasons:
      crash.reasons,

    openPosition:
      currentPosition,

    pool:
      poolInfo,
  };

  lastCrashReport =
    report;

  const reports =
    readJson(
      CRASH_FILE,
      []
    );

  reports.push(report);

  writeJson(
    CRASH_FILE,
    reports
  );

  console.log("");
  console.log(
    "🚨 STOP CRASH - MODE TEST V5.5"
  );

  console.log(
    "Token :",
    tokenMint
  );

  console.log(
    "Prix :",
    formatPrice(data.price)
  );

  console.log(
    "Variation prix ~10s :",
    `${crash.p10.toFixed(2)}%`
  );

  console.log(
    "Liquidité :",
    formatUsd(data.liquidity)
  );

  console.log(
    "Variation liquidité ~10s :",
    `${crash.l10.toFixed(2)}%`
  );

  console.log(
    "Score :",
    calculateHealthScore(data) +
      "/100"
  );

  console.log(
    "Signaux :",
    crash.reasons
  );

  if (currentPosition) {
    console.log(
      "⚠️ Position restante :",
      currentPosition.tokens
    );

    console.log(
      "⚠️ Prix de sortie NON considéré fiable."
    );

    console.log(
      "⚠️ Aucun bénéfice fictif ajouté."
    );
  }

  await telegram(
`🚨 STOP CRASH - MODE TEST V5.5

Token :
${tokenMint}

Prix :
${formatPrice(data.price)}

Variation prix ~10s :
${crash.p10.toFixed(2)}%

Liquidité :
${formatUsd(data.liquidity)}

Variation liquidité ~10s :
${crash.l10.toFixed(2)}%

🧠 Score :
${calculateHealthScore(data)}/100

⚠️ Signaux :
${crash.reasons.map(
  (r) => `• ${r}`
).join("\n")}

${
  currentPosition
    ? `⚠️ Position restante :
${currentPosition.tokens}

⚠️ Prix de sortie NON considéré fiable.
⚠️ Aucun bénéfice fictif ajouté.`
    : "Aucune position ouverte."
}

⛔ NOUVEAU CYCLE BLOQUÉ
⛔ RADAR ARRÊTÉ

Cycles :
${cyclesCompleted}

💰 Bénéfices simulés :
$${sessionProfit.toFixed(4)}

🧪 Simulation uniquement.`
  );

  stopSession();
}

/* =========================================================
   ON-CHAIN : CONNEXION
========================================================= */

function startOnchainMonitoring() {
  if (!poolInfo) {
    return;
  }

  try {
    ws =
      new WebSocket(WSS_URL);

    ws.on("open", () => {
      heliusConnected = true;

      console.log(
        "⛓️ Helius WebSocket connecté"
      );

      subscribeAccount(
        "base",
        poolInfo.baseVault
      );

      subscribeAccount(
        "quote",
        poolInfo.quoteVault
      );

      subscribeAccount(
        "pool",
        poolInfo.pool
      );
    });

    ws.on("message", (raw) => {
      try {
        const message =
          JSON.parse(
            raw.toString()
          );

        handleWebSocketMessage(
          message
        );
      } catch (error) {
        console.log(
          "Erreur WS message :",
          error.message
        );
      }
    });

    ws.on("close", () => {
      heliusConnected = false;

      console.log(
        "⛓️ Helius WebSocket fermé"
      );
    });

    ws.on("error", (error) => {
      heliusConnected = false;

      console.log(
        "⚠️ Helius WebSocket :",
        error.message
      );
    });
  } catch (error) {
    console.log(
      "❌ Erreur WebSocket :",
      error.message
    );
  }
}

/* =========================================================
   SUBSCRIBE ACCOUNT
========================================================= */

function subscribeAccount(type, address) {
  if (
    !ws ||
    ws.readyState !== WebSocket.OPEN
  ) {
    return;
  }

  const request = {
    jsonrpc: "2.0",

    id:
      Date.now() +
      Math.floor(
        Math.random() * 10000
      ),

    method:
      "accountSubscribe",

    params: [
      address,
      {
        encoding: "base64",
        commitment: "processed",
      },
    ],
  };

  /*
    On conserve temporairement le type
    dans une file. Le vrai subscription ID
    est reçu ensuite par handleWebSocketMessage.
  */

  request.__type = type;

  ws.send(
    JSON.stringify(request)
  );

  pendingSubscriptionTypes.push(
    type
  );
}

const pendingSubscriptionTypes = [];

/* =========================================================
   WEBSOCKET MESSAGE
========================================================= */

function handleWebSocketMessage(message) {
  /*
    Réponse à accountSubscribe
  */

  if (
    message.id &&
    message.result !== undefined
  ) {
    const type =
      pendingSubscriptionTypes.shift();

    if (type) {
      wsSubscriptionIds[type] =
        message.result;

      console.log(
        `⛓️ Subscription ${type} :`,
        message.result
      );
    }

    return;
  }

  if (
    message.method !==
    "accountNotification"
  ) {
    return;
  }

  const subscription =
    message.params?.subscription;

  const value =
    message.params?.result?.value;

  const context =
    message.params?.result?.context;

  if (
    subscription === undefined ||
    !value
  ) {
    return;
  }

  const data =
    value.data;

  if (
    !Array.isArray(data) ||
    data.length < 1
  ) {
    return;
  }

  const raw =
    Buffer.from(
      data[0],
      "base64"
    );

  const lamports =
    Number(value.lamports || 0);

  const slot =
    Number(context?.slot || 0);

  let type = null;

  if (
    subscription ===
    wsSubscriptionIds.base
  ) {
    type = "base";
  }

  if (
    subscription ===
    wsSubscriptionIds.quote
  ) {
    type = "quote";
  }

  if (
    subscription ===
    wsSubscriptionIds.pool
  ) {
    type = "pool";
  }

  if (type === "base") {
    processBaseVaultUpdate(
      raw,
      slot
    );
  }

  if (type === "quote") {
    processQuoteVaultUpdate(
      raw,
      slot
    );
  }

  if (type === "pool") {
    processPoolUpdate(
      raw,
      slot
    );
  }

  /*
    lamports lu uniquement pour éviter
    que le champ soit totalement ignoré.
  */

  void lamports;
}

/* =========================================================
   VAULT TOKEN BALANCE
========================================================= */

function readTokenAmountFromAccountData(raw) {
  /*
    SPL Token account layout :

    amount u64 à offset 64
  */

  try {
    if (
      !raw ||
      raw.length < 72
    ) {
      return null;
    }

    return Number(
      raw.readBigUInt64LE(64)
    );
  } catch (error) {
    return null;
  }
}

/* =========================================================
   BASE VAULT
========================================================= */

function processBaseVaultUpdate(
  raw,
  slot
) {
  const amount =
    readTokenAmountFromAccountData(
      raw
    );

  if (
    amount === null
  ) {
    return;
  }

  onchainState.lastBase = {
    amount,
    slot,
    timestamp: now(),
  };

  onchainState.pendingBase =
    onchainState.lastBase;

  tryPairOnchainChanges();
}

/* =========================================================
   QUOTE VAULT
========================================================= */

function processQuoteVaultUpdate(
  raw,
  slot
) {
  const amount =
    readTokenAmountFromAccountData(
      raw
    );

  if (
    amount === null
  ) {
    return;
  }

  onchainState.lastQuote = {
    amount,
    slot,
    timestamp: now(),
  };

  onchainState.pendingQuote =
    onchainState.lastQuote;

  tryPairOnchainChanges();
}

/* =========================================================
   POOL UPDATE
========================================================= */

function processPoolUpdate(
  raw,
  slot
) {
  if (!raw) {
    return;
  }

  /*
    Le pool peut être mis à jour avec les champs
    ajoutés à la fin.

    Pour V5.5, on utilise surtout cette notification
    comme confirmation qu'un changement du compte Pool
    a eu lieu.
  */

  if (
    raw.length >=
    POOL_VIRTUAL_QUOTE_OFFSET + 16
  ) {
    const virtualQuote =
      readI128LE(
        raw,
        POOL_VIRTUAL_QUOTE_OFFSET
      );

    if (
      poolInfo
    ) {
      poolInfo.virtualQuote =
        virtualQuote;
    }
  }

  void slot;
}

/* =========================================================
   PAIRING ON-CHAIN
========================================================= */

function tryPairOnchainChanges() {
  const base =
    onchainState.pendingBase;

  const quote =
    onchainState.pendingQuote;

  if (
    !base ||
    !quote
  ) {
    return;
  }

  const timeDiff =
    Math.abs(
      base.timestamp -
      quote.timestamp
    );

  if (
    timeDiff >
    ONCHAIN_PAIR_WINDOW_MS
  ) {
    return;
  }

  const previousBase =
    onchainState.lastEvent?.baseAmount;

  const previousQuote =
    onchainState.lastEvent?.quoteAmount;

  if (
    previousBase === undefined ||
    previousQuote === undefined
  ) {
    onchainState.lastEvent = {
      baseAmount:
        base.amount,

      quoteAmount:
        quote.amount,

      slot:
        Math.max(
          base.slot,
          quote.slot
        ),

      timestamp:
        now(),
    };

    return;
  }

  const baseDelta =
    base.amount -
    previousBase;

  const quoteDelta =
    quote.amount -
    previousQuote;

  /*
    Le vault base contient le token.
    Le vault quote contient le SOL.

    SELL token :
      base diminue
      quote augmente

    BUY token :
      base augmente
      quote diminue

    RETRAIT :
      base diminue
      quote diminue

    AJOUT :
      base augmente
      quote augmente
  */

  let type =
    "UNKNOWN";

  if (
    baseDelta < 0 &&
    quoteDelta > 0
  ) {
    type = "SELL";
  } else if (
    baseDelta > 0 &&
    quoteDelta < 0
  ) {
    type = "BUY";
  } else if (
    baseDelta < 0 &&
    quoteDelta < 0
  ) {
    type = "WITHDRAWAL";
  } else if (
    baseDelta > 0 &&
    quoteDelta > 0
  ) {
    type = "ADD_LIQUIDITY";
  }

  const quoteSol =
    Math.abs(
      quoteDelta
    ) / 1e9;

  if (
    type !== "UNKNOWN" &&
    (
      Math.abs(baseDelta) > 0 ||
      Math.abs(quoteDelta) > 0
    )
  ) {
    console.log("");
    console.log(
      "⛓️ EVENT PUMPSWAP"
    );

    console.log(
      "Type :",
      type
    );

    console.log(
      "Base delta :",
      baseDelta
    );

    console.log(
      "Quote delta :",
      quoteSol.toFixed(6),
      "SOL"
    );

    console.log(
      "Slot :",
      Math.max(
        base.slot,
        quote.slot
      )
    );
  }

  /*
    Protection sur retrait de liquidité.
  */

  if (
    running &&
    type === "WITHDRAWAL"
  ) {
    triggerOnchainProtection(
      type,
      quoteSol
    );
  }

  /*
    Grosse vente.
  */

  if (
    running &&
    type === "SELL" &&
    quoteSol >= LARGE_SELL_SOL
  ) {
    triggerOnchainProtection(
      type,
      quoteSol
    );
  }

  onchainState.lastEvent = {
    baseAmount:
      base.amount,

    quoteAmount:
      quote.amount,

    slot:
      Math.max(
        base.slot,
        quote.slot
      ),

    timestamp:
      now(),
  };

  onchainState.pendingBase =
    null;

  onchainState.pendingQuote =
    null;
}

/* =========================================================
   PROTECTION ON-CHAIN
========================================================= */

async function triggerOnchainProtection(
  type,
  quoteSol
) {
  if (!running) {
    return;
  }

  if (
    stopReason
  ) {
    return;
  }

  stopReason =
    "ONCHAIN_RISK";

  const message =
`🚨 PROTECTION ON-CHAIN V5.5

Token :
${tokenMint}

Type détecté :
${type}

Variation quote :
${quoteSol.toFixed(6)} SOL

${
  currentPosition
    ? `⚠️ Position simulée ouverte :
Cycle #${currentPosition.cycle}

⚠️ Aucune vente fictive enregistrée.
Le prix de sortie n'est pas considéré fiable.`
    : "Aucune position ouverte."
}

⛔ NOUVEAU CYCLE BLOQUÉ
⛔ SURVEILLANCE ARRÊTÉE

🧪 Simulation uniquement.`;

  console.log(message);

  await telegram(message);

  stopSession();
}

/* =========================================================
   MARKET TICK
========================================================= */

async function marketTick() {
  if (!running) {
    return;
  }

  if (tickBusy) {
    return;
  }

  tickBusy = true;

  try {
    const data =
      await getMarketData(
        tokenMint
      );

    if (!data) {
      console.log(
        "⚠️ Aucun marché PumpSwap DexScreener"
      );

      return;
    }

    if (
      !Number.isFinite(data.price) ||
      data.price <= 0
    ) {
      return;
    }

    addMarketPoint(data);

    const crash =
      getCrashSignals(data);

    if (
      crash.crash
    ) {
      await triggerCrash(
        data,
        crash
      );

      return;
    }

    /*
      Si position ouverte :
      priorité à la vente objectif.
    */

    if (currentPosition) {
      await simulateTargetSell(
        data
      );

      return;
    }

    /*
      Observation après vente.
    */

    if (
      now() <
      observationUntil
    ) {
      return;
    }

    /*
      Plus aucun nouvel achat après 43 minutes.
    */

    if (
      now() >=
      noNewBuyUntil
    ) {
      return;
    }

    await simulateBuy(
      data
    );
  } catch (error) {
    console.log(
      "⚠️ Erreur market tick :",
      error.message
    );
  } finally {
    tickBusy = false;
  }
}

/* =========================================================
   SESSION 45 MIN
========================================================= */

async function sessionLimitReached() {
  if (!running) {
    return;
  }

  console.log("");
  console.log(
    "⏱️ LIMITE SESSION 45 MIN"
  );

  /*
    Règle importante :
    s'il y a une position ouverte,
    on tente une sortie de sécurité simulée
    AVANT d'arrêter le bot.
  */

  if (currentPosition) {
    try {
      const data =
        await getMarketData(
          tokenMint
        );

      if (
        data &&
        Number.isFinite(data.price) &&
        data.price > 0
      ) {
        await forceSessionExit(
          data
        );
      } else {
        console.log(
          "⚠️ Prix indisponible à 45 min."
        );

        await telegram(
`⚠️ LIMITE 45 MIN

Token :
${tokenMint}

Une position était ouverte mais aucun prix fiable n'a été obtenu.

⚠️ Aucune liquidation fictive enregistrée.

⛔ Session arrêtée.`
        );
      }
    } catch (error) {
      console.log(
        "Erreur sortie 45 min :",
        error.message
      );

      await telegram(
`⚠️ LIMITE 45 MIN

Token :
${tokenMint}

Impossible d'obtenir un prix de sortie fiable.

⚠️ Aucun bénéfice fictif ajouté.

⛔ Session arrêtée.`
      );
    }
  }

  if (running) {
    stopReason =
      "SESSION_LIMIT";

    await telegram(
`⏱️ SESSION V5.5 TERMINÉE

Token :
${tokenMint}

Cycles terminés :
${cyclesCompleted}

💰 Résultat session :
${sessionProfit >= 0 ? "+" : ""}$${sessionProfit.toFixed(4)}

⛔ Arrêt après 45 minutes.

🧪 Simulation uniquement.`
    );

    stopSession();
  }
}

/* =========================================================
   DEMARRAGE
========================================================= */

async function startSession(mint) {
  if (running) {
    await telegram(
`⚠️ Une session est déjà en cours.

Token :
${tokenMint}

Utilise /stoptrade avant d'en lancer une autre.`
    );

    return;
  }

  try {
    tokenMint =
      new PublicKey(
        mint.trim()
      ).toBase58();
  } catch (error) {
    await telegram(
`❌ Adresse token invalide.

Token reçu :
${mint}`
    );

    return;
  }

  running = true;

  stopReason = null;

  sessionStart =
    now();

  cyclesCompleted = 0;

  sessionProfit = 0;

  currentPosition = null;

  observationUntil = 0;

  /*
    IMPORTANT :
    Le délai de 43 minutes commence
    au démarrage de la session.
  */

  noNewBuyUntil =
    sessionStart +
    NO_NEW_BUY_AFTER_MS;

  marketHistory = [];

  lastCrashReport = null;

  poolInfo = null;

  heliusConnected = false;

  onchainState = {
    lastBase: null,
    lastQuote: null,
    pendingBase: null,
    pendingQuote: null,
    lastEvent: null,
  };

  wsSubscriptionIds = {
    base: null,
    quote: null,
    pool: null,
  };

  console.log("");
  console.log(
    "========================================"
  );

  console.log(
    "🚀 V5.5 DÉMARRAGE"
  );

  console.log(
    "Token :",
    tokenMint
  );

  console.log(
    "Capital :",
    `$${CAPITAL_USD.toFixed(2)}`
  );

  console.log(
    "Objectif :",
    `${TARGET_GAIN * 100}%`
  );

  console.log(
    "========================================"
  );

  await telegram(
`🚀 V5.5 DÉMARRÉE

Token :
${tokenMint}

💵 Capital :
$${CAPITAL_USD.toFixed(2)}

🎯 Objectif :
+${TARGET_GAIN * 100}%

🔎 Recherche :
Pool PumpSwap directement sur Solana

⛓️ Surveillance :
Vault token + vault SOL

⏳ Observation après vente :
30 secondes

⏱️ Aucun nouvel achat après :
43 minutes

🛑 Limite session :
45 minutes

🧪 SIMULATION UNIQUEMENT

🔎 Recherche du pool en cours...`
  );

  /*
    Recherche pool AVANT démarrage complet.
  */

  poolInfo =
    await findBestPumpSwapPool(
      tokenMint
    );

  if (!poolInfo) {
    running = false;

    stopReason =
      "NO_PUMPSWAP_POOL";

    console.log(
      "❌ Aucun pool PumpSwap SOL valide trouvé."
    );

    await telegram(
`❌ V5.5 ARRÊTÉE

Token :
${tokenMint}

❌ Aucun pool PumpSwap SOL valide trouvé.

La surveillance on-chain n'est pas lancée.

🔎 V5.5 a recherché :
• base mint = token
• quote mint = WSOL
• vault token
• vault SOL

👉 Aucun pool correspondant n'a été accepté.`
    );

    return;
  }

  /*
    Démarrage on-chain.
  */

  startOnchainMonitoring();

  /*
    Premier tick après 1 seconde.
  */

  await sleep(1000);

  if (!running) {
    return;
  }

  await marketTick();

  marketTimer =
    setInterval(
      marketTick,
      MARKET_INTERVAL_MS
    );

  sessionTimer =
    setTimeout(
      sessionLimitReached,
      MAX_SESSION_MS
    );

  await telegram(
`✅ POOL PUMPSWAP CONFIRMÉ

Pool :
${poolInfo.pool}

Base vault :
${poolInfo.baseVault}

Quote vault :
${poolInfo.quoteVault}

💧 Réserve SOL :
${poolInfo.effectiveQuote.toFixed(4)} SOL

⛓️ Surveillance on-chain activée.

📊 DexScreener :
surveillance marché activée.

⏱️ Session maximale :
45 minutes`
  );
}

/* =========================================================
   ARRET
========================================================= */

function stopSession() {
  if (!running) {
    cleanup();
    return;
  }

  running = false;

  if (
    marketTimer
  ) {
    clearInterval(
      marketTimer
    );

    marketTimer = null;
  }

  if (
    sessionTimer
  ) {
    clearTimeout(
      sessionTimer
    );

    sessionTimer = null;
  }

  if (ws) {
    try {
      ws.close();
    } catch (error) {
      console.log(
        "Erreur fermeture WS :",
        error.message
      );
    }

    ws = null;
  }

  heliusConnected = false;

  console.log("");
  console.log(
    "⛔ RADAR ARRÊTÉ"
  );

  console.log(
    "Raison :",
    stopReason || "MANUAL"
  );

  console.log(
    "Cycles :",
    cyclesCompleted
  );

  console.log(
    "Bénéfices :",
    `$${sessionProfit.toFixed(4)}`
  );
}

function cleanup() {
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

  if (ws) {
    try {
      ws.close();
    } catch (_) {}

    ws = null;
  }

  running = false;
}

/* =========================================================
   COMMANDES TELEGRAM
========================================================= */

bot.command(
  "starttrade",
  async (ctx) => {
    const args =
      ctx.message.text
        .split(/\s+/)
        .slice(1);

    if (!args.length) {
      await ctx.reply(
`Utilisation :

/starttrade ADRESSE_DU_TOKEN

Exemple :

/starttrade DHfNd5dzCsy9oRTVBwi5tPG87edVRmevqfSH8jz7oNTR`
      );

      return;
    }

    await startSession(
      args[0]
    );
  }
);

bot.command(
  "stoptrade",
  async (ctx) => {
    if (!running) {
      await ctx.reply(
        "ℹ️ Aucune session en cours."
      );

      return;
    }

    stopReason =
      "MANUAL";

    stopSession();

    await ctx.reply(
`🛑 SESSION ARRÊTÉE

Token :
${tokenMint}

Cycles :
${cyclesCompleted}

💰 Bénéfices :
$${sessionProfit.toFixed(4)}

🧪 Simulation uniquement.`
    );
  }
);

bot.command(
  "status",
  async (ctx) => {
    if (!running) {
      await ctx.reply(
`ℹ️ Aucune session active.

Utilise :

/starttrade ADRESSE_TOKEN`
      );

      return;
    }

    const elapsed =
      now() -
      sessionStart;

    const minutes =
      Math.floor(
        elapsed / 60000
      );

    await ctx.reply(
`📊 STATUS V5.5

Token :
${tokenMint}

⏱️ Temps :
${minutes} min

Cycles :
${cyclesCompleted}

💰 Bénéfices :
$${sessionProfit.toFixed(4)}

📍 Position :
${
  currentPosition
    ? "OUVERTE"
    : "AUCUNE"
}

⛓️ Helius :
${
  heliusConnected
    ? "🟢 connecté"
    : "🔴 déconnecté"
}

🔗 Pool :
${
  poolInfo
    ? poolInfo.pool
    : "N/A"
}

⏱️ Nouvel achat :
${
  now() < noNewBuyUntil
    ? "autorisé"
    : "bloqué"
}

🧪 Simulation`
    );
  }
);

bot.command(
  "lastcrash",
  async (ctx) => {
    if (!lastCrashReport) {
      const reports =
        readJson(
          CRASH_FILE,
          []
        );

      if (
        reports.length
      ) {
        lastCrashReport =
          reports[
            reports.length - 1
          ];
      }
    }

    if (!lastCrashReport) {
      await ctx.reply(
        "ℹ️ Aucun crash enregistré."
      );

      return;
    }

    const r =
      lastCrashReport;

    await ctx.reply(
`🚨 DERNIER CRASH

Token :
${r.mint}

Date :
${r.timestamp}

Prix :
${formatPrice(
  r.crashMarket.price
)}

Variation prix :
${r.crashMarket.priceChange10s.toFixed(2)}%

Liquidité :
${formatUsd(
  r.crashMarket.liquidity
)}

Variation liquidité :
${r.crashMarket.liquidityChange10s.toFixed(2)}%

Score :
${r.crashMarket.score}/100

Signaux :
${r.reasons.join("\n")}

Cycles :
${r.cyclesCompleted}

Bénéfices :
$${r.sessionProfit.toFixed(4)}`
    );
  }
);

bot.command(
  "help",
  async (ctx) => {
    await ctx.reply(
`🤖 COMMANDES V5.5

/starttrade TOKEN
Lance une simulation.

/stoptrade
Arrête la session.

/status
Affiche l'état.

/lastcrash
Affiche le dernier crash.

/help
Affiche cette aide.

💵 Mise :
$10

🎯 Objectif :
+5%

⏳ Observation :
30 secondes

⏱️ Aucun nouvel achat :
après 43 minutes

🛑 Session maximale :
45 minutes

🧪 Aucune transaction réelle.`
    );
  }
);

/* =========================================================
   GESTION ERREURS BOT
========================================================= */

bot.catch((error) => {
  console.log(
    "❌ Erreur Telegram bot :",
    error.message
  );
});

/* =========================================================
   LANCEMENT
========================================================= */

(async () => {
  try {
    console.log(
      "🤖 Démarrage bot Telegram..."
    );

    await bot.launch();

    console.log(
      "✅ Bot Telegram opérationnel."
    );

    console.log(
      "V5.5 prête."
    );
  } catch (error) {
    console.error(
      "❌ Impossible de démarrer le bot :",
      error
    );

    process.exit(1);
  }
})();

/* =========================================================
   ARRET PROPRE
========================================================= */

process.once(
  "SIGINT",
  () => {
    cleanup();
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    cleanup();
    bot.stop("SIGTERM");
  }
);
