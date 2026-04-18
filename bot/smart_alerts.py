"""
Telegram `/alerts` command bridge for the Smart Alerts sidecar.

Isolation contract:
  - This module NEVER touches the Smart Alerts DB directly.
  - It only issues authenticated HTTP calls to the sidecar at
    SMART_ALERTS_API_BASE (default http://127.0.0.1:4310).
  - It minted a short-lived JWT that matches JWT_SECRET on the sidecar.

Wire-up in bot.py:

    from smart_alerts import register_handlers
    register_handlers(application)   # python-telegram-bot Application

Commands:
    /alerts               → show menu + usage
    /alerts list          → list user's alerts
    /alerts create <nl>   → create alert from plain English
    /alerts pause <id>
    /alerts resume <id>
    /alerts delete <id>
    /alerts help
"""

from __future__ import annotations

import os
import time
import json
import logging
from typing import Any, Dict, List, Optional

import httpx
import jwt as pyjwt
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes

log = logging.getLogger("smart_alerts")

SMART_ALERTS_API_BASE = os.environ.get(
    "SMART_ALERTS_API_BASE", "http://127.0.0.1:4310"
).rstrip("/")
JWT_SECRET = os.environ.get("JWT_SECRET", "")
JWT_TTL_SEC = int(os.environ.get("SMART_ALERTS_JWT_TTL", "300"))
HTTP_TIMEOUT = float(os.environ.get("SMART_ALERTS_HTTP_TIMEOUT", "6"))


def _mint_token(bot_user_id: int) -> str:
    """
    Mint a short-lived JWT the Smart Alerts sidecar will accept.
    Secret matches the sidecar's JWT_SECRET. The `sub` claim maps to
    bot_user_id — the sidecar does NOT look up the main DB; the plan
    gate is handled by the sidecar via its own HTTP lookup.
    """
    if not JWT_SECRET:
        raise RuntimeError("JWT_SECRET env var required for Smart Alerts bridge")
    now = int(time.time())
    payload = {
        "sub": int(bot_user_id),
        "iat": now,
        "exp": now + JWT_TTL_SEC,
        "aud": "smart-alerts",
    }
    return pyjwt.encode(payload, JWT_SECRET, algorithm="HS256")


async def _call(bot_user_id: int, method: str, path: str,
                json_body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    token = _mint_token(bot_user_id)
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    url = f"{SMART_ALERTS_API_BASE}{path}"
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as c:
        r = await c.request(method, url, headers=headers, json=json_body)
    try:
        body = r.json()
    except Exception:
        body = {"error": r.text[:200]}
    body["__status"] = r.status_code
    return body


# ── Formatters ────────────────────────────────────────────────────

def _fmt_alert(a: Dict[str, Any]) -> str:
    name = a.get("name", "Alert")
    status = a.get("status", "?")
    cnt = a.get("match_count", 0)
    cd = a.get("cooldown_seconds", 0)
    rule = json.dumps(a.get("rule_json", {}), separators=(",", ":"))
    if len(rule) > 140:
        rule = rule[:137] + "..."
    return (
        f"*#{a.get('id')}* — {name}\n"
        f"Status: `{status}`  ·  cooldown: `{cd}s`  ·  hits: `{cnt}`\n"
        f"`{rule}`"
    )


def _fmt_list(body: Dict[str, Any]) -> str:
    alerts: List[Dict[str, Any]] = body.get("alerts", []) or []
    usage = body.get("usage", {}) or {}
    limits = body.get("limits", {}) or {}
    header = (
        f"*Your alerts* — {usage.get('active', 0)}/{usage.get('max', '?')} used "
        f"· plan `{limits.get('tier', '?')}`"
    )
    if not alerts:
        return header + "\n_No alerts yet. Use_ `/alerts create <filter>`"
    return header + "\n\n" + "\n\n".join(_fmt_alert(a) for a in alerts[:10])


def _fmt_created(body: Dict[str, Any]) -> str:
    a = body.get("alert", {}) or {}
    p = body.get("parse", {}) or {}
    return (
        f"✅ Alert created (#{a.get('id')})\n"
        f"parser: `{p.get('source')}` · confidence `{p.get('confidence')}`\n\n"
        + _fmt_alert(a)
    )


def _fmt_error(body: Dict[str, Any]) -> str:
    status = body.get("__status")
    if status == 403 and body.get("error") == "subscription_required":
        return (
            "🔒 Smart Alerts requires a Pro or Elite subscription.\n"
            "Upgrade: https://bot.agoraiq.net/pricing"
        )
    if status == 409 and body.get("error") == "alert_limit_reached":
        return (
            f"You've reached your plan's alert limit "
            f"({body.get('current')}/{body.get('limit')}). Upgrade or delete one."
        )
    return f"⚠️ {body.get('error') or 'error'} (HTTP {status})"


# ── Handler ──────────────────────────────────────────────────────

HELP_TEXT = (
    "*Smart Alerts* (Pro & Elite)\n\n"
    "`/alerts`                 — show menu\n"
    "`/alerts list`            — list your alerts\n"
    "`/alerts create <filter>` — create from plain English\n"
    "`/alerts pause <id>`\n"
    "`/alerts resume <id>`\n"
    "`/alerts delete <id>`\n"
    "`/alerts help`\n\n"
    "_Example:_ `/alerts create long BTC on 4h with ai score above 80 and rr >= 2`"
)


def _map_user(update: Update) -> Optional[int]:
    """
    Return the bot_user_id for the sender. The main bot stores
    Telegram → bot_user_id mapping; we reuse whatever helper the
    existing bot.py exposes. Falls back to the Telegram id itself
    if no mapping is available — the sidecar will treat it as the
    auth subject and reject unpaid users via the plan lookup.
    """
    try:
        from store import resolve_bot_user_id  # type: ignore
        uid = resolve_bot_user_id(update.effective_user.id)
        if uid:
            return int(uid)
    except Exception:
        pass
    return int(update.effective_user.id) if update.effective_user else None


async def alerts_cmd(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    uid = _map_user(update)
    if not uid:
        await update.message.reply_text("Please /start and link your account first.")
        return

    args = ctx.args or []
    sub = (args[0] if args else "").lower()

    try:
        if sub in ("", "help"):
            await update.message.reply_markdown(HELP_TEXT)
            return

        if sub == "list":
            body = await _call(uid, "GET", "/api/v1/alerts")
            if body.get("__status") != 200:
                await update.message.reply_markdown(_fmt_error(body)); return
            await update.message.reply_markdown(_fmt_list(body))
            return

        if sub == "create":
            prompt = " ".join(args[1:]).strip()
            if not prompt:
                await update.message.reply_text(
                    "Usage: /alerts create long BTC 4h ai score above 80"
                )
                return
            body = await _call(uid, "POST", "/api/v1/alerts",
                               {"prompt": prompt, "delivery_target": str(update.effective_chat.id)})
            if body.get("__status") not in (200, 201):
                await update.message.reply_markdown(_fmt_error(body)); return
            await update.message.reply_markdown(_fmt_created(body))
            return

        if sub in ("pause", "resume", "delete"):
            if len(args) < 2 or not args[1].isdigit():
                await update.message.reply_text(f"Usage: /alerts {sub} <id>")
                return
            aid = int(args[1])
            method = "DELETE" if sub == "delete" else "POST"
            path = f"/api/v1/alerts/{aid}" if sub == "delete" else f"/api/v1/alerts/{aid}/{sub}"
            body = await _call(uid, method, path)
            if body.get("__status") not in (200, 204):
                await update.message.reply_markdown(_fmt_error(body)); return
            verb = {"pause": "paused", "resume": "resumed", "delete": "deleted"}[sub]
            await update.message.reply_text(f"Alert #{aid} {verb}.")
            return

        await update.message.reply_markdown(HELP_TEXT)

    except Exception as e:
        log.exception("alerts_cmd failed")
        await update.message.reply_text(f"⚠️ bridge error: {e}")


def register_handlers(application: Application) -> None:
    """Call this from bot.py once during startup."""
    application.add_handler(CommandHandler("alerts", alerts_cmd))
    log.info("smart_alerts: /alerts handler registered → %s", SMART_ALERTS_API_BASE)
