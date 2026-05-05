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
 * Queue name uses dashes to satisfy BullMQ's name validation. The design
 * spec referred to it as "signal:ingest" — the colon is a documentation
 * convention, not a wire identifier.
 */
function ingestQueue() {
  return getQueue("signal-ingest");
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
  for (const q of Object.values(_queues)) {
    await q.close();
  }
  _queues = {};
}

module.exports = { pushQueue, resolverQueue, lifecycleQueue, ingestQueue, enrichQueue, closeQueues };
