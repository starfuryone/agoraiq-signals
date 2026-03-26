/**
 * Daily summary + retention triggers.
 *
 * Fires once per day. Gathers stats from signal_events,
 * computes engagement metrics, sends gated daily brief.
 */

const { Worker } = require("bullmq");
const { getRedis } = require("../lib/redis");
const db = require("../lib/db");
const events = require("../lib/events");
const { pushQueue } = require("./queues");

const DAILY_INTERVAL = 86_400_000;

async function gatherStats() {
  const stats = {
    winRate: null,
    totalTracked: 0,
    newSignals: 0,
    resolved: 0,
    wins: 0,
    totalReturn: null,
    topMover: null,
  };

  try {
    // Overall win rate
    const wr = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE status LIKE 'TP%')::int AS wins,
             COUNT(*) FILTER (WHERE status LIKE 'TP%' OR status = 'SL')::int AS decided
      FROM signals_v2
      WHERE status IN ('TP1','TP2','TP3','SL','EXPIRED')
    `);
    const r = wr.rows[0];
    stats.totalTracked = r.total;
    stats.wins = r.wins;
    stats.winRate = r.decided > 0 ? r.wins / r.decided : null;

    // Last 24h
    const d = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE event = 'CREATED')::int AS created,
        COUNT(*) FILTER (WHERE event LIKE 'TP%' OR event = 'SL_HIT')::int AS resolved,
        COUNT(*) FILTER (WHERE event LIKE 'TP%')::int AS won
      FROM signal_events
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);
    stats.newSignals = d.rows[0].created;
    stats.resolved = d.rows[0].resolved;

    // Total return from last 24h wins
    const ret = await db.query(`
      SELECT SUM(result) AS total_return FROM signals_v2
      WHERE status LIKE 'TP%' AND resolved_at > NOW() - INTERVAL '24 hours'
    `);
    if (ret.rows[0].total_return) {
      stats.totalReturn = parseFloat(ret.rows[0].total_return);
    }

    // Top mover (biggest win in last 24h)
    const tm = await db.query(`
      SELECT symbol, result FROM signals_v2
      WHERE status LIKE 'TP%' AND resolved_at > NOW() - INTERVAL '24 hours'
      ORDER BY result DESC NULLS LAST LIMIT 1
    `);
    if (tm.rows.length > 0 && tm.rows[0].result) {
      stats.topMover = `${tm.rows[0].symbol} +${(parseFloat(tm.rows[0].result) * 100).toFixed(1)}%`;
    }
  } catch (err) {
    console.error("[daily] stats error:", err.message);
  }

  return stats;
}

function startDailyWorker() {
  const worker = new Worker(
    "agoraiq-daily-summary",
    async () => {
      const stats = await gatherStats();
      await pushQueue().add("daily", { stats });
      console.log("[daily] summary queued:", JSON.stringify(stats));
      return stats;
    },
    { connection: getRedis(), concurrency: 1 }
  );

  const { Queue } = require("bullmq");
  const queue = new Queue("agoraiq-daily-summary", { connection: getRedis() });
  queue.add("daily-cycle", {}, {
    repeat: { every: DAILY_INTERVAL },
    removeOnComplete: { count: 5 },
    removeOnFail: { count: 10 },
  });

  console.log("[daily-worker] started (every 24h)");
  return worker;
}

module.exports = { startDailyWorker };
