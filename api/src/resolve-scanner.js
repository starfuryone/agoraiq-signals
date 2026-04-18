/**
 * resolve-scanner.js — Resolves open scanner signals against current prices
 * 
 * Run via cron every 5 minutes:
 *   */5 * * * * cd /opt/agoraiq-signals/api && node src/resolve-scanner.js >> /var/log/agoraiq/resolve-scanner.log 2>&1
 * 
 * Or as a systemd timer (recommended):
 *   See DEPLOY.md for systemd unit files
 * 
 * Logic:
 *   For each open scanner_signal:
 *     1. Fetch current price from scanner_cache (already populated by worker)
 *     2. If price >= tp_price (long) or <= tp_price (short) → tp_hit
 *     3. If price <= sl_price (long) or >= sl_price (short) → sl_hit
 *     4. If detected_at + window_minutes passed → timeout
 *     5. Calculate PnL, peak/trough excursion, duration
 */

require("dotenv").config({ path: "/opt/agoraiq-signals/api/.env", override: true });
const { Pool } = require("pg");

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL environment variable is required");
  process.exit(1);
}
const pool = new Pool({ connectionString: DB_URL, max: 2 });

async function resolve() {
  const t0 = Date.now();

  // 1. Get all open signals
  const openSigs = await pool.query(`
    SELECT id, symbol, exchange, entry_price, bias, tp_price, sl_price, 
           window_minutes, detected_at, score
    FROM scanner_signals 
    WHERE status = 'open'
    ORDER BY detected_at ASC
  `);

  if (!openSigs.rows.length) {
    console.log(`[resolve] no open signals`);
    await pool.end();
    return;
  }

  console.log(`[resolve] checking ${openSigs.rows.length} open signals`);

  // 2. Get latest prices from scanner_cache
  const cacheRow = await pool.query(
    "SELECT data FROM scanner_cache WHERE category = 'live'"
  );
  
  if (!cacheRow.rows.length || !cacheRow.rows[0].data) {
    console.log("[resolve] no cached data — scanner worker might not be running");
    await pool.end();
    return;
  }

  const cached = cacheRow.rows[0].data;
  const items = cached.items || [];
  const priceMap = {};
  items.forEach(item => {
    priceMap[`${item.symbol}:${item.exchange}`] = item.price;
    priceMap[item.symbol] = item.price; // fallback by symbol only
  });

  let resolved = 0, tpHits = 0, slHits = 0, timeouts = 0;

  for (const sig of openSigs.rows) {
    const currentPrice = priceMap[`${sig.symbol}:${sig.exchange}`] || priceMap[sig.symbol];
    if (!currentPrice) continue;

    const entry = parseFloat(sig.entry_price);
    const tp = sig.tp_price ? parseFloat(sig.tp_price) : null;
    const sl = sig.sl_price ? parseFloat(sig.sl_price) : null;
    const bias = sig.bias || "long";
    const windowMin = sig.window_minutes || 60;
    const detectedAt = new Date(sig.detected_at);
    const now = new Date();
    const elapsed = (now - detectedAt) / 1000; // seconds
    const elapsedMin = elapsed / 60;

    let outcome = null;
    let exitPrice = currentPrice;

    // Check TP
    if (tp) {
      if (bias === "long" && currentPrice >= tp) { outcome = "tp_hit"; }
      else if (bias === "short" && currentPrice <= tp) { outcome = "tp_hit"; }
    }

    // Check SL
    if (!outcome && sl) {
      if (bias === "long" && currentPrice <= sl) { outcome = "sl_hit"; }
      else if (bias === "short" && currentPrice >= sl) { outcome = "sl_hit"; }
    }

    // Check timeout
    if (!outcome && elapsedMin > windowMin * 4) {
      // Give 4x the window before timing out
      outcome = "timeout";
    }

    if (!outcome) continue; // Still open

    // Calculate PnL
    let pnl;
    if (bias === "short") {
      pnl = ((entry - exitPrice) / entry) * 100;
    } else {
      pnl = ((exitPrice - entry) / entry) * 100;
    }

    // Peak/trough estimation (we don't have candle data, approximate from PnL)
    const peak = outcome === "tp_hit" ? Math.abs(pnl) : Math.max(0, pnl);
    const trough = outcome === "sl_hit" ? pnl : Math.min(0, pnl);

    await pool.query(`
      UPDATE scanner_signals SET
        status = 'resolved',
        outcome = $1,
        exit_price = $2,
        pnl_pct = $3,
        peak_pct = $4,
        trough_pct = $5,
        duration_sec = $6,
        resolved_at = NOW()
      WHERE id = $7
    `, [outcome, exitPrice, Math.round(pnl * 100) / 100, Math.round(peak * 100) / 100, Math.round(trough * 100) / 100, Math.round(elapsed), sig.id]);

    resolved++;
    if (outcome === "tp_hit") tpHits++;
    else if (outcome === "sl_hit") slHits++;
    else timeouts++;
  }

  console.log(`[resolve] done: ${resolved} resolved (${tpHits} TP, ${slHits} SL, ${timeouts} timeout), ${Date.now() - t0}ms`);
  await pool.end();
}

resolve().catch(e => {
  console.error("[resolve] fatal:", e);
  pool.end().then(() => process.exit(1));
});
