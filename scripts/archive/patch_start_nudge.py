#!/usr/bin/env python3
"""Adds '/start' nudge to /connect and /status so trial users land on the
Elite-speed welcome message after linking."""
import os, shutil, sys

TARGET = "/opt/agoraiq-signals/bot/bot.py"
BACKUP = TARGET + ".bak.start_nudge"
MARKER = "After linking, tap /start"  # idempotency sentinel


def main():
    with open(TARGET, "r") as f:
        src = f.read()

    if MARKER in src:
        print("ℹ️  Already patched"); return

    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f"✅ Backup: {BACKUP}")

    # ── 1. /connect: replace the tail line ───────────────────────────
    old_connect = (
        '            f"\\u23f1 Link expires in 5 minutes\\\\.\\n\\n"\n'
        '            f"After linking, use /status to verify\\\\.",'
    )
    new_connect = (
        '            f"\\u23f1 Link expires in 5 minutes\\\\.\\n\\n"\n'
        '            f"\\u2728 {bold(\'After linking, tap /start\')} to unlock your trial \\\\+\\n"\n'
        '            f"start receiving real\\\\-time signals instantly\\\\.\\n\\n"\n'
        '            f"Or /status to verify the link\\\\.",'
    )
    if old_connect not in src:
        print("❌ /connect anchor not found"); sys.exit(1)
    src = src.replace(old_connect, new_connect, 1)

    # ── 2. /status: append a nudge line before the closing paren ─────
    old_status = (
        '        await update.message.reply_text(\n'
        '            f"📋 {bold(\'Account Status\')}\\n\\n"\n'
        '            f"📧 Email: {mono(email)}\\n"\n'
        '            f"💎 Plan: {bold(plan.upper())}\\n"\n'
        '            f"🔗 Telegram: linked ✅",\n'
        '            parse_mode=ParseMode.MARKDOWN_V2,\n'
        '        )'
    )
    new_status = (
        '        await update.message.reply_text(\n'
        '            f"📋 {bold(\'Account Status\')}\\n\\n"\n'
        '            f"📧 Email: {mono(email)}\\n"\n'
        '            f"💎 Plan: {bold(plan.upper())}\\n"\n'
        '            f"🔗 Telegram: linked ✅\\n\\n"\n'
        '            f"\\u2728 Tap /start to see your plan features \\\\+ live commands\\\\.",\n'
        '            parse_mode=ParseMode.MARKDOWN_V2,\n'
        '        )'
    )
    if old_status not in src:
        print("❌ /status anchor not found"); sys.exit(1)
    src = src.replace(old_status, new_status, 1)

    tmp = TARGET + ".tmp"
    with open(tmp, "w") as f: f.write(src)
    os.replace(tmp, TARGET)
    print("✅ Added /start nudge to /connect and /status")


if __name__ == "__main__":
    main()
