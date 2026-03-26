/**
 * Signal event logger.
 *
 * Every signal state change writes an immutable event to signal_events.
 * Events drive push notifications and proof page analytics.
 *
 * Event types:
 *   CREATED     — signal first inserted
 *   TP1_HIT     — first take profit reached
 *   TP2_HIT     — second take profit reached
 *   TP3_HIT     — third take profit reached
 *   SL_HIT      — stop loss triggered
 *   EXPIRED     — signal expired (7d timeout)
 *   CANCELLED   — manually cancelled
 *   PRICE_CHECK — periodic price snapshot (optional, for charts)
 */

const db = require("./db");

/**
 * Log a signal event.
 * @param {number} signalId
 * @param {string} event       - Event type
 * @param {object} opts
 * @param {string} [opts.oldStatus]
 * @param {string} [opts.newStatus]
 * @param {number} [opts.priceAt]   - Market price at time of event
 * @param {number} [opts.pnlAt]     - PnL at time of event (decimal ratio)
 * @param {object} [opts.meta]      - Extra data (duration, provider, etc)
 */
async function logEvent(signalId, event, opts = {}) {
  try {
    await db.query(
      `INSERT INTO signal_events (signal_id, event, old_status, new_status, price_at, pnl_at, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        signalId,
        event,
        opts.oldStatus || null,
        opts.newStatus || null,
        opts.priceAt || null,
        opts.pnlAt || null,
        JSON.stringify(opts.meta || {}),
      ]
    );
  } catch (err) {
    console.error(`[events] failed to log ${event} for signal ${signalId}:`, err.message);
  }
}

/**
 * Get all events for a signal (chronological).
 */
async function getEvents(signalId) {
  const r = await db.query(
    `SELECT * FROM signal_events WHERE signal_id = $1 ORDER BY created_at ASC`,
    [signalId]
  );
  return r.rows;
}

/**
 * Get recent events across all signals (for activity feed).
 */
async function getRecentEvents(limit = 20) {
  const r = await db.query(
    `SELECT e.*, s.symbol, s.direction, s.entry
     FROM signal_events e
     JOIN signals_v2 s ON s.id = e.signal_id
     WHERE e.event != 'PRICE_CHECK'
     ORDER BY e.created_at DESC
     LIMIT $1`,
    [limit]
  );
  return r.rows;
}

/**
 * Get daily event counts (for retention dashboard).
 */
async function getDailyEventCounts(days = 7) {
  const r = await db.query(
    `SELECT
       DATE(created_at) AS day,
       COUNT(*) FILTER (WHERE event = 'CREATED')::int AS created,
       COUNT(*) FILTER (WHERE event LIKE 'TP%')::int AS tp_hits,
       COUNT(*) FILTER (WHERE event = 'SL_HIT')::int AS sl_hits,
       COUNT(*)::int AS total
     FROM signal_events
     WHERE created_at > NOW() - ($1 || ' days')::INTERVAL
     GROUP BY DATE(created_at)
     ORDER BY DATE(created_at) DESC`,
    [days]
  );
  return r.rows;
}

module.exports = { logEvent, getEvents, getRecentEvents, getDailyEventCounts };
