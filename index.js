require("dotenv").config();

const { Telegraf } = require("telegraf");
const {
  Connection,
  PublicKey,
} = require("@solana/web3.js");
const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN manquant");
if (!CHAT_ID) throw new Error("CHAT_ID manquant");
if (!HELIUS_API_KEY) throw new Error("HELIUS_API_KEY manquant");

const bot = new Telegraf(BOT_TOKEN);

const RPC_URL =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const WSS_URL =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const connection = new Connection(RPC_URL, "processed");

// ===============================
// CONFIG V5.3
// ===============================

const TOKEN_MINT =
  "5XnMHrs45GNHqNpPNHd8bepoHdRhFBppZdUieP4MKa1S";

const CAPITAL = 10;
const TARGET_PERCENT = 5;

const MARKET_INTERVAL = 2000;
const HISTORY_MS = 120000;

const MIN_LIQUIDITY = 3000;

const MAX_PRICE_DROP_10S = -5;
const MAX_LIQUIDITY_DROP_10S = -12;
const MAX_LIQUIDITY_DROP_30S = -20;

const CRASH_PRICE_DROP_10S = -20;
const CRASH_LIQUIDITY_DROP_10S = -50;

const COOLDOWN_AFTER_SELL = 15000;

const NO_NEW_BUY_AFTER_MIN = 43;
const MAX_SESSION_MIN = 45;

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ===============================
// PUMPSWAP
// ===============================

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const WSOL_MINT =
  "So11111111111111111111111111111111111111112";

const BASE_MINT_OFFSET = 43;
const QUOTE_MINT_OFFSET = 75;

const BASE_VAULT_OFFSET = 139;
const QUOTE_VAULT_OFFSET = 171;

const VIRTUAL_QUOTE_OFFSET = 245;

// ===============================
// ÉTAT
// ===============================

let running = false;
let startTime = null;

let poolAddress = null;
let baseVault = null;
let quoteVault = null;

let baseBalance = null;
let quoteBalance = null;

let lastMarket = null;
let lastMarketTime = 0;

let marketHistory = [];

let position = null;
let cycleNumber = 0;

let sessionPnL = 0;
let wins = 0;
let losses = 0;

let lastSellTime = 0;

let crashDetected = false;

let baseSubId = null;
let quoteSubId = null;
let poolSubId = null;

let ws = null;

let previousBase = null;
let previousQuote = null;

let pendingBase = null;
let pendingQuote = null;

let flushTimer = null;

// ===============================
// FICHIERS
// ===============================

function appendJSONL(file, data) {
  try {
    fs.appendFileSync(
      path.join(DATA_DIR, file),
      JSON.stringify(data) + "\n"
    );
  } catch (e) {
    console.log("Erreur écriture JSONL:", e.message);
  }
}

function saveJSON(file, data) {
  try {
    fs.writeFileSync(
      path.join(DATA_DIR, file),
      JSON.stringify(data, null, 2)
    );
  } catch (e) {
    console.log("Erreur sauvegarde:", e.message);
  }
}

// ===============================
// TELEGRAM
// ===============================

async function send(text) {
  try {
    await bot.telegram.sendMessage(CHAT_ID, text);
  } catch (e) {
    console.log("Telegram:", e.message);
  }
}

// ===============================
// OUTILS
// ===============================

function shortMint(mint) {
  if (!mint) return "N/A";
  return `${mint.slice(0, 6)}...${mint.slice(-6)}`;
}

function pct(a, b) {
  if (!a || !b) return 0;
  return ((b - a) / a) * 100;
}

function elapsedMinutes() {
  if (!startTime) return 0;
  return (Date.now() - startTime) / 60000;
}

function formatPrice(price) {
  if (!price) return "0";
  return Number(price).toFixed(10);
}

// ===============================
// DEXSCREENER
// ===============================

let dexCache = null;
let dexCacheTime = 0;

async function getDexPair() {
  try {
    if (
      dexCache &&
      Date.now() - dexCacheTime < 5000
    ) {
      return dexCache;
    }

    const url =
      `https://api.dexscreener.com/latest/dex/tokens/${TOKEN_MINT}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`DexScreener HTTP ${response.status}`);
    }

    const data = await response.json();

    const pairs = (data.pairs || []).filter((p) => {
      const dex = String(p.dexId || "").toLowerCase();

      return (
        (dex === "pumpswap" ||
          dex === "pump_amm" ||
          dex === "pumpamm" ||
          dex.includes("pump")) &&
        p.chainId === "solana" &&
        p.baseToken &&
        p.baseToken.address === TOKEN_MINT
      );
    });

    if (!pairs.length) {
      return null;
    }

    pairs.sort((a, b) => {
      const la = Number(a.liquidity?.usd || 0);
      const lb = Number(b.liquidity?.usd || 0);
      return lb - la;
    });

    dexCache = pairs[0];
    dexCacheTime = Date.now();

    return dexCache;
  } catch (e) {
    console.log("DexScreener:", e.message);
    return null;
  }
}

// ===============================
// RECHERCHE POOL PUMPSWAP
// ===============================

function readPubkey(data, offset) {
  try {
    return new PublicKey(
      data.slice(offset, offset + 32)
    ).toBase58();
  } catch {
    return null;
  }
}

async function findPumpSwapPool() {
  try {
    console.log("🔎 Recherche du pool PumpSwap...");

    const accounts =
      await connection.getProgramAccounts(
        new PublicKey(PUMPSWAP_PROGRAM),
        {
          commitment: "processed",
          filters: [
            {
              memcmp: {
                offset: BASE_MINT_OFFSET,
                bytes: TOKEN_MINT,
              },
            },
          ],
        }
      );

    console.log(
      `🔎 Pools candidats: ${accounts.length}`
    );

    let best = null;

    for (const item of accounts) {
      const data = item.account.data;

      if (!Buffer.isBuffer(data)) continue;

      if (data.length < 203) continue;

      const baseMint =
        readPubkey(data, BASE_MINT_OFFSET);

      const quoteMint =
        readPubkey(data, QUOTE_MINT_OFFSET);

      if (baseMint !== TOKEN_MINT) continue;
      if (quoteMint !== WSOL_MINT) continue;

      const baseVault =
        readPubkey(data, BASE_VAULT_OFFSET);

      const quoteVault =
        readPubkey(data, QUOTE_VAULT_OFFSET);

      if (!baseVault || !quoteVault) continue;

      let quoteReserve = 0;

      try {
        const quoteInfo =
          await connection.getTokenAccountBalance(
            new PublicKey(quoteVault),
            "processed"
          );

        quoteReserve =
          Number(quoteInfo.value.uiAmount || 0);
      } catch {}

      if (
        !best ||
        quoteReserve > best.quoteReserve
      ) {
        best = {
          pool: item.pubkey.toBase58(),
          baseMint,
          quoteMint,
          baseVault,
          quoteVault,
          quoteReserve,
        };
      }
    }

    if (!best) {
      console.log(
        "❌ Aucun pool PumpSwap SOL valide"
      );
      return null;
    }

    console.log("✅ Pool PumpSwap trouvé");
    console.log("Pool:", best.pool);
    console.log("Base vault:", best.baseVault);
    console.log("Quote vault:", best.quoteVault);
    console.log(
      "Réserve SOL:",
      best.quoteReserve
    );

    return best;
  } catch (e) {
    console.log(
      "Erreur recherche pool:",
      e.message
    );

    return null;
  }
}

// ===============================
// VALIDATION POOL
// ===============================

async function loadPool() {
  const dexPair = await getDexPair();

  if (dexPair) {
    console.log(
      "DEX PumpSwap:",
      dexPair.pairAddress
    );
  }

  const pool = await findPumpSwapPool();

  if (!pool) {
    return false;
  }

  poolAddress = pool.pool;
  baseVault = pool.baseVault;
  quoteVault = pool.quoteVault;

  return true;
}

// ===============================
// VAULTS
// ===============================

async function getVaultAmount(address) {
  try {
    const info =
      await connection.getTokenAccountBalance(
        new PublicKey(address),
        "processed"
      );

    return Number(info.value.uiAmount || 0);
  } catch (e) {
    return null;
  }
}

async function refreshVaultBalances() {
  if (!baseVault || !quoteVault) {
    return false;
  }

  const [base, quote] =
    await Promise.all([
      getVaultAmount(baseVault),
      getVaultAmount(quoteVault),
    ]);

  if (base === null || quote === null) {
    return false;
  }

  baseBalance = base;
  quoteBalance = quote;

  return true;
}

// ===============================
// WEBSOCKET HELIUS
// ===============================

function startWebSocket() {
  try {
    ws = new WebSocket(WSS_URL);

    ws.on("open", () => {
      console.log("🟢 Helius WebSocket connecté");

      if (baseVault) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "accountSubscribe",
            params: [
              baseVault,
              {
                commitment: "processed",
                encoding: "base64",
              },
            ],
          })
        );
      }

      if (quoteVault) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "accountSubscribe",
            params: [
              quoteVault,
              {
                commitment: "processed",
                encoding: "base64",
              },
            ],
          })
        );
      }

      if (poolAddress) {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "accountSubscribe",
            params: [
              poolAddress,
              {
                commitment: "processed",
                encoding: "base64",
              },
            ],
          })
        );
      }
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.id === 1) {
          baseSubId = msg.result;
          console.log(
            "Base subscription:",
            baseSubId
          );
          return;
        }

        if (msg.id === 2) {
          quoteSubId = msg.result;
          console.log(
            "Quote subscription:",
            quoteSubId
          );
          return;
        }

        if (msg.id === 3) {
          poolSubId = msg.result;
          console.log(
            "Pool subscription:",
            poolSubId
          );
          return;
        }

        if (
          msg.method !==
          "accountNotification"
        ) {
          return;
        }

        const sub = msg.params?.subscription;

        const value =
          msg.params?.result?.value;

        if (!value) return;

        const lamports =
          Number(value.lamports || 0);

        if (sub === baseSubId) {
          pendingBase = lamports;
        }

        if (sub === quoteSubId) {
          pendingQuote = lamports;
        }

        if (
          pendingBase !== null &&
          pendingQuote !== null
        ) {
          if (!flushTimer) {
            flushTimer = setTimeout(
              processVaultPair,
              80
            );
          }
        }
      } catch (e) {
        console.log(
          "WS parse:",
          e.message
        );
      }
    });

    ws.on("error", (e) => {
      console.log(
        "Helius WS:",
        e.message
      );
    });

    ws.on("close", () => {
      console.log(
        "🔴 Helius WebSocket fermé"
      );

      if (running) {
        setTimeout(() => {
          if (running) startWebSocket();
        }, 3000);
      }
    });
  } catch (e) {
    console.log(
      "WS erreur:",
      e.message
    );
  }
}

// ===============================
// ANALYSE VAULTS
// ===============================

function processVaultPair() {
  flushTimer = null;

  const b = pendingBase;
  const q = pendingQuote;

  pendingBase = null;
  pendingQuote = null;

  if (b === null || q === null) {
    return;
  }

  if (
    previousBase === null ||
    previousQuote === null
  ) {
    previousBase = b;
    previousQuote = q;
    return;
  }

  const baseDelta =
    b - previousBase;

  const quoteDelta =
    q - previousQuote;

  previousBase = b;
  previousQuote = q;

  const baseSol =
    baseDelta / 1e9;

  const quoteSol =
    quoteDelta / 1e9;

  if (
    Math.abs(baseSol) < 0.0001 &&
    Math.abs(quoteSol) < 0.0001
  ) {
    return;
  }

  let type = "UNKNOWN";

  if (
    baseDelta < 0 &&
    quoteDelta > 0
  ) {
    type = "SELL";
  } else if (
    baseDelta > 0 &&
    quoteDelta < 0
  ) {
    type = "BUY";
  } else if (
    baseDelta < 0 &&
    quoteDelta < 0
  ) {
    type = "WITHDRAWAL";
  } else if (
    baseDelta > 0 &&
    quoteDelta > 0
  ) {
    type = "ADDITION";
  }

  const event = {
    time: new Date().toISOString(),
    type,
    baseDelta: baseSol,
    quoteDelta: quoteSol,
  };

  appendJSONL(
    "v5_3_vault_events.jsonl",
    event
  );

  console.log(
    `⛓️ ${type} | base ${baseSol.toFixed(4)} | quote ${quoteSol.toFixed(4)}`
  );
}

// ===============================
// MARCHÉ DEX
// ===============================

async function getMarketData() {
  const pair = await getDexPair();

  if (!pair) {
    return null;
  }

  const price =
    Number(pair.priceUsd || 0);

  const liquidity =
    Number(pair.liquidity?.usd || 0);

  if (!price || liquidity <= 0) {
    return null;
  }

  return {
    time: Date.now(),
    price,
    liquidity,
    pairAddress:
      pair.pairAddress,
    dexId: pair.dexId,
    volume24h:
      Number(pair.volume?.h24 || 0),
  };
}

// ===============================
// HISTORIQUE
// ===============================

function updateHistory(market) {
  marketHistory.push(market);

  const cutoff =
    Date.now() - HISTORY_MS;

  marketHistory =
    marketHistory.filter(
      (x) => x.time >= cutoff
    );

  appendJSONL(
    "v5_3_market_history.jsonl",
    market
  );
}

function getOldestWithin(ms) {
  const cutoff =
    Date.now() - ms;

  for (let i = 0; i < marketHistory.length; i++) {
    if (
      marketHistory[i].time >= cutoff
    ) {
      return marketHistory[i];
    }
  }

  return null;
}

function priceDrop10s() {
  const old = getOldestWithin(10000);

  if (!old || !lastMarket) {
    return null;
  }

  return pct(
    old.price,
    lastMarket.price
  );
}

function liquidityDrop10s() {
  const old = getOldestWithin(10000);

  if (!old || !lastMarket) {
    return null;
  }

  return pct(
    old.liquidity,
    lastMarket.liquidity
  );
}

function liquidityDrop30s() {
  const cutoff =
    Date.now() - 30000;

  let old = null;

  for (const item of marketHistory) {
    if (item.time >= cutoff) {
      old = item;
      break;
    }
  }

  if (!old || !lastMarket) {
    return null;
  }

  return pct(
    old.liquidity,
    lastMarket.liquidity
  );
}

// ===============================
// CRASH
// ===============================

function checkCrash() {
  if (!lastMarket) {
    return false;
  }

  const p10 = priceDrop10s();
  const l10 = liquidityDrop10s();

  if (
    lastMarket.liquidity <= 1
  ) {
    return true;
  }

  if (
    p10 !== null &&
    p10 <= CRASH_PRICE_DROP_10S
  ) {
    return true;
  }

  if (
    l10 !== null &&
    l10 <= CRASH_LIQUIDITY_DROP_10S
  ) {
    return true;
  }

  return false;
}

// ===============================
// CONDITIONS D'ENTRÉE
// ===============================

function canBuy() {
  if (!lastMarket) {
    return {
      ok: false,
      reason: "NO_MARKET",
    };
  }

  if (
    elapsedMinutes() >=
    NO_NEW_BUY_AFTER_MIN
  ) {
    return {
      ok: false,
      reason: "43_MIN_CUTOFF",
    };
  }

  if (
    lastMarket.liquidity <
    MIN_LIQUIDITY
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_TOO_LOW",
    };
  }

  if (
    marketHistory.length < 8
  ) {
    return {
      ok: false,
      reason: "HISTORY_WARMUP",
    };
  }

  const p10 = priceDrop10s();
  const l10 = liquidityDrop10s();
  const l30 = liquidityDrop30s();

  if (
    p10 !== null &&
    p10 <= MAX_PRICE_DROP_10S
  ) {
    return {
      ok: false,
      reason: "PRICE_DROP_10S",
    };
  }

  if (
    l10 !== null &&
    l10 <= MAX_LIQUIDITY_DROP_10S
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_DROP_10S",
    };
  }

  if (
    l30 !== null &&
    l30 <= MAX_LIQUIDITY_DROP_30S
  ) {
    return {
      ok: false,
      reason: "LIQUIDITY_DROP_30S",
    };
  }

  if (
    Date.now() - lastSellTime <
    COOLDOWN_AFTER_SELL
  ) {
    return {
      ok: false,
      reason: "COOLDOWN",
    };
  }

  return {
    ok: true,
    reason: "OK",
  };
}

// ===============================
// BUY
// ===============================

async function simulateBuy() {
  if (position) return;

  const check = canBuy();

  if (!check.ok) {
    return;
  }

  const price =
    lastMarket.price;

  const target =
    price *
    (1 + TARGET_PERCENT / 100);

  position = {
    cycle: ++cycleNumber,
    entryPrice: price,
    targetPrice: target,
    entryTime: Date.now(),
    capital: CAPITAL,
    entryLiquidity:
      lastMarket.liquidity,
  };

  const msg =
    `🟢 BUY SIMULÉ #${position.cycle}\n\n` +
    `💵 Capital : $${CAPITAL.toFixed(2)}\n` +
    `💰 Prix : ${formatPrice(price)} $\n` +
    `💧 Liquidité : $${lastMarket.liquidity.toFixed(2)}\n\n` +
    `🎯 Vente cible : ${formatPrice(target)} $\n\n` +
    `⏱️ Session : ${elapsedMinutes().toFixed(1)} min\n` +
    `🧪 SIMULATION UNIQUEMENT`;

  await send(msg);
}

// ===============================
// SELL
// ===============================

async function simulateSell(reason) {
  if (!position || !lastMarket) {
    return;
  }

  const entry =
    position.entryPrice;

  const exit =
    lastMarket.price;

  const result =
    ((exit - entry) / entry) * 100;

  const pnl =
    CAPITAL * (result / 100);

  sessionPnL += pnl;

  if (result >= 0) {
    wins++;
  } else {
    losses++;
  }

  const trade = {
    cycle: position.cycle,
    reason,
    entry,
    exit,
    resultPercent: result,
    pnl,
    entryLiquidity:
      position.entryLiquidity,
    exitLiquidity:
      lastMarket.liquidity,
    time:
      new Date().toISOString(),
  };

  appendJSONL(
    "v5_3_trades.jsonl",
    trade
  );

  await send(
    `${reason === "CRASH" ? "🚨" : "🎯"} SELL SIMULÉ #${position.cycle}\n\n` +
    `Motif : ${reason}\n` +
    `Entrée : ${formatPrice(entry)} $\n` +
    `Sortie : ${formatPrice(exit)} $\n` +
    `Résultat : ${result >= 0 ? "+" : ""}${result.toFixed(2)} %\n` +
    `P&L : ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}\n\n` +
    `💰 P&L session : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );

  position = null;
  lastSellTime = Date.now();
}

// ===============================
// CRASH REPORT
// ===============================

async function handleCrash() {
  if (crashDetected) {
    return;
  }

  crashDetected = true;

  if (position) {
    await simulateSell("CRASH");
  }

  const p10 = priceDrop10s();
  const l10 = liquidityDrop10s();

  const report = {
    time: new Date().toISOString(),
    price:
      lastMarket?.price || null,
    liquidity:
      lastMarket?.liquidity || null,
    price10s: p10,
    liquidity10s: l10,
    sessionPnL,
    cycles: cycleNumber,
  };

  saveJSON(
    "v5_3_crash_report.json",
    report
  );

  await send(
    `🚨 CRASH DÉTECTÉ\n\n` +
    `Prix : ${formatPrice(lastMarket.price)} $\n` +
    `Liquidité : $${lastMarket.liquidity.toFixed(2)}\n` +
    `Prix 10s : ${p10 === null ? "N/A" : p10.toFixed(2) + " %"}\n` +
    `Liquidité 10s : ${l10 === null ? "N/A" : l10.toFixed(2) + " %"}\n\n` +
    `🛑 Nouveaux achats arrêtés.\n` +
    `💰 P&L session : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );

  running = false;

  stopWebSocket();
}

// ===============================
// LIMITE 45 MIN
// ===============================

async function handleSessionLimit() {
  if (!running) return;

  if (
    elapsedMinutes() <
    MAX_SESSION_MIN
  ) {
    return;
  }

  if (position && lastMarket) {
    await simulateSell(
      "SESSION_LIMIT"
    );
  }

  running = false;

  saveJSON(
    "v5_3_summary.json",
    {
      finishedAt:
        new Date().toISOString(),
      durationMinutes:
        elapsedMinutes(),
      cycles: cycleNumber,
      wins,
      losses,
      sessionPnL,
    }
  );

  await send(
    `⏱️ SESSION TERMINÉE\n\n` +
    `Durée : ${MAX_SESSION_MIN} min\n` +
    `Cycles : ${cycleNumber}\n` +
    `Gagnants : ${wins}\n` +
    `Perdants : ${losses}\n` +
    `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );

  stopWebSocket();
}

// ===============================
// BOUCLE MARCHÉ
// ===============================

let tickRunning = false;

async function marketTick() {
  if (!running) return;
  if (tickRunning) return;

  tickRunning = true;

  try {
    if (
      elapsedMinutes() >=
      MAX_SESSION_MIN
    ) {
      await handleSessionLimit();
      return;
    }

    const market =
      await getMarketData();

    if (!market) {
      console.log(
        "⚠️ Données marché indisponibles"
      );
      return;
    }

    lastMarket = market;

    updateHistory(market);

    console.log(
      `📊 ${formatPrice(market.price)} | ` +
      `$${market.liquidity.toFixed(0)} | ` +
      `${elapsedMinutes().toFixed(1)} min`
    );

    if (checkCrash()) {
      await handleCrash();
      return;
    }

    if (position) {
      if (
        market.price >=
        position.targetPrice
      ) {
        await simulateSell(
          "TARGET"
        );
      }
    }

    if (
      running &&
      !position
    ) {
      await simulateBuy();
    }

    await handleSessionLimit();
  } catch (e) {
    console.log(
      "marketTick:",
      e.message
    );
  } finally {
    tickRunning = false;
  }
}

// ===============================
// WEBSOCKET STOP
// ===============================

function stopWebSocket() {
  try {
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
  } catch {}

  baseSubId = null;
  quoteSubId = null;
  poolSubId = null;
}

// ===============================
// START
// ===============================

async function startSimulation() {
  if (running) {
    await send(
      "⚠️ Une simulation est déjà active."
    );
    return;
  }

  running = true;
  startTime = Date.now();

  poolAddress = null;
  baseVault = null;
  quoteVault = null;

  baseBalance = null;
  quoteBalance = null;

  lastMarket = null;
  lastMarketTime = 0;

  marketHistory = [];

  position = null;
  cycleNumber = 0;

  sessionPnL = 0;
  wins = 0;
  losses = 0;

  lastSellTime = 0;
  crashDetected = false;

  previousBase = null;
  previousQuote = null;

  pendingBase = null;
  pendingQuote = null;

  dexCache = null;
  dexCacheTime = 0;

  await send(
    `🟢 V5.3 SIMULATION ACTIVE\n\n` +
    `Token : ${shortMint(TOKEN_MINT)}\n` +
    `$${CAPITAL}/cycle\n` +
    `+${TARGET_PERCENT}% target\n` +
    `⏱️ ${MAX_SESSION_MIN} min maximum\n` +
    `🚫 Aucun BUY après ${NO_NEW_BUY_AFTER_MIN} min\n` +
    `🧪 SIMULATION UNIQUEMENT\n\n` +
    `🔎 Recherche du pool PumpSwap...`
  );

  const loaded =
    await loadPool();

  if (!loaded) {
    running = false;

    await send(
      `❌ V5.3 ARRÊTÉE\n\n` +
      `Aucun pool PumpSwap SOL valide trouvé.`
    );

    return;
  }

  await refreshVaultBalances();

  startWebSocket();

  await send(
    `🟢 POOL PUMPSWAP VALIDÉ\n\n` +
    `Pool : ${shortMint(poolAddress)}\n` +
    `Base vault : ${shortMint(baseVault)}\n` +
    `Quote vault : ${shortMint(quoteVault)}\n\n` +
    `📊 Surveillance marché active.`
  );
}

// ===============================
// COMMANDES TELEGRAM
// ===============================

bot.command("start", async (ctx) => {
  await ctx.reply(
    `🤖 V5.3\n\n` +
    `Token : ${shortMint(TOKEN_MINT)}\n\n` +
    `💵 $${CAPITAL}/cycle\n` +
    `🎯 +${TARGET_PERCENT}%\n` +
    `⏱️ ${MAX_SESSION_MIN} min\n` +
    `🚫 Aucun BUY après ${NO_NEW_BUY_AFTER_MIN} min\n` +
    `🧪 Simulation uniquement\n\n` +
    `/starttrade\n` +
    `/stoptrade\n` +
    `/status\n` +
    `/help`
  );
});

bot.command("starttrade", async () => {
  await startSimulation();
});

bot.command("stoptrade", async () => {
  if (!running) {
    await send(
      "ℹ️ Aucune simulation active."
    );
    return;
  }

  if (position && lastMarket) {
    await simulateSell(
      "MANUAL_STOP"
    );
  }

  running = false;
  stopWebSocket();

  await send(
    `🛑 SIMULATION ARRÊTÉE\n\n` +
    `Cycles : ${cycleNumber}\n` +
    `Gagnants : ${wins}\n` +
    `Perdants : ${losses}\n` +
    `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}`
  );
});

bot.command("status", async () => {
  await send(
    `📊 STATUS V5.3\n\n` +
    `Actif : ${running ? "🟢 OUI" : "🔴 NON"}\n` +
    `Session : ${elapsedMinutes().toFixed(1)} min\n` +
    `Cycles : ${cycleNumber}\n` +
    `Gagnants : ${wins}\n` +
    `Perdants : ${losses}\n` +
    `P&L : ${sessionPnL >= 0 ? "+" : ""}$${sessionPnL.toFixed(2)}\n\n` +
    `Position : ${position ? "🟢 OUVERTE" : "⚪ AUCUNE"}\n` +
    `Pool : ${poolAddress ? shortMint(poolAddress) : "N/A"}`
  );
});

bot.command("help", async () => {
  await send(
    `🤖 COMMANDES V5.3\n\n` +
    `/start\n` +
    `/starttrade\n` +
    `/stoptrade\n` +
    `/status\n` +
    `/help`
  );
});

// ===============================
// BOT
// ===============================

bot.launch({
  dropPendingUpdates: true,
})
  .then(() => {
    console.log(
      "🤖 V5.3 Telegram bot démarré"
    );
    console.log(
      "📡 RPC Helius actif"
    );
    console.log(
      "🪙 Token:",
      TOKEN_MINT
    );
  })
  .catch((e) => {
    console.error(
      "❌ Telegram launch:",
      e.message
    );
  });

// ===============================
// BOUCLE
// ===============================

setInterval(
  marketTick,
  MARKET_INTERVAL
);

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
