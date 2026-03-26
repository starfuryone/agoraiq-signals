"""
Rich signal card formatters for Telegram.

Every signal display goes through these functions.
Free users get teasers. Pro/elite get full cards.
Everything has a tap target back to the app.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from telegram import InlineKeyboardButton, InlineKeyboardMarkup

APP_URL = os.environ.get("APP_URL", "https://bot.agoraiq.net")
LANDING = os.environ.get("LANDING_URL", "https://bot.agoraiq.net")


# ── escape helpers ─────────────────────────────────────────────────
def _e(text: str) -> str:
    for ch in r"_*[]()~`>#+-=|{}.!":
        text = text.replace(ch, f"\\{ch}")
    return text


def _b(text: str) -> str:
    return f"*{_e(str(text))}*"


def _m(text: str) -> str:
    return f"`{_e(str(text))}`"


def _usd(val) -> str:
    if val is None:
        return "—"
    return f"${val:,.2f}" if isinstance(val, (int, float)) else str(val)


def _pct(val) -> str:
    if val is None:
        return "—"
    if isinstance(val, (int, float)):
        v = val * 100 if abs(val) <= 1.0 else val
        sign = "\\+" if v > 0 else ""
        return f"{sign}{v:.1f}%"
    return str(val)


def _duration(val) -> str:
    """Format duration — accepts seconds (int) or pre-formatted string."""
    if not val:
        return "—"
    if isinstance(val, str):
        return val
    sec = int(val)
    h = sec // 3600
    m = (sec % 3600) // 60
    if h > 24:
        return f"{h // 24}d {h % 24}h"
    return f"{h}h {m}m"


# ═══════════════════════════════════════════════════════════════════
#  SIGNAL CARD — the core display unit
# ═══════════════════════════════════════════════════════════════════

def signal_card_full(s: Dict[str, Any]) -> str:
    """Full signal card for pro/elite users. Reads canonical fields first, legacy fallback."""
    symbol = s.get("symbol", "?")
    direction = s.get("direction", s.get("action", s.get("side", "?")))
    entry = s.get("entry", s.get("price"))
    stop = s.get("stop", s.get("stopLoss", s.get("stop_loss")))
    targets = s.get("targets", s.get("takeProfits", []))
    conf = s.get("confidence", s.get("aiScore", s.get("breakoutScore")))
    leverage = s.get("leverage")
    provider = s.get("provider")
    sig_id = s.get("id", s.get("_id"))
    vol = s.get("meta", {}).get("volume_change", s.get("volume"))
    status = s.get("status", "OPEN")
    aligned = s.get("meta", {}).get("providers_aligned")

    emoji = "🟢" if direction in ("LONG", "BUY") else "🔴"
    s_emoji = {"OPEN": "⏳", "TP1": "✅", "TP2": "✅", "TP3": "✅", "SL": "❌", "EXPIRED": "⌛"}.get(status, "⚪")

    lines = [f"🚨 {_b(f'{symbol} {direction}')}"]
    lines.append("")
    if entry is not None:
        lines.append(f"💰 Entry: {_m(_usd(entry))}")
    if targets and isinstance(targets, list):
        for i, tp in enumerate(targets[:3], 1):
            lines.append(f"🎯 TP{i}: {_m(_usd(tp))}")
    if stop is not None:
        lines.append(f"🛑 SL: {_m(_usd(stop))}")
    if leverage:
        lines.append(f"⚡ Leverage: {_b(_e(str(leverage)))}")
    lines.append("")
    if conf is not None:
        c = int(conf) if isinstance(conf, (int, float)) and conf > 1 else int(conf * 100) if isinstance(conf, float) and conf <= 1 else conf
        lines.append(f"🧠 Confidence: {_b(f'{c}%')}")
    if vol is not None:
        lines.append(f"📦 Volume: {_b(_pct(vol))}")
    if aligned:
        lines.append(f"🔥 {_b(f'{aligned} providers aligned')}")
    if provider and provider not in ("user", "scanner", "manual"):
        lines.append(f"👤 Provider: {_e(str(provider))}")
    lines.append(f"{s_emoji} Status: {_b(_e(status))}")
    if sig_id:
        lines.append(f"🆔 \\#{_e(str(sig_id))}")

    return "\n".join(lines)


def signal_card_locked(s: Dict[str, Any]) -> str:
    """Teaser card for free users — shows just enough to create FOMO."""
    symbol = s.get("symbol", "?")
    direction = s.get("direction", s.get("action", s.get("side", "?")))
    entry = s.get("entry", s.get("price"))
    conf = s.get("confidence", s.get("aiScore", s.get("breakoutScore")))

    emoji = "🟢" if direction in ("LONG", "BUY") else "🔴"
    conf_display = f"{int(conf)}%" if isinstance(conf, (int, float)) and conf > 1 else (f"{int(conf * 100)}%" if isinstance(conf, float) and conf <= 1 else None) if conf else None

    lines = [f"🚨 {_b(f'{symbol} {direction}')}"]
    lines.append("")
    lines.append(f"💰 Price: {_m(_usd(entry))}")
    if conf_display:
        lines.append(f"🧠 AI Score: {_b(conf_display)}")
    lines.append("")
    lines.append("━━━━━━━━━━━━━━━━━━━━━━")
    lines.append(f"🔒 {_b('Full Signal Locked')}")
    lines.append("━━━━━━━━━━━━━━━━━━━━━━")
    lines.append("")
    lines.append("This trade has:")
    if conf_display:
        lines.append(f"  ✔ {conf_display} success probability")
    else:
        lines.append("  ✔ AI\\-scored entry")
    lines.append("  ✔ Verified provider edge")
    lines.append("  ✔ Entry, TP, SL targets")
    lines.append("")
    lines.append(f"Upgrade to {_b('PRO')} to unlock:")
    lines.append("→ Real\\-time breakout alerts")
    lines.append("→ Full signal details \\+ AI scoring")
    lines.append("→ Signal tracking \\+ PnL")
    lines.append("")
    lines.append(f"💎 Plans from $19/mo")

    return "\n".join(lines)


def locked_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🔓 Upgrade Now", url=f"{LANDING}/pricing")],
        [InlineKeyboardButton("📊 View Free Signals", url=f"{APP_URL}/signals.html")],
    ])


def signal_keyboard(sig_id=None) -> InlineKeyboardMarkup:
    buttons = []
    if sig_id:
        buttons.append([InlineKeyboardButton("📊 Full Analysis", url=f"{APP_URL}/signals.html?id={sig_id}")])
    buttons.append([InlineKeyboardButton("📈 Open Dashboard", url=f"{APP_URL}/dashboard.html")])
    return InlineKeyboardMarkup(buttons)


# ═══════════════════════════════════════════════════════════════════
#  SIGNAL OUTCOME CARD — when resolved
# ═══════════════════════════════════════════════════════════════════

def outcome_card(s: Dict[str, Any]) -> str:
    """Resolved signal card with PnL and duration."""
    symbol = s.get("symbol", "?")
    direction = s.get("direction", s.get("action", s.get("side", "?")))
    status = s.get("status", "—")
    entry = s.get("entry", s.get("price"))
    result = s.get("result", s.get("pnl"))
    conf = s.get("confidence")
    provider = s.get("provider")
    sig_id = s.get("id")
    duration_sec = s.get("duration_sec")

    is_win = status.startswith("TP") if status else False
    emoji = "✅" if is_win else "❌" if status == "SL" else "⌛"
    label = f"{status} HIT" if is_win else "STOPPED OUT" if status == "SL" else "EXPIRED"

    lines = [f"{emoji} {_b(f'{symbol} — {label}')}"]
    lines.append("")
    if sig_id:
        lines.append(f"🆔 Signal \\#{_e(str(sig_id))}")
    lines.append(f"📊 {_e(str(direction))} @ {_m(_usd(entry))}")
    lines.append("")
    if result is not None:
        lines.append(f"💰 Return: {_b(_pct(result))}")
    if duration_sec:
        lines.append(f"⏱ Duration: {_b(_e(_duration(duration_sec)))}")
    if conf is not None:
        c = int(conf) if isinstance(conf, (int, float)) and conf > 1 else int(conf * 100) if isinstance(conf, float) else conf
        lines.append(f"🧠 AI Score: {_b(f'{c}%')}")
    if provider and provider not in ("user", "scanner", "manual"):
        lines.append(f"👤 Provider: {_e(str(provider))}")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════
#  SIGNAL LIFECYCLE CARD — /signal_status and /my_signals detail
# ═══════════════════════════════════════════════════════════════════

def lifecycle_card(s: Dict[str, Any]) -> str:
    """Full lifecycle view for a tracked signal."""
    symbol = s.get("symbol", "?")
    direction = s.get("direction", s.get("action", s.get("side", "?")))
    status = s.get("status", "OPEN")
    entry = s.get("entry", s.get("price"))
    current = s.get("current_price", s.get("currentPrice"))
    stop = s.get("stop", s.get("stopLoss", s.get("stop_loss")))
    targets = s.get("targets", [])
    result = s.get("result", s.get("pnl"))
    unrealized = s.get("unrealized_pnl")
    conf = s.get("confidence")
    sig_id = s.get("id", "—")
    duration_sec = s.get("duration_sec")

    s_emoji = {"OPEN": "⏳", "TP1": "✅", "TP2": "✅", "TP3": "✅", "SL": "❌", "EXPIRED": "⌛"}.get(status, "⚪")
    d_emoji = "🟢" if direction in ("LONG", "BUY") else "🔴"

    lines = [f"📋 {_b(f'Signal \\#{_e(str(sig_id))}')}"]
    lines.append("")
    lines.append(f"{d_emoji} {_b(_e(symbol))} {_e(str(direction))}")
    lines.append(f"{s_emoji} Status: {_b(_e(status))}")
    lines.append("")
    if entry is not None:
        lines.append(f"💰 Entry: {_m(_usd(entry))}")
    if current is not None and status == "OPEN":
        lines.append(f"📈 Current: {_m(_usd(current))}")
    if stop is not None:
        lines.append(f"🛑 SL: {_m(_usd(stop))}")
    if targets and isinstance(targets, list):
        for i, tp in enumerate(targets[:3], 1):
            lines.append(f"🎯 TP{i}: {_m(_usd(tp))}")
    lines.append("")
    if result is not None:
        lines.append(f"💵 Return: {_b(_pct(result))}")
    elif unrealized is not None:
        lines.append(f"💵 Unrealized: {_b(_pct(unrealized))}")
    if duration_sec:
        lines.append(f"⏱ Duration: {_b(_e(_duration(duration_sec)))}")
    if conf is not None:
        c = int(conf) if isinstance(conf, (int, float)) and conf > 1 else int(conf * 100) if isinstance(conf, float) else conf
        lines.append(f"🧠 AI Score: {_b(f'{c}%')}")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════
#  BREAKOUT LIST — for /breakouts and /top
# ═══════════════════════════════════════════════════════════════════

def breakout_list_full(items: List[Dict], title: str, emoji: str) -> str:
    """Ranked breakout list for pro/elite."""
    lines = [f"{emoji} {_b(_e(title))}\n"]
    for i, b in enumerate(items[:8], 1):
        sym = b.get("symbol", "?")
        score = b.get("score", b.get("confidence", None))
        change = b.get("change", b.get("priceChangePercent", None))
        direction = b.get("direction", b.get("side", "—"))
        dir_emoji = "🟢" if direction == "LONG" else "🔴"

        score_str = f" · Score: {_e(str(score))}" if score else ""
        change_str = f" · {_pct(change)}" if change else ""

        lines.append(f"{i}\\. {dir_emoji} {_b(_e(sym))}{change_str}{score_str}")
    return "\n".join(lines)


def breakout_list_locked(items: List[Dict], title: str, emoji: str) -> str:
    """Teaser breakout list for free users — show top 3 then lock."""
    lines = [f"{emoji} {_b(_e(title))}\n"]

    for i, b in enumerate(items[:3], 1):
        sym = b.get("symbol", "?")
        change = b.get("change", b.get("priceChangePercent", None))
        direction = b.get("direction", b.get("side", "—"))
        dir_emoji = "🟢" if direction == "LONG" else "🔴"
        change_str = f" {_pct(change)}" if change else ""
        lines.append(f"{i}\\. {dir_emoji} {_b(_e(sym))}{change_str}")

    remaining = max(0, len(items) - 3)
    if remaining > 0:
        lines.append("")
        lines.append(f"🔒 {_b(f'\\+{remaining} more locked')}")
        lines.append("")
        lines.append(f"Upgrade to {_b('PRO')} for full rankings")
        lines.append("→ All breakout candidates")
        lines.append("→ Confidence scores")
        lines.append("→ Real\\-time alerts")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════
#  MY SIGNALS LIST — for /my_signals
# ═══════════════════════════════════════════════════════════════════

def my_signals_list(signals: List[Dict]) -> str:
    """User's tracked signals with lifecycle status."""
    lines = [f"📋 {_b('Your Tracked Signals')}\n"]

    for s in signals[:10]:
        sym = s.get("symbol", "?")
        direction = s.get("direction", s.get("action", s.get("side", "?")))
        status = s.get("status", "OPEN")
        # Normalize legacy statuses
        if status == "ACTIVE": status = "OPEN"
        if status == "HIT_TP": status = "TP1"
        if status == "HIT_SL": status = "SL"
        result = s.get("result", s.get("pnl"))
        sig_id = s.get("id", "")

        s_emoji = {"OPEN": "⏳", "TP1": "✅", "TP2": "✅", "TP3": "✅", "SL": "❌", "EXPIRED": "⌛"}.get(status, "⚪")
        r_str = f" {_pct(result)}" if result is not None else ""

        lines.append(
            f"{s_emoji} {_b(_e(sym))} {_e(direction)} → {_e(status)}{r_str}"
            + (f" \\(\\#{_e(str(sig_id))}\\)" if sig_id else "")
        )

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════
#  PROOF / STATS CARDS
# ═══════════════════════════════════════════════════════════════════

def proof_card(stats: Dict[str, Any]) -> str:
    total = stats.get("totalSignals", stats.get("total", "—"))
    wins = stats.get("wins", stats.get("hitTp", "—"))
    wr = stats.get("winRate", stats.get("win_rate", None))
    avg_rr = stats.get("avgRR", stats.get("avgRewardRisk", stats.get("avgPnl", None)))

    lines = [f"✅ {_b('Verified Performance')}\n"]
    lines.append(f"📊 Total Signals: {_m(str(total))}")
    lines.append(f"🏆 Wins: {_m(str(wins))}")
    lines.append(f"📈 Win Rate: {_b(_pct(wr))}")
    if avg_rr is not None:
        lines.append(f"⚖️ Avg Return: {_b(_pct(avg_rr))}")
    return "\n".join(lines)


def proof_keyboard() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("📊 Full Proof Page", url=f"{APP_URL}/proof.html")],
    ])


# ═══════════════════════════════════════════════════════════════════
#  HELPER: get plan for current user
# ═══════════════════════════════════════════════════════════════════

def get_plan(update, store_module) -> str:
    """Get user's plan tier, returns 'free' if not linked."""
    user = store_module.get_user(update.effective_user.id)
    if not user:
        return "free"
    return user.get("plan_tier", "free")


def is_premium(plan: str) -> bool:
    return plan in ("pro", "elite")
