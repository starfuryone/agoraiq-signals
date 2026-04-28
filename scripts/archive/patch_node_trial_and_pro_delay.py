#!/usr/bin/env python3
"""Consolidated Node-side patch — Elite time advantage + trial fixes + price fix.
Atomic. Idempotent. Creates .bak on first run.
"""
import os, shutil, sys

MESSAGES = "/opt/agoraiq-signals/api/src/lib/messages.js"
PUSH     = "/opt/agoraiq-signals/api/src/workers/push.js"


def atomic_write(path, src):
    tmp = path + ".tmp"
    with open(tmp, "w") as f: f.write(src)
    os.replace(tmp, path)


def backup_once(path):
    bak = path + ".bak.pro_delay"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        print(f"✅ Backup: {bak}")


# ── messages.js: price fix ───────────────────────────────────────
def patch_messages():
    with open(MESSAGES, "r") as f: src = f.read()
    if "`💎 Plans from $29/mo`" in src:
        print("ℹ️  messages.js already patched"); return
    old = "`💎 Plans from $19/mo`"
    if old not in src:
        print("❌ messages.js: $19/mo not found"); sys.exit(1)
    backup_once(MESSAGES)
    src = src.replace(old, "`💎 Plans from $29/mo`", 1)
    atomic_write(MESSAGES, src)
    print("✅ messages.js: $19 → $29")


# ── push.js ──────────────────────────────────────────────────────
def patch_push():
    with open(PUSH, "r") as f: src = f.read()
    if "PRO_DELAY_MS" in src:
        print("ℹ️  push.js already patched"); return

    backup_once(PUSH)

    # ─ 1. Add PRO_DELAY_MS constant ────────────────────────────
    old = 'const FREE_DELAY_MS = 600_000; // 10 minutes'
    new = (
        'const FREE_DELAY_MS = 600_000; // 10 minutes\n'
        'const PRO_DELAY_MS = parseInt(process.env.PRO_DELAY_MS) || 600_000;'
        ' // Elite time advantage over Pro'
    )
    if old not in src: print("❌ FREE_DELAY_MS anchor missing"); sys.exit(1)
    src = src.replace(old, new, 1)

    # ─ 2. getLinkedUsers: filter expired trials ───────────────
    old = """    const r = await db.query(`
      SELECT u.id, u.email, t.telegram_id,
             COALESCE(s.plan_tier, 'free') AS plan_tier
      FROM bot_users u
      JOIN bot_telegram_accounts t ON t.bot_user_id = u.id AND t.unlinked_at IS NULL
      LEFT JOIN bot_subscriptions s ON s.bot_user_id = u.id
    `);"""
    new = """    const r = await db.query(`
      SELECT u.id, u.email, t.telegram_id,
             CASE
               WHEN s.plan_tier IN ('pro','elite') THEN s.plan_tier
               WHEN s.plan_tier = 'trial' AND s.expires_at > NOW() THEN 'trial'
               ELSE 'free'
             END AS plan_tier
      FROM bot_users u
      JOIN bot_telegram_accounts t ON t.bot_user_id = u.id AND t.unlinked_at IS NULL
      LEFT JOIN bot_subscriptions s ON s.bot_user_id = u.id
    `);"""
    if old not in src: print("❌ getLinkedUsers anchor missing"); sys.exit(1)
    src = src.replace(old, new, 1)

    # ─ 3. Replace the entire handleBreakout inner if/else chain ─
    # Elite + Trial → instant priority
    # Pro          → delayed full signal (Elite time advantage)
    # Free         → delayed locked (unchanged)
    old = '''    if (tier === "elite") {
      // ── ELITE: instant + priority badge ────────────────────
      const text = `⚡ <b>PRIORITY</b>\\n\\n` + msg.breakoutAlert(signal);
      const viewUrl = await makeAuthUrl(user.id, "signals.html");
      const buttons = [
        [{ text: "📊 View Signal", url: viewUrl }],
        [{ text: "📡 Track Signal", callback_data: `track:${signal.id}` }],
      ];
      const result = await telegram.sendWithButtons(user.telegram_id, text, buttons);

      if (result.blocked) { await removeBlockedUser(user.telegram_id); blocked++; }
      else if (result.ok) { sent++; }
      await logPush(signal.id, user.id, user.telegram_id, "breakout", tier, result.ok, null);

    } else if (tier === "pro") {
      // ── PRO: instant + full signal ─────────────────────────
      const text = msg.breakoutAlert(signal);
      const viewUrl = await makeAuthUrl(user.id, "signals.html");
      const buttons = [
        [{ text: "📊 View Signal", url: viewUrl }],
        [{ text: "📡 Track Signal", callback_data: `track:${signal.id}` }],
      ];
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
    }'''

    new = '''    if (tier === "elite" || tier === "trial") {
      // ── ELITE / TRIAL: instant + priority (trial = conversion hook) ──
      const text = `⚡ <b>PRIORITY</b>\\n\\n` + msg.breakoutAlert(signal);
      const viewUrl = await makeAuthUrl(user.id, "signals.html");
      const buttons = [
        [{ text: "📊 View Signal", url: viewUrl }],
        [{ text: "📡 Track Signal", callback_data: `track:${signal.id}` }],
      ];
      const result = await telegram.sendWithButtons(user.telegram_id, text, buttons);

      if (result.blocked) { await removeBlockedUser(user.telegram_id); blocked++; }
      else if (result.ok) { sent++; }
      await logPush(signal.id, user.id, user.telegram_id, "breakout", tier, result.ok, null);

    } else if (tier === "pro") {
      // ── PRO: delayed full signal (Elite time-advantage gate) ──
      const q = require("./queues").pushQueue();
      const delayedUntil = new Date(Date.now() + PRO_DELAY_MS);
      await q.add("delayed", {
        signal,
        userId: user.id,
        telegramId: user.telegram_id,
        tier: "pro",
      }, { delay: PRO_DELAY_MS });
      delayed++;
      await logPush(signal.id, user.id, user.telegram_id, "breakout_pro_delayed", "pro", false, delayedUntil);

    } else {
      // ── FREE: delayed + locked paywall ─────────────────────
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
    }'''

    if old not in src: print("❌ handleBreakout if-chain anchor missing"); sys.exit(1)
    src = src.replace(old, new, 1)

    # ─ 4. handleDelayed: branch on tier ───────────────────────
    old = '''async function handleDelayed(data) {
  const { signal, telegramId, userId, tier } = data;
  const text = msg.lockedSignal(signal);
  const buttons = msg.lockedButtons();

  const result = await telegram.sendWithButtons(telegramId, text, buttons);
  if (result.blocked) await removeBlockedUser(telegramId);
  await logPush(signal.id, userId, telegramId, "breakout_free", tier, result.ok, null);

  return { sent: result.ok ? 1 : 0 };
}'''
    new = '''async function handleDelayed(data) {
  const { signal, telegramId, userId, tier } = data;

  let text, buttons, eventType;
  if (tier === "pro") {
    // Pro: full signal, delivered after the Elite-advantage delay
    text = msg.breakoutAlert(signal);
    const viewUrl = await makeAuthUrl(userId, "signals.html");
    buttons = [
      [{ text: "📊 View Signal", url: viewUrl }],
      [{ text: "📡 Track Signal", callback_data: `track:${signal.id}` }],
    ];
    eventType = "breakout_pro";
  } else {
    // Free: locked paywall after free-tier delay
    text = msg.lockedSignal(signal);
    buttons = msg.lockedButtons();
    eventType = "breakout_free";
  }

  const result = await telegram.sendWithButtons(telegramId, text, buttons);
  if (result.blocked) await removeBlockedUser(telegramId);
  await logPush(signal.id, userId, telegramId, eventType, tier, result.ok, null);

  return { sent: result.ok ? 1 : 0 };
}'''
    if old not in src: print("❌ handleDelayed anchor missing"); sys.exit(1)
    src = src.replace(old, new, 1)

    # ─ 5. handleOutcome: include trial ────────────────────────
    old = '    if (user.plan_tier !== "pro" && user.plan_tier !== "elite") continue;'
    new = '    if (!["pro","elite","trial"].includes(user.plan_tier)) continue;'
    if old not in src: print("❌ handleOutcome anchor missing"); sys.exit(1)
    src = src.replace(old, new, 1)

    # ─ 6. handleDaily: include trial ──────────────────────────
    old = '''      user.plan_tier === "pro" || user.plan_tier === "elite"
        ? msg.dailySummary(data.stats)
        : msg.dailySummaryFree(data.stats);'''
    new = '''      ["pro","elite","trial"].includes(user.plan_tier)
        ? msg.dailySummary(data.stats)
        : msg.dailySummaryFree(data.stats);'''
    if old not in src: print("❌ handleDaily anchor missing"); sys.exit(1)
    src = src.replace(old, new, 1)

    atomic_write(PUSH, src)
    print("✅ push.js: 6 changes applied")


patch_messages()
patch_push()
print("\nDone.")
