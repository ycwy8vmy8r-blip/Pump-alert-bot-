const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// ===============================
// CONFIGURATION
// ===============================

const WALLET_ADDRESS =
  "Fg8bPb4BEphR8AZNup55BWaY9EuT5Mu3SYpAUpyhqxJH";

const THRESHOLD_USD = 70000;

const CHECK_INTERVAL_MS = 10000;

// ===============================
// DOSSIER DATA
// ===============================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const STATE_FILE = path.join(DATA_DIR, "wallet_monitor_state.json");

// ===============================
// VALIDATION
// ===============================

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  console.error(
    "❌ BOT_TOKEN, CHAT_ID ou HELIUS_API_KEY manquant."
  );
  process.exit(1);
}

// ===============================
// ETAT
// ===============================

let state = {
  alertSent: false,
  lastValueUsd: 0,
  lastCheck: null
};

try {
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  }
} catch (err) {
  console.error("⚠️ Impossible de lire l'état :", err.message);
}

function saveState() {
  try {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(state, null, 2)
    );
  } catch (err) {
    console.error(
      "⚠️ Impossible de sauvegarder l'état :",
      err.message
    );
  }
}

// ===============================
// TELEGRAM
// ===============================

async function sendTelegramMessage(text) {
  const url =
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text
      })
    });

    const data = await response.json();

    if (!data.ok) {
      console.error(
        "❌ Telegram :",
        data.description || "erreur inconnue"
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error(
      "❌ Erreur Telegram :",
      err.message
    );

    return false;
  }
}

// ===============================
// PRIX SOL
// ===============================

async function getSolPriceUsd() {
  try {
    const url =
      "https://api.dexscreener.com/token-pairs/v1/solana/So11111111111111111111111111111111111111112";

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const pairs = await response.json();

    if (!Array.isArray(pairs) || pairs.length === 0) {
      return 0;
    }

    const validPairs = pairs.filter(
      pair =>
        pair &&
        pair.priceUsd &&
        Number(pair.priceUsd) > 0
    );

    if (validPairs.length === 0) {
      return 0;
    }

    validPairs.sort(
      (a, b) =>
        Number(b.liquidity?.usd || 0) -
        Number(a.liquidity?.usd || 0)
    );

    return Number(validPairs[0].priceUsd);
  } catch (err) {
    console.error(
      "⚠️ Prix SOL indisponible :",
      err.message
    );

    return 0;
  }
}

// ===============================
// PRIX TOKEN
// ===============================

async function getTokenPriceUsd(mint) {
  try {
    const url =
      `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

    const response = await fetch(url);

    if (!response.ok) {
      return 0;
    }

    const pairs = await response.json();

    if (!Array.isArray(pairs) || pairs.length === 0) {
      return 0;
    }

    const validPairs = pairs.filter(
      pair =>
        pair &&
        pair.priceUsd &&
        Number(pair.priceUsd) > 0
    );

    if (validPairs.length === 0) {
      return 0;
    }

    validPairs.sort(
      (a, b) =>
        Number(b.liquidity?.usd || 0) -
        Number(a.liquidity?.usd || 0)
    );

    return Number(validPairs[0].priceUsd);
  } catch (err) {
    return 0;
  }
}

// ===============================
// RECUPERATION WALLET HELIUS
// ===============================

async function getWalletAssets() {
  const url =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const body = {
    jsonrpc: "2.0",
    id: "wallet-monitor",
    method: "getAssetsByOwner",
    params: {
      ownerAddress: WALLET_ADDRESS,
      page: 1,
      limit: 1000,
      displayOptions: {
        showFungible: true,
        showNativeBalance: true
      }
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw new Error(
      `Helius HTTP ${response.status}`
    );
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(
      json.error.message || "Erreur Helius"
    );
  }

  return json.result;
}

// ===============================
// CALCUL VALEUR WALLET
// ===============================

async function calculateWalletValueUsd() {
  const result = await getWalletAssets();

  let totalUsd = 0;

  // -------------------------------
  // SOL
  // -------------------------------

  const nativeBalance =
    result.nativeBalance?.lamports || 0;

  const solBalance =
    Number(nativeBalance) / 1_000_000_000;

  if (solBalance > 0) {
    const solPrice = await getSolPriceUsd();

    if (solPrice > 0) {
      totalUsd += solBalance * solPrice;
    }
  }

  // -------------------------------
  // TOKENS
  // -------------------------------

  const items = result.items || [];

  for (const asset of items) {
    try {
      const interfaceType =
        asset.interface || "";

      const isFungible =
        interfaceType === "FungibleToken" ||
        interfaceType === "FungibleAsset";

      if (!isFungible) {
        continue;
      }

      const mint =
        asset.id;

      if (!mint) {
        continue;
      }

      const tokenInfo =
        asset.token_info;

      if (!tokenInfo) {
        continue;
      }

      const rawBalance =
        tokenInfo.balance;

      const decimals =
        tokenInfo.decimals;

      if (
        rawBalance === undefined ||
        decimals === undefined
      ) {
        continue;
      }

      const balance =
        Number(rawBalance) /
        Math.pow(10, Number(decimals));

      if (
        !Number.isFinite(balance) ||
        balance <= 0
      ) {
        continue;
      }

      const priceUsd =
        await getTokenPriceUsd(mint);

      if (
        !Number.isFinite(priceUsd) ||
        priceUsd <= 0
      ) {
        continue;
      }

      totalUsd +=
        balance * priceUsd;
    } catch (err) {
      continue;
    }
  }

  return totalUsd;
}

// ===============================
// FORMATAGE
// ===============================

function formatUsd(value) {
  return new Intl.NumberFormat(
    "fr-FR",
    {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2
    }
  ).format(value);
}

// ===============================
// SURVEILLANCE
// ===============================

async function checkWallet() {
  try {
    console.log(
      "🔎 Vérification du wallet..."
    );

    const valueUsd =
      await calculateWalletValueUsd();

    state.lastValueUsd = valueUsd;
    state.lastCheck =
      new Date().toISOString();

    saveState();

    console.log(
      `💰 Valeur estimée : ${formatUsd(valueUsd)}`
    );

    console.log(
      `🎯 Seuil : ${formatUsd(THRESHOLD_USD)}`
    );

    // -------------------------------
    // SEUIL ATTEINT
    // -------------------------------

    if (
      valueUsd >= THRESHOLD_USD &&
      !state.alertSent
    ) {
      const message =
        `🚨 ALERTE WALLET\n\n` +
        `💰 Valeur totale estimée : ${formatUsd(valueUsd)}\n` +
        `🎯 Seuil : ${formatUsd(THRESHOLD_USD)}\n\n` +
        `👛 Wallet :\n${WALLET_ADDRESS}\n\n` +
        `⏰ ${new Date().toLocaleString("fr-FR")}`;

      const sent =
        await sendTelegramMessage(message);

      if (sent) {
        state.alertSent = true;
        saveState();

        console.log(
          "🚨 ALERTE Telegram envoyée."
        );
      }
    }

    // -------------------------------
    // RESET SI LE WALLET REPASSE
    // SOUS LE SEUIL
    // -------------------------------

    if (
      valueUsd < THRESHOLD_USD &&
      state.alertSent
    ) {
      state.alertSent = false;
      saveState();

      console.log(
        "ℹ️ Wallet repassé sous le seuil."
      );
    }
  } catch (err) {
    console.error(
      "❌ Erreur surveillance wallet :",
      err.message
    );
  }
}

// ===============================
// DEMARRAGE
// ===============================

console.log(
  "========================================"
);

console.log(
  "👛 WALLET MONITOR"
);

console.log(
  "========================================"
);

console.log(
  `Wallet : ${WALLET_ADDRESS}`
);

console.log(
  `Seuil : ${formatUsd(THRESHOLD_USD)}`
);

console.log(
  `Intervalle : ${CHECK_INTERVAL_MS / 1000}s`
);

console.log(
  "Telegram : alertes uniquement"
);

console.log(
  "========================================"
);

// Première vérification
checkWallet();

// Vérification périodique
setInterval(
  checkWallet,
  CHECK_INTERVAL_MS
);
