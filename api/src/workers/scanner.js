/**
 * Scanner watcher — detects breakouts, PERSISTS to signals_v2, THEN pushes.
 *
 * Flow:
 *   Binance 24h tickers → score → threshold check → cooldown check →
 *   INSERT signals_v2 → log CREATED event → emit push job
 */

const { Worker } = require("bullmq");
const { getRedis } = require("../lib/redis");
const { fetch24hTickers } = require("../lib/price");
const db = require("../lib/db");
const Signal = require("../models/signal");
const events = require("../lib/events");
const { pushQueue } = require("./queues");

const SCAN_INTERVAL = 300_000; // 5 min
const BREAKOUT_THRESHOLD = 50;
const COOLDOWN_MS = 3_600_000; // 1 hour per symbol

const _alerted = new Map();

function scoreBreakout(ticker, avgVolume) {
  const change = Math.abs(ticker.priceChangePercent);
  const volRatio = ticker.volume / (avgVolume || 1);
  let score = 0;
  score += Math.min(change * 8, 50);
  score += Math.min(volRatio * 10, 30);
  score += ticker.priceChangePercent > 0 ? 10 : 5;
  score += ticker.count > 50000 ? 10 : 0;
  return Math.round(Math.min(score, 100));
}

async function scanOnce() {
  const raw = await fetch24hTickers();
  const usdt = raw.filter(
    (t) => t.symbol.endsWith("USDT") && parseFloat(t.quoteVolume) > 500_000
  );
  if (usdt.length === 0) return { scanned: 0, alerts: 0 };

  const tickers = usdt.map((t) => ({
    symbol: t.symbol,
    price: parseFloat(t.lastPrice),
    priceChangePercent: parseFloat(t.priceChangePercent),
    volume: parseFloat(t.quoteVolume),
    highPrice: parseFloat(t.highPrice),
    lowPrice: parseFloat(t.lowPrice),
    count: parseInt(t.count),
  }));

  const avgVolume = tickers.reduce((s, t) => s + t.volume, 0) / tickers.length;
  const now = Date.now();
  let alerts = 0;

  for (const ticker of tickers) {
    const score = scoreBreakout(ticker, avgVolume);
    if (score < BREAKOUT_THRESHOLD) continue;

    const last = _alerted.get(ticker.symbol) || 0;
    if (now - last < COOLDOWN_MS) continue;
    _alerted.set(ticker.symbol, now);

    // ── Normalize through canonical schema ──────────────────────
    const dir = ticker.priceChangePercent > 0 ? "LONG" : "SHORT";
    const atr = ticker.highPrice - ticker.lowPrice;
    const risk = Math.max(atr * 0.4, ticker.price * 0.015); // 40% of daily range or 1.5% min

    let stop, tp1, tp2;
    if (dir === "LONG") {
      stop = +(ticker.price - risk).toPrecision(6);
      tp1  = +(ticker.price + risk * 1.5).toPrecision(6);
      tp2  = +(ticker.price + risk * 3).toPrecision(6);
    } else {
      stop = +(ticker.price + risk).toPrecision(6);
      tp1  = +(ticker.price - risk * 1.5).toPrecision(6);
      tp2  = +(ticker.price - risk * 3).toPrecision(6);
    }

    const signal = Signal.normalize({
      symbol: ticker.symbol,
      type: "breakout",
      direction: dir,
      entry: ticker.price,
      stop: stop,
      targets: [tp1, tp2],
      confidence: score,
      source: "scanner",
      status: "OPEN",
      volume_change: Math.round((ticker.volume / avgVolume - 1) * 100),
    });

    // ── Persist to DB ───────────────────────────────────────────
    const row = Signal.toDbRow(signal);
    let savedId = null;
    try {
      const r = await db.query(
        `INSERT INTO signals_v2
          (symbol, type, direction, entry, stop, targets, leverage,
           confidence, provider, provider_id, source, bot_user_id, status, meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id`,
        [row.symbol, row.type, row.direction, row.entry, row.stop,
         row.targets, row.leverage, row.confidence, row.provider,
         row.provider_id, row.source, row.bot_user_id, row.status, row.meta]
      );
      savedId = r.rows[0].id;
      signal.id = savedId;
    } catch (err) {
      console.error(`[scanner] DB insert failed for ${ticker.symbol}:`, err.message);
      continue;
    }

    // ── Log CREATED event ───────────────────────────────────────
    await events.logEvent(savedId, "CREATED", {
      newStatus: "OPEN",
      priceAt: ticker.price,
      meta: { score, volume_change: signal.meta.volume_change },
    });

    // ── Emit push job ───────────────────────────────────────────
    await pushQueue().add("breakout", signal);
    alerts++;

    console.log(
      `[scanner] BREAKOUT: ${ticker.symbol} score=${score} ` +
      `change=${ticker.priceChangePercent.toFixed(1)}% → signal #${savedId}`
    );
  }

  // Prune old cooldowns
  for (const [sym, ts] of _alerted) {
    if (now - ts > COOLDOWN_MS * 2) _alerted.delete(sym);
  }

  return { scanned: tickers.length, alerts };
}

function startScannerWatcher() {
  const worker = new Worker(
    "agoraiq-scanner-watcher",
    async () => scanOnce(),
    { connection: getRedis(), concurrency: 1 }
  );

  const { Queue } = require("bullmq");
  const queue = new Queue("agoraiq-scanner-watcher", { connection: getRedis() });
  queue.add("scan-cycle", {}, {
    repeat: { every: SCAN_INTERVAL },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 20 },
  });

  worker.on("failed", (job, err) => console.error("[scanner]", err.message));
  console.log(`[scanner-watcher] started (every ${SCAN_INTERVAL / 1000}s)`);
  return worker;
}

module.exports = { startScannerWatcher };
