const { Connection, PublicKey } = require("@solana/web3.js");
const { Telegraf } = require("telegraf");

// ============================================================
// PUMP ALERT BOT - RADAR SORTIE V4
//
// V4 = priorité aux signaux STRUCTURELS
//
// 1. Retrait de liquidité on-chain
// 2. Chute brutale de réserve + base
// 3. Chute du prix
// 4. Chute de liquidité
// 5. Pression vendeuse comme signal secondaire
//
// IMPORTANT : aucune détection ne garantit une sortie avant
// un crash atomique ou extrêmement rapide.
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  throw new Error(
    "Variables manquantes : BOT_TOKEN, CHAT_ID ou HELIUS_API_KEY"
  );
}

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const connection = new Connection(RPC_URL, {
  commitment: "processed",
  wsEndpoint: WS_URL,
});

const bot = new Telegraf(BOT_TOKEN);

const watched = new Map();

// ============================================================
// RÉGLAGES V4
// ============================================================

const DEX_POLL_MS = 5000;
const HEALTH_LOG_MS = 30000;

const EVENT_WINDOW_MS = 30000;

// Temps pendant lequel on attend les deux vaults
// avant de calculer le mouvement.
const RESERVE_BATCH_MS = 120;

// Protection anti-spam.
const ALERT_COOLDOWN_MS = 45000;

// ============================================================
// OUTILS
// ============================================================

function now() {
  return Date.now();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatSol(value) {
  if (!Number.isFinite(value)) return "0.0000";
  return value.toFixed(4);
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
}

function getDataBuffer(accountInfo) {
  if (!accountInfo) return null;

  try {
    const data = accountInfo.data;

    if (Buffer.isBuffer(data)) {
      return data;
    }

    if (Array.isArray(data)) {
      if (data[1] === "base64") {
        return Buffer.from(data[0], "base64");
      }

      if (data[1] === "base58") {
        const bs58 = require("bs58");
        return Buffer.from(bs58.decode(data[0]));
      }
    }
  } catch (error) {
    console.error(
      "🔴 Buffer :",
      error.message
    );
  }

  return null;
}

// ------------------------------------------------------------
// SPL TOKEN ACCOUNT
// ------------------------------------------------------------

function readTokenAmount(accountInfo) {
  if (!accountInfo) return null;

  try {
    const parsed =
      accountInfo?.data?.parsed?.info?.tokenAmount?.amount;

    if (parsed !== undefined) {
      return BigInt(parsed);
    }
  } catch {}

  const buffer =
    getDataBuffer(accountInfo);

  if (!buffer || buffer.length < 72) {
    return null;
  }

  try {
    return buffer.readBigUInt64LE(64);
  } catch {
    return null;
  }
}

// ============================================================
// LECTURE POOL PUMPSWAP
// ============================================================

function readPoolInfo(accountInfo) {
  const buffer =
    getDataBuffer(accountInfo);

  if (!buffer || buffer.length < 203) {
    throw new Error(
      "Compte Pool PumpSwap trop court"
    );
  }

  // Offsets PumpSwap officiels.
  const baseVault =
    new PublicKey(
      buffer.subarray(139, 171)
    );

  const quoteVault =
    new PublicKey(
      buffer.subarray(171, 203)
    );

  // virtual_quote_reserves commence à 245.
  // On essaie de lire un i128 complet.
  let virtualQuoteRaw = 0n;

  if (buffer.length >= 261) {
    try {
      const low =
        buffer.readBigUInt64LE(245);

      const high =
        buffer.readBigUInt64LE(253);

      virtualQuoteRaw =
        low + (high << 64n);
    } catch {
      virtualQuoteRaw = 0n;
    }
  }

  return {
    baseVault,
    quoteVault,
    virtualQuoteRaw,
  };
}

// ============================================================
// DEXSCREENER
// ============================================================

async function fetchDexPair(mint) {
  const url =
    `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

  const response =
    await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "pump-alert-bot/4.0",
      },
    });

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const data =
    await response.json();

  const pairs =
    Array.isArray(data)
      ? data
      : [];

  const pumpPairs =
    pairs.filter((pair) =>
      pair?.dexId === "pumpswap" ||
      pair?.dexId === "pump-amm"
    );

  const candidates =
    pumpPairs.length
      ? pumpPairs
      : pairs;

  if (!candidates.length) {
    throw new Error(
      "Aucune paire trouvée"
    );
  }

  candidates.sort(
    (a, b) =>
      Number(b?.liquidity?.usd ?? 0) -
      Number(a?.liquidity?.usd ?? 0)
  );

  const pair =
    candidates[0];

  return {
    pairAddress:
      pair.pairAddress,

    liquidityUsd:
      Number(pair?.liquidity?.usd ?? 0),

    priceUsd:
      Number(pair?.priceUsd ?? 0),

    priceNative:
      Number(pair?.priceNative ?? 0),

    volume24h:
      Number(pair?.volume?.h24 ?? 0),

    baseDecimals:
      Number(
        pair?.baseToken?.decimals ?? 6
      ),

    url:
      pair?.url ||
      `https://dexscreener.com/solana/${pair?.pairAddress}`,
  };
}

// ============================================================
// HISTORIQUE
// ============================================================

function addEvent(state, event) {
  state.events.push(event);

  const cutoff =
    now() - EVENT_WINDOW_MS;

  while (
    state.events.length &&
    state.events[0].ts < cutoff
  ) {
    state.events.shift();
  }
}

function getFlowStats(state, ms) {
  const cutoff =
    now() - ms;

  let sellSol = 0;
  let buySol = 0;

  let sells = 0;
  let buys = 0;

  let withdrawalSol = 0;
  let withdrawals = 0;

  for (const event of state.events) {
    if (event.ts < cutoff) {
      continue;
    }

    if (event.type === "SELL") {
      sellSol += event.quoteSol;
      sells++;
    }

    if (event.type === "BUY") {
      buySol += event.quoteSol;
      buys++;
    }

    if (event.type === "LIQ_WITHDRAW") {
      withdrawalSol += event.quoteSol;
      withdrawals++;
    }
  }

  const total =
    sellSol + buySol;

  const sellRatio =
    total > 0
      ? (sellSol / total) * 100
      : 0;

  return {
    sellSol,
    buySol,
    sells,
    buys,
    sellRatio,
    withdrawalSol,
    withdrawals,
  };
}

// ============================================================
// CALCUL DU RISQUE
// ============================================================
//
// IMPORTANT : V4 ne laisse plus le ratio SELL dominer le score.
//
// Les vrais signaux structurels ont beaucoup plus de poids.
// ============================================================

function calculateRisk(state) {
  let score = 0;

  const reasons = [];

  const flow10 =
    getFlowStats(state, 10000);

  const flow30 =
    getFlowStats(state, 30000);

  // ----------------------------------------------------------
  // 1. RETRAIT DE LIQUIDITÉ ON-CHAIN
  // ----------------------------------------------------------

  if (flow30.withdrawalSol >= 10) {
    score += 65;

    reasons.push(
      `retrait pool ${flow30.withdrawalSol.toFixed(2)} SOL`
    );
  } else if (flow30.withdrawalSol >= 5) {
    score += 50;

    reasons.push(
      `retrait pool ${flow30.withdrawalSol.toFixed(2)} SOL`
    );
  } else if (flow30.withdrawalSol >= 2) {
    score += 35;

    reasons.push(
      `retrait pool ${flow30.withdrawalSol.toFixed(2)} SOL`
    );
  }

  // ----------------------------------------------------------
  // 2. BAISSE RÉSERVE WSOL
  // ----------------------------------------------------------

  const reserve10 =
    state.reserveHistory.filter(
      (x) =>
        x.ts >= now() - 10000
    );

  if (
    reserve10.length &&
    state.quoteSol > 0
  ) {
    const oldReserve =
      reserve10[0].quoteSol;

    if (oldReserve > 0) {
      const drop =
        ((oldReserve - state.quoteSol) /
          oldReserve) *
        100;

      // IMPORTANT :
      // une simple baisse de réserve n'est PAS forcément
      // une sortie de liquidité.
      //
      // On l'utilise surtout si elle accompagne une baisse
      // du prix ou un retrait on-chain.
      if (drop >= 75) {
        score += 35;

        reasons.push(
          `réserve WSOL -${drop.toFixed(1)}% / 10s`
        );
      } else if (drop >= 50) {
        score += 25;

        reasons.push(
          `réserve WSOL -${drop.toFixed(1)}% / 10s`
        );
      } else if (drop >= 25) {
        score += 15;

        reasons.push(
          `réserve WSOL -${drop.toFixed(1)}% / 10s`
        );
      } else if (drop >= 10) {
        score += 8;

        reasons.push(
          `réserve WSOL -${drop.toFixed(1)}% / 10s`
        );
      }
    }
  }

  // ----------------------------------------------------------
  // 3. CHUTE LIQUIDITÉ
  // ----------------------------------------------------------

  const liq5 =
    state.liquidityHistory.filter(
      (x) =>
        x.ts >= now() - 5000
    );

  const liq15 =
    state.liquidityHistory.filter(
      (x) =>
        x.ts >= now() - 15000
    );

  const liq30 =
    state.liquidityHistory.filter(
      (x) =>
        x.ts >= now() - 30000
    );

  function firstValue(list) {
    return list.length
      ? list[0].value
      : state.liquidityUsd;
  }

  if (state.liquidityUsd > 0) {
    const old5 =
      firstValue(liq5);

    const old15 =
      firstValue(liq15);

    const old30 =
      firstValue(liq30);

    const drop5 =
      old5 > 0
        ? ((old5 - state.liquidityUsd) /
            old5) *
          100
        : 0;

    const drop15 =
      old15 > 0
        ? ((old15 - state.liquidityUsd) /
            old15) *
          100
        : 0;

    const drop30 =
      old30 > 0
        ? ((old30 - state.liquidityUsd) /
            old30) *
          100
        : 0;

    if (drop5 >= 15) {
      score += 40;

      reasons.push(
        `liquidité -${drop5.toFixed(1)}% / 5s`
      );
    } else if (drop5 >= 8) {
      score += 30;

      reasons.push(
        `liquidité -${drop5.toFixed(1)}% / 5s`
      );
    } else if (drop5 >= 4) {
      score += 18;

      reasons.push(
        `liquidité -${drop5.toFixed(1)}% / 5s`
      );
    }

    if (drop15 >= 15) {
      score += 35;

      reasons.push(
        `liquidité -${drop15.toFixed(1)}% / 15s`
      );
    } else if (drop15 >= 8) {
      score += 20;

      reasons.push(
        `liquidité -${drop15.toFixed(1)}% / 15s`
      );
    }

    if (drop30 >= 25) {
      score += 35;

      reasons.push(
        `liquidité -${drop30.toFixed(1)}% / 30s`
      );
    } else if (drop30 >= 15) {
      score += 20;

      reasons.push(
        `liquidité -${drop30.toFixed(1)}% / 30s`
      );
    }
  }

  // ----------------------------------------------------------
  // 4. CHUTE DU PRIX
  // ----------------------------------------------------------

  if (
    state.highPriceUsd > 0 &&
    state.priceUsd > 0
  ) {
    const belowHigh =
      ((state.highPriceUsd -
        state.priceUsd) /
        state.highPriceUsd) *
      100;

    if (belowHigh >= 20) {
      score += 40;

      reasons.push(
        `prix -${belowHigh.toFixed(1)}% du sommet`
      );
    } else if (belowHigh >= 12) {
      score += 30;

      reasons.push(
        `prix -${belowHigh.toFixed(1)}% du sommet`
      );
    } else if (belowHigh >= 7) {
      score += 18;

      reasons.push(
        `prix -${belowHigh.toFixed(1)}% du sommet`
      );
    } else if (belowHigh >= 4) {
      score += 8;

      reasons.push(
        `prix -${belowHigh.toFixed(1)}% du sommet`
      );
    }
  }

  // ----------------------------------------------------------
  // 5. PRESSION VENDEUSE
  // ----------------------------------------------------------
  //
  // Beaucoup moins de poids qu'en V3.
  //
  // Un marché peut avoir énormément de SELL et continuer
  // à monter. Notre test l'a démontré.
  // ----------------------------------------------------------

  if (
    flow10.sellSol >= 30 &&
    flow10.sellRatio >= 90
  ) {
    score += 15;

    reasons.push(
      `SELL ${flow10.sellSol.toFixed(2)} SOL + ratio ${flow10.sellRatio.toFixed(0)}%`
    );
  } else if (
    flow10.sellSol >= 15 &&
    flow10.sellRatio >= 90
  ) {
    score += 10;

    reasons.push(
      `SELL ${flow10.sellSol.toFixed(2)} SOL + ratio ${flow10.sellRatio.toFixed(0)}%`
    );
  } else if (
    flow10.sellSol >= 8 &&
    flow10.sellRatio >= 85
  ) {
    score += 5;

    reasons.push(
      `SELL ${flow10.sellSol.toFixed(2)} SOL + ratio ${flow10.sellRatio.toFixed(0)}%`
    );
  }

  // ----------------------------------------------------------
  // 6. SELL RÉPÉTÉS
  // ----------------------------------------------------------

  if (
    flow10.sells >= 8 &&
    flow10.sellSol >= 20
  ) {
    score += 8;

    reasons.push(
      `${flow10.sells} SELL / 10s`
    );
  }

  return {
    score: clamp(score, 0, 100),
    reasons,
    flow10,
    flow30,
  };
}

// ============================================================
// NIVEAU
// ============================================================

function riskLevel(score) {
  if (score >= 75) {
    return "URGENT";
  }

  if (score >= 50) {
    return "DANGER";
  }

  if (score >= 30) {
    return "PRESSURE";
  }

  return "NORMAL";
}

// ============================================================
// CONDITIONS D'URGENCE V4
// ============================================================
//
// Ces conditions sont séparées du score.
//
// C'est important : un événement critique ne doit pas attendre
// que plusieurs petits points s'additionnent.
// ============================================================

function getEmergencySignals(state) {
  const signals = [];

  const flow10 =
    getFlowStats(state, 10000);

  const flow30 =
    getFlowStats(state, 30000);

  // ----------------------------------------------------------
  // A. RETRAIT ON-CHAIN
  // ----------------------------------------------------------

  if (flow10.withdrawalSol >= 5) {
    signals.push(
      `🚨 retrait pool ${flow10.withdrawalSol.toFixed(2)} SOL / 10s`
    );
  }

  // ----------------------------------------------------------
  // B. RETRAIT IMPORTANT
  // ----------------------------------------------------------

  if (flow30.withdrawalSol >= 10) {
    signals.push(
      `🚨 retrait pool ${flow30.withdrawalSol.toFixed(2)} SOL / 30s`
    );
  }

  // ----------------------------------------------------------
  // C. CHUTE RÉSERVE + PRESSION PRIX
  // ----------------------------------------------------------

  let reserveDrop = 0;

  const reserve10 =
    state.reserveHistory.filter(
      (x) =>
        x.ts >= now() - 10000
    );

  if (
    reserve10.length &&
    reserve10[0].quoteSol > 0
  ) {
    reserveDrop =
      (
        (
          reserve10[0].quoteSol -
          state.quoteSol
        ) /
        reserve10[0].quoteSol
      ) *
      100;
  }

  let belowHigh = 0;

  if (
    state.highPriceUsd > 0 &&
    state.priceUsd > 0
  ) {
    belowHigh =
      (
        (
          state.highPriceUsd -
          state.priceUsd
        ) /
        state.highPriceUsd
      ) *
      100;
  }

  // Une énorme baisse de réserve seule peut être un BUY.
  // On ne déclenche donc l'urgence que si elle est accompagnée
  // d'un vrai signal de faiblesse.
  if (
    reserveDrop >= 50 &&
    belowHigh >= 7
  ) {
    signals.push(
      `🚨 réserve WSOL -${reserveDrop.toFixed(1)}% + prix faible`
    );
  }

  // ----------------------------------------------------------
  // D. LIQUIDITÉ + PRIX
  // ----------------------------------------------------------

  const liq10 =
    state.liquidityHistory.filter(
      (x) =>
        x.ts >= now() - 10000
    );

  if (
    liq10.length &&
    liq10[0].value > 0
  ) {
    const liqDrop =
      (
        (
          liq10[0].value -
          state.liquidityUsd
        ) /
        liq10[0].value
      ) *
      100;

    if (
      liqDrop >= 20 &&
      belowHigh >= 10
    ) {
      signals.push(
        `🚨 liquidité -${liqDrop.toFixed(1)}% + prix -${belowHigh.toFixed(1)}%`
      );
    }
  }

  return signals;
}

// ============================================================
// ALERTES TELEGRAM
// ============================================================

async function sendAlert(
  state,
  level,
  title,
  lines,
  force = false
) {
  const t =
    now();

  if (!force) {
    if (
      state.lastAlertLevel === level &&
      t - state.lastAlertAt <
        ALERT_COOLDOWN_MS
    ) {
      return false;
    }

    if (
      state.lastAlertLevel === level &&
      state.lastAlertScore !== null &&
      state.riskScore <
        state.lastAlertScore + 15 &&
      t - state.lastAlertAt <
        180000
    ) {
      return false;
    }
  }

  const message =
    `${title}\n\n` +
    lines.join("\n");

  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      message
    );

    state.lastAlertAt = t;
    state.lastAlertLevel = level;
    state.lastAlertScore =
      state.riskScore;

    console.log(
      `📨 Telegram envoyé : ${level} ${state.riskScore}/100`
    );

    return true;
  } catch (error) {
    console.error(
      "🔴 Telegram :",
      error.message
    );

    return false;
  }
}

// ============================================================
// ÉVALUATION
// ============================================================

async function evaluateAlert(state) {
  const risk =
    calculateRisk(state);

  state.riskScore =
    risk.score;

  state.riskReasons =
    risk.reasons;

  // ----------------------------------------------------------
  // PRIORITÉ ABSOLUE AUX SIGNAUX D'URGENCE
  // ----------------------------------------------------------

  const emergency =
    getEmergencySignals(state);

  if (emergency.length > 0) {
    await sendAlert(
      state,
      "URGENT",
      "🚨 SIGNAL DE SORTIE URGENT",
      [
        `Score risque : ${risk.score}/100`,
        `Prix : $${state.priceUsd.toFixed(8)}`,
        `Liquidité : $${formatUsd(state.liquidityUsd)}`,
        `Réserve WSOL : ${formatSol(state.quoteSol)} SOL`,
        `SELL 10s : ${formatSol(risk.flow10.sellSol)} SOL`,
        `SELL ratio : ${risk.flow10.sellRatio.toFixed(1)}%`,
        "",
        "⚠️ SIGNAUX CRITIQUES :",
        ...emergency.slice(0, 5),
        "",
        "⚠️ Vérifie immédiatement le marché.",
      ],
      true
    );

    return;
  }

  // ----------------------------------------------------------
  // DANGER
  // ----------------------------------------------------------

  if (risk.score >= 50) {
    await sendAlert(
      state,
      "DANGER",
      "🟠 DANGER : DÉGRADATION DU POOL",
      [
        `Score risque : ${risk.score}/100`,
        `Prix : $${state.priceUsd.toFixed(8)}`,
        `Liquidité : $${formatUsd(state.liquidityUsd)}`,
        `Réserve WSOL : ${formatSol(state.quoteSol)} SOL`,
        `SELL 10s : ${formatSol(risk.flow10.sellSol)} SOL`,
        `SELL ratio : ${risk.flow10.sellRatio.toFixed(1)}%`,
        "",
        `Signaux : ${
          risk.reasons.slice(0, 6).join(" | ") ||
          "aucun"
        }`,
      ]
    );

    return;
  }

  // ----------------------------------------------------------
  // PRESSURE
  // ----------------------------------------------------------

  if (risk.score >= 30) {
    await sendAlert(
      state,
      "PRESSURE",
      "🟡 PRESSION / SURVEILLANCE",
      [
        `Score risque : ${risk.score}/100`,
        `Prix : $${state.priceUsd.toFixed(8)}`,
        `Liquidité : $${formatUsd(state.liquidityUsd)}`,
        `SELL 10s : ${formatSol(risk.flow10.sellSol)} SOL`,
        `SELL ratio : ${risk.flow10.sellRatio.toFixed(1)}%`,
        "",
        `Signaux : ${
          risk.reasons.slice(0, 5).join(" | ") ||
          "aucun"
        }`,
      ]
    );
  }
}

// ============================================================
// TRAITEMENT DES VAULTS
// ============================================================
//
// Règles V4 :
//
// base ↓ + quote ↑ = SELL
// base ↑ + quote ↓ = BUY
// base ↓ + quote ↓ = RETRAIT LIQUIDITÉ
// base ↑ + quote ↑ = AJOUT LIQUIDITÉ
//
// C'est la partie la plus importante du système.
// ============================================================

function processReserveSnapshot(
  state,
  baseRaw,
  quoteRaw,
  source = "WS"
) {
  if (
    baseRaw === null ||
    quoteRaw === null
  ) {
    return;
  }

  if (
    state.previousBaseRaw === null ||
    state.previousQuoteRaw === null
  ) {
    state.previousBaseRaw =
      baseRaw;

    state.previousQuoteRaw =
      quoteRaw;

    state.baseRaw =
      baseRaw;

    state.quoteRaw =
      quoteRaw;

    state.quoteSol =
      Number(quoteRaw) / 1e9;

    return;
  }

  const dBaseRaw =
    baseRaw -
    state.previousBaseRaw;

  const dQuoteRaw =
    quoteRaw -
    state.previousQuoteRaw;

  // On met à jour le snapshot.
  state.previousBaseRaw =
    baseRaw;

  state.previousQuoteRaw =
    quoteRaw;

  state.baseRaw =
    baseRaw;

  state.quoteRaw =
    quoteRaw;

  state.quoteSol =
    Number(quoteRaw) / 1e9;

  state.baseTokens =
    Number(baseRaw) /
    Math.pow(
      10,
      state.baseDecimals || 6
    );

  const dBase =
    Number(dBaseRaw) /
    Math.pow(
      10,
      state.baseDecimals || 6
    );

  const dQuote =
    Number(dQuoteRaw) /
    1e9;

  // ----------------------------------------------------------
  // Ignore les micro variations
  // ----------------------------------------------------------

  if (
    Math.abs(dBase) < 0.000001 &&
    Math.abs(dQuote) < 0.000001
  ) {
    return;
  }

  // ----------------------------------------------------------
  // SELL
  // ----------------------------------------------------------

  if (
    dBase < 0 &&
    dQuote > 0
  ) {
    const sellSol =
      Math.abs(dQuote);

    addEvent(state, {
      ts: now(),
      type: "SELL",
      quoteSol: sellSol,
      baseTokens: Math.abs(dBase),
      source,
    });

    console.log(
      `🔴 SELL : +${sellSol.toFixed(4)} SOL`
    );

    evaluateAlert(state).catch(
      () => {}
    );

    return;
  }

  // ----------------------------------------------------------
  // BUY
  // ----------------------------------------------------------

  if (
    dBase > 0 &&
    dQuote < 0
  ) {
    const buySol =
      Math.abs(dQuote);

    addEvent(state, {
      ts: now(),
      type: "BUY",
      quoteSol: buySol,
      baseTokens: dBase,
      source,
    });

    console.log(
      `🟢 BUY : -${buySol.toFixed(4)} SOL`
    );

    // IMPORTANT :
    // Une baisse de réserve due à un BUY ne devient pas
    // automatiquement un signal de sortie.
    //
    // C'est exactement la correction du problème observé
    // pendant notre test V3.

    evaluateAlert(state).catch(
      () => {}
    );

    return;
  }

  // ----------------------------------------------------------
  // RETRAIT DE LIQUIDITÉ
  // ----------------------------------------------------------

  if (
    dBase < 0 &&
    dQuote < 0
  ) {
    const removedSol =
      Math.abs(dQuote);

    addEvent(state, {
      ts: now(),
      type: "LIQ_WITHDRAW",
      quoteSol: removedSol,
      baseTokens: Math.abs(dBase),
      source,
    });

    console.log(
      `🚨 RETRAIT LIQUIDITÉ : -${removedSol.toFixed(4)} SOL`
    );

    // Le retrait on-chain est immédiatement important.
    evaluateAlert(state).catch(
      () => {}
    );

    return;
  }

  // ----------------------------------------------------------
  // AJOUT LIQUIDITÉ
  // ----------------------------------------------------------

  if (
    dBase > 0 &&
    dQuote > 0
  ) {
    addEvent(state, {
      ts: now(),
      type: "LIQ_ADD",
      quoteSol: dQuote,
      baseTokens: dBase,
      source,
    });

    console.log(
      `🟢 AJOUT LIQUIDITÉ : +${dQuote.toFixed(4)} SOL`
    );

    return;
  }

  console.log(
    `ℹ️ Mouvement non classé : base=${dBase.toFixed(
      6
    )} quote=${dQuote.toFixed(6)}`
  );
}

// ============================================================
// WATCH ON-CHAIN
// ============================================================

async function setupOnChain(state) {
  const poolInfo =
    await connection.getAccountInfo(
      state.poolPubkey,
      "processed"
    );

  if (!poolInfo) {
    throw new Error(
      "Compte Pool introuvable"
    );
  }

  const pool =
    readPoolInfo(poolInfo);

  state.baseVault =
    pool.baseVault;

  state.quoteVault =
    pool.quoteVault;

  state.virtualQuoteRaw =
    pool.virtualQuoteRaw;

  const infos =
    await connection.getMultipleAccountsInfo(
      [
        state.baseVault,
        state.quoteVault,
      ],
      "processed"
    );

  const baseRaw =
    readTokenAmount(infos[0]);

  const quoteRaw =
    readTokenAmount(infos[1]);

  if (
    baseRaw === null ||
    quoteRaw === null
  ) {
    throw new Error(
      "Impossible de lire les réserves initiales"
    );
  }

  state.previousBaseRaw =
    baseRaw;

  state.previousQuoteRaw =
    quoteRaw;

  state.baseRaw =
    baseRaw;

  state.quoteRaw =
    quoteRaw;

  state.quoteSol =
    Number(quoteRaw) /
    1e9;

  state.baseTokens =
    Number(baseRaw) /
    Math.pow(
      10,
      state.baseDecimals
    );

  console.log(
    "🟢 Pool :",
    state.poolAddress
  );

  console.log(
    "🟢 Base vault :",
    state.baseVault.toBase58()
  );

  console.log(
    "🟢 Quote vault :",
    state.quoteVault.toBase58()
  );

  console.log(
    "🟢 WSOL initial :",
    state.quoteSol.toFixed(4)
  );

  // ----------------------------------------------------------
  // BASE VAULT
  // ----------------------------------------------------------

  state.baseSub =
    await connection.onAccountChange(
      state.baseVault,
      (accountInfo, context) => {
        const raw =
          readTokenAmount(
            accountInfo
          );

        if (raw === null) {
          return;
        }

        state.pendingBaseRaw =
          raw;

        state.pendingSlot =
          context.slot;

        scheduleReserveProcess(
          state
        );
      },
      {
        commitment: "processed",
        encoding: "base64",
      }
    );

  // ----------------------------------------------------------
  // QUOTE VAULT
  // ----------------------------------------------------------

  state.quoteSub =
    await connection.onAccountChange(
      state.quoteVault,
      (accountInfo, context) => {
        const raw =
          readTokenAmount(
            accountInfo
          );

        if (raw === null) {
          return;
        }

        state.pendingQuoteRaw =
          raw;

        state.pendingSlot =
          context.slot;

        scheduleReserveProcess(
          state
        );
      },
      {
        commitment: "processed",
        encoding: "base64",
      }
    );

  // ----------------------------------------------------------
  // LOGS PUMPSWAP
  // ----------------------------------------------------------

  state.logsSub =
    await connection.onLogs(
      state.poolPubkey,
      (logInfo) => {
        if (logInfo.err) {
          return;
        }

        const logs =
          logInfo.logs || [];

        const joined =
          logs.join(" ");

        if (/sell/i.test(joined)) {
          console.log(
            `⚠️ LOG PUMPSWAP SELL ${logInfo.signature}`
          );
        }

        if (/buy/i.test(joined)) {
          console.log(
            `ℹ️ LOG PUMPSWAP BUY ${logInfo.signature}`
          );
        }

        if (
          /withdraw/i.test(joined)
        ) {
          console.log(
            `🚨 LOG PUMPSWAP WITHDRAW ${logInfo.signature}`
          );
        }

        if (
          /deposit/i.test(joined)
        ) {
          console.log(
            `🟢 LOG PUMPSWAP DEPOSIT ${logInfo.signature}`
          );
        }
      },
      "processed"
    );

  state.onChainActive =
    true;
}

// ============================================================
// BATCH VAULTS
// ============================================================

function scheduleReserveProcess(state) {
  if (state.reserveTimer) {
    return;
  }

  state.reserveTimer =
    setTimeout(() => {
      state.reserveTimer =
        null;

      const baseRaw =
        state.pendingBaseRaw !==
        undefined
          ? state.pendingBaseRaw
          : state.baseRaw;

      const quoteRaw =
        state.pendingQuoteRaw !==
        undefined
          ? state.pendingQuoteRaw
          : state.quoteRaw;

      state.pendingBaseRaw =
        undefined;

      state.pendingQuoteRaw =
        undefined;

      processReserveSnapshot(
        state,
        baseRaw,
        quoteRaw
      );
    }, RESERVE_BATCH_MS);
}

// ============================================================
// ARRÊT ON-CHAIN
// ============================================================

async function stopOnChain(state) {
  try {
    if (
      state.baseSub !==
      undefined
    ) {
      await connection.removeAccountChangeListener(
        state.baseSub
      );
    }
  } catch {}

  try {
    if (
      state.quoteSub !==
      undefined
    ) {
      await connection.removeAccountChangeListener(
        state.quoteSub
      );
    }
  } catch {}

  try {
    if (
      state.logsSub !==
      undefined
    ) {
      await connection.removeOnLogsListener(
        state.logsSub
      );
    }
  } catch {}

  state.baseSub =
    undefined;

  state.quoteSub =
    undefined;

  state.logsSub =
    undefined;

  state.onChainActive =
    false;
}

// ============================================================
// POLLING DEX
// ============================================================

async function pollDex(state) {
  try {
    const dex =
      await fetchDexPair(
        state.mint
      );

    if (
      state.poolAddress &&
      dex.pairAddress &&
      dex.pairAddress !==
        state.poolAddress
    ) {
      console.log(
        `⚠️ Autre paire détectée : ${dex.pairAddress}`
      );
    }

    state.liquidityUsd =
      dex.liquidityUsd;

    state.priceUsd =
      dex.priceUsd;

    state.priceNative =
      dex.priceNative;

    state.volume24h =
      dex.volume24h;

    if (
      dex.baseDecimals > 0
    ) {
      state.baseDecimals =
        dex.baseDecimals;
    }

    const t =
      now();

    state.liquidityHistory.push({
      ts: t,
      value:
        state.liquidityUsd,
    });

    state.reserveHistory.push({
      ts: t,
      quoteSol:
        state.quoteSol,
    });

    while (
      state.liquidityHistory.length &&
      state.liquidityHistory[0].ts <
        t - 120000
    ) {
      state.liquidityHistory.shift();
    }

    while (
      state.reserveHistory.length &&
      state.reserveHistory[0].ts <
        t - 120000
    ) {
      state.reserveHistory.shift();
    }

    // --------------------------------------------------------
    // SOMMET LOCAL
    // --------------------------------------------------------

    if (
      state.priceUsd >
      state.highPriceUsd
    ) {
      state.highPriceUsd =
        state.priceUsd;

      state.highAt =
        t;
    }

    await evaluateAlert(
      state
    );
  } catch (error) {
    console.error(
      "🔴 DexScreener :",
      error.message
    );
  }
}

// ============================================================
// DÉMARRAGE WATCH
// ============================================================

async function startWatch(mint) {
  if (watched.has(mint)) {
    return watched.get(mint);
  }

  const dex =
    await fetchDexPair(
      mint
    );

  const state = {
    mint,

    poolAddress:
      dex.pairAddress,

    poolPubkey:
      new PublicKey(
        dex.pairAddress
      ),

    dex,

    baseVault: null,
    quoteVault: null,

    previousBaseRaw: null,
    previousQuoteRaw: null,

    pendingBaseRaw:
      undefined,

    pendingQuoteRaw:
      undefined,

    pendingSlot:
      null,

    baseRaw: null,
    quoteRaw: null,

    virtualQuoteRaw:
      0n,

    baseDecimals:
      dex.baseDecimals || 6,

    baseTokens:
      0,

    quoteSol:
      0,

    priceUsd:
      dex.priceUsd || 0,

    priceNative:
      dex.priceNative || 0,

    liquidityUsd:
      dex.liquidityUsd || 0,

    volume24h:
      dex.volume24h || 0,

    highPriceUsd:
      dex.priceUsd || 0,

    highAt:
      now(),

    events: [],

    liquidityHistory: [],

    reserveHistory: [],

    riskScore:
      0,

    riskReasons: [],

    lastAlertAt:
      0,

    lastAlertLevel:
      null,

    lastAlertScore:
      null,

    baseSub:
      undefined,

    quoteSub:
      undefined,

    logsSub:
      undefined,

    reserveTimer:
      null,

    dexTimer:
      null,

    healthTimer:
      null,

    onChainActive:
      false,
  };

  watched.set(
    mint,
    state
  );

  try {
    await setupOnChain(
      state
    );

    await pollDex(
      state
    );

    state.dexTimer =
      setInterval(
        () => {
          pollDex(
            state
          ).catch(() => {});
        },
        DEX_POLL_MS
      );

    state.healthTimer =
      setInterval(
        () => {
          console.log(
            `💓 ${mint.slice(
              0,
              8
            )} | ` +
            `risk=${state.riskScore}/100 | ` +
            `liq=$${state.liquidityUsd.toFixed(0)} | ` +
            `price=$${state.priceUsd.toFixed(8)} | ` +
            `WSOL=${state.quoteSol.toFixed(4)} | ` +
            `onchain=${
              state.onChainActive
                ? "ON"
                : "OFF"
            }`
          );
        },
        HEALTH_LOG_MS
      );

    console.log(
      "🚀 RADAR SORTIE V4 ACTIVÉ :",
      mint
    );

    return state;
  } catch (error) {
    watched.delete(
      mint
    );

    await stopOnChain(
      state
    );

    throw error;
  }
}

// ============================================================
// ARRÊT WATCH
// ============================================================

async function stopWatch(mint) {
  const state =
    watched.get(mint);

  if (!state) {
    return false;
  }

  clearInterval(
    state.dexTimer
  );

  clearInterval(
    state.healthTimer
  );

  if (
    state.reserveTimer
  ) {
    clearTimeout(
      state.reserveTimer
    );
  }

  await stopOnChain(
    state
  );

  watched.delete(
    mint
  );

  return true;
}

// ============================================================
// TELEGRAM /START
// ============================================================

bot.start(
  async (ctx) => {
    await ctx.reply(
      "🤖 Radar Sortie V4 actif.\n\n" +
      "/watch MINT\n" +
      "/status\n" +
      "/unwatch"
    );
  }
);

// ============================================================
// TELEGRAM /WATCH
// ============================================================

bot.command(
  "watch",
  async (ctx) => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    const mint =
      parts[1];

    if (!mint) {
      return ctx.reply(
        "Utilise : /watch ADRESSE_DU_TOKEN"
      );
    }

    try {
      new PublicKey(
        mint
      );
    } catch {
      return ctx.reply(
        "❌ Adresse Solana invalide."
      );
    }

    try {
      await startWatch(
        mint
      );

      await ctx.reply(
        "🟢 RADAR SORTIE V4 ACTIVÉ\n\n" +
        "Priorité aux signaux structurels :\n" +
        "• retraits de liquidité on-chain\n" +
        "• variations simultanées des vaults\n" +
        "• chute du prix\n" +
        "• chute de liquidité\n" +
        "• pression vendeuse secondaire\n\n" +
        "🚨 Les retraits importants peuvent déclencher une urgence immédiate.\n\n" +
        "⚠️ Aucune alerte ne garantit une sortie avant un crash extrêmement rapide."
      );
    } catch (error) {
      console.error(
        "🔴 /watch :",
        error.message
      );

      await ctx.reply(
        `❌ Impossible d'activer le radar : ${error.message}`
      );
    }
  }
);

// ============================================================
// TELEGRAM /UNWATCH
// ============================================================

bot.command(
  "unwatch",
  async (ctx) => {
    const mint =
      ctx.message.text
        .trim()
        .split(/\s+/)[1];

    if (mint) {
      const stopped =
        await stopWatch(
          mint
        );

      return ctx.reply(
        stopped
          ? `🛑 Surveillance arrêtée : ${mint}`
          : "ℹ️ Ce token n'était pas surveillé."
      );
    }

    const all =
      [
        ...watched.keys()
      ];

    for (
      const item of all
    ) {
      await stopWatch(
        item
      );
    }

    await ctx.reply(
      all.length
        ? `🛑 ${all.length} surveillance(s) arrêtée(s).`
        : "ℹ️ Aucune surveillance active."
    );
  }
);

// ============================================================
// TELEGRAM /STATUS
// ============================================================

bot.command(
  "status",
  async (ctx) => {
    if (!watched.size) {
      return ctx.reply(
        "📡 Aucun token surveillé."
      );
    }

    for (
      const state of watched.values()
    ) {
      const risk =
        calculateRisk(
          state
        );

      let belowHigh =
        0;

      if (
        state.highPriceUsd > 0 &&
        state.priceUsd > 0
      ) {
        belowHigh =
          (
            (
              state.highPriceUsd -
              state.priceUsd
            ) /
            state.highPriceUsd
          ) *
          100;
      }

      const emergency =
        getEmergencySignals(
          state
        );

      await ctx.reply(
        `📡 RADAR V4\n\n` +

        `Token : ${state.mint}\n` +

        `Pool : ${state.poolAddress}\n\n` +

        `💰 Prix : $${state.priceUsd.toFixed(8)}\n` +

        `💧 Liquidité : $${formatUsd(
          state.liquidityUsd
        )}\n` +

        `📈 Sommet : $${state.highPriceUsd.toFixed(8)}\n` +

        `📉 Sous sommet : ${belowHigh.toFixed(2)}%\n\n` +

        `🪙 WSOL réserve : ${formatSol(
          state.quoteSol
        )} SOL\n` +

        `🔴 SELL 10s : ${formatSol(
          risk.flow10.sellSol
        )} SOL\n` +

        `🔴 SELL ratio 10s : ${risk.flow10.sellRatio.toFixed(
          1
        )}%\n` +

        `🔴 SELL 30s : ${formatSol(
          risk.flow30.sellSol
        )} SOL\n` +

        `🟢 BUY 10s : ${formatSol(
          risk.flow10.buySol
        )} SOL\n\n` +

        `🚨 Retrait pool 30s : ${formatSol(
          risk.flow30.withdrawalSol
        )} SOL\n` +

        `🎯 RISQUE : ${risk.score}/100\n` +

        `📡 On-chain : ${
          state.onChainActive
            ? "ACTIVE"
            : "OFF"
        }\n\n` +

        `🚨 Urgence : ${
          emergency.length
            ? emergency.join(" | ")
            : "NON"
        }\n\n` +

        `🔎 Raisons : ${
          risk.reasons.slice(
            0,
            6
          ).join(" | ") ||
          "aucune"
        }`
      );
    }
  }
);

// ============================================================
// ERREURS TELEGRAM
// ============================================================

bot.catch(
  (error) => {
    console.error(
      "🔴 Telegram bot :",
      error.message
    );
  }
);

// ============================================================
// DÉMARRAGE
// ============================================================

bot.launch();

console.log(
  "🤖 Pump Alert Bot Radar Sortie V4 démarré."
);

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
