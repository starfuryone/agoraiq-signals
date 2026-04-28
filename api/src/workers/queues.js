/**
 * BullMQ queue definitions.
 *
 * Queue names use dashes (not colons) per your BullMQ conventions.
 */

const { Queue } = require("bullmq");
const { getRedis } = require("../lib/redis");

let _queues = {};

function getQueue(name) {
  if (!_queues[name]) {
    _queues[name] = new Queue(name, { connection: getRedis() });
  }
  return _queues[name];
}

// ── Queue accessors ──────────────────────────────────────────────

/** Push notification jobs: breakout alerts, outcomes, daily summaries */
function pushQueue() {
  return getQueue("agoraiq-push-alerts");
}

/** Signal resolution jobs: check active signals against prices */
function resolverQueue() {
  return getQueue("agoraiq-signal-resolver");
}

/** Signal lifecycle events: created, updated, resolved */
function lifecycleQueue() {
  return getQueue("agoraiq-signal-lifecycle");
}

/**
 * Signal ingestion queue — the SOLE path into signals_v2.
 *
 * Producers (HTTP routes, scanner watcher, future external pushes) enqueue
 * here; the ingest worker is the only consumer that writes to the database.
 *
 * Queue name uses a colon to match the system spec ("signal:ingest"). All
 * other AgoraIQ queues use dashes — this is intentional: the colon name
 * makes the single-source-of-truth queue impossible to confuse with the
 * legacy push/resolver queues at a glance in monitoring.
 */
function ingestQueue() {
  return getQueue("signal:ingest");
}

async function closeQueues() {
  for (const q of Object.values(_queues)) {
    await q.close();
  }
  _queues = {};
}

module.exports = { pushQueue, resolverQueue, lifecycleQueue, ingestQueue, closeQueues };
