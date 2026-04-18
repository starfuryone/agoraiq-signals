/**
 * Canonical Signal Schema v4.
 *
 * Fixes from v3.1:
 *   - safeJsonParse enforces object shape for meta, array for targets
 *   - toPublicView explicit serializer for free tier
 *   - toResolvedView for public history (hides premium details)
 */

const SIGNAL_TYPES = ["breakout", "mean_reversion", "scalp", "swing", "manual"];
const DIRECTIONS = ["LONG", "SHORT"];
const STATUSES = ["OPEN", "TP1", "TP2", "TP3", "SL", "EXPIRED", "CANCELLED"];
const SOURCES = ["scanner", "provider", "user", "api", "manual"];

// ── Safe JSON helpers ─────────────────────────────────────────────

function safeJsonParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    console.warn("[signal] safeJsonParse failed:", e.message, "| starts with:", String(value).slice(0, 80));
    return fallback;
  }
}

/** Guarantee result is a plain object */
function ensureObject(val) {
  if (val && typeof val === "object" && !Array.isArray(val)) return val;
  return {};
}

/** Guarantee result is an array */
function ensureArray(val) {
  return Array.isArray(val) ? val : [];
}

// ── Validate ──────────────────────────────────────────────────────

function validate(signal) {
  const errors = [];

  if (!signal.symbol || typeof signal.symbol !== "string") {
    errors.push("symbol is required (string)");
  } else if (!/^[A-Z]{2,20}USDT$/.test(signal.symbol)) {
    errors.push(`symbol must be XXXUSDT format, got: ${signal.symbol}`);
  }

  if (!DIRECTIONS.includes(signal.direction)) {
    errors.push(`direction must be LONG or SHORT, got: ${signal.direction}`);
  }

  if (signal.type && !SIGNAL_TYPES.includes(signal.type)) {
    errors.push(`type must be one of ${SIGNAL_TYPES.join(",")}, got: ${signal.type}`);
  }

  if (signal.entry != null && (typeof signal.entry !== "number" || signal.entry <= 0)) {
    errors.push("entry must be a positive number");
  }

  if (signal.stop != null && (typeof signal.stop !== "number" || signal.stop <= 0)) {
    errors.push("stop must be a positive number");
  }

  if (signal.targets != null) {
    if (!Array.isArray(signal.targets)) {
      errors.push("targets must be an array");
    } else if (signal.targets.some((t) => typeof t !== "number" || t <= 0)) {
      errors.push("all targets must be positive numbers");
    }
  }

  if (signal.confidence != null) {
    if (typeof signal.confidence !== "number" || signal.confidence < 0 || signal.confidence > 100) {
      errors.push("confidence must be 0-100");
    }
  }

  if (signal.status && !STATUSES.includes(signal.status)) {
    errors.push(`status must be one of ${STATUSES.join(",")}, got: ${signal.status}`);
  }

  if (!SOURCES.includes(signal.source)) {
    errors.push(`source must be one of ${SOURCES.join(",")}, got: ${signal.source}`);
  }

  // Bounds & directional consistency — reject nonsense prices early.
  // Stop must be within 50% of entry; targets within 10x (prevents rogue
  // auto-gen values or bad user input producing absurd positions).
  const MAX_STOP_DEVIATION = 0.5;
  const MAX_TARGET_MULTIPLE = 10;
  if (typeof signal.entry === "number" && signal.entry > 0) {
    const e = signal.entry;
    if (typeof signal.stop === "number" && signal.stop > 0) {
      const stopPct = Math.abs(signal.stop - e) / e;
      if (stopPct > MAX_STOP_DEVIATION) {
        errors.push(`stop ${signal.stop} is ${(stopPct * 100).toFixed(1)}% from entry (max ${MAX_STOP_DEVIATION * 100}%)`);
      }
      if (signal.direction === "LONG" && signal.stop >= e) {
        errors.push("LONG stop must be below entry");
      }
      if (signal.direction === "SHORT" && signal.stop <= e) {
        errors.push("SHORT stop must be above entry");
      }
    }
    if (Array.isArray(signal.targets) && signal.targets.length) {
      for (const t of signal.targets) {
        if (typeof t !== "number" || t <= 0) continue;
        if (t > e * MAX_TARGET_MULTIPLE || t < e / MAX_TARGET_MULTIPLE) {
          errors.push(`target ${t} is out of reasonable range of entry ${e}`);
        }
        if (signal.direction === "LONG" && t <= e) {
          errors.push("LONG targets must be above entry");
        }
        if (signal.direction === "SHORT" && t >= e) {
          errors.push("SHORT targets must be below entry");
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Normalize ─────────────────────────────────────────────────────

function normalize(raw) {
  const signal = {
    id: raw.id || null,
    symbol: normalizeSymbol(raw.symbol || raw.pair),
    type: raw.type || "manual",
    direction: normalizeDirection(raw.direction || raw.action || raw.side),
    entry: toNum(raw.entry || raw.price),
    stop: toNum(raw.stop || raw.stop_loss || raw.stopLoss || raw.sl),
    targets: normalizeTargets(raw.targets || raw.takeProfits || raw.tps),
    leverage: raw.leverage || null,
    confidence: normalizeConfidence(raw.confidence || raw.aiScore || raw.score || raw.breakoutScore),
    provider: raw.provider || raw.provider_name || null,
    provider_id: raw.provider_id || null,
    source: normalizeSource(raw.source),
    bot_user_id: raw.bot_user_id || null,
    status: normalizeStatus(raw.status),
    result: raw.result != null ? toNum(raw.result) : (raw.pnl != null ? toNum(raw.pnl) : null),
    duration_sec: raw.duration_sec || null,
    created_at: raw.created_at || new Date().toISOString(),
    resolved_at: raw.resolved_at || null,
    updated_at: raw.updated_at || null,
    meta: raw.meta || {},
  };

  if (raw.raw_text) signal.meta.raw_text = raw.raw_text;
  if (raw.parse_status) signal.meta.parse_status = raw.parse_status;
  if (raw.volume_change || raw.volume) signal.meta.volume_change = raw.volume_change || raw.volume;
  if (raw.oi_direction || raw.oiChange) signal.meta.oi_direction = raw.oi_direction || raw.oiChange;
  if (raw.providers_aligned) signal.meta.providers_aligned = raw.providers_aligned;

  return signal;
}

// ── To DB row ─────────────────────────────────────────────────────

function toDbRow(signal) {
  return {
    symbol: signal.symbol,
    type: signal.type,
    direction: signal.direction,
    entry: signal.entry,
    stop: signal.stop,
    targets: JSON.stringify(signal.targets || []),
    leverage: signal.leverage,
    confidence: signal.confidence,
    provider: signal.provider,
    provider_id: signal.provider_id,
    source: signal.source,
    bot_user_id: signal.bot_user_id,
    status: signal.status,
    result: signal.result,
    duration_sec: signal.duration_sec,
    meta: JSON.stringify(signal.meta || {}),
    created_at: signal.created_at,
    resolved_at: signal.resolved_at,
  };
}

// ── From DB row ───────────────────────────────────────────────────

function fromDbRow(row) {
  const meta = ensureObject(safeJsonParse(row.meta, {}));
  const targets = ensureArray(safeJsonParse(row.targets, []));

  return {
    id: row.id,
    symbol: row.symbol,
    type: row.type || "manual",
    direction: row.direction || row.action,
    entry: row.entry != null ? parseFloat(row.entry) : (row.price != null ? parseFloat(row.price) : null),
    stop: row.stop != null ? parseFloat(row.stop) : (row.stop_loss != null ? parseFloat(row.stop_loss) : null),
    targets,
    leverage: row.leverage,
    confidence: row.confidence != null ? parseFloat(row.confidence) : null,
    provider: row.provider,
    provider_id: row.provider_id,
    source: row.source || "manual",
    bot_user_id: row.bot_user_id,
    status: normalizeStatus(row.status),
    result: row.result != null ? parseFloat(row.result) : (row.pnl != null ? parseFloat(row.pnl) : null),
    duration_sec: row.duration_sec,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
    updated_at: row.updated_at,
    meta,
    // AI fields (from meta, exposed top-level)
    score_breakdown: meta.ai_score_breakdown || null,
    thesis: meta.ai_thesis || null,
    tags: ensureArray(meta.ai_tags),
    regime: meta.ai_regime || null,
    risk_flags: ensureArray(meta.ai_risk_flags),
  };
}

// ── Free-tier serializer (explicit allow-list) ────────────────────

function toPublicView(signal) {
  return {
    id: signal.id,
    symbol: signal.symbol,
    type: signal.type,
    direction: signal.direction,
    entry: null,
    stop: null,
    targets: [],
    leverage: null,
    confidence: null,
    provider: signal.provider,
    provider_id: signal.provider_id,
    source: signal.source,
    bot_user_id: null,
    status: signal.status,
    result: null,
    duration_sec: signal.duration_sec,
    created_at: signal.created_at,
    resolved_at: signal.resolved_at,
    updated_at: signal.updated_at,
    meta: {},
    score_breakdown: null,
    thesis: null,
    tags: [],
    regime: null,
    risk_flags: [],
  };
}

// ── Resolved history serializer (public, marketing-safe) ──────────
// Shows outcome and symbol but hides premium entry/SL/TP details.

function toResolvedView(signal) {
  return {
    id: signal.id,
    symbol: signal.symbol,
    type: signal.type,
    direction: signal.direction,
    entry: null,
    stop: null,
    targets: [],
    leverage: null,
    confidence: signal.confidence,
    provider: signal.provider,
    provider_id: signal.provider_id,
    source: signal.source,
    bot_user_id: null,
    status: signal.status,
    result: signal.result,
    duration_sec: signal.duration_sec,
    created_at: signal.created_at,
    resolved_at: signal.resolved_at,
    updated_at: signal.updated_at,
    meta: {},
    score_breakdown: null,
    thesis: null,
    tags: ensureArray(signal.tags),
    regime: signal.regime,
    risk_flags: [],
  };
}

// ── Helpers ───────────────────────────────────────────────────────

function toNum(val) {
  if (val == null) return null;
  const n = typeof val === "number" ? val : parseFloat(val);
  return isNaN(n) ? null : n;
}

function normalizeSymbol(s) {
  if (!s) return null;
  let sym = String(s).toUpperCase().replace(/[\/\-\s]/g, "");
  if (sym === "BTCUSD" || sym === "XBTUSD") return "BTCUSDT";
  if (sym === "ETHUSD") return "ETHUSDT";
  if (sym.endsWith("USDT")) return sym;
  if (/^[A-Z]{2,10}$/.test(sym)) return sym + "USDT";
  return sym;
}

function normalizeDirection(d) {
  if (!d) return null;
  const up = String(d).toUpperCase().trim();
  if (up === "LONG" || up === "BUY") return "LONG";
  if (up === "SHORT" || up === "SELL") return "SHORT";
  return null;
}

function normalizeTargets(t) {
  if (!t || !Array.isArray(t)) return [];
  return t.map(toNum).filter((n) => n !== null && n > 0).slice(0, 5);
}

function normalizeConfidence(c) {
  if (c == null) return null;
  const n = toNum(c);
  if (n == null) return null;
  if (n > 0 && n <= 1) return Math.round(n * 100);
  return Math.round(Math.max(0, Math.min(100, n)));
}

function normalizeSource(s) {
  if (!s) return "manual";
  const lower = String(s).toLowerCase();
  if (lower.includes("scan")) return "scanner";
  if (lower.includes("provider") || lower.includes("telegram")) return "provider";
  if (lower.includes("user")) return "user";
  if (lower.includes("api")) return "api";
  return "manual";
}

function normalizeStatus(s) {
  if (!s) return "OPEN";
  const up = String(s).toUpperCase().trim();
  if (up === "ACTIVE") return "OPEN";
  if (up === "HIT_TP") return "TP1";
  if (up === "HIT_SL") return "SL";
  if (STATUSES.includes(up)) return up;
  return "OPEN";
}

module.exports = {
  SIGNAL_TYPES, DIRECTIONS, STATUSES, SOURCES,
  validate, normalize, toDbRow, fromDbRow,
  toPublicView, toResolvedView,
};
