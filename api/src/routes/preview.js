// api/src/routes/preview.js
// Public, no-auth endpoint backing the cold-traffic /preview.html page.
// Returns up to 6 resolved signals from yesterday's UTC window with
// confidence >= 65. Falls back to a 7-day window if yesterday is sparse,
// so the marketing page never renders empty.

const express = require('express');
const router = express.Router();
const pool = require('../lib/db'); // adjust if your pg pool lives elsewhere

const MIN_CONFIDENCE = 65;
const TARGET_COUNT = 6;
const FALLBACK_DAYS = 7;

function utcMidnightToday() {
  const now = new Date();
  return new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0
  ));
}

// Map signals_v2.result + entry/stop/targets to a display outcome + R-multiple.
function shapeOutcome(row) {
  // status holds the outcome label (TP1/TP2/TP3/SL/EXPIRED).
  // result holds the realized return as a decimal (e.g. 0.0234 = +2.34%).
  // R-multiple = realized_return / risk_pct, where risk_pct = |entry - stop| / entry.
  const entry  = parseFloat(row.entry);
  const stop   = parseFloat(row.stop);
  const ret    = parseFloat(row.result);
  const status = (row.status || '').toUpperCase();

  let r_multiple = null;
  if (entry > 0 && Math.abs(entry - stop) > 0 && !Number.isNaN(ret)) {
    const risk_pct = Math.abs(entry - stop) / entry;
    r_multiple = ret / risk_pct;
  }

  let outcome_class = 'part';
  let outcome_label = status || '—';

  if (status === 'TP1' || status === 'TP2' || status === 'TP3') {
    outcome_class = 'win';
    outcome_label = `${status} Hit`;
  } else if (status === 'SL') {
    outcome_class = 'loss';
    outcome_label = 'SL Hit';
  } else if (status === 'EXPIRED') {
    // Expired with positive return = partial; with negative = soft loss
    outcome_class = (r_multiple != null && r_multiple >= 0) ? 'part' : 'loss';
    outcome_label = 'Expired';
  }

  return { r_multiple, outcome_class, outcome_label };
}

async function fetchSignals(windowStart, windowEnd, limit) {
  // NOTE: COALESCE chain — adjust column names to match your bot_users table.
  // If you don't have display_name, drop it; email prefix is the fallback.
  const q = `
    SELECT
      s.id,
      s.symbol,
      s.direction,
      s.entry,
      s.stop,
      s.targets,
      s.confidence,
      s.result,
      s.status,
      s.created_at,
      s.resolved_at,
      s.duration_sec,
      COALESCE(
        '@' || NULLIF(t.telegram_username, ''),
        'Provider ' || LPAD(COALESCE(s.bot_user_id, 0)::text, 3, '0')
      ) AS provider_name
    FROM signals_v2 s
    LEFT JOIN bot_telegram_accounts t
      ON t.bot_user_id = s.bot_user_id
     AND t.unlinked_at IS NULL
    WHERE s.confidence >= $1
      AND s.resolved_at >= $2
      AND s.resolved_at <  $3
      AND s.status IN ('TP1','TP2','TP3','SL','EXPIRED')
      AND s.result IS NOT NULL
    ORDER BY s.confidence DESC, s.resolved_at DESC
    LIMIT $4
  `;
  const { rows } = await pool.query(q, [MIN_CONFIDENCE, windowStart, windowEnd, limit]);
  return rows;
}

router.get('/sample-signals', async (req, res) => {
  try {
    const todayStart = utcMidnightToday();
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

    // Try yesterday first
    let rows = await fetchSignals(yesterdayStart, todayStart, TARGET_COUNT);
    let windowStart = yesterdayStart;
    let windowEnd = todayStart;
    let fallback = false;

    // Fallback: extend window backward up to FALLBACK_DAYS if sparse
    if (rows.length < TARGET_COUNT) {
      const extendedStart = new Date(todayStart.getTime() - FALLBACK_DAYS * 24 * 60 * 60 * 1000);
      rows = await fetchSignals(extendedStart, todayStart, TARGET_COUNT);
      windowStart = extendedStart;
      fallback = true;
    }

    const signals = rows.map(r => {
      const { r_multiple, outcome_class, outcome_label } = shapeOutcome(r);
      return {
        symbol: r.symbol,
        direction: (r.direction || '').toLowerCase(), // 'long' | 'short'
        provider: r.provider_name,
        confidence: r.confidence != null ? Number(r.confidence) : null,
        outcome_label,
        outcome_class,
        r_multiple: r_multiple != null ? Number(r_multiple.toFixed(2)) : null,
        opened_at: r.created_at,
        closed_at: r.resolved_at
      };
    });

    res.set('Cache-Control', 'public, max-age=300'); // 5-minute edge cache
    res.json({
      window: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      fallback,
      min_confidence: MIN_CONFIDENCE,
      count: signals.length,
      signals
    });
  } catch (err) {
    console.error('[preview/sample-signals]', err);
    res.status(500).json({ error: 'failed_to_load_sample_signals' });
  }
});

module.exports = router;
