const https = require("https");

// ========================================
// CONFIGURATION
// ========================================

const WALLET_ADDRESS = "Fg8bPb4BEphR8AZNup55BWaY9EuT5Mu3SYpAUpyhqxJH";

const THRESHOLD_USD = 70000;

const CHECK_INTERVAL_MS = 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// RPC public Solana Mainnet
const SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

// WSOL mint utilisé pour récupérer le prix du SOL
const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// ========================================
// PETIT CLIENT HTTP
// ========================================

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {})
        }
      },
      (response) => {
        let data = "";

        response.on("data", (chunk) => {
          data += chunk;
        });

        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              new Error(
                `HTTP ${response.statusCode} : ${data.slice(0, 300)}`
              )
            );
            return;
          }

          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(new Error("Réponse JSON invalide"));
          }
        });
      }
    );

    request.on("error", reject);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

// ========================================
// TELEGRAM
// ========================================

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log("⚠️ BOT_TOKEN ou CHAT_ID manquant.");
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text: message
  });

  try {
    await httpsRequest(url, {
      method: "POST",
      body
    });

    console.log("📨 Alerte Telegram envoyée.");
  } catch (error) {
    console.error(
      "❌ Erreur Telegram :",
      error.message
    );
  }
}

// ========================================
// SOLDE SOL NATIF
// ========================================

async function getSolBalance() {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getBalance",
    params: [
      WALLET_ADDRESS,
      {
        commitment: "finalized"
      }
    ]
  });

  const data = await httpsRequest(SOLANA_RPC_URL, {
    method: "POST",
    body
  });

  if (
    !data ||
    !data.result ||
    typeof data.result.value !== "number"
  ) {
    throw new Error("Solde SOL introuvable.");
  }

  // Solana retourne le solde en lamports.
  return data.result.value / 1_000_000_000;
}

// ========================================
// PRIX DU SOL
// ========================================

async function getSolPriceUsd() {
  const url =
    `https://api.dexscreener.com/token-pairs/v1/solana/${WSOL_MINT}`;

  const pairs = await httpsRequest(url);

  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw new Error("Aucune paire SOL trouvée sur DexScreener.");
  }

  const validPairs = pairs.filter((pair) => {
    return (
      pair &&
      pair.priceUsd &&
      Number.isFinite(Number(pair.priceUsd)) &&
      pair.liquidity &&
      Number.isFinite(Number(pair.liquidity.usd))
    );
  });

  if (validPairs.length === 0) {
    throw new Error("Prix SOL indisponible sur DexScreener.");
  }

  // On prend la paire avec la plus grosse liquidité.
  validPairs.sort(
    (a, b) =>
      Number(b.liquidity.usd) -
      Number(a.liquidity.usd)
  );

  const price = Number(validPairs[0].priceUsd);

  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Prix SOL invalide.");
  }

  return price;
}

// ========================================
// SURVEILLANCE
// ========================================

let thresholdTriggered = false;

async function checkWallet() {
  try {
    console.log("");
    console.log("🔎 Vérification du wallet...");
    console.log("========================================");

    const solBalance = await getSolBalance();

    const solPrice = await getSolPriceUsd();

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

    // ========================================
    // ALERTE AU FRANCHISSEMENT DU SEUIL
    // ========================================

    if (
      walletValueUsd >= THRESHOLD_USD &&
      !thresholdTriggered
    ) {
      thresholdTriggered = true;

      const message =
        `🚨 SEUIL WALLET ATTEINT !\n\n` +
        `💰 Valeur : $${walletValueUsd.toFixed(2)}\n` +
        `🎯 Seuil : $${THRESHOLD_USD.toFixed(2)}\n` +
        `◎ SOL : ${solBalance.toFixed(6)}\n` +
        `💵 Prix SOL : $${solPrice.toFixed(2)}`;

      await sendTelegram(message);
    }

    // Réarmement lorsque le wallet repasse sous le seuil
    if (
      walletValueUsd < THRESHOLD_USD &&
      thresholdTriggered
    ) {
      thresholdTriggered = false;

      console.log(
        "🔄 Seuil repassé sous la limite. Alerte réarmée."
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
// DÉMARRAGE
// ========================================

console.log("========================================");
console.log("🚀 WALLET MONITOR DÉMARRÉ");
console.log("========================================");
console.log(`👛 Wallet : ${WALLET_ADDRESS}`);
console.log(`🎯 Seuil : $${THRESHOLD_USD.toFixed(2)}`);
console.log(`⏱️ Vérification : toutes les ${CHECK_INTERVAL_MS / 1000}s`);
console.log("🚫 Helius : NON UTILISÉ");
console.log("========================================");

checkWallet();

setInterval(
  checkWallet,
  CHECK_INTERVAL_MS
);
