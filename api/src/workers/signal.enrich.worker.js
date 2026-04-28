/**
 * Signal Enrichment Worker — async AI scoring of freshly ingested signals.
 *
 *   ingest worker INSERTs row → enqueues `signal:enrich` job →
 *   this worker → ai.scoreSignal() → UPDATE confidence + meta.ai_*
 *
 * Design contract:
 *   - This worker is the ONLY writer permitted to touch `confidence` and
 *     the `ai_*` keys inside `meta`. The resolver and the ingest worker
 *     do not write these fields.
 *   - It NEVER changes `status`, `result`, `duration_sec`, `resolved_at`,
 *     `targets`, `entry`, or `stop`. Lifecycle transitions belong to the
 *     resolver; trade plans belong to the ingest worker.
 *   - It is idempotent: a row with `meta.ai_score` already populated is
 *     skipped. Re-running the queue is safe.
 *   - It is best-effort: AI scoring failures are logged but do not retry
 *     forever (3 attempts, exponential backoff). A signal without AI
 *     metadata is still tradable; the resolver and dashboards tolerate
 *     missing `confidence`.
 *
 * Why a separate worker:
 *   Inline AI scoring on `/submit` made ingestion non-deterministic and
 *   coupled to a third-party API (Perplexity). Decoupling lets the
 *   ingestion path stay fast and database-only, while AI scoring runs
 *   asynchronously with its own concurrency, retry, and timeout budget.
 *
 * Concurrency:
 *   Default 2. AI calls are I/O bound and the rate-limit on Perplexity is
 *   the constraint, not CPU.
 */

const { Worker } = require("bullmq");
const { getRedis } = require("../lib/redis");
const db = require("../lib/db");
const ai = require("../lib/ai");

const QUEUE_NAME = "signal:enrich";
const CONCURRENCY = parseInt(process.env.ENRICH_WORKER_CONCURRENCY || "2", 10);

async function processEnrichJob(job) {
  const { signal_id: signalId } = job.data || {};
  if (!Number.isFinite(signalId)) {
    return { ok: false, reason: "missing_signal_id" };
  }

  // Snapshot the row. Read-only — the AI call has no need for a row lock.
  const r = await db.query(
    `SELECT id, symbol, direction, entry, stop, targets, leverage, status, meta
     FROM signals_v2 WHERE id = $1`,
    [signalId]
  );
  if (r.rows.length === 0) {
    return { ok: false, reason: "signal_not_found" };
  }
  const row = r.rows[0];

  // Idempotency: don't re-score a row that already has AI metadata.
  const existingMeta = parseMeta(row.meta);
  if (existingMeta.ai_score != null) {
    return { ok: true, skipped: true, reason: "already_scored" };
  }

  // Don't waste an AI call on a signal that has already resolved between
  // ingestion and enrichment (TP/SL/EXPIRED/CANCELLED).
  if (row.status !== "OPEN") {
    return { ok: true, skipped: true, reason: `status_${row.status.toLowerCase()}` };
  }

  const targets = parseTargets(row.targets);

  let aiResult;
  try {
    aiResult = await ai.scoreSignal({
      symbol: row.symbol,
      direction: row.direction,
      entry: row.entry != null ? parseFloat(row.entry) : null,
      stop: row.stop != null ? parseFloat(row.stop) : null,
      targets,
      leverage: row.leverage,
      volume_change: existingMeta.volume_change,
      oi_direction: existingMeta.oi_direction,
      funding_rate: existingMeta.funding_rate,
    });
  } catch (err) {
    // ai.scoreSignal already falls back to heuristic on most errors. A throw
    // here means something deeper broke (network, JSON parse). Let BullMQ
    // retry per the job's attempts/backoff config.
    throw new Error(`ai.scoreSignal failed for #${signalId}: ${err.message}`);
  }

  if (!aiResult || typeof aiResult.score !== "number") {
    return { ok: false, reason: "ai_returned_no_score" };
  }

  // Build the meta delta. Only ai_* keys are added; we never overwrite a
  // user-supplied meta key.
  const metaUpdate = {
    ai_score: aiResult.score,
    ai_provider: aiResult.provider || null,
    ai_model: aiResult.model || null,
    ai_regime: aiResult.regime || null,
    ai_risk_flags: Array.isArray(aiResult.risk_flags) ? aiResult.risk_flags : [],
    ai_reasoning: aiResult.reasoning || null,
    ai_scored_at: new Date().toISOString(),
  };
  if (aiResult.score_breakdown) metaUpdate.ai_score_breakdown = aiResult.score_breakdown;
  if (aiResult.thesis) metaUpdate.ai_thesis = aiResult.thesis;
  if (aiResult.tags && aiResult.tags.length) metaUpdate.ai_tags = aiResult.tags;

  // Atomic JSONB merge with state guard: only touch the row if no other
  // worker has scored it in the meantime AND the row is still OPEN.
  // jsonb || jsonb is right-biased, so our keys win without clobbering
  // unrelated keys (volume_change, exchange, etc.).
  const upd = await db.query(
    `UPDATE signals_v2
     SET confidence = $1,
         meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $3
       AND status = 'OPEN'
       AND (meta IS NULL OR meta->>'ai_score' IS NULL)`,
    [aiResult.score, JSON.stringify(metaUpdate), signalId]
  );

  if (upd.rowCount === 0) {
    return { ok: true, skipped: true, reason: "lost_race_or_resolved" };
  }

  return {
    ok: true,
    signal_id: signalId,
    score: aiResult.score,
    provider: aiResult.provider || null,
  };
}

function parseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === "object" && !Array.isArray(meta)) return meta;
  try { return JSON.parse(meta); } catch { return {}; }
}

function parseTargets(targets) {
  if (!targets) return [];
  if (Array.isArray(targets)) return targets.map((n) => parseFloat(n)).filter(Number.isFinite);
  try {
    const parsed = JSON.parse(targets);
    return Array.isArray(parsed) ? parsed.map((n) => parseFloat(n)).filter(Number.isFinite) : [];
  } catch { return []; }
}

function startEnrichWorker() {
  const worker = new Worker(QUEUE_NAME, processEnrichJob, {
    connection: getRedis(),
    concurrency: CONCURRENCY,
  });

  worker.on("completed", (job, result) => {
    if (result && result.ok && !result.skipped) {
      console.log(
        `[enrich] #${result.signal_id} scored=${result.score} ` +
        `provider=${result.provider || "heuristic"}`
      );
    }
  });

  worker.on("failed", (job, err) => {
    const sid = job && job.data && job.data.signal_id;
    console.error(`[enrich] job ${job && job.id} (signal #${sid}) failed: ${err.message}`);
  });

  console.log(`[enrich-worker] started (concurrency=${CONCURRENCY}, queue=${QUEUE_NAME})`);
  return worker;
}

module.exports = { startEnrichWorker, processEnrichJob };
