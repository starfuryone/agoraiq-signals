/**
 * Signal resolver worker.
 *
 * Every 60s:
 *   1. Fetch all OPEN signals from signals_v2
 *   2. Get current price for each
 *   3. Check conditions:
 *      - TP1 hit but TP2/TP3 exist → status=TP1, keep checking
 *      - All TPs hit → final status
 *      - SL hit → status=SL, close
 *   4. Write signal_events for every state change
 *   5. Emit push notification
 *   6. Expire stale signals (7d)
 */

const { Worker } = require("bullmq");
const { getRedis } = require("../lib/redis");
const db = require("../lib/db");
const { fetchPrice } = require("../lib/price");
const Signal = require("../models/signal");
const events = require("../lib/events");
const { pushQueue } = require("./queues");

const INTERVAL = parseInt(process.env.RESOLVER_INTERVAL_MS) || 60_000;

// Statuses that mean "still checking" (TP1/TP2 hit but higher TPs remain)
const TRACKABLE = ["OPEN", "TP1", "TP2"];

function durationSec(createdAt) {
  if (!createdAt) return 0;
  return Math.round((Date.now() - new Date(createdAt).getTime()) / 1000);
}

function formatDuration(sec) {
  if (!sec) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
}

async function resolveAll() {
  const result = await db.query(
    `SELECT * FROM signals_v2
     WHERE status IN ('OPEN','TP1','TP2')
       AND symbol IS NOT NULL AND entry IS NOT NULL`
  );

  let checked = result.rows.length;
  let resolved = 0;
  let updates = 0;

  for (const row of result.rows) {
    const sig = Signal.fromDbRow(row);
    const current = await fetchPrice(sig.symbol);
    if (current === null) continue;

    const entry = sig.entry;
    const stop = sig.stop;
    const targets = sig.targets || [];
    const oldStatus = sig.status;

    // ── Determine highest TP level hit ─────────────────────────
    let highestTpHit = null;
    let highestTpIndex = -1;

    for (let i = targets.length - 1; i >= 0; i--) {
      const tp = targets[i];
      const hit =
        sig.direction === "LONG" ? current >= tp :
        sig.direction === "SHORT" ? current <= tp : false;
      if (hit) {
        highestTpHit = `TP${i + 1}`;
        highestTpIndex = i;
        break;
      }
    }

    // ── Check SL ───────────────────────────────────────────────
    let slHit = false;
    if (stop != null) {
      slHit =
        sig.direction === "LONG" ? current <= stop :
        sig.direction === "SHORT" ? current >= stop : false;
    }

    // ── Resolve ────────────────────────────────────────────────
    if (slHit) {
      // SL always final
      const pnl = sig.direction === "LONG"
        ? (stop - entry) / entry
        : (entry - stop) / entry;
      const dur = durationSec(sig.created_at);

      await db.query(
        `UPDATE signals_v2
         SET status = 'SL', result = $1, duration_sec = $2,
             resolved_at = NOW(), updated_at = NOW()
         WHERE id = $3`,
        [pnl, dur, sig.id]
      );

      await events.logEvent(sig.id, "SL_HIT", {
        oldStatus, newStatus: "SL",
        priceAt: current, pnlAt: pnl,
        meta: { duration_sec: dur, duration: formatDuration(dur) },
      });

      await pushQueue().add("outcome", {
        signal: { ...sig, status: "SL", result: pnl, duration_sec: dur },
      }).catch(() => {});

      resolved++;
      console.log(
        `[resolver] ${sig.symbol} #${sig.id} → SL (${(pnl * 100).toFixed(2)}%, ${formatDuration(dur)})`
      );

    } else if (highestTpHit && highestTpHit !== oldStatus) {
      // New TP level hit
      const tpPrice = targets[highestTpIndex];
      const pnl = sig.direction === "LONG"
        ? (tpPrice - entry) / entry
        : (entry - tpPrice) / entry;
      const dur = durationSec(sig.created_at);

      const isFinal = highestTpIndex === targets.length - 1;

      await db.query(
        `UPDATE signals_v2
         SET status = $1, result = $2, duration_sec = $3,
             ${isFinal ? "resolved_at = NOW()," : ""} updated_at = NOW()
         WHERE id = $4`,
        [highestTpHit, pnl, dur, sig.id]
      );

      await events.logEvent(sig.id, `${highestTpHit}_HIT`, {
        oldStatus, newStatus: highestTpHit,
        priceAt: current, pnlAt: pnl,
        meta: {
          duration_sec: dur,
          duration: formatDuration(dur),
          final: isFinal,
          next_target: !isFinal && targets[highestTpIndex + 1] ? targets[highestTpIndex + 1] : null,
        },
      });

      if (isFinal) {
        // Final TP — send outcome
        await pushQueue().add("outcome", {
          signal: { ...sig, status: highestTpHit, result: pnl, duration_sec: dur },
        }).catch(() => {});
        resolved++;
      } else {
        // Partial TP — send update, keep tracking
        await pushQueue().add("update", {
          signalId: sig.id,
          event: highestTpHit,
          signal: {
            ...sig,
            status: highestTpHit,
            result: pnl,
            current_price: current,
            unrealized_pnl: pnl,
            duration_sec: dur,
            meta: {
              ...sig.meta,
              next_target: targets[highestTpIndex + 1],
            },
          },
        }).catch(() => {});
        updates++;
      }

      console.log(
        `[resolver] ${sig.symbol} #${sig.id} → ${highestTpHit}${isFinal ? " (FINAL)" : ""} ` +
        `(+${(pnl * 100).toFixed(2)}%, ${formatDuration(dur)})`
      );
    }
  }

  return { checked, resolved, updates };
}

async function expireStale() {
  const result = await db.query(`
    UPDATE signals_v2
    SET status = 'EXPIRED', updated_at = NOW(), resolved_at = NOW(),
        duration_sec = EXTRACT(EPOCH FROM (NOW() - created_at))::int
    WHERE status IN ('OPEN','TP1','TP2')
      AND created_at < NOW() - INTERVAL '7 days'
    RETURNING id, symbol
  `);

  for (const row of result.rows) {
    await events.logEvent(row.id, "EXPIRED", {
      oldStatus: "OPEN", newStatus: "EXPIRED",
    });
  }

  if (result.rows.length > 0) {
    console.log(`[resolver] expired ${result.rows.length} stale signals`);
  }
  return result.rows.length;
}

function startResolverWorker() {
  const worker = new Worker(
    "agoraiq-signal-resolver",
    async () => {
      const r = await resolveAll();
      const e = await expireStale();
      return { ...r, expired: e };
    },
    { connection: getRedis(), concurrency: 1 }
  );

  const queue = require("./queues").resolverQueue();
  queue.add("resolve-cycle", {}, {
    repeat: { every: INTERVAL },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 50 },
  });

  worker.on("completed", (job, result) => {
    if (result && (result.resolved > 0 || result.updates > 0)) {
      console.log(`[resolver] checked=${result.checked} resolved=${result.resolved} updates=${result.updates} expired=${result.expired}`);
    }
  });

  worker.on("failed", (job, err) => console.error("[resolver]", err.message));
  console.log(`[resolver-worker] started (every ${INTERVAL / 1000}s)`);
  return worker;
}

module.exports = { startResolverWorker, resolveAll };
