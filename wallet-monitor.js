const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// =====================================================
// CONFIGURATION TEST
// =====================================================

const WALLET_ADDRESS =
  "Fg8bPb4BEphR8AZNup55BWaY9EuT5Mu3SYpAUpyhqxJH";

const THRESHOLD_USD = 70000;

const CHECK_INTERVAL_MS = 10000;

// =====================================================
// DATA
// =====================================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const STATE_FILE =
  path.join(DATA_DIR, "wallet_monitor_state.json");

// =====================================================
// VALIDATION
// =====================================================

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  console.error(
    "❌ BOT_TOKEN, CHAT_ID ou HELIUS_API_KEY manquant."
  );
  process.exit(1);
}

// =====================================================
// ETAT
// =====================================================

let state = {
  alertSent: false,
  lastValueUsd: 0,
  lastCheck: null
};

try {
  if (fs.existsSync(STATE_FILE)) {
    state = JSON.parse(
      fs.readFileSync(STATE_FILE, "utf8")
    );
  }
} catch (err) {
  console.error(
    "⚠️ Impossible de lire l'état :",
    err.message
  );
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

// =====================================================
// TELEGRAM
// =====================================================

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

// =====================================================
// APPEL HELIUS
// =====================================================

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

  const json = await response.json();

  if (json.error) {
    throw new Error(
      json.error.message || "Erreur Helius"
    );
  }

  return json.result;
}

// =====================================================
// RECUPERATION WALLET
// =====================================================

async function getWalletAssets() {
  return await heliusRpc(
    "getAssetsByOwner",
    {
      ownerAddress: WALLET_ADDRESS,
      page: 1,
      limit: 1000,
      displayOptions: {
        showFungible: true,
        showNativeBalance: true,
        showZeroBalance: false
      }
    }
  );
}

// =====================================================
// PRIX SOL VIA WRAPPED SOL
// =====================================================

async function getSolPriceUsd() {
  const WSOL_MINT =
    "So11111111111111111111111111111111111111112";

  try {
    const asset = await heliusRpc(
      "getAsset",
      {
        id: WSOL_MINT,
        displayOptions: {
          showFungible: true
        }
      }
    );

    const price =
      Number(
        asset?.token_info?.price_info?.price_per_token
      );

    if (
      Number.isFinite(price) &&
      price > 0
    ) {
      return price;
    }

    console.warn(
      "⚠️ Prix SOL Helius indisponible."
    );

    return 0;
  } catch (err) {
    console.error(
      "⚠️ Erreur prix SOL :",
      err.message
    );

    return 0;
  }
}

// =====================================================
// CALCUL DU PORTEFEUILLE
// =====================================================

async function calculateWalletValueUsd() {
  const result =
    await getWalletAssets();

  let totalUsd = 0;

  console.log("");
  console.log(
    "========================================"
  );

  console.log(
    "💰 DETAIL DU PORTEFEUILLE"
  );

  console.log(
    "========================================"
  );

  // ===================================================
  // SOL
  // ===================================================

  const lamports =
    Number(
      result?.nativeBalance?.lamports || 0
    );

  const solBalance =
    lamports / 1_000_000_000;

  if (solBalance > 0) {
    const solPrice =
      await getSolPriceUsd();

    if (solPrice > 0) {
      const solValue =
        solBalance * solPrice;

      console.log(
        `SOL : ${solBalance.toFixed(6)} × $${solPrice.toFixed(2)} = $${solValue.toFixed(2)}`
      );

      totalUsd += solValue;
    } else {
      console.log(
        `SOL : ${solBalance.toFixed(6)} → prix indisponible`
      );
    }
  }

  // ===================================================
  // TOKENS
  // ===================================================

  const items =
    Array.isArray(result?.items)
      ? result.items
      : [];

  console.log(
    `Assets Helius : ${items.length}`
  );

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

      const tokenInfo =
        asset.token_info;

      if (!tokenInfo) {
        continue;
      }

      const priceInfo =
        tokenInfo.price_info;

      const symbol =
        tokenInfo.symbol ||
        asset.content?.metadata?.symbol ||
        asset.id?.slice(0, 8) ||
        "TOKEN";

      const decimals =
        Number(tokenInfo.decimals || 0);

      const rawBalance =
        Number(tokenInfo.balance || 0);

      const uiBalance =
        rawBalance /
        Math.pow(10, decimals);

      // -------------------------------------------------
      // Helius fournit directement la valeur totale
      // -------------------------------------------------

      const totalPrice =
        Number(priceInfo?.total_price);

      const currency =
        priceInfo?.currency || "";

      if (
        Number.isFinite(totalPrice) &&
        totalPrice > 0 &&
        currency === "USDC"
      ) {
        console.log(
          `${symbol} : ${uiBalance.toFixed(6)} → Helius total_price = $${totalPrice.toFixed(2)}`
        );

        totalUsd += totalPrice;

        continue;
      }

      console.log(
        `${symbol} : ${uiBalance.toFixed(6)} → prix indisponible, ignoré`
      );
    } catch (err) {
      console.log(
        "⚠️ Token ignoré :",
        err.message
      );
    }
  }

  console.log(
    "----------------------------------------"
  );

  console.log(
    `💵 TOTAL ESTIMÉ : $${totalUsd.toFixed(2)}`
  );

  console.log(
    `🎯 SEUIL : $${THRESHOLD_USD.toFixed(2)}`
  );

  console.log(
    "========================================"
  );

  console.log("");

  return totalUsd;
}

// =====================================================
// VERIFICATION
// =====================================================

async function checkWallet() {
  try {
    console.log(
      "🔎 Vérification du wallet..."
    );

    const valueUsd =
      await calculateWalletValueUsd();

    state.lastValueUsd =
      valueUsd;

    state.lastCheck =
      new Date().toISOString();

    saveState();

    // =================================================
    // ALERTE
    // =================================================

    if (
      valueUsd >= THRESHOLD_USD &&
      !state.alertSent
    ) {
      const message =
        `🚨 ALERTE WALLET\n\n` +
        `💰 Valeur estimée : $${valueUsd.toFixed(2)}\n` +
        `🎯 Seuil : $${THRESHOLD_USD.toFixed(2)}\n\n` +
        `👛 Wallet :\n${WALLET_ADDRESS}\n\n` +
        `⏰ ${new Date().toLocaleString("fr-FR")}`;

      const sent =
        await sendTelegramMessage(message);

      if (sent) {
        state.alertSent = true;
        saveState();

        console.log(
          "🚨 ALERTE TELEGRAM ENVOYÉE"
        );
      }
    }

    // =================================================
    // RESET
    // =================================================

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

// =====================================================
// DEMARRAGE
// =====================================================

console.log(
  "========================================"
);

console.log(
  "👛 WALLET MONITOR V3"
);

console.log(
  "========================================"
);

console.log(
  `Wallet : ${WALLET_ADDRESS}`
);

console.log(
  `Seuil : $${THRESHOLD_USD}`
);

console.log(
  `Intervalle : ${CHECK_INTERVAL_MS / 1000}s`
);

console.log(
  "Valorisation : Helius total_price"
);

console.log(
  "Telegram : alertes uniquement"
);

console.log(
  "========================================"
);

checkWallet();

setInterval(
  checkWallet,
  CHECK_INTERVAL_MS
);
