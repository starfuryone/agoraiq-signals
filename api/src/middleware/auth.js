const jwt = require("jsonwebtoken");

// ── Fail hard if JWT_SECRET is missing ───────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("[FATAL] JWT_SECRET env var is not set. Refusing to start.");
  process.exit(1);
}

const TOKEN_EXPIRY = process.env.TOKEN_EXPIRY || "7d";

/**
 * Issue a JWT for a bot_user.
 */
function issueToken(botUserId, email) {
  return jwt.sign(
    { sub: botUserId, email },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

/**
 * Normalize userId to integer.
 */
function normalizeUserId(payload) {
  const raw = payload.sub || payload.userId || payload.id;
  if (raw == null) return null;
  const num = parseInt(raw, 10);
  return isNaN(num) ? null : num;
}

/**
 * Required auth — rejects if no valid JWT.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authorization required" });
  }

  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET);
    req.userId = normalizeUserId(payload);
    if (!req.userId) {
      return res.status(401).json({ error: "Invalid token payload" });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Optional auth — sets req.userId if valid, continues either way.
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET);
      req.userId = normalizeUserId(payload);
    } catch {}
  }
  next();
}

module.exports = { requireAuth, optionalAuth, issueToken };
