#!/usr/bin/env node
"use strict";

require("dotenv").config({ override: true });

const { Worker } = require("bullmq");
const {
  deliveryQueue,
  PREFIX,
  CONCURRENCY,
  RATE_PER_SEC,
} = require("./queue/queues");
const { getBullConnection } = require("./lib/redis");
const db = require("./lib/db");
const DeliveryAttempt = require("./models/deliveryAttempt");
const telegram = require("./notifiers/telegram");
const log = require("./lib/logger");

async function main() {
  // Warm the Postgres pool — fail fast on misconfig.
  await db.query("SELECT 1");
  log.info("[worker] db ok");

  // Prime the queue so the Worker below shares its connection/prefix.
  deliveryQueue();

  const worker = new Worker(
    "sa-deliver",
    async (job) => {
      const { deliveryId } = job.data;
      const { rows } = await db.query(
        `SELECT da.id, da.channel, da.target, da.payload, da.user_id,
                da.alert_rule_id, ar.delivery_target AS rule_target
           FROM delivery_attempts da
           JOIN alert_rules ar ON ar.id = da.alert_rule_id
          WHERE da.id = $1`,
        [deliveryId]
      );
      if (rows.length === 0) {
        log.warn(`[worker] delivery ${deliveryId} missing`);
        return { skipped: true };
      }
      const row = rows[0];
      const target = row.target || row.rule_target;

      try {
        if (row.channel === "telegram") {
          await telegram.send(target, row.payload);
        } else {
          throw new Error(`unknown_channel:${row.channel}`);
        }
        await DeliveryAttempt.markSent(deliveryId);
        return { ok: true };
      } catch (err) {
        const willRetry = job.attemptsMade + 1 < (job.opts.attempts || 1);
        await DeliveryAttempt.markFailed(deliveryId, err.message, willRetry);
        throw err;   // let BullMQ schedule the retry w/ exponential backoff
      }
    },
    {
      connection: getBullConnection(),
      prefix: PREFIX,
      concurrency: CONCURRENCY,
      limiter: { max: RATE_PER_SEC, duration: 1000 },
    }
  );

  worker.on("completed", (job) => log.info(`[worker] done ${job.id}`));
  worker.on("failed", (job, err) => log.warn(`[worker] failed ${job?.id}: ${err?.message}`));
  worker.on("error", (err) => log.error("[worker] error:", err.message));

  const shutdown = async (sig) => {
    log.info(`[worker] ${sig} — shutting down`);
    try { await worker.close(); } catch {}
    try { await db.end(); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));

  log.info(`[worker] smart-alerts delivery worker online (concurrency=${CONCURRENCY}, rate=${RATE_PER_SEC}/s)`);
}

main().catch((err) => { log.error("[worker:fatal]", err.stack || err.message); process.exit(1); });
