#!/usr/bin/env python3
# /opt/agoraiq-signals/scripts/patch_nav.py
import re
from pathlib import Path

WEB = Path("/opt/agoraiq-signals/web")

MENU_ITEMS = [
    ("signals.html",    "Signals",   "signals.html"),
    ("scanner.html",    "Scanner",   "scanner.html"),
    ("chart.html",      "Chart",     "chart.html"),
    ("track.html",      "Track",     "track.html"),
    ("watchlist.html",  "Watchlist", "watchlist.html"),
    ("providers.html",  "Providers", "providers.html"),
    ("https://signals.agoraiq.net", "Calls", "__calls__"),
    ("pricing.html",    "Pricing",   "pricing.html"),
    ("help.html",       "Help",      "help.html"),
]

SIGNOUT = (
    '<a href="#" onclick="localStorage.removeItem(\'iq_token\');'
    'window.location.href=\'/login.html\'" style="color:var(--red)">Sign Out</a>'
)

NAV_RE = re.compile(r"<nav\b[^>]*>.*?</nav>", re.DOTALL | re.IGNORECASE)

def build_nav(current_file: str) -> str:
    lines = ["<nav>"]
    for href, label, match_key in MENU_ITEMS:
        active = ' class="active"' if match_key == current_file else ""
        lines.append(f'    <a href="{href}"{active}>{label}</a>')
    lines.append(f"    {SIGNOUT}")
    lines.append("  </nav>")
    return "\n  ".join(lines[:1]) + "\n" + "\n".join("  " + l for l in lines[1:])

changed = skipped = 0
for html in sorted(WEB.glob("*.html")):
    # Skip mobile variants - they have their own nav layout
    if html.name.endswith("-mobile.html"):
        skipped += 1
        continue
    text = html.read_text(encoding="utf-8")
    if not NAV_RE.search(text):
        print(f"  no <nav> found: {html.name}")
        skipped += 1
        continue
    new_nav = build_nav(html.name)
    new_text = NAV_RE.sub(new_nav, text, count=1)
    if new_text != text:
        html.write_text(new_text, encoding="utf-8")
        print(f"  patched: {html.name}")
        changed += 1
    else:
        skipped += 1

print(f"\nDone. changed={changed} skipped={skipped}")
