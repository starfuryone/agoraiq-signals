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

async function closeQueues() {
  for (const q of Object.values(_queues)) {
    await q.close();
  }
  _queues = {};
}

module.exports = { pushQueue, resolverQueue, lifecycleQueue, closeQueues };
