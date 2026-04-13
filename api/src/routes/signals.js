const crypto = require("crypto");
const { Router } = require("express");
const db = require("../lib/db");
const { requireAuth, optionalAuth } = require("../middleware/auth");
const { attachPlan } = require("../middleware/subscription");
const { parseSignal } = require("../lib/parser");
const { fetchPrice, fetchAllPrices } = require("../lib/price");
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

// ── Helpers ───────────────────────────────────────────────────────

function parseId(raw) {
  const n = parseInt(raw, 10);
  return (Number.isFinite(n) && n > 0) ? n : null;
}

/** SHA-256 dedupe fingerprint from normalized signal fields. */
function dedupeKey(signal) {
  const parts = [
    signal.symbol,
    signal.direction,
    signal.entry,
    signal.stop,
    (signal.targets || []).join(","),
  ].join("|");
  return crypto.createHash("sha256").update(parts).digest("hex").slice(0, 16);
}

const DEDUPE_WINDOW_SEC = 300;

const PUBLIC_SOURCES = ['scanner', 'provider'];

/** Strip event payload to safe public fields. */
function toSafeEvent(e) {
  const data = e.data || e;
  return {
    id: e.id,
    signal_id: e.signal_id,
    event_type: e.event_type,
    created_at: e.created_at,
    data: {
      newStatus: data.newStatus || null,
      oldStatus: data.oldStatus || null,
    },
  };
}

// ── requirePlan ───────────────────────────────────────────────────

function requirePlan(...plans) {
  return async (req, res, next) => {
    try {
      const { rows } = await db.query(
        `SELECT bs.plan_tier, bs.status, bs.expires_at
         FROM bot_subscriptions bs
         JOIN bot_users bu ON bu.id = bs.bot_user_id
         WHERE bu.id = $1
         ORDER BY
           CASE WHEN bs.status = 'active' THEN 0 ELSE 1 END,
           bs.expires_at DESC NULLS LAST,
           bs.created_at DESC
         LIMIT 1`,
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

    // Auto-generate TP/SL if missing but entry exists
    if (signal.entry && signal.entry > 0) {
      const e = signal.entry;
      const risk = e * 0.03; // 3% default risk
      if (!signal.stop) {
        signal.stop = signal.direction === "LONG"
          ? +(e - risk).toPrecision(6)
          : +(e + risk).toPrecision(6);
        signal.meta.auto_sl = true;
      }
      if (!signal.targets || signal.targets.length === 0) {
        signal.targets = signal.direction === "LONG"
          ? [+(e + risk * 1.5).toPrecision(6), +(e + risk * 3).toPrecision(6)]
          : [+(e - risk * 1.5).toPrecision(6), +(e - risk * 3).toPrecision(6)];
        signal.meta.auto_tp = true;
      }
    }

    const check = Signal.validate(signal);
    if (!check.valid) {
      return res.status(422).json({ error: "Invalid signal", details: check.errors });
    }

    // Dedupe (parameterized interval, SHA-256 key)
    const dkey = dedupeKey(signal);
    signal.meta.dedupe_key = dkey;
    try {
      const dup = await db.query(
        `SELECT id FROM signals_v2
         WHERE bot_user_id = $1
           AND meta->>'dedupe_key' = $2
           AND created_at > NOW() - ($3 * INTERVAL '1 second')
         LIMIT 1`,
        [req.userId, dkey, DEDUPE_WINDOW_SEC]
      );
      if (dup.rows.length > 0) {
        return res.status(409).json({
          error: "Duplicate signal",
          existing_id: dup.rows[0].id,
          window_sec: DEDUPE_WINDOW_SEC,
        });
      }
    } catch (err) {
      console.warn("[signals/submit] Dedupe check failed:", err.message);
    }

    // AI scoring (inline — see note at bottom of file)
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
        signal.meta.ai_provider = aiResult.provider;
        if (aiResult.score_breakdown) signal.meta.ai_score_breakdown = aiResult.score_breakdown;
        if (aiResult.thesis) signal.meta.ai_thesis = aiResult.thesis;
        if (aiResult.tags && aiResult.tags.length) signal.meta.ai_tags = aiResult.tags;
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
      q.add("breakout", saved).catch((err) => {
        console.error(`[signals/submit] Push queue failed: signal_id=${saved.id} err=${err.message}`);
      });
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
router.get("/history", optionalAuth, attachPlan, async (req, res) => {
  try {
    const tier = req.planTier || "free";
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const result = await db.query(
      `SELECT * FROM signals_v2
       WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED')
         AND source = ANY($2)
       ORDER BY resolved_at DESC NULLS LAST
       LIMIT $1`,
      [limit, PUBLIC_SOURCES]
    );
    const signals = result.rows.map((row) => {
      const s = Signal.fromDbRow(row);
      if (tier === "free") return Signal.toResolvedView(s);
      return s;
    });
    res.json({ signals });
  } catch (err) {
    console.error("[signals/history]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals/events?limit=20
// Authed. Default-deny: only events from known public sources.
// ─────────────────────────────────────────────────────────────────
router.get("/events", requireAuth, attachPlan, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const rows = await events.getRecentEvents(limit);

    // Default-deny: require known public source. Unknown = excluded.
    const safe = rows
      .filter((e) => e.signal_source && PUBLIC_SOURCES.includes(e.signal_source))
      .map(toSafeEvent);

    res.json({ events: safe });
  } catch (err) {
    console.error("[signals/events]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals/dashboard — aggregated dashboard data
// MUST be before /:id to avoid Express matching "dashboard" as an ID
// ─────────────────────────────────────────────────────────────────
router.get("/dashboard", optionalAuth, attachPlan, async (req, res) => {
  try {
    const tier = req.planTier || "free";

    const [weekR, todayR, recentR, weekPerfR, priceMap] = await Promise.all([
      db.query(`
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status LIKE 'TP%')::int AS wins,
          COUNT(*) FILTER (WHERE status = 'SL')::int AS losses,
          COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open
        FROM signals_v2
        WHERE created_at >= NOW() - INTERVAL '7 days' AND source = ANY($1)
      `, [PUBLIC_SOURCES]),
      db.query(`
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status LIKE 'TP%')::int AS wins,
          COUNT(*) FILTER (WHERE status LIKE 'TP%' OR status = 'SL')::int AS decided,
          ROUND(MAX(CASE WHEN result IS NOT NULL AND result > 0 THEN result END)::numeric, 2) AS best_win
        FROM signals_v2
        WHERE created_at >= CURRENT_DATE AND source = ANY($1)
      `, [PUBLIC_SOURCES]),
      db.query(`
        SELECT * FROM signals_v2 WHERE source = ANY($1)
        ORDER BY created_at DESC LIMIT 12
      `, [PUBLIC_SOURCES]),
      db.query(`
        SELECT ROUND(AVG(CASE WHEN result > 0 THEN result END)::numeric, 2) AS avg_win,
          ROUND(AVG(result)::numeric, 2) AS avg_return
        FROM signals_v2
        WHERE created_at >= NOW() - INTERVAL '7 days' AND result IS NOT NULL AND source = ANY($1)
      `, [PUBLIC_SOURCES]),
      fetchAllPrices().catch(() => ({})),
    ]);

    const week = weekR.rows[0];
    const today = todayR.rows[0];
    const weekPerf = weekPerfR.rows[0];
    const todayWinRate = today.decided > 0 ? Math.round((today.wins / today.decided) * 100) : null;

    const signals = recentR.rows.map(row => {
      const s = Signal.fromDbRow(row);
      const livePrice = priceMap[s.symbol] || null;
      let livePnl = null;
      if (s.entry && livePrice && s.status === "OPEN") {
        livePnl = s.direction === "LONG"
          ? ((livePrice - s.entry) / s.entry) * 100
          : ((s.entry - livePrice) / s.entry) * 100;
        livePnl = Math.round(livePnl * 100) / 100;
      }
      if (tier === "free") {
        return {
          id: s.id, symbol: s.symbol, direction: s.direction,
          status: s.status, result: s.result, confidence: s.confidence,
          provider: s.provider, source: s.source,
          created_at: s.created_at, resolved_at: s.resolved_at,
          entry: null, stop: null, targets: [],
          currentPrice: null, livePnl: null,
        };
      }
      return { ...s, currentPrice: livePrice, livePnl };
    });

    const visibleLimit = SIGNAL_LIMITS[tier] || 1;
    const hiddenCount = tier === "free" ? Math.max(0, week.total - Math.min(visibleLimit, week.total)) : 0;
    const hiddenWins = tier === "free" ? Math.max(0, week.wins - Math.min(Math.round(week.wins * visibleLimit / Math.max(week.total, 1)), week.wins)) : 0;

    res.json({
      tier,
      week: { total: week.total, wins: week.wins, losses: week.losses, open: week.open, hiddenCount, hiddenWins,
        avgWin: weekPerf.avg_win ? parseFloat(weekPerf.avg_win) : null,
        avgReturn: weekPerf.avg_return ? parseFloat(weekPerf.avg_return) : null },
      today: { total: today.total, wins: today.wins, winRate: todayWinRate,
        bestWin: today.best_win ? parseFloat(today.best_win) : null },
      signals,
    });
  } catch (err) {
    console.error("[signals/dashboard]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals/:id
// Owner: full view. Non-owner + public source: plan-gated.
// Non-owner + non-public source: 403.
// ─────────────────────────────────────────────────────────────────
router.get("/:id", optionalAuth, attachPlan, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid signal ID" });

    const result = await db.query(
      "SELECT * FROM signals_v2 WHERE id = $1", [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Signal not found" });
    }

    const row = result.rows[0];
    const isOwner = req.userId && row.bot_user_id && row.bot_user_id === req.userId;
    const tier = req.planTier || "free";
    const isPublicSource = PUBLIC_SOURCES.includes(row.source);

    // Private signal: owner only
    if (row.bot_user_id && !isOwner) {
      return res.status(403).json({ error: "Not your signal" });
    }

    // Ownerless but non-public source: deny to non-owners
    if (!row.bot_user_id && !isPublicSource) {
      return res.status(403).json({ error: "Signal not accessible" });
    }

    const signal = Signal.fromDbRow(row);

    // Free non-owners get public view
    if (!isOwner && tier === "free") {
      return res.json(Signal.toPublicView(signal));
    }

    // Live price for open signals
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
// Owner: raw events. Non-owner + public: sanitized events.
// Non-owner + private: 403.
// ─────────────────────────────────────────────────────────────────
router.get("/:id/events", requireAuth, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid signal ID" });

    const sigResult = await db.query(
      "SELECT id, bot_user_id, source FROM signals_v2 WHERE id = $1",
      [id]
    );
    if (sigResult.rows.length === 0) {
      return res.status(404).json({ error: "Signal not found" });
    }

    const sig = sigResult.rows[0];
    const isOwner = sig.bot_user_id && sig.bot_user_id === req.userId;

    // Private signals: owner only
    if (sig.bot_user_id && !isOwner) {
      return res.status(403).json({ error: "Not your signal" });
    }

    // Ownerless + non-public source: deny
    if (!sig.bot_user_id && !PUBLIC_SOURCES.includes(sig.source)) {
      return res.status(403).json({ error: "Signal not accessible" });
    }

    const evts = await events.getEvents(id);

    // Owner gets full events; non-owner gets sanitized
    if (isOwner) {
      res.json({ events: evts });
    } else {
      res.json({ events: evts.map(toSafeEvent) });
    }
  } catch (err) {
    console.error("[signals/:id/events]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /signals?limit=10 — public feed
// ─────────────────────────────────────────────────────────────────
router.get("/", optionalAuth, attachPlan, async (req, res) => {
  try {
    const tier = req.planTier || "free";
    const maxPerRequest = SIGNAL_LIMITS[tier] || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, maxPerRequest);

    const result = await db.query(
      `SELECT * FROM signals_v2
       WHERE source = ANY($2)
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit + 1, PUBLIC_SOURCES]
    );

    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);

    const signals = rows.map((row) => {
      const s = Signal.fromDbRow(row);
      if (tier === "free") return Signal.toPublicView(s);
      return s;
    });

    const resp = { signals, tier };
    if (tier === "free" && hasMore) {
      resp.upgrade = {
        message: "Free plan shows limited signal previews. Upgrade for full real-time access.",
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

/*
 * FUTURE IMPROVEMENTS (not MVP blockers):
 *
 * 1. Async AI scoring: save signal first, enqueue score job,
 *    update meta asynchronously. Current inline approach is
 *    acceptable at low volume since heuristic fallback is instant.
 *
 * 2. Cursor pagination: replace simple LIMIT with cursor-based
 *    pagination for growing feeds.
 */
