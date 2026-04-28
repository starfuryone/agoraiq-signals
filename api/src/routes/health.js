/**
 * Health + observability endpoints.
 *
 *   GET /health/ingest   — ingestion-pipeline JSON health
 *   GET /metrics         — Prometheus text exposition
 *
 * Both are unauthenticated by design — they're meant to be scraped by
 * monitoring tooling. They expose only counters, gauges, queue depths,
 * and pipeline last-success timestamps. No PII, no signal payloads.
 *
 * If you front this service with a public ingress, scope these routes to
 * an internal-only path or behind the metrics-scraper IP allowlist at the
 * reverse-proxy layer (Caddy/nginx); the application does not enforce that.
 */

const { Router } = require("express");
const db = require("../lib/db");
const metrics = require("../lib/metrics");
const { ingestQueue, enrichQueue, pushQueue, resolverQueue } = require("../workers/queues");

const router = Router();

// ── GET /metrics ───────────────────────────────────────────────────────────

router.get("/metrics", async (req, res) => {
  // Refresh queue-depth gauges on every scrape so the snapshot is current.
  // This is cheap (Redis HLEN-style calls) and only runs at the scrape rate.
  try {
    await Promise.all([
      pollQueueDepth("signal:ingest", ingestQueue()),
      pollQueueDepth("signal:enrich", enrichQueue()),
      pollQueueDepth("agoraiq-push-alerts", pushQueue()),
      pollQueueDepth("agoraiq-signal-resolver", resolverQueue()),
    ]);
  } catch (err) {
    // A queue refresh failure must not break the metrics endpoint —
    // stale gauges are still useful.
    console.warn("[metrics] queue depth refresh failed:", err.message);
  }

  res.set("Content-Type", "text/plain; version=0.0.4");
  res.send(metrics.render());
});

// ── GET /health/ingest ─────────────────────────────────────────────────────

router.get("/health/ingest", async (req, res) => {
  const now = Math.floor(Date.now() / 1000);

  let queueDepths = {};
  try {
    const queues = {
      "signal:ingest": ingestQueue(),
      "signal:enrich": enrichQueue(),
      "agoraiq-signal-resolver": resolverQueue(),
    };
    for (const [name, q] of Object.entries(queues)) {
      queueDepths[name] = await q.getJobCounts("waiting", "active", "delayed", "failed");
    }
  } catch (err) {
    queueDepths = { error: err.message };
  }

  // Pipeline-level heartbeat: how long ago was the last successful job per
  // worker. A worker with no last-success is reported as null (never run
  // since process restart), not 0.
  const heartbeats = {
    gateway: heartbeat(metrics.getGauge("agoraiq_ingest_last_success_unix", { worker: "gateway" }), now),
    ingest: heartbeat(metrics.getGauge("agoraiq_ingest_last_success_unix", { worker: "ingest" }), now),
    enrich: heartbeat(metrics.getGauge("agoraiq_enrich_last_success_unix", {}), now),
    resolver: heartbeat(metrics.getGauge("agoraiq_resolver_last_run_unix", {}), now),
  };

  // Recent rejection rate: what's the ratio of rejections to acceptances
  // since process start? A spike here is the usual canary for a payload-
  // format change at a producer (scanner config, provider parser drift).
  const persisted = sumCounter("agoraiq_ingest_total", { stage: "persisted", outcome: "accepted" });
  const rejected = sumByStage();
  const totalDecisions = persisted + (rejected.normalize + rejected.validate + rejected.dedupe);
  const rejectionRate = totalDecisions > 0 ? rejected.total / totalDecisions : 0;

  // DB connectivity smoke check.
  let dbOk = false;
  try {
    await db.query("SELECT 1");
    dbOk = true;
  } catch {
    dbOk = false;
  }

  res.json({
    status: dbOk ? "ok" : "degraded",
    schema_version: "v3_clean",
    db: dbOk,
    queue_depths: queueDepths,
    heartbeats,
    counts_since_start: {
      persisted,
      rejected_normalize: rejected.normalize,
      rejected_validate: rejected.validate,
      rejected_dedupe: rejected.dedupe,
      enriched: sumCounter("agoraiq_enrich_total", { outcome: "scored" }),
      enrich_failed: sumCounter("agoraiq_enrich_total", { outcome: "failed" }),
      resolver_transitions: {
        TP1: sumCounter("agoraiq_resolver_transitions_total", { transition: "TP1" }),
        TP2: sumCounter("agoraiq_resolver_transitions_total", { transition: "TP2" }),
        TP3: sumCounter("agoraiq_resolver_transitions_total", { transition: "TP3" }),
        SL: sumCounter("agoraiq_resolver_transitions_total", { transition: "SL" }),
        EXPIRED: sumCounter("agoraiq_resolver_transitions_total", { transition: "EXPIRED" }),
        skipped: sumCounter("agoraiq_resolver_transitions_total", { transition: "skipped" }),
      },
    },
    rejection_rate: round(rejectionRate, 4),
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

async function pollQueueDepth(label, queue) {
  const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");
  for (const [state, depth] of Object.entries(counts)) {
    metrics.setGauge("agoraiq_ingest_queue_depth", { queue: label, state }, depth);
  }
}

function heartbeat(unix, now) {
  if (!Number.isFinite(unix)) return null;
  return { last_success_unix: unix, age_sec: now - unix };
}

function sumCounter(name, filter) {
  return metrics.sumCounterByLabels(name, filter);
}

function sumByStage() {
  const stages = ["normalize", "validate", "dedupe"];
  const out = { total: 0 };
  for (const stage of stages) {
    out[stage] = sumCounter("agoraiq_ingest_rejections_total", { stage });
    out.total += out[stage];
  }
  return out;
}

function round(n, digits) {
  if (!Number.isFinite(n)) return n;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

module.exports = router;
