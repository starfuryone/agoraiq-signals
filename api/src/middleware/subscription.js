/**
 * Subscription enforcement middleware.
 * Reads from bot_subscriptions (standalone table).
 */

const db = require("../lib/db");

let _redis = null;
function getRedis() {
  if (!_redis) {
    try {
      const { getRedis: gr } = require("../lib/redis");
      _redis = gr();
    } catch {}
  }
  return _redis;
}

// No free tier. Trial gives pro-level access for 1 day. Stripe is source of truth for paid.
const TIER_RANK = { trial: 1, pro: 1, elite: 2 };
const CACHE_TTL = 300;

/**
 * Get user's effective plan tier (cached).
 * Honors active, cancel_at_period_end, past_due with 3-day grace.
 * Returns null if no active paid subscription.
 */
async function getUserTier(botUserId) {
  const cacheKey = `sub:${botUserId}`;
  const redis = getRedis();

  if (redis) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return cached === "null" ? null : cached;
    } catch {}
  }

  let tier = null;
  try {
    const r = await db.query(
      `SELECT plan_tier, status, expires_at FROM bot_subscriptions
       WHERE bot_user_id = $1 AND plan_tier IN ('pro', 'elite', 'trial')
       ORDER BY CASE plan_tier WHEN 'elite' THEN 3 WHEN 'pro' THEN 2 WHEN 'trial' THEN 1 END DESC,
                started_at DESC LIMIT 1`,
      [botUserId]
    );
    if (r.rows.length > 0) {
      const sub = r.rows[0];
      const plan = sub.plan_tier;
      const now = new Date();

      if (plan === "trial") {
        // Trial: only active if not expired
        if (sub.expires_at && new Date(sub.expires_at) > now) tier = "trial";
      } else if (sub.status === "active") {
        tier = plan;
      } else if (sub.status === "cancel_at_period_end") {
        if (sub.expires_at && new Date(sub.expires_at) > now) tier = plan;
      } else if (sub.status === "past_due") {
        if (sub.expires_at) {
          const grace = new Date(sub.expires_at);
          grace.setDate(grace.getDate() + 3);
          if (now < grace) tier = plan;
        }
      }
    }
  } catch {}

  if (redis) {
    try { await redis.setex(cacheKey, CACHE_TTL, tier || "null"); } catch {}
  }

  return tier;
}

function requirePlan(minTier) {
  const minRank = TIER_RANK[minTier] || 0;

  return async (req, res, next) => {
    if (!req.userId) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const tier = await getUserTier(req.userId);
    const rank = TIER_RANK[tier] || 0;

    if (!tier || rank < minRank) {
      return res.status(403).json({
        error: "subscription_required",
        required_plan: minTier,
        current_plan: tier || "inactive",
        message: tier
          ? `This feature requires ${minTier.toUpperCase()} plan. You are on ${tier.toUpperCase()}.`
          : "An active subscription is required. Subscribe at bot.agoraiq.net/pricing",
        upgrade_url: "/pricing.html",
      });
    }
    req.planTier = tier;
    next();
  };
}

async function attachPlan(req, res, next) {
  if (req.userId) {
    req.planTier = await getUserTier(req.userId);
  } else {
    req.planTier = null;
  }
  next();
}

module.exports = { requirePlan, attachPlan, getUserTier };
