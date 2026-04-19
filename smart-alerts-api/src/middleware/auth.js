"use strict";

const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  console.error("[FATAL] JWT_SECRET env var is not set.");
  process.exit(1);
}

function normalizeUserId(payload) {
  const raw = payload?.sub ?? payload?.userId ?? payload?.id;
  if (raw == null) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization;
  if (!h || !h.startsWith("Bearer ")) {
    return res.status(401).json({ error: "authorization_required" });
  }
  try {
    const payload = jwt.verify(h.slice(7), SECRET);
    const uid = normalizeUserId(payload);
    if (!uid) return res.status(401).json({ error: "invalid_token_payload" });
    req.userId = uid;
    req.jwt = payload;
    next();
  } catch {
    return res.status(401).json({ error: "invalid_or_expired_token" });
  }
}

module.exports = { requireAuth };
