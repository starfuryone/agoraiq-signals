"use strict";

const db = require("../lib/db");

const PUBLIC_COLUMNS = `
  id, user_id, plan_tier, name, natural_language, rule_json,
  cooldown_seconds, daily_limit, priority, status, match_count,
  last_matched_at, parse_confidence, parse_source,
  delivery_channel, delivery_target, created_at, updated_at
`;

async function create(row) {
  const r = await db.query(
    `INSERT INTO alert_rules (
       user_id, plan_tier, name, natural_language, rule_json,
       cooldown_seconds, daily_limit, priority,
       parse_confidence, parse_source, delivery_channel, delivery_target
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      row.user_id, row.plan_tier, row.name, row.natural_language,
      row.rule_json, row.cooldown_seconds, row.daily_limit, row.priority,
      row.parse_confidence, row.parse_source,
      row.delivery_channel || "telegram",
      row.delivery_target || null,
    ]
  );
  return r.rows[0];
}

async function findByUser(userId) {
  const r = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM alert_rules
      WHERE user_id = $1 AND status <> 'deleted'
      ORDER BY created_at DESC`,
    [userId]
  );
  return r.rows;
}

async function findById(id, userId) {
  const r = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM alert_rules
      WHERE id = $1 AND user_id = $2 AND status <> 'deleted'`,
    [id, userId]
  );
  return r.rows[0] || null;
}

async function countActive(userId) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM alert_rules
      WHERE user_id = $1 AND status IN ('active', 'paused')`,
    [userId]
  );
  return r.rows[0].n;
}

async function setStatus(id, userId, status) {
  const r = await db.query(
    `UPDATE alert_rules SET status = $3
      WHERE id = $1 AND user_id = $2 AND status <> 'deleted'
      RETURNING ${PUBLIC_COLUMNS}`,
    [id, userId, status]
  );
  return r.rows[0] || null;
}

async function softDelete(id, userId) {
  const r = await db.query(
    `UPDATE alert_rules SET status = 'deleted'
      WHERE id = $1 AND user_id = $2 AND status <> 'deleted'
      RETURNING id`,
    [id, userId]
  );
  return r.rowCount > 0;
}

async function listAllActive() {
  const r = await db.query(
    `SELECT ${PUBLIC_COLUMNS} FROM alert_rules WHERE status = 'active'`
  );
  return r.rows;
}

async function incrementMatchCount(id) {
  await db.query(
    `UPDATE alert_rules
        SET match_count = match_count + 1,
            last_matched_at = NOW()
      WHERE id = $1`,
    [id]
  );
}

module.exports = {
  create,
  findByUser,
  findById,
  countActive,
  setStatus,
  softDelete,
  listAllActive,
  incrementMatchCount,
};
