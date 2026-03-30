#!/usr/bin/env node
/**
 * backfill-scores.js — Re-score existing signals with full AI analysis.
 *
 * Default: only scores signals with NO existing AI data (ai_score is null).
 * --force: also re-scores signals that have ai_score but are missing breakdown.
 *
 * Usage:
 *   node backfill-scores.js                  # Score unscored signals (up to 50)
 *   node backfill-scores.js --limit 200      # Up to 200
 *   node backfill-scores.js --heuristic      # Force heuristic (no HF API calls)
 *   node backfill-scores.js --force           # Also re-score partially scored signals
 *   node backfill-scores.js --dry-run        # Preview only
 *
 * Run from: /opt/agoraiq-signals/api/src/
 * Requires: HF_API_KEY in .env (or use --heuristic for offline)
 */

require("dotenv").config({ override: true });
const db = require("./lib/db");
const ai = require("./lib/ai");

const args = process.argv.slice(2);
const LIMIT = parseInt(args.find((a) => a.startsWith("--limit="))?.split("=")[1]) ||
              parseInt(args[args.indexOf("--limit") + 1]) || 50;
const HEURISTIC_ONLY = args.includes("--heuristic");
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const DELAY_MS = 1500;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function safeJsonParse(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== "string") {
    return (value && typeof value === "object" && !Array.isArray(value)) ? value : fallback;
  }
  try { return JSON.parse(value); } catch { return fallback; }
}

async function main() {
  console.log(`[backfill] Starting — limit=${LIMIT}, heuristic=${HEURISTIC_ONLY}, force=${FORCE}, dry=${DRY_RUN}`);

  // Default: only rows with no AI scoring at all
  // --force: also rows that have ai_score but missing breakdown
  const whereClause = FORCE
    ? `WHERE meta IS NULL OR (meta->>'ai_score_breakdown') IS NULL`
    : `WHERE meta IS NULL OR (meta->>'ai_score') IS NULL`;

  const { rows } = await db.query(`
    SELECT id, symbol, direction, entry, stop, targets, leverage, confidence, meta, source, status
    FROM signals_v2
    ${whereClause}
    ORDER BY created_at DESC
    LIMIT $1
  `, [LIMIT]);

  console.log(`[backfill] Found ${rows.length} signals to score`);

  if (DRY_RUN) {
    rows.forEach((r) => {
      const m = safeJsonParse(r.meta, {});
      const hasAi = m.ai_score != null;
      console.log(`  [dry] id=${r.id} sym=${r.symbol} dir=${r.direction} score=${r.confidence} has_ai=${hasAi} meta=${r.meta ? 'present' : 'NULL'}`);
    });
    await db.end();
    return;
  }

  let scored = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const meta = safeJsonParse(row.meta, {});
      const targets = Array.isArray(safeJsonParse(row.targets, [])) ? safeJsonParse(row.targets, []) : [];

      const input = {
        symbol: row.symbol,
        direction: row.direction,
        entry: row.entry ? parseFloat(row.entry) : null,
        stop: row.stop ? parseFloat(row.stop) : null,
        targets: targets.map((t) => parseFloat(t)).filter((n) => !isNaN(n)),
        leverage: row.leverage,
        volume_change: meta.volume_change || null,
        oi_direction: meta.oi_direction || null,
        funding_rate: meta.funding_rate || null,
      };

      let result;
      if (HEURISTIC_ONLY) {
        result = ai.fallbackScore(input);
      } else {
        result = await ai.scoreSignal(input);
        await sleep(DELAY_MS);
      }

      if (!result) {
        console.warn(`  [skip] id=${row.id} sym=${row.symbol} — no result`);
        failed++;
        continue;
      }

      const updatedMeta = {
        ...meta,
        ai_score: result.score,
        ai_regime: result.regime,
        ai_risk_flags: result.risk_flags,
        ai_reasoning: result.reasoning,
        ai_model: result.model,
        ai_provider: result.provider,
        ai_score_breakdown: result.score_breakdown || null,
        ai_thesis: result.thesis || null,
        ai_tags: result.tags || [],
        ai_backfilled_at: new Date().toISOString(),
      };

      await db.query(`
        UPDATE signals_v2
        SET confidence = $1, meta = $2, updated_at = NOW()
        WHERE id = $3
      `, [result.score, JSON.stringify(updatedMeta), row.id]);

      scored++;
      const tagStr = (result.tags || []).join(",");
      console.log(`  [ok] id=${row.id} sym=${row.symbol} dir=${row.direction} → score=${result.score} model=${result.model} tags=[${tagStr}]`);

    } catch (err) {
      console.error(`  [err] id=${row.id} sym=${row.symbol}: ${err.message}`);
      failed++;
    }
  }

  console.log(`[backfill] Done — scored=${scored}, failed=${failed}, total=${rows.length}`);
  await db.end();
}

main().catch((err) => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
