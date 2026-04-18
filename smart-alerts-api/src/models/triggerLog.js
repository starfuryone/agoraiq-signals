"use strict";

const db = require("../lib/db");

/**
 * Insert a trigger log. Dedup is enforced by the unique
 * (alert_rule_id, signal_id) index — duplicates return null.
 */
async function record({
  alert_rule_id,
  user_id,
  signal_id,
  signal_snapshot,
  matched_fields,
  suppressed = false,
  suppressed_reason = null,
}) {
  const r = await db.query(
    `INSERT INTO trigger_logs (
       alert_rule_id, user_id, signal_id, signal_snapshot,
       matched_fields, suppressed, suppressed_reason
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (alert_rule_id, signal_id) DO NOTHING
     RETURNING id, alert_rule_id, user_id, signal_id, fired_at, suppressed`,
    [
      alert_rule_id, user_id, signal_id, signal_snapshot,
      matched_fields, suppressed, suppressed_reason,
    ]
  );
  return r.rows[0] || null;
}

async function countTodayForUser(userId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM trigger_logs
      WHERE user_id = $1
        AND suppressed = FALSE
        AND fired_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    [userId]
  );
  return r.rows[0].n;
}

module.exports = { record, countTodayForUser };
