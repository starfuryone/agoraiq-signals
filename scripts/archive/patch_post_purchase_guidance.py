#!/usr/bin/env python3
"""Add post-purchase activation guidance to success.html and help.html.

success.html: inline 3-step activation card + trial note, above the button row.
help.html:    'After You Subscribe' section at top of Getting Started + sidebar link.

Atomic. Idempotent. Creates .bak once.
"""
import os, shutil, sys

SUCCESS = "/opt/agoraiq-signals/web/success.html"
HELP    = "/opt/agoraiq-signals/web/help.html"


def atomic_write(path, src):
    tmp = path + ".tmp"
    with open(tmp, "w") as f: f.write(src)
    os.replace(tmp, path)


def backup_once(path, tag):
    bak = f"{path}.bak.{tag}"
    if not os.path.exists(bak):
        shutil.copy2(path, bak)
        print(f"✅ Backup: {bak}")


# ── success.html ─────────────────────────────────────────────────
def patch_success():
    with open(SUCCESS, "r") as f: src = f.read()
    if "activate-steps" in src:
        print("ℹ️  success.html already patched")
        return
    backup_once(SUCCESS, "post_purchase")

    # Inject CSS before closing </style>
    css_new = """
/* Activation steps */
.activate-steps{width:100%;max-width:520px;margin:0 auto 28px;display:flex;flex-direction:column;gap:12px;animation:fadeUp .6s ease .35s both}
.activate-title{font-family:var(--syne);font-weight:800;font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--cyan);margin-bottom:4px;text-align:left}
.step-card{display:flex;align-items:flex-start;gap:14px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:10px;text-align:left;transition:border-color .2s}
.step-card:hover{border-color:var(--cyan)}
.step-num{width:28px;height:28px;flex-shrink:0;border-radius:50%;background:var(--cyan-dim);border:1px solid var(--cyan);color:var(--cyan);font-family:var(--syne);font-weight:800;font-size:14px;display:flex;align-items:center;justify-content:center}
.step-body{flex:1}
.step-head{font-family:var(--sans);font-weight:600;font-size:14px;color:#fff;margin-bottom:2px}
.step-desc{font-family:var(--sans);font-size:13px;color:var(--text2);line-height:1.5}
.step-desc code{background:var(--surface2);padding:1px 6px;border-radius:4px;color:var(--cyan);font-family:var(--mono);font-size:12px}
.trial-note{width:100%;max-width:520px;margin:0 auto 24px;padding:12px 16px;background:var(--green-dim);border:1px solid rgba(34,197,94,.25);border-radius:8px;font-family:var(--sans);font-size:13px;color:var(--text);line-height:1.55;text-align:left;animation:fadeUp .6s ease .45s both}
.trial-note strong{color:var(--green);font-weight:700}
</style>"""
    src = src.replace("</style>", css_new, 1)

    # Inject activation block right before <div class="btn-row">
    activation_html = """
  <div class="activate-steps">
    <div class="activate-title">Activate in 60 seconds</div>

    <div class="step-card">
      <div class="step-num">1</div>
      <div class="step-body">
        <div class="step-head">Open Telegram &amp; find our bot</div>
        <div class="step-desc">Tap the <strong>Open Telegram</strong> button below. It takes you straight to <a href="https://t.me/SigPulseBot" style="color:var(--cyan)">@SigPulseBot</a>.</div>
      </div>
    </div>

    <div class="step-card">
      <div class="step-num">2</div>
      <div class="step-body">
        <div class="step-head">Link your account</div>
        <div class="step-desc">In the bot, send <code>/connect</code>. Tap the link it sends you and confirm &mdash; you're already signed in from checkout, so it's one click.</div>
      </div>
    </div>

    <div class="step-card">
      <div class="step-num">3</div>
      <div class="step-body">
        <div class="step-head">Send <code>/start</code> and you're live</div>
        <div class="step-desc">Signals, scanner, and alerts unlock instantly. Your first breakout alert usually lands within 10 minutes.</div>
      </div>
    </div>
  </div>

  <div class="trial-note">
    <strong>On the 24-hour trial?</strong> You're getting signals at Elite speed &mdash; the instant they fire, same as paying Elite members. After the trial, Pro receives the same signals on a 10-minute delay unless you upgrade to Elite. Feel the difference, then decide.
  </div>

  <div class="btn-row">"""

    src = src.replace('  <div class="btn-row">', activation_html, 1)

    atomic_write(SUCCESS, src)
    print("✅ success.html: activation steps + trial note added")


# ── help.html ────────────────────────────────────────────────────
def patch_help():
    with open(HELP, "r") as f: src = f.read()
    if 'id="after-subscribe"' in src:
        print("ℹ️  help.html already patched")
        return
    backup_once(HELP, "post_purchase")

    # 1. Add sidebar link at the top of Getting Started
    old_side = '''    <div class="sidebar-title">Getting Started</div>
    <a href="#new-here">New Here?</a>'''
    new_side = '''    <div class="sidebar-title">Getting Started</div>
    <a href="#after-subscribe">After You Subscribe</a>
    <a href="#new-here">New Here?</a>'''
    if old_side not in src:
        print("❌ sidebar anchor not found"); sys.exit(1)
    src = src.replace(old_side, new_side, 1)

    # 2. Insert new section right before <h2 id="new-here">
    old_h = '<h2 id="new-here">New Here?</h2>'
    new_h = '''<h2 id="after-subscribe">After You Subscribe</h2>
    <p>You just paid &mdash; nice. Here's exactly what to do in the next 60 seconds to start getting signals.</p>

    <div class="step"><div class="step-num">1</div><div class="step-body"><h4>Open @SigPulseBot on Telegram</h4><p>Tap <a href="https://t.me/SigPulseBot">@SigPulseBot</a> (works on <a href="https://play.google.com/store/apps/details?id=org.telegram.messenger" target="_blank">Android</a>, <a href="https://apps.apple.com/app/telegram-messenger/id686449807" target="_blank">iOS</a>, <a href="https://macos.telegram.org/" target="_blank">macOS</a>, <a href="https://desktop.telegram.org/" target="_blank">Desktop</a>, or <a href="https://web.telegram.org/" target="_blank">Web</a>). If you don't have Telegram yet, install it first &mdash; takes about 30 seconds.</p></div></div>

    <div class="step"><div class="step-num">2</div><div class="step-body"><h4>Send <span class="code">/connect</span> in the chat</h4><p>The bot will reply with a one-time link. Tap it. Because your browser is still signed in from checkout, you just click <strong>Confirm</strong> &mdash; no password needed.</p></div></div>

    <div class="step"><div class="step-num">3</div><div class="step-body"><h4>Send <span class="code">/start</span> to see your unlocked commands</h4><p>You'll get a welcome message listing every feature available on your plan. From there, try <span class="code">/signals</span> for the latest breakouts, <span class="code">/top</span> for the strongest setups right now, or <span class="code">/proof</span> for the verified track record.</p></div></div>

    <div class="step"><div class="step-num">4</div><div class="step-body"><h4>Wait for the first alert</h4><p>Signals push automatically &mdash; you don't need to do anything. Most accounts see their first breakout alert within 10 minutes. You can close the chat and come back when it buzzes.</p></div></div>

    <div class="callout success"><strong>On the 24-hour trial?</strong> You're receiving signals the <em>instant</em> they fire &mdash; the same speed as paying Elite members. That's your trial edge. After 24 hours, the Pro plan receives the same signals on a 10-minute delay. Elite keeps you on real-time speed. You'll feel the difference before you decide.</div>

    <div class="callout"><strong>Having trouble linking?</strong> If <span class="code">/connect</span> isn't working, make sure you're using the same email you used at checkout. Still stuck? Message <a href="mailto:support@agoraiq.net">support@agoraiq.net</a> with your Stripe receipt and we'll get you sorted.</div>

    <h2 id="new-here">New Here?</h2>'''

    if old_h not in src:
        print("❌ new-here heading anchor not found"); sys.exit(1)
    src = src.replace(old_h, new_h, 1)

    atomic_write(HELP, src)
    print("✅ help.html: After You Subscribe section + sidebar link added")


patch_success()
patch_help()
print("\nDone.")
