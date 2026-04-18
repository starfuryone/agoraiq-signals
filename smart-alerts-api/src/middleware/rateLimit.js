"use strict";

const rateLimit = require("express-rate-limit");

const PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "60", 10);

const userLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: PER_MIN,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => req.userId ? `u:${req.userId}` : `ip:${req.ip}`,
  message: { error: "rate_limited" },
});

module.exports = { userLimiter };
