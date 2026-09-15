require("dotenv").config();

const { Telegraf } = require("telegraf");

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN ou CHAT_ID manquant");
  process.exit(1);
}

const RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : "https://api.mainnet-beta.solana.com";

// ============================================================
// STRATEGIE
// ============================================================

const CAPITAL = 10;
const TARGET_PERCENT = 5;
const STOP_PERCENT = -20;

const MARKET_INTERVAL = 2000;
const PAIR_REFRESH_INTERVAL = 60000;
const COOLDOWN_AFTER_SELL = 30000;

const NO_NEW_BUY_MINUTES = 43;
const MAX_SESSION_MINUTES = 45;

const MIN_LIQUIDITY = 200000;
const MAX_LIQUIDITY = 400000;

const MIN_HOLDERS = 1000;
const MAX_AGE_MINUTES = 300;

// ============================================================
// ETAT
// ============================================================

let selectedMint = null;
let selectedPair = null;

let tradingActive = false;
let marketLoopRunning = false;

let sessionStartedAt = 0;
let lastSellAt = 0;

let position = null;
let lastMarket = null;

let sessionPnL = 0;
let sessionWins = 0;
let sessionLosses = 0;
let totalCycles = 0;

let lastCrash = null;

let lastPairRefresh = 0;
let sessionId = 0;

// ============================================================
// TELEGRAM
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

async function telegram(text) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (e) {
    console.error(
      "Telegram:",
      e.message
    );
  }
}

// ============================================================
// UTILITAIRES
// ============================================================

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

// ============================================================
// HTTP AVEC PROTECTION 429
// ============================================================

const httpCache = new Map();
const inflight = new Map();

async function fetchJson(
  url,
  cacheMs = 0
) {
  const cached = httpCache.get(url);

  if (
    cached &&
    Date.now() - cached.time < cacheMs
  ) {
    return cached.data;
  }

  if (inflight.has(url)) {
    return inflight.get(url);
  }

  const request = (async () => {
    let lastError = null;

    for (
      let attempt = 0;
      attempt < 5;
      attempt++
    ) {
      try {
        const response =
          await fetch(url, {
            headers: {
              accept:
                "application/json",
              "user-agent":
                "pump-simulation-bot"
            }
          });

        if (
          response.status === 429
        ) {
          const retryAfter =
            response.headers.get(
              "retry-after"
            );

          let wait =
            retryAfter
              ? Number(retryAfter) * 1000
              : 1000 *
                Math.pow(
                  2,
                  attempt
                );

          wait +=
            Math.floor(
              Math.random() * 500
            );

          await sleep(
            Math.min(
              wait,
              10000
            )
          );

          continue;
        }

        if (!response.ok) {
          throw new Error(
            `HTTP ${response.status}`
          );
        }

        const data =
          await response.json();

        httpCache.set(
          url,
          {
            time: Date.now(),
            data
          }
        );

        return data;

      } catch (e) {
        lastError = e;

        if (attempt < 4) {
          await sleep(
            1000 *
              Math.pow(
                2,
                attempt
              )
          );
        }
      }
    }

    throw (
      lastError ||
      new Error(
        "Erreur HTTP"
      )
    );
  })();

  inflight.set(
    url,
    request
  );

  try {
    return await request;
  } finally {
    inflight.delete(url);
  }
}

// ============================================================
// RPC SOLANA
// ============================================================

async function rpc(
  method,
  params = []
) {
  let lastError = null;

  for (
    let attempt = 0;
    attempt < 4;
    attempt++
  ) {
    try {
      const response =
        await fetch(
          RPC_URL,
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json"
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: Date.now(),
              method,
              params
            })
          }
        );

      if (
        response.status === 429
      ) {
        await sleep(
          1000 *
            Math.pow(
              2,
              attempt
            )
        );

        continue;
      }

      if (!response.ok) {
        throw new Error(
          `RPC_HTTP_${response.status}`
        );
      }

      const data =
        await response.json();

      if (data.error) {
        throw new Error(
          data.error.message ||
            "RPC_ERROR"
        );
      }

      return data.result;

    } catch (e) {
      lastError = e;

      if (attempt < 3) {
        await sleep(
          1000 *
            Math.pow(
              2,
              attempt
            )
        );
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "RPC_ERROR"
    )
  );
}

// ============================================================
// INFO TOKEN
// ============================================================

async function getTokenInfo(
  mint
) {
  try {
    return await fetchJson(
      `https://frontend-api-v3.pump.fun/coins/${mint}`,
      300000
    );
  } catch {
    return null;
  }
}

// ============================================================
// NOM / SYMBOLE
// ============================================================

function getName(
  info,
  pair,
  mint
) {
  const values = [
    info?.name,
    info?.symbol,
    pair?.baseToken?.address === mint
      ? pair?.baseToken?.name
      : null,
    pair?.baseToken?.address === mint
      ? pair?.baseToken?.symbol
      : null,
    pair?.quoteToken?.address === mint
      ? pair?.quoteToken?.name
      : null,
    pair?.quoteToken?.address === mint
      ? pair?.quoteToken?.symbol
      : null
  ];

  for (const value of values) {
    if (
      value &&
      String(value).trim()
    ) {
      return String(value).trim();
    }
  }

  return "Inconnu";
}

function getSymbol(
  info,
  pair,
  mint
) {
  const values = [
    info?.symbol,
    pair?.baseToken?.address === mint
      ? pair?.baseToken?.symbol
      : null,
    pair?.quoteToken?.address === mint
      ? pair?.quoteToken?.symbol
      : null
  ];

  for (const value of values) {
    if (
      value &&
      String(value).trim()
    ) {
      return String(value).trim();
    }
  }

  return "";
}

// ============================================================
// PUMPSWAP
// ============================================================

function isPumpSwap(pair) {
  if (!pair) return false;

  const dex =
    String(
      pair.dexId || ""
    ).toLowerCase();

  return (
    dex === "pumpswap" ||
    dex === "pump_amm" ||
    dex === "pumpamm" ||
    dex.includes("pump")
  );
}

function pairHasMint(
  pair,
  mint
) {
  return (
    pair?.baseToken?.address === mint ||
    pair?.quoteToken?.address === mint
  );
}

// ============================================================
// TROUVER LA PAIRE
// ============================================================

async function findPair(
  mint
) {
  const data =
    await fetchJson(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      30000
    );

  const pairs =
    Array.isArray(data?.pairs)
      ? data.pairs
      : [];

  const valid =
    pairs.filter(pair => {
      return (
        isPumpSwap(pair) &&
        pairHasMint(
          pair,
          mint
        ) &&
        Number(
          pair.liquidity?.usd || 0
        ) > 0
      );
    });

  if (!valid.length) {
    return null;
  }

  valid.sort(
    (a, b) =>
      Number(
        b.liquidity?.usd || 0
      ) -
      Number(
        a.liquidity?.usd || 0
      )
  );

  return valid[0];
}

// ============================================================
// HOLDERS
// ============================================================

const TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const holderCache =
  new Map();

async function holdersFromProgram(
  mint,
  programId
) {
  const accounts =
    await rpc(
      "getProgramAccounts",
      [
        programId,
        {
          encoding:
            "base64",
          filters: [
            {
              memcmp: {
                offset: 0,
                bytes: mint
              }
            }
          ],
          dataSlice: {
            offset: 32,
            length: 32
          }
        }
      ]
    );

  const owners =
    new Set();

  for (
    const account of accounts || []
  ) {
    const data =
      account?.account?.data;

    if (
      !Array.isArray(data) ||
      !data[0]
    ) {
      continue;
    }

    try {
      const owner =
        Buffer.from(
          data[0],
          "base64"
        ).toString("hex");

      if (owner) {
        owners.add(owner);
      }

      if (
        owners.size >=
        MIN_HOLDERS
      ) {
        return MIN_HOLDERS;
      }

    } catch {}
  }

  return owners.size;
}

async function getHolderCount(
  mint
) {
  const cached =
    holderCache.get(mint);

  if (
    cached &&
    Date.now() - cached.time <
      600000
  ) {
    return cached.count;
  }

  const allOwners =
    new Set();

  try {
    const programs = [
      TOKEN_PROGRAM,
      TOKEN_2022_PROGRAM
    ];

    for (
      const programId of programs
    ) {
      try {
        const count =
          await holdersFromProgram(
            mint,
            programId
          );

        if (
          count >=
          MIN_HOLDERS
        ) {
          holderCache.set(
            mint,
            {
              count:
                MIN_HOLDERS,
              time:
                Date.now()
            }
          );

          return MIN_HOLDERS;
        }

      } catch {}
    }

    // Deuxième méthode :
    // récupérer les comptes token via RPC
    // avec leurs propriétaires.

    for (
      const programId of programs
    ) {
      try {
        const accounts =
          await rpc(
            "getProgramAccounts",
            [
              programId,
              {
                encoding:
                  "jsonParsed",
                filters: [
                  {
                    memcmp: {
                      offset: 0,
                      bytes: mint
                    }
                  }
                ]
              }
            ]
          );

        for (
          const account of
            accounts || []
        ) {
          const info =
            account?.account?.data
              ?.parsed?.info;

          const amount =
            info?.tokenAmount
              ?.uiAmount;

          const owner =
            info?.owner;

          if (
            owner &&
            Number(amount || 0) > 0
          ) {
            allOwners.add(owner);
          }

          if (
            allOwners.size >=
            MIN_HOLDERS
          ) {
            holderCache.set(
              mint,
              {
                count:
                  MIN_HOLDERS,
                time:
                  Date.now()
              }
            );

            return MIN_HOLDERS;
          }
        }

      } catch {}
    }

    const count =
      allOwners.size;

    holderCache.set(
      mint,
      {
        count,
        time:
          Date.now()
      }
    );

    return count;

  } catch {
    if (cached) {
      return cached.count;
    }

    return 0;
  }
}

// ============================================================
// VERIFICATION DU TOKEN CHOISI
// ============================================================
//
// IMPORTANT :
// Le nom n'est PAS un filtre bloquant.
// Tu choisis toi-même le token.
//
// On garde seulement :
// PumpSwap
// Liquidité 200k-400k
// Âge < 5h
// Holders >= 1000
//
// ============================================================

async function verifySelectedToken(
  mint
) {
  const info =
    await getTokenInfo(
      mint
    );

  const pair =
    await findPair(
      mint
    );

  if (!pair) {
    return {
      ok: false,
      reason:
        "PUMPSWAP"
    };
  }

  const liquidity =
    Number(
      pair.liquidity?.usd || 0
    );

  if (
    liquidity <
      MIN_LIQUIDITY ||
    liquidity >
      MAX_LIQUIDITY
  ) {
    return {
      ok: false,
      reason:
        "LIQUIDITE",
      liquidity
    };
  }

  let ageMinutes = 0;

  let createdAt =
    Number(
      pair.pairCreatedAt || 0
    );

  if (createdAt) {
    if (
      createdAt <
      100000000000
    ) {
      createdAt *= 1000;
    }

    ageMinutes =
      (
        Date.now() -
        createdAt
      ) /
      60000;
  }

  if (
    ageMinutes >
      MAX_AGE_MINUTES
  ) {
    return {
      ok: false,
      reason:
        "AGE",
      liquidity,
      ageMinutes
    };
  }

  const holders =
    await getHolderCount(
      mint
    );

  if (
    holders <
    MIN_HOLDERS
  ) {
    return {
      ok: false,
      reason:
        "HOLDERS",
      liquidity,
      ageMinutes,
      holders
    };
  }

  return {
    ok: true,
    mint,
    name:
      getName(
        info,
        pair,
        mint
      ),
    symbol:
      getSymbol(
        info,
        pair,
        mint
      ),
    liquidity,
    ageMinutes,
    holders,
    pair
  };
}

// ============================================================
// MARKET
// ============================================================

async function getMarketData() {
  if (!selectedMint) {
    throw new Error(
      "NO_TOKEN_SELECTED"
    );
  }

  const now =
    Date.now();

  if (
    !selectedPair ||
    now -
      lastPairRefresh >
      PAIR_REFRESH_INTERVAL
  ) {
    const pair =
      await findPair(
        selectedMint
      );

    if (!pair) {
      throw new Error(
        "PUMPSWAP_PAIR_NOT_FOUND"
      );
    }

    selectedPair =
      pair;

    lastPairRefresh =
      now;
  }

  try {
    const direct =
      await fetchJson(
        `https://api.dexscreener.com/latest/dex/pairs/solana/${selectedPair.pairAddress}`,
        1500
      );

    if (direct?.pair) {
      selectedPair =
        direct.pair;
    }

  } catch {}

  const price =
    Number(
      selectedPair.priceUsd || 0
    );

  const liquidity =
    Number(
      selectedPair.liquidity?.usd ||
        0
    );

  if (
    !price ||
    !Number.isFinite(price)
  ) {
    throw new Error(
      "INVALID_PRICE"
    );
  }

  if (
    liquidity <= 0 ||
    !Number.isFinite(liquidity)
  ) {
    throw new Error(
      "INVALID_LIQUIDITY"
    );
  }

  return {
    price,
    liquidity,
    pairAddress:
      selectedPair.pairAddress,
    dex:
      selectedPair.dexId,
    timestamp:
      Date.now()
  };
}

// ============================================================
// TEMPS
// ============================================================

function elapsedMinutes() {
  if (!sessionStartedAt) {
    return 0;
  }

  return (
    Date.now() -
    sessionStartedAt
  ) / 60000;
}

// ============================================================
// PRIX CIBLE / STOP
// ============================================================

function getTargetPrice() {
  return (
    position.entryPrice *
    (
      1 +
      TARGET_PERCENT / 100
    )
  );
}

function getStopPrice() {
  return (
    position.entryPrice *
    (
      1 +
      STOP_PERCENT / 100
    )
  );
}

// ============================================================
// BUY
// ============================================================

async function simulateBuy(
  market
) {
  if (position) {
    return;
  }

  if (!tradingActive) {
    return;
  }

  if (
    elapsedMinutes() >=
    NO_NEW_BUY_MINUTES
  ) {
    return;
  }

  if (
    market.liquidity <
      MIN_LIQUIDITY ||
    market.liquidity >
      MAX_LIQUIDITY
  ) {
    return;
  }

  position = {
    id:
      totalCycles + 1,
    entryPrice:
      market.price,
    entryLiquidity:
      market.liquidity,
    entryTime:
      Date.now()
  };

  totalCycles++;

  const name =
    currentCandidateName();

  await telegram(
    `🟢 BUY SIMULÉ #${position.id}\n\n` +
    `🪙 ${name}\n` +
    `💵 Capital : $${CAPITAL.toFixed(2)}\n` +
    `💰 Prix : ${market.price.toFixed(10)} $\n` +
    `💧 Liquidité : $${market.liquidity.toFixed(2)}\n\n` +
    `🎯 Vente cible : ${getTargetPrice().toFixed(10)} $\n` +
    `🛑 Stop sécurité : ${getStopPrice().toFixed(10)} $\n\n` +
    `SIMULATION UNIQUEMENT`
  );
}

// ============================================================
// NOM COURANT
// ============================================================

let currentCandidateNameValue =
  "Inconnu";

function currentCandidateName() {
  return (
    currentCandidateNameValue ||
    "Inconnu"
  );
}

// ============================================================
// SELL
// ============================================================

async function simulateSell(
  market,
  reason
) {
  if (!position) {
    return;
  }

  const entry =
    position.entryPrice;

  const exit =
    market.price;

  const percent =
    (
      (exit - entry) /
      entry
    ) *
    100;

  const pnl =
    CAPITAL *
    (
      percent / 100
    );

  sessionPnL += pnl;

  if (pnl >= 0) {
    sessionWins++;
  } else {
    sessionLosses++;
  }

  const id =
    position.id;

  let emoji = "🎯";

  if (
    reason === "STOP"
  ) {
    emoji = "🛑";
  }

  if (
    reason === "CRASH"
  ) {
    emoji = "🚨";
  }

  if (
    reason ===
    "SESSION_LIMIT"
  ) {
    emoji = "⏱️";
  }

  position = null;

  lastSellAt =
    Date.now();

  await telegram(
    `${emoji} SELL SIMULÉ #${id}\n\n` +
    `Motif : ${reason}\n` +
    `Entrée : ${entry.toFixed(10)} $\n` +
    `Sortie : ${exit.toFixed(10)} $\n` +
    `Résultat : ${percent >= 0 ? "+" : ""}${percent.toFixed(2)} %\n` +
    `P&L : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n\n` +
    `💰 P&L session : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );
}

// ============================================================
// CRASH
// ============================================================

function detectCrash(
  market
) {
  if (!lastMarket) {
    return null;
  }

  const priceChange =
    (
      (
        market.price -
        lastMarket.price
      ) /
      lastMarket.price
    ) *
    100;

  const liquidityChange =
    (
      (
        market.liquidity -
        lastMarket.liquidity
      ) /
      Math.max(
        lastMarket.liquidity,
        1
      )
    ) *
    100;

  if (
    market.liquidity <= 1
  ) {
    return {
      priceChange,
      liquidityChange
    };
  }

  if (
    liquidityChange <= -50
  ) {
    return {
      priceChange,
      liquidityChange
    };
  }

  if (
    priceChange <= -20
  ) {
    return {
      priceChange,
      liquidityChange
    };
  }

  return null;
}

// ============================================================
// SESSION 45 MIN
// ============================================================

async function finishSession() {
  if (
    position &&
    lastMarket
  ) {
    await simulateSell(
      lastMarket,
      "SESSION_LIMIT"
    );
  }

  tradingActive =
    false;

  sessionId++;

  await telegram(
    `⏱️ SESSION TERMINÉE\n\n` +
    `Durée : 45 min\n` +
    `Cycles : ${totalCycles}\n` +
    `Gagnants : ${sessionWins}\n` +
    `Perdants : ${sessionLosses}\n` +
    `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );
}

// ============================================================
// BOUCLE TRADING
// ============================================================

async function marketTick(
  localSession
) {
  if (!tradingActive) {
    return;
  }

  if (
    localSession !==
    sessionId
  ) {
    return;
  }

  if (marketLoopRunning) {
    return;
  }

  marketLoopRunning =
    true;

  try {
    // --------------------------------------------------------
    // 45 MIN
    // --------------------------------------------------------

    if (
      elapsedMinutes() >=
      MAX_SESSION_MINUTES
    ) {
      await finishSession();
      return;
    }

    // --------------------------------------------------------
    // MARKET
    // --------------------------------------------------------

    const market =
      await getMarketData();

    // --------------------------------------------------------
    // CRASH
    // --------------------------------------------------------

    const crash =
      detectCrash(
        market
      );

    if (crash) {
      if (position) {
        await simulateSell(
          market,
          "CRASH"
        );
      }

      lastCrash = {
        price:
          market.price,
        liquidity:
          market.liquidity,
        priceChange:
          crash.priceChange,
        liquidityChange:
          crash.liquidityChange,
        time:
          Date.now()
      };

      tradingActive =
        false;

      sessionId++;

      await telegram(
        `🚨 CRASH DÉTECTÉ\n\n` +
        `Prix : ${market.price.toFixed(10)} $\n` +
        `Liquidité : $${market.liquidity.toFixed(2)}\n` +
        `Prix : ${crash.priceChange.toFixed(2)} %\n` +
        `Liquidité : ${crash.liquidityChange.toFixed(2)} %\n\n` +
        `🛑 Nouveaux achats arrêtés.\n\n` +
        `💰 P&L session : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
      );

      return;
    }

    // --------------------------------------------------------
    // POSITION OUVERTE
    // --------------------------------------------------------

    if (position) {
      if (
        market.price >=
        getTargetPrice()
      ) {
        await simulateSell(
          market,
          "TARGET"
        );

      } else if (
        market.price <=
        getStopPrice()
      ) {
        await simulateSell(
          market,
          "STOP"
        );
      }

      lastMarket =
        market;

      return;
    }

    // --------------------------------------------------------
    // NOUVEAU BUY
    // --------------------------------------------------------

    if (
      elapsedMinutes() <
        NO_NEW_BUY_MINUTES &&
      Date.now() -
        lastSellAt >=
        COOLDOWN_AFTER_SELL
    ) {
      await simulateBuy(
        market
      );
    }

    lastMarket =
      market;

  } catch (e) {
    console.error(
      "Market:",
      e.message
    );
  } finally {
    marketLoopRunning =
      false;
  }
}

// ============================================================
// START TRADE
// ============================================================

async function startTrade() {
  if (tradingActive) {
    await telegram(
      `⚠️ Une session est déjà en cours.`
    );
    return;
  }

  if (!selectedMint) {
    await telegram(
      `❌ Aucun token sélectionné.\n\n` +
      `Utilise :\n` +
      `/token MINT`
    );
    return;
  }

  sessionId++;

  const localSession =
    sessionId;

  tradingActive =
    true;

  sessionStartedAt =
    Date.now();

  lastSellAt =
    0;

  position = null;
  lastMarket = null;

  sessionPnL = 0;
  sessionWins = 0;
  sessionLosses = 0;
  totalCycles = 0;

  await telegram(
    `🟢 TEST ACHAT / VENTE ACTIF\n\n` +
    `🪙 ${currentCandidateName()}\n` +
    `💵 $10 / cycle\n` +
    `🎯 +5 %\n` +
    `🛑 -20 % sécurité\n\n` +
    `🏦 PumpSwap\n` +
    `⏱️ 45 min maximum\n` +
    `🚫 Aucun BUY après 43 min\n\n` +
    `SIMULATION UNIQUEMENT`
  );

  while (
    tradingActive &&
    localSession ===
      sessionId
  ) {
    await marketTick(
      localSession
    );

    await sleep(
      MARKET_INTERVAL
    );
  }
}

// ============================================================
// /TOKEN
// ============================================================
//
// Tu choisis directement le token.
// Plus de phase TEST.
// Le nom n'est pas utilisé pour bloquer.
//
// ============================================================

bot.command(
  "token",
  async ctx => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    const mint =
      parts[1];

    if (!mint) {
      await ctx.reply(
        `❌ Utilisation :\n/token MINT`
      );
      return;
    }

    if (tradingActive) {
      await ctx.reply(
        `⚠️ Arrête d'abord la session avec /stoptrade.`
      );
      return;
    }

    await ctx.reply(
      `🔎 Vérification du token...`
    );

    try {
      const result =
        await verifySelectedToken(
          mint
        );

      if (!result.ok) {
        await ctx.reply(
          `❌ TOKEN REFUSÉ\n\n` +
          `Mint :\n${mint}\n\n` +
          `Motif : ${result.reason}`
        );

        return;
      }

      selectedMint =
        mint;

      selectedPair =
        result.pair;

      lastPairRefresh =
        Date.now();

      currentCandidateNameValue =
        result.name;

      await ctx.reply(
        `🟢 TOKEN SÉLECTIONNÉ\n\n` +
        `🪙 ${result.name}\n` +
        `🔤 ${result.symbol}\n\n` +
        `💧 Liquidité : $${result.liquidity.toFixed(2)}\n` +
        `👥 Holders : ≥${MIN_HOLDERS}\n` +
        `⏱️ Âge : ${result.ageMinutes.toFixed(1)} min\n` +
        `🏦 PumpSwap : 🟢\n\n` +
        `🔗 Pair : ${result.pair.pairAddress}\n\n` +
        `➡️ /starttrade`
      );

    } catch (e) {
      await ctx.reply(
        `❌ Impossible de vérifier le token.\n\n` +
        `${e.message}`
      );
    }
  }
);

// ============================================================
// /STARTTRADE
// ============================================================

bot.command(
  "starttrade",
  async () => {
    await startTrade();
  }
);

// ============================================================
// /STOPTRADE
// ============================================================

bot.command(
  "stoptrade",
  async () => {
    if (!tradingActive) {
      await telegram(
        `ℹ️ Aucune session en cours.`
      );
      return;
    }

    tradingActive =
      false;

    sessionId++;

    if (
      position &&
      lastMarket
    ) {
      await simulateSell(
        lastMarket,
        "SESSION_LIMIT"
      );
    }

    await telegram(
      `⏹️ SESSION ARRÊTÉE\n\n` +
      `Cycles : ${totalCycles}\n` +
      `Gagnants : ${sessionWins}\n` +
      `Perdants : ${sessionLosses}\n` +
      `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
    );
  }
);

// ============================================================
// /STATUS
// ============================================================

bot.command(
  "status",
  async ctx => {
    if (!selectedMint) {
      await ctx.reply(
        `ℹ️ Aucun token sélectionné.\n\n` +
        `/token MINT`
      );
      return;
    }

    let text =
      `📊 STATUT\n\n` +
      `🪙 ${currentCandidateName()}\n` +
      `💵 $10 / cycle\n` +
      `🎯 +5 %\n` +
      `🛑 -20 %\n\n` +
      `Session : ${elapsedMinutes().toFixed(1)} min\n` +
      `Cycles : ${totalCycles}\n` +
      `Gagnants : ${sessionWins}\n` +
      `Perdants : ${sessionLosses}\n` +
      `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}\n`;

    if (position) {
      text +=
        `\n🟢 POSITION OUVERTE\n` +
        `Entrée : ${position.entryPrice.toFixed(10)} $\n` +
        `Cible : ${getTargetPrice().toFixed(10)} $\n` +
        `Stop : ${getStopPrice().toFixed(10)} $\n`;
    } else {
      text +=
        `\n⚪ Aucune position ouverte`;
    }

    if (lastMarket) {
      text +=
        `\n\n💰 Prix : ${lastMarket.price.toFixed(10)} $\n` +
        `💧 Liquidité : $${lastMarket.liquidity.toFixed(2)}`;
    }

    await ctx.reply(
      text
    );
  }
);

// ============================================================
// /LASTCRASH
// ============================================================

bot.command(
  "lastcrash",
  async ctx => {
    if (!lastCrash) {
      await ctx.reply(
        `ℹ️ Aucun crash enregistré.`
      );
      return;
    }

    await ctx.reply(
      `🚨 DERNIER CRASH\n\n` +
      `Prix : ${lastCrash.price.toFixed(10)} $\n` +
      `Liquidité : $${lastCrash.liquidity.toFixed(2)}\n` +
      `Prix : ${lastCrash.priceChange.toFixed(2)} %\n` +
      `Liquidité : ${lastCrash.liquidityChange.toFixed(2)} %`
    );
  }
);

// ============================================================
// /HELP
// ============================================================

bot.command(
  "help",
  async ctx => {
    await ctx.reply(
      `🤖 COMMANDES\n\n` +
      `/token MINT\n` +
      `/starttrade\n` +
      `/stoptrade\n` +
      `/status\n` +
      `/lastcrash\n` +
      `/help\n\n` +
      `Tu choisis toi-même le token.\n\n` +
      `Filtres conservés :\n` +
      `• PumpSwap\n` +
      `• liquidité 200k–400k $\n` +
      `• minimum 1 000 holders\n` +
      `• moins de 5 heures\n\n` +
      `Trading :\n` +
      `• $10 / achat\n` +
      `• objectif +5 %\n` +
      `• stop -20 %\n` +
      `• 45 min maximum\n` +
      `• aucun achat après 43 min\n` +
      `• un seul achat à la fois\n\n` +
      `SIMULATION UNIQUEMENT`
    );
  }
);

// ============================================================
// /START
// ============================================================

bot.start(
  async ctx => {
    await ctx.reply(
      `🤖 BOT ACHAT / VENTE\n\n` +
      `Choisis directement ton token :\n\n` +
      `/token MINT\n\n` +
      `Puis :\n` +
      `/starttrade\n\n` +
      `Filtres conservés :\n` +
      `• PumpSwap\n` +
      `• liquidité 200k–400k $\n` +
      `• ≥ 1 000 holders\n` +
      `• < 5 heures\n\n` +
      `Stratégie :\n` +
      `• $10 / cycle\n` +
      `• +5 % cible\n` +
      `• -20 % stop\n` +
      `• 45 min maximum\n` +
      `• aucun BUY après 43 min\n` +
      `• une seule position\n\n` +
      `SIMULATION UNIQUEMENT`
    );
  }
);

// ============================================================
// LANCEMENT
// ============================================================

bot.launch({
  dropPendingUpdates: true
})
.then(() => {
  console.log(
    "🤖 Bot achat/vente démarré"
  );

  console.log(
    "🟢 Sélection manuelle des tokens"
  );

  console.log(
    "🟢 Une seule position"
  );

  console.log(
    "💵 $10 / cycle"
  );

  console.log(
    "🎯 +5%"
  );

  console.log(
    "🛑 -20%"
  );

  console.log(
    "⏱️ 45 minutes"
  );
})
.catch(err => {
  console.error(
    "❌ Telegram:",
    err.message
  );
});

process.once(
  "SIGINT",
  () => {
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    bot.stop("SIGTERM");
  }
);
