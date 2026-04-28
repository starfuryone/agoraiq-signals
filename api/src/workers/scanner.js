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
      // Duplicates are expected (the dedupe window is 15 min, the scan
      // cycle is 5 min). They're audited in signals_rejected by the
      // pipeline itself; nothing further to do here.
      if (result.http_status !== 409) {
        console.warn(
          `[scanner] ingest rejected for ${ticker.symbol}: ${result.error || "unknown"} ${result.reason || ""}`
        );
      }
      continue;
    }

    alerts++;

    console.log(
      `[scanner] BREAKOUT: ${ticker.symbol} score=${score} ` +
      `change=${ticker.priceChangePercent.toFixed(1)}% → signal #${result.id}`
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
