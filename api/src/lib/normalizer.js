/**
 * Signal Normalization Layer
 *
 * Transforms ANY incoming signal payload (Telegram free-text, scanner
 * structured object, external API push) into the canonical v3_clean
 * shape consumed by the validator and ingest worker.
 *
 * Canonical output (no nullable critical fields):
 *
 *   {
 *     symbol:       string  (XXXUSDT)
 *     direction:    "LONG" | "SHORT"
 *     entry:        number
 *     stop:         number
 *     targets:      number[]   (ascending for LONG, descending for SHORT)
 *     timeframe:    string     (e.g. "1h", "4h", "1d", "scanner")
 *     source:       string     (scanner | provider | user | api | manual)
 *     provider:     string
 *     strategy:     string     (e.g. breakout_v1, provider_external)
 *     raw_payload:  string
 *     signal_ts:    number     (unix ms)
 *   }
 *
 * Rules implemented here:
 *   - Entry ranges (e.g. "0.42 - 0.45") collapse to midpoint
 *   - Targets are sorted in trade direction (LONG ascending, SHORT descending)
 *   - Symbol is upper-cased and forced to USDT pair convention
 *   - Direction tokens (BUY/SELL/long/short) are normalized
 *   - Missing critical fields produce a NormalizationError — the caller is
 *     expected to route the rejection to signals_rejected
 *
 * This module never mutates the input. It never falls back to "best guess"
 * for missing critical fields — failures throw and are logged downstream.
 */

const { parseSignal } = require("./parser");

class NormalizationError extends Error {
  constructor(reason, details = {}) {
    super(reason);
    this.name = "NormalizationError";
    this.reason = reason;
    this.details = details;
  }
}

const VALID_SOURCES = ["scanner", "provider", "user", "api", "manual"];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Normalize a raw payload into the canonical schema.
 *
 * @param {object} payload
 * @param {string} [payload.raw_text]    Telegram-style free text
 * @param {object} [payload.structured]  Pre-parsed structured fields
 * @param {string} payload.source        scanner | provider | user | api | manual
 * @param {string} [payload.provider]
 * @param {string} [payload.strategy]
 * @param {string} [payload.timeframe]
 * @param {number} [payload.signal_ts]
 * @returns {object} canonical signal
 * @throws {NormalizationError}
 */
function normalize(payload) {
  if (!payload || typeof payload !== "object") {
    throw new NormalizationError("payload_not_object");
  }

  const source = normalizeSource(payload.source);
  if (!source) {
    throw new NormalizationError("invalid_source", { received: payload.source });
  }

  let parsed;
  let rawPayload;

  if (typeof payload.raw_text === "string" && payload.raw_text.trim()) {
    rawPayload = payload.raw_text.trim();
    parsed = fromFreeText(rawPayload);
  } else if (payload.structured && typeof payload.structured === "object") {
    rawPayload = JSON.stringify(payload.structured);
    parsed = fromStructured(payload.structured);
  } else {
    throw new NormalizationError("missing_payload_body", {
      hint: "provide raw_text or structured",
    });
  }

  const direction = normalizeDirection(parsed.direction);
  if (!direction) {
    throw new NormalizationError("invalid_direction", { received: parsed.direction });
  }

  const symbol = normalizeSymbol(parsed.symbol);
  if (!symbol) {
    throw new NormalizationError("invalid_symbol", { received: parsed.symbol });
  }

  const entry = collapseRangeToMidpoint(parsed.entry);
  if (entry == null || !(entry > 0)) {
    throw new NormalizationError("invalid_entry", { received: parsed.entry });
  }

  const stop = toFiniteNumber(parsed.stop);
  if (stop == null || !(stop > 0)) {
    throw new NormalizationError("invalid_stop", { received: parsed.stop });
  }

  const targets = orderTargets(toFiniteArray(parsed.targets), direction);
  if (targets.length === 0) {
    throw new NormalizationError("missing_targets");
  }

  const provider = (payload.provider || parsed.provider || source).toString();
  const strategy = (payload.strategy || parsed.strategy || defaultStrategy(source)).toString();
  const timeframe = (payload.timeframe || parsed.timeframe || defaultTimeframe(source)).toString();
  const signalTs = Number.isFinite(payload.signal_ts) ? payload.signal_ts : Date.now();

  return {
    symbol,
    direction,
    entry,
    stop,
    targets,
    timeframe,
    source,
    provider,
    strategy,
    raw_payload: rawPayload,
    signal_ts: signalTs,
  };
}

// ── Telegram free-text path ────────────────────────────────────────────────

function fromFreeText(text) {
  const p = parseSignal(text);
  if (!p || p.parseStatus === "not_signal") {
    throw new NormalizationError("parse_failed", { parse_status: p && p.parseStatus });
  }
  return {
    symbol: p.symbol,
    direction: p.action,
    entry: p.price,
    stop: p.stopLoss,
    targets: p.targets,
    timeframe: p.timeframe || null,
    provider: p.provider || null,
    strategy: null,
  };
}

// ── Structured path ────────────────────────────────────────────────────────

function fromStructured(s) {
  return {
    symbol: s.symbol || s.pair,
    direction: s.direction || s.action || s.side,
    entry: s.entry != null ? s.entry : s.price,
    stop: s.stop != null ? s.stop : (s.stop_loss != null ? s.stop_loss : (s.stopLoss != null ? s.stopLoss : s.sl)),
    targets: s.targets || s.takeProfits || s.tps || [],
    timeframe: s.timeframe || null,
    provider: s.provider || s.provider_name || null,
    strategy: s.strategy || null,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizeSource(s) {
  if (!s || typeof s !== "string") return null;
  const lower = s.toLowerCase().trim();
  if (VALID_SOURCES.includes(lower)) return lower;
  if (lower.includes("scan")) return "scanner";
  if (lower.includes("provider") || lower.includes("telegram")) return "provider";
  if (lower.includes("user")) return "user";
  if (lower.includes("api")) return "api";
  return null;
}

function normalizeDirection(d) {
  if (!d) return null;
  const up = String(d).toUpperCase().trim();
  if (up === "LONG" || up === "BUY") return "LONG";
  if (up === "SHORT" || up === "SELL") return "SHORT";
  return null;
}

function normalizeSymbol(s) {
  if (!s) return null;
  let sym = String(s).toUpperCase().replace(/[\/\-\s]/g, "");
  if (sym === "BTCUSD" || sym === "XBTUSD") return "BTCUSDT";
  if (sym === "ETHUSD") return "ETHUSDT";
  if (sym.endsWith("USDT")) return /^[A-Z]{2,20}USDT$/.test(sym) ? sym : null;
  if (/^[A-Z]{2,16}$/.test(sym)) return sym + "USDT";
  return null;
}

/**
 * Accept a number or a [low, high] range (array or "low - high" string)
 * and return its midpoint. Single numbers pass through.
 */
function collapseRangeToMidpoint(val) {
  if (val == null) return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  if (Array.isArray(val) && val.length === 2) {
    const a = toFiniteNumber(val[0]);
    const b = toFiniteNumber(val[1]);
    if (a == null || b == null) return null;
    return (a + b) / 2;
  }
  if (typeof val === "string") {
    const m = val.match(/^\s*([0-9.]+)\s*[-–]\s*([0-9.]+)\s*$/);
    if (m) {
      const a = parseFloat(m[1]);
      const b = parseFloat(m[2]);
      if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
    }
    const n = parseFloat(val);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toFiniteNumber(val) {
  if (val == null) return null;
  const n = typeof val === "number" ? val : parseFloat(val);
  return Number.isFinite(n) ? n : null;
}

function toFiniteArray(val) {
  if (!Array.isArray(val)) return [];
  const out = [];
  for (const x of val) {
    const n = toFiniteNumber(x);
    if (n != null && n > 0) out.push(n);
  }
  return out;
}

/** Order targets in trade direction so targets[0] is closest to entry. */
function orderTargets(arr, direction) {
  const cleaned = [...arr].filter((n) => Number.isFinite(n) && n > 0);
  cleaned.sort((a, b) => a - b);
  return direction === "SHORT" ? cleaned.reverse() : cleaned;
}

function defaultStrategy(source) {
  if (source === "scanner") return "breakout_v1";
  if (source === "provider") return "provider_external";
  return "manual_v1";
}

function defaultTimeframe(source) {
  if (source === "scanner") return "scanner";
  return "unknown";
}

module.exports = { normalize, NormalizationError };
