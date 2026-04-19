"use strict";

const { verify } = require("../lib/hmac");
const log = require("../lib/logger");

const SECRET = process.env.SIGNAL_WEBHOOK_HMAC_SECRET;
const MAX_SKEW = parseInt(process.env.SIGNAL_WEBHOOK_MAX_SKEW_SEC || "300", 10);

if (!SECRET) {
  console.error("[FATAL] SIGNAL_WEBHOOK_HMAC_SECRET is not set.");
  process.exit(1);
}

/**
 * Verifies inbound signal webhooks. Requires a raw body parser to
 * have populated req.rawBody. Uses timing-safe comparison and enforces
 * a clock-skew window to prevent replay of old captures.
 */
function requireSignalHmac(req, res, next) {
  const ts = req.headers["x-signature-timestamp"];
  const sig = req.headers["x-signature"];
  if (!ts || !sig) {
    return res.status(401).json({ error: "missing_signature_headers" });
  }
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) {
    return res.status(401).json({ error: "invalid_timestamp" });
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > MAX_SKEW) {
    return res.status(401).json({ error: "stale_timestamp" });
  }
  const raw = req.rawBody;
  if (!raw) {
    log.error("[hmac] rawBody missing — raw parser not wired for this route");
    return res.status(500).json({ error: "raw_body_not_available" });
  }
  if (!verify(raw, String(tsNum), sig, SECRET)) {
    return res.status(401).json({ error: "invalid_signature" });
  }
  next();
}

module.exports = { requireSignalHmac };
