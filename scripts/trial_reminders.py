#!/usr/bin/env python3
"""
trial_reminders.py — External cron for AgoraIQ trial lifecycle messages.

Fires three messages exactly once per trial:
  halfway  — ~12h after start (between T-14h and T-10h from expiry)
  final    — ~1h before expiry (T-1h to T-0)
  expired  — up to 2h after expiry (T+0 to T+2h)

Dedup via bot_subscriptions.meta->'trial_reminders_sent' JSONB array.
Safe to run every 5 min via cron.
"""

import os, sys, json, urllib.request, urllib.parse
from datetime import datetime, timezone
from pathlib import Path
import psycopg2
import psycopg2.extras


# Hardcoded DSN (ignore DATABASE_URL env — too many variants in this system).
# Override via TRIAL_REMINDERS_DSN if you ever need to.
DB_DSN = os.environ.get(
    "TRIAL_REMINDERS_DSN",
    "postgresql://agoraiq_signals:desf19848@127.0.0.1:5432/agoraiq_signals",
)
# Strip unsupported query params (psycopg2 doesn't accept ?schema=public etc)
if "?" in DB_DSN:
    DB_DSN = DB_DSN.split("?", 1)[0]
APP_URL = os.environ.get("APP_URL", "https://bot.agoraiq.net")


def _load_env_fallback():
    if os.environ.get("TELEGRAM_BOT_TOKEN"):
        return
    for path in (
        "/opt/agoraiq-signals/api/.env",
        "/opt/agoraiq-signals/bot/.env",
        "/opt/agoraiq-signals/.env",
    ):
        p = Path(path)
        if not p.exists():
            continue
        for line in p.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k == "TELEGRAM_BOT_TOKEN" and v:
                os.environ["TELEGRAM_BOT_TOKEN"] = v
                return


_load_env_fallback()
BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
if not BOT_TOKEN:
    print(f"[{datetime.now(timezone.utc).isoformat()}] ERROR: TELEGRAM_BOT_TOKEN not set")
    sys.exit(1)

TG_API = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"


# ── MarkdownV2 escape ────────────────────────────────────────────
_MDV2 = r"_*[]()~`>#+-=|{}.!\\"


def esc(text: str) -> str:
    out = []
    for ch in str(text):
        if ch in _MDV2:
            out.append("\\")
        out.append(ch)
    return "".join(out)


# ── Messages ─────────────────────────────────────────────────────
def msg_halfway() -> str:
    return (
        "⚡ *Halfway through your Elite trial*\n\n"
        "You've been getting signals the instant they fire — the same speed "
        "paying Elite members get them\\.\n\n"
        "When your trial ends in about 12 hours, two paths:\n"
        "• *Elite — $99/mo*: signals in real\\-time \\(what you're getting now\\)\n"
        "• *Pro — $29/mo*: same signals, delivered later\n\n"
        "That 10\\-minute gap is the difference between catching the move "
        "and reading about it\\.\n\n"
        f"[Stay Elite]({APP_URL}/pricing.html?plan=elite)  \\|  "
        f"[Go Pro]({APP_URL}/pricing.html?plan=pro)"
    )


def msg_final() -> str:
    return (
        "⏰ *Your Elite trial ends in 1 hour*\n\n"
        "After that, signals stop until you pick a plan\\.\n\n"
        "• *Elite — $99/mo*: real\\-time \\(what you've been experiencing\\)\n"
        "• *Pro — $29/mo*: delayed delivery on every signal\n\n"
        "You've felt the speed\\. Now decide what it's worth\\.\n\n"
        f"[Stay Elite]({APP_URL}/pricing.html?plan=elite)  \\|  "
        f"[Drop to Pro]({APP_URL}/pricing.html?plan=pro)"
    )


def msg_expired() -> str:
    return (
        "*Your Elite trial has ended*\n\n"
        "You just spent 24 hours getting signals the instant they fired\\. "
        "That's Elite territory\\.\n\n"
        f"To keep what you had: [Elite — $99/mo]({APP_URL}/pricing.html?plan=elite)\n"
        f"Same signals, delayed delivery: [Pro — $29/mo]({APP_URL}/pricing.html?plan=pro)\n\n"
        "The gap between real\\-time and delayed delivery matters more than most "
        "traders admit until they've felt both sides\\."
    )


# ── Telegram send ────────────────────────────────────────────────
def send_tg(chat_id: int, text: str) -> bool:
    data = urllib.parse.urlencode({
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "MarkdownV2",
        "disable_web_page_preview": "true",
    }).encode()
    try:
        with urllib.request.urlopen(TG_API, data=data, timeout=10) as r:
            resp = json.loads(r.read())
            if not resp.get("ok"):
                print(f"TG API not ok for {chat_id}: {resp}")
                return False
            return True
    except Exception as e:
        print(f"TG send failed for {chat_id}: {e}")
        return False


# ── Core runner ──────────────────────────────────────────────────
SQL_SELECT = """
SELECT bs.id AS sub_id,
       bs.bot_user_id,
       bs.expires_at,
       bta.telegram_id
  FROM bot_subscriptions bs
  JOIN bot_telegram_accounts bta
    ON bta.bot_user_id = bs.bot_user_id AND bta.unlinked_at IS NULL
 WHERE bs.plan_tier = 'trial'
   AND bs.status = 'active'
   AND bs.expires_at BETWEEN %(start)s AND %(end)s
   AND NOT COALESCE(bs.meta->'trial_reminders_sent', '[]'::jsonb) ? %(key)s
"""

SQL_MARK = """
UPDATE bot_subscriptions
   SET meta = jsonb_set(
         COALESCE(meta, '{}'::jsonb),
         '{trial_reminders_sent}',
         COALESCE(meta->'trial_reminders_sent', '[]'::jsonb) || to_jsonb(%s::text)
       )
 WHERE id = %s
"""


def run_reminder(conn, key: str, start_sql: str, end_sql: str, msg: str) -> int:
    with conn.cursor() as cur:
        cur.execute(f"SELECT NOW() + {start_sql}, NOW() + {end_sql}")
        w_start, w_end = cur.fetchone()

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(SQL_SELECT, {"start": w_start, "end": w_end, "key": key})
        rows = cur.fetchall()

    if not rows:
        return 0

    sent = 0
    for row in rows:
        if not send_tg(row["telegram_id"], msg):
            continue
        with conn.cursor() as cur:
            cur.execute(SQL_MARK, (key, row["sub_id"]))
        conn.commit()
        sent += 1
        print(f"  sent '{key}' to tg={row['telegram_id']} sub_id={row['sub_id']}")
    return sent


def main() -> None:
    ts = datetime.now(timezone.utc).isoformat()
    try:
        conn = psycopg2.connect(DB_DSN)
    except Exception as e:
        print(f"[{ts}] DB connect failed: {e}")
        sys.exit(1)

    try:
        total = 0
        # key       start window             end window              message
        total += run_reminder(conn, "halfway", "INTERVAL '10 hours'",    "INTERVAL '14 hours'",   msg_halfway())
        total += run_reminder(conn, "final",   "INTERVAL '0 minutes'",   "INTERVAL '1 hour'",     msg_final())
        total += run_reminder(conn, "expired", "-INTERVAL '2 hours'",    "INTERVAL '0 minutes'",  msg_expired())
        print(f"[{ts}] Total reminders sent: {total}")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
