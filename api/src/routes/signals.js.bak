const { Router } = require("express");
const db = require("../lib/db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { attachPlan } = require("../middleware/subscription");
const { parseSignal } = require("../lib/parser");
const { fetchPrice } = require("../lib/price");
const ai = require("../lib/ai");
const Signal = require("../models/signal");
const events = require("../lib/events");

let _pushQueue = null;
function getPushQueue() {
  if (!_pushQueue) {
    try { _pushQueue = require("../workers/queues").pushQueue(); } catch {}
  }
  return _pushQueue;
}

const router = Router();

function requirePlan(...plans) {
  return async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT bs.plan_tier, bs.status, bs.expires_at
         FROM bot_subscriptions bs
         JOIN bot_users bu ON bu.id = bs.bot_user_id
         WHERE bu.id = $1`,
        [req.userId]
      );
      const sub = rows[0];
      if (!sub) return res.status(403).json({ error: 'No active subscription' });
      const plan = sub.plan_tier;
      const active = sub.status === 'active' && (!sub.expires_at || new Date() < new Date(sub.expires_at));
      if (!active || !plans.includes(plan)) {
        return res.status(403).json({ error: `Requires ${plans.join(' or ')} plan` });
      }
      next();
    } catch (err) {
      res.status(500).json({ error: 'Plan check failed' });
    }
  };
}


const SIGNAL_LIMITS = { free: 20, pro: 50, elite: 50 };

// ─────────────────────────────────────────────────────────────────
// POST /signals/submit
// ─────────────────────────────────────────────────────────────────
router.post("/submit", requireAuth, async (req, res) => {
  try {
    const { raw_text } = req.body;
    if (!raw_text || typeof raw_text !== "string" || !raw_text.trim()) {
      return res.status(400).json({ error: "raw_text is required" });
    }

    const parsed = parseSignal(raw_text);
    if (parsed.parseStatus === "not_signal") {
      return res.status(422).json({
        error: "Could not parse signal",
        parse_status: parsed.parseStatus,
      });
    }

    const signal = Signal.normalize({
      symbol: parsed.symbol,
      direction: parsed.action,
      entry: parsed.price,
      stop: parsed.stopLoss,
      targets: parsed.targets,
      leverage: parsed.leverage,
      type: "manual",
      source: "user",
      bot_user_id: req.userId,
      status: "OPEN",
      raw_text: raw_text.trim(),
      parse_status: parsed.parseStatus,
    });

    const check = Signal.validate(signal);
    if (!check.valid) {
      return res.status(422).json({ error: "Invalid signal", details: check.errors });
    }

    // AI scoring (non-blocking — if AI fails, signal still saves with fallback)
    try {
      const aiResult = await ai.scoreSignal({
        symbol: signal.symbol,
        direction: signal.direction,
        entry: signal.entry,
        stop: signal.stop,
        targets: signal.targets,
        volume_change: signal.meta?.volume_change,
        oi_direction: signal.meta?.oi_direction,
        funding_rate: signal.meta?.funding_rate,
      });
      if (aiResult) {
        signal.confidence = aiResult.score;
        signal.meta.ai_score = aiResult.score;
        signal.meta.ai_regime = aiResult.regime;
        signal.meta.ai_risk_flags = aiResult.risk_flags;
        signal.meta.ai_reasoning = aiResult.reasoning;
        signal.meta.ai_model = aiResult.model;
      }
    } catch (err) {
      console.warn("[signals/submit] AI scoring failed:", err.message);
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
      meta: { source: saved.source, parse_status: parsed.parseStatus },
    });

    const q = getPushQueue();
    if (q && parsed.parseStatus === "parsed") {
      q.add("breakout", saved).catch(() => {});
    }

    res.status(201).json(saved);
  } catch (err) {
    console.error("[signals/submit]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals/user?limit=10
// ─────────────────────────────────────────────────────────────────
router.get("/user", requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const result = await db.query(
      `SELECT * FROM signals_v2 WHERE bot_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [req.userId, limit]
    );
    res.json({ signals: result.rows.map(Signal.fromDbRow) });
  } catch (err) {
    console.error("[signals/user]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals/history?limit=20
// ─────────────────────────────────────────────────────────────────
router.get("/history", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const result = await db.query(
      `SELECT * FROM signals_v2
       WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED')
       ORDER BY resolved_at DESC NULLS LAST
       LIMIT $1`,
      [limit]
    );
    res.json({ signals: result.rows.map(Signal.fromDbRow) });
  } catch (err) {
    console.error("[signals/history]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals/events?limit=20
// ─────────────────────────────────────────────────────────────────
router.get("/events", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const rows = await events.getRecentEvents(limit);
    res.json({ events: rows });
  } catch (err) {
    console.error("[signals/events]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals/:id
// ─────────────────────────────────────────────────────────────────
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      "SELECT * FROM signals_v2 WHERE id = $1", [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Signal not found" });
    }

    const row = result.rows[0];
    if (row.bot_user_id && row.bot_user_id !== req.userId) {
      return res.status(403).json({ error: "Not your signal" });
    }

    const signal = Signal.fromDbRow(row);

    if (signal.status === "OPEN" && signal.symbol) {
      const current = await fetchPrice(signal.symbol);
      if (current !== null) {
        signal.current_price = current;
        if (signal.entry) {
          signal.unrealized_pnl =
            signal.direction === "LONG"
              ? (current - signal.entry) / signal.entry
              : (signal.entry - current) / signal.entry;
        }
      }
    }

    res.json(signal);
  } catch (err) {
    console.error("[signals/:id]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals/:id/events
// ─────────────────────────────────────────────────────────────────
router.get("/:id/events", requireAuth, async (req, res) => {
  try {
    const evts = await events.getEvents(parseInt(req.params.id));
    res.json({ events: evts });
  } catch (err) {
    console.error("[signals/:id/events]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals?limit=10 — public feed, plan-gated
// ─────────────────────────────────────────────────────────────────
router.get("/", optionalAuth, attachPlan, async (req, res) => {
  try {
    const tier = req.planTier || "free";
    const maxPerRequest = SIGNAL_LIMITS[tier] || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, maxPerRequest);

    const result = await db.query(
      `SELECT * FROM signals_v2 ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );

    const signals = result.rows.map((row) => {
      const s = Signal.fromDbRow(row);
      if (tier === "free") {
        s.entry = null;
        s.targets = [];
        s.stop = null;
        s.leverage = null;
        s.confidence = null;
        s.result = null;
        s.meta = {};
      }
      return s;
    });

    const resp = { signals, tier };
    if (tier === "free" && result.rowCount > limit) {
      resp.upgrade = {
        message: "Free plan shows 1 recent signal preview. Upgrade for real-time access.",
        url: "/pricing.html",
      };
    }

    res.json(resp);
  } catch (err) {
    console.error("[signals]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});


// ── POST /api/v1/signals/format ──────────────────────────────────
// Parse a raw signal text without tracking it. Pro + Elite only.
router.post('/format', requireAuth, async (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });

  try {
    const parsed = parseSignal(text);
    if (parsed && parsed.symbol) return res.json(parsed);
    return res.status(422).json({ error: 'could not parse signal' });
  } catch (err) {
    console.error('[signals/format]', err.message);
    res.status(500).json({ error: 'parse failed' });
  }
});

module.exports = router;
