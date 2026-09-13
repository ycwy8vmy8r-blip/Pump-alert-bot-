const {
  Telegraf
} = require("telegraf");

const {
  PublicKey,
  Connection
} = require("@solana/web3.js");

const botToken = process.env.BOT_TOKEN;
const anaxerApiKey = process.env.ANAXER_API_KEY;
const chatId = process.env.CHAT_ID;
const heliusApiKey = process.env.HELIUS_API_KEY;

if (
  !botToken ||
  !anaxerApiKey ||
  !chatId ||
  !heliusApiKey
) {
  console.error("❌ Variable Railway manquante");
  process.exit(1);
}

// =====================================================
// CONFIGURATION
// =====================================================

const RPC_URL =
  "https://mainnet.helius-rpc.com/?api-key=" +
  heliusApiKey;

const WS_URL =
  "wss://mainnet.helius-rpc.com/?api-key=" +
  heliusApiKey;

const connection = new Connection(
  RPC_URL,
  {
    commitment: "processed",
    wsEndpoint: WS_URL
  }
);

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const LIQUIDITY_INTERVAL = 10000;
const TRADE_INTERVAL = 45000;

// Ancien filet de sécurité
const LIQUIDITY_LEVELS = [
  {
    level: "🟠 ALERTE",
    usd: 80000
  },
  {
    level: "🔴 DANGER",
    usd: 50000
  },
  {
    level: "🚨 CRITIQUE",
    usd: 20000
  },
  {
    level: "💀 EXTRÊME",
    usd: 5000
  }
];

// =====================================================
// TURBO ON-CHAIN
// =====================================================

// Alerte si la réserve WSOL baisse brutalement
const TURBO_DROP_PERCENT = 1.5;

// Alerte absolue si une grosse quantité de SOL
// quitte la réserve en une seule mise à jour.
const TURBO_DROP_SOL = 5;

// Très grosse sortie
const TURBO_CRITICAL_PERCENT = 5;
const TURBO_EMERGENCY_PERCENT = 15;

// Anti-spam
const TELEGRAM_MIN_INTERVAL = 5000;

// =====================================================
// ÉTAT
// =====================================================

let watchedMint = null;
let watchedPool = null;

let poolBaseVault = null;
let poolQuoteVault = null;

let baseReserve = null;
let quoteReserveSol = null;

let previousBaseReserve = null;
let previousQuoteReserveSol = null;

let liquidityInterval = null;
let tradeInterval = null;

let baseSubscription = null;
let quoteSubscription = null;

let currentLiquidity = null;
let highestLiquidity = null;

let lastLiquidityAlert = null;
let lastTurboAlert = 0;

let recentTrades = [];

let lastTelegramMessageTime = 0;

let turboEventTimer = null;

let lastDexLiquidity = null;

// =====================================================
// OUTILS
// =====================================================

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return (
    "$" +
    value.toLocaleString("fr-FR", {
      maximumFractionDigits: 0
    })
  );
}

function formatSol(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  return (
    value.toLocaleString("fr-FR", {
      maximumFractionDigits: 3
    }) +
    " SOL"
  );
}

function shortAddress(address) {
  if (!address) {
    return "Inconnu";
  }

  return (
    address.slice(0, 6) +
    "..." +
    address.slice(-6)
  );
}

function nowMs() {
  return Date.now();
}

// =====================================================
// TELEGRAM
// =====================================================

async function safeTelegramSend(message) {

  const now = nowMs();

  const elapsed =
    now - lastTelegramMessageTime;

  if (
    elapsed <
    TELEGRAM_MIN_INTERVAL
  ) {
    await new Promise(resolve =>
      setTimeout(
        resolve,
        TELEGRAM_MIN_INTERVAL - elapsed
      )
    );
  }

  try {

    await bot.telegram.sendMessage(
      chatId,
      message,
      {
        parse_mode: "HTML"
      }
    );

    lastTelegramMessageTime =
      nowMs();

    console.log(
      "🟢 Telegram envoyé"
    );

  } catch (error) {

    console.error(
      "🔴 Telegram :",
      error.message
    );
  }
}

// =====================================================
// DEXSCREENER
// =====================================================

async function fetchPumpSwapPool() {

  if (!watchedMint) {
    return null;
  }

  try {

    const url =
      "https://api.dexscreener.com/token-pairs/v1/solana/" +
      watchedMint;

    const response =
      await fetch(url);

    if (!response.ok) {

      console.error(
        "🔴 DexScreener :",
        response.status
      );

      return null;
    }

    const pairs =
      await response.json();

    if (!Array.isArray(pairs)) {
      return null;
    }

    const pumpSwapPairs =
      pairs.filter(pair => {

        const dex =
          String(
            pair.dexId || ""
          ).toLowerCase();

        return (
          dex === "pumpswap" ||
          dex === "pump_amm" ||
          dex === "pumpamm"
        );
      });

    if (!pumpSwapPairs.length) {

      console.log(
        "⚠️ Aucun pool PumpSwap"
      );

      return null;
    }

    pumpSwapPairs.sort(
      (a, b) =>
        Number(
          b.liquidity?.usd || 0
        ) -
        Number(
          a.liquidity?.usd || 0
        )
    );

    return pumpSwapPairs[0];

  } catch (error) {

    console.error(
      "🔴 DexScreener erreur :",
      error.message
    );

    return null;
  }
}

// =====================================================
// DÉCODAGE DU POOL PUMPSWAP
// =====================================================
//
// Layout PumpSwap:
//
// discriminator       8
// pool_bump           1
// index               2
// creator             32
// base_mint           32
// quote_mint          32
// lp_mint             32
// base_token_account  32
// quote_token_account 32
//
// Offset base vault  = 139
// Offset quote vault = 171
//
// =====================================================

function decodePoolVaults(base64Data) {

  const data =
    Buffer.from(
      base64Data,
      "base64"
    );

  if (data.length < 203) {

    throw new Error(
      "Pool PumpSwap trop petit : " +
      data.length
    );
  }

  const baseVaultBytes =
    data.slice(
      139,
      171
    );

  const quoteVaultBytes =
    data.slice(
      171,
      203
    );

  const baseVault =
    new PublicKey(
      baseVaultBytes
    ).toBase58();

  const quoteVault =
    new PublicKey(
      quoteVaultBytes
    ).toBase58();

  return {
    baseVault,
    quoteVault
  };
}

// =====================================================
// RÉCUPÉRATION DU POOL ON-CHAIN
// =====================================================

async function loadPoolVaults() {

  if (!watchedPool) {
    return false;
  }

  try {

    const accountInfo =
      await connection.getAccountInfo(
        new PublicKey(watchedPool),
        "processed"
      );

    if (!accountInfo) {

      console.error(
        "🔴 Pool introuvable on-chain"
      );

      return false;
    }

    const data =
      accountInfo.data;

    let base64Data;

    if (
      Array.isArray(data) &&
      data.length >= 2
    ) {
      base64Data = data[0];
    } else {
      base64Data =
        Buffer.from(data).toString(
          "base64"
        );
    }

    const vaults =
      decodePoolVaults(
        base64Data
      );

    poolBaseVault =
      vaults.baseVault;

    poolQuoteVault =
      vaults.quoteVault;

    console.log(
      "🏦 Pool :",
      watchedPool
    );

    console.log(
      "🪙 Base vault :",
      poolBaseVault
    );

    console.log(
      "💰 Quote vault :",
      poolQuoteVault
    );

    return true;

  } catch (error) {

    console.error(
      "🔴 Décodage pool :",
      error.message
    );

    return false;
  }
}

// =====================================================
// LECTURE D'UN TOKEN ACCOUNT
// =====================================================

function readTokenAmount(accountInfo) {
  if (!accountInfo) {
    return null;
  }

  try {
    let data = accountInfo.data;

    // Avec getMultipleAccountsInfo(), web3.js
    // renvoie normalement directement un Buffer.
    if (Buffer.isBuffer(data)) {
      if (data.length < 72) {
        return null;
      }

      // SPL Token Account:
      // 0-31   mint
      // 32-63  owner
      // 64-71  amount (u64 little-endian)
      return data.readBigUInt64LE(64);
    }

    // Sécurité si les données arrivent sous forme
    // [base64, "base64"]
    if (
      Array.isArray(data) &&
      data.length >= 2 &&
      data[1] === "base64"
    ) {
      const buffer = Buffer.from(
        data[0],
        "base64"
      );

      if (buffer.length < 72) {
        return null;
      }

      return buffer.readBigUInt64LE(64);
    }

    // Sécurité pour jsonParsed
    const parsed =
      data?.parsed?.info?.tokenAmount?.amount;

    if (parsed !== undefined) {
      return BigInt(parsed);
    }

  } catch (error) {
    console.error(
      "🔴 Lecture réserve token :",
      error.message
    );
  }

  return null;
}

// =====================================================
// LECTURE DES RÉSERVES INITIALES
// =====================================================

async function loadInitialReserves() {

  try {

    const accounts =
      await connection.getMultipleAccountsInfo(
        [
          new PublicKey(
            poolBaseVault
          ),
          new PublicKey(
            poolQuoteVault
          )
        ],
        "processed"
      );

    const base =
      readTokenAmount(
        accounts[0]
      );

    const quote =
      readTokenAmount(
        accounts[1]
      );

    if (
      base === null ||
      quote === null
    ) {

      console.error(
        "🔴 Impossible de lire les réserves"
      );

      return false;
    }

    previousBaseReserve =
      base;

    previousQuoteReserveSol =
      Number(quote) /
      1_000_000_000;

    baseReserve =
      Number(base);

    quoteReserveSol =
      Number(quote) /
      1_000_000_000;

    console.log(
      "💰 Réserve SOL :",
      formatSol(
        quoteReserveSol
      )
    );

    return true;

  } catch (error) {

    console.error(
      "🔴 Réserves :",
      error.message
    );

    return false;
  }
}

// =====================================================
// LIQUIDITÉ DEXSCREENER
// =====================================================

async function refreshDexLiquidity() {

  const pair =
    await fetchPumpSwapPool();

  if (!pair) {
    return null;
  }

  const liquidity =
    Number(
      pair.liquidity?.usd || 0
    );

  if (
    !Number.isFinite(liquidity) ||
    liquidity <= 0
  ) {

    return null;
  }

  currentLiquidity =
    liquidity;

  lastDexLiquidity =
    liquidity;

  if (
    highestLiquidity === null ||
    liquidity > highestLiquidity
  ) {

    highestLiquidity =
      liquidity;
  }

  return liquidity;
}

// =====================================================
// TURBO ALERT
// =====================================================

async function turboAlert({
  type,
  dropPercent,
  dropSol,
  direction
}) {

  const now =
    nowMs();

  if (
    now - lastTurboAlert <
    TELEGRAM_MIN_INTERVAL
  ) {
    return;
  }

  lastTurboAlert =
    now;

  let title =
    "⚡ <b>ACTIVITÉ ON-CHAIN RAPIDE</b>";

  if (
    dropPercent >=
    TURBO_EMERGENCY_PERCENT
  ) {

    title =
      "🚨 <b>VENTE ON-CHAIN MASSIVE</b>";

  } else if (
    dropPercent >=
    TURBO_CRITICAL_PERCENT
  ) {

    title =
      "🔴 <b>FORTE VENTE ON-CHAIN</b>";

  } else if (
    dropPercent >=
    TURBO_DROP_PERCENT
  ) {

    title =
      "🟠 <b>PRESSION SELL ON-CHAIN</b>";
  }

  await safeTelegramSend(

    title +
    "\n\n" +

    "🪙 Token :\n" +
    "<code>" +
    watchedMint +
    "</code>\n\n" +

    "💰 Réserve WSOL : <b>" +
    formatSol(
      quoteReserveSol
    ) +
    "</b>\n\n" +

    "📉 Baisse réserve : <b>" +
    dropPercent.toFixed(2) +
    "%</b>\n" +

    "💸 Sortie estimée : <b>" +
    formatSol(dropSol) +
    "</b>\n\n" +

    "🔴 Direction : <b>" +
    direction +
    "</b>\n\n" +

    "⚡ <b>Signal on-chain direct.</b>\n" +
    "⚠️ La réserve vient de changer."
  );
}

// =====================================================
// TRAITEMENT D'UNE MISE À JOUR DE RÉSERVE
// =====================================================

async function processReserveUpdate(
  type,
  newRawAmount
) {

  if (
    newRawAmount === null
  ) {
    return;
  }

  if (type === "quote") {

    const newQuoteSol =
      Number(newRawAmount) /
      1_000_000_000;

    if (
      previousQuoteReserveSol === null
    ) {

      previousQuoteReserveSol =
        newQuoteSol;

      quoteReserveSol =
        newQuoteSol;

      return;
    }

    const oldQuote =
      previousQuoteReserveSol;

    const deltaSol =
      newQuoteSol - oldQuote;

    const dropSol =
      oldQuote - newQuoteSol;

    const dropPercent =
      oldQuote > 0
        ? (
            dropSol /
            oldQuote
          ) * 100
        : 0;

    quoteReserveSol =
      newQuoteSol;

    previousQuoteReserveSol =
      newQuoteSol;

    console.log(
      "⚡ WSOL :",
      formatSol(newQuoteSol),
      "| variation :",
      formatSol(deltaSol)
    );

    // Une baisse du coffre SOL
    // correspond typiquement à une vente
    if (
      dropSol > 0 &&
      (
        dropPercent >=
          TURBO_DROP_PERCENT ||
        dropSol >=
          TURBO_DROP_SOL
      )
    ) {

      await turboAlert({
        type: "quote",
        dropPercent,
        dropSol,
        direction: "SELL"
      });
    }

    return;
  }

  if (type === "base") {

    const newBase =
      Number(newRawAmount);

    if (
      previousBaseReserve === null
    ) {

      previousBaseReserve =
        newBase;

      baseReserve =
        newBase;

      return;
    }

    const oldBase =
      previousBaseReserve;

    const delta =
      newBase - oldBase;

    baseReserve =
      newBase;

    previousBaseReserve =
      newBase;

    console.log(
      "🪙 Base reserve variation :",
      delta
    );
  }
}

// =====================================================
// ABONNEMENT ON-CHAIN
// =====================================================

async function startOnChainMonitoring() {

  await stopOnChainMonitoring();

  if (
    !poolBaseVault ||
    !poolQuoteVault
  ) {

    console.error(
      "🔴 Vaults manquants"
    );

    return;
  }

  console.log(
    "⚡ Démarrage surveillance ON-CHAIN"
  );

  try {

    baseSubscription =
      await connection.onAccountChange(

        new PublicKey(
          poolBaseVault
        ),

        async (
          accountInfo,
          context
        ) => {

          const amount =
            readTokenAmount(
              accountInfo
            );

          if (amount !== null) {

            await processReserveUpdate(
              "base",
              amount
            );
          }

          console.log(
            "⚡ Base update slot :",
            context.slot
          );
        },

        {
          commitment: "processed",
          encoding: "jsonParsed"
        }
      );

    quoteSubscription =
      await connection.onAccountChange(

        new PublicKey(
          poolQuoteVault
        ),

        async (
          accountInfo,
          context
        ) => {

          const amount =
            readTokenAmount(
              accountInfo
            );

          if (amount !== null) {

            await processReserveUpdate(
              "quote",
              amount
            );
          }

          console.log(
            "⚡ Quote update slot :",
            context.slot
          );
        },

        {
          commitment: "processed",
          encoding: "jsonParsed"
        }
      );

    console.log(
      "🟢 ON-CHAIN TURBO ACTIVÉ"
    );

  } catch (error) {

    console.error(
      "🔴 WebSocket :",
      error.message
    );
  }
}

// =====================================================
// ARRÊT SURVEILLANCE ON-CHAIN
// =====================================================

async function stopOnChainMonitoring() {

  try {

    if (
      baseSubscription !== null
    ) {

      await connection.removeAccountChangeListener(
        baseSubscription
      );

      baseSubscription =
        null;
    }

    if (
      quoteSubscription !== null
    ) {

      await connection.removeAccountChangeListener(
        quoteSubscription
      );

      quoteSubscription =
        null;
    }

  } catch (error) {

    console.error(
      "🔴 Stop WebSocket :",
      error.message
    );
  }
}

// =====================================================
// TRADES ANAXER
// =====================================================

async function fetchTrades() {

  if (!watchedMint) {
    return [];
  }

  try {

    const url =
      "https://api.anaxer.com/v1/tokens/" +
      watchedMint +
      "/trades?source=pump_amm&solOnly=true&limit=50";

    const response =
      await fetch(
        url,
        {
          headers: {
            "x-api-key":
              anaxerApiKey
          }
        }
      );

    if (!response.ok) {

      console.error(
        "🔴 Anaxer :",
        response.status
      );

      return [];
    }

    const result =
      await response.json();

    return Array.isArray(result)
      ? result
      : result.data || [];

  } catch (error) {

    console.error(
      "🔴 Anaxer erreur :",
      error.message
    );

    return [];
  }
}

// =====================================================
// DIRECTION TRADE
// =====================================================

function getDirection(trade) {

  const from =
    trade.swap?.from;

  const to =
    trade.swap?.to;

  if (!from || !to) {
    return "UNKNOWN";
  }

  const fromMint =
    from.mint ||
    from.address ||
    "";

  const toMint =
    to.mint ||
    to.address ||
    "";

  if (
    fromMint === SOL_MINT &&
    toMint === watchedMint
  ) {
    return "BUY";
  }

  if (
    fromMint === watchedMint &&
    toMint === SOL_MINT
  ) {
    return "SELL";
  }

  return "UNKNOWN";
}

function tradeVolume(trade) {

  return Number(
    trade.volumeUsd ??
    trade.volume_usd ??
    trade.usdVolume ??
    0
  );
}

// =====================================================
// ANALYSE TRADES
// =====================================================

async function checkTrades() {

  if (!watchedMint) {
    return;
  }

  const trades =
    await fetchTrades();

  if (!trades.length) {
    return;
  }

  recentTrades =
    trades;

  let buyVolume = 0;
  let sellVolume = 0;

  for (const trade of trades) {

    const volume =
      tradeVolume(trade);

    const direction =
      getDirection(trade);

    if (direction === "BUY") {
      buyVolume += volume;
    }

    if (direction === "SELL") {
      sellVolume += volume;
    }
  }

  const total =
    buyVolume +
    sellVolume;

  const sellRatio =
    total > 0
      ? (
          sellVolume /
          total
        ) * 100
      : 0;

  console.log(
    "📊 Anaxer | BUY",
    formatUsd(buyVolume),
    "| SELL",
    formatUsd(sellVolume),
    "| SELL %",
    sellRatio.toFixed(1)
  );
}

// =====================================================
// LIQUIDITÉ CLASSIQUE
// =====================================================

async function checkLiquidity() {

  if (!watchedMint) {
    return;
  }

  const liquidity =
    await refreshDexLiquidity();

  if (!liquidity) {
    return;
  }

  console.log(
    "💧 DexScreener :",
    formatUsd(liquidity)
  );

  for (
    const alert of LIQUIDITY_LEVELS
  ) {

    if (
      liquidity <= alert.usd &&
      lastLiquidityAlert !==
        alert.usd
    ) {

      lastLiquidityAlert =
        alert.usd;

      await safeTelegramSend(

        alert.level +
        " <b>LIQUIDITÉ</b>\n\n" +

        "🪙 Token :\n" +
        "<code>" +
        watchedMint +
        "</code>\n\n" +

        "💧 Liquidité : <b>" +
        formatUsd(liquidity) +
        "</b>\n\n" +

        "🎯 Seuil : <b>" +
        formatUsd(alert.usd) +
        "</b>"
      );

      break;
    }
  }

  if (
    liquidity > 90000
  ) {

    lastLiquidityAlert =
      null;
  }
}

// =====================================================
// BOT
// =====================================================

const bot =
  new Telegraf(
    botToken
  );

// =====================================================
// WATCH
// =====================================================

bot.command(
  "watch",
  async ctx => {

    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    const mint =
      parts[1];

    if (!mint) {

      await ctx.reply(
        "❌ Utilise :\n/watch MINT"
      );

      return;
    }

    try {

      new PublicKey(mint);

    } catch {

      await ctx.reply(
        "❌ Adresse Solana invalide."
      );

      return;
    }

    watchedMint =
      mint;

    watchedPool =
      null;

    poolBaseVault =
      null;

    poolQuoteVault =
      null;

    baseReserve =
      null;

    quoteReserveSol =
      null;

    previousBaseReserve =
      null;

    previousQuoteReserveSol =
      null;

    currentLiquidity =
      null;

    highestLiquidity =
      null;

    lastLiquidityAlert =
      null;

    lastTurboAlert =
      0;

    await stopOnChainMonitoring();

    if (liquidityInterval) {
      clearInterval(
        liquidityInterval
      );
    }

    if (tradeInterval) {
      clearInterval(
        tradeInterval
      );
    }

    // Trouve le pool PumpSwap
    const pair =
      await fetchPumpSwapPool();

    if (!pair) {

      await ctx.reply(
        "❌ Pool PumpSwap introuvable."
      );

      return;
    }

    watchedPool =
      pair.pairAddress;

    const poolLoaded =
      await loadPoolVaults();

    if (!poolLoaded) {

      await ctx.reply(
        "❌ Impossible de lire le pool PumpSwap."
      );

      return;
    }

    const reservesLoaded =
      await loadInitialReserves();

    if (!reservesLoaded) {

      await ctx.reply(
        "❌ Impossible de lire les réserves du pool."
      );

      return;
    }

    await refreshDexLiquidity();

    await startOnChainMonitoring();

    await ctx.reply(

      "⚡ <b>RADAR TURBO ACTIVÉ</b>\n\n" +

      "🪙 Token :\n" +
      "<code>" +
      mint +
      "</code>\n\n" +

      "🏦 Pool :\n" +
      "<code>" +
      shortAddress(
        watchedPool
      ) +
      "</code>\n\n" +

      "⚡ <b>Réserves on-chain : temps réel</b>\n" +
      "💧 Liquidité : filet de sécurité 10s\n" +
      "📊 Trades : Anaxer 45s\n\n" +

      "🟠 Signal : réserve -1,5%\n" +
      "🔴 Signal fort : réserve -5%\n" +
      "🚨 Signal extrême : réserve -15%\n\n" +

      "💥 Grosse sortie : ≥ 5 SOL\n\n" +

      "⚠️ <b>Pas d'alerte à chaque trade.</b>",

      {
        parse_mode: "HTML"
      }
    );

    await checkLiquidity();
    await checkTrades();

    liquidityInterval =
      setInterval(
        checkLiquidity,
        LIQUIDITY_INTERVAL
      );

    tradeInterval =
      setInterval(
        checkTrades,
        TRADE_INTERVAL
      );
  }
);

// =====================================================
// STATUS
// =====================================================

bot.command(
  "status",
  async ctx => {

    if (!watchedMint) {

      await ctx.reply(
        "🟢 Bot opérationnel.\n\n" +
        "👁️ Aucun token surveillé."
      );

      return;
    }

    await ctx.reply(

      "🟢 <b>RADAR TURBO ACTIF</b>\n\n" +

      "🪙 Token :\n" +
      "<code>" +
      watchedMint +
      "</code>\n\n" +

      "🏦 Pool : <code>" +
      shortAddress(
        watchedPool
      ) +
      "</code>\n\n" +

      "💧 Liquidité : <b>" +
      (
        currentLiquidity !== null
          ? formatUsd(
              currentLiquidity
            )
          : "lecture..."
      ) +
      "</b>\n\n" +

      "💰 Réserve WSOL : <b>" +
      formatSol(
        quoteReserveSol
      ) +
      "</b>\n\n" +

      "📈 Plus haut : <b>" +
      (
        highestLiquidity !== null
          ? formatUsd(
              highestLiquidity
            )
          : "lecture..."
      ) +
      "</b>\n\n" +

      "⚡ Surveillance on-chain : <b>ACTIVE</b>",

      {
        parse_mode: "HTML"
      }
    );
  }
);

// =====================================================
// UNWATCH
// =====================================================

bot.command(
  "unwatch",
  async ctx => {

    watchedMint =
      null;

    watchedPool =
      null;

    poolBaseVault =
      null;

    poolQuoteVault =
      null;

    baseReserve =
      null;

    quoteReserveSol =
      null;

    previousBaseReserve =
      null;

    previousQuoteReserveSol =
      null;

    currentLiquidity =
      null;

    highestLiquidity =
      null;

    lastLiquidityAlert =
      null;

    lastTurboAlert =
      0;

    await stopOnChainMonitoring();

    if (liquidityInterval) {

      clearInterval(
        liquidityInterval
      );

      liquidityInterval =
        null;
    }

    if (tradeInterval) {

      clearInterval(
        tradeInterval
      );

      tradeInterval =
        null;
    }

    await ctx.reply(
      "🛑 Surveillance arrêtée."
    );
  }
);

// =====================================================
// LANCEMENT
// =====================================================

bot.launch();

console.log(
  "🤖 Pump Alert Bot TURBO démarré"
);

process.once(
  "SIGINT",
  async () => {

    await stopOnChainMonitoring();

    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  async () => {

    await stopOnChainMonitoring();

    bot.stop("SIGTERM");
  }
);
