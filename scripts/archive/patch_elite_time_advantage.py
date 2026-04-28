#!/usr/bin/env python3
"""
patch_elite_time_advantage.py

Adds PRO_SIGNAL_DELAY_SECONDS gating to bot.agoraiq.net pushworker so Elite
receives signals immediately and Pro receives them after a configurable delay.

Idempotent: safe to re-run. Creates a .bak on first run only.

Usage:
    python3 patch_elite_time_advantage.py
"""

import os
import sys
import shutil

TARGET = "/opt/agoraiq-signals/bot/pushworker.py"
BACKUP = TARGET + ".bak"


def main():
    if not os.path.exists(TARGET):
        print(f"❌ {TARGET} not found")
        sys.exit(1)

    with open(TARGET, "r") as f:
        src = f.read()

    original = src

    # ── Backup (first run only) ──────────────────────────────────────
    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f"✅ Backup written: {BACKUP}")
    else:
        print(f"ℹ️  Backup already exists: {BACKUP} (not overwriting)")

    # ── 1. Add PRO_SIGNAL_DELAY_SECONDS config ───────────────────────
    config_marker = "PRO_SIGNAL_DELAY_SECONDS"
    if config_marker in src:
        print("ℹ️  Config var already present — skipping insert")
    else:
        # Anchor: the first `import os` or `import asyncio` line
        anchor = "import asyncio"
        if anchor not in src:
            print(f"❌ Could not find anchor '{anchor}' for config insert")
            sys.exit(1)

        config_block = (
            "import asyncio\n"
            "\n"
            "# Elite time-advantage: Pro users receive signals after this delay.\n"
            "# Set to 0 to disable (Pro and Elite get signals simultaneously).\n"
            'PRO_SIGNAL_DELAY_SECONDS = int(os.environ.get("PRO_SIGNAL_DELAY_SECONDS", "600"))'
        )
        src = src.replace(anchor, config_block, 1)
        print("✅ Added PRO_SIGNAL_DELAY_SECONDS config")

    # ── 2. Add _delayed_pro_push helper ──────────────────────────────
    helper_marker = "async def _delayed_pro_push"
    if helper_marker in src:
        print("ℹ️  _delayed_pro_push helper already present — skipping insert")
    else:
        # Anchor: insert right before the main push function.
        # Based on known structure, `_check_outcomes` exists; we insert above it.
        # Fall back to inserting above the tier-dispatch loop's function.
        insert_anchor = "async def _check_outcomes"
        if insert_anchor not in src:
            # fallback — try inserting above the loop's enclosing function
            print(f"⚠️  Could not find '{insert_anchor}'. Trying fallback anchor.")
            insert_anchor = "#  OUTCOME PUSH"
            if insert_anchor not in src:
                print("❌ Could not locate an insertion point for helper")
                sys.exit(1)

        helper_block = '''async def _delayed_pro_push(
    bot,
    pro_users: list,
    pro_msg: str,
    delay_seconds: int,
) -> None:
    """Send pro-tier signals after a delay to preserve Elite time advantage."""
    try:
        await asyncio.sleep(delay_seconds)
        sent = 0
        for user in pro_users:
            try:
                if await _safe_send(bot, user["telegram_id"], pro_msg):
                    sent += 1
            except Exception as e:
                log.warning(
                    f"delayed pro push failed for {user.get('telegram_id')}: {e}"
                )
            await asyncio.sleep(0.05)
        log.info(
            f"Delayed pro push complete: {sent}/{len(pro_users)} delivered"
        )
    except asyncio.CancelledError:
        log.warning(
            f"Delayed pro push cancelled with {len(pro_users)} users pending"
        )
        raise


'''
        src = src.replace(insert_anchor, helper_block + insert_anchor, 1)
        print("✅ Added _delayed_pro_push helper")

    # ── 3. Replace the dispatch loop with tier-split version ─────────
    old_loop = '''        for user in users:
            tier = user["plan_tier"]
            msg = pro_msg if tier in ("pro", "elite") else free_msg
            ok = await _safe_send(bot, user["telegram_id"], msg)
            if ok:
                sent += 1
            # Small delay to avoid Telegram rate limits
            await asyncio.sleep(0.05)'''

    new_loop = '''        # ── Split by tier ──────────────────────────────────────
        elite_users = [u for u in users if u["plan_tier"] == "elite"]
        pro_users   = [u for u in users if u["plan_tier"] == "pro"]
        free_users  = [u for u in users if u["plan_tier"] not in ("pro", "elite")]

        # ── Elite: send immediately (time advantage) ────────────
        for user in elite_users:
            if await _safe_send(bot, user["telegram_id"], pro_msg):
                sent += 1
            await asyncio.sleep(0.05)

        # ── Free: send immediately (gated message) ──────────────
        for user in free_users:
            if await _safe_send(bot, user["telegram_id"], free_msg):
                sent += 1
            await asyncio.sleep(0.05)

        # ── Pro: fire-and-forget delayed batch ──────────────────
        if pro_users:
            if PRO_SIGNAL_DELAY_SECONDS > 0:
                asyncio.create_task(
                    _delayed_pro_push(
                        bot, pro_users, pro_msg, PRO_SIGNAL_DELAY_SECONDS
                    )
                )
                log.info(
                    f"Scheduled delayed pro push: {len(pro_users)} users in "
                    f"{PRO_SIGNAL_DELAY_SECONDS}s"
                )
            else:
                for user in pro_users:
                    if await _safe_send(bot, user["telegram_id"], pro_msg):
                        sent += 1
                    await asyncio.sleep(0.05)'''

    if new_loop in src:
        print("ℹ️  Dispatch loop already patched — skipping")
    elif old_loop not in src:
        print("❌ Could not find original dispatch loop to replace.")
        print("   File may have been modified. Inspect manually:")
        print(f"   grep -n 'plan_tier' {TARGET}")
        sys.exit(1)
    else:
        src = src.replace(old_loop, new_loop, 1)
        print("✅ Replaced dispatch loop with tier-split version")

    # ── Write if changed ─────────────────────────────────────────────
    if src == original:
        print("\nℹ️  No changes made (already patched).")
        return

    with open(TARGET, "w") as f:
        f.write(src)

    print(f"\n✅ Patch applied to {TARGET}")
    print("\nNext steps:")
    print("  1. Syntax check:")
    print(f"       python3 -m py_compile {TARGET}")
    print("  2. Add to ecosystem.config.js env block (or systemd unit):")
    print('       PRO_SIGNAL_DELAY_SECONDS: "600"')
    print("  3. Restart the bot process:")
    print("       systemctl restart agoraiq-signals-bot")
    print("       # or for PM2:")
    print("       pm2 delete <id> && pm2 start ecosystem.config.js")
    print("  4. Verify env var loaded:")
    print("       systemctl show agoraiq-signals-bot | grep PRO_SIGNAL")
    print("       # or:")
    print("       pm2 env <id> | grep PRO_SIGNAL_DELAY_SECONDS")
    print("  5. Watch logs for the 'Scheduled delayed pro push' message.")


if __name__ == "__main__":
    main()
