require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MIGRATIONS = [
  // ═══════════════════════════════════════════════════════════════
  //  STANDALONE SCHEMA — agoraiq_signals database
  //  No shared tables. No ALTER TABLE on external DBs.
  // ═══════════════════════════════════════════════════════════════

  // ── bot_users — local user accounts ─────────────────────────────
  `CREATE TABLE IF NOT EXISTS bot_users (
    id                  SERIAL PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE,
    password_hash       TEXT,
    auth_provider       TEXT DEFAULT 'local',
    role                TEXT DEFAULT 'user',
    stripe_customer_id  TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bu_email ON bot_users(email)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bu_stripe ON bot_users(stripe_customer_id)
   WHERE stripe_customer_id IS NOT NULL`,

  // ── bot_telegram_accounts — telegram linkage ────────────────────
  `CREATE TABLE IF NOT EXISTS bot_telegram_accounts (
    id                  SERIAL PRIMARY KEY,
    bot_user_id         INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
    telegram_id         BIGINT NOT NULL UNIQUE,
    telegram_username   TEXT,
    linked_at           TIMESTAMPTZ DEFAULT NOW(),
    unlinked_at         TIMESTAMPTZ
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bta_tgid ON bot_telegram_accounts(telegram_id)
   WHERE unlinked_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_bta_user ON bot_telegram_accounts(bot_user_id)`,

  // ── bot_subscriptions — billing state ───────────────────────────
  // Stripe is sole source of truth. No free tier.
  `CREATE TABLE IF NOT EXISTS bot_subscriptions (
    id              SERIAL PRIMARY KEY,
    bot_user_id     INTEGER NOT NULL UNIQUE REFERENCES bot_users(id) ON DELETE CASCADE,
    plan_tier       TEXT,
    status          TEXT DEFAULT 'inactive',
    stripe_sub_id   TEXT,
    billing_period  TEXT,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    expires_at      TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bsub_user ON bot_subscriptions(bot_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bsub_stripe ON bot_subscriptions(stripe_sub_id)
   WHERE stripe_sub_id IS NOT NULL`,

  // ── Migration: add billing_period column if missing ────────────
  `DO $$ BEGIN
     ALTER TABLE bot_subscriptions ADD COLUMN IF NOT EXISTS billing_period TEXT;
   EXCEPTION WHEN duplicate_column THEN NULL;
   END $$`,

  // ── Migration: add scheduled change columns ───────────────────
  `DO $$ BEGIN
     ALTER TABLE bot_subscriptions ADD COLUMN IF NOT EXISTS scheduled_plan_tier TEXT;
   EXCEPTION WHEN duplicate_column THEN NULL;
   END $$`,
  `DO $$ BEGIN
     ALTER TABLE bot_subscriptions ADD COLUMN IF NOT EXISTS scheduled_billing_period TEXT;
   EXCEPTION WHEN duplicate_column THEN NULL;
   END $$`,
  `DO $$ BEGIN
     ALTER TABLE bot_subscriptions ADD COLUMN IF NOT EXISTS scheduled_effective_at TIMESTAMPTZ;
   EXCEPTION WHEN duplicate_column THEN NULL;
   END $$`,

  // ── Migration: add pending columns used by billing.js ─────────
  `DO $$ BEGIN
     ALTER TABLE bot_subscriptions ADD COLUMN IF NOT EXISTS pending_plan_tier TEXT;
   EXCEPTION WHEN duplicate_column THEN NULL;
   END $$`,
  `DO $$ BEGIN
     ALTER TABLE bot_subscriptions ADD COLUMN IF NOT EXISTS pending_billing_period TEXT;
   EXCEPTION WHEN duplicate_column THEN NULL;
   END $$`,

  // ── Migration: add meta JSONB column for consent/checkout links ─
  `DO $$ BEGIN
     ALTER TABLE bot_subscriptions ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}'::jsonb;
   EXCEPTION WHEN duplicate_column THEN NULL;
   END $$`,

  // ── Migration: clean up legacy free rows (trial rows expire naturally) ──
  `UPDATE bot_subscriptions SET status = 'inactive', plan_tier = NULL
   WHERE plan_tier = 'free' AND stripe_sub_id IS NULL`,

  // ── consent_log — durable compliance record ────────────────────
  `CREATE TABLE IF NOT EXISTS consent_log (
    id              SERIAL PRIMARY KEY,
    bot_user_id     INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
    version         TEXT NOT NULL,
    documents       JSONB NOT NULL,
    accepted_at     TIMESTAMPTZ NOT NULL,
    ip_address      TEXT,
    user_agent      TEXT,
    plan            TEXT,
    period          TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cl_user ON consent_log(bot_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cl_version ON consent_log(version)`,
  `CREATE INDEX IF NOT EXISTS idx_cl_created ON consent_log(created_at DESC)`,

  // ── bot_sessions — magic link tokens ────────────────────────────
  `CREATE TABLE IF NOT EXISTS bot_sessions (
    id              SERIAL PRIMARY KEY,
    bot_user_id     INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    purpose         TEXT NOT NULL DEFAULT 'login',
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bses_user ON bot_sessions(bot_user_id)`,

  // ── signals_v2 — canonical signals ──────────────────────────────
  `CREATE TABLE IF NOT EXISTS signals_v2 (
    id            SERIAL PRIMARY KEY,
    symbol        TEXT NOT NULL,
    type          TEXT NOT NULL DEFAULT 'manual',
    direction     TEXT NOT NULL,
    entry         NUMERIC,
    stop          NUMERIC,
    targets       JSONB DEFAULT '[]',
    leverage      TEXT,
    confidence    NUMERIC,
    provider      TEXT,
    provider_id   INTEGER,
    source        TEXT NOT NULL DEFAULT 'manual',
    bot_user_id   INTEGER,
    status        TEXT NOT NULL DEFAULT 'OPEN',
    result        NUMERIC,
    duration_sec  INTEGER,
    meta          JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    resolved_at   TIMESTAMPTZ,
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sv2_symbol ON signals_v2(symbol)`,
  `CREATE INDEX IF NOT EXISTS idx_sv2_status ON signals_v2(status)`,
  `CREATE INDEX IF NOT EXISTS idx_sv2_user ON signals_v2(bot_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sv2_source ON signals_v2(source)`,
  `CREATE INDEX IF NOT EXISTS idx_sv2_created ON signals_v2(created_at DESC)`,

  // ── signal_events — lifecycle audit trail ───────────────────────
  `CREATE TABLE IF NOT EXISTS signal_events (
    id            SERIAL PRIMARY KEY,
    signal_id     INTEGER NOT NULL,
    event         TEXT NOT NULL,
    old_status    TEXT,
    new_status    TEXT,
    price_at      NUMERIC,
    pnl_at        NUMERIC,
    meta          JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sigev_signal ON signal_events(signal_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sigev_event ON signal_events(event)`,
  `CREATE INDEX IF NOT EXISTS idx_sigev_created ON signal_events(created_at DESC)`,

  // ── push_log — delivery audit ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS push_log (
    id            SERIAL PRIMARY KEY,
    signal_id     INTEGER,
    bot_user_id   INTEGER,
    telegram_id   BIGINT,
    event_type    TEXT NOT NULL,
    plan_tier     TEXT,
    delivered     BOOLEAN DEFAULT FALSE,
    delayed_until TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pushlog_signal ON push_log(signal_id)`,

  // ── bot_user_provider_follows ───────────────────────────────────
  `CREATE TABLE IF NOT EXISTS bot_user_provider_follows (
    bot_user_id  INTEGER NOT NULL,
    provider_id  INTEGER NOT NULL,
    created_at   TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (bot_user_id, provider_id)
  )`,

  // ── providers ───────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS providers (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    channel     TEXT,
    platform    TEXT DEFAULT 'telegram',
    active      BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── scanner_cache ───────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS scanner_cache (
    category    TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    value       NUMERIC,
    extra       JSONB DEFAULT '{}',
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (category, symbol)
  )`,

  // ── payment_events — idempotent webhook log ─────────────────────
  `CREATE TABLE IF NOT EXISTS payment_events (
    id              SERIAL PRIMARY KEY,
    stripe_event_id TEXT UNIQUE,
    event_type      TEXT NOT NULL,
    provider        TEXT NOT NULL DEFAULT 'stripe',
    payload         JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pe_type ON payment_events(event_type)`,
  `CREATE INDEX IF NOT EXISTS idx_pe_created ON payment_events(created_at DESC)`,

  // ── billing_refunds — 7-day money-back guarantee tracking ───────
  `CREATE TABLE IF NOT EXISTS billing_refunds (
    id                   SERIAL PRIMARY KEY,
    bot_user_id          INTEGER REFERENCES bot_users(id) ON DELETE SET NULL,
    stripe_sub_id        TEXT NOT NULL,
    stripe_customer_id   TEXT,
    stripe_charge_id     TEXT,
    stripe_refund_id     TEXT UNIQUE,
    amount_cents         INTEGER,
    currency             TEXT,
    reason               TEXT NOT NULL DEFAULT 'first_time_7day_guarantee',
    trigger_source       TEXT,
    status               TEXT NOT NULL DEFAULT 'pending',
    error                TEXT,
    created_at           TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_brefunds_sub ON billing_refunds(stripe_sub_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brefunds_user ON billing_refunds(bot_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_brefunds_status ON billing_refunds(status)`,

  // ── bot_alert_rules — per-user symbol alerts ────────────────────
  `CREATE TABLE IF NOT EXISTS bot_alert_rules (
    id              SERIAL PRIMARY KEY,
    bot_user_id     INTEGER NOT NULL REFERENCES bot_users(id) ON DELETE CASCADE,
    symbol          TEXT NOT NULL,
    name            TEXT,
    conditions      JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    last_fired_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bar_user ON bot_alert_rules(bot_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bar_symbol_enabled ON bot_alert_rules(symbol) WHERE enabled = TRUE`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_bar_user_symbol ON bot_alert_rules(bot_user_id, symbol)`,

  // ── updated_at auto-trigger ─────────────────────────────────────
  `CREATE OR REPLACE FUNCTION update_updated_at()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ LANGUAGE plpgsql`,

  `DO $$ BEGIN
     CREATE TRIGGER trg_sv2_updated BEFORE UPDATE ON signals_v2
       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,

  `DO $$ BEGIN
     CREATE TRIGGER trg_bu_updated BEFORE UPDATE ON bot_users
       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,

  `DO $$ BEGIN
     CREATE TRIGGER trg_bsub_updated BEFORE UPDATE ON bot_subscriptions
       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,

  `DO $$ BEGIN
     CREATE TRIGGER trg_bar_updated BEFORE UPDATE ON bot_alert_rules
       FOR EACH ROW EXECUTE FUNCTION update_updated_at();
   EXCEPTION WHEN duplicate_object THEN NULL;
   END $$`,

  // ═══════════════════════════════════════════════════════════════════
  //  005 — Signal Ingestion Pipeline (single source of truth)
  //  Mirror of api/migrations/005_signal_ingestion_pipeline.sql
  // ═══════════════════════════════════════════════════════════════════
  `ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS hash           TEXT`,
  `ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS schema_version TEXT`,
  `ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS strategy       TEXT`,
  `ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS timeframe      TEXT`,
  `ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS signal_ts      TIMESTAMPTZ`,
  `ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS risk           NUMERIC`,
  `ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS reward         NUMERIC`,
  `ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS rr             NUMERIC`,
  `ALTER TABLE signals_v2 ADD COLUMN IF NOT EXISTS raw_payload    TEXT`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sv2_hash_unique
     ON signals_v2(hash) WHERE hash IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_sv2_strategy ON signals_v2(strategy)`,
  `CREATE INDEX IF NOT EXISTS idx_sv2_schema   ON signals_v2(schema_version)`,

  `CREATE TABLE IF NOT EXISTS signals_rejected (
     id                 BIGSERIAL PRIMARY KEY,
     source             TEXT,
     provider           TEXT,
     bot_user_id        INTEGER,
     raw_payload        TEXT,
     normalized_payload JSONB,
     rejection_stage    TEXT NOT NULL,
     rejection_reason   TEXT NOT NULL,
     rejection_meta     JSONB DEFAULT '{}'::jsonb,
     created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_srej_created ON signals_rejected(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_srej_source  ON signals_rejected(source)`,
  `CREATE INDEX IF NOT EXISTS idx_srej_stage   ON signals_rejected(rejection_stage)`,
  `CREATE INDEX IF NOT EXISTS idx_srej_user    ON signals_rejected(bot_user_id)
     WHERE bot_user_id IS NOT NULL`,
];

async function migrate() {
  const client = await pool.connect();
  try {
    console.log("━━ agoraiq-signals-api: standalone migration ━━━━━━━━━\n");
    for (const sql of MIGRATIONS) {
      const label = sql.trim().slice(0, 60).replace(/\s+/g, " ");
      try {
        await client.query(sql);
        console.log(`  ✓ ${label}...`);
      } catch (err) {
        if (["42701", "42P07", "42710"].includes(err.code)) {
          console.log(`  · ${label}... (exists)`);
        } else {
          console.error(`  ✗ ${label}`, err.message);
        }
      }
    }
    console.log("\nMigration complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => { console.error("Migration failed:", err); process.exit(1); });
