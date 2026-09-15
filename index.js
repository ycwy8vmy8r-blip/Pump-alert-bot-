require("dotenv").config();

const { Telegraf } = require("telegraf");
const { PublicKey } = require("@solana/web3.js");
const fs = require("fs");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;

const TOKEN_MINT =
  "8uJzBn6QvEmHESjzbPbegvvfXHXgWJmnp7mfBwgGFh1a";

const SOL_MINT =
  "So11111111111111111111111111111111111111112";

const PUMP_PROGRAM =
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const PUMPSWAP_PROGRAM =
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

const CAPITAL_USD = 1;
const TARGET_PCT = 5;
const SESSION_MINUTES = 45;

const POLL_MS = 2000;
const HISTORY_MS = 120000;

const MIN_LIQUIDITY_USD = 3000;

const MAX_PRICE_DROP_10S = -5;
const MAX_LIQ_DROP_10S = -12;
const MAX_LIQ_DROP_30S = -20;
const ACCELERATION_DROP_5S = -8;

const CRASH_PRICE_DROP_10S = -20;
const CRASH_LIQ_DROP_10S = -50;

const COOLDOWN_MS = 15000;
const POST_SELL_OBSERVATION_MS = 30000;
const NO_NEW_BUY_AFTER_MINUTES = 43;

const HELIUS_RPC =
  `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const HELIUS_WS =
  `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

const bot = new Telegraf(BOT_TOKEN);

const DATA_DIR = fs.existsSync("/data")
  ? "/data"
  : path.join(__dirname, "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const MARKET_FILE =
  path.join(DATA_DIR, "v5_1_market_history.jsonl");

const TRADES_FILE =
  path.join(DATA_DIR, "v5_1_trades.jsonl");

const HELIUS_FILE =
  path.join(DATA_DIR, "v5_1_helius_events.jsonl");

const CRASH_FILE =
  path.join(DATA_DIR, "v5_1_crash_report.json");

const SUMMARY_FILE =
  path.join(DATA_DIR, "v5_1_summary.json");

let running = false;
let sessionStart = null;

let cycle = 0;
let winners = 0;
let losers = 0;
let pnl = 0;

let position = null;
let lastMarket = null;

let marketHistory = [];

let lastBuyTime = 0;
let lastSellTime = 0;

let ws = null;
let interval = null;

let selectedPool = null;

function now() {
  return Date.now();
}

function appendJsonl(file, obj) {
  try {
    fs.appendFileSync(
      file,
      JSON.stringify(obj) + "\n"
    );
  } catch (e) {
    console.log(
      "Erreur écriture:",
      e.message
    );
  }
}

async function telegram(text) {
  try {
    await bot.telegram.sendMessage(
      CHAT_ID,
      text
    );
  } catch (e) {
    console.log(
      "Telegram:",
      e.message
    );
  }
}

function fmtUsd(v) {
  if (!Number.isFinite(v)) {
    return "N/A";
  }

  if (Math.abs(v) < 0.01) {
    return `$${v.toFixed(8)}`;
  }

  return `$${v.toFixed(4)}`;
}

function fmtPct(v) {
  if (!Number.isFinite(v)) {
    return "N/A";
  }

  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

async function rpc(method, params = []) {
  const response = await fetch(
    HELIUS_RPC,
    {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      })
    }
  );

  if (!response.ok) {
    throw new Error(
      `Helius HTTP ${response.status}`
    );
  }

  const json = await response.json();

  if (json.error) {
    throw new Error(
      json.error.message ||
      "Helius RPC error"
    );
  }

  return json.result;
}

/*
 * ---------------------------------------------------------
 * PUMPSWAP CANONICAL POOL
 * ---------------------------------------------------------
 *
 * Pump documente le pool canonique comme :
 *
 * ["pool", index, creator, baseMint, quoteMint]
 *
 * Pour le pool canonique Pump :
 * - index = 0
 * - creator = pumpPoolAuthorityPda(baseMint)
 *
 * pumpPoolAuthorityPda :
 * ["pool-authority", baseMint]
 * sur le Pump program.
 */

function derivePumpPoolAuthority(mint) {
  const mintKey =
    new PublicKey(mint);

  const [authority] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from(
          "pool-authority"
        ),
        mintKey.toBuffer()
      ],
      new PublicKey(
        PUMP_PROGRAM
      )
    );

  return authority;
}

function deriveCanonicalPumpPool(mint) {
  const mintKey =
    new PublicKey(mint);

  const authority =
    derivePumpPoolAuthority(
      mint
    );

  const indexBuffer =
    Buffer.alloc(2);

  indexBuffer.writeUInt16LE(
    0,
    0
  );

  const [pool] =
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("pool"),
        indexBuffer,
        authority.toBuffer(),
        mintKey.toBuffer(),
        new PublicKey(
          SOL_MINT
        ).toBuffer()
      ],
      new PublicKey(
        PUMPSWAP_PROGRAM
      )
    );

  return {
    pool,
    authority
  };
}

async function loadCanonicalPool() {
  console.log(
    "🔎 Recherche du pool canonique PumpSwap..."
  );

  const {
    pool,
    authority
  } =
    deriveCanonicalPumpPool(
      TOKEN_MINT
    );

  console.log(
    "Pool PDA:",
    pool.toBase58()
  );

  console.log(
    "Pool authority:",
    authority.toBase58()
  );

  const result =
    await rpc(
      "getAccountInfo",
      [
        pool.toBase58(),
        {
          encoding: "base64",
          commitment: "processed"
        }
      ]
    );

  if (
    !result ||
    !result.value
  ) {
    throw new Error(
      `Pool canonique introuvable: ${pool.toBase58()}`
    );
  }

  const parsed =
    parsePumpSwapPool(
      pool.toBase58(),
      result.value
    );

  if (!parsed) {
    throw new Error(
      "Impossible de lire le pool PumpSwap canonique"
    );
  }

  if (
    parsed.baseMint !==
    TOKEN_MINT
  ) {
    throw new Error(
      "Le pool canonique ne contient pas le token demandé"
    );
  }

  if (
    parsed.quoteMint !==
    SOL_MINT
  ) {
    throw new Error(
      "Le pool canonique n'est pas en WSOL"
    );
  }

  selectedPool =
    parsed;

  console.log(
    "✅ POOL PUMPSWAP TROUVÉ"
  );

  console.log(
    "Pool:",
    parsed.address
  );

  console.log(
    "Base mint:",
    parsed.baseMint
  );

  console.log(
    "Quote mint:",
    parsed.quoteMint
  );

  console.log(
    "Base vault:",
    parsed.baseVault
  );

  console.log(
    "Quote vault:",
    parsed.quoteVault
  );

  console.log(
    "Virtual quote:",
    parsed.virtualQuoteReserves.toString()
  );

  return parsed;
}

function readSignedBigIntLE(
  buffer,
  offset,
  length
) {
  let value = 0n;

  for (
    let i = length - 1;
    i >= 0;
    i--
  ) {
    value =
      (value << 8n) +
      BigInt(
        buffer[offset + i]
      );
  }

  const bits =
    BigInt(length * 8);

  const signBit =
    1n << (bits - 1n);

  if (value & signBit) {
    value -=
      1n << bits;
  }

  return value;
}

function parsePumpSwapPool(
  address,
  account
) {
  if (
    !account ||
    !account.data
  ) {
    return null;
  }

  const data =
    Buffer.from(
      account.data[0],
      "base64"
    );

  /*
   * Pool layout:
   *
   * 0-7   discriminator
   * 8     bump
   * 9-10  index
   * 11-42 creator
   * 43-74 baseMint
   * 75-106 quoteMint
   * 107-138 lpMint
   * 139-170 base vault
   * 171-202 quote vault
   * 203-210 lp supply
   * 211-242 coin creator
   * 243    mayhem
   * 244    cashback
   * 245-260 virtual quote reserves
   */

  if (
    data.length <
    261
  ) {
    return null;
  }

  try {
    const baseMint =
      new PublicKey(
        data.slice(43, 75)
      ).toBase58();

    const quoteMint =
      new PublicKey(
        data.slice(75, 107)
      ).toBase58();

    const baseVault =
      new PublicKey(
        data.slice(139, 171)
      ).toBase58();

    const quoteVault =
      new PublicKey(
        data.slice(171, 203)
      ).toBase58();

    const virtualQuoteReserves =
      readSignedBigIntLE(
        data,
        245,
        16
      );

    return {
      address,

      baseMint,
      quoteMint,

      baseVault,
      quoteVault,

      virtualQuoteReserves
    };

  } catch {
    return null;
  }
}

/*
 * ---------------------------------------------------------
 * RESERVES ON-CHAIN
 * ---------------------------------------------------------
 */

async function getPoolReserves(
  pool
) {
  const requests = [
    {
      jsonrpc: "2.0",
      id: 1,
      method:
        "getTokenAccountBalance",
      params: [
        pool.baseVault,
        "processed"
      ]
    },

    {
      jsonrpc: "2.0",
      id: 2,
      method:
        "getBalance",
      params: [
        pool.quoteVault,
        {
          commitment:
            "processed"
        }
      ]
    }
  ];

  const response =
    await fetch(
      HELIUS_RPC,
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json"
        },
        body:
          JSON.stringify(
            requests
          )
      }
    );

  if (!response.ok) {
    throw new Error(
      `Helius HTTP ${response.status}`
    );
  }

  const results =
    await response.json();

  const baseResult =
    results.find(
      x => x.id === 1
    );

  const quoteResult =
    results.find(
      x => x.id === 2
    );

  if (
    !baseResult ||
    baseResult.error
  ) {
    throw new Error(
      baseResult?.error?.message ||
      "Réserve token indisponible"
    );
  }

  if (
    !quoteResult ||
    quoteResult.error
  ) {
    throw new Error(
      quoteResult?.error?.message ||
      "Réserve SOL indisponible"
    );
  }

  const baseValue =
    baseResult.result?.value;

  const quoteValue =
    quoteResult.result?.value;

  if (
    !baseValue ||
    quoteValue == null
  ) {
    throw new Error(
      "Réserves PumpSwap indisponibles"
    );
  }

  const baseTokens =
    Number(
      baseValue.uiAmountString ||
      baseValue.uiAmount ||
      0
    );

  const rawQuoteLamports =
    BigInt(
      quoteValue.value
    );

  const virtualQuote =
    pool.virtualQuoteReserves >
    0n
      ? pool.virtualQuoteReserves
      : 0n;

  const effectiveQuoteLamports =
    rawQuoteLamports +
    virtualQuote;

  const quoteSol =
    Number(
      effectiveQuoteLamports
    ) / 1e9;

  return {
    baseTokens,
    quoteSol,
    rawQuoteLamports,
    virtualQuoteLamports:
      virtualQuote
  };
}

/*
 * ---------------------------------------------------------
 * DEXSCREENER
 * ---------------------------------------------------------
 *
 * DexScreener sert uniquement pour :
 * - prix USD
 * - prix SOL
 *
 * PAS pour la liquidité.
 */

async function getDexMarket() {
  const url =
    `https://api.dexscreener.com/token-pairs/v1/solana/${TOKEN_MINT}`;

  const response =
    await fetch(
      url,
      {
        headers: {
          accept:
            "application/json"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `DexScreener HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  const pairs =
    Array.isArray(json)
      ? json
      : (
          json.pairs || []
        );

  const pumpPair =
    pairs.find(
      p =>
        p &&
        p.dexId ===
          "pumpswap" &&
        p.baseToken &&
        p.baseToken.address ===
          TOKEN_MINT
    );

  if (!pumpPair) {
    throw new Error(
      "Prix PumpSwap indisponible"
    );
  }

  const priceUsd =
    Number(
      pumpPair.priceUsd
    );

  const priceNative =
    Number(
      pumpPair.priceNative
    );

  if (
    !Number.isFinite(
      priceUsd
    ) ||
    priceUsd <= 0
  ) {
    throw new Error(
      "Prix USD indisponible"
    );
  }

  let solUsd = null;

  if (
    Number.isFinite(
      priceNative
    ) &&
    priceNative > 0
  ) {
    solUsd =
      priceUsd /
      priceNative;
  }

  return {
    priceUsd,
    priceNative,
    solUsd,

    symbol:
      pumpPair.baseToken
        .symbol ||
      "TOKEN",

    name:
      pumpPair.baseToken
        .name ||
      "Token"
  };
}

/*
 * ---------------------------------------------------------
 * MARKET
 * ---------------------------------------------------------
 */

async function getMarket() {
  if (!selectedPool) {
    await loadCanonicalPool();
  }

  const dex =
    await getDexMarket();

  const reserves =
    await getPoolReserves(
      selectedPool
    );

  const quoteUsd =
    Number.isFinite(
      dex.solUsd
    )
      ? reserves.quoteSol *
        dex.solUsd
      : 0;

  const baseUsd =
    reserves.baseTokens *
    dex.priceUsd;

  const liquidityUsd =
    quoteUsd +
    baseUsd;

  return {
    ts: now(),

    price:
      dex.priceUsd,

    liquidity:
      Number.isFinite(
        liquidityUsd
      )
        ? liquidityUsd
        : 0,

    quoteSol:
      reserves.quoteSol,

    baseTokens:
      reserves.baseTokens,

    solUsd:
      dex.solUsd,

    pairAddress:
      selectedPool.address,

    symbol:
      dex.symbol,

    name:
      dex.name
  };
}

function saveMarket(
  market
) {
  appendJsonl(
    MARKET_FILE,
    market
  );

  marketHistory.push(
    market
  );

  trimHistory();
}

function trimHistory() {
  const cutoff =
    now() -
    HISTORY_MS;

  marketHistory =
    marketHistory.filter(
      x =>
        x.ts >= cutoff
    );
}

function getChange(
  seconds,
  field
) {
  if (!lastMarket) {
    return null;
  }

  const cutoff =
    now() -
    seconds * 1000;

  let old = null;

  for (
    let i =
      marketHistory.length - 1;
    i >= 0;
    i--
  ) {
    if (
      marketHistory[i].ts <=
      cutoff
    ) {
      old =
        marketHistory[i];
      break;
    }
  }

  if (!old) {
    return null;
  }

  const current =
    lastMarket[field];

  if (
    !Number.isFinite(
      old[field]
    ) ||
    !Number.isFinite(
      current
    )
  ) {
    return null;
  }

  if (
    old[field] === 0
  ) {
    return null;
  }

  return (
    (
      (
        current -
        old[field]
      ) /
      old[field]
    ) * 100
  );
}

function isCrash(
  market
) {
  const price10 =
    getChange(
      10,
      "price"
    );

  const liq10 =
    getChange(
      10,
      "liquidity"
    );

  if (
    market.liquidity <= 1 ||
    (
      price10 !== null &&
      price10 <=
        CRASH_PRICE_DROP_10S
    ) ||
    (
      liq10 !== null &&
      liq10 <=
        CRASH_LIQ_DROP_10S
    )
  ) {
    return {
      crash: true,
      price10,
      liq10
    };
  }

  return {
    crash: false,
    price10,
    liq10
  };
}

/*
 * ---------------------------------------------------------
 * V5.1 ENTRY FILTERS
 * ---------------------------------------------------------
 */

function entryAllowed() {
  if (!lastMarket) {
    return {
      ok: false,
      reason:
        "marché indisponible"
    };
  }

  if (
    lastMarket.liquidity <
    MIN_LIQUIDITY_USD
  ) {
    return {
      ok: false,
      reason:
        `liquidité ${fmtUsd(lastMarket.liquidity)} < ${fmtUsd(MIN_LIQUIDITY_USD)}`
    };
  }

  const price10 =
    getChange(
      10,
      "price"
    );

  const liq10 =
    getChange(
      10,
      "liquidity"
    );

  const liq30 =
    getChange(
      30,
      "liquidity"
    );

  const price5 =
    getChange(
      5,
      "price"
    );

  if (
    price10 !== null &&
    price10 <=
      MAX_PRICE_DROP_10S
  ) {
    return {
      ok: false,
      reason:
        `prix ${fmtPct(price10)} / 10s`
    };
  }

  if (
    liq10 !== null &&
    liq10 <=
      MAX_LIQ_DROP_10S
  ) {
    return {
      ok: false,
      reason:
        `liquidité ${fmtPct(liq10)} / 10s`
    };
  }

  if (
    liq30 !== null &&
    liq30 <=
      MAX_LIQ_DROP_30S
  ) {
    return {
      ok: false,
      reason:
        `liquidité ${fmtPct(liq30)} / 30s`
    };
  }

  if (
    price5 !== null &&
    price5 <=
      ACCELERATION_DROP_5S
  ) {
    return {
      ok: false,
      reason:
        `accélération ${fmtPct(price5)} / 5s`
    };
  }

  if (
    now() -
      lastBuyTime <
      COOLDOWN_MS
  ) {
    return {
      ok: false,
      reason:
        "cooldown"
    };
  }

  if (
    lastSellTime &&
    now() -
      lastSellTime <
      POST_SELL_OBSERVATION_MS
  ) {
    return {
      ok: false,
      reason:
        "observation post-vente"
    };
  }

  const elapsedMin =
    (
      now() -
      sessionStart
    ) / 60000;

  if (
    elapsedMin >=
    NO_NEW_BUY_AFTER_MINUTES
  ) {
    return {
      ok: false,
      reason:
        "fin de fenêtre d'achat"
    };
  }

  return {
    ok: true
  };
}

/*
 * ---------------------------------------------------------
 * SIMULATION
 * ---------------------------------------------------------
 */

function openPosition() {
  if (!lastMarket) {
    return;
  }

  const tokens =
    CAPITAL_USD /
    lastMarket.price;

  position = {
    entryPrice:
      lastMarket.price,

    capital:
      CAPITAL_USD,

    tokens,

    entryTime:
      now(),

    entryLiquidity:
      lastMarket.liquidity
  };

  lastBuyTime =
    now();

  appendJsonl(
    TRADES_FILE,
    {
      ts: now(),
      type: "BUY",
      cycle:
        cycle + 1,
      price:
        lastMarket.price,
      liquidity:
        lastMarket.liquidity,
      capital:
        CAPITAL_USD,
      tokens
    }
  );

  console.log(
    `🟢 BUY #${cycle + 1} | ` +
    `${fmtUsd(lastMarket.price)} | ` +
    `L ${fmtUsd(lastMarket.liquidity)}`
  );
}

function closePosition(
  reason
) {
  if (
    !position ||
    !lastMarket
  ) {
    return null;
  }

  const exitPrice =
    lastMarket.price;

  const value =
    position.tokens *
    exitPrice;

  const profit =
    value -
    position.capital;

  const pct =
    (
      profit /
      position.capital
    ) * 100;

  cycle++;

  pnl += profit;

  if (
    profit >= 0
  ) {
    winners++;
  } else {
    losers++;
  }

  const trade = {
    ts: now(),
    type: "SELL",
    cycle,
    reason,

    entryPrice:
      position.entryPrice,

    exitPrice,

    entryLiquidity:
      position.entryLiquidity,

    exitLiquidity:
      lastMarket.liquidity,

    capital:
      position.capital,

    value,
    profit,
    pct,

    durationSeconds:
      (
        now() -
        position.entryTime
      ) / 1000
  };

  appendJsonl(
    TRADES_FILE,
    trade
  );

  console.log(
    `🔴 SELL #${cycle} | ` +
    `${reason} | ` +
    `${fmtPct(pct)} | ` +
    `${fmtUsd(profit)}`
  );

  position = null;

  lastSellTime =
    now();

  return trade;
}

async function checkPosition() {
  if (
    !position ||
    !lastMarket
  ) {
    return;
  }

  const elapsed =
    (
      now() -
      position.entryTime
    ) / 60000;

  const change =
    (
      (
        lastMarket.price -
        position.entryPrice
      ) /
      position.entryPrice
    ) * 100;

  if (
    change >=
    TARGET_PCT
  ) {
    const trade =
      closePosition(
        "TARGET_+5"
      );

    if (trade) {
      await telegram(
        `🟢 V5.1 WIN #${trade.cycle}\n` +
        `+${trade.pct.toFixed(2)}% | ` +
        `${fmtUsd(trade.profit)}\n` +
        `P&L session: ${fmtUsd(pnl)}`
      );
    }

    return;
  }

  if (
    elapsed >=
    SESSION_MINUTES
  ) {
    const trade =
      closePosition(
        "SESSION_45M"
      );

    if (trade) {
      await telegram(
        `🛡️ V5.1 SORTIE SÉCURITÉ 45 MIN\n` +
        `${trade.pct >= 0 ? "+" : ""}` +
        `${trade.pct.toFixed(2)}% | ` +
        `${fmtUsd(trade.profit)}\n` +
        `P&L session: ${fmtUsd(pnl)}`
      );
    }
  }
}

async function handleCrash(
  info
) {
  if (!running) {
    return;
  }

  console.log(
    "🚨 CRASH détecté"
  );

  let trade = null;

  if (position) {
    trade =
      closePosition(
        "CRASH"
      );
  }

  const report = {
    ts: now(),
    token: TOKEN_MINT,
    pool:
      selectedPool?.address ||
      null,
    cycle,
    winners,
    losers,
    pnl,
    market:
      lastMarket,
    crash:
      info,
    trade
  };

  try {
    fs.writeFileSync(
      CRASH_FILE,
      JSON.stringify(
        report,
        null,
        2
      )
    );
  } catch {}

  await telegram(
    `🚨 V5.1 CRASH\n\n` +
    `Prix: ${fmtUsd(lastMarket?.price)}\n` +
    `Liquidité réelle: ${fmtUsd(lastMarket?.liquidity)}\n` +
    `P&L session: ${fmtUsd(pnl)}\n` +
    `Cycles: ${cycle}\n` +
    `Gagnants: ${winners}\n` +
    `Perdants: ${losers}`
  );

  running = false;

  stopHelius();
}

async function marketTick() {
  if (!running) {
    return;
  }

  try {
    const market =
      await getMarket();

    lastMarket =
      market;

    saveMarket(
      market
    );

    const elapsedMin =
      (
        now() -
        sessionStart
      ) / 60000;

    console.log(
      `📊 ${market.symbol} | ` +
      `Prix ${fmtUsd(market.price)} | ` +
      `Liq réelle ${fmtUsd(market.liquidity)} | ` +
      `Cycle ${cycle} | ` +
      `P&L ${fmtUsd(pnl)}`
    );

    const crash =
      isCrash(
        market
      );

    if (
      crash.crash
    ) {
      await handleCrash(
        crash
      );

      return;
    }

    if (
      elapsedMin >=
      SESSION_MINUTES
    ) {
      if (position) {
        const trade =
          closePosition(
            "SESSION_45M"
          );

        if (trade) {
          await telegram(
            `🛡️ FIN SESSION 45 MIN\n` +
            `${trade.pct >= 0 ? "+" : ""}` +
            `${trade.pct.toFixed(2)}% | ` +
            `${fmtUsd(trade.profit)}\n` +
            `P&L total: ${fmtUsd(pnl)}`
          );
        }
      }

      running = false;

      stopHelius();

      if (interval) {
        clearInterval(
          interval
        );

        interval = null;
      }

      await telegram(
        `🏁 V5.1 TERMINÉE\n\n` +
        `Cycles: ${cycle}\n` +
        `Wins: ${winners}\n` +
        `Losses: ${losers}\n` +
        `P&L: ${fmtUsd(pnl)}`
      );

      return;
    }

    await checkPosition();

    if (!position) {
      const allowed =
        entryAllowed();

      if (
        allowed.ok
      ) {
        openPosition();
      } else {
        console.log(
          `⏸️ Pas de BUY: ${allowed.reason}`
        );
      }
    }

  } catch (e) {
    console.log(
      "⚠️ Marché indisponible:",
      e.message
    );
  }
}

/*
 * ---------------------------------------------------------
 * HELIUS WSS
 * ---------------------------------------------------------
 */

function startHelius() {
  if (ws) {
    return;
  }

  try {
    const WebSocket =
      require("ws");

    ws =
      new WebSocket(
        HELIUS_WS
      );

    ws.on(
      "open",
      () => {
        console.log(
          "✅ Helius WSS connecté"
        );

        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method:
              "logsSubscribe",
            params: [
              {
                mentions: [
                  TOKEN_MINT
                ]
              },
              {
                commitment:
                  "processed"
              }
            ]
          })
        );
      }
    );

    ws.on(
      "message",
      raw => {
        try {
          const msg =
            JSON.parse(
              raw.toString()
            );

          appendJsonl(
            HELIUS_FILE,
            {
              ts: now(),
              msg
            }
          );
        } catch {}
      }
    );

    ws.on(
      "error",
      e => {
        console.log(
          "⚠️ Helius WSS:",
          e.message
        );
      }
    );

    ws.on(
      "close",
      () => {
        console.log(
          "Helius WSS fermé"
        );

        ws = null;

        if (running) {
          setTimeout(
            () => {
              if (
                running &&
                !ws
              ) {
                startHelius();
              }
            },
            5000
          );
        }
      }
    );

  } catch (e) {
    console.log(
      "Erreur WSS:",
      e.message
    );
  }
}

function stopHelius() {
  if (!ws) {
    return;
  }

  try {
    ws.close();
  } catch {}

  ws = null;
}

/*
 * ---------------------------------------------------------
 * SESSION
 * ---------------------------------------------------------
 */

async function startSession() {
  if (running) {
    return;
  }

  running = true;

  sessionStart =
    now();

  cycle = 0;
  winners = 0;
  losers = 0;
  pnl = 0;

  position = null;
  lastMarket = null;

  marketHistory = [];

  lastBuyTime = 0;
  lastSellTime = 0;

  selectedPool = null;

  console.log(
    "🚀 V5.1 démarrée"
  );

  console.log(
    "Token:",
    TOKEN_MINT
  );

  console.log(
    "Capital:",
    `$${CAPITAL_USD}`
  );

  console.log(
    "Target:",
    `+${TARGET_PCT}%`
  );

  console.log(
    "Session:",
    `${SESSION_MINUTES} min`
  );

  await telegram(
    `🚀 V5.1 DÉMARRÉE\n\n` +
    `Capital/cycle: $${CAPITAL_USD}\n` +
    `Objectif: +${TARGET_PCT}%\n` +
    `Session: ${SESSION_MINUTES} min\n` +
    `Marché: PumpSwap\n` +
    `Liquidité: réserves on-chain`
  );

  startHelius();

  if (interval) {
    clearInterval(
      interval
    );
  }

  interval =
    setInterval(
      marketTick,
      POLL_MS
    );

  await marketTick();
}

async function stopSession(
  reason = "MANUAL_STOP"
) {
  if (!running) {
    return;
  }

  if (
    position &&
    lastMarket
  ) {
    const trade =
      closePosition(
        reason
      );

    if (trade) {
      await telegram(
        `🛑 POSITION FERMÉE\n` +
        `${trade.pct >= 0 ? "+" : ""}` +
        `${trade.pct.toFixed(2)}% | ` +
        `${fmtUsd(trade.profit)}`
      );
    }
  }

  running = false;

  stopHelius();

  if (interval) {
    clearInterval(
      interval
    );

    interval = null;
  }

  try {
    fs.writeFileSync(
      SUMMARY_FILE,
      JSON.stringify(
        {
          ts: now(),
          running: false,
          reason,
          cycle,
          winners,
          losers,
          pnl
        },
        null,
        2
      )
    );
  } catch {}

  await telegram(
    `🛑 V5.1 ARRÊTÉE\n\n` +
    `Cycles: ${cycle}\n` +
    `Wins: ${winners}\n` +
    `Losses: ${losers}\n` +
    `P&L: ${fmtUsd(pnl)}`
  );
}

/*
 * ---------------------------------------------------------
 * TELEGRAM
 * ---------------------------------------------------------
 */

bot.start(
  ctx => {
    ctx.reply(
      `🤖 V5.1\n\n` +
      `/starttrade\n` +
      `/stoptrade\n` +
      `/status\n` +
      `/lastcrash\n` +
      `/help`
    );
  }
);

bot.command(
  "starttrade",
  async ctx => {
    await startSession();
  }
);

bot.command(
  "stoptrade",
  async ctx => {
    await stopSession();
  }
);

bot.command(
  "status",
  async ctx => {
    const elapsed =
      sessionStart
        ? (
            (
              now() -
              sessionStart
            ) / 60000
          ).toFixed(1)
        : "0";

    const posText =
      position
        ? `OUVERTE\nEntrée: ${fmtUsd(position.entryPrice)}`
        : "Aucune";

    await ctx.reply(
      `📊 V5.1 STATUS\n\n` +
      `Actif: ${running ? "OUI" : "NON"}\n` +
      `Temps: ${elapsed} / ${SESSION_MINUTES} min\n` +
      `Cycles: ${cycle}\n` +
      `Wins: ${winners}\n` +
      `Losses: ${losers}\n` +
      `P&L: ${fmtUsd(pnl)}\n\n` +
      `Position: ${posText}\n` +
      `Prix: ${fmtUsd(lastMarket?.price)}\n` +
      `Liquidité réelle: ${fmtUsd(lastMarket?.liquidity)}\n` +
      `SOL: ${fmtUsd(lastMarket?.solUsd)}\n` +
      `Pool: ${selectedPool?.address || "N/A"}`
    );
  }
);

bot.command(
  "lastcrash",
  async ctx => {
    try {
      if (
        !fs.existsSync(
          CRASH_FILE
        )
      ) {
        return ctx.reply(
          "Aucun crash enregistré."
        );
      }

      const report =
        JSON.parse(
          fs.readFileSync(
            CRASH_FILE,
            "utf8"
          )
        );

      await ctx.reply(
        `🚨 DERNIER CRASH\n\n` +
        `Prix: ${fmtUsd(report.market?.price)}\n` +
        `Liquidité: ${fmtUsd(report.market?.liquidity)}\n` +
        `P&L: ${fmtUsd(report.pnl)}\n` +
        `Cycles: ${report.cycle}\n` +
        `Pool: ${report.pool || "N/A"}`
      );

    } catch {
      await ctx.reply(
        "Impossible de lire le dernier crash."
      );
    }
  }
);

bot.command(
  "help",
  ctx => {
    ctx.reply(
      `V5.1\n\n` +
      `/starttrade = démarrer\n` +
      `/stoptrade = arrêter\n` +
      `/status = état actuel\n` +
      `/lastcrash = dernier crash\n\n` +
      `Simulation uniquement.\n` +
      `$1 par cycle.\n` +
      `Objectif +5%.\n` +
      `Session max 45 min.`
    );
  }
);

bot.launch()
  .then(() => {
    console.log(
      "🤖 Bot Telegram V5.1 lancé"
    );
  })
  .catch(
    err => {
      console.error(
        "Erreur lancement Telegram:",
        err
      );
    }
  );

process.once(
  "SIGINT",
  () => {
    stopHelius();
    bot.stop("SIGINT");
  }
);

process.once(
  "SIGTERM",
  () => {
    stopHelius();
    bot.stop("SIGTERM");
  }
);
