/**
 * AI routes — regime, narrative, re-scoring.
 *
 * GET  /ai/regime/:symbol     — market regime for a symbol
 * GET  /ai/narrative/:symbol  — narrative tags for a symbol
 * POST /ai/score              — score a raw signal (without saving)
 * POST /ai/rescore/:id        — re-score an existing signal with AI
 */

const { Router } = require("express");
const db = require("../lib/db");
const { requireAuth } = require("../middleware/auth");
const { requirePlan } = require("../middleware/subscription");
const ai = require("../lib/ai");
const Signal = require("../models/signal");

const router = Router();

// ── GET /ai/regime/:symbol ───────────────────────────────────────
// Elite only — market regime classification
router.get("/regime/:symbol", requireAuth, requirePlan("elite"), async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();

    // Pull latest scanner data for this symbol
    const cache = await db.query(
      "SELECT category, value, extra FROM scanner_cache WHERE symbol = $1",
      [symbol]
    );

    const data = { symbol };
    for (const row of cache.rows) {
      if (row.category === "momentum") {
        const ex = typeof row.extra === "string" ? JSON.parse(row.extra) : (row.extra || {});
        data.price_1h = ex.price_1h || 0;
        data.price_4h = ex.price_4h || 0;
        data.price_24h = ex.price_24h || 0;
      }
      if (row.category === "volume") data.volume_change = row.value || 0;
      if (row.category === "oi") data.oi_change = row.value || 0;
      if (row.category === "funding") data.funding_rate = row.value || 0;
    }

    const result = await ai.classifyRegime(data);
    res.json({ symbol, ...result });
  } catch (err) {
    console.error("[ai/regime]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── GET /ai/narrative/:symbol ────────────────────────────────────
// Elite only — narrative/whale/macro tagging
router.get("/narrative/:symbol", requireAuth, requirePlan("elite"), async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();

    // Could enrich with external news API later
    const result = await ai.tagNarrative({
      symbol,
      recent_news: null,
      social_volume: null,
      whale_activity: null,
    });

    res.json({ symbol, ...result });
  } catch (err) {
    console.error("[ai/narrative]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /ai/score ───────────────────────────────────────────────
// Pro+ — score a signal without saving it
router.post("/score", requireAuth, requirePlan("pro"), async (req, res) => {
  try {
    const { symbol, direction, entry, stop, targets, volume_change, oi_direction, funding_rate } = req.body;
    if (!symbol || !direction) {
      return res.status(400).json({ error: "symbol and direction required" });
    }

    const result = await ai.scoreSignal({
      symbol, direction, entry, stop, targets,
      volume_change, oi_direction, funding_rate,
    });

    res.json(result);
  } catch (err) {
    console.error("[ai/score]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── POST /ai/rescore/:id ─────────────────────────────────────────
// Elite only — re-score an existing signal with latest AI
router.post("/rescore/:id", requireAuth, requirePlan("elite"), async (req, res) => {
  try {
    const signalId = parseInt(req.params.id);
    if (isNaN(signalId)) return res.status(400).json({ error: "Invalid signal ID" });

    const r = await db.query("SELECT * FROM signals_v2 WHERE id = $1", [signalId]);
    if (r.rows.length === 0) return res.status(404).json({ error: "Signal not found" });

    const sig = Signal.fromDbRow(r.rows[0]);

    const result = await ai.scoreSignal({
      symbol: sig.symbol,
      direction: sig.direction,
      entry: sig.entry,
      stop: sig.stop,
      targets: sig.targets,
      volume_change: sig.meta?.volume_change,
      oi_direction: sig.meta?.oi_direction,
      funding_rate: sig.meta?.funding_rate,
    });

    // Update signal meta with new AI score
    const newMeta = {
      ...sig.meta,
      ai_score: result.score,
      ai_regime: result.regime,
      ai_risk_flags: result.risk_flags,
      ai_reasoning: result.reasoning,
      ai_model: result.model,
      ai_rescored_at: new Date().toISOString(),
    };

    await db.query(
      "UPDATE signals_v2 SET confidence = $1, meta = $2 WHERE id = $3",
      [result.score, JSON.stringify(newMeta), signalId]
    );

    res.json({ signal_id: signalId, ...result });
  } catch (err) {
    console.error("[ai/rescore]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

module.exports = router;
