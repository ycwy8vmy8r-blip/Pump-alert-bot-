const { Telegraf } = require("telegraf");
const { Connection, PublicKey } = require("@solana/web3.js");
const WebSocket = require("ws");

// ============================================================
// CONFIG
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const ANAXER_API_KEY = process.env.ANAXER_API_KEY;

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  throw new Error(
    "BOT_TOKEN, CHAT_ID et HELIUS_API_KEY sont obligatoires."
  );
}

const bot = new Telegraf(BOT_TOKEN);

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, {
  commitment: "processed",
  wsEndpoint: WS_URL
});

// PumpSwap
const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

// WSOL
const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// Token surveillé
let watchedMint = null;

// Pool
let poolAddress = null;
let baseVault = null;
let quoteVault = null;

// WebSocket
let ws = null;
let wsReconnectTimer = null;
let wsSubscriptionId = null;
let wsReady = false;

// Intervalles
let dexTimer = null;
let anaxerTimer = null;
let healthTimer = null;

// Etat marché
let currentLiquidityUsd = null;
let lastDexLiquidity = null;

let currentQuoteReserve = null;
let currentBaseReserve = null;

let highestLiquidity = 0;
let highestPrice = null;

let lastPrice = null;

// Historique transactions
const trades = [];

// Dernière alerte
let lastAlertTime = 0;
let lastAlertType = "";

// Evite de traiter deux fois la même transaction
const processedSignatures = new Set();

// Limite mémoire
const MAX_SIGNATURES = 2000;

// ============================================================
// UTILITAIRES
// ============================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nowMs() {
  return Date.now();
}

function formatUsd(value) {
  if (value === null || value === undefined) {
    return "N/A";
  }

  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatSol(value) {
  if (value === null || value === undefined) {
    return "N/A";
  }

  return Number(value).toFixed(4);
}

function shortAddress(address) {
  if (!address) return "N/A";

  return (
    address.slice(0, 6) +
    "..." +
    address.slice(-6)
  );
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(message) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      message,
      {
        parse_mode: "HTML",
        disable_web_page_preview: true
      }
    );

    console.log("📨 Telegram envoyé");
  } catch (error) {
    console.error(
      "❌ Telegram :",
      error.message
    );
  }
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexPair(mint) {
  try {
    const response = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`
    );

    if (!response.ok) {
      throw new Error(
        `DexScreener HTTP ${response.status}`
      );
    }

    const data = await response.json();

    const pairs = data.pairs || [];

    const pumpPair =
      pairs.find(
        p =>
          p.dexId === "pumpswap" &&
          p.chainId === "solana"
      ) ||
      pairs.find(
        p =>
          p.chainId === "solana"
      );

    return pumpPair || null;

  } catch (error) {
    console.error(
      "🔴 DexScreener :",
      error.message
    );

    return null;
  }
}

// ============================================================
// TROUVER LE POOL PUMPSWAP
// ============================================================

async function findPumpSwapPool(mint) {
  const pair = await getDexPair(mint);

  if (!pair) {
    throw new Error(
      "Impossible de trouver le pool PumpSwap."
    );
  }

  const address =
    pair.pairAddress;

  if (!address) {
    throw new Error(
      "Le pool n'a pas d'adresse."
    );
  }

  return {
    pool: new PublicKey(address),
    liquidityUsd:
      Number(pair.liquidity?.usd || 0),
    priceUsd:
      Number(pair.priceUsd || 0),
    pair
  };
}

// ============================================================
// DECODER DU POOL PUMPSWAP
// ============================================================

function decodePoolVaults(data) {
  /*
    PumpSwap Pool layout :

    discriminator     8
    bump               1
    index              2
    creator           32
    base_mint         32
    quote_mint        32
    lp_mint           32
    pool_base_vault   32
    pool_quote_vault  32

    base vault offset  = 139
    quote vault offset = 171
  */

  if (!data) {
    return null;
  }

  const buffer =
    Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);

  if (buffer.length < 203) {
    return null;
  }

  const baseVault =
    new PublicKey(
      buffer.subarray(139, 171)
    );

  const quoteVault =
    new PublicKey(
      buffer.subarray(171, 203)
    );

  return {
    baseVault,
    quoteVault
  };
}

async function loadPoolVaults(pool) {
  const info =
    await connection.getAccountInfo(
      pool,
      "processed"
    );

  if (!info) {
    throw new Error(
      "Compte du pool introuvable."
    );
  }

  const decoded =
    decodePoolVaults(info.data);

  if (!decoded) {
    throw new Error(
      "Impossible de décoder les vaults du pool."
    );
  }

  return decoded;
}

// ============================================================
// LECTURE RESERVE TOKEN
// ============================================================

function readTokenAmount(accountInfo) {
  if (!accountInfo) {
    return null;
  }

  try {
    const data = accountInfo.data;

    // Buffer brut
    if (Buffer.isBuffer(data)) {
      if (data.length < 72) {
        return null;
      }

      return data.readBigUInt64LE(64);
    }

    // Base64
    if (
      Array.isArray(data) &&
      data.length >= 2 &&
      data[1] === "base64"
    ) {
      const buffer =
        Buffer.from(
          data[0],
          "base64"
        );

      if (buffer.length < 72) {
        return null;
      }

      return buffer.readBigUInt64LE(64);
    }

    // jsonParsed
    const parsed =
      data?.parsed?.info?.tokenAmount?.amount;

    if (parsed !== undefined) {
      return BigInt(parsed);
    }

  } catch (error) {
    console.error(
      "🔴 Lecture réserve :",
      error.message
    );
  }

  return null;
}

// ============================================================
// RESERVES INITIALES
// ============================================================

async function loadInitialReserves() {
  if (!baseVault || !quoteVault) {
    return false;
  }

  const accounts =
    await connection.getMultipleAccountsInfo(
      [
        baseVault,
        quoteVault
      ],
      "processed"
    );

  const baseAmount =
    readTokenAmount(accounts[0]);

  const quoteAmount =
    readTokenAmount(accounts[1]);

  if (
    baseAmount === null ||
    quoteAmount === null
  ) {
    return false;
  }

  currentBaseReserve =
    Number(baseAmount) / 1e6;

  currentQuoteReserve =
    Number(quoteAmount) / 1e9;

  return true;
}

// ============================================================
// PRIX APPROXIMATIF
// ============================================================

function calculatePriceSol() {
  if (
    !currentBaseReserve ||
    !currentQuoteReserve
  ) {
    return null;
  }

  if (currentBaseReserve <= 0) {
    return null;
  }

  return (
    currentQuoteReserve /
    currentBaseReserve
  );
}

// ============================================================
// HISTORIQUE DES TRADES
// ============================================================

function addTrade(type, quoteSol, signature) {
  const timestamp = nowMs();

  trades.push({
    type,
    quoteSol,
    timestamp,
    signature
  });

  // garde seulement 30 secondes
  const cutoff =
    timestamp - 30000;

  while (
    trades.length &&
    trades[0].timestamp < cutoff
  ) {
    trades.shift();
  }
}

// ============================================================
// STATS COURTES
// ============================================================

function getStats(seconds) {
  const cutoff =
    nowMs() - seconds * 1000;

  const recent =
    trades.filter(
      t => t.timestamp >= cutoff
    );

  let buys = 0;
  let sells = 0;
  let sellCount = 0;
  let buyCount = 0;

  for (const trade of recent) {
    if (trade.type === "SELL") {
      sells += trade.quoteSol;
      sellCount++;
    } else {
      buys += trade.quoteSol;
      buyCount++;
    }
  }

  const total =
    buys + sells;

  const sellPct =
    total > 0
      ? (sells / total) * 100
      : 0;

  return {
    buys,
    sells,
    sellPct,
    buyCount,
    sellCount,
    total
  };
}

// ============================================================
// ALERTE AVEC ANTI-SPAM
// ============================================================

async function smartAlert(
  type,
  message,
  cooldownMs = 4000
) {
  const now = nowMs();

  if (
    type === lastAlertType &&
    now - lastAlertTime < cooldownMs
  ) {
    return;
  }

  lastAlertTime = now;
  lastAlertType = type;

  await sendTelegram(message);
}

// ============================================================
// ANALYSE DU SIGNAL
// ============================================================

async function analyzeTradeSignal({
  type,
  quoteSol,
  signature
}) {
  const stats3 =
    getStats(3);

  const stats5 =
    getStats(5);

  const stats10 =
    getStats(10);

  const price =
    calculatePriceSol();

  // ----------------------------------------------------------
  // Niveau CRITIQUE
  // ----------------------------------------------------------

  if (
    type === "SELL" &&
    (
      stats3.sellPct >= 85 ||
      stats5.sellPct >= 85
    )
  ) {
    await smartAlert(
      "CRITICAL_SELL",
      `
🚨 <b>SIGNAL SORTIE CRITIQUE</b>

<b>SELL 3s :</b> ${stats3.sellPct.toFixed(1)}%
<b>SELL 5s :</b> ${stats5.sellPct.toFixed(1)}%
<b>SELL 10s :</b> ${stats10.sellPct.toFixed(1)}%

<b>Ventes 5s :</b> ${formatSol(stats5.sells)} SOL
<b>Achats 5s :</b> ${formatSol(stats5.buys)} SOL

<b>Prix :</b> ${price !== null ? price.toExponential(4) : "N/A"} SOL

⚠️ Pression vendeuse extrêmement forte.

Signature :
<code>${signature}</code>
`,
      2500
    );

    return;
  }

  // ----------------------------------------------------------
  // SELL PRESSURE FORTE
  // ----------------------------------------------------------

  if (
    type === "SELL" &&
    stats3.sellPct >= 70 &&
    stats5.sells >= 1
  ) {
    await smartAlert(
      "STRONG_SELL",
      `
🔴 <b>PRESSION SELL FORTE</b>

<b>SELL 3s :</b> ${stats3.sellPct.toFixed(1)}%
<b>SELL 5s :</b> ${stats5.sellPct.toFixed(1)}%
<b>SELL 10s :</b> ${stats10.sellPct.toFixed(1)}%

<b>Volume SELL 5s :</b> ${formatSol(stats5.sells)} SOL
<b>Volume BUY 5s :</b> ${formatSol(stats5.buys)} SOL

⚠️ Plusieurs ventes rapprochées détectées.
`,
      4000
    );

    return;
  }

  // ----------------------------------------------------------
  // ACCELERATION SELL
  // ----------------------------------------------------------

  if (
    type === "SELL" &&
    stats3.sellPct >= 60 &&
    stats3.sellCount >= 3
  ) {
    await smartAlert(
      "SELL_ACCELERATION",
      `
🟠 <b>ACCÉLÉRATION DES VENTES</b>

<b>SELL 3s :</b> ${stats3.sellPct.toFixed(1)}%
<b>Nombre de SELL :</b> ${stats3.sellCount}

<b>Volume SELL :</b> ${formatSol(stats3.sells)} SOL
<b>Volume BUY :</b> ${formatSol(stats3.buys)} SOL

📡 Le radar commence à voir un retournement.
`,
      6000
    );
  }
}

// ============================================================
// ANALYSE TRANSACTION
// ============================================================

function getAccountKeyString(accountKey) {
  if (!accountKey) {
    return null;
  }

  if (typeof accountKey === "string") {
    return accountKey;
  }

  if (accountKey.pubkey) {
    return accountKey.pubkey.toString();
  }

  return null;
}

function extractVaultDelta(
  transaction,
  vaultAddress
) {
  if (
    !transaction ||
    !transaction.meta ||
    !transaction.transaction
  ) {
    return null;
  }

  const meta =
    transaction.meta;

  const accountKeys =
    transaction.transaction.message.accountKeys || [];

  const vaultIndex =
    accountKeys.findIndex(
      key =>
        getAccountKeyString(key) ===
        vaultAddress.toString()
    );

  if (vaultIndex === -1) {
    return null;
  }

  const pre =
    (meta.preTokenBalances || [])
      .find(
        b =>
          b.accountIndex ===
          vaultIndex
      );

  const post =
    (meta.postTokenBalances || [])
      .find(
        b =>
          b.accountIndex ===
          vaultIndex
      );

  if (!pre || !post) {
    return null;
  }

  const preAmount =
    BigInt(
      pre.uiTokenAmount.amount
    );

  const postAmount =
    BigInt(
      post.uiTokenAmount.amount
    );

  return {
    delta:
      postAmount - preAmount,
    pre: preAmount,
    post: postAmount,
    decimals:
      post.uiTokenAmount.decimals
  };
}

// ============================================================
// TRAITEMENT D'UNE TRANSACTION
// ============================================================

async function processSignature(signature) {
  if (!signature) {
    return;
  }

  if (
    processedSignatures.has(signature)
  ) {
    return;
  }

  processedSignatures.add(signature);

  if (
    processedSignatures.size >
    MAX_SIGNATURES
  ) {
    const first =
      processedSignatures.values().next().value;

    processedSignatures.delete(first);
  }

  try {
    const tx =
      await connection.getParsedTransaction(
        signature,
        {
          commitment: "processed",
          maxSupportedTransactionVersion: 0
        }
      );

    if (!tx || !tx.meta) {
      return;
    }

    if (tx.meta.err) {
      return;
    }

    const quote =
      extractVaultDelta(
        tx,
        quoteVault
      );

    const base =
      extractVaultDelta(
        tx,
        baseVault
      );

    if (!quote || !base) {
      return;
    }

    const quoteDeltaSol =
      Number(quote.delta) /
      1e9;

    const baseDelta =
      Number(base.delta) /
      Math.pow(
        10,
        base.decimals
      );

    /*
      SELL :

      trader donne des tokens
      -> base vault augmente

      trader reçoit du SOL
      -> quote vault diminue
    */

    let type = null;

    if (
      quoteDeltaSol < 0 &&
      baseDelta > 0
    ) {
      type = "SELL";
    }

    /*
      BUY :

      quote vault augmente
      base vault diminue
    */

    else if (
      quoteDeltaSol > 0 &&
      baseDelta < 0
    ) {
      type = "BUY";
    }

    if (!type) {
      return;
    }

    const volume =
      Math.abs(quoteDeltaSol);

    if (volume <= 0) {
      return;
    }

    // Mise à jour réserve
    if (quote.post !== undefined) {
      currentQuoteReserve =
        Number(quote.post) / 1e9;
    }

    if (base.post !== undefined) {
      currentBaseReserve =
        Number(base.post) /
        Math.pow(
          10,
          base.decimals
        );
    }

    const oldPrice =
      lastPrice;

    const newPrice =
      calculatePriceSol();

    lastPrice =
      newPrice;

    addTrade(
      type,
      volume,
      signature
    );

    console.log(
      `${type} | ${volume.toFixed(4)} SOL | ${signature}`
    );

    // --------------------------------------------------------
    // GROSSE VENTE INDIVIDUELLE
    // --------------------------------------------------------

    if (
      type === "SELL" &&
      volume >= 3
    ) {
      await smartAlert(
        "BIG_SELL",
        `
⚠️ <b>GROSSE VENTE DÉTECTÉE</b>

<b>Montant :</b> ${volume.toFixed(3)} SOL

<b>SELL 3s :</b> ${getStats(3).sellPct.toFixed(1)}%
<b>SELL 5s :</b> ${getStats(5).sellPct.toFixed(1)}%

<b>Réserve WSOL :</b> ${formatSol(currentQuoteReserve)} SOL

<b>Signature :</b>
<code>${signature}</code>
`,
        3000
      );
    }

    // --------------------------------------------------------
    // CHUTE DE PRIX
    // --------------------------------------------------------

    if (
      type === "SELL" &&
      oldPrice &&
      newPrice
    ) {
      const priceChange =
        ((newPrice - oldPrice) /
          oldPrice) *
        100;

      if (priceChange <= -5) {
        await smartAlert(
          "PRICE_DROP",
          `
🚨 <b>CHUTE RAPIDE DU PRIX</b>

<b>Variation transaction :</b> ${priceChange.toFixed(2)}%

<b>SELL :</b> ${volume.toFixed(3)} SOL

<b>Réserve WSOL :</b> ${formatSol(currentQuoteReserve)} SOL

⚠️ Risque de cascade de ventes.
`,
          2500
        );
      }
    }

    await analyzeTradeSignal({
      type,
      quoteSol: volume,
      signature
    });

  } catch (error) {
    console.error(
      "🔴 Analyse transaction :",
      error.message
    );
  }
}

// ============================================================
// WEBSOCKET PUMPSWAP
// ============================================================

function startWebSocket() {
  if (!poolAddress) {
    return;
  }

  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  console.log(
    "📡 Connexion WebSocket..."
  );

  wsReady = false;

  ws =
    new WebSocket(WS_URL);

  ws.on("open", () => {
    console.log(
      "🟢 WebSocket connecté"
    );

    wsReady = true;

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [
        {
          mentions: [
            poolAddress.toString()
          ]
        },
        {
          commitment: "processed"
        }
      ]
    };

    ws.send(
      JSON.stringify(request)
    );
  });

  ws.on("message", async data => {
    try {
      const message =
        JSON.parse(
          data.toString()
        );

      // Confirmation abonnement
      if (
        message.result &&
        message.id === 1
      ) {
        wsSubscriptionId =
          message.result;

        console.log(
          "🟢 Surveillance pool active :",
          poolAddress.toString()
        );

        return;
      }

      const value =
        message?.params?.result?.value;

      if (!value) {
        return;
      }

      if (value.err) {
        return;
      }

      const signature =
        value.signature;

      if (!signature) {
        return;
      }

      /*
        Petite attente pour laisser le RPC
        rendre la transaction disponible.
      */

      await sleep(20);

      await processSignature(
        signature
      );

    } catch (error) {
      console.error(
        "🔴 WebSocket message :",
        error.message
      );
    }
  });

  ws.on("error", error => {
    console.error(
      "🔴 WebSocket :",
      error.message
    );
  });

  ws.on("close", () => {
    console.log(
      "🟠 WebSocket fermé"
    );

    wsReady = false;

    if (wsReconnectTimer) {
      return;
    }

    wsReconnectTimer =
      setTimeout(() => {
        wsReconnectTimer = null;

        if (watchedMint) {
          startWebSocket();
        }

      }, 1500);
  });
}

// ============================================================
// DEX LIQUIDITY FALLBACK
// ============================================================

async function checkDexLiquidity() {
  if (!watchedMint) {
    return;
  }

  try {
    const pair =
      await getDexPair(
        watchedMint
      );

    if (!pair) {
      return;
    }

    const liquidity =
      Number(
        pair.liquidity?.usd || 0
      );

    const price =
      Number(
        pair.priceUsd || 0
      );

    currentLiquidityUsd =
      liquidity;

    if (
      liquidity >
      highestLiquidity
    ) {
      highestLiquidity =
        liquidity;
    }

    if (
      price > 0
    ) {
      highestPrice =
        highestPrice === null
          ? price
          : Math.max(
              highestPrice,
              price
            );
    }

    // chute liquidité
    if (
      lastDexLiquidity &&
      lastDexLiquidity > 0
    ) {
      const change =
        ((liquidity -
          lastDexLiquidity) /
          lastDexLiquidity) *
        100;

      if (change <= -5) {
        await smartAlert(
          "DEX_LIQUIDITY_DROP",
          `
🚨 <b>BAISSE LIQUIDITÉ</b>

<b>Avant :</b> $${formatUsd(lastDexLiquidity)}
<b>Maintenant :</b> $${formatUsd(liquidity)}

<b>Variation :</b> ${change.toFixed(2)}%

⚠️ Filet de sécurité DexScreener.
`,
          4000
        );
      }
    }

    lastDexLiquidity =
      liquidity;

    // seuils absolus
    if (
      liquidity > 0 &&
      liquidity <= 5000
    ) {
      await smartAlert(
        "LIQUIDITY_5K",
        `
🚨 <b>LIQUIDITÉ CRITIQUE</b>

💧 <b>$${formatUsd(liquidity)}</b>

Le pool est extrêmement dégradé.
`,
        10000
      );

    } else if (
      liquidity > 0 &&
      liquidity <= 20000
    ) {
      await smartAlert(
        "LIQUIDITY_20K",
        `
🔴 <b>LIQUIDITÉ TRÈS FAIBLE</b>

💧 <b>$${formatUsd(liquidity)}</b>
`,
        15000
      );

    } else if (
      liquidity > 0 &&
      liquidity <= 50000
    ) {
      await smartAlert(
        "LIQUIDITY_50K",
        `
🟠 <b>LIQUIDITÉ EN BAISSE</b>

💧 <b>$${formatUsd(liquidity)}</b>
`,
        30000
      );
    }

  } catch (error) {
    console.error(
      "🔴 Liquidity check :",
      error.message
    );
  }
}

// ============================================================
// ANAXER
// ============================================================

async function checkAnaxer() {
  if (
    !watchedMint ||
    !ANAXER_API_KEY
  ) {
    return;
  }

  try {
    const url =
      `https://api.anaxer.io/v1/tokens/${watchedMint}/trades` +
      `?source=pump_amm` +
      `&solOnly=true` +
      `&limit=50`;

    const response =
      await fetch(
        url,
        {
          headers: {
            "x-api-key":
              ANAXER_API_KEY
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `Anaxer HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const tradesData =
      data.trades ||
      data.data ||
      [];

    if (!Array.isArray(tradesData)) {
      return;
    }

    const cutoff =
      Date.now() - 10000;

    let buy = 0;
    let sell = 0;

    for (
      const trade of tradesData
    ) {
      const timestamp =
        new Date(
          trade.timestamp
        ).getTime();

      if (
        Number.isFinite(timestamp) &&
        timestamp < cutoff
      ) {
        continue;
      }

      const volume =
        Number(
          trade.volumeUsd || 0
        );

      if (
        !Number.isFinite(volume)
      ) {
        continue;
      }

      const from =
        String(
          trade.swap?.from?.mint ||
          trade.swap?.from?.address ||
          ""
        );

      const to =
        String(
          trade.swap?.to?.mint ||
          trade.swap?.to?.address ||
          ""
        );

      if (
        from === watchedMint
      ) {
        sell += volume;
      }

      if (
        to === watchedMint
      ) {
        buy += volume;
      }
    }

    const total =
      buy + sell;

    if (total <= 0) {
      return;
    }

    const sellPct =
      (sell / total) * 100;

    if (
      sellPct >= 85
    ) {
      await smartAlert(
        "ANAXER_EXTREME",
        `
🚨 <b>ANAXER : SELL EXTRÊME</b>

<b>SELL 10s :</b> ${sellPct.toFixed(1)}%

<b>SELL :</b> $${formatUsd(sell)}
<b>BUY :</b> $${formatUsd(buy)}

⚠️ Confirmation externe du retournement.
`,
        8000
      );
    }

  } catch (error) {
    console.error(
      "🔴 Anaxer :",
      error.message
    );
  }
}

// ============================================================
// STATUS
// ============================================================

function statusMessage() {
  const s3 =
    getStats(3);

  const s5 =
    getStats(5);

  const s10 =
    getStats(10);

  return `
📡 <b>RADAR SORTIE</b>

<b>Token :</b>
<code>${watchedMint || "Aucun"}</code>

<b>Pool :</b>
<code>${poolAddress ? shortAddress(poolAddress.toString()) : "N/A"}</code>

<b>WebSocket :</b>
${wsReady ? "🟢 ACTIVE" : "🔴 INACTIVE"}

<b>Réserve WSOL :</b>
${formatSol(currentQuoteReserve)} SOL

<b>Réserve token :</b>
${formatSol(currentBaseReserve)}

<b>Liquidité Dex :</b>
$${formatUsd(currentLiquidityUsd)}

<b>Plus haute liquidité :</b>
$${formatUsd(highestLiquidity)}

<b>SELL 3s :</b>
${s3.sellPct.toFixed(1)}%

<b>SELL 5s :</b>
${s5.sellPct.toFixed(1)}%

<b>SELL 10s :</b>
${s10.sellPct.toFixed(1)}%

<b>Ventes 5s :</b>
${formatSol(s5.sells)} SOL

<b>Achats 5s :</b>
${formatSol(s5.buys)} SOL
`;
}

// ============================================================
// WATCH
// ============================================================

async function startWatch(mint) {
  try {
    await stopWatch();

    watchedMint = mint;

    console.log(
      "🔎 Recherche pool..."
    );

    const found =
      await findPumpSwapPool(
        mint
      );

    poolAddress =
      found.pool;

    currentLiquidityUsd =
      found.liquidityUsd;

    highestLiquidity =
      found.liquidityUsd;

    highestPrice =
      found.priceUsd;

    console.log(
      "🏊 Pool :",
      poolAddress.toString()
    );

    const vaults =
      await loadPoolVaults(
        poolAddress
      );

    baseVault =
      vaults.baseVault;

    quoteVault =
      vaults.quoteVault;

    console.log(
      "🪙 Base vault :",
      baseVault.toString()
    );

    console.log(
      "💰 Quote vault :",
      quoteVault.toString()
    );

    const reservesOk =
      await loadInitialReserves();

    if (!reservesOk) {
      throw new Error(
        "Impossible de lire les réserves du pool."
      );
    }

    trades.length = 0;
    processedSignatures.clear();

    lastDexLiquidity = null;
    lastPrice = calculatePriceSol();

    startWebSocket();

    dexTimer =
      setInterval(
        checkDexLiquidity,
        10000
      );

    anaxerTimer =
      setInterval(
        checkAnaxer,
        30000
      );

    healthTimer =
      setInterval(
        checkWebSocketHealth,
        5000
      );

    await checkDexLiquidity();

    await sendTelegram(
      `
🟢 <b>RADAR ACTIVÉ</b>

<b>Token :</b>
<code>${mint}</code>

<b>Pool :</b>
<code>${poolAddress.toString()}</code>

<b>Liquidité :</b>
$${formatUsd(currentLiquidityUsd)}

<b>Réserve WSOL :</b>
${formatSol(currentQuoteReserve)} SOL

<b>WebSocket :</b>
🟢 surveillance transactions ACTIVE

<b>Détection :</b>
SELL / BUY
3s / 5s / 10s
Prix
Réserve WSOL
Liquidité

📡 Le radar est prêt.
`
    );

  } catch (error) {
    console.error(
      "❌ Watch :",
      error
    );

    await sendTelegram(
      `
❌ <b>Échec surveillance</b>

${error.message}
`
    );
  }
}

// ============================================================
// STOP
// ============================================================

async function stopWatch() {
  if (dexTimer) {
    clearInterval(dexTimer);
    dexTimer = null;
  }

  if (anaxerTimer) {
    clearInterval(anaxerTimer);
    anaxerTimer = null;
  }

  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }

  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  if (ws) {
    try {
      ws.close();
    } catch {}
  }

  ws = null;
  wsReady = false;
  wsSubscriptionId = null;

  watchedMint = null;

  poolAddress = null;
  baseVault = null;
  quoteVault = null;

  currentLiquidityUsd = null;
  currentQuoteReserve = null;
  currentBaseReserve = null;

  highestLiquidity = 0;
  highestPrice = null;
  lastPrice = null;

  lastDexLiquidity = null;

  trades.length = 0;
  processedSignatures.clear();
}

// ============================================================
// HEALTH CHECK
// ============================================================

async function checkWebSocketHealth() {
  if (!watchedMint) {
    return;
  }

  if (!wsReady) {
    console.log(
      "⚠️ WebSocket non connecté"
    );
  }
}

// ============================================================
// COMMANDES TELEGRAM
// ============================================================

bot.command("start", async ctx => {
  await ctx.reply(
    "📡 Radar PumpSwap prêt.\n\n" +
    "Utilise :\n" +
    "/watch TON_MINT\n" +
    "/status\n" +
    "/unwatch"
  );
});

bot.command("watch", async ctx => {
  const parts =
    ctx.message.text
      .trim()
      .split(/\s+/);

  const mint =
    parts[1];

  if (!mint) {
    await ctx.reply(
      "❌ Utilisation :\n/watch ADRESSE_DU_TOKEN"
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

  await ctx.reply(
    "🔎 Analyse du token et recherche du pool..."
  );

  await startWatch(mint);
});

bot.command("status", async ctx => {
  await ctx.reply(
    statusMessage(),
    {
      parse_mode: "HTML"
    }
  );
});

bot.command("unwatch", async ctx => {
  await stopWatch();

  await ctx.reply(
    "🛑 Surveillance arrêtée."
  );
});

// ============================================================
// LANCEMENT
// ============================================================

bot.launch();

console.log(
  "🤖 Pump Radar lancé."
);

process.once(
  "SIGINT",
  () => {
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    bot.stop("SIGTERM");
  }
);
