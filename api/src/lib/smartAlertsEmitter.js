"use strict";

/**
 * Fire-and-forget outbound webhook to the Smart Alerts sidecar.
 *
 * Design constraints (non-negotiable):
 *   - MUST never block the main signal pipeline.
 *   - MUST never throw upward on failure.
 *   - MUST never modify the signal object.
 *   - Read-only snapshot of the signal is HMAC-signed and POSTed.
 *
 * To integrate, call:
 *
 *     const emitter = require("../lib/smartAlertsEmitter");
 *     emitter.emit(signal);   // returns immediately; errors are logged
 *
 * Disable by unsetting SMART_ALERTS_WEBHOOK_URL.
 */

const crypto = require("crypto");
const fetch = require("node-fetch");

const URL = process.env.SMART_ALERTS_WEBHOOK_URL || "";
const SECRET = process.env.SMART_ALERTS_HMAC_SECRET || "";
const TIMEOUT_MS = parseInt(process.env.SMART_ALERTS_WEBHOOK_TIMEOUT_MS || "2000", 10);

function enabled() {
  return !!(URL && SECRET);
}

/** Reduce a signal to the fields Smart Alerts cares about. Read-only copy. */
function snapshot(signal) {
  if (!signal) return null;
  return {
    id: signal.id ?? signal.signal_id ?? signal.uuid,
    symbol: signal.symbol,
    direction: signal.direction,
    ai_score: signal.ai_score ?? signal.score,
    confidence: signal.confidence,
    risk_reward: signal.risk_reward ?? signal.rr,
    provider: signal.provider,
    timeframe: signal.timeframe,
    signal_type: signal.signal_type,
    entry_type: signal.entry_type,
    trending: signal.trending,
    leverage_max: signal.leverage_max ?? signal.leverage,
    created_at: signal.created_at,
  };
}

function emit(signal) {
  if (!enabled()) return;
  const snap = snapshot(signal);
  if (!snap || !snap.id || !snap.symbol) return;

  // Fire-and-forget. Errors are swallowed (logged only).
  setImmediate(() => {
    try {
      const body = Buffer.from(JSON.stringify(snap), "utf8");
      const ts = String(Math.floor(Date.now() / 1000));
      const mac = crypto.createHmac("sha256", SECRET);
      mac.update(`${ts}.`); mac.update(body);
      const sig = "sha256=" + mac.digest("hex");

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

      fetch(URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Signature": sig,
          "X-Signature-Timestamp": ts,
          "User-Agent": "agoraiq-signals-emitter/1.0",
        },
        body,
        signal: ctrl.signal,
      }).then(res => {
        if (!res.ok) console.warn(`[smart-alerts:emit] ${res.status}`);
      }).catch(err => {
        console.warn(`[smart-alerts:emit] ${err.message}`);
      }).finally(() => clearTimeout(timer));
    } catch (err) {
      console.warn(`[smart-alerts:emit] ${err.message}`);
    }
  });
}

module.exports = { emit, enabled, snapshot };
