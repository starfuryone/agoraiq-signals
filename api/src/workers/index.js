/**
 * Worker process — runs all BullMQ workers.
 *
 * Start separately from the API:
 *   node src/workers/index.js
 *
 * Or via PM2:
 *   pm2 start src/workers/index.js --name agoraiq-workers
 *
 * Workers:
 *   - push:     sends Telegram notifications
 *   - resolver: checks active signals against prices
 *   - scanner:  detects breakouts, emits alerts
 *   - daily:    sends morning summary
 */

require("dotenv").config();

const { startPushWorker } = require("./push");
const { startResolverWorker } = require("./resolver");
const { startScannerWatcher } = require("./scanner");
const { startDailyWorker } = require("./daily");
const { startIngestWorker } = require("./signal.ingest.worker");
const { closeQueues } = require("./queues");
const { closeRedis } = require("../lib/redis");
const db = require("../lib/db");

async function main() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  AgoraIQ Workers Starting");
  console.log("═══════════════════════════════════════════════════════");

  // Verify connections
  try {
    await db.query("SELECT 1");
    console.log("[db] connected");
  } catch (err) {
    console.error("[db] connection failed:", err.message);
    process.exit(1);
  }

  try {
    const { getRedis } = require("../lib/redis");
    await getRedis().ping();
    console.log("[redis] connected");
  } catch (err) {
    console.error("[redis] connection failed:", err.message);
    process.exit(1);
  }

  // Start all workers. The ingest worker comes first because it is the
  // sole writer to signals_v2 — every other producer expects it to be live.
  const workers = [];
  workers.push(startIngestWorker());
  workers.push(startPushWorker());
  workers.push(startResolverWorker());
  workers.push(startScannerWatcher());
  workers.push(startDailyWorker());

  console.log(`\n[workers] ${workers.length} workers running`);
  console.log("  • signal-ingest:   Single-writer ingestion (signals_v2)");
  console.log("  • push-alerts:     Telegram push notifications");
  console.log("  • signal-resolver: Price checking + outcome resolution");
  console.log("  • scanner-watcher: Breakout detection + alerts");
  console.log("  • daily-summary:   Morning brief");
  console.log("");

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n[shutdown] ${signal} received`);
    for (const w of workers) {
      await w.close();
    }
    await closeQueues();
    await closeRedis();
    await db.end();
    console.log("[shutdown] complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
