/**
 * Strict Validation Engine
 *
 * Operates on a normalized signal (output of lib/normalizer). Computes derived
 * risk metrics and rejects mathematically-invalid trade plans:
 *
 *   - entry / stop / targets must all be finite positive numbers
 *   - direction in {LONG, SHORT}
 *   - entry !== stop (zero risk would divide by zero in EV math)
 *   - stop is on the correct side of entry given direction
 *   - first target is on the correct side of entry given direction
 *   - risk/reward ratio (computed from targets[0]) must be in [MIN_RR, MAX_RR]
 *
 * Bounds are configurable via env:
 *   INGEST_RR_MIN  (default 0.5)
 *   INGEST_RR_MAX  (default 10)
 *
 * Returns either { ok: true, validated } or { ok: false, reason, details }.
 * Never throws — callers branch on the result and route rejections.
 */

const RR_MIN = parseFloat(process.env.INGEST_RR_MIN || "0.5");
const RR_MAX = parseFloat(process.env.INGEST_RR_MAX || "10");

function validate(signal) {
  if (!signal || typeof signal !== "object") {
    return fail("payload_not_object");
  }

  if (signal.direction !== "LONG" && signal.direction !== "SHORT") {
    return fail("invalid_direction", { received: signal.direction });
  }

  const { entry, stop } = signal;

  if (!Number.isFinite(entry) || entry <= 0) {
    return fail("invalid_entry", { received: entry });
  }
  if (!Number.isFinite(stop) || stop <= 0) {
    return fail("invalid_stop", { received: stop });
  }
  if (entry === stop) {
    return fail("entry_equals_stop");
  }

  if (!Array.isArray(signal.targets) || signal.targets.length === 0) {
    return fail("missing_targets");
  }
  if (signal.targets.some((t) => !Number.isFinite(t) || t <= 0)) {
    return fail("invalid_target_value");
  }

  // Side-of-entry sanity. Catches LONG with stop above entry, etc. — these are
  // almost always payload errors, not legitimate trades. Every target must be
  // on the correct side of entry, not just targets[0].
  if (signal.direction === "LONG") {
    if (stop >= entry) return fail("long_stop_at_or_above_entry", { entry, stop });
    const badIdx = signal.targets.findIndex((t) => t <= entry);
    if (badIdx >= 0) {
      return fail("long_target_at_or_below_entry", { entry, target_index: badIdx, target: signal.targets[badIdx] });
    }
  } else {
    if (stop <= entry) return fail("short_stop_at_or_below_entry", { entry, stop });
    const badIdx = signal.targets.findIndex((t) => t >= entry);
    if (badIdx >= 0) {
      return fail("short_target_at_or_above_entry", { entry, target_index: badIdx, target: signal.targets[badIdx] });
    }
  }

  // entry !== stop is checked above, so risk is always > 0 here.
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(signal.targets[0] - entry);
  const rr = reward / risk;

  if (!(rr >= RR_MIN) || !(rr <= RR_MAX)) {
    return fail("rr_out_of_bounds", { rr, min: RR_MIN, max: RR_MAX });
  }

  return {
    ok: true,
    validated: {
      ...signal,
      validation: {
        risk: round(risk, 12),
        reward: round(reward, 12),
        rr: round(rr, 6),
        rr_min: RR_MIN,
        rr_max: RR_MAX,
        validated_at: Date.now(),
      },
    },
  };
}

function fail(reason, details = {}) {
  return { ok: false, reason, details };
}

function round(n, digits) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

module.exports = { validate };
