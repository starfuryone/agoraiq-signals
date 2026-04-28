#!/usr/bin/env python3
"""Patch cmd_start to give 'trial' users a distinct Elite-speed welcome.
Pro/Elite users keep the existing welcome-back message.
Idempotent, atomic write, creates .bak on first run.
"""
import os, shutil, sys

TARGET = "/opt/agoraiq-signals/bot/bot.py"
BACKUP = TARGET + ".bak.trial_msg"
MARKER = "Your Elite trial is LIVE"  # idempotency sentinel


def main():
    with open(TARGET, "r") as f:
        src = f.read()

    if MARKER in src:
        print("ℹ️  Already patched — nothing to do")
        return

    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f"✅ Backup: {BACKUP}")

    # Anchor — the existing premium branch opening
    old = '''    if cards.is_premium(plan):
        tier = plan.upper()
        msg = (
            f"\\U0001f44b <b>Welcome back, {name}!</b> You're on the <b>{tier}</b> plan.\\n\\n"'''

    if old not in src:
        print("❌ Could not find is_premium branch anchor.")
        print("   grep -n 'is_premium(plan)' " + TARGET)
        sys.exit(1)

    new = '''    if plan == "trial":
        msg = (
            f"\\U0001f3af <b>Welcome {name}! Your Elite trial is LIVE.</b>\\n\\n"
            "For the next <b>24 hours</b> you're getting signals "
            "<b>the instant they fire</b> \\u2014 the exact same speed "
            "paying Elite members get them.\\n\\n"
            "No delay. No lag. Same alerts.\\n\\n"
            "<b>\\U0001f4ca Try these now</b>\\n"
            "\\U0001f539 /signals \\u2014 Latest breakout signals\\n"
            "\\U0001f539 /top \\u2014 Top breakout candidates\\n"
            "\\U0001f539 /momentum \\u2014 Strongest momentum\\n"
            "\\U0001f539 /proof \\u2014 See verified track record\\n\\n"
            "<b>\\u23f0 When your trial ends</b>\\n"
            "\\U0001f539 <b>Elite $99/mo</b> \\u2014 keep real-time speed\\n"
            "\\U0001f539 <b>Pro $29/mo</b> \\u2014 same signals, 10-minute delay\\n\\n"
            "Feel the difference now. Decide later.\\n\\n"
            "Type /help for all commands \\u00b7 /upgrade to stay Elite"
        )
        await update.message.reply_text(msg, parse_mode="HTML", disable_web_page_preview=True)

    elif cards.is_premium(plan):
        tier = plan.upper()
        msg = (
            f"\\U0001f44b <b>Welcome back, {name}!</b> You're on the <b>{tier}</b> plan.\\n\\n"'''

    src = src.replace(old, new, 1)

    tmp = TARGET + ".tmp"
    with open(tmp, "w") as f:
        f.write(src)
    os.replace(tmp, TARGET)
    print("✅ Patched cmd_start with trial-specific welcome")


if __name__ == "__main__":
    main()
