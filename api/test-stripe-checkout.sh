#!/usr/bin/env bash
# test-stripe-checkout.sh — End-to-end Stripe checkout smoke test for AgoraIQ
#
# Runs through:
#   1. Preflight    (PM2, port 4300, env vars)
#   2. API health
#   3. Stripe API key validity (hits /v1/balance)
#   4. Create a checkout session via the app
#   5. Verify the session exists on Stripe and carries a success_url token
#   6. Webhook reachability (unsigned → expect 400)
#   7. Webhook signature verification (signed test event)
#   8. DB sanity (recent bot_users / stripe_customers)
#   9. Tail last 20 lines of API log
#
# Usage:
#   chmod +x test-stripe-checkout.sh
#   ./test-stripe-checkout.sh                 # use defaults
#   CHECKOUT_PATH=/api/v1/billing/create-checkout ./test-stripe-checkout.sh
#   TEST_PRICE_ID=price_xxx ./test-stripe-checkout.sh
#
# Env overrides: API_BASE, PUBLIC_BASE, WEBHOOK_PATH, CHECKOUT_PATH, HEALTH_PATH,
#                ENV_FILE, TEST_EMAIL, TEST_PRICE_ID, PGURI, PM2_API_NAME

set -euo pipefail

# ─── config ────────────────────────────────────────────────────────────────
API_BASE="${API_BASE:-http://127.0.0.1:4300}"
PUBLIC_BASE="${PUBLIC_BASE:-https://bot.agoraiq.net}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
WEBHOOK_PATH="${WEBHOOK_PATH:-/api/v1/billing/webhook}"
CHECKOUT_PATH="${CHECKOUT_PATH:-/api/v1/billing/public-checkout}"

ENV_FILE="${ENV_FILE:-/opt/agoraiq-signals/api/.env}"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  # shellcheck source=/dev/null
  source <(grep -E '^(STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET|STRIPE_PRICE_)' "$ENV_FILE" | sed 's/\r$//')
  set +a
fi

STRIPE_SECRET_KEY="${STRIPE_SECRET_KEY:-}"
STRIPE_WEBHOOK_SECRET="${STRIPE_WEBHOOK_SECRET:-}"
TEST_EMAIL="${TEST_EMAIL:-stripe-test+$(date +%s)@agoraiq.net}"
TEST_PRICE_ID="${TEST_PRICE_ID:-${STRIPE_PRICE_PRO:-}}"

PGURI="${PGURI:-postgresql://agoraiq_signals:desf19848@127.0.0.1:5432/agoraiq_signals}"
PM2_API_NAME="${PM2_API_NAME:-agoraiq-signals-api}"

# ─── helpers ───────────────────────────────────────────────────────────────
C_OK=$'\033[0;32m'; C_FAIL=$'\033[0;31m'; C_WARN=$'\033[0;33m'
C_DIM=$'\033[0;90m'; C_B=$'\033[1m'; C_R=$'\033[0m'
PASS=0; FAIL=0; WARN=0
pass(){ echo "${C_OK}✔${C_R} $1"; PASS=$((PASS+1)); }
fail(){ echo "${C_FAIL}✘${C_R} $1"; FAIL=$((FAIL+1)); }
warn(){ echo "${C_WARN}⚠${C_R} $1"; WARN=$((WARN+1)); }
step(){ echo; echo "${C_B}▸ $1${C_R}"; }
info(){ echo "  ${C_DIM}$1${C_R}"; }

need(){ command -v "$1" >/dev/null 2>&1 || { echo "missing dep: $1 (apt install $1)"; exit 2; }; }
need curl; need jq; need openssl

# ─── 1. preflight ──────────────────────────────────────────────────────────
step "1. Preflight"

if command -v pm2 >/dev/null 2>&1; then
  if pm2 jlist 2>/dev/null | jq -e ".[] | select(.name==\"$PM2_API_NAME\" and .pm2_env.status==\"online\")" >/dev/null; then
    pid=$(pm2 jlist | jq -r ".[] | select(.name==\"$PM2_API_NAME\") | .pid")
    pass "PM2 process '$PM2_API_NAME' online (pid $pid)"
  else
    fail "PM2 process '$PM2_API_NAME' not online — try: pm2 delete $PM2_API_NAME && pm2 start ecosystem.config.js"
  fi
else
  warn "pm2 not on PATH — skipping process check"
fi

if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ':4300$'; then
  pass "port 4300 listening"
else
  fail "port 4300 not listening"
fi

if [[ -z "$STRIPE_SECRET_KEY" ]]; then
  fail "STRIPE_SECRET_KEY not set (looked in $ENV_FILE)"
else
  kind="live"; [[ "$STRIPE_SECRET_KEY" == sk_test_* ]] && kind="test"
  pass "Stripe secret key loaded ($kind mode)"
fi

if [[ -z "$STRIPE_WEBHOOK_SECRET" ]]; then
  warn "STRIPE_WEBHOOK_SECRET not set — webhook signature test will be skipped"
else
  pass "Stripe webhook secret loaded"
fi

# ─── 2. API health ─────────────────────────────────────────────────────────
step "2. API health"
code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$API_BASE$HEALTH_PATH" || echo 000)
if [[ "$code" =~ ^2 ]]; then
  pass "GET $API_BASE$HEALTH_PATH → $code"
else
  fail "GET $API_BASE$HEALTH_PATH → $code"
fi

# ─── 3. Stripe key validity ────────────────────────────────────────────────
step "3. Stripe API key validity"
if [[ -n "$STRIPE_SECRET_KEY" ]]; then
  resp=$(curl -s -w "\n%{http_code}" --max-time 10 https://api.stripe.com/v1/balance -u "$STRIPE_SECRET_KEY:")
  body=$(echo "$resp" | sed '$d'); code=$(echo "$resp" | tail -n1)
  if [[ "$code" == "200" ]]; then
    pass "Stripe /v1/balance → 200 (key valid)"
  else
    msg=$(echo "$body" | jq -r '.error.message // .' 2>/dev/null | head -c 200)
    fail "Stripe rejected key → $code: $msg"
  fi
else
  warn "skipped (no key)"
fi

# ─── 4. Create a checkout session via the app ──────────────────────────────
step "4. Create checkout session via POST $CHECKOUT_PATH"

if [[ -n "${CHECKOUT_PAYLOAD:-}" ]]; then
  payload="${CHECKOUT_PAYLOAD//__EMAIL__/$TEST_EMAIL}"
else
  plan="${TEST_PLAN:-elite}"
  period="${TEST_PERIOD:-monthly}"
  payload=$(jq -n --arg plan "$plan" --arg period "$period" '
    {
      plan:   $plan,
      period: $period,
      consent: {
        version:   "1.0",
        accepted:  true,
        timestamp: (now|todate),
        documents: [
          "subscription-agreement",
          "terms",
          "privacy",
          "cookies",
          "no-financial-advice"
        ]
      }
    }')
fi
info "payload: $payload"

resp=$(curl -s -w "\n%{http_code}" --max-time 15 -X POST "$API_BASE$CHECKOUT_PATH" \
  -H "Content-Type: application/json" -d "$payload" || echo -e "\n000")
body=$(echo "$resp" | sed '$d'); code=$(echo "$resp" | tail -n1)

session_url=$(echo "$body" | jq -r '.url // .checkout_url // .session_url // empty' 2>/dev/null || true)
session_id=$(echo "$body"  | jq -r '.sessionId // .id // .session_id // empty' 2>/dev/null || true)

if [[ "$code" =~ ^2 && -n "$session_url" ]]; then
  pass "checkout session created → $code"
  info "session_id:   ${session_id:-<not returned>}"
  info "checkout URL: $session_url"
else
  fail "checkout creation failed → $code"
  info "response: $(echo "$body" | head -c 400)"
  info "hint: tail -n 80 ~/.pm2/logs/${PM2_API_NAME}-error.log"
fi

# ─── 5. Verify session server-side via Stripe ──────────────────────────────
step "5. Verify session via Stripe API"
if [[ -n "${session_id:-}" && -n "$STRIPE_SECRET_KEY" ]]; then
  s_resp=$(curl -s -w "\n%{http_code}" --max-time 10 \
           "https://api.stripe.com/v1/checkout/sessions/$session_id" -u "$STRIPE_SECRET_KEY:")
  s_body=$(echo "$s_resp" | sed '$d'); s_code=$(echo "$s_resp" | tail -n1)
  if [[ "$s_code" == "200" ]]; then
    status=$(     echo "$s_body" | jq -r '.status')
    email=$(      echo "$s_body" | jq -r '.customer_email // .customer_details.email // "—"')
    mode=$(       echo "$s_body" | jq -r '.mode')
    success_url=$(echo "$s_body" | jq -r '.success_url')
    pass "session found on Stripe: status=$status mode=$mode email=$email"
    info "success_url: $success_url"
    if [[ "$success_url" == *"iq_token="* || "$success_url" == *"token="* || "$success_url" == *"jwt="* ]]; then
      pass "success_url carries iq_token (cold-traffic hydration path wired)"
    else
      warn "success_url has no iq_token — cold buyers will hit 401 on /billing/status"
    fi
  else
    fail "Stripe did not recognise session_id '$session_id' → $s_code"
  fi
else
  warn "skipped (no session_id or no stripe key)"
fi

# ─── 6. Webhook reachability ───────────────────────────────────────────────
step "6. Webhook reachability (unsigned)"
code=$(curl -s -o /tmp/wh_unsigned.out -w "%{http_code}" --max-time 10 \
       -X POST "$PUBLIC_BASE$WEBHOOK_PATH" \
       -H "Content-Type: application/json" -d '{}' || echo 000)
if [[ "$code" == "400" || "$code" == "401" ]]; then
  pass "webhook rejected unsigned request ($code) — signature verification active"
elif [[ "$code" == "200" ]]; then
  warn "webhook returned 200 without Stripe-Signature — verification may be disabled!"
elif [[ "$code" == "000" ]]; then
  fail "webhook unreachable at $PUBLIC_BASE$WEBHOOK_PATH (connection failed)"
else
  warn "webhook returned $code — inspect /tmp/wh_unsigned.out"
fi

# ─── 7. Signed webhook event ───────────────────────────────────────────────
step "7. Signed webhook event"
if [[ -n "$STRIPE_WEBHOOK_SECRET" ]]; then
  ts=$(date +%s)
  event="{\"id\":\"evt_test_${ts}\",\"object\":\"event\",\"api_version\":\"2024-06-20\",\"type\":\"ping\",\"data\":{\"object\":{\"id\":\"test\"}}}"
  sig_payload="${ts}.${event}"
  sig=$(printf '%s' "$sig_payload" | openssl dgst -sha256 -hmac "$STRIPE_WEBHOOK_SECRET" | awk '{print $2}')
  header="t=${ts},v1=${sig}"

  code=$(curl -s -o /tmp/wh_signed.out -w "%{http_code}" --max-time 10 \
         -X POST "$PUBLIC_BASE$WEBHOOK_PATH" \
         -H "Content-Type: application/json" \
         -H "Stripe-Signature: $header" \
         -d "$event" || echo 000)

  if [[ "$code" =~ ^2 ]]; then
    pass "signed event accepted ($code)"
  elif [[ "$code" == "400" ]]; then
    if grep -qi "signature" /tmp/wh_signed.out 2>/dev/null; then
      fail "signed event rejected on signature → $(head -c 200 /tmp/wh_signed.out)"
    else
      pass "signature passed; app rejected unknown event body ($code) — acceptable"
    fi
  else
    fail "signed event → $code — $(head -c 200 /tmp/wh_signed.out)"
  fi
else
  warn "skipped (no STRIPE_WEBHOOK_SECRET)"
fi

# ─── 8. DB sanity ──────────────────────────────────────────────────────────
step "8. DB sanity"
if command -v psql >/dev/null 2>&1; then
  if psql "$PGURI" -tAc "SELECT 1" >/dev/null 2>&1; then
    pass "postgres reachable"
    recent=$(psql "$PGURI" -tAc \
      "SELECT COUNT(*) FROM bot_users WHERE created_at > NOW() - INTERVAL '10 minutes'" 2>/dev/null || echo "?")
    info "bot_users created in last 10 min: $recent"
    if psql "$PGURI" -tAc "SELECT to_regclass('public.stripe_customers')" 2>/dev/null | grep -q stripe_customers; then
      sc=$(psql "$PGURI" -tAc \
        "SELECT COUNT(*) FROM stripe_customers WHERE created_at > NOW() - INTERVAL '1 hour'" 2>/dev/null || echo "?")
      info "stripe_customers added in last hour: $sc"
    fi
    if psql "$PGURI" -tAc "SELECT to_regclass('public.billing_events')" 2>/dev/null | grep -q billing_events; then
      be=$(psql "$PGURI" -tAc \
        "SELECT COUNT(*) FROM billing_events WHERE created_at > NOW() - INTERVAL '1 hour'" 2>/dev/null || echo "?")
      info "billing_events in last hour: $be"
    fi
  else
    fail "psql cannot connect with \$PGURI"
  fi
else
  warn "psql not installed — skipping"
fi

# ─── 9. API log tail ───────────────────────────────────────────────────────
step "9. API log tail (last 20 lines, ${PM2_API_NAME}-out.log)"
LOG="$HOME/.pm2/logs/${PM2_API_NAME}-out.log"
if [[ -f "$LOG" ]]; then
  tail -n 20 "$LOG" | sed 's/^/  /'
else
  warn "log not found at $LOG"
fi

# ─── 10. Cold-traffic claim-session path ───────────────────────────────────
step "10. /claim-session regression check (cold-traffic hydration)"
CLAIM_PATH="${CLAIM_PATH:-/api/v1/billing/claim-session}"

# Pull iq_token out of the success_url we captured in Step 5
iq_token=""
if [[ -n "${success_url:-}" ]]; then
  iq_token=$(echo "$success_url" | sed -nE 's/.*[?&]iq_token=([^&]+).*/\1/p' | \
             python3 -c 'import sys,urllib.parse;print(urllib.parse.unquote(sys.stdin.read().strip()))' 2>/dev/null || true)
fi

if [[ -z "$iq_token" || -z "${session_id:-}" ]]; then
  warn "skipped (no iq_token or session_id from earlier steps)"
else
  # 10a. input validation
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    -X POST "$API_BASE$CLAIM_PATH" \
    -H "Content-Type: application/json" -d '{}')
  if [[ "$code" == "400" ]]; then
    pass "claim-session rejects empty body ($code)"
  else
    fail "claim-session empty-body → $code (expected 400)"
  fi

  # 10b. full happy-path-as-far-as-possible (Stripe session has no email until
  #      the buyer actually completes checkout in a browser — so the realistic
  #      ceiling for an automated run is the "no email" branch)
  payload=$(jq -n --arg t "$iq_token" --arg s "$session_id" \
    '{iq_token:$t, session_id:$s}')
  resp=$(curl -s -w "\n%{http_code}" --max-time 15 \
    -X POST "$API_BASE$CLAIM_PATH" \
    -H "Content-Type: application/json" -d "$payload")
  body=$(echo "$resp" | sed '$d'); code=$(echo "$resp" | tail -n1)

  real_token=$(echo "$body" | jq -r '.token // empty' 2>/dev/null || true)

  if [[ "$code" == "200" && -n "$real_token" ]]; then
    pass "claim-session minted a real session token (buyer completed checkout)"
    info "email: $(echo "$body" | jq -r '.email')  bot_user_id: $(echo "$body" | jq -r '.bot_user_id')"

    # 10c. real token works against requireAuth
    s_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
      -H "Authorization: Bearer $real_token" \
      "$API_BASE/api/v1/billing/status")
    if [[ "$s_code" =~ ^2 ]]; then
      pass "minted token passes requireAuth on /billing/status ($s_code)"
    else
      fail "minted token failed /billing/status → $s_code"
    fi
  elif [[ "$code" == "400" ]] && echo "$body" | grep -q "no email"; then
    pass "claim-session reached Stripe & validated JWT (ceiling for unpaid session)"
    info "to test end-to-end: open the checkout URL above, pay with 4242..., then rerun"
  else
    fail "claim-session → $code: $(echo "$body" | head -c 200)"
  fi
fi

# ─── summary ───────────────────────────────────────────────────────────────
echo
echo "${C_B}── summary ──${C_R}"
echo "  ${C_OK}passed${C_R}: $PASS"
echo "  ${C_FAIL}failed${C_R}: $FAIL"
echo "  ${C_WARN}warn  ${C_R}: $WARN"
echo
if [[ -n "${session_url:-}" ]]; then
  echo "${C_B}▶ open this in a browser to finish a live test-mode checkout:${C_R}"
  echo "  $session_url"
  echo "  (card: 4242 4242 4242 4242, any future date, any CVC, any ZIP)"
fi
echo
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
