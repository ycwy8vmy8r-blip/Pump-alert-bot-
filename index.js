const { Connection, PublicKey } = require("@solana/web3.js");
const { Telegraf } = require("telegraf");

// ============================================================
// PUMP ALERT BOT - RADAR SORTIE V3
// Objectif : détecter une vraie dégradation du pool, pas un SELL isolé.
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN || !CHAT_ID || !HELIUS_API_KEY) {
  throw new Error("Variables manquantes : BOT_TOKEN, CHAT_ID ou HELIUS_API_KEY");
}

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const PUMPSWAP_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const connection = new Connection(RPC_URL, {
  commitment: "processed",
  wsEndpoint: WS_URL,
});

const bot = new Telegraf(BOT_TOKEN);

const watched = new Map();

// ------------------------------------------------------------
// Réglages
// ------------------------------------------------------------

const DEX_POLL_MS = 5000;
const HEALTH_LOG_MS = 30000;
const EVENT_WINDOW_MS = 30000;
const ALERT_COOLDOWN_MS = 45000;

// Les seuils ne déclenchent plus seuls une sortie.
// Ils alimentent un score.
const SCORE = {
  SELL_10S_5SOL: 10,
  SELL_10S_10SOL: 18,
  SELL_RATIO_10S_70: 12,
  SELL_RATIO_10S_85: 18,

  LIQ_DROP_5S_2: 18,
  LIQ_DROP_5S_5: 28,
  LIQ_DROP_15S_8: 25,
  LIQ_DROP_30S_15: 35,

  RESERVE_DROP_10S_2: 12,
  RESERVE_DROP_10S_5: 25,

  REPEATED_SELLS: 10,
  LARGE_REPEATED_SELLS: 15,

  BELOW_HIGH_3: 8,
  BELOW_HIGH_7: 15,
  BELOW_HIGH_12: 22,

  LIQ_WITHDRAWAL_2: 30,
  LIQ_WITHDRAWAL_5: 45,
};

// ------------------------------------------------------------
// Utilitaires
// ------------------------------------------------------------

function now() {
  return Date.now();
}

function pctChange(oldValue, newValue) {
  if (!Number.isFinite(oldValue) || oldValue <= 0 || !Number.isFinite(newValue)) {
    return 0;
  }
  return ((newValue - oldValue) / oldValue) * 100;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatPct(value) {
  if (!Number.isFinite(value)) return "0.00%";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatSol(value) {
  if (!Number.isFinite(value)) return "0.0000";
  return value.toFixed(4);
}

function getDataBuffer(accountInfo) {
  if (!accountInfo) return null;

  try {
    const data = accountInfo.data;

    if (Buffer.isBuffer(data)) {
      return data;
    }

    if (Array.isArray(data) && data[1] === "base64") {
      return Buffer.from(data[0], "base64");
    }

    if (Array.isArray(data) && data[1] === "base58") {
      // Pas utilisé ici, mais garde le parseur robuste.
      const bs58 = require("bs58");
      return Buffer.from(bs58.decode(data[0]));
    }
  } catch (error) {
    console.error("Lecture buffer :", error.message);
  }

  return null;
}

function readTokenAmount(accountInfo) {
  try {
    const parsed = accountInfo?.data?.parsed?.info?.tokenAmount?.amount;
    if (parsed !== undefined) {
      return BigInt(parsed);
    }
  } catch {}

  const buffer = getDataBuffer(accountInfo);

  if (!buffer || buffer.length < 72) {
    return null;
  }

  try {
    return buffer.readBigUInt64LE(64);
  } catch {
    return null;
  }
}

function readPoolVaults(accountInfo) {
  const buffer = getDataBuffer(accountInfo);

  if (!buffer || buffer.length < 203) {
    throw new Error("Compte Pool PumpSwap trop court");
  }

  const baseVault = new PublicKey(buffer.subarray(139, 171));
  const quoteVault = new PublicKey(buffer.subarray(171, 203));

  // PumpSwap a ajouté virtual_quote_reserves après les deux booléens.
  // Layout :
  // 8 discriminator
  // 1 bump
  // 2 index
  // 32 creator
  // 32 base mint
  // 32 quote mint
  // 32 lp mint
  // 32 base vault
  // 32 quote vault
  // 8 lp supply
  // 32 coin creator
  // 1 is_mayhem_mode
  // 1 is_cashback_coin
  // 16 virtual_quote_reserves (i128)
  let virtualQuote = 0n;

  if (buffer.length >= 261) {
    try {
      virtualQuote = buffer.readBigInt64LE(245);

      // readBigInt64LE ne couvre pas tout i128, mais la valeur actuelle
      // documentée est 0. On garde donc 0 si elle dépasse int64.
      // Le radar utilise principalement le vault réel.
      if (virtualQuote < 0n) virtualQuote = 0n;
    } catch {
      virtualQuote = 0n;
    }
  }

  return {
    baseVault,
    quoteVault,
    virtualQuote,
  };
}

function getDecimalsFromDex(pair, side) {
  if (!pair) return 0;

  if (side === "base") {
    return Number(pair.baseToken?.decimals ?? 0);
  }

  return 9;
}

function rawToNumber(raw, decimals) {
  if (raw === null || raw === undefined) return null;

  try {
    const s = raw.toString();
    const n = Number(s);

    if (!Number.isFinite(n)) return null;

    return n / Math.pow(10, decimals);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// DexScreener
// ------------------------------------------------------------

async function fetchDexPair(mint) {
  const url = `https://api.dexscreener.com/token-pairs/v1/solana/${mint}`;

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "pump-alert-bot/3.0",
    },
  });

  if (!response.ok) {
    throw new Error(`DexScreener HTTP ${response.status}`);
  }

  const data = await response.json();

  const pairs = Array.isArray(data) ? data : [];

  const pumpPairs = pairs.filter(
    (pair) =>
      pair?.dexId === "pumpswap" ||
      pair?.dexId === "pump-amm"
  );

  const candidates = pumpPairs.length ? pumpPairs : pairs;

  if (!candidates.length) {
    throw new Error("Aucune paire trouvée");
  }

  // On privilégie la paire avec la liquidité USD la plus élevée.
  candidates.sort(
    (a, b) =>
      Number(b?.liquidity?.usd ?? 0) -
      Number(a?.liquidity?.usd ?? 0)
  );

  const pair = candidates[0];

  return {
    pairAddress: pair.pairAddress,
    liquidityUsd: Number(pair?.liquidity?.usd ?? 0),
    priceUsd: Number(pair?.priceUsd ?? 0),
    priceNative: Number(pair?.priceNative ?? 0),
    volume24h: Number(pair?.volume?.h24 ?? 0),
    baseDecimals: getDecimalsFromDex(pair, "base"),
    quoteDecimals: 9,
    url:
      pair?.url ||
      `https://dexscreener.com/solana/${pair?.pairAddress}`,
  };
}

// ------------------------------------------------------------
// Historique
// ------------------------------------------------------------

function addEvent(state, event) {
  state.events.push(event);

  const cutoff = now() - EVENT_WINDOW_MS;

  while (state.events.length && state.events[0].ts < cutoff) {
    state.events.shift();
  }
}

function sumEvents(state, ms, type) {
  const cutoff = now() - ms;

  let amount = 0;
  let count = 0;

  for (const event of state.events) {
    if (event.ts < cutoff) continue;
    if (type && event.type !== type) continue;

    amount += event.quoteSol || 0;
    count++;
  }

  return { amount, count };
}

function getSellStats(state, ms) {
  const cutoff = now() - ms;

  let sell = 0;
  let buy = 0;
  let sells = 0;
  let buys = 0;
  let liquidityWithdrawals = 0;

  for (const event of state.events) {
    if (event.ts < cutoff) continue;

    if (event.type === "SELL") {
      sell += event.quoteSol;
      sells++;
    } else if (event.type === "BUY") {
      buy += event.quoteSol;
      buys++;
    } else if (event.type === "LIQ_WITHDRAW") {
      liquidityWithdrawals += event.quoteSol;
    }
  }

  const total = sell + buy;
  const sellRatio = total > 0 ? (sell / total) * 100 : 0;

  return {
    sell,
    buy,
    sells,
    buys,
    sellRatio,
    liquidityWithdrawals,
  };
}

// ------------------------------------------------------------
// Score de risque
// ------------------------------------------------------------

function calculateRisk(state) {
  let score = 0;
  const reasons = [];

  const s10 = getSellStats(state, 10000);
  const s30 = getSellStats(state, 30000);

  if (s10.sell >= 10) {
    score += SCORE.SELL_10S_10SOL;
    reasons.push(`SELL ${s10.sell.toFixed(2)} SOL / 10s`);
  } else if (s10.sell >= 5) {
    score += SCORE.SELL_10S_5SOL;
    reasons.push(`SELL ${s10.sell.toFixed(2)} SOL / 10s`);
  }

  if (s10.sellRatio >= 85) {
    score += SCORE.SELL_RATIO_10S_85;
    reasons.push(`SELL ratio ${s10.sellRatio.toFixed(0)}% / 10s`);
  } else if (s10.sellRatio >= 70) {
    score += SCORE.SELL_RATIO_10S_70;
    reasons.push(`SELL ratio ${s10.sellRatio.toFixed(0)}% / 10s`);
  }

  const liq5 = state.liquidityHistory.filter(
    (x) => x.ts >= now() - 5000
  );

  const liq15 = state.liquidityHistory.filter(
    (x) => x.ts >= now() - 15000
  );

  const liq30 = state.liquidityHistory.filter(
    (x) => x.ts >= now() - 30000
  );

  function getOldestValue(list, fallback) {
    return list.length ? list[0].value : fallback;
  }

  const currentLiq = state.liquidityUsd || 0;

  if (currentLiq > 0) {
    const old5 = getOldestValue(liq5, currentLiq);
    const old15 = getOldestValue(liq15, currentLiq);
    const old30 = getOldestValue(liq30, currentLiq);

    const drop5 =
      old5 > 0
        ? ((old5 - currentLiq) / old5) * 100
        : 0;

    const drop15 =
      old15 > 0
        ? ((old15 - currentLiq) / old15) * 100
        : 0;

    const drop30 =
      old30 > 0
        ? ((old30 - currentLiq) / old30) * 100
        : 0;

    if (drop5 >= 5) {
      score += SCORE.LIQ_DROP_5S_5;
      reasons.push(`liquidité -${drop5.toFixed(1)}% / 5s`);
    } else if (drop5 >= 2) {
      score += SCORE.LIQ_DROP_5S_2;
      reasons.push(`liquidité -${drop5.toFixed(1)}% / 5s`);
    }

    if (drop15 >= 8) {
      score += SCORE.LIQ_DROP_15S_8;
      reasons.push(`liquidité -${drop15.toFixed(1)}% / 15s`);
    }

    if (drop30 >= 15) {
      score += SCORE.LIQ_DROP_30S_15;
      reasons.push(`liquidité -${drop30.toFixed(1)}% / 30s`);
    }
  }

  // Baisse de réserve quote réelle.
  const reserve10 = state.reserveHistory.filter(
    (x) => x.ts >= now() - 10000
  );

  if (reserve10.length && state.quoteSol > 0) {
    const old = reserve10[0].quoteSol;

    if (old > 0) {
      const drop =
        ((old - state.quoteSol) / old) * 100;

      if (drop >= 5) {
        score += SCORE.RESERVE_DROP_10S_5;
        reasons.push(`réserve WSOL -${drop.toFixed(1)}% / 10s`);
      } else if (drop >= 2) {
        score += SCORE.RESERVE_DROP_10S_2;
        reasons.push(`réserve WSOL -${drop.toFixed(1)}% / 10s`);
      }
    }
  }

  // Retrait de liquidité confirmé on-chain :
  // base ET quote diminuent ensemble.
  const withdraw30 = s30.liquidityWithdrawals;

  if (withdraw30 >= 5) {
    score += SCORE.LIQ_WITHDRAWAL_5;
    reasons.push(`retrait pool ${withdraw30.toFixed(2)} SOL`);
  } else if (withdraw30 >= 2) {
    score += SCORE.LIQ_WITHDRAWAL_2;
    reasons.push(`retrait pool ${withdraw30.toFixed(2)} SOL`);
  }

  // SELL répétés.
  if (s10.sells >= 4) {
    score += SCORE.REPEATED_SELLS;
    reasons.push(`${s10.sells} SELL / 10s`);
  }

  if (s10.sells >= 6 && s10.sell >= 15) {
    score += SCORE.LARGE_REPEATED_SELLS;
    reasons.push("SELL répétés et importants");
  }

  // Prix sous le sommet récent.
  if (state.highPriceUsd > 0 && state.priceUsd > 0) {
    const belowHigh =
      ((state.highPriceUsd - state.priceUsd) /
        state.highPriceUsd) *
      100;

    if (belowHigh >= 12) {
      score += SCORE.BELOW_HIGH_12;
      reasons.push(`prix -${belowHigh.toFixed(1)}% du sommet`);
    } else if (belowHigh >= 7) {
      score += SCORE.BELOW_HIGH_7;
      reasons.push(`prix -${belowHigh.toFixed(1)}% du sommet`);
    } else if (belowHigh >= 3) {
      score += SCORE.BELOW_HIGH_3;
      reasons.push(`prix -${belowHigh.toFixed(1)}% du sommet`);
    }
  }

  return {
    score: clamp(score, 0, 100),
    reasons,
    sell10: s10,
    sell30: s30,
  };
}

function riskLevel(score) {
  if (score >= 75) return "URGENT";
  if (score >= 50) return "DANGER";
  if (score >= 30) return "PRESSURE";
  return "NORMAL";
}

// ------------------------------------------------------------
// Telegram
// ------------------------------------------------------------

async function sendAlert(state, level, title, lines) {
  const t = now();

  // On évite les répétitions inutiles.
  if (
    state.lastAlertLevel === level &&
    t - state.lastAlertAt < ALERT_COOLDOWN_MS
  ) {
    return false;
  }

  // Une alerte de même niveau ne repart pas toutes les 45s si rien
  // n'a empiré. Elle repart seulement si le score a augmenté fortement.
  if (
    state.lastAlertLevel === level &&
    state.lastAlertScore !== null &&
    state.riskScore < state.lastAlertScore + 15 &&
    t - state.lastAlertAt < 180000
  ) {
    return false;
  }

  const message = `${title}\n\n${lines.join("\n")}`;

  try {
    await bot.telegram.sendMessage(CHAT_ID, message);

    state.lastAlertAt = t;
    state.lastAlertLevel = level;
    state.lastAlertScore = state.riskScore;

    console.log(
      "📨 Telegram envoyé :",
      level,
      state.riskScore
    );

    return true;
  } catch (error) {
    console.error("🔴 Telegram :", error.message);
    return false;
  }
}

async function evaluateAlert(state) {
  const risk = calculateRisk(state);

  state.riskScore = risk.score;
  state.riskReasons = risk.reasons;

  const level = riskLevel(risk.score);

  if (level === "URGENT") {
    await sendAlert(
      state,
      level,
      "🚨 SORTIE POTENTIELLE : RISQUE CONFIRMÉ",
      [
        `Score risque : ${risk.score}/100`,
        `Prix : $${state.priceUsd.toFixed(8)}`,
        `Liquidité : $${state.liquidityUsd.toFixed(2)}`,
        `SELL 10s : ${risk.sell10.sell.toFixed(2)} SOL`,
        `SELL ratio 10s : ${risk.sell10.sellRatio.toFixed(1)}%`,
        `SELL 30s : ${risk.sell30.sell.toFixed(2)} SOL`,
        `Réserve WSOL : ${state.quoteSol.toFixed(4)} SOL`,
        "",
        `Signaux : ${risk.reasons.slice(0, 5).join(" | ")}`,
        "",
        "⚠️ Dégradation confirmée. Vérifie immédiatement le marché.",
      ]
    );
  } else if (level === "DANGER") {
    await sendAlert(
      state,
      level,
      "🟠 DANGER : DÉGRADATION DU POOL",
      [
        `Score risque : ${risk.score}/100`,
        `Prix : $${state.priceUsd.toFixed(8)}`,
        `Liquidité : $${state.liquidityUsd.toFixed(2)}`,
        `SELL 10s : ${risk.sell10.sell.toFixed(2)} SOL`,
        `SELL ratio 10s : ${risk.sell10.sellRatio.toFixed(1)}%`,
        `Réserve WSOL : ${state.quoteSol.toFixed(4)} SOL`,
        "",
        `Signaux : ${risk.reasons.slice(0, 5).join(" | ")}`,
      ]
    );
  } else if (level === "PRESSURE") {
    await sendAlert(
      state,
      level,
      "🟡 PRESSION VENDEUSE",
      [
        `Score risque : ${risk.score}/100`,
        `Prix : $${state.priceUsd.toFixed(8)}`,
        `Liquidité : $${state.liquidityUsd.toFixed(2)}`,
        `SELL 10s : ${risk.sell10.sell.toFixed(2)} SOL`,
        `SELL ratio 10s : ${risk.sell10.sellRatio.toFixed(1)}%`,
        `SELL 30s : ${risk.sell30.sell.toFixed(2)} SOL`,
        "",
        `Signaux : ${risk.reasons.slice(0, 5).join(" | ")}`,
      ]
    );
  }
}

// ------------------------------------------------------------
// Analyse des changements des deux vaults
// ------------------------------------------------------------

function processReserveSnapshot(
  state,
  baseRaw,
  quoteRaw,
  source = "WS"
) {
  if (baseRaw === null || quoteRaw === null) return;

  if (
    state.previousBaseRaw === null ||
    state.previousQuoteRaw === null
  ) {
    state.previousBaseRaw = baseRaw;
    state.previousQuoteRaw = quoteRaw;

    state.baseRaw = baseRaw;
    state.quoteRaw = quoteRaw;

    return;
  }

  const dBaseRaw =
    baseRaw - state.previousBaseRaw;

  const dQuoteRaw =
    quoteRaw - state.previousQuoteRaw;

  // On mémorise toujours le nouvel état.
  state.previousBaseRaw = baseRaw;
  state.previousQuoteRaw = quoteRaw;

  state.baseRaw = baseRaw;
  state.quoteRaw = quoteRaw;

  const baseDecimals = state.baseDecimals || 6;

  const dBase =
    Number(dBaseRaw) /
    Math.pow(10, baseDecimals);

  const dQuote =
    Number(dQuoteRaw) / 1e9;

  state.quoteSol =
    Number(quoteRaw) / 1e9;

  state.baseTokens =
    Number(baseRaw) /
    Math.pow(10, baseDecimals);

  // Ignore les micro variations.
  if (
    Math.abs(dBase) < 0.000001 &&
    Math.abs(dQuote) < 0.000001
  ) {
    return;
  }

  // SELL :
  // base diminue + quote augmente.
  if (dBase < 0 && dQuote > 0) {
    const sellSol = Math.abs(dQuote);

    addEvent(state, {
      ts: now(),
      type: "SELL",
      quoteSol: sellSol,
      baseTokens: Math.abs(dBase),
      source,
    });

    console.log(
      `🔴 SELL confirmé : +${sellSol.toFixed(4)} SOL / -${Math.abs(
        dBase
      ).toFixed(2)} tokens`
    );

    evaluateAlert(state).catch(() => {});
    return;
  }

  // BUY :
  // base augmente + quote diminue.
  if (dBase > 0 && dQuote < 0) {
    const buySol = Math.abs(dQuote);

    addEvent(state, {
      ts: now(),
      type: "BUY",
      quoteSol: buySol,
      baseTokens: dBase,
      source,
    });

    console.log(
      `🟢 BUY confirmé : -${buySol.toFixed(4)} SOL / +${dBase.toFixed(
        2
      )} tokens`
    );

    evaluateAlert(state).catch(() => {});
    return;
  }

  // RETRAIT DE LIQUIDITÉ :
  // base ET quote diminuent.
  if (dBase < 0 && dQuote < 0) {
    const removedQuote = Math.abs(dQuote);

    addEvent(state, {
      ts: now(),
      type: "LIQ_WITHDRAW",
      quoteSol: removedQuote,
      baseTokens: Math.abs(dBase),
      source,
    });

    console.log(
      `🚨 RETRAIT LIQUIDITÉ : -${removedQuote.toFixed(
        4
      )} SOL / -${Math.abs(dBase).toFixed(2)} tokens`
    );

    // Un retrait réel du pool est un signal bien plus important qu'un SELL.
    evaluateAlert(state).catch(() => {});
    return;
  }

  // AJOUT DE LIQUIDITÉ :
  // base ET quote augmentent.
  if (dBase > 0 && dQuote > 0) {
    addEvent(state, {
      ts: now(),
      type: "LIQ_ADD",
      quoteSol: dQuote,
      baseTokens: dBase,
      source,
    });

    console.log(
      `🟢 AJOUT LIQUIDITÉ : +${dQuote.toFixed(
        4
      )} SOL / +${dBase.toFixed(2)} tokens`
    );

    return;
  }

  console.log(
    `ℹ️ Variation non classée : base=${dBase.toFixed(
      6
    )}, quote=${dQuote.toFixed(6)}`
  );
}

// ------------------------------------------------------------
// Surveillance on-chain
// ------------------------------------------------------------

async function setupOnChain(state) {
  const poolInfo = await connection.getAccountInfo(
    state.poolPubkey,
    "processed"
  );

  if (!poolInfo) {
    throw new Error("Compte Pool introuvable");
  }

  const vaults = readPoolVaults(poolInfo);

  state.baseVault = vaults.baseVault;
  state.quoteVault = vaults.quoteVault;
  state.virtualQuoteRaw = vaults.virtualQuote;

  const infos =
    await connection.getMultipleAccountsInfo(
      [state.baseVault, state.quoteVault],
      "processed"
    );

  const baseRaw = readTokenAmount(infos[0]);
  const quoteRaw = readTokenAmount(infos[1]);

  if (baseRaw === null || quoteRaw === null) {
    throw new Error("Impossible de lire les réserves initiales");
  }

  state.previousBaseRaw = baseRaw;
  state.previousQuoteRaw = quoteRaw;

  state.baseRaw = baseRaw;
  state.quoteRaw = quoteRaw;

  state.baseDecimals =
    state.dex.baseDecimals || 6;

  state.baseTokens =
    Number(baseRaw) /
    Math.pow(10, state.baseDecimals);

  state.quoteSol =
    Number(quoteRaw) / 1e9;

  console.log(
    "🟢 Pool trouvé :",
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
    "🟢 Réserve WSOL initiale :",
    state.quoteSol.toFixed(4)
  );

  state.baseSub =
    await connection.onAccountChange(
      state.baseVault,
      (accountInfo, context) => {
        const raw =
          readTokenAmount(accountInfo);

        if (raw === null) return;

        state.pendingBaseRaw = raw;
        state.pendingSlot = context.slot;

        scheduleReserveProcess(state);
      },
      {
        commitment: "processed",
        encoding: "base64",
      }
    );

  state.quoteSub =
    await connection.onAccountChange(
      state.quoteVault,
      (accountInfo, context) => {
        const raw =
          readTokenAmount(accountInfo);

        if (raw === null) return;

        state.pendingQuoteRaw = raw;
        state.pendingSlot = context.slot;

        scheduleReserveProcess(state);
      },
      {
        commitment: "processed",
        encoding: "base64",
      }
    );

  state.logsSub =
    await connection.onLogs(
      state.poolPubkey,
      (logInfo) => {
        if (logInfo.err) return;

        const joined =
          (logInfo.logs || []).join(" ");

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
      },
      "processed"
    );

  state.onChainActive = true;
}

function scheduleReserveProcess(state) {
  if (state.reserveTimer) return;

  // On laisse les deux notifications d'un même mouvement arriver
  // avant de comparer l'ancien snapshot au nouveau.
  state.reserveTimer = setTimeout(() => {
    state.reserveTimer = null;

    const baseRaw =
      state.pendingBaseRaw !== undefined
        ? state.pendingBaseRaw
        : state.baseRaw;

    const quoteRaw =
      state.pendingQuoteRaw !== undefined
        ? state.pendingQuoteRaw
        : state.quoteRaw;

    state.pendingBaseRaw = undefined;
    state.pendingQuoteRaw = undefined;

    processReserveSnapshot(
      state,
      baseRaw,
      quoteRaw
    );
  }, 150);
}

async function stopOnChain(state) {
  try {
    if (state.baseSub !== undefined) {
      await connection.removeAccountChangeListener(
        state.baseSub
      );
    }
  } catch {}

  try {
    if (state.quoteSub !== undefined) {
      await connection.removeAccountChangeListener(
        state.quoteSub
      );
    }
  } catch {}

  try {
    if (state.logsSub !== undefined) {
      await connection.removeOnLogsListener(
        state.logsSub
      );
    }
  } catch {}

  state.baseSub = undefined;
  state.quoteSub = undefined;
  state.logsSub = undefined;
  state.onChainActive = false;
}

// ------------------------------------------------------------
// Polling DexScreener
// ------------------------------------------------------------

async function pollDex(state) {
  try {
    const dex =
      await fetchDexPair(state.mint);

    // Si le pair change, on garde l'ancien pool tant que le nouveau
    // n'est pas clairement différent. Pour ce bot, on ne change pas
    // de pool automatiquement pendant une position.
    if (
      state.poolAddress &&
      dex.pairAddress &&
      dex.pairAddress !== state.poolAddress
    ) {
      console.log(
        `⚠️ DexScreener a renvoyé une autre paire : ${dex.pairAddress}`
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

    if (dex.baseDecimals > 0) {
      state.baseDecimals =
        dex.baseDecimals;
    }

    const t = now();

    state.liquidityHistory.push({
      ts: t,
      value: state.liquidityUsd,
    });

    state.reserveHistory.push({
      ts: t,
      quoteSol: state.quoteSol,
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

    if (
      state.priceUsd >
      state.highPriceUsd
    ) {
      state.highPriceUsd =
        state.priceUsd;

      state.highAt = t;
    }

    await evaluateAlert(state);
  } catch (error) {
    console.error(
      "🔴 DexScreener :",
      error.message
    );
  }
}

// ------------------------------------------------------------
// Création du watcher
// ------------------------------------------------------------

async function startWatch(mint) {
  if (watched.has(mint)) {
    return watched.get(mint);
  }

  const dex =
    await fetchDexPair(mint);

  const state = {
    mint,

    poolAddress:
      dex.pairAddress,

    poolPubkey:
      new PublicKey(dex.pairAddress),

    dex,

    baseVault: null,
    quoteVault: null,

    previousBaseRaw: null,
    previousQuoteRaw: null,

    pendingBaseRaw: undefined,
    pendingQuoteRaw: undefined,

    baseRaw: null,
    quoteRaw: null,

    baseDecimals:
      dex.baseDecimals || 6,

    baseTokens: 0,
    quoteSol: 0,

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

    highAt: now(),

    events: [],
    liquidityHistory: [],
    reserveHistory: [],

    riskScore: 0,
    riskReasons: [],

    lastAlertAt: 0,
    lastAlertLevel: null,
    lastAlertScore: null,

    baseSub: undefined,
    quoteSub: undefined,
    logsSub: undefined,

    reserveTimer: null,

    onChainActive: false,
  };

  watched.set(mint, state);

  try {
    await setupOnChain(state);

    await pollDex(state);

    state.dexTimer =
      setInterval(
        () => pollDex(state),
        DEX_POLL_MS
      );

    state.healthTimer =
      setInterval(() => {
        console.log(
          `💓 ${mint.slice(0, 8)} | ` +
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
      }, HEALTH_LOG_MS);

    console.log(
      "🚀 RADAR V3 ACTIVÉ :",
      mint
    );

    return state;
  } catch (error) {
    watched.delete(mint);

    await stopOnChain(state);

    throw error;
  }
}

async function stopWatch(mint) {
  const state =
    watched.get(mint);

  if (!state) return false;

  clearInterval(
    state.dexTimer
  );

  clearInterval(
    state.healthTimer
  );

  if (state.reserveTimer) {
    clearTimeout(
      state.reserveTimer
    );
  }

  await stopOnChain(state);

  watched.delete(mint);

  return true;
}

// ------------------------------------------------------------
// Telegram commandes
// ------------------------------------------------------------

bot.start(async (ctx) => {
  await ctx.reply(
    "🤖 Radar Sortie V3 actif.\n\n" +
    "/watch MINT\n" +
    "/status\n" +
    "/unwatch"
  );
});

bot.command("watch", async (ctx) => {
  const parts =
    ctx.message.text
      .trim()
      .split(/\s+/);

  const mint = parts[1];

  if (!mint) {
    return ctx.reply(
      "Utilise : /watch ADRESSE_DU_TOKEN"
    );
  }

  try {
    new PublicKey(mint);
  } catch {
    return ctx.reply(
      "❌ Adresse Solana invalide."
    );
  }

  try {
    await startWatch(mint);

    await ctx.reply(
      "🟢 RADAR SORTIE V3 ACTIVÉ\n\n" +
      "Je surveille :\n" +
      "• vrais deltas des réserves\n" +
      "• SELL/BUY on-chain\n" +
      "• retraits de liquidité\n" +
      "• liquidité USD\n" +
      "• prix et sommet récent\n" +
      "• pression vendeuse persistante\n\n" +
      "⚠️ Une alerte n'est pas une garantie de sortie avant un crash."
    );
  } catch (error) {
    console.error(
      "🔴 /watch :",
      error
    );

    await ctx.reply(
      `❌ Impossible d'activer le radar : ${error.message}`
    );
  }
});

bot.command("unwatch", async (ctx) => {
  const mint =
    ctx.message.text
      .trim()
      .split(/\s+/)[1];

  if (mint) {
    const stopped =
      await stopWatch(mint);

    return ctx.reply(
      stopped
        ? `🛑 Surveillance arrêtée : ${mint}`
        : `ℹ️ Ce token n'était pas surveillé.`
    );
  }

  const all =
    [...watched.keys()];

  for (const item of all) {
    await stopWatch(item);
  }

  await ctx.reply(
    all.length
      ? `🛑 ${all.length} surveillance(s) arrêtée(s).`
      : "ℹ️ Aucune surveillance active."
  );
});

bot.command("status", async (ctx) => {
  if (!watched.size) {
    return ctx.reply(
      "📡 Aucun token surveillé."
    );
  }

  for (const state of watched.values()) {
    const risk =
      calculateRisk(state);

    const belowHigh =
      state.highPriceUsd > 0 &&
      state.priceUsd > 0
        ? (
            (
              state.highPriceUsd -
              state.priceUsd
            ) /
            state.highPriceUsd
          ) * 100
        : 0;

    await ctx.reply(
      `📡 RADAR V3\n\n` +
      `Token : ${state.mint}\n` +
      `Pool : ${state.poolAddress}\n\n` +
      `💰 Prix : $${state.priceUsd.toFixed(8)}\n` +
      `💧 Liquidité : $${state.liquidityUsd.toFixed(2)}\n` +
      `📈 Sommet : $${state.highPriceUsd.toFixed(8)}\n` +
      `📉 Sous sommet : ${belowHigh.toFixed(2)}%\n\n` +
      `🪙 WSOL réserve : ${state.quoteSol.toFixed(4)} SOL\n` +
      `🔴 SELL 10s : ${risk.sell10.sell.toFixed(4)} SOL\n` +
      `🔴 SELL ratio 10s : ${risk.sell10.sellRatio.toFixed(1)}%\n` +
      `🔴 SELL 30s : ${risk.sell30.sell.toFixed(4)} SOL\n\n` +
      `🎯 RISQUE : ${risk.score}/100\n` +
      `📡 On-chain : ${
        state.onChainActive
          ? "ACTIVE"
          : "OFF"
      }\n` +
      `🔎 Raisons : ${
        risk.reasons.slice(0, 5).join(" | ") ||
        "aucune"
      }`
    );
  }
});

bot.catch((error) => {
  console.error(
    "🔴 Telegram bot :",
    error.message
  );
});

// ------------------------------------------------------------
// Démarrage
// ------------------------------------------------------------

bot.launch();

console.log(
  "🤖 Pump Alert Bot Radar Sortie V3 démarré."
);

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
