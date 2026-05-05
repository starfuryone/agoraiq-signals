#!/usr/bin/env node
/**
 * backfill-scores.js v3 — Re-score legacy signals with AI analysis.
 *
 * Default scope: rows with no AI metadata (meta.ai_score IS NULL).
 *   --force: also rescore rows that have ai_score but missing breakdown.
 *
 * Hardened:
 *   - Mandatory --apply opt-in (default is dry run).
 *   - Postgres advisory lock (via lib/backfill_safety) prevents concurrent
 *     runs and prevents overlap with the live enrich worker on the same
 *     dimension.
 *   - State-gated UPDATE: only writes when meta.ai_score is still null
 *     (or breakdown still missing in --force mode).
 *   - Each updated row logs a BACKFILL_AI_SCORE event to signal_events.
 *   - Status-gated: never mutates rows that have already resolved
 *     (TP/SL/EXPIRED/CANCELLED) — historical analytics keep the original
 *     score on resolution.
 *
 * Usage:
 *   node backfill-scores.js                       # dry run, up to 50 unscored
 *   node backfill-scores.js --apply               # write
 *   node backfill-scores.js --apply --limit 200
 *   node backfill-scores.js --apply --heuristic   # offline (no API calls)
 *   node backfill-scores.js --apply --force       # also fill partials
 *
 * Run from: /opt/agoraiq-signals/api/src/
 * Requires: PPLX_API_KEY in .env (or use --heuristic for offline).
 */

require("dotenv").config({ override: true });
const db = require("./lib/db");
const ai = require("./lib/ai");
const safety = require("./lib/backfill_safety");

const NAME = "backfill_scores";
const DELAY_MS = 1500;

function safeJsonParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") {
    return (value && typeof value === "object" && !Array.isArray(value)) ? value : fallback;
  }
  try { return JSON.parse(value); } catch { return fallback; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const ctx = await safety.begin({ name: NAME, argv: process.argv });
  const HEURISTIC_ONLY = ctx.args.raw.includes("--heuristic");
  const FORCE = ctx.args.force;
  const LIMIT = ctx.args.limit || 50;

  console.log(
    `[${NAME}] limit=${LIMIT} heuristic=${HEURISTIC_ONLY} force=${FORCE} dry=${ctx.args.dryRun}`
  );

  let scored = 0;
  let skipped = 0;
  let failed = 0;

  try {
    // Default: only rows with no AI scoring at all.
    // --force: also rows that have ai_score but missing breakdown.
    // Status='OPEN' guards against rescoring rows whose lifecycle has moved
    // on — those should not be retroactively re-scored.
    const whereClause = FORCE
      ? `(meta IS NULL OR (meta->>'ai_score_breakdown') IS NULL)
         AND status = 'OPEN'`
      : `(meta IS NULL OR (meta->>'ai_score') IS NULL)
         AND status = 'OPEN'`;

    const { rows } = await db.query(`
      SELECT id, symbol, direction, entry, stop, targets, leverage, confidence, meta, source, status
      FROM signals_v2
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1
    `, [LIMIT]);

    console.log(`[${NAME}] found ${rows.length} candidate signals`);

    for (const row of rows) {
      try {
        const meta = safeJsonParse(row.meta, {});

        // Re-check status under the live state — the candidate scan was
        // not transactional. If the row resolved between the scan and now,
        // skip it.
        if (row.status !== "OPEN") {
          skipped++;
          continue;
        }
        // Skip if already-scored (race against live enrich worker).
        if (!FORCE && meta.ai_score != null) {
          skipped++;
          continue;
        }

        const targets = (() => {
          const t = safeJsonParse(row.targets, []);
          return Array.isArray(t) ? t.map(parseFloat).filter((n) => !isNaN(n)) : [];
        })();

        const input = {
          symbol: row.symbol,
          direction: row.direction,
          entry: row.entry ? parseFloat(row.entry) : null,
          stop: row.stop ? parseFloat(row.stop) : null,
          targets,
          leverage: row.leverage,
          volume_change: meta.volume_change || null,
          oi_direction: meta.oi_direction || null,
          funding_rate: meta.funding_rate || null,
        };

        if (ctx.args.dryRun) {
          console.log(`  [dry] #${row.id} ${row.symbol} ${row.direction}`);
          scored++;
          continue;
        }

        const result = HEURISTIC_ONLY
          ? ai.fallbackScore(input)
          : await ai.scoreSignal(input);

        if (!HEURISTIC_ONLY) await sleep(DELAY_MS);

        if (!result || typeof result.score !== "number") {
          console.warn(`  [skip] #${row.id} ${row.symbol} — no result`);
          failed++;
          continue;
        }

        const aiDelta = {
          ai_score: result.score,
          ai_regime: result.regime || null,
          ai_risk_flags: Array.isArray(result.risk_flags) ? result.risk_flags : [],
          ai_reasoning: result.reasoning || null,
          ai_model: result.model || null,
          ai_provider: result.provider || null,
          ai_score_breakdown: result.score_breakdown || null,
          ai_thesis: result.thesis || null,
          ai_tags: result.tags || [],
          ai_backfilled_at: new Date().toISOString(),
        };

        // State-gated UPDATE. JSONB right-biased merge so unrelated meta
        // keys (volume_change, exchange, raw_text, etc.) are preserved.
        // The status='OPEN' guard prevents racing the resolver.
        const stateGate = FORCE
          ? "AND (meta->>'ai_score_breakdown') IS NULL"
          : "AND (meta IS NULL OR meta->>'ai_score' IS NULL)";

        const upd = await ctx.client.query(`
          UPDATE signals_v2
          SET confidence = $1,
              meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb,
              updated_at = NOW()
          WHERE id = $3 AND status = 'OPEN' ${stateGate}
        `, [result.score, JSON.stringify(aiDelta), row.id]);

        if (upd.rowCount === 0) {
          skipped++;
          continue;
        }

        await safety.audit(ctx, {
          signal_id: row.id,
          change: {
            field: "ai_score",
            old: meta.ai_score || null,
            new: result.score,
            provider: result.provider || (HEURISTIC_ONLY ? "heuristic" : null),
            model: result.model || null,
          },
          event: "BACKFILL_AI_SCORE",
        });

        scored++;
        const tagStr = (result.tags || []).join(",");
        console.log(
          `  [ok] #${row.id} ${row.symbol} ${row.direction} → ` +
          `score=${result.score} provider=${result.provider || "heuristic"} tags=[${tagStr}]`
        );
      } catch (err) {
        console.error(`  [err] #${row.id} ${row.symbol}: ${err.message}`);
        failed++;
      }
    }

    console.log(
      `[${NAME}] scored=${scored} skipped=${skipped} failed=${failed} ` +
      `total=${rows.length} dry_run=${ctx.args.dryRun}`
    );
    if (ctx.args.dryRun && scored > 0) {
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
