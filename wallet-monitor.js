const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

// =====================================================
// CONFIGURATION
// =====================================================

const WALLET_ADDRESS =
  "Fg8bPb4BEphR8AZNup55BWaY9EuT5Mu3SYpAUpyhqxJH";

const THRESHOLD_USD = 70000;

const CHECK_INTERVAL_MS = 10000;

// =====================================================
// DOSSIER DATA
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
// HELIUS
// =====================================================

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

  if (!json.result) {
    throw new Error(
      "Helius n'a retourné aucun résultat."
    );
  }

  return json.result;
}

// =====================================================
// PRIX SOL
// =====================================================

async function getSolPriceUsd(result) {
  const nativeBalance =
    result.nativeBalance?.lamports || 0;

  if (!nativeBalance) {
    return {
      balance: 0,
      priceUsd: 0,
      valueUsd: 0
    };
  }

  const solBalance =
    Number(nativeBalance) / 1_000_000_000;

  // Helius peut fournir directement le prix SOL
  const nativePrice =
    result.nativeBalance?.price_per_sol;

  const priceFromHelius =
    Number(nativePrice);

  if (
    Number.isFinite(priceFromHelius) &&
    priceFromHelius > 0
  ) {
    return {
      balance: solBalance,
      priceUsd: priceFromHelius,
      valueUsd: solBalance * priceFromHelius
    };
  }

  // Fallback très sécurisé :
  // on récupère le prix SOL via l'API Helius DAS
  // si le champ direct n'est pas présent.
  try {
    const url =
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

    const body = {
      jsonrpc: "2.0",
      id: "sol-price",
      method: "getAsset",
      params: {
        id: "So11111111111111111111111111111111111111112"
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (response.ok) {
      const json = await response.json();

      const price =
        Number(
          json.result?.token_info?.price_info?.price_per_token
        );

      if (
        Number.isFinite(price) &&
        price > 0
      ) {
        return {
          balance: solBalance,
          priceUsd: price,
          valueUsd: solBalance * price
        };
      }
    }
  } catch (err) {
    // On ignore le fallback
  }

  console.warn(
    "⚠️ Prix SOL indisponible."
  );

  return {
    balance: solBalance,
    priceUsd: 0,
    valueUsd: 0
  };
}

// =====================================================
// PRIX TOKEN HELIUS
// =====================================================

function getHeliusTokenPrice(asset) {
  const priceInfo =
    asset.token_info?.price_info;

  if (!priceInfo) {
    return 0;
  }

  const possiblePrices = [
    priceInfo.price_per_token,
    priceInfo.pricePerToken,
    priceInfo.price_usd,
    priceInfo.priceUsd
  ];

  for (const candidate of possiblePrices) {
    const price =
      Number(candidate);

    if (
      Number.isFinite(price) &&
      price > 0
    ) {
      return price;
    }
  }

  return 0;
}

// =====================================================
// CALCUL TOTAL
// =====================================================

async function calculateWalletValueUsd() {
  const result =
    await getWalletAssets();

  let totalUsd = 0;

  console.log("");
  console.log(
    "----------------------------------------"
  );

  console.log(
    "💰 DETAIL DU PORTEFEUILLE"
  );

  console.log(
    "----------------------------------------"
  );

  // ===================================================
  // SOL
  // ===================================================

  const sol =
    await getSolPriceUsd(result);

  if (sol.balance > 0) {
    if (sol.priceUsd > 0) {
      console.log(
        `SOL : ${sol.balance.toFixed(6)} × $${sol.priceUsd.toFixed(2)} = $${sol.valueUsd.toFixed(2)}`
      );

      totalUsd += sol.valueUsd;
    } else {
      console.log(
        `SOL : ${sol.balance.toFixed(6)} → prix indisponible`
      );
    }
  }

  // ===================================================
  // TOKENS
  // ===================================================

  const items =
    Array.isArray(result.items)
      ? result.items
      : [];

  console.log(
    `Assets récupérés : ${items.length}`
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

      const rawBalance =
        Number(tokenInfo.balance);

      const decimals =
        Number(tokenInfo.decimals);

      if (
        !Number.isFinite(rawBalance) ||
        !Number.isFinite(decimals)
      ) {
        continue;
      }

      const balance =
        rawBalance /
        Math.pow(10, decimals);

      if (
        !Number.isFinite(balance) ||
        balance <= 0
      ) {
        continue;
      }

      const priceUsd =
        getHeliusTokenPrice(asset);

      const symbol =
        tokenInfo.symbol ||
        asset.content?.metadata?.symbol ||
        asset.id?.slice(0, 8) ||
        "TOKEN";

      // -----------------------------------------------
      // PRIX DISPONIBLE
      // -----------------------------------------------

      if (
        Number.isFinite(priceUsd) &&
        priceUsd > 0
      ) {
        const valueUsd =
          balance * priceUsd;

        // Sécurité contre les valeurs absurdes
        // accidentelles de l'API.
        if (
          Number.isFinite(valueUsd) &&
          valueUsd >= 0 &&
          valueUsd < 100000000
        ) {
          console.log(
            `${symbol} : ${balance.toFixed(6)} × $${priceUsd.toFixed(8)} = $${valueUsd.toFixed(2)}`
          );

          totalUsd += valueUsd;
        } else {
          console.log(
            `${symbol} : valeur ignorée (valeur anormale)`
          );
        }

        continue;
      }

      // -----------------------------------------------
      // PAS DE PRIX
      // -----------------------------------------------

      console.log(
        `${symbol} : ${balance.toFixed(6)} → prix indisponible, ignoré`
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
    "----------------------------------------"
  );

  console.log("");

  return totalUsd;
}

// =====================================================
// SURVEILLANCE
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
        await sendTelegramMessage(
          message
        );

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
  "👛 WALLET MONITOR V2"
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
  "Source prix tokens : Helius"
);

console.log(
  "Telegram : alertes uniquement"
);

console.log(
  "========================================"
);

// Première vérification
checkWallet();

// Vérifications périodiques
setInterval(
  checkWallet,
  CHECK_INTERVAL_MS
);
