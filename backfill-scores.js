#!/usr/bin/env node
/**
 * backfill-scores.js (root-level) — DEPRECATED.
 *
 * This is the legacy, unhardened backfill script. It contained a hardcoded
 * database password fallback and had no advisory lock, no audit trail, and
 * no mandatory --apply opt-in.
 *
 * The canonical, hardened replacement is:
 *
 *     node api/src/backfill-scores.js --apply
 *
 * which uses lib/backfill_safety to:
 *   - acquire a Postgres advisory lock (no concurrent runs)
 *   - require --apply to mutate (default is dry run)
 *   - skip rows that have already resolved (status != 'OPEN')
 *   - merge into meta with a JSONB right-biased operator (preserves keys)
 *   - log every change to signal_events (BACKFILL_AI_SCORE)
 *
 * This file is intentionally left as a refusal stub so any cron, runbook,
 * or muscle-memory invocation fails loudly instead of running unsafe code.
 */

console.error(
  "[backfill-scores] this script has been deprecated.\n\n" +
  "Use the hardened version instead:\n" +
  "    cd api/src && node backfill-scores.js          # dry run\n" +
  "    cd api/src && node backfill-scores.js --apply  # write\n\n" +
  "It enforces an advisory lock, mandatory --apply opt-in, and per-row\n" +
  "audit trail in signal_events. No hardcoded credentials.\n"
);
process.exit(64); // EX_USAGE
