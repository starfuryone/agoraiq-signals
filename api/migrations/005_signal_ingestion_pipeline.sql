-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 005 — Signal Ingestion Pipeline (single source of truth)
--
-- Purpose:
--   Enforce the v3_clean ingestion contract on signals_v2 and create the
--   rejection sink (signals_rejected). All new INSERTs into signals_v2 must
--   come from the ingest worker, which writes the full set of v3_clean
--   columns (hash, schema_version, strategy, timeframe, signal_ts, risk,
--   reward, rr, raw_payload).
--
-- This file mirrors the inline DDL in api/src/migrate.js, which executes the
-- same statements idempotently. It exists as a numbered, reviewable artifact.
-- Re-running is safe (every statement is IF NOT EXISTS / DO $$ guarded).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── signals_v2 schema additions ────────────────────────────────────────────
ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS hash             TEXT;
ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS schema_version   TEXT;
ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS strategy         TEXT;
ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS timeframe        TEXT;
ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS signal_ts        TIMESTAMPTZ;
ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS risk             NUMERIC;
ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS reward           NUMERIC;
ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS rr               NUMERIC;
ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS raw_payload      TEXT;

-- Hash uniqueness is the deduplication contract. Partial index ignores legacy
-- rows (NULL hash) so backfill can proceed without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sv2_hash_unique
  ON signals_v2(hash)
  WHERE hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sv2_strategy ON signals_v2(strategy);
CREATE INDEX IF NOT EXISTS idx_sv2_schema   ON signals_v2(schema_version);

-- ── signals_rejected — rejection pipeline (mandatory audit) ────────────────
CREATE TABLE IF NOT EXISTS signals_rejected (
  id                 BIGSERIAL PRIMARY KEY,
  source             TEXT,
  provider           TEXT,
  bot_user_id        INTEGER,
  raw_payload        TEXT,
  normalized_payload JSONB,
  rejection_stage    TEXT NOT NULL,    -- 'normalize' | 'validate' | 'dedupe'
  rejection_reason   TEXT NOT NULL,
  rejection_meta     JSONB DEFAULT '{}'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_srej_created ON signals_rejected(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_srej_source  ON signals_rejected(source);
CREATE INDEX IF NOT EXISTS idx_srej_stage   ON signals_rejected(rejection_stage);
CREATE INDEX IF NOT EXISTS idx_srej_user    ON signals_rejected(bot_user_id) WHERE bot_user_id IS NOT NULL;
