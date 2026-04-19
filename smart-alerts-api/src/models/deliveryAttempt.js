"use strict";

const db = require("../lib/db");

async function create({
  trigger_log_id, alert_rule_id, user_id,
  channel = "telegram", target = null, payload,
}) {
  const r = await db.query(
    `INSERT INTO delivery_attempts (
       trigger_log_id, alert_rule_id, user_id, channel, target, payload
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     RETURNING id`,
    [trigger_log_id, alert_rule_id, user_id, channel, target,
     JSON.stringify(payload ?? {})]
  );
  return r.rows[0].id;
}

async function markSent(id) {
  await db.query(
    `UPDATE delivery_attempts
        SET status = 'sent',
            delivered_at = NOW(),
            attempt_count = attempt_count + 1,
            last_error = NULL
      WHERE id = $1`,
    [id]
  );
}

async function markFailed(id, error, willRetry) {
  await db.query(
    `UPDATE delivery_attempts
        SET status = $2,
            attempt_count = attempt_count + 1,
            last_error = $3
      WHERE id = $1`,
    [id, willRetry ? "retry" : "failed", String(error || "").slice(0, 2000)]
  );
}

module.exports = { create, markSent, markFailed };
