/**
 * BullMQ queue definitions.
 *
 * Queue names use dashes (not colons) per your BullMQ conventions.
 */

const { Queue, QueueEvents } = require("bullmq");
const { getRedis } = require("../lib/redis");

let _queues = {};
let _queueEvents = {};

function getQueue(name) {
  if (!_queues[name]) {
    _queues[name] = new Queue(name, { connection: getRedis() });
  }
  return _queues[name];
}

function getQueueEvents(name) {
  if (!_queueEvents[name]) {
    _queueEvents[name] = new QueueEvents(name, { connection: getRedis() });
  }
  return _queueEvents[name];
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
 * Queue name uses dashes to satisfy BullMQ's name validation. The design
 * spec referred to it as "signal:ingest" — the colon is a documentation
 * convention, not a wire identifier.
 */
/**
 * Scanner watcher schedule queue: cron-like recurring trigger that wakes the
 * scanner worker. Distinct from data queues — only carries a single repeating
 * scan-cycle job.
 */
function scannerWatcherQueue() {
  return getQueue("agoraiq-scanner-watcher");
}

function ingestQueue() {
  return getQueue("signal-ingest");
}

/**
 * Shared QueueEvents instance for signal-ingest. BullMQ's
 * Job#waitUntilFinished requires a QueueEvents — passing a Queue silently
 * fails (the awaiter never resolves). Reuse one instance per process.
 */
function ingestQueueEvents() {
  return getQueueEvents("signal-ingest");
}

/**
 * Signal enrichment queue — async AI scoring on freshly ingested rows.
 *
 * The ingest worker enqueues onto signal-enrich after a successful INSERT.
 * The enrich worker is the only writer permitted to mutate `confidence` and
 * the `ai_*` keys inside `meta`. It never changes `status` (the resolver
 * owns lifecycle transitions).
 */
function enrichQueue() {
  return getQueue("signal-enrich");
}

async function closeQueues() {
  for (const qe of Object.values(_queueEvents)) {
    await qe.close();
  }
  _queueEvents = {};
  for (const q of Object.values(_queues)) {
    await q.close();
  }
  _queues = {};
}

module.exports = {
  pushQueue,
  resolverQueue,
  lifecycleQueue,
  ingestQueue,
  ingestQueueEvents,
  enrichQueue,
  scannerWatcherQueue,
  closeQueues,
};
