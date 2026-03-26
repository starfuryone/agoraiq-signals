const { Router } = require("express");
const db = require("../lib/db");
const { requireAuth } = require("../middleware/auth");

const router = Router();

// ─────────────────────────────────────────────────────────────────
// GET /providers?limit=10 — provider leaderboard
// ─────────────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    // Try joining with provider_stats_snapshot if it exists
    let rows;
    try {
      const r = await db.query(
        `SELECT
           p.id, p.name,
           COALESCE(p.channel, '') AS channel,
           COALESCE(p.platform, 'telegram') AS platform,
           COALESCE(p.active, true) AS active,
           ps.win_rate,
           COALESCE(ps.total_signals, ps.trade_count, 0) AS total_signals,
           COALESCE(ps.avg_rr, ps.expectancy_r) AS avg_rr,
           COALESCE(ps.trust_score, ps.win_rate) AS trust_score,
           ps.profit_factor, ps.expectancy_r, ps.max_drawdown_pct
         FROM providers p
         LEFT JOIN provider_stats_snapshot ps ON ps.provider_id::text = p.id::text
         ORDER BY COALESCE(ps.trust_score, ps.win_rate, 0) DESC
         LIMIT $1`,
        [limit]
      );
      rows = r.rows;
    } catch {
      // Simpler query if provider_stats_snapshot doesn't exist
      const r = await db.query(
        `SELECT id, name,
           COALESCE(channel, '') AS channel,
           COALESCE(platform, 'telegram') AS platform
         FROM providers
         ORDER BY id LIMIT $1`,
        [limit]
      );
      rows = r.rows;
    }

    const providers = rows.map(formatProvider);
    res.json({ providers });
  } catch (err) {
    console.error("[providers]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /providers/top — top 5 by trust score
// MUST be before /:id
// ─────────────────────────────────────────────────────────────────
router.get("/top", async (req, res) => {
  try {
    let rows;
    try {
      const r = await db.query(
        `SELECT
           p.id, p.name,
           COALESCE(p.channel, '') AS channel,
           COALESCE(p.platform, 'telegram') AS platform,
           ps.win_rate,
           COALESCE(ps.total_signals, ps.trade_count, 0) AS total_signals,
           COALESCE(ps.avg_rr, ps.expectancy_r) AS avg_rr,
           COALESCE(ps.trust_score, ps.win_rate) AS trust_score,
           ps.profit_factor, ps.expectancy_r
         FROM providers p
         JOIN provider_stats_snapshot ps ON ps.provider_id::text = p.id::text
         WHERE COALESCE(ps.trade_count, ps.total_signals, 0) >= 5
         ORDER BY COALESCE(ps.trust_score, ps.win_rate, 0) DESC
         LIMIT 5`
      );
      rows = r.rows;
    } catch {
      const r = await db.query(
        `SELECT id, name, COALESCE(channel, '') AS channel FROM providers ORDER BY id LIMIT 5`
      );
      rows = r.rows;
    }

    res.json({ providers: rows.map(formatProvider) });
  } catch (err) {
    console.error("[providers/top]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /providers/following — providers the user follows
// MUST be before /:id
// ─────────────────────────────────────────────────────────────────
router.get("/following", requireAuth, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.id, p.name, COALESCE(p.channel, '') AS channel, COALESCE(p.platform, 'telegram') AS platform
       FROM providers p
       JOIN bot_user_provider_follows f ON f.provider_id = p.id
       WHERE f.bot_user_id = $1
       ORDER BY f.created_at DESC`,
      [req.userId]
    );
    res.json({ providers: result.rows.map(formatProvider) });
  } catch (err) {
    console.error("[providers/following]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// GET /providers/:id — single provider detail
// ─────────────────────────────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const providerId = req.params.id;

    // Support lookup by name or by numeric ID
    let rows;
    if (/^\d+$/.test(providerId)) {
      const r = await db.query("SELECT *, COALESCE(channel, '') AS channel_resolved FROM providers WHERE id = $1", [providerId]);
      rows = r.rows;
    } else {
      const r = await db.query(
        "SELECT *, COALESCE(channel, '') AS channel_resolved FROM providers WHERE LOWER(name) = LOWER($1) OR LOWER(COALESCE(channel, '')) LIKE $2",
        [providerId, `%${providerId.toLowerCase()}%`]
      );
      rows = r.rows;
    }

    if (rows.length === 0) {
      return res.status(404).json({ error: "Provider not found" });
    }

    const provider = rows[0];

    // Get stats if available
    let stats = {};
    try {
      const s = await db.query(
        `SELECT win_rate, total_signals, avg_rr, trust_score
         FROM provider_stats_snapshot WHERE provider_id = $1
         ORDER BY snapshot_date DESC LIMIT 1`,
        [provider.id]
      );
      if (s.rows.length > 0) stats = s.rows[0];
    } catch {
      // Stats table might not exist
    }

    res.json({
      id: provider.id,
      name: provider.name,
      channel: provider.channel_resolved || provider.channel || provider.chain || null,
      platform: provider.platform,
      winRate: stats.win_rate ? parseFloat(stats.win_rate) : null,
      totalSignals: stats.total_signals || 0,
      avgRR: stats.avg_rr ? parseFloat(stats.avg_rr) : null,
      trustScore: stats.trust_score ? parseFloat(stats.trust_score) : null,
    });
  } catch (err) {
    console.error("[providers/:id]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// POST /providers/:id/follow
// ─────────────────────────────────────────────────────────────────
router.post("/:id/follow", requireAuth, async (req, res) => {
  try {
    const providerId = await resolveProviderId(req.params.id);
    if (!providerId) {
      return res.status(404).json({ error: "Provider not found" });
    }

    await db.query(
      `INSERT INTO bot_user_provider_follows (bot_user_id, provider_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [req.userId, providerId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[providers/:id/follow]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ─────────────────────────────────────────────────────────────────
// DELETE /providers/:id/follow
// ─────────────────────────────────────────────────────────────────
router.delete("/:id/follow", requireAuth, async (req, res) => {
  try {
    const providerId = await resolveProviderId(req.params.id);
    if (!providerId) {
      return res.status(404).json({ error: "Provider not found" });
    }

    await db.query(
      `DELETE FROM bot_user_provider_follows WHERE bot_user_id = $1 AND provider_id = $2`,
      [req.userId, providerId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[providers/:id/follow]", err.message);
    res.status(500).json({ error: "Internal error" });
  }
});

// ── helpers ───────────────────────────────────────────────────────

async function resolveProviderId(idOrName) {
  if (/^\d+$/.test(idOrName)) {
    const r = await db.query("SELECT id FROM providers WHERE id = $1", [idOrName]);
    return r.rows.length > 0 ? r.rows[0].id : null;
  }
  const r = await db.query(
    "SELECT id FROM providers WHERE LOWER(name) = LOWER($1)",
    [idOrName]
  );
  return r.rows.length > 0 ? r.rows[0].id : null;
}

function formatProvider(row) {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel || null,
    platform: row.platform || 'telegram',
    winRate: row.win_rate ? parseFloat(row.win_rate) : null,
    totalSignals: parseInt(row.total_signals) || 0,
    avgRR: row.avg_rr ? parseFloat(row.avg_rr) : null,
    trustScore: row.trust_score ? parseFloat(row.trust_score) : null,
    profitFactor: row.profit_factor ? parseFloat(row.profit_factor) : null,
    expectancyR: row.expectancy_r ? parseFloat(row.expectancy_r) : null,
    maxDrawdown: row.max_drawdown_pct ? parseFloat(row.max_drawdown_pct) : null,
  };
}

module.exports = router;
