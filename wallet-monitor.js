const https = require("https");

// ========================================
// CONFIGURATION
// ========================================

const WALLET_ADDRESS =
  "Fg8bPb4BEphR8AZNup55BWaY9EuT5Mu3SYpAUpyhqxJH";

const THRESHOLD_USD = 200000;

const CHECK_INTERVAL_MS = 10000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// RPC public Solana
const SOLANA_RPC_URL =
  "https://api.mainnet-beta.solana.com";

// WSOL
const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

// Programmes SPL
const TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuF";


// ========================================
// HTTP
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
          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
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
            reject(
              new Error("Réponse JSON invalide")
            );
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
// RPC SOLANA
// ========================================

async function solanaRpc(method, params) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params
  });

  const data = await httpsRequest(
    SOLANA_RPC_URL,
    {
      method: "POST",
      body
    }
  );

  if (data.error) {
    throw new Error(
      `Solana RPC : ${data.error.message || "Erreur inconnue"}`
    );
  }

  return data.result;
}


// ========================================
// SOL NATIF
// ========================================

async function getNativeSolBalance() {
  const result = await solanaRpc(
    "getBalance",
    [
      WALLET_ADDRESS,
      {
        commitment: "finalized"
      }
    ]
  );

  if (
    !result ||
    typeof result.value !== "number"
  ) {
    throw new Error(
      "Solde SOL introuvable."
    );
  }

  return result.value / 1_000_000_000;
}


// ========================================
// COMPTES SPL DU WALLET
// ========================================

async function getTokenAccounts(programId) {
  const result = await solanaRpc(
    "getTokenAccountsByOwner",
    [
      WALLET_ADDRESS,
      {
        programId
      },
      {
        commitment: "finalized",
        encoding: "jsonParsed"
      }
    ]
  );

  if (!result || !Array.isArray(result.value)) {
    return [];
  }

  return result.value;
}


// ========================================
// TOUS LES TOKENS DU WALLET
// ========================================

async function getWalletTokens() {
  const [standardTokens, token2022Tokens] =
    await Promise.all([
      getTokenAccounts(TOKEN_PROGRAM),
      getTokenAccounts(TOKEN_2022_PROGRAM)
    ]);

  const allAccounts = [
    ...standardTokens,
    ...token2022Tokens
  ];

  const tokens = [];

  for (const account of allAccounts) {
    try {
      const info =
        account.account.data.parsed.info;

      const mint = info.mint;

      const amount =
        info.tokenAmount.uiAmount;

      if (!mint) continue;

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        continue;
      }

      // Le SOL wrapped est volontairement ignoré.
      // Le SOL natif est calculé séparément.
      if (mint === WSOL_MINT) {
        continue;
      }

      tokens.push({
        mint,
        amount
      });
    } catch (error) {
      // On ignore les comptes impossibles à parser.
    }
  }

  // Évite les doublons éventuels
  const uniqueTokens = new Map();

  for (const token of tokens) {
    if (!uniqueTokens.has(token.mint)) {
      uniqueTokens.set(
        token.mint,
        token
      );
    }
  }

  return Array.from(
    uniqueTokens.values()
  );
}


// ========================================
// PRIX DES TOKENS VIA DEXSCREENER
// ========================================

async function getTokenPrices(mints) {
  const prices = new Map();

  if (!mints.length) {
    return prices;
  }

  // DEX Screener accepte jusqu'à 30 adresses
  // par requête.
  for (
    let i = 0;
    i < mints.length;
    i += 30
  ) {
    const batch =
      mints.slice(i, i + 30);

    const url =
      `https://api.dexscreener.com/tokens/v1/solana/${batch.join(",")}`;

    const data =
      await httpsRequest(url);

    if (!Array.isArray(data)) {
      continue;
    }

    // Plusieurs pools peuvent exister pour
    // le même token.
    //
    // On garde le prix de la paire avec
    // la plus grosse liquidité.
    for (const pair of data) {
      if (!pair) continue;

      const baseAddress =
        pair.baseToken &&
        pair.baseToken.address;

      const quoteAddress =
        pair.quoteToken &&
        pair.quoteToken.address;

      const priceUsd =
        Number(pair.priceUsd);

      const liquidityUsd =
        Number(
          pair.liquidity &&
          pair.liquidity.usd
        );

      if (
        !Number.isFinite(priceUsd) ||
        priceUsd <= 0
      ) {
        continue;
      }

      if (
        !Number.isFinite(liquidityUsd) ||
        liquidityUsd <= 0
      ) {
        continue;
      }

      let mint = null;

      if (
        batch.includes(baseAddress)
      ) {
        mint = baseAddress;
      } else if (
        batch.includes(quoteAddress)
      ) {
        mint = quoteAddress;
      }

      if (!mint) continue;

      const existing =
        prices.get(mint);

      if (
        !existing ||
        liquidityUsd >
          existing.liquidityUsd
      ) {
        prices.set(mint, {
          priceUsd,
          liquidityUsd
        });
      }
    }
  }

  return prices;
}


// ========================================
// TELEGRAM
// ========================================

async function sendTelegram(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log(
      "⚠️ BOT_TOKEN ou CHAT_ID manquant."
    );
    return;
  }

  const url =
    `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text: message
  });

  try {
    await httpsRequest(
      url,
      {
        method: "POST",
        body
      }
    );

    console.log(
      "📨 Alerte Telegram envoyée."
    );
  } catch (error) {
    console.error(
      "❌ Erreur Telegram :",
      error.message
    );
  }
}


// ========================================
// CALCUL TOTAL DU PORTEFEUILLE
// ========================================

async function calculateWalletValue() {
  const solBalance =
    await getNativeSolBalance();

  const tokens =
    await getWalletTokens();

  const mints =
    tokens.map(
      (token) => token.mint
    );

  const prices =
    await getTokenPrices(mints);

  // Prix SOL
  const solPriceData =
    await getTokenPrices([
      WSOL_MINT
    ]);

  const solData =
    solPriceData.get(
      WSOL_MINT
    );

  if (!solData) {
    throw new Error(
      "Prix SOL indisponible."
    );
  }

  const solPrice =
    solData.priceUsd;

  const solValueUsd =
    solBalance * solPrice;

  let tokensValueUsd = 0;

  const valuedTokens = [];

  for (const token of tokens) {
    const priceData =
      prices.get(token.mint);

    if (!priceData) {
      continue;
    }

    const valueUsd =
      token.amount *
      priceData.priceUsd;

    if (
      !Number.isFinite(valueUsd) ||
      valueUsd <= 0
    ) {
      continue;
    }

    tokensValueUsd += valueUsd;

    valuedTokens.push({
      mint: token.mint,
      amount: token.amount,
      priceUsd: priceData.priceUsd,
      valueUsd
    });
  }

  const totalValueUsd =
    solValueUsd +
    tokensValueUsd;

  return {
    solBalance,
    solPrice,
    solValueUsd,
    tokens,
    valuedTokens,
    tokensValueUsd,
    totalValueUsd
  };
}


// ========================================
// SURVEILLANCE
// ========================================

let thresholdTriggered = false;

let checking = false;

async function checkWallet() {
  if (checking) {
    return;
  }

  checking = true;

  try {
    console.log("");
    console.log(
      "🔎 Vérification du portefeuille..."
    );

    console.log(
      "========================================"
    );

    const wallet =
      await calculateWalletValue();

    console.log(
      `◎ SOL : ${wallet.solBalance.toFixed(6)} × $${wallet.solPrice.toFixed(2)} = $${wallet.solValueUsd.toFixed(2)}`
    );

    console.log(
      `🪙 TOKENS : ${wallet.valuedTokens.length} valorisés`
    );

    console.log(
      `💵 VALEUR TOKENS : $${wallet.tokensValueUsd.toFixed(2)}`
    );

    console.log(
      "========================================"
    );

    console.log(
      `💰 VALEUR TOTALE DU PORTEFEUILLE : $${wallet.totalValueUsd.toFixed(2)}`
    );

    console.log(
      `🎯 SEUIL : $${THRESHOLD_USD.toFixed(2)}`
    );

    console.log(
      "========================================"
    );

    // ========================================
    // SEUIL ATTEINT
    // ========================================

    if (
      wallet.totalValueUsd >=
        THRESHOLD_USD &&
      !thresholdTriggered
    ) {
      thresholdTriggered = true;

      const message =
        `🚨 PORTEFEUILLE À ${THRESHOLD_USD.toLocaleString("fr-FR")} $ !\n\n` +
        `💰 Valeur totale : $${wallet.totalValueUsd.toFixed(2)}\n` +
        `◎ SOL : ${wallet.solBalance.toFixed(6)}\n` +
        `💵 Valeur SOL : $${wallet.solValueUsd.toFixed(2)}\n` +
        `🪙 Valeur tokens : $${wallet.tokensValueUsd.toFixed(2)}\n\n` +
        `🎯 Seuil : $${THRESHOLD_USD.toFixed(2)}`;

      await sendTelegram(message);
    }

    // ========================================
    // RÉARMEMENT
    // ========================================

    if (
      wallet.totalValueUsd <
        THRESHOLD_USD &&
      thresholdTriggered
    ) {
      thresholdTriggered = false;

      console.log(
        "🔄 Valeur repassée sous le seuil."
      );

      console.log(
        "🔔 Alerte réarmée."
      );
    }

  } catch (error) {
    console.error(
      "❌ Erreur surveillance :",
      error.message
    );
  } finally {
    checking = false;
  }
}


// ========================================
// DÉMARRAGE
// ========================================

console.log(
  "========================================"
);

console.log(
  "🚀 WALLET MONITOR DÉMARRÉ"
);

console.log(
  "========================================"
);

console.log(
  `👛 Wallet : ${WALLET_ADDRESS}`
);

console.log(
  `🎯 SEUIL PORTEFEUILLE : $${THRESHOLD_USD.toFixed(2)}`
);

console.log(
  `⏱️ Vérification : toutes les ${CHECK_INTERVAL_MS / 1000}s`
);

console.log(
  "🚫 Helius : NON UTILISÉ"
);

console.log(
  "🪙 SOL + TOKENS SPL : OUI"
);

console.log(
  "========================================"
);

checkWallet();

setInterval(
  checkWallet,
  CHECK_INTERVAL_MS
);
