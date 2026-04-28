#!/usr/bin/env python3
"""Hardens trial_reminders.py:
  1. Ignore polluted shell DATABASE_URL (Prisma ?schema= fails psycopg2)
  2. Strip ?query params from any DSN regardless
  3. Replace deprecated datetime.utcnow() with timezone-aware datetime.now(UTC)
Idempotent, atomic, creates .bak once.
"""
import os, shutil, sys

TARGET = "/opt/agoraiq-signals/scripts/trial_reminders.py"
BACKUP = TARGET + ".bak.fixes"


def main():
    with open(TARGET, "r") as f:
        src = f.read()
    original = src

    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f"✅ Backup: {BACKUP}")

    # ── Fix 1: datetime import ──────────────────────────────────
    old = "from datetime import datetime"
    new = "from datetime import datetime, timezone"
    if "from datetime import datetime, timezone" in src:
        print("ℹ️  datetime import already has timezone")
    elif old in src:
        src = src.replace(old, new, 1)
        print("✅ Added timezone to datetime import")
    else:
        print("❌ datetime import line not found"); sys.exit(1)

    # ── Fix 2: DB_DSN resolution — use dedicated env var + strip query ──
    old_dsn = '''DB_DSN = os.environ.get(
    "DATABASE_URL",
    "postgresql://agoraiq_signals:desf19848@127.0.0.1:5432/agoraiq_signals",
)'''
    new_dsn = '''# Use dedicated env var, not DATABASE_URL — a stale Prisma-style DSN
# (postgresql://...?schema=public) is loose in the system env and psycopg2
# doesn't accept ?query params.
DB_DSN = os.environ.get(
    "TRIAL_REMINDERS_DSN",
    "postgresql://agoraiq_signals:desf19848@127.0.0.1:5432/agoraiq_signals",
)
# Strip any ?query params — psycopg2 rejects things like ?schema=public
if "?" in DB_DSN:
    DB_DSN = DB_DSN.split("?", 1)[0]'''

    if "TRIAL_REMINDERS_DSN" in src:
        print("ℹ️  DSN hardening already applied")
    elif old_dsn in src:
        src = src.replace(old_dsn, new_dsn, 1)
        print("✅ DSN hardened (ignores DATABASE_URL, strips ?query)")
    else:
        print("❌ DB_DSN block not found"); sys.exit(1)

    # ── Fix 3: replace deprecated datetime.utcnow() ─────────────
    count = src.count("datetime.utcnow()")
    if count == 0 and "datetime.now(timezone.utc)" in src:
        print("ℹ️  utcnow() already replaced")
    elif count > 0:
        src = src.replace("datetime.utcnow()", "datetime.now(timezone.utc)")
        print(f"✅ Replaced {count} datetime.utcnow() call(s)")
    else:
        print("⚠️  No utcnow() calls found (unexpected)")

    if src == original:
        print("\nℹ️  No changes needed")
        return

    tmp = TARGET + ".tmp"
    with open(tmp, "w") as f: f.write(src)
    os.replace(tmp, TARGET)
    print("\n✅ Patch applied")


if __name__ == "__main__":
    main()
