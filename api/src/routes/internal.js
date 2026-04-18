"use strict";

/**
 * Internal, read-only endpoints consumed by sibling sidecars
 * (e.g. agoraiq-smart-alerts) on the loopback interface.
 *
 * This router does NOT expose user data, PII, or billing details —
 * only the minimum needed to gate features:
 *
 *   GET /api/internal/user-plan/:userId → { tier: "pro"|"elite"|null }
 *
 * Auth: X-Internal-Key header matched against MAIN_INTERNAL_KEY.
 * Timing-safe comparison.
 */

const crypto = require("crypto");
const { Router } = require("express");
const db = require("../lib/db");
const { getUserTier } = require("../middleware/subscription");

const router = Router();

const INTERNAL_KEY = process.env.MAIN_INTERNAL_KEY || "";

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  if (ab.length === 0 || ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function requireInternalKey(req, res, next) {
  if (!INTERNAL_KEY) return res.status(503).json({ error: "internal_key_not_configured" });
  const provided = req.headers["x-internal-key"];
  if (!timingSafeEqual(provided, INTERNAL_KEY)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

router.use(requireInternalKey);

/** Plan lookup — only returns the normalized paid tier or null. */
router.get("/user-plan/:userId", async (req, res) => {
  const id = parseInt(req.params.userId, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: "invalid_user_id" });
  }
  try {
    const tier = await getUserTier(id);
    const normalized = tier === "pro" || tier === "elite" ? tier : null;
    res.json({ user_id: id, tier: normalized });
  } catch (err) {
    res.status(500).json({ error: "lookup_failed", detail: err.message });
  }
});

/** Light ping for sidecars to confirm the internal channel is up. */
router.get("/ping", (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

module.exports = router;
