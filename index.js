"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const bs58 = require("bs58");
const BN = require("bn.js");

const {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");

const { Telegraf } = require("telegraf");

const {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
} = require("@pump-fun/pump-swap-sdk");

/* =========================================================
   CONFIGURATION
========================================================= */

const BOT_TOKEN = process.env.BOT_TOKEN || "";
const CHAT_ID = process.env.CHAT_ID || "";

const CRASH_GUARD_URL =
  process.env.CRASH_GUARD_URL || "";

const CRASH_GUARD_SECRET =
  process.env.CRASH_GUARD_SECRET || "";

const PORT =
  Number(process.env.PORT || 3000);

const REAL_TRADING =
  String(process.env.REAL_TRADING || "false").toLowerCase() === "true";

const FIXED_CAPITAL_EUR =
  Number(process.env.FIXED_CAPITAL_EUR || "0.10");

const BUY_SLIPPAGE_PERCENT =
  Number(process.env.BUY_SLIPPAGE_PERCENT || "1");

const SELL_SLIPPAGE_PERCENT =
  Number(process.env.SELL_SLIPPAGE_PERCENT || "2");

const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  "https://rpc.ankr.com/solana";

const MIN_SOL_RESERVE =
  Number(process.env.MIN_SOL_RESERVE || "0.001");

const MAX_DAILY_EUR =
  Number(process.env.MAX_DAILY_EUR || "1");

const TRADING_PRIVATE_KEY =
  process.env.TRADING_PRIVATE_KEY || "";

const EXPECTED_WALLET =
  "2vK4Th2R934xvwSrPnNu9c63W3QKq7KEF4zDQ3LQ2Gpy";

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN manquant");
  process.exit(1);
}

if (!CHAT_ID) {
  console.error("❌ CHAT_ID manquant");
  process.exit(1);
}

if (REAL_TRADING && !TRADING_PRIVATE_KEY) {
  console.error("❌ TRADING_PRIVATE_KEY manquante alors que REAL_TRADING=true");
  process.exit(1);
}

if (!Number.isFinite(FIXED_CAPITAL_EUR) || FIXED_CAPITAL_EUR <= 0) {
  console.error("❌ FIXED_CAPITAL_EUR invalide");
  process.exit(1);
}

if (
  !Number.isFinite(BUY_SLIPPAGE_PERCENT) ||
  BUY_SLIPPAGE_PERCENT < 0
) {
  console.error("❌ BUY_SLIPPAGE_PERCENT invalide");
  process.exit(1);
}

if (
  !Number.isFinite(SELL_SLIPPAGE_PERCENT) ||
  SELL_SLIPPAGE_PERCENT < 0
) {
  console.error("❌ SELL_SLIPPAGE_PERCENT invalide");
  process.exit(1);
}

/* =========================================================
   SOLANA WALLET
========================================================= */

function loadTradingKeypair() {
  if (!TRADING_PRIVATE_KEY) {
    return null;
  }

  let keypair;

  try {
    if (TRADING_PRIVATE_KEY.trim().startsWith("[")) {
      const arr = JSON.parse(TRADING_PRIVATE_KEY);

      if (!Array.isArray(arr)) {
        throw new Error("clé JSON invalide");
      }

      keypair = Keypair.fromSecretKey(
        Uint8Array.from(arr)
      );
    } else {
      const decoded = bs58.decode(
        TRADING_PRIVATE_KEY.trim()
      );

      keypair = Keypair.fromSecretKey(
        decoded
      );
    }
  } catch (error) {
    throw new Error(
      `Impossible de décoder TRADING_PRIVATE_KEY: ${error.message}`
    );
  }

  const derivedAddress =
    keypair.publicKey.toBase58();

  if (derivedAddress !== EXPECTED_WALLET) {
    throw new Error(
      `Le wallet dérivé de TRADING_PRIVATE_KEY est ${derivedAddress}, attendu ${EXPECTED_WALLET}`
    );
  }

  return keypair;
}

let tradingWallet = null;

try {
  tradingWallet = loadTradingKeypair();
} catch (error) {
  console.error("❌", error.message);
  process.exit(1);
}

const connection =
  new Connection(
    SOLANA_RPC_URL,
    "confirmed"
  );

const onlineAmmSdk =
  new OnlinePumpAmmSdk(connection);

/* =========================================================
   TELEGRAM
========================================================= */

const bot = new Telegraf(BOT_TOKEN);

/* =========================================================
   STRATEGIE V5.1
========================================================= */

const TARGET_GAIN_PERCENT = 5;

const POLL_INTERVAL_MS = 2000;

const HISTORY_WINDOW_MS = 120000;

const CRASH_REPORT_WINDOW_MS = 60000;

const OBSERVATION_AFTER_SELL_MS = 30000;

const MAX_TOKEN_SESSION_MS =
  45 * 60 * 1000;

const NO_NEW_BUY_AFTER_MS =
  43 * 60 * 1000;

const MIN_LIQUIDITY_USD = 3000;

const ENTRY_LIQUIDITY_DROP_10S = -10;
const ENTRY_LIQUIDITY_DROP_30S = -15;

const CRASH_LIQUIDITY_DROP_10S = -50;

const ENTRY_PRICE_DROP_10S = -4;
const CRASH_PRICE_DROP_10S = -20;

const ACCEL_PRICE_5S_WARNING = 7;
const ACCEL_PRICE_10S_WARNING = 10;

const ACCEL_PRICE_5S_EXTREME = 10;
const ACCEL_PRICE_10S_EXTREME = 15;

const ACCEL_LIQUIDITY_DROP = -5;

const REQUIRED_HEALTHY_CONFIRMATIONS = 4;

const MIN_HEALTH_SCORE_FOR_ENTRY = 80;

/* =========================================================
   ETAT V5.1
========================================================= */

let active = false;
let mint = null;

let pollTimer = null;

let observationUntil = 0;

let sessionStartTime = 0;

let position = null;

let cycleNumber = 0;

let sessionCycles = [];

let sessionProfit = 0;

let healthyConfirmations = 0;

let marketHistory = [];

let accelerationWarningActive = false;

let accelerationAlertSent = false;

/* =========================================================
   CRASH GUARD
========================================================= */

let crashGuardLevel = "NORMAL";

let crashGuardBuyBlocked = false;

let crashGuardLocked = false;

let crashGuardEmergencyExitDone = false;

let crashGuardEmergencyExitInProgress = false;

let crashGuardLastEventId = null;

let crashGuardArmed = false;

/* =========================================================
   REAL TRADING STATE
========================================================= */

let tradeInProgress = false;

let dailySpentEur = 0;

let dailySpentDate = "";

let eurUsdCache = null;
let eurUsdCacheAt = 0;

let solUsdCache = null;
let solUsdCacheAt = 0;

/* =========================================================
   DOSSIERS
========================================================= */

const DATA_DIR =
  fs.existsSync("/data")
    ? "/data"
    : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });
}

const MARKET_HISTORY_FILE =
  path.join(
    DATA_DIR,
    "market_history.jsonl"
  );

const TRADE_HISTORY_FILE =
  path.join(
    DATA_DIR,
    "trade_history.json"
  );

const CRASH_REPORTS_FILE =
  path.join(
    DATA_DIR,
    "crash_reports.json"
  );

const SUMMARY_FILE =
  path.join(
    DATA_DIR,
    "v51_summary.json"
  );

/* =========================================================
   UTILITAIRES
========================================================= */

function now() {
  return Date.now();
}

function round(value, decimals = 8) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function sleep(ms) {
  return new Promise(resolve =>
    setTimeout(resolve, ms)
  );
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(
      file,
      JSON.stringify(data, null, 2),
      "utf8"
    );
  } catch (error) {
    console.error(
      "Erreur écriture JSON:",
      error.message
    );
  }
}

function appendJsonLine(file, data) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(data) + "\n",
      "utf8"
    );
  } catch (error) {
    console.error(
      "Erreur écriture JSONL:",
      error.message
    );
  }
}

function loadTrades() {
  try {
    if (!fs.existsSync(TRADE_HISTORY_FILE)) {
      return [];
    }

    const content =
      fs.readFileSync(
        TRADE_HISTORY_FILE,
        "utf8"
      );

    if (!content.trim()) {
      return [];
    }

    return JSON.parse(content);
  } catch (error) {
    console.error(
      "Erreur lecture trade_history:",
      error.message
    );

    return [];
  }
}

function saveTrades(trades) {
  saveJson(
    TRADE_HISTORY_FILE,
    trades
  );
}

function addTrade(trade) {
  const trades = loadTrades();

  trades.push({
    ...trade,
    timestamp:
      trade.timestamp || new Date().toISOString(),
  });

  saveTrades(trades);
}

/* =========================================================
   TELEGRAM
========================================================= */

async function sendTelegram(message) {
  try {
    const response =
      await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json",
          },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: message,
            disable_web_page_preview: true,
          }),
        }
      );

    if (!response.ok) {
      const text =
        await response.text();

      console.error(
        "Telegram HTTP",
        response.status,
        text
      );
    }
  } catch (error) {
    console.error(
      "Erreur Telegram:",
      error.message
    );
  }
}

/* =========================================================
   DAILY LIMIT
========================================================= */

function resetDailyIfNeeded() {
  const today =
    new Date()
      .toISOString()
      .slice(0, 10);

  if (dailySpentDate !== today) {
    dailySpentDate = today;
    dailySpentEur = 0;
  }
}

function canSpendDaily(amountEur) {
  resetDailyIfNeeded();

  return (
    dailySpentEur + amountEur <=
    MAX_DAILY_EUR + 1e-9
  );
}

function registerDailySpend(amountEur) {
  resetDailyIfNeeded();

  dailySpentEur += amountEur;

  dailySpentEur =
    round(dailySpentEur, 6);
}

/* =========================================================
   PRIX SOL / EUR
========================================================= */

async function getSolUsdPrice() {
  if (
    solUsdCache &&
    now() - solUsdCacheAt < 30000
  ) {
    return solUsdCache;
  }

  const SOL_MINT =
    "So11111111111111111111111111111111111111112";

  const url =
    `https://api.dexscreener.com/tokens/v1/solana/${SOL_MINT}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `DexScreener SOL HTTP ${response.status}`
    );
  }

  const pairs =
    await response.json();

  if (!Array.isArray(pairs)) {
    throw new Error(
      "Réponse DexScreener SOL invalide"
    );
  }

  const validPairs =
    pairs
      .filter(pair => {
        if (!pair) return false;

        const chain =
          String(pair.chainId || "")
            .toLowerCase();

        if (chain !== "solana") {
          return false;
        }

        const base =
          pair.baseToken?.address;

        const quote =
          pair.quoteToken?.address;

        return (
          base === SOL_MINT ||
          quote === SOL_MINT
        );
      })
      .filter(pair => {
        const liquidity =
          Number(
            pair.liquidity?.usd || 0
          );

        const price =
          Number(
            pair.priceUsd || 0
          );

        return (
          liquidity > 0 &&
          price > 0
        );
      })
      .sort(
        (a, b) =>
          Number(
            b.liquidity?.usd || 0
          ) -
          Number(
            a.liquidity?.usd || 0
          )
      );

  if (!validPairs.length) {
    throw new Error(
      "Aucune paire SOL/USD valide trouvée"
    );
  }

  const price =
    Number(
      validPairs[0].priceUsd
    );

  solUsdCache = price;
  solUsdCacheAt = now();

  return price;
}

async function getEurUsdPrice() {
  if (
    eurUsdCache &&
    now() - eurUsdCacheAt < 300000
  ) {
    return eurUsdCache;
  }

  const response =
    await fetch(
      "https://api.frankfurter.app/latest?from=EUR&to=USD"
    );

  if (!response.ok) {
    throw new Error(
      `Frankfurter HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const rate =
    Number(
      data?.rates?.USD
    );

  if (
    !Number.isFinite(rate) ||
    rate <= 0
  ) {
    throw new Error(
      "Taux EUR/USD invalide"
    );
  }

  eurUsdCache = rate;
  eurUsdCacheAt = now();

  return rate;
}

async function getEurSolQuote() {
  const eurUsd =
    await getEurUsdPrice();

  const solUsd =
    await getSolUsdPrice();

  const eurUsdValue =
    FIXED_CAPITAL_EUR *
    eurUsd;

  const solAmount =
    eurUsdValue /
    solUsd;

  return {
    eur: FIXED_CAPITAL_EUR,
    usd: eurUsdValue,
    sol: solAmount,
    eurUsd,
    solUsd,
  };
}

/* =========================================================
   WALLET BALANCE
========================================================= */

async function getWalletSolBalance() {
  if (!tradingWallet) {
    throw new Error(
      "Wallet de trading non disponible"
    );
  }

  const lamports =
    await connection.getBalance(
      tradingWallet.publicKey,
      "confirmed"
    );

  return lamports / 1e9;
}

/* =========================================================
   TOKEN BALANCE
========================================================= */

async function getTokenBalanceRaw(tokenMint) {
  if (!tradingWallet) {
    throw new Error(
      "Wallet de trading non disponible"
    );
  }

  const mintPk =
    new PublicKey(tokenMint);

  const response =
    await connection.getParsedTokenAccountsByOwner(
      tradingWallet.publicKey,
      {
        mint: mintPk,
      },
      "confirmed"
    );

  let totalRaw = new BN(0);

  let decimals = null;

  for (
    const account of response.value
  ) {
    const info =
      account.account?.data?.parsed?.info;

    const tokenAmount =
      info?.tokenAmount;

    if (!tokenAmount) {
      continue;
    }

    const raw =
      new BN(
        String(
          tokenAmount.amount
        )
      );

    totalRaw =
      totalRaw.add(raw);

    if (
      decimals === null
    ) {
      decimals =
        Number(
          tokenAmount.decimals
        );
    }
  }

  return {
    raw: totalRaw,
    decimals:
      decimals === null
        ? 0
        : decimals,
  };
}

/* =========================================================
   MARKET DATA V5.1
========================================================= */

async function getMarketData(tokenMint) {
  const url =
    `https://api.dexscreener.com/token-pairs/v1/solana/${tokenMint}`;

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const pairs =
    await response.json();

  if (!Array.isArray(pairs)) {
    throw new Error(
      "DexScreener réponse invalide"
    );
  }

  const pumpSwapPairs =
    pairs
      .filter(pair =>
        String(pair?.dexId || "")
          .toLowerCase() ===
        "pumpswap"
      )
      .filter(pair =>
        Number(
          pair?.priceUsd || 0
        ) > 0
      )
      .sort(
        (a, b) =>
          Number(
            b?.liquidity?.usd || 0
          ) -
          Number(
            a?.liquidity?.usd || 0
          )
      );

  if (!pumpSwapPairs.length) {
    return null;
  }

  const pair =
    pumpSwapPairs[0];

  return {
    timestamp: now(),

    price:
      Number(pair.priceUsd || 0),

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

    baseToken:
      pair.baseToken?.address || null,

    quoteToken:
      pair.quoteToken?.address || null,

    pair,
  };
}

/* =========================================================
   MARKET HISTORY
========================================================= */

function addMarketHistory(data) {
  if (!data) {
    return;
  }

  marketHistory.push({
    timestamp: data.timestamp,
    price: data.price,
    liquidity: data.liquidity,
    volume24h: data.volume24h,
    buys5m: data.buys5m,
    sells5m: data.sells5m,
  });

  const cutoff =
    now() - HISTORY_WINDOW_MS;

  marketHistory =
    marketHistory.filter(
      item =>
        item.timestamp >= cutoff
    );

  appendJsonLine(
    MARKET_HISTORY_FILE,
    {
      mint,
      ...marketHistory[
        marketHistory.length - 1
      ],
    }
  );
}

function getHistoryAgo(ms) {
  const target =
    now() - ms;

  let selected = null;

  for (
    const item of marketHistory
  ) {
    if (
      item.timestamp <= target
    ) {
      selected = item;
    }
  }

  return selected;
}

function percentChange(current, old) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(old) ||
    old === 0
  ) {
    return null;
  }

  return (
    ((current - old) / old) *
    100
  );
}

/* =========================================================
   ACCELERATION
========================================================= */

function analyzeAcceleration(data) {
  const five =
    getHistoryAgo(5000);

  const ten =
    getHistoryAgo(10000);

  if (!five || !ten) {
    return {
      price5s: null,
      price10s: null,
      liquidity10s: null,
      warning: false,
      extreme: false,
    };
  }

  const price5s =
    percentChange(
      data.price,
      five.price
    );

  const price10s =
    percentChange(
      data.price,
      ten.price
    );

  const liquidity10s =
    percentChange(
      data.liquidity,
      ten.liquidity
    );

  const warning =
    (
      price5s !== null &&
      price5s <=
        -ACCEL_PRICE_5S_WARNING
    ) ||
    (
      price10s !== null &&
      price10s <=
        -ACCEL_PRICE_10S_WARNING
    ) ||
    (
      liquidity10s !== null &&
      liquidity10s <=
        ACCEL_LIQUIDITY_DROP
    );

  const extreme =
    (
      price5s !== null &&
      price5s <=
        -ACCEL_PRICE_5S_EXTREME
    ) ||
    (
      price10s !== null &&
      price10s <=
        -ACCEL_PRICE_10S_EXTREME
    );

  return {
    price5s,
    price10s,
    liquidity10s,
    warning,
    extreme,
  };
}

/* =========================================================
   HEALTH
========================================================= */

function calculateHealth(data) {
  const ten =
    getHistoryAgo(10000);

  const thirty =
    getHistoryAgo(30000);

  let score = 100;

  if (!ten || !thirty) {
    return {
      score,
      healthy: false,
      liquidityChange10s: null,
      liquidityChange30s: null,
      priceChange10s: null,
    };
  }

  const liquidityChange10s =
    percentChange(
      data.liquidity,
      ten.liquidity
    );

  const liquidityChange30s =
    percentChange(
      data.liquidity,
      thirty.liquidity
    );

  const priceChange10s =
    percentChange(
      data.price,
      ten.price
    );

  if (
    liquidityChange10s !== null &&
    liquidityChange10s <
      ENTRY_LIQUIDITY_DROP_10S
  ) {
    score -= 25;
  }

  if (
    liquidityChange30s !== null &&
    liquidityChange30s <
      ENTRY_LIQUIDITY_DROP_30S
  ) {
    score -= 30;
  }

  if (
    priceChange10s !== null &&
    priceChange10s <
      ENTRY_PRICE_DROP_10S
  ) {
    score -= 25;
  }

  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    score -= 30;
  }

  score =
    Math.max(
      0,
      Math.min(100, score)
    );

  return {
    score,
    healthy:
      score >=
      MIN_HEALTH_SCORE_FOR_ENTRY,

    liquidityChange10s,
    liquidityChange30s,
    priceChange10s,
  };
}

/* =========================================================
   LATEST VALID PRICE
========================================================= */

function getLatestValidMarketPrice() {
  for (
    let i =
      marketHistory.length - 1;
    i >= 0;
    i--
  ) {
    const price =
      Number(
        marketHistory[i]?.price
      );

    if (
      Number.isFinite(price) &&
      price > 0
    ) {
      return price;
    }
  }

  return null;
}

/* =========================================================
   CRASH GUARD HTTP
========================================================= */

async function crashGuardRequest(
  method,
  endpoint,
  body = null
) {
  if (!CRASH_GUARD_URL) {
    return null;
  }

  if (!CRASH_GUARD_SECRET) {
    throw new Error(
      "CRASH_GUARD_SECRET manquant"
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      15000
    );

  try {
    const response =
      await fetch(
        `${CRASH_GUARD_URL}${endpoint}`,
        {
          method,
          headers: {
            "content-type":
              "application/json",
            "x-crash-guard-secret":
              CRASH_GUARD_SECRET,
          },
          body:
            body === null
              ? undefined
              : JSON.stringify(body),
          signal:
            controller.signal,
        }
      );

    const text =
      await response.text();

    if (!response.ok) {
      throw new Error(
        `Crash Guard HTTP ${response.status}: ${text}`
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function armCrashGuard(tokenMint) {
  if (!CRASH_GUARD_URL) {
    crashGuardArmed = false;
    return;
  }

  await crashGuardRequest(
    "POST",
    "/arm",
    {
      mint: tokenMint,
    }
  );

  crashGuardArmed = true;

  console.log(
    "🛡️ Crash Guard armé pour",
    tokenMint
  );
}

async function disarmCrashGuard() {
  if (!CRASH_GUARD_URL) {
    crashGuardArmed = false;
    return;
  }

  try {
    await crashGuardRequest(
      "POST",
      "/disarm"
    );
  } catch (error) {
    console.error(
      "Erreur désarmement Crash Guard:",
      error.message
    );
  }

  crashGuardArmed = false;
}

/* =========================================================
   PUMPSWAP REAL SWAP
========================================================= */

async function sendRealSwap(
  poolAddress,
  mode,
  amountBn,
  slippagePercent
) {
  if (!REAL_TRADING) {
    throw new Error(
      "REAL_TRADING=false"
    );
  }

  if (!tradingWallet) {
    throw new Error(
      "Wallet trading absent"
    );
  }

  if (!poolAddress) {
    throw new Error(
      "Pool PumpSwap manquant"
    );
  }

  if (!BN.isBN(amountBn)) {
    amountBn =
      new BN(String(amountBn));
  }

  if (
    amountBn.lte(new BN(0))
  ) {
    throw new Error(
      "Montant swap invalide"
    );
  }

  const poolPk =
    new PublicKey(poolAddress);

  console.log(
    `🔄 Swap ${mode} | pool=${poolAddress} | amount=${amountBn.toString()} | slippage=${slippagePercent}%`
  );

  const swapState =
    await onlineAmmSdk.swapSolanaState(
      poolPk,
      tradingWallet.publicKey
    );

  let instructions;

  if (mode === "BUY") {
    instructions =
      await PUMP_AMM_SDK.buyQuoteInput(
        swapState,
        amountBn,
        slippagePercent
      );
  } else if (mode === "SELL") {
    instructions =
      await PUMP_AMM_SDK.sellBaseInput(
        swapState,
        amountBn,
        slippagePercent
      );
  } else {
    throw new Error(
      `Mode swap inconnu: ${mode}`
    );
  }

  if (
    !Array.isArray(instructions) ||
    instructions.length === 0
  ) {
    throw new Error(
      "PumpSwap n'a produit aucune instruction"
    );
  }

  const transaction =
    new Transaction();

  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit(
      {
        units: 200000,
      }
    )
  );

  for (
    const instruction of instructions
  ) {
    transaction.add(instruction);
  }

  /*
   * Pré-simulation obligatoire.
   * Si elle échoue, aucune transaction n'est envoyée.
   */
  const simulation =
    await connection.simulateTransaction(
      transaction,
      [tradingWallet]
    );

  if (simulation.value.err) {
    console.error(
      "❌ Simulation PumpSwap échouée:",
      JSON.stringify(
        simulation.value.err
      )
    );

    if (
      simulation.value.logs
    ) {
      console.error(
        simulation.value.logs.join("\n")
      );
    }

    throw new Error(
      `Simulation PumpSwap échouée: ${JSON.stringify(
        simulation.value.err
      )}`
    );
  }

  console.log(
    "✅ Simulation PumpSwap OK"
  );

  /*
   * Une seule tentative d'envoi.
   *
   * Si cette opération devient ambiguë après envoi,
   * on ne relance PAS automatiquement un deuxième swap.
   */
  const signature =
    await sendAndConfirmTransaction(
      connection,
      transaction,
      [tradingWallet],
      {
        commitment: "confirmed",
        preflightCommitment:
          "confirmed",
        skipPreflight: false,
      }
    );

  console.log(
    `✅ Transaction confirmée: ${signature}`
  );

  return signature;
}

/* =========================================================
   REAL BUY
========================================================= */

async function realBuy(data) {
  if (!REAL_TRADING) {
    throw new Error(
      "Le bot n'est pas en mode réel"
    );
  }

  if (tradeInProgress) {
    console.log(
      "⏳ Transaction déjà en cours"
    );
    return false;
  }

  if (!data?.pairAddress) {
    throw new Error(
      "Pair PumpSwap absente"
    );
  }

  resetDailyIfNeeded();

  if (
    !canSpendDaily(
      FIXED_CAPITAL_EUR
    )
  ) {
    await sendTelegram(
      `⛔ ACHAT BLOQUÉ\n\n` +
      `Plafond quotidien atteint.\n` +
      `Dépensé aujourd'hui : ${dailySpentEur.toFixed(2)} €\n` +
      `Plafond : ${MAX_DAILY_EUR.toFixed(2)} €`
    );

    return false;
  }

  tradeInProgress = true;

  try {
    const quote =
      await getEurSolQuote();

    const solBalance =
      await getWalletSolBalance();

    if (
      solBalance <
      quote.sol + MIN_SOL_RESERVE
    ) {
      await sendTelegram(
        `⛔ ACHAT BLOQUÉ\n\n` +
        `Solde SOL insuffisant.\n` +
        `Disponible : ${solBalance.toFixed(6)} SOL\n` +
        `Nécessaire achat : ${quote.sol.toFixed(6)} SOL\n` +
        `Réserve : ${MIN_SOL_RESERVE} SOL`
      );

      return false;
    }

    const tokenBefore =
      await getTokenBalanceRaw(
        mint
      );

    const lamports =
      Math.ceil(
        quote.sol * 1e9
      );

    const quoteBn =
      new BN(
        String(lamports)
      );

    console.log(
      `🟢 ACHAT RÉEL ${FIXED_CAPITAL_EUR.toFixed(2)} €`
    );

    console.log(
      `USD: ${quote.usd.toFixed(6)}`
    );

    console.log(
      `SOL: ${quote.sol.toFixed(9)}`
    );

    console.log(
      `Lamports: ${quoteBn.toString()}`
    );

    const signature =
      await sendRealSwap(
        data.pairAddress,
        "BUY",
        quoteBn,
        BUY_SLIPPAGE_PERCENT
      );

    /*
     * Lecture du solde après confirmation.
     * On utilise la différence pour connaître exactement
     * combien de tokens CET achat a reçu.
     */
    await sleep(1000);

    const tokenAfter =
      await getTokenBalanceRaw(
        mint
      );

    const receivedRaw =
      tokenAfter.raw.sub(
        tokenBefore.raw
      );

    if (
      receivedRaw.lte(new BN(0))
    ) {
      throw new Error(
        "Aucun token détecté après l'achat confirmé"
      );
    }

    const decimals =
      tokenAfter.decimals;

    const receivedTokens =
      Number(
        receivedRaw.toString()
      ) /
      10 ** decimals;

    if (
      !Number.isFinite(receivedTokens) ||
      receivedTokens <= 0
    ) {
      throw new Error(
        "Quantité de tokens reçue invalide"
      );
    }

    const actualEntryPrice =
      quote.usd /
      receivedTokens;

    const targetPrice =
      actualEntryPrice *
      (1 +
        TARGET_GAIN_PERCENT / 100);

    const newPosition = {
      mint,

      poolAddress:
        data.pairAddress,

      tokenAmountRaw:
        receivedRaw.toString(),

      tokenAmount:
        receivedTokens,

      tokenDecimals:
        decimals,

      capitalEur:
        FIXED_CAPITAL_EUR,

      capitalUsd:
        quote.usd,

      solSpent:
        quote.sol,

      solSpentLamports:
        lamports,

      eurUsd:
        quote.eurUsd,

      solUsd:
        quote.solUsd,

      entryPrice:
        actualEntryPrice,

      targetPrice,

      entryMarketPrice:
        data.price,

      entryLiquidity:
        data.liquidity,

      buySignature:
        signature,

      entryTimestamp:
        now(),

      cycle:
        cycleNumber + 1,
    };

    /*
     * On vérifie immédiatement si un CRITICAL est arrivé
     * pendant la transaction.
     */
    position =
      newPosition;

    registerDailySpend(
      FIXED_CAPITAL_EUR
    );

    cycleNumber += 1;

    /*
     * Si Crash Guard a verrouillé pendant l'achat,
     * on vend immédiatement la quantité réellement reçue.
     */
    if (crashGuardLocked) {
      console.log(
        "🚨 CRITICAL arrivé pendant l'achat. Vente d'urgence immédiate."
      );

      await emergencyExitFromCrashGuard(
        {
          level: "CRITICAL",
          pool:
            data.pairAddress,
          mint,
          reason:
            "CRITICAL pendant achat",
        }
      );

      return false;
    }

    healthyConfirmations = 0;

    sessionCycles.push({
      cycle:
        cycleNumber,

      type:
        "BUY_REAL",

      capitalEur:
        FIXED_CAPITAL_EUR,

      capitalUsd:
        quote.usd,

      solSpent:
        quote.sol,

      tokens:
        receivedTokens,

      entryPrice:
        actualEntryPrice,

      targetPrice,

      buySignature:
        signature,

      timestamp:
        new Date().toISOString(),
    });

    addTrade({
      type:
        "BUY_REAL",

      mint,

      poolAddress:
        data.pairAddress,

      cycle:
        cycleNumber,

      capitalEur:
        FIXED_CAPITAL_EUR,

      capitalUsd:
        quote.usd,

      solSpent:
        quote.sol,

      tokenAmount:
        receivedTokens,

      tokenAmountRaw:
        receivedRaw.toString(),

      tokenDecimals:
        decimals,

      entryPrice:
        actualEntryPrice,

      targetPrice,

      signature,
    });

    await sendTelegram(
      `🟢 ACHAT RÉEL\n\n` +
      `Cycle : ${cycleNumber}\n` +
      `Montant : ${FIXED_CAPITAL_EUR.toFixed(2)} €\n` +
      `≈ ${quote.usd.toFixed(4)} USD\n` +
      `≈ ${quote.sol.toFixed(6)} SOL\n` +
      `Tokens : ${receivedTokens}\n` +
      `Prix entrée réel : ${actualEntryPrice}\n` +
      `Objectif +${TARGET_GAIN_PERCENT}% : ${targetPrice}\n` +
      `Slippage achat : ${BUY_SLIPPAGE_PERCENT}%\n\n` +
      `TX : ${signature}`
    );

    return true;
  } finally {
    tradeInProgress = false;
  }
}

/* =========================================================
   REAL SELL
========================================================= */

async function realSellPosition(
  reason,
  forcedPoolAddress = null
) {
  if (!position) {
    return null;
  }

  if (tradeInProgress) {
    console.log(
      "⏳ Une autre transaction est déjà en cours"
    );

    return null;
  }

  const currentPosition =
    position;

  const poolAddress =
    forcedPoolAddress ||
    currentPosition.poolAddress;

  const amountRaw =
    new BN(
      String(
        currentPosition.tokenAmountRaw
      )
    );

  if (
    amountRaw.lte(new BN(0))
  ) {
    throw new Error(
      "Montant de vente invalide"
    );
  }

  tradeInProgress = true;

  try {
    const beforeSol =
      await getWalletSolBalance();

    const signature =
      await sendRealSwap(
        poolAddress,
        "SELL",
        amountRaw,
        SELL_SLIPPAGE_PERCENT
      );

    await sleep(1000);

    const afterSol =
      await getWalletSolBalance();

    const solDelta =
      afterSol - beforeSol;

    /*
     * Le delta SOL inclut aussi potentiellement les frais.
     * On l'utilise uniquement comme information.
     */
    const exitPrice =
      currentPosition.capitalUsd > 0 &&
      currentPosition.tokenAmount > 0
        ? currentPosition.capitalUsd /
          currentPosition.tokenAmount
        : null;

    let profitPercent = null;

    if (
      exitPrice !== null &&
      currentPosition.entryPrice > 0
    ) {
      profitPercent =
        (
          (
            exitPrice -
            currentPosition.entryPrice
          ) /
          currentPosition.entryPrice
        ) * 100;
    }

    const cycleResult = {
      cycle:
        currentPosition.cycle,

      reason,

      entryPrice:
        currentPosition.entryPrice,

      exitPrice,

      profitPercent,

      capitalEur:
        currentPosition.capitalEur,

      tokenAmount:
        currentPosition.tokenAmount,

      solDelta,

      buySignature:
        currentPosition.buySignature,

      sellSignature:
        signature,

      timestamp:
        new Date().toISOString(),
    };

    sessionCycles.push({
      type:
        "SELL_REAL",

      ...cycleResult,
    });

    if (
      Number.isFinite(profitPercent)
    ) {
      sessionProfit +=
        profitPercent;
    }

    addTrade({
      type:
        "SELL_REAL",

      mint,

      poolAddress,

      ...cycleResult,

      signature,
    });

    position = null;

    healthyConfirmations = 0;

    observationUntil =
      now() +
      OBSERVATION_AFTER_SELL_MS;

    await sendTelegram(
      `🔴 VENTE RÉELLE\n\n` +
      `Cycle : ${currentPosition.cycle}\n` +
      `Raison : ${reason}\n` +
      `Tokens vendus : ${currentPosition.tokenAmount}\n` +
      `Prix entrée : ${currentPosition.entryPrice}\n` +
      `Prix sortie estimé : ${exitPrice ?? "N/A"}\n` +
      `Résultat estimé : ${
        profitPercent === null
          ? "N/A"
          : `${profitPercent.toFixed(2)}%`
      }\n` +
      `Slippage vente : ${SELL_SLIPPAGE_PERCENT}%\n\n` +
      `TX : ${signature}`
    );

    return signature;
  } finally {
    tradeInProgress = false;
  }
}

/* =========================================================
   CRASH GUARD EMERGENCY EXIT
========================================================= */

async function emergencyExitFromCrashGuard(
  signal
) {
  if (
    crashGuardEmergencyExitDone
  ) {
    return;
  }

  if (
    crashGuardEmergencyExitInProgress
  ) {
    return;
  }

  if (!position) {
    crashGuardEmergencyExitDone = true;

    await sendTelegram(
      `🚨 CRASH GUARD CRITICAL\n\n` +
      `Aucune position ouverte à vendre.\n` +
      `Trading verrouillé.`
    );

    return;
  }

  crashGuardEmergencyExitInProgress =
    true;

  try {
    const poolAddress =
      signal?.pool ||
      position.poolAddress ||
      null;

    if (!poolAddress) {
      throw new Error(
        "Aucune pool disponible pour la vente d'urgence"
      );
    }

    await sendTelegram(
      `🚨 CRASH GUARD CRITICAL\n\n` +
      `VENTE D'URGENCE RÉELLE EN COURS.\n` +
      `Pool : ${poolAddress}`
    );

    const signature =
      await realSellPosition(
        "CRASH_GUARD_CRITICAL",
        poolAddress
      );

    if (signature) {
      crashGuardEmergencyExitDone =
        true;

      await sendTelegram(
        `🛡️ CRASH GUARD\n\n` +
        `Position liquidée par CRITICAL.\n\n` +
        `TX : ${signature}`
      );
    }
  } catch (error) {
    /*
     * On NE marque PAS l'exit comme effectué si la vente échoue.
     * Cela permet à l'état de rester visible comme non liquidé.
     */
    await sendTelegram(
      `❌ ERREUR VENTE D'URGENCE\n\n` +
      `${error.message}\n\n` +
      `La position réelle n'est PAS considérée comme liquidée.`
    );

    console.error(
      "Erreur emergency exit:",
      error
    );
  } finally {
    crashGuardEmergencyExitInProgress =
      false;
  }
}

/* =========================================================
   CRASH GUARD SIGNAL
========================================================= */

async function applyCrashGuardSignal(
  signal
) {
  if (!signal) {
    return;
  }

  const eventId =
    signal.id ||
    `${signal.level}-${signal.timestamp}`;

  if (
    eventId ===
    crashGuardLastEventId
  ) {
    return;
  }

  crashGuardLastEventId =
    eventId;

  if (
    signal.mint &&
    mint &&
    signal.mint !== mint
  ) {
    return;
  }

  const level =
    String(
      signal.level || "NORMAL"
    ).toUpperCase();

  if (level === "WATCH") {
    crashGuardLevel =
      "WATCH";

    return;
  }

  if (level === "DANGER") {
    crashGuardLevel =
      "DANGER";

    crashGuardBuyBlocked =
      true;

    await sendTelegram(
      `⚠️ CRASH GUARD DANGER\n\n` +
      `Nouveaux achats bloqués.\n` +
      `Position actuelle conservée.\n` +
      `Aucune vente automatique sur DANGER.`
    );

    return;
  }

  if (level === "CRITICAL") {
    crashGuardLevel =
      "CRITICAL";

    crashGuardBuyBlocked =
      true;

    crashGuardLocked =
      true;

    await sendTelegram(
      `🚨 CRASH GUARD CRITICAL\n\n` +
      `Nouveaux achats BLOQUÉS.\n` +
      `Trading verrouillé.\n` +
      `Vente d'urgence de la position si nécessaire.`
    );

    await emergencyExitFromCrashGuard(
      signal
    );

    saveSummary();

    if (active) {
      stopRadar(
        false,
        true
      ).catch(error =>
        console.error(
          "Erreur stop après CRITICAL:",
          error.message
        )
      );
    }
  }
}

/* =========================================================
   HTTP SERVER POUR CRASH GUARD
========================================================= */

function isAuthorizedCrashGuard(req) {
  return (
    req.headers[
      "x-crash-guard-secret"
    ] ===
    CRASH_GUARD_SECRET
  );
}

const httpServer =
  http.createServer(
    async (req, res) => {
      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        res.writeHead(
          200,
          {
            "content-type":
              "application/json",
          }
        );

        res.end(
          JSON.stringify({
            ok: true,
            service:
              "v51-real-trading",
            realTrading:
              REAL_TRADING,
            wallet:
              tradingWallet
                ? tradingWallet.publicKey.toBase58()
                : null,
            active,
            mint,
            crashGuardLevel,
            crashGuardLocked,
            position:
              !!position,
          })
        );

        return;
      }

      if (
        req.method === "POST" &&
        req.url ===
          "/crash-guard/event"
      ) {
        if (
          !isAuthorizedCrashGuard(req)
        ) {
          res.writeHead(
            401,
            {
              "content-type":
                "application/json",
            }
          );

          res.end(
            JSON.stringify({
              ok: false,
              error:
                "unauthorized",
            })
          );

          return;
        }

        let body = "";

        req.on(
          "data",
          chunk => {
            body += chunk;
          }
        );

        req.on(
          "end",
          () => {
            let signal;

            try {
              signal =
                JSON.parse(body);
            } catch {
              res.writeHead(
                400,
                {
                  "content-type":
                    "application/json",
                }
              );

              res.end(
                JSON.stringify({
                  ok: false,
                  error:
                    "invalid json",
                })
              );

              return;
            }

            res.writeHead(
              200,
              {
                "content-type":
                  "application/json",
              }
            );

            res.end(
              JSON.stringify({
                ok: true,
              })
            );

            applyCrashGuardSignal(
              signal
            ).catch(error =>
              console.error(
                "Erreur traitement Crash Guard:",
                error
              )
            );
          }
        );

        return;
      }

      res.writeHead(
        404,
        {
          "content-type":
            "application/json",
        }
      );

      res.end(
        JSON.stringify({
          ok: false,
          error:
            "not found",
        })
      );
    }
  );

httpServer.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `🌐 Serveur V5.1 listening on ${PORT}`
    );

    console.log(
      `🌐 Host: 0.0.0.0`
    );

    console.log(
      `💰 Mode réel: ${REAL_TRADING}`
    );

    if (tradingWallet) {
      console.log(
        `👛 Wallet: ${tradingWallet.publicKey.toBase58()}`
      );
    }
  }
);

/* =========================================================
   ENTRY CONDITIONS
========================================================= */

function canEnter(data) {
  if (!active) {
    return false;
  }

  if (position) {
    return false;
  }

  if (tradeInProgress) {
    return false;
  }

  if (crashGuardLocked) {
    return false;
  }

  if (crashGuardBuyBlocked) {
    return false;
  }

  if (
    CRASH_GUARD_URL &&
    !crashGuardArmed
  ) {
    return false;
  }

  const elapsed =
    now() -
    sessionStartTime;

  if (
    elapsed >=
    NO_NEW_BUY_AFTER_MS
  ) {
    return false;
  }

  if (
    observationUntil >
    now()
  ) {
    return false;
  }

  if (
    !data ||
    data.liquidity <
      MIN_LIQUIDITY_USD
  ) {
    return false;
  }

  const health =
    calculateHealth(data);

  if (
    health.score <
    MIN_HEALTH_SCORE_FOR_ENTRY
  ) {
    return false;
  }

  const acceleration =
    analyzeAcceleration(data);

  if (
    acceleration.extreme
  ) {
    return false;
  }

  return true;
}

/* =========================================================
   CRASH DETECTION V5.1
========================================================= */

function detectCrash(data) {
  const ten =
    getHistoryAgo(10000);

  if (!ten) {
    return {
      crash: false,
      reasons: [],
    };
  }

  const priceChange10s =
    percentChange(
      data.price,
      ten.price
    );

  const liquidityChange10s =
    percentChange(
      data.liquidity,
      ten.liquidity
    );

  const reasons = [];

  if (
    liquidityChange10s !== null &&
    liquidityChange10s <=
      CRASH_LIQUIDITY_DROP_10S
  ) {
    reasons.push(
      `liquidité ${liquidityChange10s.toFixed(2)}%`
    );
  }

  if (
    priceChange10s !== null &&
    priceChange10s <=
      CRASH_PRICE_DROP_10S
  ) {
    reasons.push(
      `prix ${priceChange10s.toFixed(2)}%`
    );
  }

  return {
    crash:
      reasons.length > 0,

    reasons,

    priceChange10s,

    liquidityChange10s,
  };
}

/* =========================================================
   CRASH REPORT
========================================================= */

function loadCrashReports() {
  try {
    if (
      !fs.existsSync(
        CRASH_REPORTS_FILE
      )
    ) {
      return [];
    }

    const content =
      fs.readFileSync(
        CRASH_REPORTS_FILE,
        "utf8"
      );

    if (!content.trim()) {
      return [];
    }

    return JSON.parse(content);
  } catch {
    return [];
  }
}

function saveCrashReport(report) {
  const reports =
    loadCrashReports();

  reports.push(report);

  saveJson(
    CRASH_REPORTS_FILE,
    reports
  );
}

/* =========================================================
   GENERIC CRASH HANDLER
========================================================= */

async function handleCrash(
  data,
  crash
) {
  const report = {
    timestamp:
      new Date().toISOString(),

    mint,

    sessionStartTime:
      sessionStartTime
        ? new Date(
            sessionStartTime
          ).toISOString()
        : null,

    cycles:
      sessionCycles.length,

    sessionProfit,

    crashPrice:
      data.price,

    crashLiquidity:
      data.liquidity,

    priceChange10s:
      crash.priceChange10s,

    liquidityChange10s:
      crash.liquidityChange10s,

    reasons:
      crash.reasons,

    position:
      position
        ? {
            entryPrice:
              position.entryPrice,

            tokenAmount:
              position.tokenAmount,

            cycle:
              position.cycle,
          }
        : null,

    history:
      marketHistory.slice(
        -Math.floor(
          CRASH_REPORT_WINDOW_MS /
            POLL_INTERVAL_MS
        )
      ),
  };

  saveCrashReport(
    report
  );

  await sendTelegram(
    `💥 CRASH V5.1\n\n` +
    `Prix : ${data.price}\n` +
    `Liquidité : $${data.liquidity.toFixed(2)}\n` +
    `Prix 10s : ${
      crash.priceChange10s === null
        ? "N/A"
        : crash.priceChange10s.toFixed(2) + "%"
    }\n` +
    `Liquidité 10s : ${
      crash.liquidityChange10s === null
        ? "N/A"
        : crash.liquidityChange10s.toFixed(2) + "%"
    }\n` +
    `Raisons : ${crash.reasons.join(", ")}`
  );

  /*
   * En réel, on ne laisse pas une position ouverte
   * uniquement parce que le détecteur V5.1 classique
   * a déclenché.
   *
   * On tente une vente réelle si Crash Guard n'a pas
   * déjà pris en charge la position.
   */
  if (
    position &&
    !crashGuardEmergencyExitDone
  ) {
    try {
      await realSellPosition(
        "V5.1_CRASH"
      );
    } catch (error) {
      await sendTelegram(
        `❌ V5.1 CRASH\n\n` +
        `La vente réelle a échoué.\n` +
        `${error.message}`
      );
    }
  }

  await disarmCrashGuard();

  stopRadar(
    false,
    true
  ).catch(error =>
    console.error(
      "Erreur stopRadar crash:",
      error.message
    )
  );
}

/* =========================================================
   TIME LIMIT EXIT
========================================================= */

async function timeLimitExit(data) {
  if (!position) {
    return;
  }

  try {
    await realSellPosition(
      "TIME_LIMIT_45_MIN",
      position.poolAddress
    );
  } catch (error) {
    await sendTelegram(
      `❌ LIMITE 45 MIN\n\n` +
      `La vente réelle a échoué.\n` +
      `${error.message}\n\n` +
      `La position n'est PAS considérée comme liquidée.`
    );

    console.error(
      "Erreur time limit sell:",
      error
    );

    return;
  }

  await disarmCrashGuard();

  await stopRadar(
    false,
    true
  );
}

/* =========================================================
   TARGET SELL
========================================================= */

async function checkTargetSell(data) {
  if (!position) {
    return false;
  }

  if (
    data.price >=
    position.targetPrice
  ) {
    try {
      await realSellPosition(
        "TARGET_PLUS_5",
        position.poolAddress
      );

      return true;
    } catch (error) {
      await sendTelegram(
        `❌ VENTE OBJECTIF\n\n` +
        `L'objectif a été atteint mais la transaction a échoué.\n` +
        `${error.message}\n\n` +
        `La position reste ouverte.`
      );

      console.error(
        "Erreur target sell:",
        error
      );

      return false;
    }
  }

  return false;
}

/* =========================================================
   ACCELERATION ALERT
========================================================= */

async function handleAcceleration(
  data
) {
  const acceleration =
    analyzeAcceleration(data);

  if (
    acceleration.warning &&
    !accelerationAlertSent
  ) {
    accelerationWarningActive =
      true;

    accelerationAlertSent =
      true;

    await sendTelegram(
      `⚠️ ACCÉLÉRATION V5.1\n\n` +
      `Prix 5s : ${
        acceleration.price5s === null
          ? "N/A"
          : acceleration.price5s.toFixed(2) + "%"
      }\n` +
      `Prix 10s : ${
        acceleration.price10s === null
          ? "N/A"
          : acceleration.price10s.toFixed(2) + "%"
      }\n` +
      `Liquidité 10s : ${
        acceleration.liquidity10s === null
          ? "N/A"
          : acceleration.liquidity10s.toFixed(2) + "%"
      }`
    );
  }

  if (
    !acceleration.warning
  ) {
    accelerationWarningActive =
      false;

    accelerationAlertSent =
      false;
  }

  return acceleration;
}

/* =========================================================
   TICK V5.1
========================================================= */

async function tick() {
  if (
    !active ||
    !mint
  ) {
    return;
  }

  if (
    crashGuardLocked
  ) {
    return;
  }

  if (
    tradeInProgress
  ) {
    return;
  }

  let data;

  try {
    data =
      await getMarketData(
        mint
      );
  } catch (error) {
    console.error(
      "Erreur marché:",
      error.message
    );

    return;
  }

  if (!data) {
    return;
  }

  addMarketHistory(
    data
  );

  const health =
    calculateHealth(
      data
    );

  if (
    health.healthy
  ) {
    healthyConfirmations += 1;
  } else {
    healthyConfirmations = 0;
  }

  const acceleration =
    await handleAcceleration(
      data
    );

  const crash =
    detectCrash(
      data
    );

  if (
    crash.crash
  ) {
    await handleCrash(
      data,
      crash
    );

    return;
  }

  const elapsed =
    now() -
    sessionStartTime;

  if (
    elapsed >=
    MAX_TOKEN_SESSION_MS
  ) {
    await timeLimitExit(
      data
    );

    return;
  }

  if (position) {
    await checkTargetSell(
      data
    );

    return;
  }

  if (
    !canEnter(data)
  ) {
    return;
  }

  if (
    healthyConfirmations <
    REQUIRED_HEALTHY_CONFIRMATIONS
  ) {
    return;
  }

  if (
    acceleration.extreme
  ) {
    return;
  }

  try {
    await realBuy(
      data
    );
  } catch (error) {
    await sendTelegram(
      `❌ ERREUR ACHAT RÉEL\n\n` +
      `${error.message}\n\n` +
      `Aucun achat considéré comme réussi.`
    );

    console.error(
      "Erreur realBuy:",
      error
    );
  }
}

/* =========================================================
   SUMMARY
========================================================= */

function saveSummary() {
  const summary = {
    version:
      "V5.1-REAL",

    active,

    mint,

    sessionStartTime:
      sessionStartTime
        ? new Date(
            sessionStartTime
          ).toISOString()
        : null,

    sessionCycles,

    sessionProfit,

    dailySpentEur,

    dailySpentDate,

    position,

    crashGuardLevel,

    crashGuardBuyBlocked,

    crashGuardLocked,

    crashGuardEmergencyExitDone,

    realTrading:
      REAL_TRADING,

    wallet:
      tradingWallet
        ? tradingWallet.publicKey.toBase58()
        : null,

    updatedAt:
      new Date().toISOString(),
  };

  saveJson(
    SUMMARY_FILE,
    summary
  );
}

/* =========================================================
   START RADAR
========================================================= */

async function startRadar(
  tokenMint
) {
  if (
    active
  ) {
    throw new Error(
      "Un radar est déjà actif"
    );
  }

  if (
    !tokenMint
  ) {
    throw new Error(
      "Mint manquant"
    );
  }

  if (
    !REAL_TRADING
  ) {
    throw new Error(
      "REAL_TRADING=false. Active le mode réel dans Railway avant /starttrade."
    );
  }

  /*
   * Vérification du wallet avant toute session.
   */
  const solBalance =
    await getWalletSolBalance();

  if (
    solBalance <
    MIN_SOL_RESERVE
  ) {
    throw new Error(
      `Solde SOL insuffisant pour démarrer: ${solBalance.toFixed(6)} SOL`
    );
  }

  /*
   * Vérification marché avant armement.
   */
  const initialData =
    await getMarketData(
      tokenMint
    );

  if (!initialData) {
    throw new Error(
      "Aucune paire PumpSwap détectée pour ce token"
    );
  }

  mint =
    tokenMint;

  crashGuardLevel =
    "NORMAL";

  crashGuardBuyBlocked =
    false;

  crashGuardLocked =
    false;

  crashGuardEmergencyExitDone =
    false;

  crashGuardEmergencyExitInProgress =
    false;

  crashGuardLastEventId =
    null;

  healthyConfirmations =
    0;

  marketHistory = [];

  accelerationWarningActive =
    false;

  accelerationAlertSent =
    false;

  position =
    null;

  cycleNumber =
    0;

  sessionCycles = [];

  sessionProfit =
    0;

  observationUntil =
    0;

  sessionStartTime =
    now();

  resetDailyIfNeeded();

  /*
   * Le Guard doit être armé AVANT le début
   * de la surveillance réelle.
   */
  await armCrashGuard(
    tokenMint
  );

  active =
    true;

  await sendTelegram(
    `🚀 V5.1 RÉEL DÉMARRÉ\n\n` +
    `Mint : ${tokenMint}\n` +
    `Capital par achat : ${FIXED_CAPITAL_EUR.toFixed(2)} €\n` +
    `Objectif : +${TARGET_GAIN_PERCENT}%\n` +
    `Slippage achat : ${BUY_SLIPPAGE_PERCENT}%\n` +
    `Slippage vente : ${SELL_SLIPPAGE_PERCENT}%\n` +
    `Plafond quotidien : ${MAX_DAILY_EUR.toFixed(2)} €\n` +
    `Wallet : ${tradingWallet.publicKey.toBase58()}\n\n` +
    `⚠️ Les transactions sont maintenant RÉELLES.`
  );

  /*
   * Premier tick immédiat.
   */
  tick().catch(error =>
    console.error(
      "Erreur premier tick:",
      error
    )
  );

  pollTimer =
    setInterval(
      () => {
        tick().catch(error =>
          console.error(
            "Erreur tick:",
            error
          )
        );
      },
      POLL_INTERVAL_MS
    );

  saveSummary();
}

/* =========================================================
   STOP RADAR
========================================================= */

async function stopRadar(
  sendMessage = true,
  internal = false
) {
  if (
    pollTimer
  ) {
    clearInterval(
      pollTimer
    );

    pollTimer =
      null;
  }

  /*
   * Si /stoptrade est demandé alors qu'une position
   * réelle existe, on la vend avant de désarmer le Guard.
   */
  if (
    position &&
    !internal &&
    REAL_TRADING
  ) {
    try {
      await realSellPosition(
        "MANUAL_STOP",
        position.poolAddress
      );
    } catch (error) {
      await sendTelegram(
        `❌ ARRÊT DU BOT\n\n` +
        `Impossible de vendre la position réelle.\n` +
        `${error.message}\n\n` +
        `La position reste considérée comme ouverte.`
      );

      /*
       * On ne considère pas la session comme proprement
       * arrêtée si une position réelle reste ouverte.
       */
      saveSummary();

      return;
    }
  }

  active =
    false;

  await disarmCrashGuard();

  if (
    sendMessage
  ) {
    await sendTelegram(
      `⛔ V5.1 RÉEL ARRÊTÉ\n\n` +
      `Mint : ${mint || "aucun"}\n` +
      `Cycles : ${sessionCycles.length}\n` +
      `Résultat cumulé : ${sessionProfit.toFixed(2)}%`
    );
  }

  saveSummary();

  if (!internal) {
    mint =
      null;

    position =
      null;

    marketHistory =
      [];

    crashGuardLevel =
      "NORMAL";

    crashGuardBuyBlocked =
      false;

    crashGuardLocked =
      false;

    crashGuardEmergencyExitDone =
      false;

    crashGuardLastEventId =
      null;

    healthyConfirmations =
      0;
  }
}

/* =========================================================
   TELEGRAM COMMANDS
========================================================= */

bot.command(
  "starttrade",
  async ctx => {
    try {
      const parts =
        ctx.message.text
          .trim()
          .split(/\s+/);

      const tokenMint =
        parts[1];

      if (!tokenMint) {
        await ctx.reply(
          "❌ Utilisation : /starttrade MINT"
        );

        return;
      }

      try {
        new PublicKey(
          tokenMint
        );
      } catch {
        await ctx.reply(
          "❌ Mint Solana invalide."
        );

        return;
      }

      await startRadar(
        tokenMint
      );

      await ctx.reply(
        "✅ Surveillance réelle démarrée."
      );
    } catch (error) {
      console.error(
        "/starttrade:",
        error
      );

      await ctx.reply(
        `❌ Impossible de démarrer.\n\n${error.message}`
      );
    }
  }
);

bot.command(
  "stoptrade",
  async ctx => {
    try {
      await stopRadar(
        true,
        false
      );

      await ctx.reply(
        "⛔ Surveillance arrêtée."
      );
    } catch (error) {
      console.error(
        "/stoptrade:",
        error
      );

      await ctx.reply(
        `❌ Erreur arrêt : ${error.message}`
      );
    }
  }
);

bot.command(
  "status",
  async ctx => {
    resetDailyIfNeeded();

    const solBalance =
      tradingWallet
        ? await getWalletSolBalance()
            .catch(() => null)
        : null;

    let message =
      `📊 V5.1 RÉEL\n\n`;

    message +=
      `Actif : ${active ? "OUI" : "NON"}\n`;

    message +=
      `Mint : ${mint || "aucun"}\n`;

    message +=
      `Trading réel : ${REAL_TRADING ? "OUI" : "NON"}\n`;

    message +=
      `Crash Guard : ${crashGuardLevel}\n`;

    message +=
      `Buy bloqué : ${crashGuardBuyBlocked ? "OUI" : "NON"}\n`;

    message +=
      `Trading verrouillé : ${crashGuardLocked ? "OUI" : "NON"}\n`;

    message +=
      `Position : ${position ? "OUVERTE" : "AUCUNE"}\n`;

    message +=
      `Cycle : ${cycleNumber}\n`;

    message +=
      `Résultat cumulé : ${sessionProfit.toFixed(2)}%\n`;

    message +=
      `Dépensé aujourd'hui : ${dailySpentEur.toFixed(2)} € / ${MAX_DAILY_EUR.toFixed(2)} €\n`;

    message +=
      `Solde SOL : ${
        solBalance === null
          ? "N/A"
          : solBalance.toFixed(6)
      } SOL\n`;

    if (position) {
      message +=
        `\nPrix entrée : ${position.entryPrice}\n`;

      message +=
        `Objectif : ${position.targetPrice}\n`;

      message +=
        `Tokens : ${position.tokenAmount}\n`;

      message +=
        `TX achat : ${position.buySignature}\n`;
    }

    await ctx.reply(
      message
    );
  }
);

bot.command(
  "lastcrash",
  async ctx => {
    const reports =
      loadCrashReports();

    if (!reports.length) {
      await ctx.reply(
        "💥 Aucun crash enregistré."
      );

      return;
    }

    const last =
      reports[
        reports.length - 1
      ];

    await ctx.reply(
      `💥 DERNIER CRASH\n\n` +
      `Mint : ${last.mint}\n` +
      `Date : ${last.timestamp}\n` +
      `Prix : ${last.crashPrice}\n` +
      `Liquidité : $${Number(
        last.crashLiquidity || 0
      ).toFixed(2)}\n` +
      `Prix 10s : ${
        last.priceChange10s === null
          ? "N/A"
          : Number(
              last.priceChange10s
            ).toFixed(2) + "%"
      }\n` +
      `Liquidité 10s : ${
        last.liquidityChange10s === null
          ? "N/A"
          : Number(
              last.liquidityChange10s
            ).toFixed(2) + "%"
      }\n` +
      `Raisons : ${
        Array.isArray(last.reasons)
          ? last.reasons.join(", ")
          : "N/A"
      }`
    );
  }
);

bot.command(
  "help",
  async ctx => {
    await ctx.reply(
      `🤖 V5.1 RÉEL\n\n` +
      `/starttrade MINT\n` +
      `/stoptrade\n` +
      `/status\n` +
      `/lastcrash\n` +
      `/help\n\n` +
      `Capital : ${FIXED_CAPITAL_EUR.toFixed(2)} € par achat\n` +
      `Objectif : +${TARGET_GAIN_PERCENT}%\n` +
      `Slippage achat : ${BUY_SLIPPAGE_PERCENT}%\n` +
      `Slippage vente : ${SELL_SLIPPAGE_PERCENT}%`
    );
  }
);

/* =========================================================
   TELEGRAM ERROR
========================================================= */

bot.catch(
  (error, ctx) => {
    console.error(
      "Erreur Telegram:",
      error
    );

    console.error(
      "Update:",
      ctx?.update?.update_id
    );
  }
);

/* =========================================================
   START BOT
========================================================= */

bot.launch()
  .then(() => {
    console.log(
      "🤖 Telegram V5.1 REAL démarré"
    );

    console.log(
      `💰 REAL_TRADING=${REAL_TRADING}`
    );

    console.log(
      `💶 CAPITAL=${FIXED_CAPITAL_EUR} EUR`
    );

    console.log(
      `📉 BUY SLIPPAGE=${BUY_SLIPPAGE_PERCENT}%`
    );

    console.log(
      `📈 SELL SLIPPAGE=${SELL_SLIPPAGE_PERCENT}%`
    );

    console.log(
      `🌐 RPC=${SOLANA_RPC_URL}`
    );

    console.log(
      `🛡️ CRASH GUARD=${CRASH_GUARD_URL ? "CONFIGURÉ" : "NON CONFIGURÉ"}`
    );
  })
  .catch(error => {
    console.error(
      "❌ Impossible de démarrer Telegram:",
      error
    );

    process.exit(1);
  });

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(
  signal
) {
  console.log(
    `\n🛑 Réception ${signal}`
  );

  if (
    pollTimer
  ) {
    clearInterval(
      pollTimer
    );

    pollTimer =
      null;
  }

  /*
   * On ne lance PAS de vente automatique ici.
   *
   * Un redémarrage Railway ne doit pas déclencher
   * aveuglément une transaction pendant que le processus
   * est en train de s'arrêter.
   *
   * La position reste enregistrée dans les logs/summary.
   */
  saveSummary();

  try {
    bot.stop(
      signal
    );
  } catch {}

  httpServer.close(
    () => {
      process.exit(0);
    }
  );

  setTimeout(
    () => process.exit(0),
    5000
  );
}

process.once(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.once(
  "SIGTERM",
  () => shutdown("SIGTERM")
);
