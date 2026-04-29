#!/usr/bin/env python3
"""
rewrite_nav.py — replace the topbar <nav> block in every web/*.html page so
they all match the canonical nav from signals.html, and set class="active"
on the link that corresponds to the current filename.

Excluded pages (untouched):
  - index.html, methodology.html         (per request)
  - login.html, magic-login.html, link.html,
    preview.html, proof-popup.html       (pre-auth / popup — Sign Out is wrong)

Operates only on pages that already have a <nav>...</nav> block. Pages
without one are skipped and reported. Group A (with <div class="topbar">)
gets a straight content swap. Group B (no topbar wrapper) gets the same
content swap but the surrounding HTML is left as-is — the caller can decide
whether to add the topbar wrapper later.
"""

import re
import sys
from pathlib import Path

WEB = Path("web")

EXCLUDE = {
    "index.html",
    "methodology.html",
    "login.html",
    "magic-login.html",
    "link.html",
    "preview.html",
    "proof-popup.html",
}

# Canonical nav. The {ACTIVE_*} markers are placeholders we replace per page.
NAV_TEMPLATE = """<nav>
    <a href="signals.html"{ACTIVE_signals}>Signals</a>
    <a href="signals-feed.html"{ACTIVE_signals_feed}>Feed</a>
    <a href="scanner.html"{ACTIVE_scanner}>Scanner</a>
    <a href="chart.html"{ACTIVE_chart}>Chart</a>
    <a href="track.html"{ACTIVE_track}>Track</a>
    <a href="watchlist.html"{ACTIVE_watchlist}>Watchlist</a>
    <a href="providers.html"{ACTIVE_providers}>Providers</a>
    <a href="https://signals.agoraiq.net">Calls</a>
    <a href="pricing.html"{ACTIVE_pricing}>Pricing</a>
    <a href="help.html"{ACTIVE_help}>Help</a>
    <a href="#" onclick="localStorage.removeItem('iq_token');window.location.href='/login.html'" style="color:var(--red)">Sign Out</a>
  </nav>"""

# Map: filename → key in the template that should get class="active".
# Mobile variants point at their desktop equivalent so the right link lights up.
ACTIVE_MAP = {
    "signals.html": "signals",
    "signals-mobile.html": "signals",
    "signals-feed.html": "signals_feed",
    "scanner.html": "scanner",
    "scanner-mobile.html": "scanner",
    "chart.html": "chart",
    "chart-mobile.html": "chart",
    "track.html": "track",
    "track-mobile.html": "track",
    "watchlist.html": "watchlist",
    "providers.html": "providers",
    "pricing.html": "pricing",
    "help.html": "help",
}

NAV_RE = re.compile(r"<nav\b[^>]*>.*?</nav>", re.DOTALL | re.IGNORECASE)


def render_nav(filename: str) -> str:
    keys = ["signals", "signals_feed", "scanner", "chart", "track", "watchlist",
            "providers", "pricing", "help"]
    sub = {f"ACTIVE_{k}": "" for k in keys}
    active_key = ACTIVE_MAP.get(filename)
    if active_key:
        sub[f"ACTIVE_{active_key}"] = ' class="active"'
    out = NAV_TEMPLATE
    for k, v in sub.items():
        out = out.replace("{" + k + "}", v)
    return out


def process(path: Path, apply: bool) -> str:
    src = path.read_text(encoding="utf-8")
    if not NAV_RE.search(src):
        return f"SKIP  {path.name}: no <nav> block found"
    new_nav = render_nav(path.name)
    # Replace only the FIRST <nav>...</nav> — that's the topbar nav. Any
    # later <nav> elements (footer mini-nav, etc.) are left untouched.
    new_src, n = NAV_RE.subn(new_nav, src, count=1)
    if new_src == src:
        return f"NOOP  {path.name}: nav already canonical"
    if apply:
        path.write_text(new_src, encoding="utf-8")
    return f"{'EDIT' if apply else 'DRY '}  {path.name}: nav rewritten"


def main():
    apply = "--apply" in sys.argv
    only = [a for a in sys.argv[1:] if a != "--apply"]
    files = sorted(p for p in WEB.glob("*.html") if p.name not in EXCLUDE)
    if only:
        files = [f for f in files if f.name in only]
    if not files:
        print("No matching files.")
        return
    print(f"=== {'APPLY' if apply else 'DRY RUN'} — {len(files)} file(s) ===")
    for f in files:
        print(process(f, apply))
    if not apply:
        print("\nRe-run with --apply to write changes.")


if __name__ == "__main__":
    main()
