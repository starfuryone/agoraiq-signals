/**
 * backfill-entries.js v2 — Re-parse signals with NULL entry.
 *
 * Run from /opt/agoraiq-signals/api:
 *   node backfill-entries.js            # dry run
 *   node backfill-entries.js --apply    # write changes
 */

require("dotenv").config({ path: "/opt/agoraiq-signals/.env" });
const db = require("./src/lib/db");
const { parseSignal } = require("./src/lib/parser");

const DRY_RUN = !process.argv.includes("--apply");

async function main() {
  if (DRY_RUN) console.log("=== DRY RUN (pass --apply to write) ===\n");

  const { rows } = await db.query(
    "SELECT id, symbol, direction, entry, stop, targets, meta FROM signals_v2 WHERE entry IS NULL ORDER BY id"
  );

  console.log("Found " + rows.length + " signals with NULL entry\n");

  let fixed = 0, skipped = 0;

  for (const row of rows) {
    let meta;
    try {
      meta = typeof row.meta === "string" ? JSON.parse(row.meta) : (row.meta || {});
    } catch(e) { meta = {}; }

    const rawText = meta.raw_text;
    if (!rawText) { skipped++; continue; }

    const parsed = parseSignal(rawText);

    if (!parsed.price) {
      console.log("  SKIP #" + row.id + " " + row.symbol + " — no entry extracted");
      console.log("    raw: " + rawText.replace(/\n/g, " ").slice(0, 100));
      skipped++;
      continue;
    }

    console.log("  FIX  #" + row.id + " " + row.symbol);
    console.log("    entry: NULL -> " + parsed.price);
    if (parsed.stopLoss) console.log("    stop:  NULL -> " + parsed.stopLoss);
    if (parsed.targets.length) console.log("    targets: " + JSON.stringify(parsed.targets));

    if (!DRY_RUN) {
      await db.query(
        "UPDATE signals_v2 SET entry = COALESCE($1, entry), stop = COALESCE($2, stop), targets = COALESCE($3, targets), updated_at = NOW() WHERE id = $4",
        [parsed.price, parsed.stopLoss || null, parsed.targets.length ? JSON.stringify(parsed.targets) : null, row.id]
      );
      console.log("    done");
    }

    fixed++;
  }

  console.log("\n" + fixed + " fixable, " + skipped + " skipped");
  if (DRY_RUN && fixed > 0) console.log("\nRun: node backfill-entries.js --apply");
  await db.end();
}

main().catch(function(e) { console.error(e); process.exit(1); });
