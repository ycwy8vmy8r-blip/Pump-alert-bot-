const { Telegraf } = require("telegraf");
const fs = require("fs");
const path = require("path");
const http = require("http");

// ============================================================
// CONFIGURATION V5.1 TEST
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

const CRASH_GUARD_URL =
  process.env.CRASH_GUARD_URL || "";

const CRASH_GUARD_SECRET =
  process.env.CRASH_GUARD_SECRET || "";

const PORT =
  Number(process.env.PORT || 3000);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN ou CHAT_ID manquant.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------------- STRATÉGIE ----------------

const FIXED_CAPITAL_USD = 10;
const TARGET_GAIN_PERCENT = 5;
const POLL_INTERVAL_MS = 2000;
const HISTORY_WINDOW_MS = 120000;
const CRASH_REPORT_WINDOW_MS = 60000;
const OBSERVATION_AFTER_SELL_MS = 30000;
const MAX_TOKEN_SESSION_MS = 45 * 60 * 1000;
const NO_NEW_BUY_AFTER_MS = 43 * 60 * 1000;

// ---------------- LIQUIDITÉ ----------------

const MIN_LIQUIDITY_USD = 3000;
const ENTRY_LIQUIDITY_DROP_10S = -10;
const ENTRY_LIQUIDITY_DROP_30S = -15;
const CRASH_LIQUIDITY_DROP_10S = -50;

// ---------------- PRIX ----------------

const ENTRY_PRICE_DROP_10S = -4;
const CRASH_PRICE_DROP_10S = -20;

// ---------------- ACCÉLÉRATION ----------------

const ACCEL_PRICE_5S_WARNING = 7;
const ACCEL_PRICE_10S_WARNING = 10;
const ACCEL_PRICE_5S_EXTREME = 10;
const ACCEL_PRICE_10S_EXTREME = 15;
const ACCEL_LIQUIDITY_DROP = -5;

// ---------------- ENTRÉE ----------------

const REQUIRED_HEALTHY_CONFIRMATIONS = 4;
const MIN_HEALTH_SCORE_FOR_ENTRY = 80;

// ============================================================
// FICHIERS
// ============================================================

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MARKET_FILE = path.join(DATA_DIR, "market_history.jsonl");
const TRADES_FILE = path.join(DATA_DIR, "trade_history.json");
const CRASH_FILE = path.join(DATA_DIR, "crash_reports.json");
const SUMMARY_FILE = path.join(DATA_DIR, "v51_summary.json");

// ============================================================
// ÉTAT DU BOT
// ============================================================

let active = false;
let mint = null;
let pollTimer = null;
let observationUntil = 0;
let sessionStartTime = 0;
let position = null;
let cycleNumber = 0;
let sessionCycles = 0;
let sessionProfit = 0;
let healthyConfirmations = 0;
let marketHistory = [];
let accelerationWarningActive = false;
let accelerationAlertSent = false;

// ============================================================
// CRASH GUARD
// ============================================================

let crashGuardLevel = "NORMAL";
let crashGuardBuyBlocked = false;
let crashGuardLocked = false;
let crashGuardEmergencyExitDone = false;
let crashGuardEmergencyExitInProgress = false;
let crashGuardLastEventId = null;
let crashGuardArmed = false;

// ============================================================
// OUTILS
// ============================================================

function now() {
  return Date.now();
}

function shortMint(value) {
  if (!value) return "inconnu";
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

function round(value, decimals = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(decimals));
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(4)}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "N/A";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

// ============================================================
// SAUVEGARDE
// ============================================================

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`❌ Erreur sauvegarde ${file}:`, error.message);
  }
}

function appendJsonLine(file, data) {
  try {
    fs.appendFileSync(file, JSON.stringify(data) + "\n");
  } catch (error) {
    console.error(`❌ Erreur écriture ${file}:`, error.message);
  }
}

function loadTrades() {
  try {
    if (!fs.existsSync(TRADES_FILE)) return [];

    const content = fs.readFileSync(TRADES_FILE, "utf8");

    if (!content.trim()) return [];

    const data = JSON.parse(content);

    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.error("❌ Impossible de charger trade_history.json");
    return [];
  }
}

let tradeHistory = loadTrades();

// ============================================================
// CRASH GUARD HTTP
// ============================================================

function isCrashGuardConfigured() {
  return Boolean(
    CRASH_GUARD_URL &&
    CRASH_GUARD_SECRET
  );
}

async function crashGuardRequest(
  endpoint,
  method = "GET",
  body = null
) {
  if (!isCrashGuardConfigured()) {
    throw new Error(
      "Crash Guard non configuré"
    );
  }

  const controller =
    new AbortController();

  const timeout =
    setTimeout(() => {
      controller.abort();
    }, 5000);

  try {
    const options = {
      method,
      headers: {
        "x-crash-guard-secret":
          CRASH_GUARD_SECRET
      },
      signal: controller.signal
    };

    if (body !== null) {
      options.headers[
        "Content-Type"
      ] = "application/json";

      options.body =
        JSON.stringify(body);
    }

    const response =
      await fetch(
        `${CRASH_GUARD_URL.replace(/\/$/, "")}${endpoint}`,
        options
      );

    if (!response.ok) {
      throw new Error(
        `Crash Guard HTTP ${response.status}`
      );
    }

    return await response.json();

  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// ARM CRASH GUARD
// ============================================================

async function armCrashGuard(tokenMint) {
  if (!isCrashGuardConfigured()) {
    throw new Error(
      "CRASH_GUARD_URL ou CRASH_GUARD_SECRET manquant"
    );
  }

  console.log(
    `🛡️ Armement Crash Guard pour ${shortMint(tokenMint)}...`
  );

  const result =
    await crashGuardRequest(
      "/arm",
      "POST",
      {
        mint: tokenMint
      }
    );

  if (
    !result ||
    result.ok !== true
  ) {
    throw new Error(
      "Le Crash Guard n'a pas confirmé son armement"
    );
  }

  crashGuardArmed = true;
  crashGuardLevel = "NORMAL";
  crashGuardBuyBlocked = false;
  crashGuardLocked = false;
  crashGuardEmergencyExitDone = false;
  crashGuardEmergencyExitInProgress = false;
  crashGuardLastEventId = null;

  console.log(
    `🟢 Crash Guard armé pour ${shortMint(tokenMint)}`
  );

  return result;
}

// ============================================================
// DISARM CRASH GUARD
// ============================================================

async function disarmCrashGuard() {
  if (!isCrashGuardConfigured()) {
    crashGuardArmed = false;
    return;
  }

  try {
    await crashGuardRequest(
      "/disarm",
      "POST"
    );

    console.log(
      "🛡️ Crash Guard désarmé."
    );

  } catch (error) {
    console.error(
      "⚠️ Impossible de désarmer le Crash Guard:",
      error.message
    );
  }

  crashGuardArmed = false;
  crashGuardLevel = "NORMAL";
  crashGuardBuyBlocked = false;
  crashGuardLocked = false;
  crashGuardEmergencyExitDone = false;
  crashGuardEmergencyExitInProgress = false;
  crashGuardLastEventId = null;
}

// ============================================================
// PRIX DE SORTIE D'URGENCE
// ============================================================

function getLatestValidMarketPrice() {
  for (
    let i = marketHistory.length - 1;
    i >= 0;
    i--
  ) {
    const point =
      marketHistory[i];

    if (
      point &&
      Number.isFinite(point.price) &&
      point.price > 0
    ) {
      return point.price;
    }
  }

  return null;
}

// ============================================================
// SORTIE D'URGENCE CRASH GUARD
// ============================================================

async function emergencyExitFromCrashGuard(
  signal
) {
  if (
    crashGuardEmergencyExitDone ||
    crashGuardEmergencyExitInProgress
  ) {
    return;
  }

  crashGuardEmergencyExitInProgress =
    true;

  try {
    /*
    Une seule sortie d'urgence
    pour toute la session.
    */

    crashGuardEmergencyExitDone =
      true;

    if (!position) {
      await bot.telegram.sendMessage(
        CHAT_ID,
        `🔴 CRASH GUARD CRITICAL

Token :

${mint}

🚨 Signal critique reçu.

ℹ️ Aucune position ouverte.

⛔ Trading verrouillé.`
      );

      return;
    }

    /*
    On tente d'abord une nouvelle lecture
    DexScreener.
    */

    let data =
      await getMarketData(mint);

    let exitPrice =
      data?.price || null;

    /*
    Si DexScreener ne répond plus,
    on utilise le dernier prix valide
    réellement observé par V5.1.
    */

    if (
      !Number.isFinite(exitPrice) ||
      exitPrice <= 0
    ) {
      exitPrice =
        getLatestValidMarketPrice();
    }

    /*
    Aucun prix disponible :
    on ne fabrique pas de prix.
    */

    if (
      !Number.isFinite(exitPrice) ||
      exitPrice <= 0
    ) {
      await bot.telegram.sendMessage(
        CHAT_ID,
        `🔴 CRASH GUARD CRITICAL

Token :

${mint}

🚨 Signal critique confirmé.

⚠️ Aucun prix DEX fiable disponible
pour calculer une sortie simulée.

⛔ Aucun bénéfice fictif ajouté.

⛔ Trading verrouillé.`
      );

      position = null;

      return;
    }

    const entryPrice =
      position.entryPrice;

    const amount =
      position.tokens *
      exitPrice;

    const profit =
      amount -
      position.capital;

    const profitPercent =
      (profit /
        position.capital) *
      100;

    sessionProfit +=
      profit;

    const trade = {
      type:
        "CRASH_GUARD_EMERGENCY",
      sessionStart:
        sessionStartTime,
      timestamp:
        now(),
      mint,
      cycle:
        position.cycle,
      entryPrice,
      exitPrice,
      capital:
        position.capital,
      tokens:
        position.tokens,
      amount,
      profit,
      profitPercent,
      guardLevel:
        signal?.level || "CRITICAL",
      guardEventId:
        signal?.id || null,
      guardTimestamp:
        signal?.timestamp || null,
      priceSource:
        data?.price
          ? "fresh_dexscreener"
          : "latest_valid_v51_observation"
    };

    tradeHistory.push(
      trade
    );

    saveJson(
      TRADES_FILE,
      tradeHistory
    );

    const cycle =
      position.cycle;

    position = null;

    observationUntil = 0;
    healthyConfirmations = 0;

    await bot.telegram.sendMessage(
      CHAT_ID,
      `🚨 SORTIE D'URGENCE CRASH GUARD

Token :

${mint}

Cycle :

#${cycle}

🔴 Niveau :

CRITICAL

🚨 Signal critique reçu.

💵 Prix d'entrée :

$${entryPrice.toFixed(8)}

🛑 Prix de sortie simulé :

$${exitPrice.toFixed(8)}

💰 Montant simulé :

${formatUsd(amount)}

📊 Résultat :

${profit >= 0 ? "+" : ""}${formatUsd(profit)}

📈 Variation :

${formatPercent(profitPercent)}

💰 Bénéfice session :

${sessionProfit >= 0 ? "+" : ""}${formatUsd(sessionProfit)}

⛔ ACHATS BLOQUÉS

⛔ VENTES NORMALES BLOQUÉES

⛔ SESSION VERROUILLÉE`
    );

  } catch (error) {

    console.error(
      "❌ Erreur sortie urgence Crash Guard:",
      error.message
    );

    /*
    Même en cas d'erreur, on ne permet
    pas une seconde tentative automatique
    qui pourrait créer une double sortie.
    */

    await bot.telegram.sendMessage(
      CHAT_ID,
      `🔴 CRASH GUARD CRITICAL

Token :

${mint}

🚨 Signal critique reçu.

⚠️ Erreur pendant la sortie simulée :

${error.message}

⛔ Trading verrouillé.

❗ Aucune seconde vente automatique.`
    );

  } finally {
    crashGuardEmergencyExitInProgress =
      false;
  }
}

// ============================================================
// SIGNAL CRASH GUARD
// ============================================================

async function applyCrashGuardSignal(
  signal
) {
  if (
    !signal ||
    !signal.level
  ) {
    return;
  }

  /*
  Ignore les anciens événements.
  */

  if (
    signal.id !== undefined &&
    signal.id !== null
  ) {
    if (
      crashGuardLastEventId ===
      signal.id
    ) {
      return;
    }

    crashGuardLastEventId =
      signal.id;
  }

  /*
  CRITICAL reste prioritaire.
  */

  if (
    crashGuardLocked
  ) {
    return;
  }

  const level =
    String(
      signal.level
    ).toUpperCase();

  /*
  Vérification du token.
  */

  if (
    signal.mint &&
    mint &&
    signal.mint !== mint
  ) {
    console.error(
      `⚠️ Signal Crash Guard ignoré : mauvais mint ${signal.mint}`
    );

    return;
  }

  if (
    level === "WATCH"
  ) {
    crashGuardLevel =
      "WATCH";

    console.log(
      "🟡 Crash Guard WATCH"
    );

    return;
  }

  if (
    level === "DANGER"
  ) {
    crashGuardLevel =
      "DANGER";

    /*
    DANGER bloque les nouveaux achats
    pour le reste de la session.
    */

    crashGuardBuyBlocked =
      true;

    console.log(
      "🟠 Crash Guard DANGER : nouveaux achats bloqués."
    );

    await bot.telegram.sendMessage(
      CHAT_ID,
      `🟠 CRASH GUARD DANGER

Token :

${mint}

⛔ Nouveaux achats bloqués.

📌 La position ouverte éventuelle
reste gérée normalement tant qu'aucun
CRITICAL n'est reçu.`
    );

    return;
  }

  if (
    level === "CRITICAL"
  ) {
    crashGuardLevel =
      "CRITICAL";

    crashGuardBuyBlocked =
      true;

    crashGuardLocked =
      true;

    console.log(
      "🔴 Crash Guard CRITICAL : VERROUILLAGE TOTAL."
    );

    await emergencyExitFromCrashGuard(
      signal
    );

    /*
    Après la sortie d'urgence,
    aucun nouveau cycle.
    */

    if (active) {
      await saveSummary(
        "CRASH_GUARD_CRITICAL"
      );

      stopRadar(
        false,
        true
      );
    }
  }
}

// ============================================================
// SERVEUR HTTP V5.1
// ============================================================

function parseRequestBody(req) {
  return new Promise(
    (resolve, reject) => {
      let body = "";

      req.on(
        "data",
        chunk => {
          body +=
            chunk.toString();

          if (
            body.length >
            100000
          ) {
            reject(
              new Error(
                "Body trop volumineux"
              )
            );

            req.destroy();
          }
        }
      );

      req.on(
        "end",
        () => {
          try {
            resolve(
              body
                ? JSON.parse(body)
                : {}
            );
          } catch (error) {
            reject(
              new Error(
                "JSON invalide"
              )
            );
          }
        }
      );

      req.on(
        "error",
        reject
      );
    }
  );
}

function authorizeCrashGuardRequest(
  req
) {
  if (
    !CRASH_GUARD_SECRET
  ) {
    return false;
  }

  return (
    req.headers[
      "x-crash-guard-secret"
    ] ===
    CRASH_GUARD_SECRET
  );
}

const v51Server =
  http.createServer(
    async (req, res) => {

      /*
      HEALTH
      */

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        const body =
          JSON.stringify({
            ok: true,
            service:
              "pump-alert-bot-v5.1",
            active,
            mint,
            timestamp:
              new Date().toISOString()
          });

        res.writeHead(
          200,
          {
            "Content-Type":
              "application/json",
            "Content-Length":
              Buffer.byteLength(body)
          }
        );

        res.end(body);

        return;
      }

      /*
      CRASH GUARD EVENT
      */

      if (
        req.method === "POST" &&
        req.url ===
          "/crash-guard/event"
      ) {

        if (
          !authorizeCrashGuardRequest(
            req
          )
        ) {
          res.writeHead(
            401,
            {
              "Content-Type":
                "application/json"
            }
          );

          res.end(
            JSON.stringify({
              ok: false,
              error:
                "Unauthorized"
            })
          );

          return;
        }

        try {
          const signal =
            await parseRequestBody(
              req
            );

          await applyCrashGuardSignal(
            signal
          );

          const body =
            JSON.stringify({
              ok: true,
              level:
                crashGuardLevel,
              locked:
                crashGuardLocked,
              buyBlocked:
                crashGuardBuyBlocked
            });

          res.writeHead(
            200,
            {
              "Content-Type":
                "application/json",
              "Content-Length":
                Buffer.byteLength(body)
            }
          );

          res.end(body);

        } catch (error) {
          console.error(
            "❌ Crash Guard event:",
            error.message
          );

          res.writeHead(
            400,
            {
              "Content-Type":
                "application/json"
            }
          );

          res.end(
            JSON.stringify({
              ok: false,
              error:
                error.message
            })
          );
        }

        return;
      }

      /*
      404
      */

      res.writeHead(
        404,
        {
          "Content-Type":
            "application/json"
        }
      );

      res.end(
        JSON.stringify({
          ok: false,
          error:
            "Not found"
        })
      );
    }
  );

v51Server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `🌐 Serveur V5.1 écoute sur le port ${PORT}.`
    );
  }
);

// ============================================================
// DEXSCREENER
// ============================================================

async function getMarketData(tokenMint) {
  const url =
    `https://api.dexscreener.com/token-pairs/v1/solana/${tokenMint}`;

  try {
    const response =
      await fetch(url);

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    const pairs =
      await response.json();

    if (
      !Array.isArray(pairs) ||
      pairs.length === 0
    ) {
      return null;
    }

    const pumpPair =
      pairs.find((pair) => {
        return (
          pair &&
          pair.dexId &&
          pair.dexId.toLowerCase() ===
            "pumpswap"
        );
      });

    if (!pumpPair) {
      return null;
    }

    const price =
      Number(
        pumpPair.priceUsd || 0
      );

    const liquidity =
      Number(
        pumpPair.liquidity?.usd ||
          0
      );

    if (
      !price ||
      price <= 0
    ) {
      return null;
    }

    return {
      timestamp: now(),
      price,
      liquidity,
      pairAddress:
        pumpPair.pairAddress ||
        null,
      volume24h:
        Number(
          pumpPair.volume?.h24 ||
            0
        ),
      buys5m:
        Number(
          pumpPair.txns?.m5?.buys ||
            0
        ),
      sells5m:
        Number(
          pumpPair.txns?.m5?.sells ||
            0
        )
    };

  } catch (error) {
    console.error(
      "⚠️ Erreur DEX Screener:",
      error.message
    );

    return null;
  }
}

// ============================================================
// HISTORIQUE
// ============================================================

function addMarketPoint(data) {
  marketHistory.push(data);

  const cutoff =
    now() -
    HISTORY_WINDOW_MS;

  marketHistory =
    marketHistory.filter(
      (point) =>
        point.timestamp >=
        cutoff
    );

  appendJsonLine(
    MARKET_FILE,
    {
      sessionStart:
        sessionStartTime,
      mint,
      ...data
    }
  );
}

function getPointAgo(seconds) {
  const target =
    now() -
    seconds * 1000;

  let closest = null;
  let distance = Infinity;

  for (
    const point of
    marketHistory
  ) {
    const currentDistance =
      Math.abs(
        point.timestamp -
          target
      );

    if (
      currentDistance <
      distance
    ) {
      distance =
        currentDistance;

      closest =
        point;
    }
  }

  if (
    !closest ||
    distance > 5000
  ) {
    return null;
  }

  return closest;
}

function calculateChange(
  seconds,
  field
) {
  const current =
    marketHistory[
      marketHistory.length - 1
    ];

  if (!current) {
    return null;
  }

  const old =
    getPointAgo(seconds);

  if (
    !old ||
    !old[field]
  ) {
    return null;
  }

  return (
    ((current[field] -
      old[field]) /
      old[field]) *
    100
  );
}

// ============================================================
// ACCÉLÉRATION
// ============================================================

function calculateAcceleration() {
  const price5s =
    calculateChange(
      5,
      "price"
    );

  const price10s =
    calculateChange(
      10,
      "price"
    );

  const liquidity10s =
    calculateChange(
      10,
      "liquidity"
    );

  let level =
    "NORMAL";

  const reasons = [];

  if (
    Number.isFinite(
      price5s
    ) &&
    Number.isFinite(
      price10s
    )
  ) {
    if (
      price5s >=
        ACCEL_PRICE_5S_EXTREME ||
      price10s >=
        ACCEL_PRICE_10S_EXTREME
    ) {
      level =
        "EXTREME";

      reasons.push(
        `hausse prix très rapide (${formatPercent(price5s)} / 5s)`
      );

    } else if (
      price5s >=
        ACCEL_PRICE_5S_WARNING ||
      price10s >=
        ACCEL_PRICE_10S_WARNING
    ) {
      level =
        "WARNING";

      reasons.push(
        `accélération prix (${formatPercent(price5s)} / 5s)`
      );
    }
  }

  if (
    Number.isFinite(
      liquidity10s
    ) &&
    liquidity10s <=
      ACCEL_LIQUIDITY_DROP &&
    (
      (
        Number.isFinite(
          price5s
        ) &&
        price5s >= 5
      ) ||
      (
        Number.isFinite(
          price10s
        ) &&
        price10s >= 8
      )
    )
  ) {
    level =
      "EXTREME";

    reasons.push(
      `prix en accélération + liquidité ${formatPercent(liquidity10s)} / 10s`
    );
  }

  return {
    level,
    price5s,
    price10s,
    liquidity10s,
    reasons
  };
}

// ============================================================
// SANTÉ DU MARCHÉ
// ============================================================

function calculateHealth(data) {
  let score = 100;

  const signals = [];

  const liquidity10s =
    calculateChange(
      10,
      "liquidity"
    );

  const liquidity30s =
    calculateChange(
      30,
      "liquidity"
    );

  const price10s =
    calculateChange(
      10,
      "price"
    );

  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    score -= 20;

    signals.push(
      `liquidité sous ${formatUsd(MIN_LIQUIDITY_USD)}`
    );
  }

  if (
    Number.isFinite(
      liquidity10s
    ) &&
    liquidity10s <=
      ENTRY_LIQUIDITY_DROP_10S
  ) {
    score -= 20;

    signals.push(
      `liquidité ${formatPercent(liquidity10s)} / 10s`
    );
  }

  if (
    Number.isFinite(
      liquidity30s
    ) &&
    liquidity30s <=
      ENTRY_LIQUIDITY_DROP_30S
  ) {
    score -= 20;

    signals.push(
      `liquidité ${formatPercent(liquidity30s)} / 30s`
    );
  }

  if (
    Number.isFinite(
      price10s
    ) &&
    price10s <=
      ENTRY_PRICE_DROP_10S
  ) {
    score -= 20;

    signals.push(
      `prix ${formatPercent(price10s)} / 10s`
    );
  }

  const totalActivity =
    data.buys5m +
    data.sells5m;

  if (
    totalActivity === 0
  ) {
    score -= 10;

    signals.push(
      "activité faible"
    );
  }

  score =
    Math.max(
      0,
      Math.min(
        100,
        score
      )
    );

  return {
    score,
    liquidity10s,
    liquidity30s,
    price10s,
    signals
  };
}

// ============================================================
// CRASH
// ============================================================

function detectCrash(
  data,
  health
) {
  const price10s =
    health.price10s;

  const liquidity10s =
    health.liquidity10s;

  const reasons = [];

  if (
    data.liquidity <= 1
  ) {
    reasons.push(
      "liquidité quasi nulle"
    );
  }

  if (
    Number.isFinite(
      liquidity10s
    ) &&
    liquidity10s <=
      CRASH_LIQUIDITY_DROP_10S
  ) {
    reasons.push(
      `liquidité ${formatPercent(liquidity10s)} / 10s`
    );
  }

  if (
    Number.isFinite(
      price10s
    ) &&
    price10s <=
      CRASH_PRICE_DROP_10S
  ) {
    reasons.push(
      `prix ${formatPercent(price10s)} / 10s`
    );
  }

  return reasons;
}

// ============================================================
// ENTRÉE
// ============================================================

function canEnter(
  data,
  health,
  acceleration
) {
  const elapsed =
    now() -
    sessionStartTime;

  /*
  CRASH GUARD
  */

  if (
    crashGuardLocked
  ) {
    return {
      ok: false,
      reason:
        "Crash Guard verrouillé"
    };
  }

  if (
    crashGuardBuyBlocked
  ) {
    return {
      ok: false,
      reason:
        `Crash Guard ${crashGuardLevel} : achats bloqués`
    };
  }

  if (
    !crashGuardArmed
  ) {
    return {
      ok: false,
      reason:
        "Crash Guard non armé"
    };
  }

  if (
    elapsed >=
    NO_NEW_BUY_AFTER_MS
  ) {
    return {
      ok: false,
      reason:
        "limite de 43 minutes atteinte"
    };
  }

  if (
    observationUntil > now()
  ) {
    return {
      ok: false,
      reason:
        "phase d'observation"
    };
  }

  if (
    data.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    return {
      ok: false,
      reason:
        "liquidité insuffisante"
    };
  }

  if (
    health.score <
    MIN_HEALTH_SCORE_FOR_ENTRY
  ) {
    return {
      ok: false,
      reason:
        `score santé ${health.score}/100`
    };
  }

  if (
    acceleration.level ===
      "WARNING" ||
    acceleration.level ===
      "EXTREME"
  ) {
    return {
      ok: false,
      reason:
        `accélération ${acceleration.level}`
    };
  }

  if (
    marketHistory.length <
    REQUIRED_HEALTHY_CONFIRMATIONS
  ) {
    return {
      ok: false,
      reason:
        "historique insuffisant"
    };
  }

  return {
    ok: true,
    reason:
      "conditions favorables"
  };
}

// ============================================================
// ACHAT SIMULÉ
// ============================================================

async function simulateBuy(data) {
  /*
  Double sécurité juste avant achat.
  */

  if (
    crashGuardLocked ||
    crashGuardBuyBlocked ||
    !crashGuardArmed
  ) {
    console.log(
      "🛡️ Achat ignoré : Crash Guard actif."
    );

    return;
  }

  cycleNumber++;
  sessionCycles++;

  const tokens =
    FIXED_CAPITAL_USD /
    data.price;

  position = {
    cycle:
      cycleNumber,
    entryTime:
      now(),
    entryPrice:
      data.price,
    capital:
      FIXED_CAPITAL_USD,
    tokens,
    targetPrice:
      data.price *
      (
        1 +
        TARGET_GAIN_PERCENT /
          100
      )
  };

  const health =
    calculateHealth(
      data
    );

  const acceleration =
    calculateAcceleration();

  await bot.telegram.sendMessage(
    CHAT_ID,
    `🟢 ACHAT TEST #${cycleNumber}

Token :

${mint}

Mise fixe :

${formatUsd(FIXED_CAPITAL_USD)}

Prix :

$${data.price.toFixed(8)}

Tokens :

${tokens.toFixed(8)}

🎯 Objectif :

+${TARGET_GAIN_PERCENT.toFixed(2)}%

Prix cible :

$${position.targetPrice.toFixed(8)}

💧 Liquidité :

${formatUsd(data.liquidity)}

🧠 SCORE DE SANTÉ :

${health.score}/100

⚡ Accélération :

${acceleration.level}

🛡️ Entrée confirmée :

${healthyConfirmations}/${REQUIRED_HEALTHY_CONFIRMATIONS}`
  );
}

// ============================================================
// VENTE CIBLE
// ============================================================

async function simulateTargetSell(
  data
) {
  if (!position) {
    return;
  }

  /*
  Crash Guard :
  aucune vente normale après CRITICAL.
  */

  if (
    crashGuardLocked
  ) {
    console.log(
      "🛡️ Vente cible annulée : Crash Guard verrouillé."
    );

    return;
  }

  const entryPrice =
    position.entryPrice;

  const targetPrice =
    position.targetPrice;

  const simulatedAmount =
    FIXED_CAPITAL_USD *
    (
      targetPrice /
      entryPrice
    );

  const profit =
    simulatedAmount -
    FIXED_CAPITAL_USD;

  sessionProfit +=
    profit;

  const trade = {
    type: "TARGET",
    sessionStart:
      sessionStartTime,
    timestamp:
      now(),
    mint,
    cycle:
      position.cycle,
    entryPrice,
    exitPrice:
      targetPrice,
    capital:
      FIXED_CAPITAL_USD,
    amount:
      simulatedAmount,
    profit,
    profitPercent:
      (
        profit /
        FIXED_CAPITAL_USD
      ) * 100
  };

  tradeHistory.push(
    trade
  );

  saveJson(
    TRADES_FILE,
    tradeHistory
  );

  const cycle =
    position.cycle;

  position = null;

  await bot.telegram.sendMessage(
    CHAT_ID,
    `🔴 VENTE TEST #${cycle}

Token :

${mint}

Prix de vente :

$${targetPrice.toFixed(8)}

Montant simulé :

${formatUsd(simulatedAmount)}

Résultat :

+${TARGET_GAIN_PERCENT.toFixed(2)}%

Bénéfice réalisé :

+${formatUsd(profit)}

💰 Bénéfices de cette session :

${formatUsd(sessionProfit)}

🔄 Capital du prochain cycle :

${formatUsd(FIXED_CAPITAL_USD)}

🛡️ NOUVELLE PHASE DE SÉCURITÉ

⏳ Observation du marché pendant 30s

❌ Aucun rachat immédiat.`
  );

  observationUntil =
    now() +
    OBSERVATION_AFTER_SELL_MS;

  healthyConfirmations =
    0;
}

// ============================================================
// SORTIE À 45 MINUTES
// ============================================================

async function timeLimitExit(
  data
) {
  if (!position) {
    return;
  }

  if (
    crashGuardLocked
  ) {
    return;
  }

  if (
    data.liquidity <=
    MIN_LIQUIDITY_USD
  ) {
    await bot.telegram.sendMessage(
      CHAT_ID,
      `⏰ LIMITE 180 MINUTES

Token :

${mint}

⚠️ Position encore ouverte.

💧 Liquidité :

${formatUsd(data.liquidity)}

La liquidité n'est pas suffisamment fiable.

❌ Aucune vente fictive.

❌ Aucun bénéfice fictif.

⛔ Session arrêtée.`
    );

    position = null;

    return;
  }

  const exitPrice =
    data.price;

  const amount =
    position.tokens *
    exitPrice;

  const profit =
    amount -
    position.capital;

  const profitPercent =
    (
      profit /
      position.capital
    ) * 100;

  sessionProfit +=
    profit;

  const trade = {
    type:
      "TIME_LIMIT",
    sessionStart:
      sessionStartTime,
    timestamp:
      now(),
    mint,
    cycle:
      position.cycle,
    entryPrice:
      position.entryPrice,
    exitPrice,
    capital:
      position.capital,
    amount,
    profit,
    profitPercent
  };

  tradeHistory.push(
    trade
  );

  saveJson(
    TRADES_FILE,
    tradeHistory
  );

  const cycle =
    position.cycle;

  position = null;

  await bot.telegram.sendMessage(
    CHAT_ID,
    `⏰ SORTIE LIMITE 180 MINUTES

Token :

${mint}

Cycle :

#${cycle}

Prix d'entrée :

$${trade.entryPrice.toFixed(8)}

Prix de sortie :

$${exitPrice.toFixed(8)}

Résultat :

${formatPercent(profitPercent)}

Résultat simulé :

${profit >= 0 ? "+" : ""}${formatUsd(profit)}

💰 Bénéfice session :

${profit >= 0 ? "+" : ""}${formatUsd(sessionProfit)}

⛔ Aucun nouveau cycle.`
  );
}

// ============================================================
// ACCÉLÉRATION TELEGRAM
// ============================================================

async function handleAccelerationAlert(
  acceleration
) {
  const danger =
    acceleration.level ===
      "WARNING" ||
    acceleration.level ===
      "EXTREME";

  if (!danger) {
    accelerationWarningActive =
      false;

    accelerationAlertSent =
      false;

    return;
  }

  accelerationWarningActive =
    true;

  if (
    accelerationAlertSent
  ) {
    return;
  }

  accelerationAlertSent =
    true;

  const message =
    acceleration.level ===
    "EXTREME"
      ? "🚨 ACCÉLÉRATION TRÈS FORTE"
      : "⚡ ACCÉLÉRATION ANORMALE";

  await bot.telegram.sendMessage(
    CHAT_ID,
    `${message}

Token :

${mint}

Prix 5s :

${formatPercent(acceleration.price5s)}

Prix 10s :

${formatPercent(acceleration.price10s)}

Liquidité 10s :

${formatPercent(acceleration.liquidity10s)}

⚠️ Aucun nouvel achat pendant cette accélération.

${
  position
    ? "📌 Une position est déjà ouverte. Pas de vente d'urgence automatique."
    : "🛡️ Le filtre d'entrée reste bloqué."
}

Raisons :

${acceleration.reasons
  .map(
    (reason) =>
      `• ${reason}`
  )
  .join("\n")}`
  );
}

// ============================================================
// RAPPORT CRASH
// ============================================================

async function saveCrashReport(
  data,
  health,
  acceleration,
  reasons
) {
  const cutoff =
    now() -
    CRASH_REPORT_WINDOW_MS;

  const last60Seconds =
    marketHistory.filter(
      (point) =>
        point.timestamp >=
        cutoff
    );

  const report = {
    id:
      `crash_${now()}`,
    timestamp:
      new Date().toISOString(),
    sessionStart:
      new Date(
        sessionStartTime
      ).toISOString(),
    mint,
    cyclesCompleted:
      sessionCycles,
    sessionProfit,
    crashMarket: {
      price:
        data.price,
      liquidity:
        data.liquidity,
      priceChange10s:
        health.price10s,
      liquidityChange10s:
        health.liquidity10s,
      score:
        health.score
    },
    acceleration: {
      level:
        acceleration.level,
      price5s:
        acceleration.price5s,
      price10s:
        acceleration.price10s,
      liquidity10s:
        acceleration.liquidity10s,
      reasons:
        acceleration.reasons
    },
    reasons,
    openPosition:
      position
        ? {
            cycle:
              position.cycle,
            entryPrice:
              position.entryPrice,
            tokens:
              position.tokens,
            capital:
              position.capital
          }
        : null,
    last60Seconds
  };

  let reports = [];

  try {
    if (
      fs.existsSync(
        CRASH_FILE
      )
    ) {
      const content =
        fs.readFileSync(
          CRASH_FILE,
          "utf8"
        );

      if (
        content.trim()
      ) {
        reports =
          JSON.parse(
            content
          );

        if (
          !Array.isArray(
            reports
          )
        ) {
          reports = [];
        }
      }
    }
  } catch {
    reports = [];
  }

  reports.push(
    report
  );

  if (
    reports.length >
    20
  ) {
    reports =
      reports.slice(-20);
  }

  saveJson(
    CRASH_FILE,
    reports
  );

  return report;
}

// ============================================================
// RAPPORT TELEGRAM
// ============================================================

async function sendCrashReport(
  report
) {
  const market =
    report.crashMarket;

  const acceleration =
    report.acceleration;

  const lastPoints =
    report.last60Seconds.slice(
      -15
    );

  let lines = "";

  for (
    const point of
    lastPoints
  ) {
    const time =
      new Date(
        point.timestamp
      ).toLocaleTimeString(
        "fr-FR",
        {
          hour:
            "2-digit",
          minute:
            "2-digit",
          second:
            "2-digit"
        }
      );

    lines +=
      `${time} | prix $${point.price.toFixed(8)} | liq ${formatUsd(point.liquidity)}\n`;
  }

  await bot.telegram.sendMessage(
    CHAT_ID,
    `📊 RAPPORT CRASH V5.1

🪙 Token :

${report.mint}

🕐 Crash :

${new Date(
  report.timestamp
).toLocaleString("fr-FR")}

💥 Prix au crash :

$${market.price.toFixed(8)}

📉 Prix / 10s :

${formatPercent(market.priceChange10s)}

💧 Liquidité :

${formatUsd(market.liquidity)}

📉 Liquidité / 10s :

${formatPercent(market.liquidityChange10s)}

🧠 Score :

${market.score}/100

⚡ Accélération :

${acceleration.level}

Prix / 5s :

${formatPercent(acceleration.price5s)}

Prix / 10s :

${formatPercent(acceleration.price10s)}

🚨 Signaux :

${report.reasons
  .map(
    (reason) =>
      `• ${reason}`
  )
  .join("\n")}

📈 DERNIERS POINTS AVANT CRASH

${lines}

💰 Bénéfices session :

${formatUsd(
  report.sessionProfit
)}

🔄 Cycles terminés :

${report.cyclesCompleted}

💾 Rapport complet :

crash_reports.json`
  );

  try {
    if (
      fs.existsSync(
        CRASH_FILE
      )
    ) {
      await bot.telegram.sendDocument(
        CHAT_ID,
        {
          source:
            CRASH_FILE
        },
        {
          caption:
            "📁 Fichier complet crash_reports.json"
        }
      );
    }
  } catch (error) {
    console.error(
      "⚠️ Impossible d'envoyer le fichier Telegram:",
      error.message
    );
  }
}

// ============================================================
// CRASH V5.1
// ============================================================

async function handleCrash(
  data,
  health,
  acceleration,
  reasons
) {
  if (!active) {
    return;
  }

  const report =
    await saveCrashReport(
      data,
      health,
      acceleration,
      reasons
    );

  await bot.telegram.sendMessage(
    CHAT_ID,
    `🚨 STOP CRASH - MODE TEST V5.1

Token :

${mint}

Prix :

$${data.price.toFixed(8)}

Variation prix ~10s :

${formatPercent(
  health.price10s
)}

Liquidité :

${formatUsd(
  data.liquidity
)}

Variation liquidité ~10s :

${formatPercent(
  health.liquidity10s
)}

⚡ Accélération :

${acceleration.level}

🧠 Score au crash :

${health.score}/100

⚠️ Signaux :

${reasons
  .map(
    (reason) =>
      `• ${reason}`
  )
  .join("\n")}

${
  position
    ? `⚠️ Position restante :

${position.tokens.toFixed(8)} tokens

⚠️ Prix de sortie NON considéré fiable.

⚠️ Aucun bénéfice fictif ajouté.`
    : "ℹ️ Aucune position ouverte."
}

📊 Données des 60 dernières secondes :

SAUVEGARDÉES

📩 Le rapport complet arrive maintenant.

⛔ NOUVEAU CYCLE BLOQUÉ

⛔ RADAR ARRÊTÉ`
  );

  await sendCrashReport(
    report
  );

  await disarmCrashGuard();

  stopRadar(false);
}

// ============================================================
// LIMITE TEMPORELLE
// ============================================================

async function handleTimeLimit(
  data
) {
  if (!active) {
    return false;
  }

  const elapsed =
    now() -
    sessionStartTime;

  if (
    elapsed <
    MAX_TOKEN_SESSION_MS
  ) {
    return false;
  }

  await bot.telegram.sendMessage(
    CHAT_ID,
    `⏰ LIMITE DE SESSION ATTEINTE

Token :

${mint}

Durée :

45 minutes

🔄 Cycles terminés :

${sessionCycles}

💰 Bénéfice session :

${sessionProfit >= 0 ? "+" : ""}${formatUsd(sessionProfit)}

⛔ Aucun nouveau cycle.`
  );

  if (
    position
  ) {
    await timeLimitExit(
      data
    );
  }

  await saveSummary(
    "TIME_LIMIT"
  );

  await disarmCrashGuard();

  stopRadar(false);

  return true;
}

// ============================================================
// BOUCLE PRINCIPALE
// ============================================================

async function tick() {
  if (
    !active ||
    !mint
  ) {
    return;
  }

  /*
  Si le Guard a déjà verrouillé V5.1,
  on arrête immédiatement les actions.
  */

  if (
    crashGuardLocked
  ) {
    return;
  }

  const data =
    await getMarketData(
      mint
    );

  if (!data) {
    return;
  }

  addMarketPoint(
    data
  );

  const health =
    calculateHealth(
      data
    );

  const acceleration =
    calculateAcceleration();

  await handleAccelerationAlert(
    acceleration
  );

  /*
  Crash V5.1 existant.
  */

  const crashReasons =
    detectCrash(
      data,
      health
    );

  if (
    crashReasons.length >
    0
  ) {
    await handleCrash(
      data,
      health,
      acceleration,
      crashReasons
    );

    return;
  }

  /*
  Limite 45 minutes.
  */

  const timeStopped =
    await handleTimeLimit(
      data
    );

  if (
    timeStopped
  ) {
    return;
  }

  /*
  Vérification supplémentaire juste
  avant toute action de trading.
  */

  if (
    crashGuardLocked
  ) {
    return;
  }

  /*
  POSITION OUVERTE
  */

  if (
    position
  ) {
    if (
      data.price >=
      position.targetPrice
    ) {
      await simulateTargetSell(
        data
      );
    }

    return;
  }

  /*
  OBSERVATION
  */

  if (
    observationUntil >
    now()
  ) {
    return;
  }

  /*
  FILTRE D'ENTRÉE
  */

  const entry =
    canEnter(
      data,
      health,
      acceleration
    );

  if (
    !entry.ok
  ) {
    healthyConfirmations =
      0;

    return;
  }

  healthyConfirmations++;

  console.log(
    `🟡 Marché favorable : ${healthyConfirmations}/${REQUIRED_HEALTHY_CONFIRMATIONS}`
  );

  if (
    healthyConfirmations >=
    REQUIRED_HEALTHY_CONFIRMATIONS
  ) {
    /*
    Dernière vérification.
    */

    if (
      crashGuardLocked ||
      crashGuardBuyBlocked ||
      !crashGuardArmed
    ) {
      healthyConfirmations =
        0;

      return;
    }

    await simulateBuy(
      data
    );

    healthyConfirmations =
      0;
  }
}

// ============================================================
// SUMMARY
// ============================================================

async function saveSummary(
  reason
) {
  const summary = {
    version:
      "V5.1",
    sessionStart:
      sessionStartTime
        ? new Date(
            sessionStartTime
          ).toISOString()
        : null,
    sessionEnd:
      new Date().toISOString(),
    mint,
    reason,
    cyclesCompleted:
      sessionCycles,
    sessionProfit,
    positionOpen:
      !!position,
    marketPoints:
      marketHistory.length,
    crashGuard: {
      armed:
        crashGuardArmed,
      level:
        crashGuardLevel,
      buyBlocked:
        crashGuardBuyBlocked,
      locked:
        crashGuardLocked,
      emergencyExitDone:
        crashGuardEmergencyExitDone
    }
  };

  saveJson(
    SUMMARY_FILE,
    summary
  );
}

// ============================================================
// START
// ============================================================

async function startRadar(
  tokenMint
) {
  if (active) {
    await bot.telegram.sendMessage(
      CHAT_ID,
      `⚠️ Un test est déjà en cours.

Token :

${mint}

Utilise /stoptrade avant d'en lancer un autre.`
    );

    return;
  }

  /*
  ARMEMENT DU CRASH GUARD AVANT
  DE DÉMARRER LA SESSION V5.1.
  */

  try {
    await armCrashGuard(
      tokenMint.trim()
    );

  } catch (error) {

    console.error(
      "❌ Impossible d'armer le Crash Guard:",
      error.message
    );

    await bot.telegram.sendMessage(
      CHAT_ID,
      `❌ V5.1 NON DÉMARRÉE

Token :

${tokenMint}

🛡️ Crash Guard :

❌ ARMEMENT IMPOSSIBLE

Erreur :

${error.message}

⛔ Aucun achat ne sera lancé.

Vérifie que le service Crash Guard
est bien démarré et que les variables
sont correctement configurées.`
    );

    return;
  }

  mint =
    tokenMint.trim();

  active =
    true;

  sessionStartTime =
    now();

  observationUntil =
    0;

  position =
    null;

  cycleNumber =
    0;

  sessionCycles =
    0;

  sessionProfit =
    0;

  healthyConfirmations =
    0;

  marketHistory =
    [];

  accelerationWarningActive =
    false;

  accelerationAlertSent =
    false;

  console.log(
    `🚀 V5.1 démarrée pour ${shortMint(mint)}`
  );

  await bot.telegram.sendMessage(
    CHAT_ID,
    `🚀 V5.1 TEST DÉMARRÉ

Token :

${mint}

💵 Mise fixe :

${formatUsd(FIXED_CAPITAL_USD)}

🎯 Objectif :

+${TARGET_GAIN_PERCENT.toFixed(2)}%

⏳ Observation après vente :

30 secondes

⚡ Filtre accélération :

ACTIF

🛡️ CRASH GUARD :

ACTIF

🟢 WATCH :

Aucune action

🟠 DANGER :

Nouveaux achats bloqués

🔴 CRITICAL :

Sortie d'urgence + verrouillage

⏱️ Durée maximale :

45 minutes

🛑 Aucun nouvel achat après :

43 minutes

💾 Sauvegarde automatique :

ACTIVÉE

📩 Rapport crash :

DIRECTEMENT DANS TELEGRAM

⚠️ Simulation uniquement.

Aucune transaction réelle.`
  );

  pollTimer =
    setInterval(
      () => {
        tick().catch(
          (error) => {
            console.error(
              "❌ Erreur tick:",
              error.message
            );
          }
        );
      },
      POLL_INTERVAL_MS
    );

  tick().catch(
    (error) => {
      console.error(
        "❌ Erreur tick initial:",
        error.message
      );
    }
  );
}

// ============================================================
// STOP
// ============================================================

async function stopRadar(
  sendMessage = true,
  skipGuardDisarm = false
) {
  active =
    false;

  if (
    pollTimer
  ) {
    clearInterval(
      pollTimer
    );

    pollTimer =
      null;
  }

  await saveSummary(
    "STOP"
  );

  if (
    !skipGuardDisarm
  ) {
    await disarmCrashGuard();
  }

  if (
    sendMessage
  ) {
    await bot.telegram.sendMessage(
      CHAT_ID,
      `⛔ TEST ARRÊTÉ

Token :

${mint || "aucun"}

🔄 Cycles :

${sessionCycles}

💰 Bénéfice session :

${sessionProfit >= 0 ? "+" : ""}${formatUsd(sessionProfit)}

📌 Position ouverte :

${position ? "OUI" : "NON"}

🛡️ Crash Guard :

DÉSARMÉ

⚠️ Simulation uniquement.`
    );
  }

  console.log(
    "⛔ Radar arrêté."
  );
}

// ============================================================
// COMMANDES TELEGRAM
// ============================================================

bot.command(
  "starttrade",
  async (ctx) => {
    const parts =
      ctx.message.text
        .trim()
        .split(/\s+/);

    if (
      parts.length < 2
    ) {
      await ctx.reply(
        `❌ Indique le mint du token.

Exemple :

/starttrade TON_MINT`
      );

      return;
    }

    await startRadar(
      parts[1]
    );
  }
);

bot.command(
  "stoptrade",
  async (ctx) => {
    if (!active) {
      await ctx.reply(
        "ℹ️ Aucun test en cours."
      );

      return;
    }

    await stopRadar(
      true
    );
  }
);

bot.command(
  "status",
  async (ctx) => {
    if (!active) {
      await ctx.reply(
        `⚪ Aucun test en cours.

V5.1 prête.`
      );

      return;
    }

    const elapsed =
      now() -
      sessionStartTime;

    const minutes =
      Math.floor(
        elapsed /
          60000
      );

    const seconds =
      Math.floor(
        (
          elapsed %
          60000
        ) / 1000
      );

    await ctx.reply(
      `📊 STATUS V5.1

Token :

${mint}

⏱️ Session :

${minutes}m ${seconds}s / 45m

🔄 Cycles :

${sessionCycles}

💰 Bénéfice :

${sessionProfit >= 0 ? "+" : ""}${formatUsd(sessionProfit)}

📌 Position :

${position ? "OUVERTE" : "AUCUNE"}

⚡ Accélération :

${accelerationWarningActive ? "⚠️ ACTIVE" : "🟢 normale"}

🛡️ Crash Guard :

${crashGuardLevel}

🛒 Achats :

${crashGuardBuyBlocked ? "⛔ BLOQUÉS" : "🟢 AUTORISÉS"}

🔒 Verrouillage :

${crashGuardLocked ? "🔴 OUI" : "🟢 NON"}

🚨 Sortie urgence :

${crashGuardEmergencyExitDone ? "EFFECTUÉE" : "NON"}

🛡️ Confirmations :

${healthyConfirmations}/${REQUIRED_HEALTHY_CONFIRMATIONS}`
    );
  }
);

// ============================================================
// DERNIER CRASH
// ============================================================

bot.command(
  "lastcrash",
  async (ctx) => {
    if (
      !fs.existsSync(
        CRASH_FILE
      )
    ) {
      await ctx.reply(
        `📂 Aucun crash report trouvé.

Le prochain crash sera automatiquement sauvegardé ici et envoyé dans Telegram.`
      );

      return;
    }

    try {
      const content =
        fs.readFileSync(
          CRASH_FILE,
          "utf8"
        );

      const reports =
        JSON.parse(
          content
        );

      if (
        !Array.isArray(
          reports
        ) ||
        reports.length ===
          0
      ) {
        await ctx.reply(
          "📂 Aucun crash report disponible."
        );

        return;
      }

      const last =
        reports[
          reports.length - 1
        ];

      await ctx.reply(
        `📊 DERNIER CRASH

Token :

${last.mint}

Date :

${last.timestamp}

Cycles :

${last.cyclesCompleted}

Bénéfice session :

${formatUsd(
  last.sessionProfit
)}

Prix :

$${Number(
  last.crashMarket.price
).toFixed(8)}

Liquidité :

${formatUsd(
  last.crashMarket.liquidity
)}

⚡ Accélération :

${last.acceleration.level}

📁 Le fichier complet va être envoyé.`
      );

      await ctx.replyWithDocument(
        {
          source:
            CRASH_FILE
        },
        {
          caption:
            "📁 crash_reports.json"
        }
      );

    } catch (error) {
      await ctx.reply(
        `❌ Impossible de lire le crash report.

${error.message}`
      );
    }
  }
);

// ============================================================
// AIDE
// ============================================================

bot.command(
  "help",
  async (ctx) => {
    await ctx.reply(
      `🤖 COMMANDES V5.1

/starttrade MINT

▶️ démarre un test

/status

📊 affiche l'état

/lastcrash

📁 récupère le dernier crash report

/stoptrade

⛔ arrête le test

/help

ℹ️ affiche cette aide

🛡️ CRASH GUARD

🟡 WATCH
Aucune action

🟠 DANGER
Achats bloqués

🔴 CRITICAL
Sortie d'urgence + verrouillage total

⚠️ V5.1 = SIMULATION UNIQUEMENT`
    );
  }
);

// ============================================================
// LANCEMENT
// ============================================================

bot.launch();

console.log(
  "🤖 Bot Telegram V5.1 lancé."
);

// ============================================================
// ARRÊT PROPRE
// ============================================================

async function shutdown() {
  try {
    await disarmCrashGuard();
  } catch {}

  try {
    v51Server.close();
  } catch {}

  bot.stop(
    "SHUTDOWN"
  );
}

process.once(
  "SIGINT",
  shutdown
);

process.once(
  "SIGTERM",
  shutdown
);
