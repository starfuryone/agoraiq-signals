#!/usr/bin/env python3
"""One-shot consolidated patch for Elite time-advantage.
Writes atomically — no partial states. Idempotent.
"""
import os, sys, shutil

TARGET = "/opt/agoraiq-signals/bot/pushworker.py"
BACKUP = TARGET + ".bak"


def main():
    with open(TARGET, "r") as f:
        src = f.read()
    original = src
    changes = []

    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f"✅ Backup: {BACKUP}")

    # ── 1. Config ────────────────────────────────────────────────
    if "PRO_SIGNAL_DELAY_SECONDS" in src:
        print("ℹ️  Config present")
    else:
        anchor = "import asyncio"
        if anchor not in src:
            print(f"❌ Missing anchor: {anchor}"); sys.exit(1)
        src = src.replace(anchor,
            "import asyncio\n\n"
            "# Elite time-advantage: Pro delayed by this many seconds.\n"
            "# Trial + Elite get real-time. Set 0 to disable.\n"
            'PRO_SIGNAL_DELAY_SECONDS = int(os.environ.get("PRO_SIGNAL_DELAY_SECONDS", "600"))',
            1)
        changes.append("config")

    # ── 2. Helper (inserted before enclosing function of dispatch loop) ──
    if "async def _delayed_pro_push" in src:
        print("ℹ️  Helper present")
    else:
        loop_marker = '        # Push to active subscribers (trial, pro, elite) — no free tier'
        loop_idx = src.find(loop_marker)
        if loop_idx == -1:
            print("❌ Loop marker not found"); sys.exit(1)
        func_idx = src.rfind('\nasync def ', 0, loop_idx)
        if func_idx == -1:
            print("❌ Enclosing function not found"); sys.exit(1)
        insert_pos = func_idx + 1

        helper = (
            'async def _delayed_pro_push(bot, pro_users: list, pro_msg: str, delay_seconds: int) -> None:\n'
            '    """Send pro-tier signals after delay to preserve Elite time advantage."""\n'
            '    try:\n'
            '        await asyncio.sleep(delay_seconds)\n'
            '        sent = 0\n'
            '        for user in pro_users:\n'
            '            try:\n'
            '                if await _safe_send(bot, user["telegram_id"], pro_msg):\n'
            '                    sent += 1\n'
            '            except Exception as e:\n'
            '                log.warning(f"delayed pro push failed for {user.get(\'telegram_id\')}: {e}")\n'
            '            await asyncio.sleep(0.05)\n'
            '        log.info(f"Delayed pro push complete: {sent}/{len(pro_users)} delivered")\n'
            '    except asyncio.CancelledError:\n'
            '        log.warning(f"Delayed pro push cancelled with {len(pro_users)} users pending")\n'
            '        raise\n'
            '\n\n'
        )
        src = src[:insert_pos] + helper + src[insert_pos:]
        changes.append("helper")

    # ── 3. Loop replacement ──────────────────────────────────────
    old_loop = '''        # Push to active subscribers (trial, pro, elite) — no free tier
        for user in users:
            tier = user["plan_tier"]
            if tier not in ("trial", "pro", "elite"):
                continue
            ok = await _safe_send(bot, user["telegram_id"], pro_msg)
            if ok:
                sent += 1
            # Small delay to avoid Telegram rate limits
            await asyncio.sleep(0.05)'''

    new_loop = '''        # ── Split by tier for Elite time-advantage ─────────────
        # Trial users get Elite-speed as a conversion hook.
        fast_users    = [u for u in users if u["plan_tier"] in ("elite", "trial")]
        delayed_users = [u for u in users if u["plan_tier"] == "pro"]

        # Elite + Trial: send immediately
        for user in fast_users:
            if await _safe_send(bot, user["telegram_id"], pro_msg):
                sent += 1
            await asyncio.sleep(0.05)

        # Pro: fire-and-forget delayed batch
        if delayed_users:
            if PRO_SIGNAL_DELAY_SECONDS > 0:
                asyncio.create_task(
                    _delayed_pro_push(bot, delayed_users, pro_msg, PRO_SIGNAL_DELAY_SECONDS)
                )
                log.info(
                    f"Scheduled delayed pro push: "
                    f"{len(delayed_users)} users in {PRO_SIGNAL_DELAY_SECONDS}s"
                )
            else:
                for user in delayed_users:
                    if await _safe_send(bot, user["telegram_id"], pro_msg):
                        sent += 1
                    await asyncio.sleep(0.05)'''

    if "Split by tier for Elite time-advantage" in src:
        print("ℹ️  Loop already patched")
    elif old_loop in src:
        src = src.replace(old_loop, new_loop, 1)
        changes.append("loop")
    else:
        print("❌ Loop shape unexpected. Nothing written.")
        print("   grep -n -B2 -A10 'plan_tier' " + TARGET)
        sys.exit(1)

    if src == original:
        print("ℹ️  Already fully patched"); return

    tmp = TARGET + ".tmp"
    with open(tmp, "w") as f:
        f.write(src)
    os.replace(tmp, TARGET)
    print(f"✅ Applied: {', '.join(changes)}")


if __name__ == "__main__":
    main()
