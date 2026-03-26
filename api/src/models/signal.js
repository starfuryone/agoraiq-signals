/**
 * Canonical Signal Schema.
 *
 * EVERY signal in the system — scanner-generated, user-submitted,
 * provider-scraped, API-ingested — MUST pass through this.
 *
 * This is the contract between:
 *   - Scanner worker (creates signals)
 *   - Parser (normalizes raw text into signals)
 *   - API routes (reads/writes signals)
 *   - Push worker (formats signals for Telegram)
 *   - Resolver worker (checks TP/SL conditions)
 *   - Proof engine (aggregates stats)
 *   - Frontend (displays signals)
 */

// ── Enums ─────────────────────────────────────────────────────────

const SIGNAL_TYPES = ["breakout", "mean_reversion", "scalp", "swing", "manual"];
const DIRECTIONS = ["LONG", "SHORT"];
const STATUSES = ["OPEN", "TP1", "TP2", "TP3", "SL", "EXPIRED", "CANCELLED"];
const SOURCES = ["scanner", "provider", "user", "api"];

// ── Schema ────────────────────────────────────────────────────────

/**
 * @typedef {Object} Signal
 * @property {string}   id            - Unique ID (uuid or serial)
 * @property {string}   symbol        - Trading pair, always XXXUSDT (e.g. BTCUSDT)
 * @property {string}   type          - One of SIGNAL_TYPES
 * @property {string}   direction     - LONG or SHORT
 *
 * @property {number}   entry         - Entry price
 * @property {number}   stop          - Stop loss price
 * @property {number[]} targets       - Take profit levels [TP1, TP2, TP3...]
 * @property {string}   [leverage]    - e.g. "10X"
 *
 * @property {number}   confidence    - 0-100 (integer percentage)
 * @property {string}   [provider]    - Provider name/ID
 * @property {number}   [provider_id] - FK to providers table
 * @property {string}   source        - One of SOURCES
 * @property {number}   [bot_user_id]     - FK to users table (for user-submitted)
 *
 * @property {string}   status        - One of STATUSES
 * @property {number}   [result]      - Realized PnL as decimal ratio (0.032 = 3.2%)
 * @property {number}   [duration_sec]- Seconds from open to close
 * @property {number}   [current_price] - Live price (computed, not stored)
 * @property {number}   [unrealized_pnl] - Unrealized PnL (computed)
 *
 * @property {string}   created_at    - ISO 8601
 * @property {string}   [resolved_at] - ISO 8601, when status changed from OPEN
 * @property {string}   [updated_at]  - ISO 8601
 *
 * @property {Object}   [meta]        - Freeform metadata
 * @property {string}   [meta.raw_text]      - Original unparsed text
 * @property {string}   [meta.parse_status]  - parsed | partial | not_signal
 * @property {number}   [meta.volume_change] - Volume spike percentage
 * @property {string}   [meta.oi_direction]  - OI direction (rising/falling)
 * @property {number}   [meta.funding_rate]  - Funding rate at time of signal
 * @property {number}   [meta.providers_aligned] - Number of providers with same direction
 */

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

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ── Normalize ─────────────────────────────────────────────────────
// Takes any messy input and returns a clean Signal object.

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

  // Carry over raw_text and parse_status into meta
  if (raw.raw_text) signal.meta.raw_text = raw.raw_text;
  if (raw.parse_status) signal.meta.parse_status = raw.parse_status;
  if (raw.volume_change || raw.volume) {
    signal.meta.volume_change = raw.volume_change || raw.volume;
  }
  if (raw.oi_direction || raw.oiChange) {
    signal.meta.oi_direction = raw.oi_direction || raw.oiChange;
  }
  if (raw.providers_aligned) {
    signal.meta.providers_aligned = raw.providers_aligned;
  }

  return signal;
}

// ── To DB row ─────────────────────────────────────────────────────
// Converts a normalized Signal to a flat object for Postgres INSERT.

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
// Converts a Postgres row back to a clean Signal object.

function fromDbRow(row) {
  return {
    id: row.id,
    symbol: row.symbol,
    type: row.type || "manual",
    direction: row.direction || row.action,

    entry: row.entry != null ? parseFloat(row.entry) : (row.price != null ? parseFloat(row.price) : null),
    stop: row.stop != null ? parseFloat(row.stop) : (row.stop_loss != null ? parseFloat(row.stop_loss) : null),
    targets: typeof row.targets === "string" ? JSON.parse(row.targets) : (row.targets || []),
    leverage: row.leverage,

    confidence: row.confidence != null ? parseFloat(row.confidence) : null,
    provider: row.provider,
    provider_id: row.provider_id,
    source: row.source || "provider",
    bot_user_id: row.bot_user_id,

    status: normalizeStatus(row.status),
    result: row.result != null ? parseFloat(row.result) : (row.pnl != null ? parseFloat(row.pnl) : null),
    duration_sec: row.duration_sec,

    created_at: row.created_at,
    resolved_at: row.resolved_at,
    updated_at: row.updated_at,

    meta: typeof row.meta === "string" ? JSON.parse(row.meta) : (row.meta || {}),
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
  // Already has USDT suffix
  if (sym.endsWith("USDT")) return sym;
  // Bare symbol — append USDT
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
  if (!t) return [];
  if (!Array.isArray(t)) return [];
  return t.map(toNum).filter((n) => n !== null && n > 0).slice(0, 5);
}

function normalizeConfidence(c) {
  if (c == null) return null;
  const n = toNum(c);
  if (n == null) return null;
  // If 0-1 range, convert to 0-100
  if (n > 0 && n <= 1) return Math.round(n * 100);
  // Clamp to 0-100
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
  // Map legacy statuses
  if (up === "ACTIVE") return "OPEN";
  if (up === "HIT_TP") return "TP1";
  if (up === "HIT_SL") return "SL";
  if (STATUSES.includes(up)) return up;
  return "OPEN";
}

module.exports = {
  SIGNAL_TYPES,
  DIRECTIONS,
  STATUSES,
  SOURCES,
  validate,
  normalize,
  toDbRow,
  fromDbRow,
};
