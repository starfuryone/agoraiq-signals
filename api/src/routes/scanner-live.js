/**
 * scanner-live.js — Routes for /api/v1/scanner/live and /api/v1/scanner/performance
 * 
 * These read from the scanner_cache table populated by scanner-worker.js.
 * The API never fetches exchanges directly — it's a pure renderer of cached data.
 * 
 * Add to your Express app:
 *   app.use("/api/v1/scanner", require("./routes/scanner-live"));
 * 
 * Or merge into existing scanner.js
 */

const express = require("express");
const router = express.Router();
const db = require("../lib/db");
const { optionalAuth } = require("../middleware/auth");
const { attachPlan } = require("../middleware/subscription");

// GET /api/v1/scanner/live?category=top
// Returns cached scanner data from worker
router.get("/live", optionalAuth, attachPlan, async (req, res) => {
  try {
    const category = req.query.category || "live";
    const r = await db.query(
      "SELECT data, updated_at FROM scanner_cache WHERE category = $1",
      [category]
    );

    if (!r.rows.length || !r.rows[0].data) {
      return res.json([]);
    }

    const cached = r.rows[0].data;
    const updatedAt = r.rows[0].updated_at;

    // Check staleness — if > 30s old, data might be stale
    const age = Date.now() - new Date(updatedAt).getTime();
    const stale = age > 30000;

    // Tier gating: free users get top 5, pro gets 15, elite gets all
    const tier = req.planTier || "free";
    let items = cached.items || cached || [];
    if (tier === "free") items = items.slice(0, 5);
    else if (tier === "pro") items = items.slice(0, 15);
    // elite gets all

    res.json({
      tier,
      items,
      meta: cached.meta || {},
      stale,
      updatedAt
    });
  } catch (e) {
    console.error("[scanner/live]", e.message);
    res.status(500).json({ error: "Scanner cache unavailable" });
  }
});

// GET /api/v1/scanner/performance?symbol=BTCUSDT&pattern=breakout
// Returns REAL verified performance data from resolved scanner_signals
router.get("/performance", async (req, res) => {
  try {
    const { symbol, pattern, exchange, days } = req.query;
    const lookback = parseInt(days) || 30;
    
    let where = ["status = 'resolved'", `detected_at > NOW() - interval '${lookback} days'`];
    const params = [];
    let idx = 1;

    if (symbol) {
      where.push(`symbol = $${idx++}`);
      params.push(symbol);
    }
    if (exchange) {
      where.push(`exchange = $${idx++}`);
      params.push(exchange);
    }
    if (pattern) {
      where.push(`reasons @> $${idx++}::jsonb`);
      params.push(JSON.stringify([{ tag: pattern }]));
    }

    const sql = `
      SELECT 
        COUNT(*)::int AS total_signals,
        COUNT(*) FILTER (WHERE outcome = 'tp_hit')::int AS wins,
        COUNT(*) FILTER (WHERE outcome = 'sl_hit')::int AS losses,
        COUNT(*) FILTER (WHERE outcome = 'timeout')::int AS timeouts,
        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome = 'tp_hit') / NULLIF(COUNT(*), 0), 1) AS win_rate,
        ROUND(AVG(pnl_pct)::numeric, 2) AS avg_pnl,
        ROUND(AVG(pnl_pct) FILTER (WHERE outcome = 'tp_hit')::numeric, 2) AS avg_win,
        ROUND(AVG(pnl_pct) FILTER (WHERE outcome = 'sl_hit')::numeric, 2) AS avg_loss,
        ROUND(AVG(duration_sec)::numeric, 0) AS avg_duration_sec,
        ROUND(AVG(peak_pct)::numeric, 2) AS avg_peak,
        ROUND(AVG(score)::numeric, 0) AS avg_score,
        MAX(pnl_pct) AS best_trade,
        MIN(pnl_pct) AS worst_trade
      FROM scanner_signals
      WHERE ${where.join(" AND ")}
    `;

    const r = await db.query(sql, params);
    const stats = r.rows[0] || {};

    // If no resolved signals yet, say so honestly
    if (!stats.total_signals || stats.total_signals === 0) {
      return res.json({
        verified: false,
        message: "No resolved signals yet for this query. Performance data builds over time as signals are tracked and resolved.",
        total_signals: 0
      });
    }

    res.json({
      verified: true,
      ...stats,
      lookback_days: lookback,
      query: { symbol, pattern, exchange }
    });
  } catch (e) {
    console.error("[scanner/performance]", e.message);
    res.status(500).json({ error: "Performance query failed" });
  }
});

// GET /api/v1/scanner/signals?status=open&limit=50
// Returns tracked scanner signals (for lifecycle view)
router.get("/signals", optionalAuth, attachPlan, async (req, res) => {
  try {
    const status = req.query.status || "open";
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const symbol = req.query.symbol;

    let where = [`status = $1`];
    const params = [status];
    let idx = 2;

    if (symbol) {
      where.push(`symbol = $${idx++}`);
      params.push(symbol);
    }

    params.push(limit);
    const r = await db.query(`
      SELECT * FROM scanner_signals 
      WHERE ${where.join(" AND ")}
      ORDER BY detected_at DESC
      LIMIT $${idx}
    `, params);

    res.json({
      signals: r.rows,
      count: r.rows.length,
      status
    });
  } catch (e) {
    console.error("[scanner/signals]", e.message);
    res.status(500).json({ error: "Query failed" });
  }
});

module.exports = router;
