"use strict";

/**
 * Plan-tier lookup.
 *
 * Strictly read-only HTTP call to the main app:
 *   GET {MAIN_API_BASE_URL}/api/internal/user-plan/:userId
 *   Header: X-Internal-Key: {MAIN_API_INTERNAL_KEY}
 *
 * Response shape:
 *   { tier: "pro" | "elite" | null, status: "active" | ... }
 *
 * Results are cached in this service's Redis for PLAN_CACHE_TTL_SEC.
 * Cache failures never cause the lookup to fail; they just skip the cache.
 */

const fetch = require("node-fetch");
const { getRedis } = require("./redis");
const log = require("./logger");

const BASE = (process.env.MAIN_API_BASE_URL || "http://127.0.0.1:4300").replace(/\/$/, "");
const KEY = process.env.MAIN_API_INTERNAL_KEY || "";
const TTL = parseInt(process.env.PLAN_CACHE_TTL_SEC || "300", 10);

const TIER_RANK = { pro: 1, elite: 2 };

function rank(t) { return TIER_RANK[t] || 0; }

async function lookup(userId) {
  if (!userId) return null;
  const cacheKey = `plan:${userId}`;
  const r = getRedis();

  try {
    const cached = await r.get(cacheKey);
    if (cached != null) return cached === "none" ? null : cached;
  } catch (e) {
    log.warn("[plan] cache get failed:", e.message);
  }

  let tier = null;
  try {
    const res = await fetch(`${BASE}/api/internal/user-plan/${encodeURIComponent(userId)}`, {
      method: "GET",
      headers: { "X-Internal-Key": KEY, "Accept": "application/json" },
      timeout: 4000,
    });
    if (res.ok) {
      const body = await res.json();
      if (body && (body.tier === "pro" || body.tier === "elite")) {
        tier = body.tier;
      }
    } else if (res.status === 404) {
      tier = null;
    } else {
      log.warn(`[plan] lookup ${res.status} for user ${userId}`);
    }
  } catch (e) {
    log.error("[plan] lookup error:", e.message);
  }

  try { await r.setex(cacheKey, TTL, tier || "none"); } catch {}
  return tier;
}

function requirePaid(req, res, next) {
  lookup(req.userId).then(tier => {
    if (!tier) {
      return res.status(403).json({
        error: "subscription_required",
        required_plan: "pro",
        message: "Smart Alerts requires an active Pro or Elite subscription.",
        upgrade_url: "/pricing.html",
      });
    }
    req.planTier = tier;
    next();
  }).catch(err => {
    log.error("[plan] requirePaid failed:", err.message);
    res.status(503).json({ error: "plan_lookup_unavailable" });
  });
}

module.exports = { lookup, requirePaid, rank, TIER_RANK };
