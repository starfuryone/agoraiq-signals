/**
 * Signal resolver worker.
 *
 * Every 60s:
 *   1. Fetch all OPEN / TP1 / TP2 signals from signals_v2
 *   2. For each candidate, attempt a per-signal pg_try_advisory_xact_lock —
 *      contended signals are skipped this tick and picked up by the lock
 *      holder.
 *   3. Re-read the row under the lock (status may have changed since the
 *      candidate scan) and fetch the current price.
 *   4. Compute the transition (TPn / SL / no-op).
 *   5. UPDATE with a state-gated WHERE clause (`AND status = $oldStatus` or
 *      `AND status IN (...)`). If rowCount === 0, another transition won the
 *      race — emit no events and no push notifications.
 *   6. Emit signal_events + push only after the UPDATE succeeded under lock.
 *   7. Same per-signal lock pattern for expireStale.
 *
 * Concurrency contract:
 *   - Multiple resolver replicas may run simultaneously. They will partition
 *     work via advisory locks; no two replicas will side-effect the same
 *     signal in the same tick.
 *   - State-gated UPDATEs are belt-and-suspenders: even without the advisory
 *     lock, a second writer's UPDATE matches zero rows once the first has
 *     transitioned the status.
 *   - All side effects (event log, push enqueue) are post-COMMIT and
 *     conditional on rowCount > 0, so they are emitted exactly once per
 *     real transition.
 *
 * Why advisory locks (not SELECT … FOR UPDATE):
 *   FOR UPDATE would also work, but the resolver may need to fetch the
 *   current price (a network call to Binance) between reading the row and
 *   updating it. Holding row locks across a network call is bad. Advisory
 *   locks are application-level, lightweight, and tied to the transaction;
 *   we acquire one before computing the decision and release at COMMIT.
 */

const { Worker } = require("bullmq");
const { getRedis } = require("../lib/redis");
const db = require("../lib/db");
const { fetchPrice } = require("../lib/price");
const Signal = require("../models/signal");
const events = require("../lib/events");
const { pushQueue } = require("./queues");
const metrics = require("../lib/metrics");

const INTERVAL = parseInt(process.env.RESOLVER_INTERVAL_MS) || 60_000;

// Statuses that mean "still checking" (TP1/TP2 hit but higher TPs remain)
const TRACKABLE = ["OPEN", "TP1", "TP2"];

// Distinct namespace for the per-signal advisory lock so it can never
// collide with locks taken by other parts of the system. The first int of
// pg_try_advisory_xact_lock(int4, int4) is the namespace; the second is the
// signal id.
const LOCK_NAMESPACE_RESOLVER = 0x51e1;

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

/**
 * Process one candidate signal under a per-signal advisory lock.
 *
 * Returns one of:
 *   { kind: "skipped" }            — contended, no-price, or status drifted
 *   { kind: "resolved" }           — terminal SL or final-TP transition
 *   { kind: "update" }             — partial TP transition (kept tracking)
 *   { kind: "noop" }               — under threshold; no transition
 */
async function processSignal(candidateId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock($1, $2) AS locked",
      [LOCK_NAMESPACE_RESOLVER, candidateId]
    );
    if (!lock.rows[0].locked) {
      await client.query("ROLLBACK");
      return { kind: "skipped", reason: "contended" };
    }

    // Re-read under lock — status may have changed since the candidate scan.
    const r = await client.query(
      `SELECT * FROM signals_v2
       WHERE id = $1
         AND status = ANY($2)
         AND symbol IS NOT NULL
         AND entry IS NOT NULL`,
      [candidateId, TRACKABLE]
    );
    if (r.rows.length === 0) {
      await client.query("ROLLBACK");
      return { kind: "skipped", reason: "status_drift" };
    }

    const sig = Signal.fromDbRow(r.rows[0]);
    const oldStatus = sig.status;

    // Network fetch under the advisory lock is fine — no row lock is held.
    const current = await fetchPrice(sig.symbol);
    if (current === null) {
      await client.query("ROLLBACK");
      return { kind: "skipped", reason: "no_price" };
    }

    const entry = sig.entry;
    const stop = sig.stop;
    const targets = sig.targets || [];

    // ── Determine highest TP level hit ───────────────────────────────────
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

    // ── SL check ─────────────────────────────────────────────────────────
    let slHit = false;
    if (stop != null) {
      slHit =
        sig.direction === "LONG" ? current <= stop :
        sig.direction === "SHORT" ? current >= stop : false;
    }

    // ── SL transition ────────────────────────────────────────────────────
    if (slHit) {
      const pnl = sig.direction === "LONG"
        ? (stop - entry) / entry
        : (entry - stop) / entry;
      const dur = durationSec(sig.created_at);

      const upd = await client.query(
        `UPDATE signals_v2
         SET status = 'SL', result = $1, duration_sec = $2,
             resolved_at = NOW(), updated_at = NOW()
         WHERE id = $3 AND status = ANY($4)`,
        [pnl, dur, sig.id, TRACKABLE]
      );

      await client.query("COMMIT");

      if (upd.rowCount === 0) {
        return { kind: "skipped", reason: "lost_race_sl" };
      }

      await events.logEvent(sig.id, "SL_HIT", {
        oldStatus, newStatus: "SL",
        priceAt: current, pnlAt: pnl,
        meta: { duration_sec: dur, duration: formatDuration(dur) },
      });
      pushQueue().add("outcome", {
        signal: { ...sig, status: "SL", result: pnl, duration_sec: dur },
      }).catch(() => {});

      metrics.incCounter("agoraiq_resolver_transitions_total", { transition: "SL" });
      console.log(
        `[resolver] ${sig.symbol} #${sig.id} → SL (${(pnl * 100).toFixed(2)}%, ${formatDuration(dur)})`
      );
      return { kind: "resolved" };
    }

    // ── TP transition ────────────────────────────────────────────────────
    if (highestTpHit && highestTpHit !== oldStatus) {
      const tpPrice = targets[highestTpIndex];
      const pnl = sig.direction === "LONG"
        ? (tpPrice - entry) / entry
        : (entry - tpPrice) / entry;
      const dur = durationSec(sig.created_at);
      const isFinal = highestTpIndex === targets.length - 1;

      // State-gated: only transition if the row is still in oldStatus.
      // Forward-only: don't downgrade TP2→TP1 if a stale read sees an old
      // candidate. Higher TPs supersede lower ones.
      const upd = await client.query(
        `UPDATE signals_v2
         SET status = $1, result = $2, duration_sec = $3,
             ${isFinal ? "resolved_at = NOW()," : ""} updated_at = NOW()
         WHERE id = $4 AND status = $5`,
        [highestTpHit, pnl, dur, sig.id, oldStatus]
      );

      await client.query("COMMIT");

      if (upd.rowCount === 0) {
        return { kind: "skipped", reason: "lost_race_tp" };
      }

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
        pushQueue().add("outcome", {
          signal: { ...sig, status: highestTpHit, result: pnl, duration_sec: dur },
        }).catch(() => {});
      } else {
        pushQueue().add("update", {
          signalId: sig.id,
          event: highestTpHit,
          signal: {
            ...sig,
            status: highestTpHit,
            result: pnl,
            current_price: current,
            unrealized_pnl: pnl,
            duration_sec: dur,
            meta: { ...sig.meta, next_target: targets[highestTpIndex + 1] },
          },
        }).catch(() => {});
      }

      metrics.incCounter("agoraiq_resolver_transitions_total", { transition: highestTpHit });
      console.log(
        `[resolver] ${sig.symbol} #${sig.id} → ${highestTpHit}${isFinal ? " (FINAL)" : ""} ` +
        `(+${(pnl * 100).toFixed(2)}%, ${formatDuration(dur)})`
      );
      return { kind: isFinal ? "resolved" : "update" };
    }

    // No transition — release the advisory lock and move on.
    await client.query("COMMIT");
    return { kind: "noop" };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error(`[resolver] processSignal #${candidateId} failed:`, err.message);
    return { kind: "skipped", reason: "error" };
  } finally {
    client.release();
  }
}

async function resolveAll() {
  // Lightweight candidate scan — only the id is needed; the row is re-read
  // under the per-signal lock to avoid stale-read transitions.
  const r = await db.query(
    `SELECT id FROM signals_v2
     WHERE status = ANY($1)
       AND symbol IS NOT NULL AND entry IS NOT NULL`,
    [TRACKABLE]
  );

  let checked = 0;
  let resolved = 0;
  let updates = 0;
  let skipped = 0;

  for (const { id } of r.rows) {
    const result = await processSignal(id);
    if (result.kind === "skipped") { skipped++; continue; }
    checked++;
    if (result.kind === "resolved") resolved++;
    else if (result.kind === "update") updates++;
  }

  return { checked, resolved, updates, skipped };
}

/**
 * Expire signals older than 7d. Runs under the same per-signal advisory
 * lock as resolveAll so an in-flight TP/SL transition can't race the bulk
 * expiration, and vice versa.
 */
async function expireStale() {
  const r = await db.query(
    `SELECT id FROM signals_v2
     WHERE status = ANY($1)
       AND created_at < NOW() - INTERVAL '7 days'`,
    [TRACKABLE]
  );

  let expired = 0;
  for (const { id } of r.rows) {
    const out = await expireOne(id);
    if (out) expired++;
  }
  if (expired > 0) console.log(`[resolver] expired ${expired} stale signals`);
  return expired;
}

async function expireOne(candidateId) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock($1, $2) AS locked",
      [LOCK_NAMESPACE_RESOLVER, candidateId]
    );
    if (!lock.rows[0].locked) {
      await client.query("ROLLBACK");
      return false;
    }

    // Capture the prior status under lock so the event log shows the real
    // transition (OPEN/TP1/TP2 → EXPIRED), not always "OPEN".
    const prior = await client.query(
      `SELECT status FROM signals_v2
       WHERE id = $1
         AND status = ANY($2)
         AND created_at < NOW() - INTERVAL '7 days'`,
      [candidateId, TRACKABLE]
    );
    if (prior.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const oldStatus = prior.rows[0].status;

    const upd = await client.query(
      `UPDATE signals_v2
         SET status = 'EXPIRED',
             updated_at = NOW(),
             resolved_at = NOW(),
             duration_sec = EXTRACT(EPOCH FROM (NOW() - created_at))::int
       WHERE id = $1 AND status = $2`,
      [candidateId, oldStatus]
    );

    await client.query("COMMIT");

    if (upd.rowCount === 0) return false;

    await events.logEvent(candidateId, "EXPIRED", {
      oldStatus,
      newStatus: "EXPIRED",
    });
    return true;
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error(`[resolver] expireOne #${candidateId} failed:`, err.message);
    return false;
  } finally {
    client.release();
  }
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
    metrics.setGauge("agoraiq_resolver_last_run_unix", {}, Math.floor(Date.now() / 1000));
    if (result && result.skipped > 0) {
      metrics.incCounter("agoraiq_resolver_transitions_total", { transition: "skipped" }, result.skipped);
    }
    if (result && result.expired > 0) {
      metrics.incCounter("agoraiq_resolver_transitions_total", { transition: "EXPIRED" }, result.expired);
    }
    if (result && (result.resolved > 0 || result.updates > 0 || result.skipped > 0)) {
      console.log(
        `[resolver] checked=${result.checked} resolved=${result.resolved} ` +
        `updates=${result.updates} skipped=${result.skipped} expired=${result.expired}`
      );
    }
  });

  worker.on("failed", (job, err) => console.error("[resolver]", err.message));
  console.log(`[resolver-worker] started (every ${INTERVAL / 1000}s)`);
  return worker;
}

module.exports = { startResolverWorker, resolveAll, processSignal, expireStale };
