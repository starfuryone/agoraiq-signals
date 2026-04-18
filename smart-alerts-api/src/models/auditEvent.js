"use strict";

const db = require("../lib/db");
const log = require("../lib/logger");

async function record({ user_id = null, actor, action, target_type = null, target_id = null, metadata = {} }) {
  try {
    await db.query(
      `INSERT INTO audit_events (user_id, actor, action, target_type, target_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [user_id, actor, action, target_type, target_id && String(target_id),
       JSON.stringify(metadata ?? {})]
    );
  } catch (e) {
    log.warn("[audit] failed to record:", e.message);
  }
}

module.exports = { record };
