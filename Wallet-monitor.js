const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");

// ============================================================
// WALLET MONITOR
// Surveillance de la valeur totale d'un portefeuille Solana
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  console.error(
    "❌ BOT_TOKEN, CHAT_ID ou HELIUS_API_KEY manquant."
  );
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ============================================================
// CONFIGURATION
// ============================================================

const CHECK_INTERVAL_MS = 10000;

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MONITORS_FILE = path.join(
  DATA_DIR,
  "wallet_monitors.json"
);

// ============================================================
// ÉTAT
// ============================================================

let monitors = loadMonitors();

let checking = false;

// ============================================================
// OUTILS
// ============================================================

function now() {
  return Date.now();
}

function formatUsd(value) {
  return `$${Number(value || 0).toLocaleString(
    "en-US",
    {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }
  )}`;
}

function shortAddress(address) {
  if (!address) return "inconnue";

  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

function isValidSolanaAddress(address) {
  return (
    typeof address === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)
  );
}

// ============================================================
// SAUVEGARDE
// ============================================================

function saveMonitors() {
  try {
    fs.writeFileSync(
      MONITORS_FILE,
      JSON.stringify(monitors, null, 2)
    );
  } catch (error) {
    console.error(
      "❌ Erreur sauvegarde monitors:",
      error.message
    );
  }
}

function loadMonitors() {
  try {
    if (!fs.existsSync(MONITORS_FILE)) {
      return [];
    }

    const content = fs.readFileSync(
      MONITORS_FILE,
      "utf8"
    );

    if (!content.trim()) {
      return [];
    }

    const data = JSON.parse(content);

    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error(
      "❌ Impossible de charger wallet_monitors.json:",
      error.message
    );

    return [];
  }
}

// ============================================================
// PRIX SOL
// ============================================================

async function getSolPriceUsd() {
  try {
    const response = await fetch(
      "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112"
    );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const data = await response.json();

    if (
      !data.pairs ||
      !Array.isArray(data.pairs) ||
      data.pairs.length === 0
    ) {
      return null;
    }

    const validPairs = data.pairs
      .filter(
        (pair) =>
          pair &&
          pair.priceUsd &&
          Number(pair.priceUsd) > 0
      )
      .sort(
        (a, b) =>
          Number(
            b.liquidity?.usd || 0
          ) -
          Number(
            a.liquidity?.usd || 0
          )
      );

    if (validPairs.length === 0) {
      return null;
    }

    return Number(
      validPairs[0].priceUsd
    );
  } catch (error) {
    console.error(
      "⚠️ Erreur prix SOL:",
      error.message
    );

    return null;
  }
}

// ============================================================
// PRIX TOKEN
// ============================================================

async function getTokenPriceUsd(mint) {
  try {
    const url =
      `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

    const response = await fetch(url);

    if (!response.ok) {
      return null;
    }

    const pairs = await response.json();

    if (
      !Array.isArray(pairs) ||
      pairs.length === 0
    ) {
      return null;
    }

    const validPairs = pairs
      .filter(
        (pair) =>
          pair &&
          pair.priceUsd &&
          Number(pair.priceUsd) > 0
      )
      .sort(
        (a, b) =>
          Number(
            b.liquidity?.usd || 0
          ) -
          Number(
            a.liquidity?.usd || 0
          )
      );

    if (validPairs.length === 0) {
      return null;
    }

    return Number(
      validPairs[0].priceUsd
    );
  } catch (error) {
    return null;
  }
}

// ============================================================
// PORTFOLIO HELIUS
// ============================================================

async function getWalletAssets(address) {
  const url =
    `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

  const body = {
    jsonrpc: "2.0",
    id: "wallet-monitor",
    method: "getAssetsByOwner",
    params: {
      ownerAddress: address,
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

  const result = await response.json();

  if (result.error) {
    throw new Error(
      result.error.message ||
        "Erreur Helius"
    );
  }

  return result.result || {};
}

// ============================================================
// CALCUL VALEUR WALLET
// ============================================================

async function calculateWalletValue(address) {
  const assets =
    await getWalletAssets(address);

  let totalUsd = 0;

  let solAmount = 0;
  let solValueUsd = 0;

  const tokenValues = [];

  // ----------------------------------------------------------
  // SOL
  // ----------------------------------------------------------

  if (
    assets.nativeBalance &&
    Number.isFinite(
      Number(
        assets.nativeBalance.lamports
      )
    )
  ) {
    solAmount =
      Number(
        assets.nativeBalance.lamports
      ) / 1_000_000_000;
  }

  const solPrice =
    await getSolPriceUsd();

  if (
    solAmount > 0 &&
    Number.isFinite(solPrice)
  ) {
    solValueUsd =
      solAmount * solPrice;

    totalUsd += solValueUsd;
  }

  // ----------------------------------------------------------
  // TOKENS
  // ----------------------------------------------------------

  const items =
    Array.isArray(assets.items)
      ? assets.items
      : [];

  for (const item of items) {
    try {
      const interfaceType =
        item.interface || "";

      if (
        interfaceType !==
          "FungibleToken" &&
        interfaceType !==
          "FungibleAsset"
      ) {
        continue;
      }

      const tokenInfo =
        item.token_info || {};

      const balance =
        Number(
          tokenInfo.balance || 0
        );

      const decimals =
        Number(
          tokenInfo.decimals || 0
        );

      if (
        !Number.isFinite(balance) ||
        balance <= 0
      ) {
        continue;
      }

      const amount =
        balance /
        Math.pow(10, decimals);

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        continue;
      }

      const mint =
        item.id;

      if (!mint) {
        continue;
      }

      // Le SOL est déjà traité séparément.
      if (
        mint ===
        "So11111111111111111111111111111111111111112"
      ) {
        continue;
      }

      const price =
        await getTokenPriceUsd(mint);

      if (
        !Number.isFinite(price) ||
        price <= 0
      ) {
        continue;
      }

      const valueUsd =
        amount * price;

      if (
        !Number.isFinite(valueUsd) ||
        valueUsd <= 0
      ) {
        continue;
      }

      totalUsd += valueUsd;

      tokenValues.push({
        mint,
        amount,
        priceUsd: price,
        valueUsd
      });
    } catch {
      // Un token impossible à valoriser
      // n'empêche pas le calcul du reste du portefeuille.
    }
  }

  return {
    address,
    totalUsd,
    solAmount,
    solPriceUsd: solPrice,
    solValueUsd,
    tokenCount: tokenValues.length,
    tokens: tokenValues,
    timestamp: now()
  };
}

// ============================================================
// VÉRIFICATION D'UN MONITOR
// ============================================================

async function checkMonitor(monitor) {
  try {
    const portfolio =
      await calculateWalletValue(
        monitor.address
      );

    monitor.lastCheck =
      portfolio.timestamp;

    monitor.lastValueUsd =
      portfolio.totalUsd;

    monitor.lastSolAmount =
      portfolio.solAmount;

    monitor.lastSolValueUsd =
      portfolio.solValueUsd;

    monitor.lastTokenCount =
      portfolio.tokenCount;

    saveMonitors();

    console.log(
      `👀 ${shortAddress(
        monitor.address
      )} → ${formatUsd(
        portfolio.totalUsd
      )} / seuil ${formatUsd(
        monitor.thresholdUsd
      )}`
    );

    // --------------------------------------------------------
    // SEUIL ATTEINT
    // --------------------------------------------------------

    if (
      !monitor.alertSent &&
      portfolio.totalUsd >=
        monitor.thresholdUsd
    ) {
      monitor.alertSent = true;
      monitor.alertTime = now();

      saveMonitors();

      await bot.telegram.sendMessage(
        CHAT_ID,
        `🚨 SEUIL PORTEFEUILLE ATTEINT

👤 Adresse :
${monitor.address}

💰 Valeur totale estimée :
${formatUsd(
  portfolio.totalUsd
)}

🎯 Seuil :
${formatUsd(
  monitor.thresholdUsd
)}

◎ SOL :
${portfolio.solAmount.toFixed(
  6
)} SOL

💵 Valeur SOL :
${formatUsd(
  portfolio.solValueUsd
)}

🪙 Tokens valorisés :
${portfolio.tokenCount}

⏰ Heure :
${new Date().toLocaleString(
  "fr-FR"
)}

🛑 Surveillance de ce seuil arrêtée.`
      );

      console.log(
        `🚨 SEUIL ATTEINT pour ${monitor.address}`
      );
    }
  } catch (error) {
    console.error(
      `⚠️ Erreur surveillance ${shortAddress(
        monitor.address
      )}:`,
      error.message
    );
  }
}

// ============================================================
// BOUCLE DE SURVEILLANCE
// ============================================================

async function checkAllMonitors() {
  if (checking) {
    return;
  }

  if (monitors.length === 0) {
    return;
  }

  checking = true;

  try {
    for (const monitor of monitors) {
      if (monitor.alertSent) {
        continue;
      }

      await checkMonitor(monitor);
    }
  } finally {
    checking = false;
  }
}

setInterval(
  () => {
    checkAllMonitors().catch(
      (error) => {
        console.error(
          "❌ Erreur boucle monitor:",
          error.message
        );
      }
    );
  },
  CHECK_INTERVAL_MS
);

// ============================================================
// /monitor
// ============================================================

bot.command(
  "monitor",
  async (ctx) => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    if (parts.length < 3) {
      await ctx.reply(
        `❌ Format incorrect.

Utilise :

/monitor ADRESSE SEUIL

Exemple :

/monitor D6YTMYdeTpKkaDf7RkaxGZDehmetmLcrXmj4pKopVwHE 145000`
      );

      return;
    }

    const address =
      parts[1];

    const threshold =
      Number(parts[2]);

    if (
      !isValidSolanaAddress(
        address
      )
    ) {
      await ctx.reply(
        "❌ Adresse Solana invalide."
      );

      return;
    }

    if (
      !Number.isFinite(
        threshold
      ) ||
      threshold <= 0
    ) {
      await ctx.reply(
        "❌ Le seuil doit être un montant en dollars supérieur à 0."
      );

      return;
    }

    const existing =
      monitors.find(
        (monitor) =>
          monitor.address ===
            address &&
          monitor.thresholdUsd ===
            threshold &&
          !monitor.alertSent
      );

    if (existing) {
      await ctx.reply(
        `⚠️ Cette surveillance existe déjà.

Adresse :
${address}

Seuil :
${formatUsd(
  threshold
)}`
      );

      return;
    }

    const monitor = {
      id: `monitor_${now()}`,
      address,
      thresholdUsd:
        threshold,
      createdAt: now(),
      lastCheck: null,
      lastValueUsd: null,
      lastSolAmount: null,
      lastSolValueUsd: null,
      lastTokenCount: null,
      alertSent: false,
      alertTime: null
    };

    monitors.push(monitor);

    saveMonitors();

    await ctx.reply(
      `👀 SURVEILLANCE ACTIVÉE

Adresse :
${address}

🎯 Seuil :
${formatUsd(
  threshold
)}

🔄 Vérification :
toutes les 10 secondes

🚨 Une alerte sera envoyée dès que la valeur totale estimée du portefeuille atteindra ou dépassera le seuil.

🛑 Le V5.1 n'est pas modifié.`
    );

    // Première vérification immédiate
    await checkMonitor(
      monitor
    );
  }
);

// ============================================================
// /monitors
// ============================================================

bot.command(
  "monitors",
  async (ctx) => {
    const activeMonitors =
      monitors.filter(
        (monitor) =>
          !monitor.alertSent
      );

    if (
      activeMonitors.length === 0
    ) {
      await ctx.reply(
        "👀 Aucune surveillance active."
      );

      return;
    }

    let message =
      "👀 SURVEILLANCES ACTIVES\n\n";

    for (
      const monitor of activeMonitors
    ) {
      message +=
        `📍 ${shortAddress(
          monitor.address
        )}\n`;

      message +=
        `🎯 Seuil : ${formatUsd(
          monitor.thresholdUsd
        )}\n`;

      message +=
        `💰 Dernière valeur : ${
          monitor.lastValueUsd !== null
            ? formatUsd(
                monitor.lastValueUsd
              )
            : "calcul en cours"
        }\n\n`;
    }

    await ctx.reply(
      message
    );
  }
);

// ============================================================
// /stopmonitor
// ============================================================

bot.command(
  "stopmonitor",
  async (ctx) => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    if (parts.length < 2) {
      await ctx.reply(
        `❌ Indique l'adresse à arrêter.

Exemple :

/stopmonitor D6YTMYdeTpKkaDf7RkaxGZDehmetmLcrXmj4pKopVwHE`
      );

      return;
    }

    const address =
      parts[1];

    const before =
      monitors.length;

    monitors =
      monitors.filter(
        (monitor) =>
          monitor.address !==
          address
      );

    saveMonitors();

    if (
      monitors.length === before
    ) {
      await ctx.reply(
        "ℹ️ Aucune surveillance trouvée pour cette adresse."
      );

      return;
    }

    await ctx.reply(
      `⛔ SURVEILLANCE ARRÊTÉE

Adresse :
${address}`
    );
  }
);

// ============================================================
// /walletstatus
// ============================================================

bot.command(
  "walletstatus",
  async (ctx) => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    if (parts.length < 2) {
      await ctx.reply(
        `❌ Indique une adresse.

Exemple :

/walletstatus ADRESSE`
      );

      return;
    }

    const address =
      parts[1];

    if (
      !isValidSolanaAddress(
        address
      )
    ) {
      await ctx.reply(
        "❌ Adresse Solana invalide."
      );

      return;
    }

    await ctx.reply(
      `🔎 Calcul de la valeur du portefeuille...

Adresse :
${address}`
    );

    try {
      const portfolio =
        await calculateWalletValue(
          address
        );

      await ctx.reply(
        `💰 PORTEFEUILLE

Adresse :
${address}

💵 Valeur totale estimée :
${formatUsd(
  portfolio.totalUsd
)}

◎ SOL :
${portfolio.solAmount.toFixed(
  6
)}

💵 Valeur SOL :
${formatUsd(
  portfolio.solValueUsd
)}

🪙 Tokens valorisés :
${portfolio.tokenCount}

⏰ Mise à jour :
${new Date().toLocaleString(
  "fr-FR"
)}

⚠️ Valeur estimée à partir des prix disponibles.`
      );
    } catch (error) {
      await ctx.reply(
        `❌ Impossible de calculer la valeur du portefeuille.

${error.message}`
      );
    }
  }
);

// ============================================================
// /helpwallet
// ============================================================

bot.command(
  "helpwallet",
  async (ctx) => {
    await ctx.reply(
      `🤖 WALLET MONITOR

/monitor ADRESSE SEUIL
▶️ surveille un portefeuille jusqu'au seuil indiqué

/monitors
▶️ affiche les surveillances actives

/walletstatus ADRESSE
▶️ calcule immédiatement la valeur totale estimée

/stopmonitor ADRESSE
▶️ arrête la surveillance d'une adresse

Exemple :

/monitor D6YTMYdeTpKkaDf7RkaxGZDehmetmLcrXmj4pKopVwHE 145000

🎯 Seuil :
145 000 $

🔄 Vérification :
toutes les 10 secondes

🚨 Alerte dès que le portefeuille atteint ou dépasse le seuil.

⚠️ Module indépendant du V5.1.`
    );
  }
);

// ============================================================
// LANCEMENT
// ============================================================

bot.launch();

console.log(
  "👀 Wallet Monitor lancé."
);

// ============================================================
// ARRÊT PROPRE
// ============================================================

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
