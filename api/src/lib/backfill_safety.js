/**
 * Backfill safety helper.
 *
 * Production backfill scripts share three requirements:
 *
 *   1. Mutual exclusion — never two backfills running concurrently against
 *      the same dimension (entries, scores, hashes). Implemented via a
 *      Postgres session-level advisory lock (pg_try_advisory_lock).
 *
 *   2. Mandatory --apply opt-in — a bare invocation must be a dry run, so
 *      a fat-fingered SSH session can't mutate production data.
 *
 *   3. Per-row audit trail — every UPDATE must record an entry in
 *      signal_events so the change is traceable to its operator and run.
 *
 * Usage:
 *
 *   const safety = require("./lib/backfill_safety");
 *   const ctx = await safety.begin({
 *     name: "backfill_signal_hashes",
 *     argv: process.argv,
 *   });
 *   try {
 *     // ... iterate and modify rows ...
 *     await safety.audit(ctx, { signal_id, change: { ... } });
 *   } finally {
 *     await safety.end(ctx);
 *   }
 *
 * Lock semantics:
 *   - pg_try_advisory_lock returns false if another session holds the same
 *     name. We exit with status 75 (EX_TEMPFAIL) so cron / systemd can
 *     distinguish "already running" from a real error.
 *   - The lock is held on a dedicated client checked out from the pool
 *     for the lifetime of the script; releasing the client (or process
 *     exit) auto-releases the lock.
 *   - Each backfill picks its own integer key. Use a stable hash of the
 *     name so two scripts can't collide.
 */

const crypto = require("crypto");
const db = require("./db");

const LOCK_NAMESPACE = 0x6BACF111; // signed int4-safe; distinct from resolver (0x51e1)

function lockKey(name) {
  // pg_advisory_lock(int4, int4) — first int is namespace, second is the
  // backfill-specific id. Hash the name into a stable int4.
  const h = crypto.createHash("sha256").update(name).digest();
  // signed int4 range
  const id = h.readInt32BE(0);
  return { ns: LOCK_NAMESPACE, id };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  return {
    apply: args.includes("--apply"),
    dryRun: !args.includes("--apply"),
    limit: parseLimit(args),
    force: args.includes("--force"),
    raw: args,
  };
}

function parseLimit(args) {
  const idx = args.indexOf("--limit");
  if (idx >= 0 && args[idx + 1]) {
    const n = parseInt(args[idx + 1], 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  for (const a of args) {
    if (a.startsWith("--limit=")) {
      const n = parseInt(a.split("=")[1], 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/**
 * Acquire the advisory lock and return an opaque context. Throws on any
 * setup failure; exits the process with code 75 if another backfill is
 * already holding the lock.
 */
async function begin({ name, argv }) {
  if (!name || typeof name !== "string") {
    throw new Error("backfill_safety.begin: `name` is required");
  }
  const args = parseArgs(argv || []);
  const { ns, id } = lockKey(name);

  const client = await db.connect();
  let held = false;
  try {
    const r = await client.query(
      "SELECT pg_try_advisory_lock($1, $2) AS got",
      [ns, id]
    );
    held = r.rows[0].got === true;
  } catch (err) {
    client.release();
    throw err;
  }

  if (!held) {
    client.release();
    console.error(
      `[${name}] another instance holds the advisory lock — refusing to run.\n` +
      `If you are sure no other backfill is in progress, check pg_locks for ` +
      `objid=${id} and release manually.`
    );
    process.exit(75); // EX_TEMPFAIL
  }

  if (args.dryRun) {
    console.log(`[${name}] === DRY RUN === (pass --apply to write)`);
  } else {
    console.log(`[${name}] === APPLY MODE — writes are live ===`);
  }

  return {
    name,
    args,
    client,
    ns,
    id,
    startedAt: Date.now(),
    audited: 0,
  };
}

/**
 * Record a row-level change to signal_events. No-op in dry run.
 *
 * @param {object} ctx       output of begin()
 * @param {object} entry
 * @param {number} entry.signal_id
 * @param {object} entry.change   arbitrary JSON describing the change
 * @param {string} [entry.event] event name (default: "BACKFILL_<NAME>")
 */
async function audit(ctx, { signal_id, change, event }) {
  if (!Number.isFinite(signal_id)) {
    throw new Error("backfill_safety.audit: signal_id must be a number");
  }
  if (ctx.args.dryRun) return;
  const ev = event || `BACKFILL_${ctx.name.toUpperCase()}`;
  await ctx.client.query(
    `INSERT INTO signal_events (signal_id, event, meta)
     VALUES ($1, $2, $3)`,
    [signal_id, ev, JSON.stringify({ ...change, run_started_at: new Date(ctx.startedAt).toISOString() })]
  );
  ctx.audited++;
}

/**
 * Release the advisory lock, return the client, end the pool. Call this
 * exactly once in a finally block.
 */
async function end(ctx) {
  if (!ctx) return;
  try {
    await ctx.client.query("SELECT pg_advisory_unlock($1, $2)", [ctx.ns, ctx.id]);
  } catch (err) {
    console.warn(`[${ctx.name}] advisory unlock failed:`, err.message);
  }
  try { ctx.client.release(); } catch {}
  if (ctx.audited > 0) {
    console.log(`[${ctx.name}] audited ${ctx.audited} rows to signal_events`);
  }
}

module.exports = { begin, end, audit, parseArgs };
