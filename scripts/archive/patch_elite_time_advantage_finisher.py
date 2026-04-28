#!/usr/bin/env python3
"""
patch_elite_time_advantage_finisher.py (v2 — trial gets Elite speed)

Replaces the dispatch loop with a tier-split version where:
  • Elite + Trial → immediate (time advantage, hooks trial users)
  • Pro           → delayed by PRO_SIGNAL_DELAY_SECONDS

Idempotent: handles original loop AND prior v1 output.
"""

import os
import sys

TARGET = "/opt/agoraiq-signals/bot/pushworker.py"


def main():
    if not os.path.exists(TARGET):
        print(f"❌ {TARGET} not found")
        sys.exit(1)

    with open(TARGET, "r") as f:
        src = f.read()

    if "PRO_SIGNAL_DELAY_SECONDS" not in src:
        print("❌ Run patch_elite_time_advantage.py first (config + helper missing)")
        sys.exit(1)
    if "_delayed_pro_push" not in src:
        print("❌ Run patch_elite_time_advantage.py first (helper missing)")
        sys.exit(1)

    # The canonical new loop we want in place
    new_loop = '''        # ── Split by tier for Elite time-advantage ─────────────
        # Trial users get Elite-speed delivery as a conversion hook —
        # they feel the full product, then Pro becomes a downgrade.
        fast_users     = [u for u in users if u["plan_tier"] in ("elite", "trial")]
        delayed_users  = [u for u in users if u["plan_tier"] == "pro"]

        # ── Elite + Trial: send immediately ─────────────────────
        for user in fast_users:
            if await _safe_send(bot, user["telegram_id"], pro_msg):
                sent += 1
            await asyncio.sleep(0.05)

        # ── Pro: fire-and-forget delayed batch ──────────────────
        if delayed_users:
            if PRO_SIGNAL_DELAY_SECONDS > 0:
                asyncio.create_task(
                    _delayed_pro_push(
                        bot, delayed_users, pro_msg, PRO_SIGNAL_DELAY_SECONDS
                    )
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

    if new_loop in src:
        print("ℹ️  Already patched with trial-fast design — nothing to do")
        return

    # ── State A: original loop (fresh install) ───────────────────────
    old_loop_a = '''        # Push to active subscribers (trial, pro, elite) — no free tier
        for user in users:
            tier = user["plan_tier"]
            if tier not in ("trial", "pro", "elite"):
                continue
            ok = await _safe_send(bot, user["telegram_id"], pro_msg)
            if ok:
                sent += 1
            # Small delay to avoid Telegram rate limits
            await asyncio.sleep(0.05)'''

    # ── State B: v1 finisher already applied (trial delayed) ─────────
    old_loop_b = '''        # ── Split by tier for Elite time-advantage ─────────────
        # NOTE: trial users experience the Pro delay (previews the Pro
        # product so Elite upsell has bite). To give trial users
        # Elite-speed instead, move "trial" into the elite_users filter.
        elite_users    = [u for u in users if u["plan_tier"] == "elite"]
        delayed_users  = [u for u in users if u["plan_tier"] in ("pro", "trial")]

        # ── Elite: send immediately (time advantage) ───────────
        for user in elite_users:
            if await _safe_send(bot, user["telegram_id"], pro_msg):
                sent += 1
            await asyncio.sleep(0.05)

        # ── Pro + Trial: fire-and-forget delayed batch ─────────
        if delayed_users:
            if PRO_SIGNAL_DELAY_SECONDS > 0:
                asyncio.create_task(
                    _delayed_pro_push(
                        bot, delayed_users, pro_msg, PRO_SIGNAL_DELAY_SECONDS
                    )
                )
                log.info(
                    f"Scheduled delayed pro/trial push: "
                    f"{len(delayed_users)} users in {PRO_SIGNAL_DELAY_SECONDS}s"
                )
            else:
                for user in delayed_users:
                    if await _safe_send(bot, user["telegram_id"], pro_msg):
                        sent += 1
                    await asyncio.sleep(0.05)'''

    if old_loop_a in src:
        src = src.replace(old_loop_a, new_loop, 1)
        print("✅ Patched from original loop → trial-fast design")
    elif old_loop_b in src:
        src = src.replace(old_loop_b, new_loop, 1)
        print("✅ Migrated from v1 (trial-delayed) → trial-fast design")
    else:
        print("❌ Could not locate a recognizable loop.")
        print("   Inspect manually:")
        print("     grep -n -B2 -A15 'plan_tier' /opt/agoraiq-signals/bot/pushworker.py")
        sys.exit(1)

    with open(TARGET, "w") as f:
        f.write(src)

    print("\nNext steps:")
    print(f"  python3 -m py_compile {TARGET}")
    print("  grep -n -B1 -A20 'Split by tier for Elite' bot/pushworker.py")
    print("  systemctl restart agoraiq-signals-bot")
    print("  journalctl -u agoraiq-signals-bot -f | grep -i 'delayed pro'")


if __name__ == "__main__":
    main()
