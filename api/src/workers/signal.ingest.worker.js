/**
 * Signal Ingest Worker — the SINGLE SOURCE OF TRUTH writer.
 *
 *   ┌─────────────┐   ┌──────────────┐   ┌─────────────┐
 *   │ Ingest API  │──▶│ signal:ingest│──▶│ this worker │──▶ signals_v2
 *   │ Scanner     │   │ (BullMQ)     │   │             │
 *   │ Providers   │   └──────────────┘   └──────┬──────┘
 *   └─────────────┘                             │
 *                                               ▼
 *                                        signal_events (CREATED)
 *                                        push queue (breakout)
 *
 * Contract:
 *   - This is the only component in the codebase permitted to INSERT into
 *     signals_v2. Any other writer is a bug.
 *   - Job payload is a fully validated, deduped, hashed signal — produced by
 *     lib/normalizer → lib/validator → lib/dedupe.
 *   - On insert, the unique partial index on signals_v2(hash) is the final
 *     dedupe backstop. A 23505 collision is treated as an idempotent success
 *     (the existing row is returned).
 *   - On any non-collision insert failure, the dedupe Redis reservation is
 *     released so a retry can proceed.
 *   - schema_version is hard-coded to v3_clean. Older rows in signals_v2
 *     without schema_version are pre-pipeline and remain readable.
 *
 * Job result shape (read by route via job.waitUntilFinished()):
 *   { ok: true, id, hash, idempotent? }
 *   { ok: false, reason, details }   ← only for non-recoverable failures;
 *                                      schema/dedupe errors are returned
 *                                      synchronously by the route, not here
 */

const { Worker } = require("bullmq");
const { getRedis } = require("../lib/redis");
const db = require("../lib/db");
const events = require("../lib/events");
const { releaseReservation } = require("../lib/dedupe");
const { SCHEMA_VERSION } = require("../lib/strategy");
const { pushQueue, enrichQueue } = require("./queues");

const QUEUE_NAME = "signal:ingest";
const CONCURRENCY = parseInt(process.env.INGEST_WORKER_CONCURRENCY || "4", 10);

async function processIngestJob(job) {
  const payload = job.data;

  if (!payload || !payload.hash) {
    return { ok: false, reason: "missing_hash" };
  }

  const meta = payload.meta && typeof payload.meta === "object" ? payload.meta : {};
  if (payload.validation) {
    meta.validation = payload.validation;
  }
  if (payload.signal_ts) {
    meta.signal_ts = payload.signal_ts;
  }

  const targets = Array.isArray(payload.targets) ? payload.targets : [];
  const risk = payload.validation && payload.validation.risk;
  const reward = payload.validation && payload.validation.reward;
  const rr = payload.validation && payload.validation.rr;
  const signalTsIso = payload.signal_ts
    ? new Date(payload.signal_ts).toISOString()
    : new Date().toISOString();

  let saved;
  try {
    const r = await db.query(
      `INSERT INTO signals_v2
         (symbol, type, direction, entry, stop, targets, leverage,
          confidence, provider, provider_id, source, bot_user_id,
          status, meta,
          hash, schema_version, strategy, timeframe, signal_ts,
          risk, reward, rr, raw_payload)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,
          $8,$9,$10,$11,$12,
          $13,$14,
          $15,$16,$17,$18,$19,
          $20,$21,$22,$23)
       RETURNING *`,
      [
        payload.symbol,
        payload.type || strategyToType(payload.strategy),
        payload.direction,
        payload.entry,
        payload.stop,
        JSON.stringify(targets),
        payload.leverage || null,
        payload.confidence != null ? payload.confidence : null,
        payload.provider || null,
        payload.provider_id || null,
        payload.source,
        payload.bot_user_id || null,
        "OPEN",
        JSON.stringify(meta),
        payload.hash,
        SCHEMA_VERSION,
        payload.strategy,
        payload.timeframe,
        signalTsIso,
        risk != null ? risk : null,
        reward != null ? reward : null,
        rr != null ? rr : null,
        payload.raw_payload || null,
      ]
    );
    saved = r.rows[0];
  } catch (err) {
    if (err.code === "23505") {
      // Unique violation on hash — another worker won the race. Idempotent success.
      const existing = await db.query(
        "SELECT * FROM signals_v2 WHERE hash = $1 LIMIT 1",
        [payload.hash]
      );
      if (existing.rows.length > 0) {
        return {
          ok: true,
          id: existing.rows[0].id,
          hash: payload.hash,
          idempotent: true,
        };
      }
    }
    // Any other DB error: release the dedupe reservation so retries can proceed.
    await releaseReservation(payload.hash);
    throw err;
  }

  // Lifecycle audit. Failure here does not invalidate the ingestion.
  try {
    await events.logEvent(saved.id, "CREATED", {
      newStatus: "OPEN",
      priceAt: saved.entry,
      meta: {
        source: saved.source,
        strategy: payload.strategy,
        schema_version: SCHEMA_VERSION,
        hash: payload.hash,
      },
    });
  } catch (err) {
    console.warn("[ingest] event log failed:", err.message);
  }

  // Downstream push notification (preserves existing scanner/manual UX).
  // Only enqueue for sources that historically produced pushes.
  if (saved.source === "scanner" || saved.source === "user" || saved.source === "provider") {
    try {
      await pushQueue().add("breakout", saved);
    } catch (err) {
      console.warn("[ingest] push enqueue failed:", err.message);
    }
  }

  // Async AI enrichment. The enrich worker is the only writer that mutates
  // confidence/meta.ai_*. Idempotent — jobId = signal id, so a duplicate
  // enqueue (e.g. if the ingest job is replayed) coalesces to one job.
  try {
    await enrichQueue().add(
      "enrich",
      { signal_id: saved.id },
      {
        jobId: `enrich-${saved.id}`,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      }
    );
  } catch (err) {
    console.warn("[ingest] enrich enqueue failed:", err.message);
  }

  return { ok: true, id: saved.id, hash: payload.hash };
}

function strategyToType(strategy) {
  if (!strategy) return "manual";
  if (strategy.startsWith("breakout")) return "breakout";
  if (strategy.startsWith("mean_reversion")) return "mean_reversion";
  if (strategy.startsWith("scanner")) return "manual";
  return "manual";
}

function startIngestWorker() {
  const worker = new Worker(QUEUE_NAME, processIngestJob, {
    connection: getRedis(),
    concurrency: CONCURRENCY,
  });

  worker.on("failed", (job, err) => {
    console.error(
      `[ingest] job ${job && job.id} failed: ${err.message}` +
        (job && job.data && job.data.hash ? ` hash=${job.data.hash.slice(0, 12)}` : "")
    );
  });

  worker.on("completed", (job, result) => {
    if (result && result.ok) {
      const tag = result.idempotent ? " [idempotent]" : "";
      console.log(
        `[ingest] job ${job.id} → signal #${result.id}${tag} ` +
          `(${job.data.symbol} ${job.data.direction} ${job.data.strategy})`
      );
    }
  });

  console.log(`[ingest-worker] started (concurrency=${CONCURRENCY}, queue=${QUEUE_NAME})`);
  return worker;
}

module.exports = { startIngestWorker, processIngestJob };
