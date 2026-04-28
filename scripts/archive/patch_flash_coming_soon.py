#!/usr/bin/env python3
"""flash.html: red COMING SOON banner + honest hero copy tense.
Atomic. Idempotent. Creates .bak once."""
import os, shutil, sys

TARGET = "/opt/agoraiq-signals/web/flash.html"
BACKUP = TARGET + ".bak.coming_soon"


def main():
    with open(TARGET, "r") as f: src = f.read()
    if 'id="flash-coming-soon"' in src:
        print("ℹ️  flash.html already patched"); return
    if not os.path.exists(BACKUP):
        shutil.copy2(TARGET, BACKUP)
        print(f"✅ Backup: {BACKUP}")

    # ── 1. Red banner injected right after </nav></div> (after topbar) ──
    old = '''</nav>
</div>
<div style="max-width:1400px;margin:0 auto;padding:18px 20px 14px;border-bottom:1px solid var(--bdr);background:linear-gradient(180deg,rgba(252,213,53,.015),transparent)">'''

    new = '''</nav>
</div>

<!-- ── Coming Soon banner ── -->
<div id="flash-coming-soon" style="background:linear-gradient(90deg,#c81e3a 0%,#a8172f 100%);border-bottom:2px solid rgba(252,213,53,.5);padding:14px 20px;text-align:center;position:relative;overflow:hidden">
  <div style="position:absolute;inset:0;background:repeating-linear-gradient(45deg,transparent,transparent 10px,rgba(252,213,53,.04) 10px,rgba(252,213,53,.04) 20px);pointer-events:none"></div>
  <div style="position:relative;display:flex;align-items:center;justify-content:center;gap:14px;flex-wrap:wrap">
    <span style="font-family:var(--hd);font-weight:800;font-size:16px;letter-spacing:.15em;color:#FCD535;text-shadow:0 0 12px rgba(252,213,53,.5);background:rgba(0,0,0,.25);padding:4px 12px;border-radius:4px;border:1px solid rgba(252,213,53,.4)">⚠ COMING SOON!</span>
    <span style="font-family:var(--sans);font-size:14px;color:#fff;font-weight:500;max-width:760px;line-height:1.5">Flash Intel isn't live yet. The signals below are <strong>illustrative samples</strong> of what real-time flash-loan, liquidation, and arbitrage alerts will look like. <strong>Do not trade on this data.</strong></span>
  </div>
</div>

<div style="max-width:1400px;margin:0 auto;padding:18px 20px 14px;border-bottom:1px solid var(--bdr);background:linear-gradient(180deg,rgba(252,213,53,.015),transparent)">'''

    if old not in src: print("❌ topbar/hero anchor missing"); sys.exit(1)
    src = src.replace(old, new, 1)
    print("✅ COMING SOON banner added")

    # ── 2. Hero copy: present tense → future tense ──
    old_hero = """Flash Intel is AgoraIQ's real-time intelligence feed, converting on-chain anomalies into actionable trade signals. Each signal is monitored, resolved, and verified&mdash;giving you a transparent record of performance, not predictions."""
    new_hero = """Flash Intel <strong>will be</strong> AgoraIQ's real-time intelligence feed, converting on-chain anomalies into actionable trade signals. When live, each signal will be monitored, resolved, and verified&mdash;giving you a transparent record of performance, not predictions."""
    if old_hero not in src: print("❌ hero copy anchor missing"); sys.exit(1)
    src = src.replace(old_hero, new_hero, 1)
    print("✅ Hero copy shifted to future tense")

    # ── 3. ALPHA FEED label → DEMO PREVIEW ──
    old_label = '<span style="font-size:13px;font-weight:600;color:var(--gold);margin-left:4px">ALPHA FEED</span>'
    new_label = '<span style="font-size:13px;font-weight:600;color:var(--red);margin-left:4px">DEMO PREVIEW</span>'
    if old_label in src:
        src = src.replace(old_label, new_label, 1)
        print("✅ ALPHA FEED → DEMO PREVIEW")

    tmp = TARGET + ".tmp"
    with open(tmp, "w") as f: f.write(src)
    os.replace(tmp, TARGET)
    print("\nDone.")


if __name__ == "__main__":
    main()
