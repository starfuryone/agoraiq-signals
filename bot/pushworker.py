"""
Push alert worker — proactive Telegram notifications.

Runs as a background task inside the bot process.
Polls AgoraIQ API every 60s for:
  - New signals
  - Breakout alerts
  - Signal outcome updates (HIT_TP / HIT_SL)

Sends push notifications to linked users based on their alert rules
and plan tier.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from telegram import Bot
from telegram.constants import ParseMode
from telegram.error import Forbidden, BadRequest

import api
import store

log = logging.getLogger("push-worker")

POLL_INTERVAL = int(os.environ.get("PUSH_POLL_SECONDS", "60"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))

# Track what we've already pushed to avoid duplicates
_pushed_signal_ids: Set[str] = set()
_pushed_outcome_ids: Set[str] = set()
_max_cache = 5000


def _esc(text: str) -> str:
    for ch in r"_*[]()~`>#+-=|{}.!":
        text = text.replace(ch, f"\\{ch}")
    return text


def _bold(text: str) -> str:
    return f"*{_esc(str(text))}*"


def _mono(text: str) -> str:
    return f"`{_esc(str(text))}`"


def _usd(val) -> str:
    if val is None:
        return "—"
    return f"${val:,.2f}" if isinstance(val, (int, float)) else str(val)


def _pct(val) -> str:
    if val is None:
        return "—"
    if isinstance(val, (int, float)):
        if val <= 1.0:
            val = val * 100
        return f"{val:.1f}%"
    return str(val)


def _get_all_linked_users() -> List[Dict[str, Any]]:
    """Get linked telegram users from the in-memory cache.

    The cache is populated by require_link / store.async_get_token
    as users interact with the bot. This means push notifications
    only reach users who have been active recently — which is correct
    for a bot-side fallback worker. The primary push delivery happens
    server-side via the BullMQ push worker in the API.
    """
    users = []
    for tg_id, entry in list(store._cache.items()):
        if entry.get("token"):
            users.append({
                "telegram_id": tg_id,
                "email": entry.get("email", ""),
                "plan_tier": entry.get("plan_tier"),
            })
    return users


async def _safe_send(bot: Bot, chat_id: int, text: str) -> bool:
    """Send message, handle blocked/deactivated users."""
    try:
        await bot.send_message(
            chat_id=chat_id,
            text=text,
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return True
    except Forbidden:
        # User blocked the bot — remove link
        log.info(f"User {chat_id} blocked bot, removing link")
        store.remove_link(chat_id)
        return False
    except BadRequest as e:
        log.warning(f"Bad request sending to {chat_id}: {e}")
        return False
    except Exception as e:
        log.error(f"Failed to send to {chat_id}: {e}")
        return False


# ═══════════════════════════════════════════════════════════════════
#  SIGNAL PUSH
# ═══════════════════════════════════════════════════════════════════

async def _check_new_signals(bot: Bot) -> int:
    """Poll for new signals, push to eligible users."""
    try:
        data = await api.signals_latest(limit=10)
        signals = data if isinstance(data, list) else data.get("signals", data.get("data", []))
    except Exception as e:
        log.debug(f"Signal poll failed: {e}")
        return 0

    new_signals = []
    for s in signals:
        sid = str(s.get("id", s.get("_id", s.get("message_id", ""))))
        if sid and sid not in _pushed_signal_ids:
            new_signals.append(s)
            _pushed_signal_ids.add(sid)

    if not new_signals:
        return 0

    # Trim cache
    if len(_pushed_signal_ids) > _max_cache:
        excess = len(_pushed_signal_ids) - _max_cache
        for _ in range(excess):
            _pushed_signal_ids.pop()

    users = _get_all_linked_users()
    sent = 0

    for sig in new_signals:
        symbol = sig.get("symbol", sig.get("pair", "?"))
        action = sig.get("action", sig.get("side", "?"))
        price = sig.get("price", sig.get("entry", "?"))
        confidence = sig.get("confidence", sig.get("aiScore", None))
        provider = sig.get("provider", sig.get("source", None))

        emoji = "🟢" if action in ("LONG", "BUY") else "🔴"

        # Build message for paid subscribers only
        base_msg = (
            f"{emoji} {_bold('New Signal')}\n\n"
            f"📊 {_bold(_esc(str(symbol)))} {_esc(str(action))}\n"
            f"💰 Entry: {_mono(_usd(price))}\n"
        )

        if confidence:
            base_msg += f"🧠 AI Score: {_mono(_pct(confidence))}\n"
        if provider:
            base_msg += f"👤 Provider: {_esc(str(provider))}\n"

        pro_msg = base_msg

        # Add targets/SL for paid users
        targets = sig.get("targets", sig.get("takeProfits", []))
        sl = sig.get("stopLoss", sig.get("stop_loss", None))
        if targets and isinstance(targets, list):
            for i, tp in enumerate(targets[:3], 1):
                pro_msg += f"🎯 TP{i}: {_mono(_usd(tp))}\n"
        if sl:
            pro_msg += f"🛑 SL: {_mono(_usd(sl))}\n"

        # Push to active subscribers (trial, pro, elite) — no free tier
        for user in users:
            tier = user["plan_tier"]
            if tier not in ("trial", "pro", "elite"):
                continue
            ok = await _safe_send(bot, user["telegram_id"], pro_msg)
            if ok:
                sent += 1
            # Small delay to avoid Telegram rate limits
            await asyncio.sleep(0.05)

    log.info(f"Pushed {len(new_signals)} new signals to {sent} deliveries")
    return sent


# ═══════════════════════════════════════════════════════════════════
#  OUTCOME PUSH
# ═══════════════════════════════════════════════════════════════════

async def _check_outcomes(bot: Bot) -> int:
    """Poll for resolved signals (HIT_TP / HIT_SL), push results."""
    try:
        data = await api.proof_recent(limit=10)
        items = data if isinstance(data, list) else data.get("signals", data.get("data", []))
    except Exception as e:
        log.debug(f"Outcome poll failed: {e}")
        return 0

    new_outcomes = []
    for s in items:
        sid = str(s.get("id", s.get("_id", "")))
        status = s.get("status", "")
        if sid and status in ("HIT_TP", "HIT_SL") and sid not in _pushed_outcome_ids:
            new_outcomes.append(s)
            _pushed_outcome_ids.add(sid)

    if not new_outcomes:
        return 0

    if len(_pushed_outcome_ids) > _max_cache:
        excess = len(_pushed_outcome_ids) - _max_cache
        for _ in range(excess):
            _pushed_outcome_ids.pop()

    users = _get_all_linked_users()
    sent = 0

    for sig in new_outcomes:
        symbol = sig.get("symbol", "?")
        status = sig.get("status", "?")
        action = sig.get("action", sig.get("side", "?"))
        pnl = sig.get("pnl", sig.get("pnlPercent", None))

        emoji = "✅" if status == "HIT_TP" else "❌"
        label = "Target Hit" if status == "HIT_TP" else "Stopped Out"

        msg = (
            f"{emoji} {_bold('Signal Resolved')}\n\n"
            f"📊 {_bold(_esc(str(symbol)))} {_esc(str(action))} → {_bold(_esc(label))}\n"
        )
        if pnl is not None:
            msg += f"💰 PnL: {_mono(_pct(pnl))}\n"

        for user in users:
            ok = await _safe_send(bot, user["telegram_id"], msg)
            if ok:
                sent += 1
            await asyncio.sleep(0.05)

    log.info(f"Pushed {len(new_outcomes)} outcomes to {sent} deliveries")
    return sent


# ═══════════════════════════════════════════════════════════════════
#  DAILY SUMMARY
# ═══════════════════════════════════════════════════════════════════

_last_daily = 0.0


async def _maybe_send_daily(bot: Bot) -> None:
    """Send daily summary at ~08:00 UTC."""
    global _last_daily
    import datetime
    now = datetime.datetime.now(datetime.timezone.utc)

    # Only send between 08:00-08:02 UTC, once per day
    if now.hour != 8 or now.minute > 1:
        return
    if time.time() - _last_daily < 82800:  # 23 hours
        return

    _last_daily = time.time()

    try:
        stats = await api.proof_stats()
    except Exception:
        return

    total = stats.get("totalSignals", stats.get("total", "—"))
    wr = stats.get("winRate", stats.get("win_rate", "—"))

    APP_URL = os.environ.get("APP_URL", "https://bot.agoraiq.net")

    msg = (
        f"☀️ {_bold('Daily AgoraIQ Brief')}\n\n"
        f"📊 Total tracked: {_mono(str(total))}\n"
        f"📈 Win rate: {_mono(_pct(wr))}\n\n"
        f"Use /signals for latest\\.\n"
        f"[Open dashboard]({APP_URL}/dashboard.html)"
    )

    users = _get_all_linked_users()
    for user in users:
        if user["plan_tier"] in ("trial", "pro", "elite"):
            await _safe_send(bot, user["telegram_id"], msg)
            await asyncio.sleep(0.05)

    log.info(f"Daily summary sent to {len([u for u in users if u['plan_tier'] in ('trial', 'pro', 'elite')])} active users")


# ═══════════════════════════════════════════════════════════════════
#  MAIN LOOP
# ═══════════════════════════════════════════════════════════════════

_running = False


async def start_push_worker(bot: Bot) -> None:
    """Start the background push worker. Call from bot post_init."""
    global _running
    if _running:
        return
    _running = True
    log.info(f"Push worker started (poll every {POLL_INTERVAL}s)")

    while _running:
        try:
            await _check_new_signals(bot)
            await _check_outcomes(bot)
            await _maybe_send_daily(bot)
        except Exception as e:
            log.error(f"Push worker error: {e}")

        await asyncio.sleep(POLL_INTERVAL)


def stop_push_worker() -> None:
    global _running
    _running = False
    log.info("Push worker stopped")
