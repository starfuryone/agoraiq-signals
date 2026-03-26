/**
 * Push alert worker.
 *
 * Job types:
 *   breakout — new signal → fan out by tier:
 *     ELITE: instant + priority badge
 *     PRO:   instant + full signal
 *     FREE:  delayed 10 min + locked paywall
 *
 *   outcome — signal resolved → pro/elite only
 *   update  — partial TP hit → signal owner + followers
 *   daily   — daily summary → all users, gated by tier
 *   delayed — delayed delivery for free users (re-queued from breakout)
 */

const { Worker } = require("bullmq");
const { getRedis } = require("../lib/redis");
const db = require("../lib/db");
const telegram = require("../lib/telegram");
const msg = require("../lib/messages");
const events = require("../lib/events");
const pw = require("../lib/password");

async function makeAuthUrl(userId, path) {
  const raw = pw.randomToken();
  const hash = pw.hashToken(raw);
  const exp = new Date(Date.now() + 10 * 60 * 1000); // 10 min
  await db.query(
    `INSERT INTO bot_sessions (bot_user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, 'push_auth', $3)`,
    [userId, hash, exp]
  );
  const base = process.env.APP_URL || "https://bot.agoraiq.net";
  return `${base}/${path}?auth=${raw}`;
}

const BATCH_DELAY = parseInt(process.env.PUSH_BATCH_DELAY_MS) || 50;
const FREE_DELAY_MS = 600_000; // 10 minutes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── User queries ──────────────────────────────────────────────────

async function getLinkedUsers() {
  try {
    const r = await db.query(`
      SELECT u.id, u.email, t.telegram_id,
             COALESCE(s.plan_tier, 'free') AS plan_tier
      FROM bot_users u
      JOIN bot_telegram_accounts t ON t.bot_user_id = u.id AND t.unlinked_at IS NULL
      LEFT JOIN bot_subscriptions s ON s.bot_user_id = u.id
    `);
    return r.rows;
  } catch {
    return [];
  }
}

async function removeBlockedUser(telegramId) {
  await db.query(
    "UPDATE bot_telegram_accounts SET unlinked_at = NOW() WHERE telegram_id = $1 AND unlinked_at IS NULL",
    [telegramId]
  );
  console.log(`[push] unlinked blocked telegram user ${telegramId}`);
}

async function logPush(signalId, userId, telegramId, eventType, tier, delivered, delayedUntil) {
  try {
    await db.query(
      `INSERT INTO push_log (signal_id, bot_user_id, telegram_id, event_type, plan_tier, delivered, delayed_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [signalId, userId, telegramId, eventType, tier, delivered, delayedUntil]
    );
  } catch { /* non-fatal */ }
}

// ── Breakout handler ──────────────────────────────────────────────

async function handleBreakout(signal) {
  const users = await getLinkedUsers();
  let sent = 0, delayed = 0, blocked = 0;

  for (const user of users) {
    const tier = user.plan_tier;

    if (tier === "elite") {
      // ── ELITE: instant + priority badge ────────────────────
      const text = `⚡ <b>PRIORITY</b>\n\n` + msg.breakoutAlert(signal);
      const viewUrl = await makeAuthUrl(user.id, "signals.html");
      const buttons = [[{ text: "📊 View Signal", url: viewUrl }]];
      const result = await telegram.sendWithButtons(user.telegram_id, text, buttons);

      if (result.blocked) { await removeBlockedUser(user.telegram_id); blocked++; }
      else if (result.ok) { sent++; }
      await logPush(signal.id, user.id, user.telegram_id, "breakout", tier, result.ok, null);

    } else if (tier === "pro") {
      // ── PRO: instant + full signal ─────────────────────────
      const text = msg.breakoutAlert(signal);
      const viewUrl = await makeAuthUrl(user.id, "signals.html");
      const buttons = [[{ text: "📊 View Signal", url: viewUrl }]];
      const result = await telegram.sendWithButtons(user.telegram_id, text, buttons);

      if (result.blocked) { await removeBlockedUser(user.telegram_id); blocked++; }
      else if (result.ok) { sent++; }
      await logPush(signal.id, user.id, user.telegram_id, "breakout", tier, result.ok, null);

    } else {
      // ── FREE: delayed + locked paywall ─────────────────────
      // Re-queue with delay
      const q = require("./queues").pushQueue();
      const delayedUntil = new Date(Date.now() + FREE_DELAY_MS);
      await q.add("delayed", {
        signal,
        userId: user.id,
        telegramId: user.telegram_id,
        tier: "free",
      }, { delay: FREE_DELAY_MS });
      delayed++;
      await logPush(signal.id, user.id, user.telegram_id, "breakout_delayed", "free", false, delayedUntil);
    }

    await sleep(BATCH_DELAY);
  }

  console.log(`[push:breakout] ${signal.symbol} → sent=${sent} delayed=${delayed} blocked=${blocked}`);
  return { sent, delayed, blocked };
}

// ── Delayed delivery (free users) ─────────────────────────────────

async function handleDelayed(data) {
  const { signal, telegramId, userId, tier } = data;
  const text = msg.lockedSignal(signal);
  const buttons = msg.lockedButtons();

  const result = await telegram.sendWithButtons(telegramId, text, buttons);
  if (result.blocked) await removeBlockedUser(telegramId);
  await logPush(signal.id, userId, telegramId, "breakout_free", tier, result.ok, null);

  return { sent: result.ok ? 1 : 0 };
}

// ── Outcome handler (TP final / SL) ──────────────────────────────

async function handleOutcome(data) {
  const { signal } = data;
  const users = await getLinkedUsers();
  let sent = 0;

  const text = msg.signalOutcome(signal);

  for (const user of users) {
    // Only pro/elite get outcome notifications
    if (user.plan_tier !== "pro" && user.plan_tier !== "elite") continue;

    const result = await telegram.send(user.telegram_id, text);
    if (result.blocked) await removeBlockedUser(user.telegram_id);
    else if (result.ok) sent++;
    await sleep(BATCH_DELAY);
  }

  console.log(`[push:outcome] ${signal.symbol} ${signal.status} → sent=${sent}`);
  return { sent };
}

// ── Update handler (partial TP) ───────────────────────────────────

async function handleUpdate(data) {
  const { signalId, event, signal } = data;

  // Notify signal owner
  if (signal.bot_user_id) {
    try {
      const r = await db.query(
        `SELECT t.telegram_id FROM bot_telegram_accounts t
         WHERE t.bot_user_id = $1 AND t.unlinked_at IS NULL`,
        [signal.bot_user_id]
      );
      if (r.rows.length > 0) {
        const nextTp = signal.meta?.next_target;
        let text = msg.signalUpdate(signal, event);
        if (nextTp) {
          text += `\n🎯 Next target: <code>${nextTp.toLocaleString("en-US", { style: "currency", currency: "USD" })}</code>`;
        }
        const result = await telegram.send(r.rows[0].telegram_id, text);
        if (result.blocked) await removeBlockedUser(r.rows[0].telegram_id);
      }
    } catch { /* non-fatal */ }
  }

  // Notify followers of the provider
  if (signal.provider_id) {
    try {
      const r = await db.query(
        `SELECT t.telegram_id FROM bot_user_provider_follows f
         JOIN bot_telegram_accounts t ON t.bot_user_id = f.bot_user_id AND t.unlinked_at IS NULL
         WHERE f.provider_id = $1`,
        [signal.provider_id]
      );
      const text = msg.signalUpdate(signal, event);
      for (const row of r.rows) {
        const result = await telegram.send(row.telegram_id, text);
        if (result.blocked) await removeBlockedUser(row.telegram_id);
        await sleep(BATCH_DELAY);
      }
    } catch { /* non-fatal */ }
  }

  return { sent: 1 };
}

// ── Daily handler ─────────────────────────────────────────────────

async function handleDaily(data) {
  const users = await getLinkedUsers();
  let sent = 0;

  for (const user of users) {
    const text =
      user.plan_tier === "pro" || user.plan_tier === "elite"
        ? msg.dailySummary(data.stats)
        : msg.dailySummaryFree(data.stats);

    const result = await telegram.send(user.telegram_id, text);
    if (result.blocked) await removeBlockedUser(user.telegram_id);
    else if (result.ok) sent++;
    await sleep(BATCH_DELAY);
  }

  console.log(`[push:daily] sent=${sent}`);
  return { sent };
}

// ── Worker ────────────────────────────────────────────────────────

function startPushWorker() {
  const worker = new Worker(
    "agoraiq-push-alerts",
    async (job) => {
      switch (job.name) {
        case "breakout": return handleBreakout(job.data);
        case "delayed":  return handleDelayed(job.data);
        case "outcome":  return handleOutcome(job.data);
        case "update":   return handleUpdate(job.data);
        case "daily":    return handleDaily(job.data);
        default: console.warn(`[push] unknown: ${job.name}`);
      }
    },
    { connection: getRedis(), concurrency: 1 }
  );

  worker.on("failed", (job, err) => console.error(`[push] ${job?.name} failed:`, err.message));
  console.log("[push-worker] started");
  return worker;
}

module.exports = { startPushWorker };
