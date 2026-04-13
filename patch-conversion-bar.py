#!/usr/bin/env python3
"""
Inject global conversion bar into signals.html and scanner.html.
Run from /opt/agoraiq-signals: python3 patch-conversion-bar.py
"""
import re, shutil, os
from datetime import datetime

BASE = "/opt/agoraiq-signals/web"

# The conversion bar CSS + HTML + JS snippet to inject
CONV_CSS = """
/* === Global Conversion Bar (injected) === */
.global-conv{display:none;padding:12px 18px;margin-bottom:20px;border-radius:8px;border:1px solid rgba(255,193,7,.25);background:linear-gradient(135deg,rgba(255,193,7,.06),rgba(255,193,7,.02));text-align:center;font-family:var(--sans,'Albert Sans',sans-serif);font-size:13px;color:var(--text,#e2e4ef)}
.global-conv strong{color:#FFC107}
.global-conv a{display:inline-block;margin-left:8px;padding:6px 18px;border-radius:5px;background:linear-gradient(135deg,#FCD535,#EFBF04);color:#000;font-weight:700;font-size:12px;text-decoration:none}
"""

CONV_HTML = """<!-- Global conversion bar -->
<div class="global-conv" id="globalConv"></div>
"""

CONV_JS = """
<!-- Global conversion bar loader -->
<script>
(function(){
  var t=localStorage.getItem('iq_token');
  if(!t)return;
  fetch('/api/v1/signals/dashboard',{headers:{'Authorization':'Bearer '+t,'Content-Type':'application/json'}})
    .then(function(r){return r.ok?r.json():null})
    .then(function(d){
      if(!d||!d.week)return;
      var tier=d.tier||'free';
      if(tier!=='free'&&tier!=='trial')return;
      var bar=document.getElementById('globalConv');
      if(!bar)return;
      var w=d.week;
      if(w.hiddenCount>0){
        bar.style.display='block';
        bar.innerHTML='\\ud83d\\udd12 <strong>'+w.hiddenCount+' signals hidden</strong> this week.'
          +(w.hiddenWins>0?' <strong>'+w.hiddenWins+' were winners.</strong>':'')
          +' <a href="/pricing.html">Unlock \\u2192</a>';
      }
    }).catch(function(){});
})();
</script>
"""

def patch_file(filepath):
    if not os.path.exists(filepath):
        print(f"  ✗ {filepath} not found, skipping")
        return

    with open(filepath, 'r') as f:
        content = f.read()

    # Skip if already patched
    if 'global-conv' in content:
        print(f"  · {filepath} already has conversion bar, skipping")
        return

    # Backup
    ts = datetime.now().strftime('%Y%m%d%H%M%S')
    shutil.copy2(filepath, f"{filepath}.bak-{ts}")
    print(f"  ✓ backed up {filepath}")

    # Inject CSS before </style>
    content = content.replace('</style>', CONV_CSS + '</style>', 1)

    # Inject HTML after <div class="container"> (first occurrence)
    content = content.replace(
        '<div class="container">',
        '<div class="container">\n' + CONV_HTML,
        1
    )

    # Inject JS before </body>
    content = content.replace('</body>', CONV_JS + '</body>', 1)

    with open(filepath, 'w') as f:
        f.write(content)

    print(f"  ✓ patched {filepath}")


if __name__ == '__main__':
    print("── Injecting global conversion bar ──")
    patch_file(os.path.join(BASE, "signals.html"))
    patch_file(os.path.join(BASE, "scanner.html"))
    print("Done.")
