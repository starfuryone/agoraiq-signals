#!/usr/bin/env node
/**
 * backfill_signal_hashes.js
 *
 * Populates the `hash` column on legacy rows in signals_v2 (rows that
 * pre-date migration 005 / the v3_clean ingestion pipeline).
 *
 * Why this matters:
 *   The unique partial index on signals_v2(hash) WHERE hash IS NOT NULL
 *   is the final dedupe backstop for new ingestions. Legacy rows with
 *   NULL hash do NOT participate in that index, so a fresh ingestion of
 *   the same trade as a legacy row would create a duplicate. Backfilling
 *   the hash extends dedupe protection to the historical data.
 *
 * Hash function:
 *   Identical to lib/dedupe.computeHash. signal_ts is taken from the
 *   row's created_at; timeframe falls back to "unknown" when missing.
 *
 * Collision handling:
 *   Two legacy rows with the same (symbol, direction, rounded_entry,
 *   timeframe, time_window_bucket) will compute the same hash. We do
 *   not silently merge them — instead the older row (lowest id) gets
 *   the hash and any subsequent collisions are LOGGED and SKIPPED. The
 *   colliding rows remain hash=NULL, are reported in a summary, and can
 *   be reviewed manually.
 *
 * Safety:
 *   - Mandatory --apply opt-in (default is dry run).
 *   - Postgres advisory lock prevents concurrent runs.
 *   - Each row mutation logs a BACKFILL_HASHES event to signal_events.
 *   - Re-runnable: only touches rows where hash IS NULL.
 *
 * Usage:
 *   node api/scripts/backfill_signal_hashes.js              # dry run
 *   node api/scripts/backfill_signal_hashes.js --apply      # write
 *   node api/scripts/backfill_signal_hashes.js --limit 1000 # cap rows
 */

require("dotenv").config({ override: true });
const db = require("../src/lib/db");
const safety = require("../src/lib/backfill_safety");
const { computeHash } = require("../src/lib/dedupe");

const NAME = "backfill_signal_hashes";
const BATCH_SIZE = 500;

async function main() {
  const ctx = await safety.begin({ name: NAME, argv: process.argv });

  let processed = 0;
  let updated = 0;
  let collisions = 0;
  let errors = 0;
  const collisionExamples = [];

  try {
    const totalR = await db.query(
      "SELECT COUNT(*)::int AS n FROM signals_v2 WHERE hash IS NULL"
    );
    const total = totalR.rows[0].n;
    const cap = ctx.args.limit || total;
    console.log(`[${NAME}] ${total} legacy rows have hash IS NULL; will process up to ${cap}`);

    if (total === 0) {
      console.log(`[${NAME}] nothing to do`);
      return;
    }

    // Order by id ASC so the oldest legacy row wins any collision.
    let lastId = 0;
    while (processed < cap) {
      const remaining = cap - processed;
      const batchLimit = Math.min(BATCH_SIZE, remaining);

      const { rows } = await db.query(
        `SELECT id, symbol, direction, entry, timeframe, signal_ts, created_at
         FROM signals_v2
         WHERE hash IS NULL AND id > $1
         ORDER BY id ASC
         LIMIT $2`,
        [lastId, batchLimit]
      );
      if (rows.length === 0) break;

      for (const row of rows) {
        processed++;
        lastId = row.id;

        const result = await processRow(ctx, row);
        if (result.kind === "updated") updated++;
        else if (result.kind === "collision") {
          collisions++;
          if (collisionExamples.length < 10) {
            collisionExamples.push({
              id: row.id,
              symbol: row.symbol,
              direction: row.direction,
              hash: result.hash,
              colliding_id: result.collidingId,
            });
          }
        } else if (result.kind === "skipped") {
          // skipped due to missing required fields
        } else if (result.kind === "error") {
          errors++;
        }
      }
    }

    console.log(
      `[${NAME}] processed=${processed} updated=${updated} collisions=${collisions} ` +
      `errors=${errors} dry_run=${ctx.args.dryRun}`
    );
    if (collisionExamples.length > 0) {
      console.log(`[${NAME}] first ${collisionExamples.length} collision examples:`);
      for (const c of collisionExamples) {
        console.log(
          `  - row #${c.id} ${c.symbol} ${c.direction} → hash ${c.hash.slice(0, 12)}… ` +
          `already on row #${c.colliding_id}`
        );
      }
    }
    if (ctx.args.dryRun && updated === 0 && processed > 0) {
      console.log(`[${NAME}] re-run with --apply to persist`);
    }
  } finally {
    await safety.end(ctx);
    await db.end();
  }
}

async function processRow(ctx, row) {
  // Skip rows that don't have enough data to compute a meaningful hash.
  if (!row.symbol || !row.direction || row.entry == null) {
    return { kind: "skipped", reason: "missing_fields" };
  }

  const signalTs = row.signal_ts
    ? new Date(row.signal_ts).getTime()
    : new Date(row.created_at).getTime();
  const timeframe = row.timeframe || "unknown";

  const hash = computeHash({
    symbol: row.symbol,
    direction: row.direction,
    entry: parseFloat(row.entry),
    timeframe,
    signal_ts: signalTs,
  });

  if (ctx.args.dryRun) {
    // In dry run we still want to know whether THIS hash would collide.
    const existing = await db.query(
      "SELECT id FROM signals_v2 WHERE hash = $1 LIMIT 1",
      [hash]
    );
    if (existing.rows.length > 0 && existing.rows[0].id !== row.id) {
      return { kind: "collision", hash, collidingId: existing.rows[0].id };
    }
    console.log(`  [dry] #${row.id} ${row.symbol} ${row.direction} → ${hash.slice(0, 16)}…`);
    return { kind: "updated" }; // counted as would-update for dry-run reporting
  }

  // Live update path. State-gated WHERE clause: only set hash if still NULL.
  // The unique partial index will throw 23505 on collision.
  try {
    const r = await ctx.client.query(
      `UPDATE signals_v2 SET hash = $1, updated_at = NOW()
       WHERE id = $2 AND hash IS NULL`,
      [hash, row.id]
    );
    if (r.rowCount === 0) return { kind: "skipped", reason: "race" };

    await safety.audit(ctx, {
      signal_id: row.id,
      change: {
        field: "hash",
        old: null,
        new: hash,
        timeframe_used: timeframe,
        signal_ts_used: new Date(signalTs).toISOString(),
      },
      event: "BACKFILL_HASH",
    });

    if ((processedSoFar(ctx) % 100) === 0) {
      console.log(`  [ok] #${row.id} ${row.symbol} ${row.direction} → ${hash.slice(0, 16)}…`);
    }
    return { kind: "updated" };
  } catch (err) {
    if (err.code === "23505") {
      // Unique violation — another legacy row already owns this hash.
      const existing = await db.query(
        "SELECT id FROM signals_v2 WHERE hash = $1 LIMIT 1",
        [hash]
      );
      const collidingId = existing.rows[0] && existing.rows[0].id;
      return { kind: "collision", hash, collidingId };
    }
    console.error(`  [err] #${row.id}: ${err.message}`);
    return { kind: "error" };
  }
}

function processedSoFar(ctx) {
  return ctx.audited + 1;
}

main().catch((err) => {
  console.error(`[${NAME}] fatal:`, err);
  process.exit(1);
});
