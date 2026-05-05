#!/usr/bin/env node
/**
 * backfill-entries.js v3 — Re-parse legacy signals with NULL entry.
 *
 * Hardened:
 *   - Mandatory --apply opt-in (default is dry run).
 *   - Postgres advisory lock (via lib/backfill_safety) prevents concurrent
 *     runs.
 *   - Each updated row logs a BACKFILL_ENTRY event to signal_events.
 *   - Idempotent: only touches rows where entry IS NULL.
 *
 * Run from /opt/agoraiq-signals/api:
 *   node backfill-entries.js              # dry run
 *   node backfill-entries.js --apply      # write changes
 *   node backfill-entries.js --limit 100  # cap rows processed
 */

require("dotenv").config({ path: "/opt/agoraiq-signals/.env" });
const db = require("./src/lib/db");
const safety = require("./src/lib/backfill_safety");
const { parseSignal } = require("./src/lib/parser");

const NAME = "backfill_entries";

async function main() {
  const ctx = await safety.begin({ name: NAME, argv: process.argv });

  let fixed = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const limitClause = ctx.args.limit ? "LIMIT " + parseInt(ctx.args.limit, 10) : "";
    const { rows } = await db.query(
      `SELECT id, symbol, direction, entry, stop, targets, meta
       FROM signals_v2
       WHERE entry IS NULL
       ORDER BY id
       ${limitClause}`
    );

    console.log(`[${NAME}] ${rows.length} signals with NULL entry`);

    for (const row of rows) {
      let meta;
      try {
        meta = typeof row.meta === "string" ? JSON.parse(row.meta) : (row.meta || {});
      } catch { meta = {}; }

      const rawText = meta.raw_text;
      if (!rawText) {
        skipped++;
        continue;
      }

      const parsed = parseSignal(rawText);
      if (!parsed.price) {
        console.log(`  [skip] #${row.id} ${row.symbol} — no entry extracted`);
        skipped++;
        continue;
      }

      const change = {
        field: "entry",
        old: { entry: null, stop: row.stop, targets: row.targets },
        new: {
          entry: parsed.price,
          stop: parsed.stopLoss || row.stop,
          targets: parsed.targets.length ? parsed.targets : row.targets,
        },
      };

      console.log(
        `  [${ctx.args.dryRun ? "dry" : "fix"}] #${row.id} ${row.symbol} ` +
        `entry: NULL → ${parsed.price}` +
        (parsed.stopLoss ? `, stop: NULL → ${parsed.stopLoss}` : "") +
        (parsed.targets.length ? `, targets: ${JSON.stringify(parsed.targets)}` : "")
      );

      if (ctx.args.dryRun) {
        fixed++;
        continue;
      }

      try {
        // State-gated UPDATE: only patch if entry is still NULL — prevents
        // overwriting any concurrent write.
        const r = await ctx.client.query(
          `UPDATE signals_v2
           SET entry = COALESCE($1, entry),
               stop = COALESCE($2, stop),
               targets = COALESCE($3, targets),
               updated_at = NOW()
           WHERE id = $4 AND entry IS NULL`,
          [
            parsed.price,
            parsed.stopLoss || null,
            parsed.targets.length ? JSON.stringify(parsed.targets) : null,
            row.id,
          ]
        );
        if (r.rowCount === 0) {
          skipped++;
          continue;
        }

        await safety.audit(ctx, {
          signal_id: row.id,
          change,
          event: "BACKFILL_ENTRY",
        });
        fixed++;
      } catch (err) {
        console.error(`  [err] #${row.id}: ${err.message}`);
        errors++;
      }
    }

    console.log(
      `[${NAME}] fixed=${fixed} skipped=${skipped} errors=${errors} dry_run=${ctx.args.dryRun}`
    );
    if (ctx.args.dryRun && fixed > 0) {
      console.log(`[${NAME}] re-run with --apply to persist`);
    }
  } finally {
    await safety.end(ctx);
    await db.end();
  }
}

main().catch((err) => {
  console.error(`[${NAME}] fatal:`, err);
  process.exit(1);
});
