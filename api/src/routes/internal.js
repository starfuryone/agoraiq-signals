"use strict";

const { Router } = require("express");
const { getUserTier } = require("../middleware/subscription");

const router = Router();

// Shared-secret guard. Accepts X-Internal-Key matching MAIN_INTERNAL_KEY.
// Also restricts to localhost, since only sidecar services on this box call it.
router.use((req, res, next) => {
  const ip = req.ip || req.connection?.remoteAddress;
  const isLocal = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!isLocal) return res.status(403).json({ error: "localhost_only" });

  const expected = process.env.MAIN_INTERNAL_KEY;
  if (!expected) return res.status(500).json({ error: "internal_key_unconfigured" });

  const provided = req.headers["x-internal-key"];
  if (provided !== expected) return res.status(403).json({ error: "invalid_internal_key" });

  next();
});

// GET /api/internal/user-plan/:userId
// Response: { tier: "pro" | "elite" | null, status: "active" | "inactive" | ... }
router.get("/user-plan/:userId", async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: "invalid_user_id" });
  }

  try {
    const tier = await getUserTier(userId); // returns "pro" | "elite" | null
    res.json({
      tier: tier || null,
      status: tier ? "active" : "inactive",
    });
  } catch (err) {
    console.error("[internal/user-plan]", err.message);
    res.status(500).json({ error: "lookup_failed" });
  }
});

module.exports = router;
