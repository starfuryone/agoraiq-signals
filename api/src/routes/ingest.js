/**
 * POST /api/v1/signals/ingest
 *
 * Single ingestion gateway. Accepts payloads from any source (Telegram
 * free-text, scanner structured, external API), runs them through:
 *
 *   normalize → validate → dedupe → enqueue (signal:ingest)
 *
 * NEVER writes to signals_v2 directly. The DB write happens inside
 * workers/signal.ingest.worker.js. Synchronous callers receive the worker
 * result via job.waitUntilFinished() with a bounded timeout — this preserves
 * the existing API contract (callers get the saved row back) while keeping
 * the worker as the sole writer.
 *
 * Rejections (normalize / validate / dedupe failures) are persisted to
 * signals_rejected and returned as 4xx responses with a structured reason.
 *
 * Auth model:
 *   - Authenticated callers (Bearer JWT): bot_user_id MUST match req.userId.
 *   - Unauthenticated machine-to-machine callers: must present a valid
 *     X-Internal-Token (constant-time-compared against INGEST_SERVICE_TOKEN).
 *     Without that header, the body's bot_user_id is dropped — no caller can
 *     forge ownership of another user's signal.
 *
 * Request body shape:
 *   {
 *     raw_text?:   string,            // Telegram free-text path
 *     structured?: {                  // structured path
 *       symbol, direction, entry, stop, targets, ...
 *     },
 *     source:      "scanner" | "provider" | "user" | "api" | "manual",
 *     provider?:   string,
 *     strategy?:   string,
 *     timeframe?:  string,
 *     signal_ts?:  number  (unix ms),
 *     bot_user_id?: number,
 *     leverage?:   string,
 *     confidence?: number,
 *     meta?:       object
 *   }
 */

const crypto = require("crypto");
const { Router } = require("express");
const db = require("../lib/db");
const { optionalAuth } = require("../middleware/auth");
const { normalize, NormalizationError } = require("../lib/normalizer");
const { validate } = require("../lib/validator");
const { checkAndReserve, releaseReservation } = require("../lib/dedupe");
const { ingestQueue, ingestQueueEvents } = require("../workers/queues");
const metrics = require("../lib/metrics");

const router = Router();

const WAIT_TIMEOUT_MS = parseInt(process.env.INGEST_WAIT_TIMEOUT_MS || "10000", 10);
const SERVICE_TOKEN = process.env.INGEST_SERVICE_TOKEN || "";

function hasValidServiceToken(req) {
  if (!SERVICE_TOKEN) return false;
  const provided = req.headers["x-internal-token"];
  if (!provided || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(SERVICE_TOKEN);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function toUserId(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Resolve which bot_user_id (if any) the caller is permitted to attribute
 * the signal to. Returns either { userId } or { error: <403-message> }.
 */
function resolveBotUserId(req, body) {
  const claimed = toUserId(body.bot_user_id);
  const authed = toUserId(req.userId);

  if (authed) {
    if (claimed && claimed !== authed) {
      return { error: "bot_user_id mismatch with authenticated user" };
    }
    return { userId: authed };
  }

  if (!claimed) return { userId: null };

  // Unauthenticated caller claiming a user — only allowed with service token.
  if (hasValidServiceToken(req)) return { userId: claimed };
  return { error: "bot_user_id requires authentication or service token" };
}

router.post("/", optionalAuth, async (req, res) => {
  const body = req.body || {};

  const auth = resolveBotUserId(req, body);
  if (auth.error) return res.status(403).json({ error: auth.error });
  const botUserId = auth.userId;

  // ── 1. Normalize ─────────────────────────────────────────────────────────
  let canonical;
  try {
    canonical = normalize({
      raw_text: body.raw_text,
      structured: body.structured,
      source: body.source,
      provider: body.provider,
      strategy: body.strategy,
      timeframe: body.timeframe,
      signal_ts: body.signal_ts,
    });
  } catch (err) {
    if (err instanceof NormalizationError) {
      await recordRejection({
        stage: "normalize",
        reason: err.reason,
        meta: err.details,
        source: body.source,
        provider: body.provider,
        botUserId,
        rawPayload: rawString(body),
        normalizedPayload: null,
      });
      return res.status(422).json({ error: "normalization_failed", reason: err.reason, details: err.details });
    }
    console.error("[ingest] unexpected normalizer error:", err);
    return res.status(500).json({ error: "internal_error" });
  }

  // Attach optional caller-supplied fields that aren't part of the canonical
  // schema but are persisted with the row.
  const enriched = {
    ...canonical,
    bot_user_id: botUserId,
    leverage: body.leverage || null,
    confidence: typeof body.confidence === "number" ? body.confidence : null,
    provider_id: body.provider_id || null,
    meta: body.meta && typeof body.meta === "object" ? { ...body.meta } : {},
  };

  // ── 2. Validate ──────────────────────────────────────────────────────────
  const v = validate(enriched);
  if (!v.ok) {
    await recordRejection({
      stage: "validate",
      reason: v.reason,
      meta: v.details,
      source: enriched.source,
      provider: enriched.provider,
      botUserId,
      rawPayload: enriched.raw_payload,
      normalizedPayload: enriched,
    });
    return res.status(422).json({ error: "validation_failed", reason: v.reason, details: v.details });
  }

  const validated = v.validated;

  // ── 3. Dedupe ────────────────────────────────────────────────────────────
  const dedupe = await checkAndReserve(validated);
  if (dedupe.duplicate) {
    await recordRejection({
      stage: "dedupe",
      reason: "duplicate_within_window",
      meta: { hash: dedupe.hash, source: dedupe.source, existing_id: dedupe.existing_id || null },
      source: validated.source,
      provider: validated.provider,
      botUserId,
      rawPayload: validated.raw_payload,
      normalizedPayload: validated,
    });
    return res.status(409).json({
      error: "duplicate_signal",
      hash: dedupe.hash,
      existing_id: dedupe.existing_id || null,
    });
  }

  const jobPayload = {
    ...validated,
    hash: dedupe.hash,
  };

  // ── 4. Enqueue ───────────────────────────────────────────────────────────
  let job;
  try {
    job = await ingestQueue().add("ingest", jobPayload, {
      jobId: dedupe.hash, // BullMQ-level idempotency
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
    });
  } catch (err) {
    console.error("[ingest] enqueue failed:", err.message);
    // Reservation would otherwise hold the hash for 2× the dedupe window.
    await releaseReservation(dedupe.hash);
    return res.status(503).json({ error: "ingest_queue_unavailable" });
  }

  // ── 5. Wait for the worker (bounded). The worker is the sole DB writer. ──
  let result;
  try {
    result = await job.waitUntilFinished(ingestQueueEvents(), WAIT_TIMEOUT_MS);
  } catch (err) {
    // Job is queued; client can poll later via /signals/:id once persisted.
    return res.status(202).json({
      status: "queued",
      hash: dedupe.hash,
      job_id: job.id,
      message: "Ingest accepted; persistence is in-flight.",
    });
  }

  if (!result || !result.ok) {
    return res.status(500).json({ error: "ingest_worker_failed", details: result || null });
  }

  return res.status(201).json({
    status: result.idempotent ? "already_ingested" : "ingested",
    id: result.id,
    hash: result.hash,
    schema_version: "v3_clean",
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

async function recordRejection({
  stage,
  reason,
  meta,
  source,
  provider,
  botUserId,
  rawPayload,
  normalizedPayload,
}) {
  metrics.incCounter("agoraiq_ingest_total", {
    stage,
    source: source || "unknown",
    strategy: (normalizedPayload && normalizedPayload.strategy) || "unknown",
    outcome: "rejected",
  });
  metrics.incCounter("agoraiq_ingest_rejections_total", { stage, reason });

  try {
    await db.query(
      `INSERT INTO signals_rejected
         (source, provider, bot_user_id, raw_payload, normalized_payload,
          rejection_stage, rejection_reason, rejection_meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        source || null,
        provider || null,
        botUserId || null,
        rawPayload || null,
        normalizedPayload ? JSON.stringify(normalizedPayload) : null,
        stage,
        reason,
        JSON.stringify(meta || {}),
      ]
    );
  } catch (err) {
    // The audit trail is best-effort; surface the failure as a metric so
    // operators can alert on it instead of silently losing rejections.
    metrics.incCounter("agoraiq_ingest_rejection_persist_failed_total", { stage });
    console.error("[ingest] rejection persist failed:", err.message);
  }
}

function rawString(body) {
  if (typeof body.raw_text === "string") return body.raw_text;
  try { return JSON.stringify(body); } catch { return null; }
}

/**
 * Internal helper for in-process producers (HTTP routes, scanner worker)
 * that want to bypass HTTP and run the same pipeline. Same contract as the
 * route handler but returns a structured object instead of writing a response.
 */
async function ingestInternal({ payload, botUserId }) {
  let canonical;
  try {
    canonical = normalize({
      raw_text: payload.raw_text,
      structured: payload.structured,
      source: payload.source,
      provider: payload.provider,
      strategy: payload.strategy,
      timeframe: payload.timeframe,
      signal_ts: payload.signal_ts,
    });
  } catch (err) {
    if (err instanceof NormalizationError) {
      await recordRejection({
        stage: "normalize",
        reason: err.reason,
        meta: err.details,
        source: payload.source,
        provider: payload.provider,
        botUserId,
        rawPayload: rawString(payload),
        normalizedPayload: null,
      });
      return { ok: false, http_status: 422, error: "normalization_failed", reason: err.reason, details: err.details };
    }
    throw err;
  }

  const enriched = {
    ...canonical,
    bot_user_id: botUserId || null,
    leverage: payload.leverage || null,
    confidence: typeof payload.confidence === "number" ? payload.confidence : null,
    provider_id: payload.provider_id || null,
    meta: payload.meta && typeof payload.meta === "object" ? { ...payload.meta } : {},
  };

  const v = validate(enriched);
  if (!v.ok) {
    await recordRejection({
      stage: "validate",
      reason: v.reason,
      meta: v.details,
      source: enriched.source,
      provider: enriched.provider,
      botUserId,
      rawPayload: enriched.raw_payload,
      normalizedPayload: enriched,
    });
    return { ok: false, http_status: 422, error: "validation_failed", reason: v.reason, details: v.details };
  }

  const validated = v.validated;
  const dedupe = await checkAndReserve(validated);
  if (dedupe.duplicate) {
    await recordRejection({
      stage: "dedupe",
      reason: "duplicate_within_window",
      meta: { hash: dedupe.hash, source: dedupe.source, existing_id: dedupe.existing_id || null },
      source: validated.source,
      provider: validated.provider,
      botUserId,
      rawPayload: validated.raw_payload,
      normalizedPayload: validated,
    });
    return { ok: false, http_status: 409, error: "duplicate_signal", hash: dedupe.hash, existing_id: dedupe.existing_id || null };
  }

  const jobPayload = { ...validated, hash: dedupe.hash };
  let job;
  try {
    job = await ingestQueue().add("ingest", jobPayload, {
      jobId: dedupe.hash,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
      attempts: 3,
      backoff: { type: "exponential", delay: 500 },
    });
  } catch (err) {
    console.error("[ingest:internal] enqueue failed:", err.message);
    await releaseReservation(dedupe.hash);
    return { ok: false, http_status: 503, error: "ingest_queue_unavailable" };
  }

  let result;
  try {
    result = await job.waitUntilFinished(ingestQueueEvents(), WAIT_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, http_status: 202, status: "queued", hash: dedupe.hash, job_id: job.id };
  }

  if (!result || !result.ok) {
    return { ok: false, http_status: 500, error: "ingest_worker_failed" };
  }

  return { ok: true, http_status: 201, id: result.id, hash: result.hash, idempotent: !!result.idempotent };
}

module.exports = { router, ingestInternal };
