#!/usr/bin/env python3
"""
patch-caddy-smart-alerts.py

Inserts:
    handle_path /api/smart-alerts/* {
        reverse_proxy 127.0.0.1:4310
    }

into the bot.agoraiq.net site block in /etc/caddy/Caddyfile, placed BEFORE
any existing `/api/*` handler so Caddy matches the more-specific route first.

Idempotent. Makes a timestamped backup. Exits non-zero on any structural
problem so `&&` chains stop.

Usage:
    sudo python3 patch-caddy-smart-alerts.py                  # write
    sudo python3 patch-caddy-smart-alerts.py --dry-run        # preview diff
"""
import argparse, datetime, pathlib, re, shutil, sys

CADDY  = pathlib.Path("/etc/caddy/Caddyfile")
SITE   = "bot.agoraiq.net"
MARKER = "/api/smart-alerts/*"   # used for idempotency check

def die(msg, code=1):
    print(f"ERROR: {msg}", file=sys.stderr); sys.exit(code)

def find_site_block(src: str, site: str) -> tuple[int, int]:
    """Return (start_of_body, end_of_body) for `site { ... }` with brace balancing."""
    m = re.search(rf"(^|\n)\s*{re.escape(site)}\b[^\{{]*\{{", src)
    if not m:
        die(f"site block {site!r} not found in {CADDY}")
    start = m.end()
    depth, i = 1, start
    while i < len(src) and depth:
        if   src[i] == "{": depth += 1
        elif src[i] == "}": depth -= 1
        i += 1
    if depth:
        die("unbalanced braces while scanning site block")
    return start, i - 1

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--file", default=str(CADDY))
    args = ap.parse_args()

    path = pathlib.Path(args.file)
    if not path.exists(): die(f"{path} does not exist")

    src = path.read_text()
    if MARKER in src:
        print("already patched; no changes"); return

    start, end = find_site_block(src, SITE)
    body = src[start:end]

    # Detect indent used inside the block (first indented line wins).
    m = re.search(r"\n([ \t]+)\S", body)
    indent = m.group(1) if m else "\t"

    snippet = (
        f"\n{indent}handle_path /api/smart-alerts/* {{\n"
        f"{indent}{indent}reverse_proxy 127.0.0.1:4310\n"
        f"{indent}}}\n"
    )

    # Prefer inserting just before the first line that handles /api/*
    anchor = re.search(r"^[ \t]*(handle|handle_path|route|reverse_proxy)[^\n]*\/api\/\*",
                       body, re.M)
    if anchor:
        pos = anchor.start()
        new_body = body[:pos] + snippet.lstrip("\n") + body[pos:]
    else:
        # No /api/* handler found — insert at top of block.
        new_body = snippet + body

    new_src = src[:start] + new_body + src[end:]

    if args.dry_run:
        import difflib
        sys.stdout.writelines(difflib.unified_diff(
            src.splitlines(keepends=True),
            new_src.splitlines(keepends=True),
            fromfile=str(path), tofile=str(path) + " (patched)"))
        return

    stamp  = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(path.name + f".bak-{stamp}")
    shutil.copy2(path, backup)
    path.write_text(new_src)
    print(f"patched {path}")
    print(f"backup  {backup}")
    print("next:   sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy")

if __name__ == "__main__":
    main()
