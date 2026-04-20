const { Router } = require("express");
const db = require("../lib/db");
const { requireAuth } = require("../middleware/auth");

const router = Router();
router.use(requireAuth);

const MAX_ALERTS_PER_USER = 50;
const SYMBOL_RE = /^[A-Z0-9]{3,20}$/;

function toRule(row) {
  return {
    id: row.id,
    name: row.name || `${row.symbol} breakout`,
    enabled: row.enabled,
    symbol: row.symbol,
    conditions: { symbol: row.symbol, ...(row.conditions || {}) },
    last_fired_at: row.last_fired_at,
    created_at: row.created_at,
  };
}

// GET /alerts — list current user's alert rules
router.get("/", async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id, symbol, name, conditions, enabled, last_fired_at, created_at
         FROM bot_alert_rules
        WHERE bot_user_id = $1
        ORDER BY created_at DESC`,
      [req.userId]
    );
    res.json({ rules: r.rows.map(toRule) });
  } catch (err) {
    console.error("[alerts:list]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /alerts — create an alert rule
// body: { symbol, name?, conditions? }
router.post("/", async (req, res) => {
  try {
    const symbol = String(req.body?.symbol || "").toUpperCase().trim();
    if (!SYMBOL_RE.test(symbol)) {
      return res.status(400).json({ error: "Invalid symbol" });
    }

    const count = await db.query(
      "SELECT COUNT(*)::int AS n FROM bot_alert_rules WHERE bot_user_id = $1",
      [req.userId]
    );
    if (count.rows[0].n >= MAX_ALERTS_PER_USER) {
      return res.status(400).json({ error: `Limit of ${MAX_ALERTS_PER_USER} alerts reached` });
    }

    const name = req.body?.name ? String(req.body.name).slice(0, 80) : null;
    const conditions = req.body?.conditions && typeof req.body.conditions === "object"
      ? req.body.conditions : {};

    const r = await db.query(
      `INSERT INTO bot_alert_rules (bot_user_id, symbol, name, conditions, enabled)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (bot_user_id, symbol)
         DO UPDATE SET enabled = TRUE,
                       name = COALESCE(EXCLUDED.name, bot_alert_rules.name),
                       conditions = EXCLUDED.conditions
       RETURNING id, symbol, name, conditions, enabled, last_fired_at, created_at`,
      [req.userId, symbol, name, conditions]
    );
    res.status(201).json({ rule: toRule(r.rows[0]) });
  } catch (err) {
    console.error("[alerts:create]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// DELETE /alerts/:id — delete an alert rule
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid id" });

    const r = await db.query(
      "DELETE FROM bot_alert_rules WHERE id = $1 AND bot_user_id = $2 RETURNING id",
      [id, req.userId]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: "Alert not found" });
    res.json({ deleted: r.rows[0].id });
  } catch (err) {
    console.error("[alerts:delete]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /alerts/pause-all — disable every rule for the user
router.post("/pause-all", async (req, res) => {
  try {
    const r = await db.query(
      "UPDATE bot_alert_rules SET enabled = FALSE WHERE bot_user_id = $1 AND enabled = TRUE RETURNING id",
      [req.userId]
    );
    res.json({ paused: r.rowCount });
  } catch (err) {
    console.error("[alerts:pause-all]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// POST /alerts/resume-all — re-enable every rule for the user
router.post("/resume-all", async (req, res) => {
  try {
    const r = await db.query(
      "UPDATE bot_alert_rules SET enabled = TRUE WHERE bot_user_id = $1 AND enabled = FALSE RETURNING id",
      [req.userId]
    );
    res.json({ resumed: r.rowCount });
  } catch (err) {
    console.error("[alerts:resume-all]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
