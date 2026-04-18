"use strict";

const { Pool } = require("pg");
const log = require("./logger");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[FATAL] DATABASE_URL is not set.");
  process.exit(1);
}

// Guardrail: refuse to boot if this pool is pointed at the main app's DB.
// The main app's DB name is agoraiq_signals. This service must use
// agoraiq_smart_alerts (or any other name; just never agoraiq_signals).
try {
  const dbName = new URL(url).pathname.replace(/^\//, "");
  if (dbName === "agoraiq_signals") {
    console.error(
      "[FATAL] smart-alerts-api DATABASE_URL points at agoraiq_signals. " +
      "This service must use its own database. Refusing to start."
    );
    process.exit(1);
  }
} catch {
  /* malformed URL — the pool will error clearly on first use */
}

const pool = new Pool({
  connectionString: url,
  max: parseInt(process.env.PG_POOL_MAX || "10", 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => log.error("[db] pool error:", err.message));

module.exports = pool;
