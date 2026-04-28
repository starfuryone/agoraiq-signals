BEGIN;

CREATE TABLE IF NOT EXISTS provider_iq_cache (
  provider_id   INTEGER     PRIMARY KEY REFERENCES providers(id) ON DELETE CASCADE,
  stats_hash    TEXT        NOT NULL,
  response_text TEXT        NOT NULL,
  model         TEXT        NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_iq_cache_generated
  ON provider_iq_cache (generated_at DESC);

CREATE TABLE IF NOT EXISTS provider_iq_responses (
  id              BIGSERIAL   PRIMARY KEY,
  provider_id     INTEGER     NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  stats_hash      TEXT        NOT NULL,
  stats_snapshot  JSONB       NOT NULL,
  response_text   TEXT        NOT NULL,
  model           TEXT        NOT NULL,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  cost_usd        NUMERIC(12,6),
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_iq_responses_provider_time
  ON provider_iq_responses (provider_id, generated_at DESC);

CREATE INDEX IF NOT EXISTS idx_provider_iq_responses_hash
  ON provider_iq_responses (stats_hash);

COMMIT;
