/**
 * Scanner watcher — detects breakouts and forwards them to the canonical
 * ingestion pipeline.
 *
 * Flow:
 *   Binance 24h tickers → score → threshold check → cooldown check →
 *   ingestInternal() → (normalize → validate → dedupe → enqueue → worker) →
 *   signals_v2 + signal_events + push.
 *
 * The scanner does NOT write to signals_v2. Deduplication is now centralized
 * in lib/dedupe (Redis + DB). The in-process cooldown remains as a cheap
 * pre-filter that suppresses Binance noise before we even build a payload —
 * but it is no longer the source of truth for dedupe.
 */

const { Worker } = require("bullmq");
const { getRedis } = require("../lib/redis");
const { fetch24hTickers } = require("../lib/price");
const { ingestInternal } = require("../routes/ingest");
const { STRATEGIES } = require("../lib/strategy");

const SCAN_INTERVAL = 300_000; // 5 min
const BREAKOUT_THRESHOLD = 80;
const COOLDOWN_MS = 3_600_000; // 1 hour per symbol

// Cooldown is Redis-backed so it survives process restarts

function scoreBreakout(ticker, avgVolume) {
  const change = Math.abs(ticker.priceChangePercent);
  const volRatio = ticker.volume / (avgVolume || 1);
  let score = 0;
  score += Math.min(change * 8, 50);
  score += Math.min(volRatio * 10, 30);
  score += 10; // equal long/short bonus
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

    const redis = getRedis();
    const cooldownKey = `scanner:cooldown:${ticker.symbol}`;
    const locked = await redis.get(cooldownKey);
    if (locked) continue;
    await redis.set(cooldownKey, '1', 'PX', COOLDOWN_MS);

    // ── Normalize through canonical schema ──────────────────────
    const dir = ticker.priceChangePercent > 0 ? "LONG" : "SHORT";
    const atr = ticker.highPrice - ticker.lowPrice;
    const risk = Math.max(atr * 0.4, ticker.price * 0.015); // 40% of daily range or 1.5% min

    let stop, tp1, tp2;
    if (dir === "LONG") {
      stop = +(ticker.price - risk).toPrecision(6);
      tp1  = +(ticker.price + risk * 1.0).toPrecision(6);
      tp2  = +(ticker.price + risk * 3).toPrecision(6);
    } else {
      stop = +(ticker.price + risk).toPrecision(6);
      tp1  = +(ticker.price - risk * 1.0).toPrecision(6);
      tp2  = +(ticker.price - risk * 3).toPrecision(6);
    }

    const volumeChange = Math.round((ticker.volume / avgVolume - 1) * 100);

    // ── Forward to ingestion pipeline (sole DB writer) ──────────
    const result = await ingestInternal({
      payload: {
        structured: {
          symbol: ticker.symbol,
          direction: dir,
          entry: ticker.price,
          stop: stop,
          targets: [tp1, tp2],
        },
        source: "scanner",
        provider: "scanner",
        strategy: STRATEGIES.BREAKOUT_V1,
        timeframe: "scanner",
        confidence: score,
        signal_ts: Date.now(),
        meta: { volume_change: volumeChange, breakout_score: score },
      },
      botUserId: null,
    });

    if (!result.ok) {
      // 409 = duplicate (expected, dedupe window 15min vs 5min scan cycle).
      // 202 = queued but worker did not finish within INGEST_WAIT_TIMEOUT_MS
      //       (10s default). The job is still processing and will land in
      //       signals_v2 — treat as success, do not warn.
      if (result.http_status !== 409 && result.http_status !== 202) {
        console.warn(
          `[scanner] ingest rejected for ${ticker.symbol}: ${result.error || "unknown"} ${result.reason || ""}`
        );
        continue;
      }
      if (result.http_status === 409) continue;
      // 202 falls through to the alerts++/log block below as success
    }

    alerts++;

    console.log(
      `[scanner] BREAKOUT: ${ticker.symbol} score=${score} ` +
      `change=${ticker.priceChangePercent.toFixed(1)}% → signal #${result.id}`
    );
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
