/**
 * Deterministic Deduplication Engine
 *
 * Hash contract:
 *
 *   hash = sha256(symbol + "|" + direction + "|" + roundedEntry +
 *                 "|" + timeframe + "|" + timeWindowBucket)
 *
 * Where:
 *   - roundedEntry        = entry rounded to ENTRY_ROUNDING_DIGITS decimals
 *                           (default 8) so float jitter doesn't unhash
 *   - timeWindowBucket    = floor(signal_ts_ms / window_ms) — every signal
 *                           inside the same N-minute slot collapses to the
 *                           same bucket
 *
 * Window is configurable via env INGEST_DEDUPE_WINDOW_MIN (default 15).
 *
 * Two checks happen, in order:
 *
 *   1. Redis SET NX with TTL = window. Fast path. If key already exists,
 *      we have a duplicate within the live window. This makes the dedupe
 *      decision atomic across HTTP replicas and worker instances.
 *
 *   2. Postgres lookup against signals_v2(hash) — guards against the case
 *      where Redis was flushed but the row already landed. The unique
 *      partial index on signals_v2(hash) is the final backstop at INSERT
 *      time inside the worker.
 *
 * Returns { duplicate: false, hash } when the signal is fresh, or
 * { duplicate: true, hash, existing_id?, source } when a collision is found.
 * The caller is responsible for routing duplicates to signals_rejected.
 */

const crypto = require("crypto");
const db = require("./db");
const { getRedis } = require("./redis");

const WINDOW_MIN = parseInt(process.env.INGEST_DEDUPE_WINDOW_MIN || "15", 10);
const WINDOW_MS = WINDOW_MIN * 60 * 1000;
const ENTRY_ROUNDING_DIGITS = 8;
const REDIS_KEY_PREFIX = "agoraiq:ingest:dedupe:";
// TTL is 2x the window so the in-flight key survives clock skew at the boundary.
const REDIS_TTL_SEC = WINDOW_MIN * 60 * 2;

/**
 * Compute the deterministic hash for a normalized signal at a given bucket.
 *
 * @param {object} signal  output of normalizer.normalize
 * @param {number} [bucketOffset=0]  -1 to compute the previous bucket's hash
 * @returns {string} 64-char hex sha256
 */
function computeHash(signal, bucketOffset = 0) {
  const roundedEntry = round(signal.entry, ENTRY_ROUNDING_DIGITS);
  const ts = Number.isFinite(signal.signal_ts) ? signal.signal_ts : Date.now();
  const bucket = Math.floor(ts / WINDOW_MS) + bucketOffset;

  const material = [
    signal.symbol,
    signal.direction,
    roundedEntry,
    signal.timeframe || "unknown",
    bucket,
  ].join("|");

  return crypto.createHash("sha256").update(material).digest("hex");
}

/**
 * Check whether a signal would duplicate one already ingested in this window.
 *
 * Two near-identical signals straddling a bucket boundary (e.g. one at
 * bucket-end, one at bucket-start of the next slot) would otherwise hash
 * differently and both ingest. Guard against that by also checking the
 * previous bucket's hash before reserving.
 *
 * @param {object} signal  output of normalizer.normalize
 * @returns {Promise<{duplicate: boolean, hash: string, existing_id?: number, source?: string}>}
 */
async function checkAndReserve(signal) {
  const hash = computeHash(signal, 0);
  const prevHash = computeHash(signal, -1);

  // Previous-bucket lookahead: if a duplicate exists in the prior bucket,
  // treat this one as a duplicate too (sliding-window protection).
  if (prevHash !== hash) {
    try {
      const redis = getRedis();
      const prevHit = await redis.get(REDIS_KEY_PREFIX + prevHash);
      if (prevHit) {
        return { duplicate: true, hash, source: "redis_prev_bucket" };
      }
    } catch (err) {
      console.warn("[dedupe] redis prev-bucket check failed:", err.message);
    }
    try {
      const r = await db.query(
        "SELECT id FROM signals_v2 WHERE hash = $1 LIMIT 1",
        [prevHash]
      );
      if (r.rows.length > 0) {
        return { duplicate: true, hash, existing_id: r.rows[0].id, source: "db_prev_bucket" };
      }
    } catch (err) {
      console.error("[dedupe] db prev-bucket check failed:", err.message);
    }
  }

  // Redis fast path: SET NX (atomic). Reservation lives until window expires.
  let reservedInRedis = false;
  try {
    const redis = getRedis();
    const result = await redis.set(REDIS_KEY_PREFIX + hash, "1", "EX", REDIS_TTL_SEC, "NX");
    reservedInRedis = result === "OK";
  } catch (err) {
    // Redis is best-effort — Postgres unique index is the source of truth.
    console.warn("[dedupe] redis check failed:", err.message);
  }

  if (!reservedInRedis) {
    // Either Redis already saw this hash, or Redis errored. Confirm against DB.
    try {
      const r = await db.query(
        "SELECT id FROM signals_v2 WHERE hash = $1 LIMIT 1",
        [hash]
      );
      if (r.rows.length > 0) {
        return { duplicate: true, hash, existing_id: r.rows[0].id, source: "db" };
      }
      // Redis hit but no DB row → another worker is mid-flight. Treat as duplicate.
      if (reservedInRedis === false) {
        return { duplicate: true, hash, source: "redis_inflight" };
      }
    } catch (err) {
      console.error("[dedupe] db check failed:", err.message);
      // Fall through — let the worker's INSERT hit the unique index.
    }
  }

  return { duplicate: false, hash };
}

/**
 * Release a Redis reservation (called only when the worker's INSERT fails for
 * a non-duplicate reason, so the next retry can re-reserve cleanly).
 */
async function releaseReservation(hash) {
  try {
    await getRedis().del(REDIS_KEY_PREFIX + hash);
  } catch (err) {
    console.warn("[dedupe] release failed:", err.message);
  }
}

function round(n, digits) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

module.exports = {
  computeHash,
  checkAndReserve,
  releaseReservation,
  WINDOW_MIN,
};
