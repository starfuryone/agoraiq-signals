#!/usr/bin/env node
/**
 * backfill-scores.js
 * 
 * Computes real score_breakdown, thesis, and tags from existing signal data.
 * Writes ai_score_breakdown, ai_thesis, ai_tags, ai_regime, ai_risk_flags
 * into the meta JSONB column of signals_v2.
 * 
 * No external API calls. Runs instantly.
 *
 * Usage:
 *   node backfill-scores.js                # backfill signals missing breakdown
 *   node backfill-scores.js --limit 50     # only 50
 *   node backfill-scores.js --all          # re-score everything
 *   node backfill-scores.js --dry-run      # preview without writing
 */

const { Pool } = require("pg");

if (!process.env.PGPASSWORD) {
  console.error("PGPASSWORD environment variable is required");
  process.exit(1);
}

const pool = new Pool({
  user: process.env.PGUSER || "agoraiq_signals",
  host: process.env.PGHOST || "127.0.0.1",
  database: process.env.PGDATABASE || "agoraiq_signals",
  password: process.env.PGPASSWORD,
  port: parseInt(process.env.PGPORT) || 5432,
});

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const ALL = args.includes("--all");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1]) || 9999 : 9999;

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function computeHeuristic(sig) {
  const entry = parseFloat(sig.entry) || 0;
  const stop = parseFloat(sig.stop) || 0;
  const targets = Array.isArray(sig.targets) ? sig.targets.map(Number).filter(Boolean) : [];
  const leverage = parseFloat(sig.leverage) || 1;
  const direction = (sig.direction || "long").toLowerCase();
  const meta = (typeof sig.meta === "object" && sig.meta) ? sig.meta : {};
  const symbol = (sig.symbol || "").toUpperCase();

  // ── Sub-scores ──
  let breakoutScore = 50;
  let volumeScore = 50;
  let oiScore = 50;
  let liquidityScore = 60;
  let fundingScore = 60;
  let regimeScore = 50;
  let providerScore = 50;
  let riskPenalty = 0;
  const riskFlags = [];

  // Risk/Reward
  let rr = 0;
  if (entry && stop && targets.length > 0) {
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(targets[0] - entry);
    rr = risk > 0 ? reward / risk : 0;

    if (rr >= 3) breakoutScore = 85;
    else if (rr >= 2) breakoutScore = 72;
    else if (rr >= 1.5) breakoutScore = 60;
    else if (rr >= 1) breakoutScore = 45;
    else { breakoutScore = 25; riskFlags.push("low_rr"); }
  }

  // Stop loss
  if (!stop || stop === 0) {
    riskPenalty -= 15;
    breakoutScore = Math.max(breakoutScore - 10, 10);
    riskFlags.push("no_stop_loss");
  }

  // Target count
  if (targets.length >= 3) breakoutScore = Math.min(breakoutScore + 10, 95);
  else if (targets.length === 0) breakoutScore = Math.max(breakoutScore - 15, 10);

  // Leverage
  if (leverage > 50) {
    riskPenalty -= 20;
    liquidityScore = 30;
    riskFlags.push("extreme_leverage");
  } else if (leverage > 20) {
    riskPenalty -= 10;
    liquidityScore = 45;
    riskFlags.push("high_leverage");
  } else if (leverage > 10) {
    riskPenalty -= 5;
    liquidityScore = 55;
  } else {
    liquidityScore = 70;
  }

  // Volume from meta
  const volChange = parseFloat(meta.volume_change || 0);
  if (volChange > 50) volumeScore = 85;
  else if (volChange > 20) volumeScore = 70;
  else if (volChange > 5) volumeScore = 55;
  else if (volChange > -10) volumeScore = 45;
  else if (volChange > -50) volumeScore = 35;
  else volumeScore = 25;

  // OI from meta
  const oiDir = (meta.oi_direction || "").toLowerCase();
  if (oiDir === "rising" || oiDir === "up") oiScore = 72;
  else if (oiDir === "falling" || oiDir === "down") oiScore = 35;

  // Funding
  const funding = parseFloat(meta.funding_rate || 0);
  if (Math.abs(funding) > 0.1) {
    fundingScore = 25;
    riskPenalty -= 5;
    riskFlags.push("extreme_funding");
  } else if (Math.abs(funding) > 0.05) {
    fundingScore = 45;
  } else {
    fundingScore = 70;
  }

  // Provider IQ
  const provIQ = parseInt(meta.provider_iq || meta.iq || 0);
  providerScore = provIQ > 0 ? clamp(provIQ) : 50;

  // Regime
  if (rr >= 2.5 && targets.length >= 2) regimeScore = 75;
  else if (leverage > 20) regimeScore = 40;
  else regimeScore = 55;

  // ── Build breakdown ──
  const breakdown = {
    breakout: clamp(breakoutScore),
    volume: clamp(volumeScore),
    oi: clamp(oiScore),
    liquidity: clamp(liquidityScore),
    funding: clamp(fundingScore),
    regime: clamp(regimeScore),
    provider: clamp(providerScore),
    risk_penalty: Math.max(-30, Math.min(0, Math.round(riskPenalty))),
  };

  // ── Weighted score ──
  const weights = { breakout: 0.20, volume: 0.15, oi: 0.10, liquidity: 0.10, funding: 0.10, regime: 0.15, provider: 0.20 };
  let weighted = 0;
  for (const [k, w] of Object.entries(weights)) {
    weighted += breakdown[k] * w;
  }
  const score = clamp(weighted + breakdown.risk_penalty);

  // ── Tags ──
  const tags = [];
  if (rr >= 2) tags.push("breakout");
  if (volChange > 20) tags.push("volume");
  if (targets.length >= 3 && rr >= 1.5) tags.push("swing");
  if (leverage > 20) tags.push("high-risk");
  if (targets.length === 1 && leverage > 10) tags.push("scalp");
  if (oiDir === "rising" || oiDir === "up") tags.push("oi");
  if (rr >= 1.5 && rr < 2.5) tags.push("trend");
  if (tags.length === 0) tags.push("trend");
  const finalTags = tags.slice(0, 4);

  // ── Regime ──
  let regime = "chop";
  if (rr >= 2.5 && targets.length >= 2) regime = "breakout";
  else if (rr >= 1.5) regime = "trend";
  else if (rr > 0 && rr < 0.8) regime = "mean_reversion";

  // ── Thesis ──
  const parts = [];
  parts.push(`${symbol} ${direction.toUpperCase()}`);
  if (rr > 0) parts.push(`with ${rr.toFixed(1)}:1 R:R`);
  if (targets.length > 0) parts.push(`targeting ${targets.length} level${targets.length > 1 ? "s" : ""}`);
  if (!stop) parts.push("— no stop-loss defined, elevated risk");
  else if (leverage > 20) parts.push(`at ${leverage}x leverage — high exposure`);
  if (volChange > 20) parts.push(`. Volume up ${Math.round(volChange)}% supporting the move`);
  else if (volChange < -30) parts.push(`. Volume down ${Math.round(Math.abs(volChange))}% — thin conviction`);

  let thesis = parts.join(" ") + ".";
  // Clean up double periods
  thesis = thesis.replace(/\.\./g, ".").replace(/\s+/g, " ").trim();
  if (thesis.length > 250) thesis = thesis.slice(0, 247) + "...";

  return {
    score,
    score_breakdown: breakdown,
    thesis,
    tags: finalTags,
    regime,
    risk_flags: [...new Set(riskFlags)],
    model: "heuristic-v1",
    provider: "local",
  };
}

async function run() {
  console.log(`\n🔧 Backfill scores — ${DRY_RUN ? "DRY RUN" : "LIVE"} | Limit: ${LIMIT} | Mode: ${ALL ? "all signals" : "missing only"}\n`);

  const whereClause = ALL
    ? ""
    : "WHERE meta->>'ai_score_breakdown' IS NULL OR meta->>'ai_score_breakdown' = ''";

  const { rows } = await pool.query(
    `SELECT id, symbol, direction, entry, stop, targets, leverage, confidence, meta, provider
     FROM signals_v2
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $1`,
    [LIMIT]
  );

  console.log(`Found ${rows.length} signals to process.\n`);

  if (rows.length === 0) {
    console.log("Nothing to backfill.");
    await pool.end();
    return;
  }

  let updated = 0;
  let errors = 0;

  for (const row of rows) {
    try {
      // Parse targets if stored as JSON string
      if (typeof row.targets === "string") {
        try { row.targets = JSON.parse(row.targets); } catch { row.targets = []; }
      }
      // Parse meta if stored as JSON string
      if (typeof row.meta === "string") {
        try { row.meta = JSON.parse(row.meta); } catch { row.meta = {}; }
      }

      const result = computeHeuristic(row);

      // Merge new AI fields into existing meta
      const newMeta = {
        ...(row.meta || {}),
        ai_score_breakdown: result.score_breakdown,
        ai_thesis: result.thesis,
        ai_tags: result.tags,
        ai_regime: result.regime,
        ai_risk_flags: result.risk_flags,
        ai_model: result.model,
        ai_provider: result.provider,
      };

      if (DRY_RUN) {
        console.log(`  [DRY] #${row.id} ${row.symbol} ${row.direction} → score=${result.score} regime=${result.regime} tags=[${result.tags}]`);
        console.log(`        thesis: ${result.thesis}`);
        console.log(`        breakdown: B=${result.score_breakdown.breakout} V=${result.score_breakdown.volume} OI=${result.score_breakdown.oi} L=${result.score_breakdown.liquidity} F=${result.score_breakdown.funding} R=${result.score_breakdown.regime} P=${result.score_breakdown.provider} pen=${result.score_breakdown.risk_penalty}`);
      } else {
        await pool.query(
          `UPDATE signals_v2 SET meta = $1, confidence = $2, updated_at = NOW() WHERE id = $3`,
          [JSON.stringify(newMeta), result.score, row.id]
        );
        console.log(`  ✓ #${row.id} ${(row.symbol || "").padEnd(10)} score=${String(result.score).padStart(3)} regime=${result.regime.padEnd(15)} tags=[${result.tags}]`);
      }

      updated++;
    } catch (err) {
      console.error(`  ✗ #${row.id} error: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`Done. ${updated} scored, ${errors} errors.${DRY_RUN ? " (dry run — nothing written)" : ""}`);

  await pool.end();
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
