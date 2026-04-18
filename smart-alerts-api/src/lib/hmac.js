"use strict";

const crypto = require("crypto");

/**
 * Compute the canonical HMAC-SHA256 signature for a signal webhook request.
 *
 *   sig = HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *
 * Header contract on the wire:
 *   X-Signature-Timestamp: <unix-seconds>
 *   X-Signature:          sha256=<hex>
 *
 * Timestamp skew is enforced at the middleware layer.
 */
function sign(rawBody, timestamp, secret) {
  const mac = crypto.createHmac("sha256", secret);
  mac.update(`${timestamp}.`);
  mac.update(rawBody);
  return "sha256=" + mac.digest("hex");
}

function verify(rawBody, timestamp, signature, secret) {
  if (!rawBody || !timestamp || !signature || !secret) return false;
  const expected = sign(rawBody, timestamp, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(signature), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { sign, verify };
