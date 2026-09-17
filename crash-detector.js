const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// Token surveillé
const MINT =
  "GE4EfPtjfYfA8AmFsfJ6GBE7XAtxHSWsfwmaiQQLh2YS";

// PumpSwap / Pump AMM
const PUMPSWAP_PROGRAM_ID =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

// SOL wrapped mint
const SOL_MINT =
  "So11111111111111111111111111111111111111112";

// USDC
const USDC_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// RPC
const HTTP_RPC =
  "https://api.mainnet-beta.solana.com";

const WS_RPC =
  "wss://api.mainnet-beta.solana.com/";

// DexScreener
const DEX_API =
  `https://api.dexscreener.com/token-pairs/v1/solana/${MINT}`;

// Surveillance
const MONITOR_INTERVAL_MS = 5000;

// Historique
const HISTORY_WINDOW_MS = 120000;

// WebSocket considéré comme trop vieux après 15 secondes
const WS_STALE_MS = 15000;

// Reconnexion WS
const WS_RECONNECT_MS = 10000;

// Cooldown Telegram
const TELEGRAM_COOLDOWN_MS = 30000;

// ============================================================
// SEUILS DEXSCREENER
// ============================================================

const DEX_WATCH_LIQ_5S = -5;
const DEX_WATCH_LIQ_10S = -10;
const DEX_WATCH_PRICE_5S = -5;

const DEX_DANGER_LIQ_5S = -10;
const DEX_DANGER_LIQ_10S = -20;
const DEX_DANGER_PRICE_5S = -10;

const DEX_CRITICAL_LIQ_5S = -20;
const DEX_CRITICAL_LIQ_10S = -40;
const DEX_CRITICAL_PRICE_5S = -20;

// ============================================================
// SEUILS ON-CHAIN
// ============================================================
//
// On distingue volontairement plusieurs comportements.
//
// SELL PRESSURE :
// SOL reserve baisse + token reserve augmente
//
// LIQUIDITY REMOVAL :
// SOL reserve ET token reserve baissent ensemble
//
// Cela évite de considérer automatiquement un simple achat/vente
// comme une disparition de liquidité.
// ============================================================

// Pression vendeuse
const ONCHAIN_WATCH_SOL_OUT_5S = -5;
const ONCHAIN_DANGER_SOL_OUT_5S = -10;
const ONCHAIN_CRITICAL_SOL_OUT_5S = -20;

// Retrait potentiel de liquidité
const ONCHAIN_WATCH_LIQ_DROP_5S = -5;
const ONCHAIN_DANGER_LIQ_DROP_5S = -10;
const ONCHAIN_CRITICAL_LIQ_DROP_5S = -20;

// ============================================================
// DATA
// ============================================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, {
    recursive: true
  });
}

const LOG_FILE =
  path.join(
    DATA_DIR,
    "crash_radar_v2.jsonl"
  );

// ============================================================
// ETAT GENERAL
// ============================================================

let poolAddress = null;

let tokenVault = null;
let solVault = null;

let tokenDecimals = 6;

let currentPriceUsd = null;

// Dernière liquidité Dex valide
let currentDexLiquidityUsd = null;

// Dernière liquidité Dex brute reçue
let rawDexLiquidityUsd = null;

let dexLiquidityValid = false;

let currentSolPriceUsd = null;

// ============================================================
// ETAT ON-CHAIN
// ============================================================

let solReserve = null;
let tokenReserve = null;

let lastSolUpdateTime = 0;
let lastTokenUpdateTime = 0;

let lastSolSlot = null;
let lastTokenSlot = null;

// ============================================================
// HISTORIQUES
// ============================================================

let dexHistory = [];

let onchainHistory = [];

// ============================================================
// ETAT RADAR
// ============================================================

let dexLevel = "NORMAL";
let onchainLevel = "NORMAL";
let combinedLevel = "NORMAL";

let lastTelegramTime = 0;

let ws = null;
let reconnectTimer = null;

let wsConnected = false;

let monitoring = false;

// Abonnements WebSocket
let tokenSubscriptionId = null;
let solSubscriptionId = null;

// ============================================================
// UTILITAIRES
// ============================================================

function formatNumber(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  if (Math.abs(value) < 0.000001) {
    return value.toExponential(4);
  }

  if (Math.abs(value) < 0.01) {
    return value.toFixed(8);
  }

  if (Math.abs(value) < 1) {
    return value.toFixed(6);
  }

  return value.toFixed(4);
}

function formatUsd(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  if (value >= 1000000) {
    return `$${(
      value / 1000000
    ).toFixed(2)}M`;
  }

  if (value >= 1000) {
    return `$${(
      value / 1000
    ).toFixed(2)}k`;
  }

  return `$${value.toFixed(2)}`;
}

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}

function percentChange(
  current,
  previous
) {
  if (
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous === 0
  ) {
    return null;
  }

  return (
    ((current - previous) /
      previous) *
    100
  );
}

function addBoundedHistory(
  array,
  item
) {
  array.push(item);

  const cutoff =
    Date.now() -
    HISTORY_WINDOW_MS;

  while (
    array.length > 0 &&
    array[0].timestamp < cutoff
  ) {
    array.shift();
  }
}

function getHistoryAt(
  array,
  seconds
) {
  if (
    array.length === 0
  ) {
    return null;
  }

  const target =
    Date.now() -
    seconds * 1000;

  let best =
    array[0];

  let bestDiff =
    Math.abs(
      best.timestamp -
      target
    );

  for (
    const item of array
  ) {
    const diff =
      Math.abs(
        item.timestamp -
        target
      );

    if (
      diff < bestDiff
    ) {
      best = item;
      bestDiff = diff;
    }
  }

  return best;
}

// ============================================================
// BASE58
// ============================================================

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function bs58Encode(buffer) {
  if (
    !buffer ||
    buffer.length === 0
  ) {
    return "";
  }

  const digits = [0];

  for (
    const byte of buffer
  ) {
    let carry = byte;

    for (
      let i = 0;
      i < digits.length;
      i++
    ) {
      const value =
        digits[i] * 256 +
        carry;

      digits[i] =
        value % 58;

      carry =
        Math.floor(
          value / 58
        );
    }

    while (
      carry > 0
    ) {
      digits.push(
        carry % 58
      );

      carry =
        Math.floor(
          carry / 58
        );
    }
  }

  let result = "";

  for (
    let i = 0;
    i < buffer.length &&
    buffer[i] === 0;
    i++
  ) {
    result += "1";
  }

  for (
    let i = digits.length - 1;
    i >= 0;
    i--
  ) {
    result +=
      BASE58_ALPHABET[
        digits[i]
      ];
  }

  return result;
}

// ============================================================
// TELEGRAM
// ============================================================

async function sendTelegram(
  message
) {
  if (
    !BOT_TOKEN ||
    !CHAT_ID
  ) {
    console.log(
      "⚠️ BOT_TOKEN ou CHAT_ID absent."
    );

    return;
  }

  try {
    const url =
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

    const response =
      await fetch(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type":
              "application/json"
          },
          body:
            JSON.stringify({
              chat_id:
                CHAT_ID,
              text:
                message,
              disable_web_page_preview:
                true
            })
        }
      );

    if (
      !response.ok
    ) {
      console.log(
        `⚠️ Telegram HTTP ${response.status}`
      );
    }
  } catch (
    error
  ) {
    console.log(
      "⚠️ Erreur Telegram :",
      error.message
    );
  }
}

// ============================================================
// RPC HTTP
// ============================================================

async function rpcRequest(
  method,
  params = []
) {
  const response =
    await fetch(
      HTTP_RPC,
      {
        method: "POST",
        headers: {
          "Content-Type":
            "application/json"
        },
        body:
          JSON.stringify({
            jsonrpc:
              "2.0",
            id:
              Date.now(),
            method,
            params
          })
      }
    );

  if (
    response.status ===
    429
  ) {
    throw new Error(
      "RPC HTTP 429"
    );
  }

  if (
    !response.ok
  ) {
    throw new Error(
      `RPC HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (
    data.error
  ) {
    throw new Error(
      data.error.message ||
      "Erreur RPC"
    );
  }

  return data.result;
}

// ============================================================
// DEXSCREENER
// ============================================================

async function getDexData() {
  const response =
    await fetch(
      DEX_API,
      {
        headers: {
          Accept:
            "application/json"
        }
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  if (
    !Array.isArray(data)
  ) {
    throw new Error(
      "Réponse DexScreener invalide"
    );
  }

  const pumpswapPairs =
    data.filter(
      pair =>
        pair &&
        pair.dexId ===
          "pumpswap"
    );

  if (
    pumpswapPairs.length ===
    0
  ) {
    throw new Error(
      "Aucune paire PumpSwap trouvée"
    );
  }

  pumpswapPairs.sort(
    (a, b) => {
      const liqA =
        Number(
          a?.liquidity?.usd
        ) || 0;

      const liqB =
        Number(
          b?.liquidity?.usd
        ) || 0;

      return liqB - liqA;
    }
  );

  const pair =
    pumpswapPairs[0];

  const priceUsd =
    Number(
      pair.priceUsd
    );

  const liquidityUsd =
    Number(
      pair?.liquidity?.usd
    );

  if (
    !Number.isFinite(
      priceUsd
    )
  ) {
    throw new Error(
      "Prix USD invalide"
    );
  }

  return {
    pair,
    priceUsd,
    liquidityUsd
  };
}

// ============================================================
// SOL PRICE
// ============================================================

async function getSolPriceUsd() {
  try {
    const url =
      "https://api.dexscreener.com/token-pairs/v1/solana/" +
      SOL_MINT;

    const response =
      await fetch(
        url,
        {
          headers: {
            Accept:
              "application/json"
          }
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `DexScreener SOL HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    if (
      !Array.isArray(data)
    ) {
      throw new Error(
        "Réponse SOL invalide"
      );
    }

    const stableMints =
      new Set([
        USDC_MINT,
        "Es9vMFrzaCERmJfrF4H2FYD4mHfFqZ2eXfWm6gkT9Q"
      ]);

    const candidates =
      data.filter(
        pair => {
          if (!pair) {
            return false;
          }

          const base =
            pair.baseToken?.address;

          const quote =
            pair.quoteToken?.address;

          return (
            (
              base ===
                SOL_MINT &&
              stableMints.has(
                quote
              )
            ) ||
            (
              quote ===
                SOL_MINT &&
              stableMints.has(
                base
              )
            )
          );
        }
      );

    candidates.sort(
      (a, b) => {
        const liqA =
          Number(
            a?.liquidity?.usd
          ) || 0;

        const liqB =
          Number(
            b?.liquidity?.usd
          ) || 0;

        return liqB - liqA;
      }
    );

    if (
      candidates.length >
      0
    ) {
      const price =
        Number(
          candidates[0]
            .priceUsd
        );

      if (
        Number.isFinite(
          price
        )
      ) {
        return price;
      }
    }

    // Fallback
    const fallback =
      data
        .filter(
          pair =>
            pair &&
            (
              pair.baseToken
                ?.address ===
                SOL_MINT ||
              pair.quoteToken
                ?.address ===
                SOL_MINT
            )
        )
        .sort(
          (a, b) => {
            const liqA =
              Number(
                a?.liquidity?.usd
              ) || 0;

            const liqB =
              Number(
                b?.liquidity?.usd
              ) || 0;

            return liqB - liqA;
          }
        );

    if (
      fallback.length >
      0
    ) {
      const price =
        Number(
          fallback[0]
            .priceUsd
        );

      if (
        Number.isFinite(
          price
        )
      ) {
        return price;
      }
    }

    throw new Error(
      "Prix SOL/USD introuvable"
    );
  } catch (
    error
  ) {
    console.log(
      "⚠️ Prix SOL indisponible :",
      error.message
    );

    return currentSolPriceUsd;
  }
}

// ============================================================
// RECHERCHE POOL
// ============================================================

async function findPool() {
  const dex =
    await getDexData();

  const pair =
    dex.pair;

  if (
    !pair.pairAddress
  ) {
    throw new Error(
      "Adresse pool absente"
    );
  }

  poolAddress =
    pair.pairAddress;

  const baseMint =
    pair.baseToken?.address;

  const quoteMint =
    pair.quoteToken?.address;

  console.log(
    `Base mint  : ${baseMint}`
  );

  console.log(
    `Quote mint : ${quoteMint}`
  );

  console.log(
    `Pool       : ${poolAddress}`
  );

  if (
    baseMint !== MINT &&
    quoteMint !== MINT
  ) {
    throw new Error(
      "Le token surveillé ne correspond pas au pool"
    );
  }

  return {
    baseMint,
    quoteMint
  };
}

// ============================================================
// DECODAGE POOL
// ============================================================

function decodePublicKey(
  buffer,
  offset
) {
  if (
    offset < 0 ||
    offset + 32 >
      buffer.length
  ) {
    throw new Error(
      `Offset invalide : ${offset}`
    );
  }

  return bs58Encode(
    buffer.subarray(
      offset,
      offset + 32
    )
  );
}

async function decodePool() {
  const result =
    await rpcRequest(
      "getAccountInfo",
      [
        poolAddress,
        {
          encoding:
            "base64",
          commitment:
            "processed"
        }
      ]
    );

  if (
    !result ||
    !result.value ||
    !result.value.data
  ) {
    throw new Error(
      "Compte pool introuvable"
    );
  }

  const encoded =
    result.value.data[0];

  const buffer =
    Buffer.from(
      encoded,
      "base64"
    );

  console.log(
    `Taille du compte pool : ${buffer.length} bytes`
  );

  if (
    buffer.length < 203
  ) {
    throw new Error(
      "Compte pool trop petit"
    );
  }

  const baseMint =
    decodePublicKey(
      buffer,
      43
    );

  const quoteMint =
    decodePublicKey(
      buffer,
      75
    );

  const baseVault =
    decodePublicKey(
      buffer,
      139
    );

  const quoteVault =
    decodePublicKey(
      buffer,
      171
    );

  console.log(
    "✅ Pool décodé"
  );

  console.log(
    `Base mint  : ${baseMint}`
  );

  console.log(
    `Quote mint : ${quoteMint}`
  );

  console.log(
    `Base vault : ${baseVault}`
  );

  console.log(
    `Quote vault: ${quoteVault}`
  );

  if (
    baseMint === MINT &&
    quoteMint === SOL_MINT
  ) {
    tokenVault =
      baseVault;

    solVault =
      quoteVault;

    console.log(
      "🟢 Token surveillé = BASE"
    );
  } else if (
    baseMint === SOL_MINT &&
    quoteMint === MINT
  ) {
    tokenVault =
      quoteVault;

    solVault =
      baseVault;

    console.log(
      "🟢 Token surveillé = QUOTE"
    );
  } else {
    throw new Error(
      "Impossible de déterminer les vaults"
    );
  }

  console.log(
    `Token vault : ${tokenVault}`
  );

  console.log(
    `SOL vault   : ${solVault}`
  );
}

// ============================================================
// DECIMALES TOKEN
// ============================================================

async function getTokenDecimals() {
  try {
    const result =
      await rpcRequest(
        "getTokenSupply",
        [
          MINT,
          {
            commitment:
              "processed"
          }
        ]
      );

    const decimals =
      Number(
        result?.value?.decimals
      );

    if (
      Number.isFinite(
        decimals
      )
    ) {
      tokenDecimals =
        decimals;
    }
  } catch (
    error
  ) {
    console.log(
      "⚠️ Décimales token indisponibles :",
      error.message
    );

    // Pour ce token, valeur déjà vérifiée
    tokenDecimals = 6;
  }

  console.log(
    `Décimales token : ${tokenDecimals}`
  );
}

// ============================================================
// DECODAGE COMPTE TOKEN SPL
// ============================================================
//
// Compte token SPL classique / Token-2022 :
// amount = offset 64, 8 bytes little-endian.
//
// On récupère la valeur brute directement depuis
// la notification WebSocket.
// ============================================================

function decodeTokenAmountFromAccount(
  base64Data
) {
  const buffer =
    Buffer.from(
      base64Data,
      "base64"
    );

  if (
    buffer.length < 72
  ) {
    throw new Error(
      "Compte token trop petit"
    );
  }

  const rawAmount =
    buffer.readBigUInt64LE(
      64
    );

  const divisor =
    10 ** tokenDecimals;

  return (
    Number(rawAmount) /
    divisor
  );
}

// ============================================================
// WEBSOCKET
// ============================================================

function subscribeAccount(
  address,
  type
) {
  if (
    !ws ||
    ws.readyState !==
      WebSocket.OPEN
  ) {
    return;
  }

  const id =
    type === "token"
      ? 1001
      : 1002;

  const message = {
    jsonrpc: "2.0",
    id,
    method:
      "accountSubscribe",
    params: [
      address,
      {
        encoding:
          "base64",
        commitment:
          "processed"
      }
    ]
  };

  ws.send(
    JSON.stringify(message)
  );
}

function connectWebSocket() {
  if (
    ws &&
    (
      ws.readyState ===
        WebSocket.OPEN ||
      ws.readyState ===
        WebSocket.CONNECTING
    )
  ) {
    return;
  }

  console.log(
    "🔌 Connexion WebSocket Solana..."
  );

  ws =
    new WebSocket(
      WS_RPC
    );

  ws.on(
    "open",
    () => {
      wsConnected =
        true;

      console.log(
        "✅ WebSocket Solana connecté"
      );

      subscribeAccount(
        tokenVault,
        "token"
      );

      subscribeAccount(
        solVault,
        "sol"
      );
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

        // ----------------------------------------------------
        // Confirmation abonnement
        // ----------------------------------------------------

        if (
          message.id === 1001 &&
          Number.isFinite(
            message.result
          )
        ) {
          tokenSubscriptionId =
            message.result;

          console.log(
            `📡 Token vault abonné : ${tokenSubscriptionId}`
          );

          return;
        }

        if (
          message.id === 1002 &&
          Number.isFinite(
            message.result
          )
        ) {
          solSubscriptionId =
            message.result;

          console.log(
            `📡 SOL vault abonné : ${solSubscriptionId}`
          );

          return;
        }

        // ----------------------------------------------------
        // Notification compte
        // ----------------------------------------------------

        if (
          message.method !==
          "accountNotification"
        ) {
          return;
        }

        const params =
          message.params;

        const subscription =
          params?.subscription;

        const result =
          params?.result;

        const context =
          result?.context;

        const value =
          result?.value;

        const slot =
          context?.slot;

        if (
          !value
        ) {
          return;
        }

        // ----------------------------------------------------
        // SOL vault
        // ----------------------------------------------------

        if (
          subscription ===
          solSubscriptionId
        ) {
          const lamports =
            Number(
              value.lamports
            );

          if (
            Number.isFinite(
              lamports
            )
          ) {
            solReserve =
              lamports /
              1e9;

            lastSolUpdateTime =
              Date.now();

            lastSolSlot =
              slot;

            addBoundedHistory(
              onchainHistory,
              {
                timestamp:
                  Date.now(),
                solReserve,
                tokenReserve,
                slot
              }
            );
          }

          return;
        }

        // ----------------------------------------------------
        // TOKEN vault
        // ----------------------------------------------------

        if (
          subscription ===
          tokenSubscriptionId
        ) {
          const accountData =
            value.data;

          if (
            Array.isArray(
              accountData
            ) &&
            accountData.length >=
              1
          ) {
            const encoded =
              accountData[0];

            const amount =
              decodeTokenAmountFromAccount(
                encoded
              );

            if (
              Number.isFinite(
                amount
              )
            ) {
              tokenReserve =
                amount;

              lastTokenUpdateTime =
                Date.now();

              lastTokenSlot =
                slot;

              addBoundedHistory(
                onchainHistory,
                {
                  timestamp:
                    Date.now(),
                  solReserve,
                  tokenReserve,
                  slot
                }
              );
            }
          }

          return;
        }
      } catch (
        error
      ) {
        console.log(
          "⚠️ Erreur traitement WebSocket :",
          error.message
        );
      }
    }
  );

  ws.on(
    "error",
    error => {
      console.log(
        "⚠️ WebSocket :",
        error.message
      );
    }
  );

  ws.on(
    "close",
    () => {
      wsConnected =
        false;

      tokenSubscriptionId =
        null;

      solSubscriptionId =
        null;

      console.log(
        "⚠️ WebSocket fermé."
      );

      if (
        reconnectTimer
      ) {
        return;
      }

      reconnectTimer =
        setTimeout(
          () => {
            reconnectTimer =
              null;

            connectWebSocket();
          },
          WS_RECONNECT_MS
        );
    }
  );
}

// ============================================================
// LIQUIDITE DEX
// ============================================================

function updateDexData(
  priceUsd,
  liquidityUsd
) {
  currentPriceUsd =
    priceUsd;

  rawDexLiquidityUsd =
    liquidityUsd;

  // IMPORTANT :
  // Une liquidité à 0 n'écrase PLUS la dernière valeur valide.
  if (
    Number.isFinite(
      liquidityUsd
    ) &&
    liquidityUsd > 0
  ) {
    currentDexLiquidityUsd =
      liquidityUsd;

    dexLiquidityValid =
      true;
  } else {
    dexLiquidityValid =
      false;
  }

  addBoundedHistory(
    dexHistory,
    {
      timestamp:
        Date.now(),
      price:
        currentPriceUsd,
      liquidity:
        currentDexLiquidityUsd,
      liquidityValid:
        dexLiquidityValid
    }
  );
}

// ============================================================
// ANALYSE DEX
// ============================================================

function calculateDexRadar() {
  const h5 =
    getHistoryAt(
      dexHistory,
      5
    );

  const h10 =
    getHistoryAt(
      dexHistory,
      10
    );

  const price5 =
    h5
      ? percentChange(
          currentPriceUsd,
          h5.price
        )
      : null;

  const price10 =
    h10
      ? percentChange(
          currentPriceUsd,
          h10.price
        )
      : null;

  const liq5 =
    (
      dexLiquidityValid &&
      h5 &&
      Number.isFinite(
        h5.liquidity
      ) &&
      h5.liquidity > 0
    )
      ? percentChange(
          currentDexLiquidityUsd,
          h5.liquidity
        )
      : null;

  const liq10 =
    (
      dexLiquidityValid &&
      h10 &&
      Number.isFinite(
        h10.liquidity
      ) &&
      h10.liquidity > 0
    )
      ? percentChange(
          currentDexLiquidityUsd,
          h10.liquidity
        )
      : null;

  let level =
    "NORMAL";

  if (
    Number.isFinite(
      price5
    ) &&
    price5 <=
      DEX_CRITICAL_PRICE_5S
  ) {
    level =
      "CRITICAL";
  } else if (
    Number.isFinite(
      liq5
    ) &&
    liq5 <=
      DEX_CRITICAL_LIQ_5S
  ) {
    level =
      "CRITICAL";
  } else if (
    Number.isFinite(
      liq10
    ) &&
    liq10 <=
      DEX_CRITICAL_LIQ_10S
  ) {
    level =
      "CRITICAL";
  } else if (
    Number.isFinite(
      price5
    ) &&
    price5 <=
      DEX_DANGER_PRICE_5S
  ) {
    level =
      "DANGER";
  } else if (
    Number.isFinite(
      liq5
    ) &&
    liq5 <=
      DEX_DANGER_LIQ_5S
  ) {
    level =
      "DANGER";
  } else if (
    Number.isFinite(
      liq10
    ) &&
    liq10 <=
      DEX_DANGER_LIQ_10S
  ) {
    level =
      "DANGER";
  } else if (
    Number.isFinite(
      price5
    ) &&
    price5 <=
      DEX_WATCH_PRICE_5S
  ) {
    level =
      "WATCH";
  } else if (
    Number.isFinite(
      liq5
    ) &&
    liq5 <=
      DEX_WATCH_LIQ_5S
  ) {
    level =
      "WATCH";
  } else if (
    Number.isFinite(
      liq10
    ) &&
    liq10 <=
      DEX_WATCH_LIQ_10S
  ) {
    level =
      "WATCH";
  }

  return {
    level,
    price5,
    price10,
    liq5,
    liq10
  };
}

// ============================================================
// ANALYSE ON-CHAIN
// ============================================================

function calculateOnchainRadar() {
  if (
    !Number.isFinite(
      solReserve
    ) ||
    !Number.isFinite(
      tokenReserve
    )
  ) {
    return {
      level:
        "NORMAL",
      sol5:
        null,
      sol10:
        null,
      token5:
        null,
      token10:
        null,
      onchainLiquidity5:
        null,
      onchainLiquidity10:
        null,
      event:
        "WAITING_FOR_VAULTS"
    };
  }

  const h5 =
    getHistoryAt(
      onchainHistory,
      5
    );

  const h10 =
    getHistoryAt(
      onchainHistory,
      10
    );

  const sol5 =
    h5 &&
    Number.isFinite(
      h5.solReserve
    )
      ? percentChange(
          solReserve,
          h5.solReserve
        )
      : null;

  const sol10 =
    h10 &&
    Number.isFinite(
      h10.solReserve
    )
      ? percentChange(
          solReserve,
          h10.solReserve
        )
      : null;

  const token5 =
    h5 &&
    Number.isFinite(
      h5.tokenReserve
    )
      ? percentChange(
          tokenReserve,
          h5.tokenReserve
        )
      : null;

  const token10 =
    h10 &&
    Number.isFinite(
      h10.tokenReserve
    )
      ? percentChange(
          tokenReserve,
          h10.tokenReserve
        )
      : null;

  let onchainLiquidity5 =
    null;

  let onchainLiquidity10 =
    null;

  if (
    Number.isFinite(
      currentSolPriceUsd
    ) &&
    Number.isFinite(
      solReserve
    ) &&
    h5 &&
    Number.isFinite(
      h5.solReserve
    )
  ) {
    const currentProxy =
      solReserve *
      currentSolPriceUsd *
      2;

    const oldProxy =
      h5.solReserve *
      currentSolPriceUsd *
      2;

    onchainLiquidity5 =
      percentChange(
        currentProxy,
        oldProxy
      );
  }

  if (
    Number.isFinite(
      currentSolPriceUsd
    ) &&
    Number.isFinite(
      solReserve
    ) &&
    h10 &&
    Number.isFinite(
      h10.solReserve
    )
  ) {
    const currentProxy =
      solReserve *
      currentSolPriceUsd *
      2;

    const oldProxy =
      h10.solReserve *
      currentSolPriceUsd *
      2;

    onchainLiquidity10 =
      percentChange(
        currentProxy,
        oldProxy
      );
  }

  let event =
    "NORMAL";

  let level =
    "NORMAL";

  // ----------------------------------------------------------
  // RETRAIT DE LIQUIDITE
  //
  // Les deux réserves diminuent ensemble.
  // ----------------------------------------------------------

  const liquidityRemoval5 =
    Number.isFinite(
      sol5
    ) &&
    Number.isFinite(
      token5
    ) &&
    sol5 <=
      ONCHAIN_CRITICAL_LIQ_DROP_5S &&
    token5 <=
      ONCHAIN_CRITICAL_LIQ_DROP_5S;

  const liquidityDanger5 =
    Number.isFinite(
      sol5
    ) &&
    Number.isFinite(
      token5
    ) &&
    sol5 <=
      ONCHAIN_DANGER_LIQ_DROP_5S &&
    token5 <=
      ONCHAIN_DANGER_LIQ_DROP_5S;

  const liquidityWatch5 =
    Number.isFinite(
      sol5
    ) &&
    Number.isFinite(
      token5
    ) &&
    sol5 <=
      ONCHAIN_WATCH_LIQ_DROP_5S &&
    token5 <=
      ONCHAIN_WATCH_LIQ_DROP_5S;

  if (
    liquidityRemoval5
  ) {
    level =
      "CRITICAL";

    event =
      "LIQUIDITY_REMOVAL_SUSPECTED";
  } else if (
    liquidityDanger5
  ) {
    level =
      "DANGER";

    event =
      "LIQUIDITY_REMOVAL_SUSPECTED";
  } else if (
    liquidityWatch5
  ) {
    level =
      "WATCH";

    event =
      "LIQUIDITY_REMOVAL_SUSPECTED";
  }

  // ----------------------------------------------------------
  // PRESSION VENDEUSE
  //
  // SOL baisse + token augmente.
  // ----------------------------------------------------------

  const criticalSell =
    Number.isFinite(
      sol5
    ) &&
    Number.isFinite(
      token5
    ) &&
    sol5 <=
      ONCHAIN_CRITICAL_SOL_OUT_5S &&
    token5 >= 5;

  const dangerSell =
    Number.isFinite(
      sol5
    ) &&
    Number.isFinite(
      token5
    ) &&
    sol5 <=
      ONCHAIN_DANGER_SOL_OUT_5S &&
    token5 >= 3;

  const watchSell =
    Number.isFinite(
      sol5
    ) &&
    Number.isFinite(
      token5
    ) &&
    sol5 <=
      ONCHAIN_WATCH_SOL_OUT_5S &&
    token5 >= 1;

  if (
    criticalSell
  ) {
    level =
      "CRITICAL";

    event =
      "STRONG_SELL_PRESSURE";
  } else if (
    dangerSell &&
    level !== "CRITICAL"
  ) {
    level =
      "DANGER";

    event =
      "SELL_PRESSURE";
  } else if (
    watchSell &&
    level === "NORMAL"
  ) {
    level =
      "WATCH";

    event =
      "SELL_PRESSURE";
  }

  return {
    level,
    sol5,
    sol10,
    token5,
    token10,
    onchainLiquidity5,
    onchainLiquidity10,
    event
  };
}

// ============================================================
// WEBSOCKET ETAT
// ============================================================

function getWsState() {
  const lastUpdate =
    Math.max(
      lastSolUpdateTime,
      lastTokenUpdateTime
    );

  if (
    !wsConnected
  ) {
    return {
      state:
        "OFFLINE",
      ageMs:
        null
    };
  }

  if (
    lastUpdate === 0
  ) {
    return {
      state:
        "WAITING",
      ageMs:
        null
    };
  }

  const ageMs =
    Date.now() -
    lastUpdate;

  if (
    ageMs >
    WS_STALE_MS
  ) {
    return {
      state:
        "STALE",
      ageMs
    };
  }

  return {
    state:
      "LIVE",
    ageMs
  };
}

// ============================================================
// NIVEAU COMBINE
// ============================================================

function levelRank(
  level
) {
  if (
    level ===
    "CRITICAL"
  ) {
    return 3;
  }

  if (
    level ===
    "DANGER"
  ) {
    return 2;
  }

  if (
    level ===
    "WATCH"
  ) {
    return 1;
  }

  return 0;
}

function rankLevel(
  rank
) {
  if (
    rank >= 3
  ) {
    return "CRITICAL";
  }

  if (
    rank >= 2
  ) {
    return "DANGER";
  }

  if (
    rank >= 1
  ) {
    return "WATCH";
  }

  return "NORMAL";
}

// ============================================================
// LOG
// ============================================================

function writeLog(
  data
) {
  try {
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify(
        data
      ) + "\n"
    );
  } catch (
    error
  ) {
    console.log(
      "⚠️ Erreur écriture log :",
      error.message
    );
  }
}

// ============================================================
// TELEGRAM RADAR
// ============================================================

async function maybeAlert(
  dex,
  onchain,
  wsState
) {
  const previous =
    combinedLevel;

  const combinedRank =
    Math.max(
      levelRank(
        dex.level
      ),
      levelRank(
        onchain.level
      )
    );

  combinedLevel =
    rankLevel(
      combinedRank
    );

  // Pas de changement
  if (
    combinedLevel ===
      previous
  ) {
    return;
  }

  console.log(
    `🚨 RADAR ${previous} → ${combinedLevel}`
  );

  if (
    Date.now() -
      lastTelegramTime <
    TELEGRAM_COOLDOWN_MS
  ) {
    return;
  }

  lastTelegramTime =
    Date.now();

  let emoji =
    "🟢";

  if (
    combinedLevel ===
    "WATCH"
  ) {
    emoji =
      "🟡";
  }

  if (
    combinedLevel ===
    "DANGER"
  ) {
    emoji =
      "🟠";
  }

  if (
    combinedLevel ===
    "CRITICAL"
  ) {
    emoji =
      "🚨";
  }

  const message =
`${emoji} CRASH RADAR V2

Niveau : ${combinedLevel}

🪙 ${MINT}

💵 Prix :
$${formatNumber(
    currentPriceUsd
  )}

💧 DexScreener :
${
  dexLiquidityValid
    ? formatUsd(
        currentDexLiquidityUsd
      )
    : "DATA GAP"
}

⛓️ On-chain SOL :
${
  Number.isFinite(
    solReserve
  )
    ? solReserve.toFixed(
        6
      ) + " SOL"
    : "N/A"
}

⛓️ On-chain token :
${
  Number.isFinite(
    tokenReserve
  )
    ? formatNumber(
        tokenReserve
      )
    : "N/A"
}

📊 DEX :
${dex.level}

📊 ON-CHAIN :
${onchain.level}

🔎 Signal :
${onchain.event}

📉 Prix 5s :
${
  Number.isFinite(
    dex.price5
  )
    ? dex.price5.toFixed(
        2
      ) + "%"
    : "N/A"
}

📉 SOL reserve 5s :
${
  Number.isFinite(
    onchain.sol5
  )
    ? onchain.sol5.toFixed(
        2
      ) + "%"
    : "N/A"
}

📉 Token reserve 5s :
${
  Number.isFinite(
    onchain.token5
  )
    ? onchain.token5.toFixed(
        2
      ) + "%"
    : "N/A"
}

📡 WebSocket :
${wsState.state}`;

  await sendTelegram(
    message
  );
}

// ============================================================
// CYCLE PRINCIPAL
// ============================================================

async function monitorCycle() {
  if (
    !monitoring
  ) {
    return;
  }

  try {
    // --------------------------------------------------------
    // 1. DEXSCREENER
    // --------------------------------------------------------

    const dexData =
      await getDexData();

    updateDexData(
      dexData.priceUsd,
      dexData.liquidityUsd
    );

    // --------------------------------------------------------
    // 2. SOL PRICE
    // --------------------------------------------------------

    const solPrice =
      await getSolPriceUsd();

    if (
      Number.isFinite(
        solPrice
      )
    ) {
      currentSolPriceUsd =
        solPrice;
    }

    // --------------------------------------------------------
    // 3. RADARS
    // --------------------------------------------------------

    const dex =
      calculateDexRadar();

    const onchain =
      calculateOnchainRadar();

    const wsState =
      getWsState();

    // --------------------------------------------------------
    // 4. LOG CONSOLE
    // --------------------------------------------------------

    const dexLiqText =
      dexLiquidityValid
        ? formatUsd(
            currentDexLiquidityUsd
          )
        : "DATA GAP";

    console.log(
      `[RADAR] Prix $${formatNumber(currentPriceUsd)} | DEX Liq ${dexLiqText} | DEX ${dex.level} | ONCHAIN ${onchain.level} | ${onchain.event} | WS ${wsState.state}`
    );

    if (
      Number.isFinite(
        solReserve
      ) &&
      Number.isFinite(
        tokenReserve
      )
    ) {
      console.log(
        `[VAULT] SOL ${solReserve.toFixed(6)} | TOKEN ${formatNumber(tokenReserve)} | SOL5 ${Number.isFinite(onchain.sol5) ? onchain.sol5.toFixed(2) + "%" : "N/A"} | TOKEN5 ${Number.isFinite(onchain.token5) ? onchain.token5.toFixed(2) + "%" : "N/A"}`
      );
    }

    // --------------------------------------------------------
    // 5. TELEGRAM
    // --------------------------------------------------------

    await maybeAlert(
      dex,
      onchain,
      wsState
    );

    // --------------------------------------------------------
    // 6. LOG JSON COMPLET
    // --------------------------------------------------------

    writeLog({
      timestamp:
        new Date().toISOString(),

      mint:
        MINT,

      pool:
        poolAddress,

      priceUsd:
        currentPriceUsd,

      solPriceUsd:
        currentSolPriceUsd,

      dexLiquidityUsd:
        currentDexLiquidityUsd,

      rawDexLiquidityUsd:
        rawDexLiquidityUsd,

      dexLiquidityValid:
        dexLiquidityValid,

      dexLevel:
        dex.level,

      dexPriceChange5s:
        dex.price5,

      dexPriceChange10s:
        dex.price10,

      dexLiquidityChange5s:
        dex.liq5,

      dexLiquidityChange10s:
        dex.liq10,

      solReserve:
        solReserve,

      tokenReserve:
        tokenReserve,

      solReserveChange5s:
        onchain.sol5,

      solReserveChange10s:
        onchain.sol10,

      tokenReserveChange5s:
        onchain.token5,

      tokenReserveChange10s:
        onchain.token10,

      onchainLiquidityChange5s:
        onchain.onchainLiquidity5,

      onchainLiquidityChange10s:
        onchain.onchainLiquidity10,

      onchainLevel:
        onchain.level,

      onchainEvent:
        onchain.event,

      combinedLevel:
        combinedLevel,

      websocketState:
        wsState.state,

      websocketAgeMs:
        wsState.ageMs,

      solSlot:
        lastSolSlot,

      tokenSlot:
        lastTokenSlot
    });
  } catch (
    error
  ) {
    console.log(
      "⚠️ Erreur monitoring :",
      error.message
    );
  }
}

// ============================================================
// INITIALISATION
// ============================================================

async function init() {
  try {
    console.log(
      "======================================"
    );

    console.log(
      "🚨 CRASH RADAR V2"
    );

    console.log(
      `Token : ${MINT}`
    );

    console.log(
      `PumpSwap : ${PUMPSWAP_PROGRAM_ID}`
    );

    console.log(
      "======================================"
    );

    // --------------------------------------------------------
    // POOL
    // --------------------------------------------------------

    await findPool();

    console.log(
      "🔎 Lecture du compte pool..."
    );

    await decodePool();

    // --------------------------------------------------------
    // DECIMALES
    // --------------------------------------------------------

    await getTokenDecimals();

    // --------------------------------------------------------
    // SOL
    // --------------------------------------------------------

    currentSolPriceUsd =
      await getSolPriceUsd();

    console.log(
      `💵 SOL/USD : $${formatNumber(currentSolPriceUsd)}`
    );

    // --------------------------------------------------------
    // PREMIERE DONNEE DEX
    // --------------------------------------------------------

    const dex =
      await getDexData();

    updateDexData(
      dex.priceUsd,
      dex.liquidityUsd
    );

    console.log(
      `💰 Prix initial : $${formatNumber(currentPriceUsd)}`
    );

    console.log(
      `💧 Liquidité initiale : ${
        dexLiquidityValid
          ? formatUsd(
              currentDexLiquidityUsd
            )
          : "DATA GAP"
      }`
    );

    // --------------------------------------------------------
    // DEMARRAGE
    // --------------------------------------------------------

    monitoring =
      true;

    connectWebSocket();

    console.log(
      "🚀 Radar V2 démarré."
    );

    console.log(
      `⏱️ Surveillance toutes les ${MONITOR_INTERVAL_MS / 1000}s`
    );

    console.log(
      "🛡️ Protection Dex DATA GAP + monitoring on-chain activée."
    );

    console.log(
      "⛓️ Réserves PumpSwap surveillées directement par WebSocket."
    );

    // Premier cycle
    await monitorCycle();

    setInterval(
      monitorCycle,
      MONITOR_INTERVAL_MS
    );
  } catch (
    error
  ) {
    console.log(
      `❌ Impossible d'initialiser le radar : ${error.message}`
    );

    console.log(
      "🔄 Nouvelle tentative dans 10 secondes..."
    );

    setTimeout(
      init,
      10000
    );
  }
}

// ============================================================
// START
// ============================================================

init();
