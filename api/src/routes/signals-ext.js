const { Router } = require("express");
const db = require("../lib/db");
const { requireAuth } = require("../middleware/auth");
const { attachPlan, requirePlan } = require("../middleware/subscription");
const Signal = require("../models/signal");
const events = require("../lib/events");

const router = Router();

// ─────────────────────────────────────────────────────────────────
// POST /signals/:id/cancel
// ─────────────────────────────────────────────────────────────────
router.post("/:id/cancel", requireAuth, requirePlan("pro"), async (req, res) => {
  try {
    const signalId = parseInt(req.params.id);
    if (isNaN(signalId)) {
      return res.status(400).json({ error: "Invalid signal ID" });
    }

    const r = await db.query("SELECT * FROM signals_v2 WHERE id = $1", [signalId]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Signal not found" });

    const row = r.rows[0];
    if (row.bot_user_id !== req.userId) {
      return res.status(403).json({ error: "Not your signal" });
    }
    if (row.status !== "OPEN") {
      return res.status(409).json({ error: "Signal already resolved", currentStatus: row.status });
    }

    const updated = await db.query(
      `UPDATE signals_v2
       SET status = 'CANCELLED', resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [signalId]
    );

    const signal = Signal.fromDbRow(updated.rows[0]);

    await events.logEvent(signalId, "CANCELLED", {
      oldStatus: "OPEN", newStatus: "CANCELLED", priceAt: signal.entry,
      meta: { cancelled_by: "user", bot_user_id: req.userId, ip: req.ip,
              timestamp: new Date().toISOString() },
    });

    res.json(signal);
  } catch (err) {
    console.error("[signals/cancel]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals/user/stats — server-side plan gated
// ─────────────────────────────────────────────────────────────────
router.get("/user/stats", requireAuth, attachPlan, async (req, res) => {
  try {
    const uid = req.userId;
    const tier = req.planTier || "free";

    const totalR = await db.query("SELECT COUNT(*) AS cnt FROM signals_v2 WHERE bot_user_id = $1", [uid]);
    const openR = await db.query("SELECT COUNT(*) AS cnt FROM signals_v2 WHERE bot_user_id = $1 AND status = 'OPEN'", [uid]);
    const winsR = await db.query(
      `SELECT COUNT(*) FILTER (WHERE status IN ('TP1','TP2','TP3')) AS wins,
              COUNT(*) FILTER (WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED')) AS total
       FROM signals_v2 WHERE bot_user_id = $1`, [uid]
    );

    const wins = parseInt(winsR.rows[0]?.wins || 0);
    const totalResolved = parseInt(winsR.rows[0]?.total || 0);

    const base = {
      total: parseInt(totalR.rows[0]?.cnt || 0),
      open: parseInt(openR.rows[0]?.cnt || 0),
      wins, totalResolved,
      winRate: totalResolved > 0 ? (wins / totalResolved) : null,
    };

    if (tier === "free") {
      return res.json({ ...base, breakdown: [], best: null, worst: null, monthly: [] });
    }

    const resolvedR = await db.query(
      `SELECT status, COUNT(*) AS cnt, AVG(result) AS avg_pnl, AVG(duration_sec) AS avg_duration
       FROM signals_v2 WHERE bot_user_id = $1 AND status NOT IN ('OPEN','CANCELLED')
       GROUP BY status`, [uid]
    );
    const bestR = await db.query(
      `SELECT symbol, direction, result, status, created_at FROM signals_v2
       WHERE bot_user_id = $1 AND result IS NOT NULL ORDER BY result DESC LIMIT 1`, [uid]
    );
    const worstR = await db.query(
      `SELECT symbol, direction, result, status, created_at FROM signals_v2
       WHERE bot_user_id = $1 AND result IS NOT NULL ORDER BY result ASC LIMIT 1`, [uid]
    );
    const monthlyR = await db.query(
      `SELECT TO_CHAR(created_at, 'YYYY-MM') AS month, COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status IN ('TP1','TP2','TP3')) AS wins,
              COUNT(*) FILTER (WHERE status = 'SL') AS losses,
              AVG(result) FILTER (WHERE result IS NOT NULL) AS avg_pnl
       FROM signals_v2 WHERE bot_user_id = $1 AND created_at > NOW() - INTERVAL '6 months'
       GROUP BY month ORDER BY month DESC`, [uid]
    );

    res.json({
      ...base,
      breakdown: resolvedR.rows.map((r) => ({
        status: r.status, count: parseInt(r.cnt),
        avgPnl: r.avg_pnl ? parseFloat(r.avg_pnl) : null,
        avgDuration: r.avg_duration ? parseInt(r.avg_duration) : null,
      })),
      best: bestR.rows[0] || null,
      worst: worstR.rows[0] || null,
      monthly: monthlyR.rows.map((r) => ({
        month: r.month, total: parseInt(r.total), wins: parseInt(r.wins),
        losses: parseInt(r.losses), avgPnl: r.avg_pnl ? parseFloat(r.avg_pnl) : null,
      })),
    });
  } catch (err) {
    console.error("[signals/user/stats]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});


// ─────────────────────────────────────────────────────────────────
// POST /signals/track — direct insert from scanner UI (bypasses parser)
// ─────────────────────────────────────────────────────────────────
router.post("/track", requireAuth, requirePlan("pro"), async (req, res) => {
  try {
    const { symbol, direction, entry, sl, targets, ai_score, exchange, meta } = req.body;

    if (!symbol || !direction) {
      return res.status(400).json({ error: "Missing required fields: symbol, direction" });
    }

    // Use Signal model for normalization + validation — same as /submit
    const signal = Signal.normalize({
      symbol,
      direction,
      entry: entry || null,
      stop: sl || null,
      targets: Array.isArray(targets) ? targets : [],
      confidence: ai_score || null,
      type: "manual",
      source: "scanner",
      provider: "scanner",
      bot_user_id: req.userId,
      status: "OPEN",
      meta: Object.assign({}, meta || {}, {
        exchange: exchange || null,
        tracked_from: "scanner_ui",
      }),
    });

    const check = Signal.validate(signal);
    if (!check.valid) {
      return res.status(422).json({ error: "Invalid signal", details: check.errors });
    }

    // Dedupe: reject if user already has an OPEN signal for this symbol
    const existing = await db.query(
      `SELECT id, direction, created_at FROM signals_v2
       WHERE bot_user_id = $1 AND symbol = $2 AND status = 'OPEN'
       LIMIT 1`,
      [req.userId, signal.symbol]
    );
    if (existing.rows.length > 0) {
      const ex = existing.rows[0];
      return res.status(409).json({
        error: "Already tracking " + signal.symbol,
        existing_id: ex.id,
        direction: ex.direction,
        created_at: ex.created_at,
      });
    }

    const row = Signal.toDbRow(signal);

    const result = await db.query(
      `INSERT INTO signals_v2
        (symbol, type, direction, entry, stop, targets, leverage,
         confidence, provider, provider_id, source, bot_user_id,
         status, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [row.symbol, row.type, row.direction, row.entry, row.stop,
       row.targets, row.leverage, row.confidence, row.provider,
       row.provider_id, row.source, row.bot_user_id, row.status, row.meta]
    );

    const saved = Signal.fromDbRow(result.rows[0]);

    await events.logEvent(saved.id, "CREATED", {
      newStatus: "OPEN",
      priceAt: saved.entry,
      meta: { source: "scanner_track", bot_user_id: req.userId },
    });

    res.json({ ok: true, id: saved.id, symbol: saved.symbol, direction: saved.direction });
  } catch (err) {
    console.error("[signals/track]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
