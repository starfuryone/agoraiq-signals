#!/usr/bin/env python3
"""Filter DATABASE_URL out of /root/.bashrc env auto-export so the stale
agoraiq?schema=public DSN stops polluting root shells."""
import os, shutil

TARGET = "/root/.bashrc"
BACKUP = TARGET + ".bak.db_leak_fix"


def main():
    with open(TARGET, "r") as f: src = f.read()

    old = 'export $(grep -v "^#" /etc/agoraiq.env | grep -v "^$" | xargs)'
    new = 'export $(grep -v "^#" /etc/agoraiq.env | grep -v "^$" | grep -v "^DATABASE_URL=" | xargs)'

    if new in src:
        print("ℹ️  Already filtered"); return
    if old not in src:
        print("❌ Exact export line not found. Inspect manually:")
        print("    grep -n agoraiq.env /root/.bashrc")
        return

    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f"✅ Backup: {BACKUP}")

    src = src.replace(old, new, 1)
    with open(TARGET, "w") as f: f.write(src)
    print("✅ DATABASE_URL filtered out of .bashrc auto-export")


if __name__ == "__main__":
    main()
