const { Telegraf } = require("telegraf");
const { Connection, PublicKey } = require("@solana/web3.js");

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

// ============================================================
// ETAT
// ============================================================

let watchedMint = null;

let poolAddress = null;
let baseVault = null;
let quoteVault = null;

let baseSubscriptionId = null;
let quoteSubscriptionId = null;

let dexTimer = null;
let anaxerTimer = null;
let healthTimer = null;

let currentLiquidityUsd = null;

let currentBaseReserve = null;
let currentQuoteReserve = null;

let previousBaseReserve = null;
let previousQuoteReserve = null;

let highestLiquidity = 0;
let highestPrice = null;

let lastPriceUsd = null;

// Historique ultra court
const flowEvents = [];

// Dernière alerte
let lastAlertAt = 0;
let lastAlertType = "";

// ============================================================
// UTILITAIRES
// ============================================================

function now() {
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
  if (!address) {
    return "N/A";
  }

  const s = address.toString();

  return (
    s.slice(0, 6) +
    "..." +
    s.slice(-6)
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
// ALERTES
// ============================================================

async function alertOnce(
  type,
  message,
  cooldown = 4000
) {
  const current = now();

  if (
    type === lastAlertType &&
    current - lastAlertAt < cooldown
  ) {
    return;
  }

  lastAlertType = type;
  lastAlertAt = current;

  await sendTelegram(message);
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
        `HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    const pairs =
      data.pairs || [];

    const pumpPair =
      pairs.find(
        p =>
          p.chainId === "solana" &&
          p.dexId === "pumpswap"
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
// TROUVER LE POOL
// ============================================================

async function findPool(mint) {
  const pair =
    await getDexPair(mint);

  if (!pair) {
    throw new Error(
      "Pool PumpSwap introuvable."
    );
  }

  if (!pair.pairAddress) {
    throw new Error(
      "Adresse du pool absente."
    );
  }

  return {
    pool:
      new PublicKey(
        pair.pairAddress
      ),

    liquidityUsd:
      Number(
        pair.liquidity?.usd || 0
      ),

    priceUsd:
      Number(
        pair.priceUsd || 0
      )
  };
}

// ============================================================
// DECODER POOL PUMPSWAP
// ============================================================

function decodePoolVaults(data) {
  if (!data) {
    return null;
  }

  const buffer =
    Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);

  /*
    Layout PumpSwap :

    discriminator       8
    bump                 1
    index                2
    creator             32
    base_mint           32
    quote_mint          32
    lp_mint             32
    pool_base_vault     32
    pool_quote_vault    32

    base vault  = 139
    quote vault = 171
  */

  if (buffer.length < 203) {
    return null;
  }

  return {
    baseVault:
      new PublicKey(
        buffer.subarray(
          139,
          171
        )
      ),

    quoteVault:
      new PublicKey(
        buffer.subarray(
          171,
          203
        )
      )
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
    decodePoolVaults(
      info.data
    );

  if (!decoded) {
    throw new Error(
      "Impossible de décoder le pool."
    );
  }

  return decoded;
}

// ============================================================
// LECTURE TOKEN ACCOUNT
// ============================================================

function readRawTokenAmount(info) {
  if (!info) {
    return null;
  }

  try {
    const data =
      info.data;

    // Buffer
    if (
      Buffer.isBuffer(data)
    ) {
      if (data.length < 72) {
        return null;
      }

      return data.readBigUInt64LE(
        64
      );
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

      return buffer.readBigUInt64LE(
        64
      );
    }

    // Parsed
    const amount =
      data?.parsed?.info?.tokenAmount?.amount;

    if (
      amount !== undefined
    ) {
      return BigInt(amount);
    }

  } catch (error) {
    console.error(
      "🔴 Lecture token :",
      error.message
    );
  }

  return null;
}

// ============================================================
// RESERVES INITIALES
// ============================================================

async function loadInitialReserves() {
  const accounts =
    await connection.getMultipleAccountsInfo(
      [
        baseVault,
        quoteVault
      ],
      "processed"
    );

  if (
    !accounts ||
    accounts.length !== 2
  ) {
    return false;
  }

  const baseRaw =
    readRawTokenAmount(
      accounts[0]
    );

  const quoteRaw =
    readRawTokenAmount(
      accounts[1]
    );

  if (
    baseRaw === null ||
    quoteRaw === null
  ) {
    return false;
  }

  /*
    PumpSwap token accounts :

    quote WSOL = 9 decimals

    Le mint peut avoir des décimales différentes.
    On récupère ici les valeurs brutes.
  */

  currentQuoteReserve =
    Number(quoteRaw) / 1e9;

  currentBaseReserve =
    Number(baseRaw);

  previousQuoteReserve =
    currentQuoteReserve;

  previousBaseReserve =
    currentBaseReserve;

  return true;
}

// ============================================================
// HISTORIQUE DES FLUX
// ============================================================

function addFlow(type, amountSol) {
  flowEvents.push({
    type,
    amountSol,
    timestamp: now()
  });

  cleanupFlows();
}

function cleanupFlows() {
  const cutoff =
    now() - 15000;

  while (
    flowEvents.length &&
    flowEvents[0].timestamp < cutoff
  ) {
    flowEvents.shift();
  }
}

function getFlowStats(seconds) {
  const cutoff =
    now() -
    seconds * 1000;

  let sells = 0;
  let buys = 0;

  let sellCount = 0;
  let buyCount = 0;

  for (
    const event of flowEvents
  ) {
    if (
      event.timestamp < cutoff
    ) {
      continue;
    }

    if (
      event.type === "SELL"
    ) {
      sells += event.amountSol;
      sellCount++;
    }

    if (
      event.type === "BUY"
    ) {
      buys += event.amountSol;
      buyCount++;
    }
  }

  const total =
    sells + buys;

  const sellPct =
    total > 0
      ? (sells / total) * 100
      : 0;

  return {
    sells,
    buys,
    sellCount,
    buyCount,
    total,
    sellPct
  };
}

// ============================================================
// ANALYSE IMMEDIATE DU QUOTE VAULT
// ============================================================

async function processQuoteChange(
  newQuoteReserve
) {
  if (
    previousQuoteReserve === null
  ) {
    previousQuoteReserve =
      newQuoteReserve;

    currentQuoteReserve =
      newQuoteReserve;

    return;
  }

  const old =
    previousQuoteReserve;

  const change =
    newQuoteReserve - old;

  const decrease =
    old > 0
      ? ((old - newQuoteReserve) /
          old) *
        100
      : 0;

  currentQuoteReserve =
    newQuoteReserve;

  previousQuoteReserve =
    newQuoteReserve;

  /*
    QUOTE DOWN

    Le pool perd du WSOL.

    C'est compatible avec :
    - SELL
    - retrait
    - autre opération de liquidité

    On considère cela comme un
    "outflow" dangereux immédiatement.
  */

  if (
    change < 0
  ) {
    const outflow =
      Math.abs(change);

    addFlow(
      "SELL",
      outflow
    );

    console.log(
      `🔻 WSOL OUTFLOW ${outflow.toFixed(4)} SOL`
    );

    const stats1 =
      getFlowStats(1);

    const stats3 =
      getFlowStats(3);

    const stats5 =
      getFlowStats(5);

    // --------------------------------------------------------
    // SORTIE URGENTE
    // --------------------------------------------------------

    if (
      decrease >= 3 ||
      outflow >= 5 ||
      stats1.sellPct >= 85 ||
      stats3.sellPct >= 85
    ) {
      await alertOnce(
        "URGENT_OUTFLOW",
        `
🚨 <b>SIGNAL DE SORTIE URGENT</b>

<b>Sortie WSOL détectée :</b>
${formatSol(outflow)} SOL

<b>Baisse réserve :</b>
${decrease.toFixed(2)}%

<b>SELL 1s :</b>
${stats1.sellPct.toFixed(1)}%

<b>SELL 3s :</b>
${stats3.sellPct.toFixed(1)}%

<b>SELL 5s :</b>
${stats5.sellPct.toFixed(1)}%

<b>Réserve WSOL :</b>
${formatSol(currentQuoteReserve)} SOL

⚠️ Flux vendeur très agressif.
`,
        2000
      );

      return;
    }

    // --------------------------------------------------------
    // PRE-ALERTE
    // --------------------------------------------------------

    if (
      decrease >= 1 ||
      outflow >= 1 ||
      stats3.sellPct >= 70
    ) {
      await alertOnce(
        "SELL_PRESSURE",
        `
🟠 <b>PRESSION VENDEUSE</b>

<b>WSOL sorti :</b>
${formatSol(outflow)} SOL

<b>Variation réserve :</b>
-${decrease.toFixed(2)}%

<b>SELL 3s :</b>
${stats3.sellPct.toFixed(1)}%

<b>SELL 5s :</b>
${stats5.sellPct.toFixed(1)}%

<b>Réserve :</b>
${formatSol(currentQuoteReserve)} SOL

📡 Le radar détecte une accélération.
`,
        5000
      );
    }

    return;
  }

  /*
    QUOTE UP

    Le pool reçoit du WSOL.
    Cela correspond typiquement à un BUY.
  */

  if (
    change > 0
  ) {
    addFlow(
      "BUY",
      change
    );

    console.log(
      `🟢 WSOL INFLOW ${change.toFixed(4)} SOL`
    );
  }
}

// ============================================================
// ANALYSE VAULT TOKEN
// ============================================================

async function processBaseChange(
  newBaseRaw
) {
  if (
    previousBaseReserve === null
  ) {
    previousBaseReserve =
      newBaseRaw;

    currentBaseReserve =
      newBaseRaw;

    return;
  }

  const old =
    previousBaseReserve;

  const change =
    newBaseRaw - old;

  currentBaseReserve =
    newBaseRaw;

  previousBaseReserve =
    newBaseRaw;

  /*
    BASE UP + QUOTE DOWN
    = confirmation SELL

    BASE DOWN + QUOTE UP
    = confirmation BUY
  */

  if (
    change > 0 &&
    previousQuoteReserve !== null
  ) {
    console.log(
      "🔴 Base vault en hausse : SELL confirmé"
    );
  }

  if (
    change < 0 &&
    previousQuoteReserve !== null
  ) {
    console.log(
      "🟢 Base vault en baisse : BUY confirmé"
    );
  }
}

// ============================================================
// ABONNEMENT VAULT WSOL
// ============================================================

async function subscribeQuoteVault() {
  if (!quoteVault) {
    throw new Error(
      "Quote vault absent."
    );
  }

  if (
    quoteSubscriptionId !== null
  ) {
    try {
      await connection.removeAccountChangeListener(
        quoteSubscriptionId
      );
    } catch {}

    quoteSubscriptionId = null;
  }

  quoteSubscriptionId =
    await connection.onAccountChange(
      quoteVault,
      accountInfo => {
        try {
          const raw =
            readRawTokenAmount(
              accountInfo
            );

          if (raw === null) {
            return;
          }

          const reserve =
            Number(raw) / 1e9;

          /*
            IMPORTANT :

            L'alerte principale part
            directement d'ici.

            Aucun getParsedTransaction.
            Aucun confirmed.
            Aucun appel RPC supplémentaire.
          */

          processQuoteChange(
            reserve
          ).catch(error => {
            console.error(
              "🔴 Quote analysis :",
              error.message
            );
          });

        } catch (error) {
          console.error(
            "🔴 Quote callback :",
            error.message
          );
        }
      },
      {
        commitment: "processed",
        encoding: "base64"
      }
    );

  console.log(
    "🟢 Surveillance WSOL ACTIVE"
  );
}

// ============================================================
// ABONNEMENT VAULT TOKEN
// ============================================================

async function subscribeBaseVault() {
  if (!baseVault) {
    throw new Error(
      "Base vault absent."
    );
  }

  if (
    baseSubscriptionId !== null
  ) {
    try {
      await connection.removeAccountChangeListener(
        baseSubscriptionId
      );
    } catch {}

    baseSubscriptionId = null;
  }

  baseSubscriptionId =
    await connection.onAccountChange(
      baseVault,
      accountInfo => {
        try {
          const raw =
            readRawTokenAmount(
              accountInfo
            );

          if (raw === null) {
            return;
          }

          processBaseChange(
            Number(raw)
          );

        } catch (error) {
          console.error(
            "🔴 Base callback :",
            error.message
          );
        }
      },
      {
        commitment: "processed",
        encoding: "base64"
      }
    );

  console.log(
    "🟢 Surveillance TOKEN ACTIVE"
  );
}

// ============================================================
// LOGS PUMPSWAP
// ============================================================

let logsSubscriptionId = null;

async function subscribePoolLogs() {
  if (!poolAddress) {
    return;
  }

  if (
    logsSubscriptionId !== null
  ) {
    try {
      await connection.removeOnLogsListener(
        logsSubscriptionId
      );
    } catch {}

    logsSubscriptionId = null;
  }

  logsSubscriptionId =
    await connection.onLogs(
      poolAddress,
      info => {
        if (
          info.err
        ) {
          return;
        }

        const logs =
          info.logs || [];

        const joined =
          logs.join(" ").toLowerCase();

        /*
          On utilise les logs comme
          deuxième radar.

          On ne récupère PAS la transaction.
        */

        if (
          joined.includes("sell")
        ) {
          console.log(
            "⚠️ LOG PUMPSWAP SELL",
            info.signature
          );
        }

        if (
          joined.includes("buy")
        ) {
          console.log(
            "🟢 LOG PUMPSWAP BUY",
            info.signature
          );
        }
      },
      "processed"
    );

  console.log(
    "🟢 Surveillance LOGS ACTIVE"
  );
}

// ============================================================
// DEXSCREENER FILET DE SÉCURITÉ
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
      lastPriceUsd =
        price;

      if (
        highestPrice === null ||
        price > highestPrice
      ) {
        highestPrice =
          price;
      }
    }

    /*
      DexScreener n'est PLUS le radar principal.

      C'est seulement le filet de sécurité.
    */

    if (
      liquidity > 0 &&
      liquidity <= 50000
    ) {
      await alertOnce(
        "DEX_LOW",
        `
🔴 <b>LIQUIDITÉ DEX FAIBLE</b>

<b>Liquidité :</b>
$${formatUsd(liquidity)}

⚠️ Filet de sécurité.
`,
        30000
      );
    }

  } catch (error) {
    console.error(
      "🔴 Dex check :",
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
      return;
    }

    const data =
      await response.json();

    const list =
      data.trades ||
      data.data ||
      [];

    if (!Array.isArray(list)) {
      return;
    }

    const cutoff =
      now() - 10000;

    let buys = 0;
    let sells = 0;

    for (
      const trade of list
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
        sells += volume;
      }

      if (
        to === watchedMint
      ) {
        buys += volume;
      }
    }

    const total =
      buys + sells;

    if (
      total <= 0
    ) {
      return;
    }

    const sellPct =
      (sells / total) * 100;

    if (
      sellPct >= 85
    ) {
      await alertOnce(
        "ANAXER_SELL",
        `
🚨 <b>CONFIRMATION ANAXER</b>

<b>SELL 10s :</b>
${sellPct.toFixed(1)}%

<b>SELL :</b>
$${formatUsd(sells)}

<b>BUY :</b>
$${formatUsd(buys)}

⚠️ Confirmation externe du retournement.
`,
        10000
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

function getStatus() {
  const stats1 =
    getFlowStats(1);

  const stats3 =
    getFlowStats(3);

  const stats5 =
    getFlowStats(5);

  return `
📡 <b>RADAR SORTIE V2</b>

<b>Token :</b>
<code>${watchedMint || "Aucun"}</code>

<b>Pool :</b>
<code>${poolAddress ? shortAddress(poolAddress) : "N/A"}</code>

<b>WSOL :</b>
${quoteSubscriptionId !== null ? "🟢 ACTIVE" : "🔴 INACTIVE"}

<b>Vault TOKEN :</b>
${baseSubscriptionId !== null ? "🟢 ACTIVE" : "🔴 INACTIVE"}

<b>Logs PumpSwap :</b>
${logsSubscriptionId !== null ? "🟢 ACTIVE" : "🔴 INACTIVE"}

<b>Réserve WSOL :</b>
${formatSol(currentQuoteReserve)} SOL

<b>Liquidité DEX :</b>
$${formatUsd(currentLiquidityUsd)}

<b>Plus haute liquidité :</b>
$${formatUsd(highestLiquidity)}

<b>SELL 1s :</b>
${stats1.sellPct.toFixed(1)}%

<b>SELL 3s :</b>
${stats3.sellPct.toFixed(1)}%

<b>SELL 5s :</b>
${stats5.sellPct.toFixed(1)}%

<b>Flux SELL 5s :</b>
${formatSol(stats5.sells)} SOL

<b>Flux BUY 5s :</b>
${formatSol(stats5.buys)} SOL
`;
}

// ============================================================
// WATCH
// ============================================================

async function startWatch(mint) {
  try {
    await stopWatch();

    watchedMint =
      mint;

    await sendTelegram(
      "🔎 Recherche du pool PumpSwap..."
    );

    const found =
      await findPool(
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
        "Impossible de lire les réserves."
      );
    }

    flowEvents.length = 0;

    /*
      IMPORTANT :

      On démarre les trois radars
      sans getParsedTransaction.
    */

    await subscribeQuoteVault();

    await subscribeBaseVault();

    await subscribePoolLogs();

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
        () => {
          if (
            quoteSubscriptionId === null
          ) {
            console.log(
              "⚠️ Quote subscription absente"
            );
          }
        },
        5000
      );

    await checkDexLiquidity();

    await sendTelegram(
      `
🟢 <b>RADAR SORTIE V2 ACTIVÉ</b>

<b>Token :</b>
<code>${mint}</code>

<b>Pool :</b>
<code>${poolAddress.toString()}</code>

<b>Liquidité :</b>
$${formatUsd(currentLiquidityUsd)}

<b>Réserve WSOL :</b>
${formatSol(currentQuoteReserve)} SOL

<b>Vault WSOL :</b>
🟢 ACTIVE

<b>Vault TOKEN :</b>
🟢 ACTIVE

<b>Logs PumpSwap :</b>
🟢 ACTIVE

⚡ Détection directe des mouvements de réserve.

⚠️ Aucune attente de getParsedTransaction pour l'alerte principale.
`
    );

  } catch (error) {
    console.error(
      "❌ START WATCH :",
      error.message
    );

    await sendTelegram(
      `
❌ <b>ERREUR RADAR</b>

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
    clearInterval(
      dexTimer
    );

    dexTimer = null;
  }

  if (anaxerTimer) {
    clearInterval(
      anaxerTimer
    );

    anaxerTimer = null;
  }

  if (healthTimer) {
    clearInterval(
      healthTimer
    );

    healthTimer = null;
  }

  if (
    baseSubscriptionId !== null
  ) {
    try {
      await connection.removeAccountChangeListener(
        baseSubscriptionId
      );
    } catch {}

    baseSubscriptionId = null;
  }

  if (
    quoteSubscriptionId !== null
  ) {
    try {
      await connection.removeAccountChangeListener(
        quoteSubscriptionId
      );
    } catch {}

    quoteSubscriptionId = null;
  }

  if (
    logsSubscriptionId !== null
  ) {
    try {
      await connection.removeOnLogsListener(
        logsSubscriptionId
      );
    } catch {}

    logsSubscriptionId = null;
  }

  watchedMint = null;

  poolAddress = null;
  baseVault = null;
  quoteVault = null;

  currentLiquidityUsd = null;

  currentBaseReserve = null;
  currentQuoteReserve = null;

  previousBaseReserve = null;
  previousQuoteReserve = null;

  highestLiquidity = 0;
  highestPrice = null;
  lastPriceUsd = null;

  flowEvents.length = 0;
}

// ============================================================
// COMMANDES
// ============================================================

bot.command(
  "start",
  async ctx => {
    await ctx.reply(
      "📡 Radar PumpSwap prêt.\n\n" +
      "/watch ADRESSE_TOKEN\n" +
      "/status\n" +
      "/unwatch"
    );
  }
);

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
        "❌ Utilisation : /watch ADRESSE_TOKEN"
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
      "🔎 Initialisation du radar..."
    );

    await startWatch(
      mint
    );
  }
);

bot.command(
  "status",
  async ctx => {
    await ctx.reply(
      getStatus(),
      {
        parse_mode: "HTML"
      }
    );
  }
);

bot.command(
  "unwatch",
  async ctx => {
    await stopWatch();

    await ctx.reply(
      "🛑 Radar arrêté."
    );
  }
);

// ============================================================
// LANCEMENT
// ============================================================

bot.launch();

console.log(
  "🤖 Pump Radar V2 lancé."
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
