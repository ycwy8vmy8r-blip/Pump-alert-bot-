const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// ========================================
// CONFIGURATION
// ========================================

const WALLET_ADDRESS = "Fg8bPb4BEphR8AZNup55BWaY9EuT5Mu3SYpAUpyhqxJH";

const THRESHOLD_USD = 70000;

// Vérification toutes les 10 secondes
const CHECK_INTERVAL_MS = 10000;

// Mint WSOL pour récupérer le prix du SOL via Helius
const SOL_MINT =
  "So11111111111111111111111111111111111111112";

// ========================================
// VERIFICATION CONFIG
// ========================================

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  console.error("❌ BOT_TOKEN, CHAT_ID ou HELIUS_API_KEY manquant.");
  process.exit(1);
}

// ========================================
// TELEGRAM
// ========================================

async function sendTelegramMessage(message) {
  const url =
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: message
    })
  });

  const data = await response.json();

  if (!data.ok) {
    console.error("❌ Erreur Telegram :", data);
  }
}

// ========================================
// APPEL HELIUS
// ========================================

async function heliusRpc(method, params) {
  const url =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "wallet-monitor",
      method,
      params
    })
  });

  if (!response.ok) {
    throw new Error(
      `Helius HTTP ${response.status}`
    );
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(
      data.error.message || "Erreur Helius"
    );
  }

  return data.result;
}

// ========================================
// SOLDE SOL DU WALLET
// ========================================

async function getSolBalance() {
  const result = await heliusRpc(
    "getBalance",
    [WALLET_ADDRESS]
  );

  const lamports = result.value || 0;

  return lamports / 1_000_000_000;
}

// ========================================
// PRIX DU SOL
// ========================================

async function getSolPrice() {
  const result = await heliusRpc(
    "getAsset",
    {
      id: SOL_MINT,
      displayOptions: {
        showFungible: true
      }
    }
  );

  const price =
    result?.token_info?.price_info?.price_per_token;

  if (
    typeof price !== "number" ||
    !Number.isFinite(price)
  ) {
    throw new Error(
      "Prix SOL indisponible via Helius."
    );
  }

  return price;
}

// ========================================
// CALCUL VALEUR DU WALLET
// ========================================

async function checkWallet() {
  console.log("");
  console.log("🔎 Vérification du wallet...");
  console.log("========================================");

  const solBalance = await getSolBalance();
  const solPrice = await getSolPrice();

  const walletValueUsd =
    solBalance * solPrice;

  console.log(
    `SOL : ${solBalance.toFixed(6)} × $${solPrice.toFixed(2)} = $${walletValueUsd.toFixed(2)}`
  );

  console.log("========================================");
  console.log(
    `💰 VALEUR TOTALE DU WALLET : $${walletValueUsd.toFixed(2)}`
  );
  console.log(
    `🎯 SEUIL : $${THRESHOLD_USD.toFixed(2)}`
  );
  console.log("========================================");

  return walletValueUsd;
}

// ========================================
// SURVEILLANCE
// ========================================

let alertSent = false;

async function monitor() {
  try {
    const walletValueUsd =
      await checkWallet();

    // Seuil atteint
    if (
      walletValueUsd >= THRESHOLD_USD &&
      !alertSent
    ) {
      alertSent = true;

      const message =
        `🚨 SEUIL WALLET ATTEINT\n\n` +
        `💰 Valeur du wallet : $${walletValueUsd.toFixed(2)}\n` +
        `🎯 Seuil : $${THRESHOLD_USD.toFixed(2)}\n\n` +
        `👛 Wallet :\n${WALLET_ADDRESS}`;

      await sendTelegramMessage(message);

      console.log(
        "🚨 ALERTE TELEGRAM ENVOYÉE"
      );
    }

    // Si le wallet repasse sous le seuil,
    // on réarme l'alerte
    if (
      walletValueUsd < THRESHOLD_USD &&
      alertSent
    ) {
      alertSent = false;

      console.log(
        "🔄 Wallet repassé sous le seuil, alerte réarmée."
      );
    }

  } catch (error) {
    console.error(
      "❌ Erreur surveillance :",
      error.message
    );
  }
}

// ========================================
// DEMARRAGE
// ========================================

console.log("");
console.log("========================================");
console.log("👛 WALLET MONITOR");
console.log("========================================");
console.log(`Wallet : ${WALLET_ADDRESS}`);
console.log(`Seuil : $${THRESHOLD_USD}`);
console.log("Mode : VALEUR SOL DU WALLET UNIQUEMENT");
console.log("========================================");

monitor();

setInterval(
  monitor,
  CHECK_INTERVAL_MS
);
