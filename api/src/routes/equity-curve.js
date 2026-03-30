/**
 * ═══════════════════════════════════════════════════════════════
 * EQUITY CURVE ROUTE — /api/v1/proof/equity-curve
 * ═══════════════════════════════════════════════════════════════
 *
 * Returns cumulative R-multiple curve + BTC/ETH benchmark data
 * for the proof page equity chart.
 *
 * Data sources:
 *   - signals_v2 table (resolved trades with r_multiple)
 *   - Binance Spot API (BTC/ETH daily closes via SOCKS5 proxy)
 *   - Kraken fallback if Binance fails
 *
 * Response shape:
 *   { dates: string[], cumR: number[], btcIndexed: number[], ethIndexed: number[] }
 *
 * INSTALLATION:
 *   Option A — Add to existing proof router:
 *     In /opt/agoraiq-signals/api/src/routes/proof.js, add:
 *       const equityCurve = require('./equity-curve');
 *       router.get('/equity-curve', equityCurve);
 *
 *   Option B — Mount separately in index.js:
 *     app.use("/api/v1/proof", require("./routes/equity-curve-router"));
 *
 *   Then: pm2 restart agoraiq-signals-api
 *
 * DEPENDENCIES:
 *   npm install socks-proxy-agent   (if not already installed)
 *   The db module is already available at ../lib/db
 */

const db = require("../lib/db");

// ── Config ────────────────────────────────────────────────────
const SOCKS_PROXY = process.env.SOCKS_PROXY || "socks5://143.198.202.65:1080";
const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";
const KRAKEN_OHLC = "https://api.kraken.com/0/public/OHLC";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min cache
const MAX_DAYS = 365;

// ── In-memory cache ───────────────────────────────────────────
let cache = { data: null, ts: 0 };

// ── SOCKS5 fetch helper (Binance is geo-blocked) ──────────────
let SocksProxyAgent;
try {
  SocksProxyAgent = require("socks-proxy-agent").SocksProxyAgent;
} catch (e) {
  console.warn("[equity-curve] socks-proxy-agent not installed — Binance calls will go direct (may fail if geo-blocked)");
}

async function fetchJSON(url, useSocks = false) {
  // Use dynamic import for node-fetch if needed, or native fetch (Node 18+)
  const fetchFn = globalThis.fetch || (await import("node-fetch")).default;
  const opts = {};
  if (useSocks && SocksProxyAgent) {
    opts.agent = new SocksProxyAgent(SOCKS_PROXY);
  }
  const res = await fetchFn(url, { ...opts, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

// ── Binance daily closes ──────────────────────────────────────
async function fetchBinanceDailyCloses(symbol, days) {
  // symbol: "BTCUSDT" or "ETHUSDT"
  // Returns: Map<date_string, close_price>
  const url = `${BINANCE_KLINES}?symbol=${symbol}&interval=1d&limit=${days}`;
  const data = await fetchJSON(url, true); // via SOCKS5

  const closes = new Map();
  for (const candle of data) {
    // Kline format: [openTime, open, high, low, close, volume, closeTime, ...]
    const date = new Date(candle[0]).toISOString().slice(0, 10);
    closes.set(date, parseFloat(candle[4])); // close price
  }
  return closes;
}

// ── Kraken daily closes (fallback) ────────────────────────────
async function fetchKrakenDailyCloses(pair, days) {
  // pair: "XXBTZUSD" or "XETHZUSD"
  const since = Math.floor((Date.now() - days * 86400000) / 1000);
  const url = `${KRAKEN_OHLC}?pair=${pair}&interval=1440&since=${since}`;
  const data = await fetchJSON(url, false); // Kraken not geo-blocked

  const closes = new Map();
  const result = data.result || {};
  const entries = Object.values(result)[0] || [];
  for (const candle of entries) {
    // Kraken OHLC: [time, open, high, low, close, vwap, volume, count]
    const date = new Date(candle[0] * 1000).toISOString().slice(0, 10);
    closes.set(date, parseFloat(candle[4]));
  }
  return closes;
}

// ── Get benchmark closes with Binance → Kraken fallback ───────
async function getBenchmarkCloses(days) {
  let btcCloses, ethCloses;

  // Try Binance first (via SOCKS5)
  try {
    [btcCloses, ethCloses] = await Promise.all([
      fetchBinanceDailyCloses("BTCUSDT", days),
      fetchBinanceDailyCloses("ETHUSDT", days),
    ]);
    console.log(`[equity-curve] Binance: BTC ${btcCloses.size} days, ETH ${ethCloses.size} days`);
    return { btcCloses, ethCloses, source: "binance" };
  } catch (err) {
    console.warn(`[equity-curve] Binance failed: ${err.message} — falling back to Kraken`);
  }

  // Fallback to Kraken
  try {
    [btcCloses, ethCloses] = await Promise.all([
      fetchKrakenDailyCloses("XXBTZUSD", days),
      fetchKrakenDailyCloses("XETHZUSD", days),
    ]);
    console.log(`[equity-curve] Kraken: BTC ${btcCloses.size} days, ETH ${ethCloses.size} days`);
    return { btcCloses, ethCloses, source: "kraken" };
  } catch (err) {
    console.warn(`[equity-curve] Kraken also failed: ${err.message}`);
    return { btcCloses: new Map(), ethCloses: new Map(), source: "none" };
  }
}

// ── Index benchmark to cumulative return (R-equivalent) ───────
function indexToReturn(closes, dates) {
  // Convert daily close prices to cumulative % return indexed to first date
  // Then scale to approximate R-equivalent for visual comparison
  const indexed = [];
  let firstPrice = null;

  for (const date of dates) {
    const price = closes.get(date);
    if (price && firstPrice === null) firstPrice = price;
    if (price && firstPrice) {
      indexed.push(+((price - firstPrice) / firstPrice * 100).toFixed(2));
    } else {
      // Forward-fill last known value
      indexed.push(indexed.length > 0 ? indexed[indexed.length - 1] : 0);
    }
  }

  // Scale: rough conversion from % return to R-equivalent
  // Using 1R ≈ 2% as a reasonable scaling factor
  return indexed.map(v => +(v / 2).toFixed(2));
}

// ── Main handler ──────────────────────────────────────────────
async function equityCurveHandler(req, res) {
  try {
    // Return cached data if fresh
    if (cache.data && Date.now() - cache.ts < CACHE_TTL_MS) {
      return res.json(cache.data);
    }

    // ── 1. Query resolved signals with R-multiples ────────────
    const result = await db.query(`
      SELECT
        DATE(COALESCE(resolved_at, updated_at, created_at)) AS resolve_date,
        result,
        entry,
        stop,
        status,
        symbol
      FROM signals_v2
      WHERE status IN ('TP1', 'TP2', 'TP3', 'SL', 'EXPIRED')
        AND COALESCE(resolved_at, updated_at, created_at) IS NOT NULL
      ORDER BY COALESCE(resolved_at, updated_at, created_at) ASC
      LIMIT 2000
    `);

    const rows = result.rows;

    if (!rows.length) {
      return res.json({
        dates: [],
        cumR: [],
        btcIndexed: [],
        ethIndexed: [],
        source: "no_data",
        count: 0,
      });
    }

    // ── 2. Build daily cumulative R series ────────────────────
    // Group by date, sum R-multiples per day
    const dailyR = new Map(); // date → total R for that day

    for (const row of rows) {
      const date = row.resolve_date instanceof Date
        ? row.resolve_date.toISOString().slice(0, 10)
        : String(row.resolve_date).slice(0, 10);

      // Compute R-multiple from entry, stop, and result
      const entry = parseFloat(row.entry);
      const stop = parseFloat(row.stop);
      const result = parseFloat(row.result);
      let rVal = 0;

      // If we have entry + stop, compute risk and derive R
      if (!isNaN(entry) && !isNaN(stop) && entry > 0 && stop > 0) {
        const risk = Math.abs(entry - stop) / entry; // risk as fraction
        if (risk > 0 && !isNaN(result)) {
          rVal = (result / 100) / risk; // result is % return, risk is fraction
        } else if (!isNaN(result)) {
          rVal = result / 1.5; // fallback: assume 1.5% avg risk
        }
      } else if (!isNaN(result)) {
        // No stop defined — estimate R from result assuming 1.5% risk
        rVal = result / 1.5;
      }

      // If still 0 and no result, assign defaults by status
      if (rVal === 0 && isNaN(result)) {
        if (['TP1', 'TP2', 'TP3'].includes(row.status)) rVal = 1.0;
        else if (row.status === 'SL') rVal = -1.0;
        else rVal = 0; // EXPIRED
      }

      dailyR.set(date, (dailyR.get(date) || 0) + rVal);
    }

    // Build continuous date range (fill gaps with 0)
    const sortedDates = Array.from(dailyR.keys()).sort();
    const firstDate = new Date(sortedDates[0]);
    const lastDate = new Date(sortedDates[sortedDates.length - 1]);
    const allDates = [];
    const cumR = [];
    let runningR = 0;

    for (let d = new Date(firstDate); d <= lastDate; d.setDate(d.getDate() + 1)) {
      const ds = d.toISOString().slice(0, 10);
      allDates.push(ds);
      runningR += dailyR.get(ds) || 0;
      cumR.push(+runningR.toFixed(2));
    }

    // ── 3. Fetch BTC/ETH benchmark data ──────────────────────
    const daySpan = Math.min(allDates.length + 10, MAX_DAYS);
    const benchmarks = await getBenchmarkCloses(daySpan);
    const btcIndexed = indexToReturn(benchmarks.btcCloses, allDates);
    const ethIndexed = indexToReturn(benchmarks.ethCloses, allDates);

    // ── 4. Build response ────────────────────────────────────
    const response = {
      dates: allDates,
      cumR,
      btcIndexed,
      ethIndexed,
      source: benchmarks.source,
      count: rows.length,
      range: {
        from: allDates[0],
        to: allDates[allDates.length - 1],
        days: allDates.length,
      },
    };

    // Cache it
    cache = { data: response, ts: Date.now() };

    res.json(response);
  } catch (err) {
    console.error("[equity-curve] Error:", err.message);
    res.status(500).json({ error: "Failed to build equity curve", detail: err.message });
  }
}

module.exports = equityCurveHandler;

// ── Standalone router variant (if mounting separately) ────────
// Usage in index.js:
//   app.get("/api/v1/proof/equity-curve", require("./routes/equity-curve"));
//
// Or if you prefer a router:
//   const router = require("express").Router();
//   router.get("/equity-curve", require("./routes/equity-curve"));
//   module.exports = router;
