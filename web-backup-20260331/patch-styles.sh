#!/usr/bin/env bash
# ============================================
# AgoraIQ Signals – Style Unification Script
# Run from: /opt/agoraiq-signals/web
# ============================================
set -euo pipefail

WEB_ROOT="/opt/agoraiq-signals/web"
cd "$WEB_ROOT"

echo "=== Step 1: Verify styles.css exists ==="
if [ ! -f "$WEB_ROOT/styles.css" ]; then
  echo "ERROR: styles.css not found in $WEB_ROOT"
  echo "Copy it first:  scp styles.css root@your-vps:$WEB_ROOT/"
  exit 1
fi
echo "✓ styles.css found"

echo ""
echo "=== Step 2: Inject font + stylesheet into all HTML files ==="
INJECT_BLOCK='<link rel="preconnect" href="https://fonts.googleapis.com">\
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700\&display=swap" rel="stylesheet">\
<link rel="stylesheet" href="/styles.css">'

INJECTED=0
SKIPPED=0

for f in *.html; do
  if grep -q 'styles.css' "$f"; then
    echo "  SKIP  $f (already linked)"
    ((SKIPPED++))
  else
    sed -i "/<\/head>/i\\
$INJECT_BLOCK" "$f"
    echo "  ✓     $f"
    ((INJECTED++))
  fi
done

echo ""
echo "Injected: $INJECTED files   Skipped: $SKIPPED files"

echo ""
echo "=== Step 3: Strip conflicting inline styles from priority pages ==="
# Priority pages that likely have hardcoded colors/fonts
PRIORITY_PAGES=(
  index.html
  signals.html
  pricing.html
  providers.html
  proof.html
  scanner.html
)

for page in "${PRIORITY_PAGES[@]}"; do
  if [ ! -f "$page" ]; then
    echo "  MISS  $page (not found, skipping)"
    continue
  fi

  # Backup before touching
  cp "$page" "${page}.bak"
  echo "  BAK   $page → ${page}.bak"

  # Remove inline background-color on body if set to white/light
  sed -i 's/body\s*{[^}]*background-color\s*:\s*\(#fff\|#ffffff\|white\|#fafafa\|#f5f5f5\)[^}]*/body{/gi' "$page"

  # Remove inline font-family on body
  sed -i 's/font-family\s*:\s*[^;]*Arial[^;]*;/\/\* stripped-font \*\//gi' "$page"
  sed -i 's/font-family\s*:\s*[^;]*Helvetica[^;]*;/\/\* stripped-font \*\//gi' "$page"
  sed -i 's/font-family\s*:\s*[^;]*sans-serif[^;]*;/\/\* stripped-font \*\//gi' "$page"

  # Remove inline color: #333 / #000 / black on body/p
  sed -i 's/color\s*:\s*\(#333\|#000\|#000000\|black\)\s*;/\/\* stripped-color \*\//gi' "$page"

  # Remove hardcoded white/light backgrounds on common containers
  sed -i 's/background-color\s*:\s*\(#fff\|#ffffff\|white\|#fafafa\|#f5f5f5\|#f8f9fa\)\s*;/\/\* stripped-bg \*\//gi' "$page"
  sed -i 's/background\s*:\s*\(#fff\|#ffffff\|white\|#fafafa\|#f5f5f5\|#f8f9fa\)\s*;/\/\* stripped-bg \*\//gi' "$page"

  echo "  ✓     $page (inline conflicts stripped)"
done

echo ""
echo "=== Step 4: Verification ==="
echo "--- styles.css linkage ---"
grep -l "styles.css" *.html | while read f; do echo "  ✓ $f"; done
echo ""
echo "--- File check ---"
ls -lh "$WEB_ROOT/styles.css"

echo ""
echo "=== Done ==="
echo "Hard refresh your browser: Ctrl+Shift+R"
echo ""
echo "Backups saved as *.bak — delete when satisfied:"
echo "  rm -f $WEB_ROOT/*.bak"
