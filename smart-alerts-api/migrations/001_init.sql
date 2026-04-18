-- ══════════════════════════════════════════════════════════════════
--  agoraiq-smart-alerts — initial schema
--  Owned by database agoraiq_smart_alerts. NEVER run against the
--  main agoraiq_signals database.
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS alert_rules (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL,
  plan_tier         TEXT NOT NULL CHECK (plan_tier IN ('pro', 'elite')),
  name              TEXT NOT NULL,
  natural_language  TEXT NOT NULL,
  rule_json         JSONB NOT NULL,
  cooldown_seconds  INTEGER NOT NULL DEFAULT 300,
  daily_limit       INTEGER NOT NULL DEFAULT 50,
  priority          SMALLINT NOT NULL DEFAULT 5,
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'deleted')),
  match_count       BIGINT NOT NULL DEFAULT 0,
  last_matched_at   TIMESTAMPTZ,
  parse_confidence  REAL NOT NULL DEFAULT 1.0,
  parse_source      TEXT NOT NULL DEFAULT 'regex'
                      CHECK (parse_source IN ('regex', 'llm', 'fallback')),
  delivery_channel  TEXT NOT NULL DEFAULT 'telegram',
  delivery_target   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_user_status
  ON alert_rules (user_id, status);
CREATE INDEX IF NOT EXISTS idx_alert_rules_status
  ON alert_rules (status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_alert_rules_updated_at
  ON alert_rules (updated_at DESC);

-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trigger_logs (
  id                BIGSERIAL PRIMARY KEY,
  alert_rule_id     BIGINT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  user_id           BIGINT NOT NULL,
  signal_id         TEXT NOT NULL,
  signal_snapshot   JSONB NOT NULL,
  matched_fields    JSONB NOT NULL,
  suppressed        BOOLEAN NOT NULL DEFAULT FALSE,
  suppressed_reason TEXT,
  fired_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trigger_logs_rule_fired
  ON trigger_logs (alert_rule_id, fired_at DESC);
CREATE INDEX IF NOT EXISTS idx_trigger_logs_user_fired
  ON trigger_logs (user_id, fired_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trigger_logs_rule_signal
  ON trigger_logs (alert_rule_id, signal_id);

-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id                BIGSERIAL PRIMARY KEY,
  trigger_log_id    BIGINT NOT NULL REFERENCES trigger_logs(id) ON DELETE CASCADE,
  alert_rule_id     BIGINT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
  user_id           BIGINT NOT NULL,
  channel           TEXT NOT NULL DEFAULT 'telegram',
  target            TEXT,
  payload           JSONB NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'sent', 'failed', 'retry')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  next_attempt_at   TIMESTAMPTZ,
  delivered_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_attempts_status
  ON delivery_attempts (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_delivery_attempts_rule
  ON delivery_attempts (alert_rule_id, created_at DESC);

-- ──────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_events_user_created
  ON audit_events (user_id, created_at DESC);

-- ──────────────────────────────────────────────────────────────────
--  Helper trigger to bump updated_at
-- ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION sa_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_alert_rules_updated_at ON alert_rules;
CREATE TRIGGER trg_alert_rules_updated_at
  BEFORE UPDATE ON alert_rules
  FOR EACH ROW EXECUTE FUNCTION sa_touch_updated_at();

DROP TRIGGER IF EXISTS trg_delivery_attempts_updated_at ON delivery_attempts;
CREATE TRIGGER trg_delivery_attempts_updated_at
  BEFORE UPDATE ON delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION sa_touch_updated_at();
