const { Router } = require("express");
const db = require("../lib/db");
const Signal = require("../models/signal");

const router = Router();

// Helper to query signals_v2, falling back to legacy tables
async function querySignals(sql, params) {
  try {
    return await db.query(sql, params);
  } catch {
    // signals_v2 might not exist yet — try legacy
    const legacy = sql
      .replace(/signals_v2/g, "user_signals")
      .replace(/direction/g, "action")
      .replace(/entry/g, "price")
      .replace(/stop(?!\w)/g, "stop_loss")
      .replace(/result/g, "pnl");
    return await db.query(legacy, params);
  }
}

// ── GET /proof/stats ──────────────────────────────────────────────
router.get("/stats", async (req, res) => {
  try {
    const r = await querySignals(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status LIKE 'TP%')::int AS wins,
        COUNT(*) FILTER (WHERE status = 'SL')::int AS losses,
        COUNT(*) FILTER (WHERE status LIKE 'TP%' OR status = 'SL')::int AS decided,
        ROUND(AVG(CASE WHEN result IS NOT NULL THEN result END)::numeric, 4) AS avg_result,
        ROUND(AVG(CASE WHEN duration_sec IS NOT NULL THEN duration_sec END))::int AS avg_duration_sec
      FROM signals_v2
      WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED')
    `);
    const s = r.rows[0];
    const winRate = s.decided > 0 ? Math.round((s.wins / s.decided) * 10000) / 10000 : 0;

    res.json({
      totalSignals: s.total,
      wins: s.wins,
      losses: s.losses,
      winRate,
      avgResult: s.avg_result ? parseFloat(s.avg_result) : null,
      avgDurationSec: s.avg_duration_sec,
    });
  } catch (err) {
    console.error("[proof/stats]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET /proof/monthly ────────────────────────────────────────────
router.get("/monthly", async (req, res) => {
  try {
    const r = await querySignals(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', resolved_at), 'YYYY-MM') AS month,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status LIKE 'TP%')::int AS wins,
        COUNT(*) FILTER (WHERE status LIKE 'TP%' OR status = 'SL')::int AS decided,
        ROUND(AVG(result)::numeric, 4) AS avg_result
      FROM signals_v2
      WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED') AND resolved_at IS NOT NULL
      GROUP BY DATE_TRUNC('month', resolved_at)
      ORDER BY DATE_TRUNC('month', resolved_at) DESC
      LIMIT 12
    `);

    const months = r.rows.map((row) => ({
      month: row.month,
      total: row.total,
      wins: row.wins,
      winRate: row.decided > 0 ? Math.round((row.wins / row.decided) * 10000) / 10000 : 0,
      avgResult: row.avg_result ? parseFloat(row.avg_result) : null,
    }));

    res.json({ months });
  } catch (err) {
    console.error("[proof/monthly]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET /proof/recent?limit=10 ───────────────────────────────────
router.get("/recent", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const r = await querySignals(
      `SELECT * FROM signals_v2
       WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED','OPEN')
       ORDER BY COALESCE(resolved_at, created_at) DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ signals: r.rows.map(Signal.fromDbRow) });
  } catch (err) {
    console.error("[proof/recent]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
