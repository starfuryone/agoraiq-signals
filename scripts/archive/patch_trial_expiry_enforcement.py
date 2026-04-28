#!/usr/bin/env python3
"""Enforce trial expiry at read-time in cards.get_plan.
Treats any trial row with expires_at <= now() as 'inactive'."""
import os, shutil, sys

TARGET = "/opt/agoraiq-signals/bot/cards.py"
BACKUP = TARGET + ".bak.expiry"
MARKER = "Trial expiry guard"


def main():
    with open(TARGET, "r") as f:
        src = f.read()
    if MARKER in src:
        print("ℹ️  Already patched"); return
    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f"✅ Backup: {BACKUP}")

    old = '''def get_plan(update, store_module) -> str:
    """Get user's plan tier. Returns 'inactive' if no active subscription or trial expired."""
    user = store_module.get_user(update.effective_user.id)
    if not user:
        return "no_account"
    plan = user.get("plan_tier")
    if not plan or plan == "free":
        return "inactive"
    return plan  # "trial", "pro", or "elite"'''

    new = '''def get_plan(update, store_module) -> str:
    """Get user's plan tier. Returns 'inactive' if no active subscription or trial expired."""
    user = store_module.get_user(update.effective_user.id)
    if not user:
        return "no_account"
    plan = user.get("plan_tier")
    if not plan or plan == "free":
        return "inactive"

    # Trial expiry guard — defense in depth against stale trial rows
    if plan == "trial":
        expires_at = user.get("expires_at") or user.get("trial_expires_at")
        if expires_at:
            try:
                from datetime import datetime, timezone
                if isinstance(expires_at, str):
                    # Handle ISO8601 with/without 'Z'
                    ts = expires_at.replace("Z", "+00:00")
                    exp = datetime.fromisoformat(ts)
                else:
                    exp = expires_at
                if exp.tzinfo is None:
                    exp = exp.replace(tzinfo=timezone.utc)
                if exp <= datetime.now(timezone.utc):
                    return "inactive"
            except Exception:
                pass  # fail-open on parse error; cron is backstop

    return plan  # "trial", "pro", or "elite"'''

    if old not in src:
        print("❌ get_plan anchor not found"); sys.exit(1)

    src = src.replace(old, new, 1)
    tmp = TARGET + ".tmp"
    with open(tmp, "w") as f: f.write(src)
    os.replace(tmp, TARGET)
    print("✅ Added trial expiry guard to get_plan")


if __name__ == "__main__":
    main()
