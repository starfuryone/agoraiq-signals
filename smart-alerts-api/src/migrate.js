#!/usr/bin/env node
"use strict";

require("dotenv").config({ override: true });
const fs = require("fs");
const path = require("path");
const db = require("./lib/db");
const log = require("./lib/logger");

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

async function run() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const applied = await db.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      [version]
    );
    if (applied.rowCount > 0) {
      log.info(`[migrate] skip ${version} (already applied)`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    log.info(`[migrate] applying ${version}`);
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version]
      );
      await client.query("COMMIT");
      log.info(`[migrate] applied ${version}`);
    } catch (err) {
      await client.query("ROLLBACK");
      log.error(`[migrate] failed ${version}: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }
  log.info("[migrate] done");
  process.exit(0);
}

run().catch(err => {
  log.error(err.stack || err.message);
  process.exit(1);
});
