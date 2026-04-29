"""
AgoraIQ Breakout Bot — @agoraiq_breakout_bot
Telegram interface to AgoraIQ signal intelligence platform.

Security: Fernet-encrypted token storage, web-based auth (no passwords in chat),
          per-user rate limiting, non-root systemd service.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import defaultdict
from typing import Optional

from dotenv import load_dotenv
from telegram import BotCommand, Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    MessageHandler,
    filters,
)

import api
import store
import pushworker
import cards

load_dotenv()

logging.basicConfig(
    format="%(asctime)s [%(name)s] %(levelname)s — %(message)s",
    level=logging.INFO,
)
log = logging.getLogger("agoraiq-bot")

APP_URL = os.environ.get("APP_URL", "https://bot.agoraiq.net")
LANDING = os.environ.get("LANDING_URL", "https://bot.agoraiq.net")


# ═══════════════════════════════════════════════════════════════════
#  RATE LIMITER
# ═══════════════════════════════════════════════════════════════════

_last_call: dict[int, float] = defaultdict(float)
RATE_LIMIT_SECONDS = 3


def _rate_ok(user_id: int) -> bool:
    now = time.time()
    if now - _last_call[user_id] < RATE_LIMIT_SECONDS:
        return False
    _last_call[user_id] = now
    return True


def rate_limited(func):
    """Decorator: drop commands if user is spamming."""
    async def wrapper(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        if not _rate_ok(update.effective_user.id):
            return  # silently drop
        return await func(update, ctx)
    return wrapper


# ═══════════════════════════════════════════════════════════════════
#  FORMATTING HELPERS
# ═══════════════════════════════════════════════════════════════════

def esc(text: str) -> str:
    for ch in r"_*[]()~`>#+-=|{}.!":
        text = text.replace(ch, f"\\{ch}")
    return text


def esc_code(text: str) -> str:
    # Inside MarkdownV2 code entities, only '`' and '\' may/must be escaped.
    return str(text).replace("\\", "\\\\").replace("`", "\\`")


def mono(text: str) -> str:
    return f"`{esc_code(text)}`"


def bold(text: str) -> str:
    return f"*{esc(str(text))}*"


def link(label: str, url: str) -> str:
    return f"[{esc(label)}]({url})"


def pct(val, decimals: int = 1) -> str:
    if val is None:
        return "—"
    if isinstance(val, (int, float)):
        if val <= 1.0:
            val = val * 100
        return f"{val:.{decimals}f}%"
    return str(val)


def usd(val) -> str:
    if val is None:
        return "—"
    return f"${val:,.2f}" if isinstance(val, (int, float)) else str(val)


def safe_get(d: dict, *keys, default="—"):
    for k in keys:
        if isinstance(d, dict):
            d = d.get(k, default)
        else:
            return default
    return d if d is not None else default


def norm(s: dict) -> dict:
    """Normalize an API signal response to canonical field names.
    Handles both new (direction/entry/stop/result) and legacy (action/price/stopLoss/pnl)."""
    if not isinstance(s, dict):
        return s
    return {
        "id": s.get("id"),
        "symbol": s.get("symbol", s.get("pair", "?")),
        "type": s.get("type", "manual"),
        "direction": s.get("direction", s.get("action", s.get("side", "?"))),
        "entry": s.get("entry", s.get("price")),
        "stop": s.get("stop", s.get("stopLoss", s.get("stop_loss"))),
        "targets": s.get("targets", s.get("takeProfits", [])),
        "leverage": s.get("leverage"),
        "confidence": s.get("confidence", s.get("aiScore", s.get("score"))),
        "provider": s.get("provider", s.get("source")),
        "source": s.get("source", "manual"),
        "status": _norm_status(s.get("status", "OPEN")),
        "result": s.get("result", s.get("pnl")),
        "duration_sec": s.get("duration_sec"),
        "current_price": s.get("current_price", s.get("currentPrice")),
        "unrealized_pnl": s.get("unrealized_pnl"),
        "created_at": s.get("created_at"),
        "resolved_at": s.get("resolved_at"),
        "meta": s.get("meta", {}),
    }


def _norm_status(status: str) -> str:
    if not status:
        return "OPEN"
    up = str(status).upper()
    if up == "ACTIVE":
        return "OPEN"
    if up == "HIT_TP":
        return "TP1"
    if up == "HIT_SL":
        return "SL"
    return up


def status_emoji(status: str) -> str:
    if not status:
        return "⚪"
    s = status.upper()
    if s.startswith("TP"):
        return "✅"
    if s == "SL":
        return "❌"
    if s == "EXPIRED":
        return "⏱"
    if s == "OPEN":
        return "⏳"
    return "⚪"


def direction_emoji(direction: str) -> str:
    if direction in ("LONG", "BUY"):
        return "🟢"
    if direction in ("SHORT", "SELL"):
        return "🔴"
    return "⚪"


async def api_error(update: Update, action: str, exc: Exception) -> None:
    log.error(f"API error in {action}: {exc}")
    await update.message.reply_text(
        f"⚠️ Couldn't fetch {action} right now\\. Try again shortly\\.",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


def require_link(func):
    """Decorator: require linked account. Store fetches from API if cache is stale."""
    async def wrapper(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        tg_id = update.effective_user.id
        # store.async_get_token checks cache, falls back to API /auth/telegram-auth
        token = await store.async_get_token(tg_id)

        if not token:
            await update.message.reply_text(
                "🔗 You need to link your account first\\.\n"
                "Use /connect to get started\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return
        ctx.user_data["iq_token"] = token
        return await func(update, ctx)
    return wrapper


def require_plan(*allowed_plans):
    """Decorator: gate command behind plan tier."""
    def decorator(func):
        async def wrapper(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
            user = store.get_user(update.effective_user.id)
            if not user:
                await update.message.reply_text(
                    "🔗 Link your account first with /connect\\.",
                    parse_mode=ParseMode.MARKDOWN_V2,
                )
                return
            if user["plan_tier"] not in allowed_plans:
                tier_list = ", ".join(p.upper() for p in allowed_plans)
                await update.message.reply_text(
                    f"⚠️ This feature requires {bold(esc(tier_list))} plan\\.\n\n"
                    f"👉 {link('Upgrade now', LANDING + '/pricing')}",
                    parse_mode=ParseMode.MARKDOWN_V2,
                )
                return
            return await func(update, ctx)
        return wrapper
    return decorator


# ═══════════════════════════════════════════════════════════════════
#  CORE COMMANDS
# ═══════════════════════════════════════════════════════════════════

@rate_limited
async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    name = update.effective_user.first_name or "there"
    plan = cards.get_plan(update, store)

    if cards.is_premium(plan):
        tier = plan.upper()
        msg = (
            f"\U0001f44b <b>Welcome back, {name}!</b> You're on the <b>{tier}</b> plan.\n\n"
            "<b>\U0001f4ca Signals & Intelligence</b>\n"
            "\U0001f539 /signals - Latest breakout signals\n"
            "\U0001f539 /market - Market overview\n"
            "\U0001f539 /top - Top breakout candidates\n"
            "\U0001f539 /momentum - Strongest momentum\n"
            "\U0001f539 /volume - Unusual volume\n\n"
            "<b>\U0001f3af Track & Prove</b>\n"
            "\U0001f539 /track - Submit a signal to track\n"
            "\U0001f539 /my_signals - Your tracked signals\n"
            "\U0001f539 /proof - Verified performance\n\n"
            "<b>\U0001f514 Alerts</b>\n"
            "\U0001f539 /alerts - Your active alerts\n"
            "\U0001f539 /addalert BTCUSDT - Add alert\n\n"
            "Type /help for all commands."
        )
        await update.message.reply_text(msg, parse_mode="HTML")

    elif plan == "inactive":
        msg = (
            f"\U0001f44b Hey {name}! Your account is linked but your subscription is inactive.\n\n"
            f"\U0001f449 <a href=\"{LANDING}/pricing\">Subscribe now</a> "
            "to unlock all signals, AI scoring, and provider intelligence.\n\n"
            "<b>Plans start at $29/mo</b>\n"
            "\U0001f539 <b>Pro $29/mo</b> - Full signal feed, AI scoring, provider analytics\n"
            "\U0001f539 <b>Elite $99/mo</b> - Everything in Pro + API, Smart Alerts, data export\n\n"
            "Once subscribed, all commands unlock instantly.\n\n"
            f"\U0001f50d See what you're getting: <a href=\"{LANDING}/proof.html\">Live Proof Dashboard</a>"
        )
        await update.message.reply_text(msg, parse_mode="HTML")

    else:
        msg = (
            f"\U0001f44b Hey {name}! Welcome to <b>AgoraIQ Signals</b> - "
            "AI-scored crypto signal intelligence, right here in Telegram.\n\n"
            "<b>Get started in 3 steps:</b>\n"
            f"1. Pick your plan at <a href=\"{LANDING}/pricing\">bot.agoraiq.net/pricing</a>\n"
            "2. After checkout, come back here and tap /connect\n"
            "3. All commands unlock instantly\n\n"
            "<b>Plans</b>\n"
            "\U0001f539 <b>Pro $29/mo</b> - Full signal feed, AI scoring, provider analytics\n"
            "\U0001f539 <b>Elite $99/mo</b> - Everything in Pro + API, Smart Alerts, data export\n\n"
            f"\U0001f50d See verified results first: <a href=\"{LANDING}/proof.html\">Live Proof Dashboard</a>\n\n"
            "Already have an account? Tap /connect to link it."
        )
        await update.message.reply_text(msg, parse_mode="HTML")


@rate_limited
async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        f"{bold('SigPulseBot')} — Commands\n\n"
        f"{bold('📊 Breakout & Signals')}\n"
        "/signals — Latest breakout signals\n"
        "/breakouts — Active breakout setups\n"
        "/latest — Most recent alerts\n"
        "/watchlist — Monitored pairs\n"
        "/pair BTCUSDT — Breakout data for a pair\n"
        "/setup BTCUSDT — Entry, SL, TPs, confidence\n\n"
        f"{bold('🔔 Alerts')}\n"
        "/alerts — Your active alerts\n"
        "/addalert BTCUSDT — Add alert\n"
        "/removealert BTCUSDT — Remove alert\n"
        "/pausealerts — Pause all\n"
        "/resumealerts — Resume all\n"
        "/settings — Alert preferences\n\n"
        f"{bold('🧠 Intelligence')}\n"
        "/market — Market overview\n"
        "/top — Top breakout candidates\n"
        "/momentum — Strongest momentum\n"
        "/volume — Unusual volume\n"
        "/oi — Open interest movers\n"
        "/funding — Funding rate extremes\n\n"
        f"{bold('📝 Track')}\n"
        "/track — Submit a signal to track\n"
        "/my\\_signals — Your tracked signals\n"
        "/signal\\_status ID — Check signal status\n\n"
        f"{bold('✅ Proof & Trust')}\n"
        "/proof — Verified performance\n"
        "/history — Past signals\n"
        "/wins — Winning signals\n"
        "/stats — Performance stats\n\n"
        f"{bold('👤 Account')}\n"
        "/connect — Link Telegram to AgoraIQ\n"
        "/disconnect — Unlink account\n"
        "/status — Account & subscription\n"
        "/profile — Bot profile\n"
        "/plan — Current plan\n"
        "/upgrade — Upgrade access\n"
        "/billing — Manage subscription\n\n"
        f"{bold('👥 Providers')}\n"
        "/providers — Signal provider leaderboard\n"
        "/top\\_providers — Top rated providers\n"
        "/follow NAME — Follow a provider\n"
        "/unfollow NAME — Unfollow a provider\n\n"
        f"{bold('ℹ️ Support')}\n"
        "/support — Contact support\n"
        "/faq — Common questions\n"
        "/feedback — Send feedback\n"
        "/about — What is AgoraIQ\n",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


@rate_limited
async def cmd_register(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        f"📝 Create your account:\n\n"
        f"👉 {link('Register here', APP_URL + '/register')}\n\n"
        "After registering, use /connect to link this bot\\.",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


@rate_limited
async def cmd_login(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        f"🔐 Log in to AgoraIQ:\n\n"
        f"👉 {link('Open login', APP_URL + '/login')}",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


@rate_limited
async def cmd_pricing(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    token = store.get_token(update.effective_user.id)
    current_plan = "free"
    if token:
        try:
            status = await api.billing_status(token)
            current_plan = status.get("plan", "free")
        except Exception:
            pass

    text = (
        f"\U0001f48e {bold('SigPulseBot Plans')}\n\n"
        f"Current: {bold(esc(current_plan.upper()))}\n\n"
        f"\u26a1 {bold('Pro')} \u2014 $29/mo \\| $228/yr\n"
        f"Full signals, alerts, scanner, /format\n\n"
        f"\U0001f3c6 {bold('Elite')} \u2014 $99/mo \\| $790/yr\n"
        f"Everything \\+ priority alerts \\+ API\n\n"
        f"\u2728 Upgrades are prorated \u2014 pay only the difference"
    )
    buttons = []
    if current_plan in ("free", "trial"):
        buttons.append([
            cards.InlineKeyboardButton("\u26a1 Pro Monthly", callback_data="upgrade:pro:monthly"),
            cards.InlineKeyboardButton("\u26a1 Pro Yearly", callback_data="upgrade:pro:yearly"),
        ])
    if current_plan in ("free", "trial", "pro"):
        buttons.append([
            cards.InlineKeyboardButton("\U0001f3c6 Elite Monthly", callback_data="upgrade:elite:monthly"),
            cards.InlineKeyboardButton("\U0001f3c6 Elite Yearly", callback_data="upgrade:elite:yearly"),
        ])
    if current_plan not in ("free", "trial"):
        buttons.append([cards.InlineKeyboardButton("\U0001f4cb Manage Billing", callback_data="billing_portal")])
    buttons.append([cards.InlineKeyboardButton("\U0001f310 Full Details", url=f"{LANDING}/pricing")])

    await update.message.reply_text(
        text,
        parse_mode=ParseMode.MARKDOWN_V2,
        reply_markup=cards.InlineKeyboardMarkup(buttons),
    )


@rate_limited
@require_link
async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.auth_me(ctx.user_data["iq_token"])
        user = data.get("user", {})
        sub = data.get("subscription", {})
        plan = sub.get("planTier", "free")
        email = user.get("email", "—")
        await update.message.reply_text(
            f"📋 {bold('Account Status')}\n\n"
            f"📧 Email: {mono(email)}\n"
            f"💎 Plan: {bold(plan.upper())}\n"
            f"🔗 Telegram: linked ✅",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, "account status", e)


# ═══════════════════════════════════════════════════════════════════
#  BREAKOUT & SIGNAL COMMANDS
# ═══════════════════════════════════════════════════════════════════

@rate_limited
async def cmd_signals(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        plan = cards.get_plan(update, store)
        data = await api.signals_latest(limit=5)
        signals = data if isinstance(data, list) else data.get("signals", data.get("data", []))
        if not signals:
            await update.message.reply_text("📭 No recent signals right now\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return

        # Show first signal as rich card, rest as list
        first = signals[0]
        if cards.is_premium(plan):
            text = cards.signal_card_full(first)
            kb = cards.signal_keyboard(first.get("id"))
        else:
            text = cards.signal_card_locked(first)
            kb = cards.locked_keyboard()

        await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2, reply_markup=kb)

        # If more signals, show compact list
        if len(signals) > 1:
            lines = [f"📡 {bold('More Signals')}\n"]
            for s in signals[1:5]:
                n = norm(s)
                e = direction_emoji(n["direction"])
                if cards.is_premium(plan):
                    lines.append(f"{e} {bold(esc(n['symbol']))} {esc(n['direction'])} @ {esc(usd(n['entry']))}")
                else:
                    lines.append(f"{e} {bold(esc(n['symbol']))} {esc(n['direction'])} 🔒")
            lines.append(f"\n💡 Use /track to start tracking a signal")
            await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "signals", e)


@rate_limited
async def cmd_breakouts(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        plan = cards.get_plan(update, store)
        data = await api.scanner_breakouts()
        items = data if isinstance(data, list) else data.get("breakouts", data.get("data", []))
        if not items:
            await update.message.reply_text("📭 No active breakout setups\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return

        if cards.is_premium(plan):
            text = cards.breakout_list_full(items, "Active Breakouts", "🚀")
            kb = cards.signal_keyboard()
        else:
            text = cards.breakout_list_locked(items, "Active Breakouts", "🚀")
            kb = cards.locked_keyboard()

        await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2, reply_markup=kb)
    except Exception as e:
        await api_error(update, "breakouts", e)


@rate_limited
async def cmd_latest(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.proof_recent(limit=5)
        items = data if isinstance(data, list) else data.get("signals", data.get("data", []))
        if not items:
            await update.message.reply_text("📭 No recent alerts\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return

        # Show first as rich outcome card
        first = items[0]
        text = cards.outcome_card(first)
        await update.message.reply_text(
            text, parse_mode=ParseMode.MARKDOWN_V2,
            reply_markup=cards.proof_keyboard(),
        )

        # Rest as compact list
        if len(items) > 1:
            lines = [f"🕐 {bold('More Results')}\n"]
            for s in items[1:5]:
                n = norm(s)
                e = status_emoji(n["status"])
                r = f" {esc(pct(n['result']))}" if n["result"] is not None else ""
                lines.append(f"{e} {bold(esc(n['symbol']))} → {esc(n['status'])}{r}")
            await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "latest", e)


@rate_limited
async def cmd_watchlist(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.scanner_overview()
        pairs = data.get("watchlist", data.get("pairs", data.get("symbols", [])))
        if not pairs:
            await update.message.reply_text(
                f"👀 Your watchlist is managed in the app\\.\n"
                f"👉 {link('Open scanner', APP_URL + '/scanner.html')}",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return
        lines = [f"👀 {bold('Monitored Pairs')}\n"]
        for p in pairs[:15]:
            name = p if isinstance(p, str) else p.get("symbol", "?")
            lines.append(f"• {mono(name)}")
        await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "watchlist", e)


@rate_limited
async def cmd_pair(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not ctx.args:
        await update.message.reply_text("Usage: /pair BTCUSDT", parse_mode=ParseMode.MARKDOWN_V2)
        return
    symbol = ctx.args[0].upper()
    try:
        data = await api.scanner_pair(symbol)
        price = data.get("price", data.get("lastPrice", "—"))
        chg = data.get("change24h", data.get("priceChange", "—"))
        vol = data.get("volume24h", data.get("volume", "—"))
        score = data.get("breakoutScore", data.get("score", "—"))
        await update.message.reply_text(
            f"📊 {bold(esc(symbol))}\n\n"
            f"💰 Price: {mono(usd(price))}\n"
            f"📈 24h Change: {mono(pct(chg))}\n"
            f"📦 Volume: {mono(usd(vol))}\n"
            f"🎯 Breakout Score: {mono(str(score))}",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, f"pair {symbol}", e)


@rate_limited
@require_link
@require_plan("pro", "elite")
async def cmd_setup(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not ctx.args:
        await update.message.reply_text("Usage: /setup BTCUSDT", parse_mode=ParseMode.MARKDOWN_V2)
        return
    symbol = ctx.args[0].upper()
    try:
        data = await api.scanner_pair(symbol)
        entry = data.get("entry", data.get("price", "—"))
        sl = data.get("stopLoss", data.get("stop_loss", "—"))
        tps = data.get("targets", data.get("takeProfits", []))
        conf = data.get("confidence", data.get("breakoutScore", "—"))
        side = data.get("direction", data.get("side", "—"))

        tp_lines = ""
        if isinstance(tps, list):
            for i, tp in enumerate(tps, 1):
                tp_lines += f"  🎯 TP{i}: {mono(usd(tp))}\n"

        await update.message.reply_text(
            f"📐 {bold('Setup')} — {bold(esc(symbol))}\n\n"
            f"📍 Side: {bold(esc(str(side)))}\n"
            f"💰 Entry: {mono(usd(entry))}\n"
            f"🛑 Stop Loss: {mono(usd(sl))}\n"
            f"{tp_lines}"
            f"📊 Confidence: {mono(pct(conf))}\n\n"
            f"👉 {link('Full analysis', APP_URL + '/scanner.html')}",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, f"setup {symbol}", e)


# ═══════════════════════════════════════════════════════════════════
#  ALERT COMMANDS
# ═══════════════════════════════════════════════════════════════════

@rate_limited
@require_link
async def cmd_alerts(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.alerts_list(ctx.user_data["iq_token"])
        rules = data if isinstance(data, list) else data.get("rules", [])
        if not rules:
            await update.message.reply_text("🔕 No active alerts\\. Use /addalert SYMBOL to add one\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return
        lines = [f"🔔 {bold('Your Alerts')}\n"]
        for r in rules[:10]:
            name = r.get("name", "Unnamed")
            enabled = "✅" if r.get("enabled") else "⏸️"
            lines.append(f"{enabled} {esc(name)}")
        await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "alerts", e)


@rate_limited
@require_link
async def cmd_addalert(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not ctx.args:
        await update.message.reply_text("Usage: /addalert BTCUSDT", parse_mode=ParseMode.MARKDOWN_V2)
        return
    symbol = ctx.args[0].upper()
    try:
        await api.alert_create(ctx.user_data["iq_token"], symbol)
        await update.message.reply_text(
            f"✅ Alert created for {bold(esc(symbol))}\\!\n"
            "You'll get notified on breakout signals\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, f"add alert {symbol}", e)


@rate_limited
@require_link
async def cmd_removealert(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not ctx.args:
        await update.message.reply_text("Usage: /removealert BTCUSDT", parse_mode=ParseMode.MARKDOWN_V2)
        return
    symbol = ctx.args[0].upper()
    try:
        data = await api.alerts_list(ctx.user_data["iq_token"])
        rules = data if isinstance(data, list) else data.get("rules", [])
        target = None
        for r in rules:
            cond = r.get("conditions", {})
            if cond.get("symbol", "").upper() == symbol:
                target = r
                break
        if not target:
            await update.message.reply_text(f"⚠️ No alert found for {esc(symbol)}\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return
        rid = target.get("id") or target.get("_id")
        await api.alert_delete(ctx.user_data["iq_token"], rid)
        await update.message.reply_text(f"🗑️ Alert for {bold(esc(symbol))} removed\\.", parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, f"remove alert {symbol}", e)


@rate_limited
@require_link
async def cmd_pausealerts(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        await api.alerts_pause_all(ctx.user_data["iq_token"])
        await update.message.reply_text("⏸️ All alerts paused\\. Use /resumealerts to resume\\.", parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "pause alerts", e)


@rate_limited
@require_link
async def cmd_resumealerts(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        await api.alerts_resume_all(ctx.user_data["iq_token"])
        await update.message.reply_text("▶️ All alerts resumed\\!", parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "resume alerts", e)


@rate_limited
@require_link
async def cmd_settings(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        f"⚙️ {bold('Alert Settings')}\n\n"
        f"Manage your full alert preferences in the app:\n"
        f"👉 {link('Open alerts', APP_URL + '/alerts.html')}",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


# ═══════════════════════════════════════════════════════════════════
#  INTELLIGENCE COMMANDS
# ═══════════════════════════════════════════════════════════════════

@rate_limited
async def cmd_market(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.scanner_overview()
        btc = data.get("btcPrice", data.get("btc", {}).get("price", "—"))
        eth = data.get("ethPrice", data.get("eth", {}).get("price", "—"))
        total_mc = data.get("totalMarketCap", "—")
        fear = data.get("fearGreedIndex", data.get("sentiment", "—"))
        await update.message.reply_text(
            f"🌐 {bold('Market Overview')}\n\n"
            f"₿ BTC: {mono(usd(btc))}\n"
            f"Ξ ETH: {mono(usd(eth))}\n"
            f"💰 Total MCap: {mono(usd(total_mc))}\n"
            f"😱 Fear/Greed: {mono(str(fear))}\n\n"
            f"👉 {link('Full scanner', APP_URL + '/scanner.html')}",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, "market overview", e)


async def _render_list(update: Update, title: str, emoji: str, fetcher, key_field: str = "symbol") -> None:
    try:
        data = await fetcher()
        items = data if isinstance(data, list) else data.get("data", data.get("results", []))
        if not items:
            await update.message.reply_text(f"📭 No {title.lower()} data right now\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return
        lines = [f"{emoji} {bold(esc(title))}\n"]
        for item in items[:10]:
            sym = item.get(key_field, item.get("symbol", "?"))
            val = item.get("value", item.get("change", item.get("score", "—")))
            lines.append(f"• {bold(esc(str(sym)))} — {esc(str(val))}")
        await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, title.lower(), e)


@rate_limited
async def cmd_top(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        plan = cards.get_plan(update, store)
        data = await api.scanner_top()
        items = data if isinstance(data, list) else data.get("data", data.get("results", []))
        if not items:
            await update.message.reply_text("📭 No top candidates right now\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return

        if cards.is_premium(plan):
            text = cards.breakout_list_full(items, "Top Breakout Candidates", "🏆")
            kb = cards.signal_keyboard()
        else:
            text = cards.breakout_list_locked(items, "Top Breakout Candidates", "🏆")
            kb = cards.locked_keyboard()

        await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2, reply_markup=kb)
    except Exception as e:
        await api_error(update, "top", e)


@rate_limited
@require_link
@require_plan("pro", "elite")
async def cmd_momentum(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await _render_list(update, "Strongest Momentum", "⚡", api.scanner_momentum)


@rate_limited
@require_link
@require_plan("pro", "elite")
async def cmd_volume(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await _render_list(update, "Unusual Volume", "📦", api.scanner_volume)


@rate_limited
@require_link
@require_plan("pro", "elite")
async def cmd_oi(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await _render_list(update, "Open Interest Movers", "📈", api.scanner_oi)


@rate_limited
@require_link
@require_plan("pro", "elite")
async def cmd_funding(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await _render_list(update, "Funding Rate Extremes", "💸", api.scanner_funding)


# ═══════════════════════════════════════════════════════════════════
#  /track — USER-SUBMITTED SIGNALS
# ═══════════════════════════════════════════════════════════════════

TRACK_INPUT = range(1)


async def upgrade_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer("Processing...")
    parts = (query.data or "").split(":")
    if len(parts) != 3:
        await query.message.reply_text("Invalid upgrade request.")
        return
    _, plan, period = parts
    token = store.get_token(query.from_user.id)
    if not token:
        await query.message.reply_text("Log in first with /login")
        return
    try:
        result = await api.billing_checkout(token, plan, period)
        if result.get("upgraded"):
            await query.message.reply_text(
                f"\u2705 Upgraded to {plan.upper()}!\n\n"
                "Your subscription has been updated with prorated billing.\n"
                "New features are available immediately.",
            )
            return
        url = result.get("url")
        if url:
            await query.message.reply_text(
                f"\U0001f4b3 {plan.upper()} {period.capitalize()} Checkout\n\n"
                f"Complete your subscription:\n{url}\n\n"
                "Secure payment via Stripe.",
            )
        else:
            await query.message.reply_text("Couldn't create checkout. Try again.")
    except Exception as e:
        log.error(f"Upgrade callback failed: {e}")
        await query.message.reply_text("Upgrade failed. Try /upgrade manually.")


async def billing_portal_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    await query.answer("Opening billing portal...")
    token = store.get_token(query.from_user.id)
    if not token:
        await query.message.reply_text("Log in first with /login")
        return
    try:
        result = await api.billing_portal(token)
        url = result.get("url")
        if url:
            await query.message.reply_text(f"Manage your subscription:\n{url}")
        else:
            await query.message.reply_text("Couldn't open billing portal.")
    except Exception as e:
        log.error(f"Billing portal failed: {e}")
        await query.message.reply_text("Billing portal unavailable. Try again.")


async def track_from_format_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """One-tap track from /format result — auto-submits the stored signal."""
    query = update.callback_query
    await query.answer("Submitting signal...")
    raw = ctx.user_data.pop("last_formatted_signal", None)
    if not raw:
        await query.message.reply_text("⚠️ Signal expired. Use /format again, then tap Track.")
        return
    token = store.get_token(query.from_user.id)
    if not token:
        ctx.user_data["last_formatted_signal"] = raw  # restore it
        await query.message.reply_text("⚠️ You need to log in first. Use /login or /register.")
        return
    try:
        result = await api.signal_submit(token, raw)
        sig = result if isinstance(result, dict) else {}
        sym = sig.get("symbol", sig.get("pair", "\u2014"))
        side = sig.get("direction", sig.get("action", sig.get("side", "\u2014")))
        status = sig.get("status", sig.get("parse_status", "submitted"))
        await query.message.reply_text(
            f"\u2705 Signal submitted for tracking!\n\n"
            f"\U0001f4ca Pair: {sym}\n"
            f"\U0001f4cd Side: {side}\n"
            f"\U0001f4cb Status: {status}\n\n"
            "AgoraIQ will track this against market data.",
        )
    except Exception as e:
        log.error(f"Track from format failed: {e}")
        ctx.user_data["last_formatted_signal"] = raw  # restore on failure
        await query.message.reply_text("⚠️ Couldn\'t submit. Try /track manually.")

async def track_signal_callback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Handle Track Signal button — extract signal from message text and submit."""
    query = update.callback_query
    await query.answer("Submitting signal for tracking...")
    token = store.get_token(query.from_user.id)
    if not token:
        await query.message.reply_text(
            "\u26a0\ufe0f You need to log in first. Use /login or /register."
        )
        return
    try:
        raw = query.message.text or ""
        if not raw:
            await query.message.reply_text("\u26a0\ufe0f Could not read signal from message.")
            return
        result = await api.signal_submit(token, raw)
        sig = result if isinstance(result, dict) else {}
        sym = sig.get("symbol", sig.get("pair", "\u2014"))
        side = sig.get("direction", sig.get("action", sig.get("side", "\u2014")))
        status = sig.get("status", sig.get("parse_status", "submitted"))
        await query.message.reply_text(
            f"\u2705 Signal submitted for tracking!\n\n"
            f"\U0001f4ca Pair: {sym}\n"
            f"\U0001f4cd Side: {side}\n"
            f"\U0001f4cb Status: {status}\n\n"
            "AgoraIQ will track this against market data.",
        )
    except Exception as e:
        log.error(f"Track callback failed: {e}")
        await query.message.reply_text("\u26a0\ufe0f Couldn\'t submit signal. Try /track manually.")

@require_link
async def cmd_track(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    # Auto-submit if we have a recently formatted signal
    last_signal = ctx.user_data.pop("last_formatted_signal", None)
    if last_signal:
        token = ctx.user_data.get("iq_token") or store.get_token(update.effective_user.id)
        try:
            result = await api.signal_submit(token, last_signal)
            sig = result if isinstance(result, dict) else {}
            sym = sig.get("symbol", sig.get("pair", "\u2014"))
            side = sig.get("direction", sig.get("action", sig.get("side", "\u2014")))
            status = sig.get("status", sig.get("parse_status", "submitted"))
            await update.message.reply_text(
                f"\u2705 Signal submitted!\n\n"
                f"\U0001f4ca Pair: {sym}\n"
                f"\U0001f4cd Side: {side}\n"
                f"\U0001f4cb Status: {status}\n\n"
                "AgoraIQ will track this against market data.",
            )
            return ConversationHandler.END
        except Exception as e:
            log.error(f"Auto-track submit failed: {e}")
    await update.message.reply_text(
        f"📝 {bold('Submit a signal to track')}\n\n"
        "Paste your signal in this format:\n\n"
        f"{mono('BTCUSDT LONG')}\n"
        f"{mono('Entry: 65000')}\n"
        f"{mono('TP1: 67000')}\n"
        f"{mono('SL: 63000')}\n\n"
        "Or just paste any signal text and I'll parse it\\.",
        parse_mode=ParseMode.MARKDOWN_V2,
    )
    return TRACK_INPUT[0]


async def track_receive(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    raw_text = update.message.text.strip()
    token = ctx.user_data.get("iq_token") or store.get_token(update.effective_user.id)
    if not token:
        await update.message.reply_text(
            "🔗 Session expired\\. Use /connect to re\\-link, then /track again\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return ConversationHandler.END
    try:
        result = await api.signal_submit(token, raw_text)
        sig = result if isinstance(result, dict) else {}
        sym = sig.get("symbol", sig.get("pair", "—"))
        side = sig.get("direction", sig.get("action", sig.get("side", "—")))
        status = sig.get("status", sig.get("parse_status", "submitted"))
        await update.message.reply_text(
            f"✅ Signal submitted\\!\n\n"
            f"📊 Pair: {bold(esc(str(sym)))}\n"
            f"📍 Side: {esc(str(side))}\n"
            f"📋 Status: {esc(str(status))}\n\n"
            "AgoraIQ will track this against market data\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        log.error(f"Track submit failed: {e}")
        await update.message.reply_text(
            "⚠️ Couldn't submit signal\\. Check the format and try again\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    return ConversationHandler.END


# ═══════════════════════════════════════════════════════════════════
#  PROOF & TRUST COMMANDS
# ═══════════════════════════════════════════════════════════════════

@rate_limited
async def cmd_proof(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.proof_stats()
        text = cards.proof_card(data)
        await update.message.reply_text(
            text, parse_mode=ParseMode.MARKDOWN_V2,
            reply_markup=cards.proof_keyboard(),
        )
    except Exception as e:
        await api_error(update, "proof stats", e)


@rate_limited
async def cmd_history(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.signals_history(limit=10)
        items = data if isinstance(data, list) else data.get("signals", data.get("data", []))
        if not items:
            await update.message.reply_text("📭 No signal history yet\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return

        # First as rich outcome card
        text = cards.outcome_card(items[0])
        await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2)

        # Rest as compact list with PnL
        if len(items) > 1:
            lines = [f"📜 {bold('History')}\n"]
            for s in items[1:10]:
                n = norm(s)
                e = status_emoji(n["status"])
                r = f" {esc(pct(n['result']))}" if n["result"] is not None else ""
                lines.append(f"{e} {bold(esc(n['symbol']))} → {esc(n['status'])}{r}")
            await update.message.reply_text(
                "\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2,
                reply_markup=cards.proof_keyboard(),
            )
    except Exception as e:
        await api_error(update, "history", e)


@rate_limited
async def cmd_wins(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.signals_history(limit=50)
        items = data if isinstance(data, list) else data.get("signals", data.get("data", []))
        wins = [s for s in items if norm(s)["status"].startswith("TP")]
        if not wins:
            await update.message.reply_text("📭 No winning signals recorded yet\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return

        # First win as outcome card
        text = cards.outcome_card(wins[0])
        await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2)

        # Summary + list
        if len(wins) > 1:
            lines = [f"🏆 {bold(esc(str(len(wins))))} {bold('total wins')}\n"]
            for s in wins[1:10]:
                n = norm(s)
                r = f" {esc(pct(n['result']))}" if n["result"] is not None else ""
                lines.append(f"✅ {bold(esc(n['symbol']))}{r}")
            await update.message.reply_text(
                "\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2,
                reply_markup=cards.proof_keyboard(),
            )
    except Exception as e:
        await api_error(update, "wins", e)


@rate_limited
async def cmd_stats(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        stats = await api.proof_stats()
        monthly = await api.proof_monthly()
        months = monthly if isinstance(monthly, list) else monthly.get("months", monthly.get("data", []))
        lines = [f"📊 {bold('Performance Stats')}\n"]
        lines.append(f"Win Rate: {mono(pct(stats.get('winRate', stats.get('win_rate', '—'))))}")
        lines.append(f"Total: {mono(str(stats.get('totalSignals', stats.get('total', '—'))))}")
        if months:
            lines.append(f"\n{bold('Monthly Breakdown')}")
            for m in months[-3:]:
                label = m.get("month", m.get("label", "?"))
                wr = m.get("winRate", m.get("win_rate", "—"))
                cnt = m.get("total", m.get("count", "—"))
                lines.append(f"• {esc(str(label))}: {esc(pct(wr))} \\({esc(str(cnt))} signals\\)")
        await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "stats", e)


# ═══════════════════════════════════════════════════════════════════
#  PROVIDER COMMANDS
# ═══════════════════════════════════════════════════════════════════

@rate_limited
async def cmd_providers(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.providers_list(limit=10)
        items = data if isinstance(data, list) else data.get("providers", data.get("data", []))
        if not items:
            await update.message.reply_text("📭 No providers tracked yet\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return
        lines = [f"👥 {bold('Signal Providers')}\n"]
        for p in items[:10]:
            name = p.get("name", p.get("channel", "?"))
            wr = p.get("winRate", p.get("win_rate", None))
            total = p.get("totalSignals", p.get("total", "—"))
            trust = p.get("trustScore", p.get("score", "—"))
            wr_str = pct(wr) if wr else "—"
            lines.append(
                f"• {bold(esc(str(name)))} — "
                f"WR: {esc(wr_str)} · "
                f"Signals: {esc(str(total))} · "
                f"Trust: {esc(str(trust))}"
            )
        lines.append(f"\n👉 {link('Full leaderboard', APP_URL + '/providers.html')}")
        await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "providers", e)


@rate_limited
async def cmd_top_providers(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.providers_top()
        items = data if isinstance(data, list) else data.get("providers", data.get("data", []))
        if not items:
            await update.message.reply_text("📭 No top providers yet\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return
        lines = [f"🏆 {bold('Top Providers')}\n"]
        for i, p in enumerate(items[:5], 1):
            name = p.get("name", p.get("channel", "?"))
            wr = p.get("winRate", p.get("win_rate", None))
            wr_str = pct(wr) if wr else "—"
            lines.append(f"{i}\\. {bold(esc(str(name)))} — WR: {esc(wr_str)}")
        await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "top providers", e)


@rate_limited
@require_link
async def cmd_follow(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not ctx.args:
        await update.message.reply_text(
            "Usage: /follow provider\\_name\n\n"
            "Use /providers to see available providers\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return
    provider = " ".join(ctx.args)
    try:
        result = await api.provider_follow(ctx.user_data["iq_token"], provider)
        await update.message.reply_text(
            f"✅ Now following {bold(esc(provider))}\\.\n"
            "You'll get alerts when they post signals\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, f"follow {provider}", e)


@rate_limited
@require_link
async def cmd_unfollow(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not ctx.args:
        await update.message.reply_text("Usage: /unfollow provider\\_name", parse_mode=ParseMode.MARKDOWN_V2)
        return
    provider = " ".join(ctx.args)
    try:
        await api.provider_unfollow(ctx.user_data["iq_token"], provider)
        await update.message.reply_text(f"🔕 Unfollowed {bold(esc(provider))}\\.", parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, f"unfollow {provider}", e)


# ═══════════════════════════════════════════════════════════════════
#  USER SIGNAL COMMANDS
# ═══════════════════════════════════════════════════════════════════

@rate_limited
@require_link
async def cmd_my_signals(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.user_signals(ctx.user_data["iq_token"], limit=10)
        items = data if isinstance(data, list) else data.get("signals", data.get("data", []))
        if not items:
            await update.message.reply_text(
                "📭 No tracked signals yet\\. Use /track to submit one\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return

        # First active signal as full lifecycle card
        active = [s for s in items if norm(s)["status"] == "OPEN"]
        if active:
            text = cards.lifecycle_card(active[0])
            sig_id = active[0].get("id")
            await update.message.reply_text(
                text, parse_mode=ParseMode.MARKDOWN_V2,
                reply_markup=cards.signal_keyboard(sig_id),
            )

        # Full list with IDs and PnL
        text = cards.my_signals_list(items)
        await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN_V2)
    except Exception as e:
        await api_error(update, "my signals", e)


@rate_limited
@require_link
async def cmd_signal_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    if not ctx.args:
        await update.message.reply_text(
            "Usage: /signal\\_status SIGNAL\\_ID\n\n"
            "Get signal IDs from /my\\_signals\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return
    signal_id = ctx.args[0]
    try:
        data = await api.signal_detail(ctx.user_data["iq_token"], signal_id)
        text = cards.lifecycle_card(data)
        await update.message.reply_text(
            text, parse_mode=ParseMode.MARKDOWN_V2,
            reply_markup=cards.signal_keyboard(signal_id),
        )
    except Exception as e:
        await api_error(update, f"signal {signal_id}", e)


# ═══════════════════════════════════════════════════════════════════
#  ACCOUNT / LINK COMMANDS — WEB AUTH FLOW
# ═══════════════════════════════════════════════════════════════════

@rate_limited
async def cmd_connect(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    tg_id = update.effective_user.id
    tg_user = update.effective_user.username

    existing = store.get_user(tg_id)
    if existing:
        await update.message.reply_text(
            f"\u2705 Already linked as {mono(existing['email'])}\\.\n"
            "Use /disconnect first to re\\-link\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return

    try:
        result = await api.telegram_link_start(tg_id, tg_user)
        link_url = result.get("link", f"{APP_URL}/link.html")

        await update.message.reply_text(
            f"\U0001f517 {bold('Link your account')}\n\n"
            f"1\ufe0f\u20e3 Open this link:\n"
            f"   \U0001f449 {link('Connect Account', link_url)}\n\n"
            f"2\ufe0f\u20e3 Log in \\(or create an account\\)\n"
            f"3\ufe0f\u20e3 Click Confirm to link your Telegram\n\n"
            f"\u23f1 Link expires in 5 minutes\\.\n\n"
            f"After linking, use /status to verify\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        code = getattr(getattr(e, "response", None), "status_code", 0)
        if code == 409:
            await update.message.reply_text(
                "\u26a0\ufe0f This Telegram account is already linked\\. Use /disconnect first\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
        else:
            await api_error(update, "connect", e)


@rate_limited
async def cmd_disconnect(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    tg_id = update.effective_user.id
    token = store.get_token(tg_id)
    removed = store.remove_link(tg_id)

    # Always attempt server-side unlink. The local store and the server's
    # bot_telegram_accounts table can drift (token expiry, store reset, etc.),
    # so /disconnect must clean both sides \u2014 otherwise /connect later 409s
    # forever.
    server_unlinked = False
    server_status = None

    if token:
        try:
            await api.telegram_unlink(token)
            server_unlinked = True
        except Exception as e:
            server_status = getattr(getattr(e, "response", None), "status_code", 0)

    # Token-authed unlink failed (or no token): fall through to the
    # force-unlink escape hatch authenticated by INTERNAL_API_SECRET.
    if not server_unlinked:
        try:
            await api.telegram_force_unlink(tg_id)
            server_unlinked = True
        except Exception as e:
            code = getattr(getattr(e, "response", None), "status_code", 0)
            if code == 404:
                # Server says nothing was linked. Confirms there's nothing to do.
                server_status = 404
            else:
                server_status = code or "error"

    if removed or server_unlinked:
        await update.message.reply_text(
            "\U0001f513 Account unlinked\\. Use /connect to re\\-link\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    else:
        await update.message.reply_text(
            "\u2139\ufe0f No linked account found\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )


@rate_limited
@require_link
async def cmd_profile(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    user = store.get_user(update.effective_user.id)
    if not user:
        await update.message.reply_text("ℹ️ No linked account\\. Use /connect\\.", parse_mode=ParseMode.MARKDOWN_V2)
        return
    await update.message.reply_text(
        f"👤 {bold('Bot Profile')}\n\n"
        f"📧 Email: {mono(user['email'])}\n"
        f"💎 Plan: {bold(esc(user['plan_tier'].upper()))}\n"
        f"🔗 Linked: {mono(user['linked_at'])}",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


@rate_limited
@require_link
async def cmd_plan(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        data = await api.auth_me(ctx.user_data["iq_token"])
        plan = safe_get(data, "subscription", "planTier", default="free")
        await update.message.reply_text(
            f"💎 Your plan: {bold(esc(plan.upper()))}\n\n"
            f"👉 {link('Manage subscription', APP_URL + '/pricing.html')}",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, "plan", e)


@rate_limited
async def cmd_upgrade(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    args = ctx.args or []
    plan = ""
    period = "monthly"
    for a in args:
        a_low = a.lower().strip()
        if a_low in ("pro", "elite"):
            plan = a_low
        elif a_low in ("yearly", "annual", "year"):
            period = "yearly"
        elif a_low in ("monthly", "month"):
            period = "monthly"

    if not plan:
        token = store.get_token(update.effective_user.id)
        current_plan = "free"
        if token:
            try:
                status = await api.billing_status(token)
                current_plan = status.get("plan", "free")
            except Exception:
                pass

        lines_msg = [
            f"\U0001f680 {bold('Upgrade your plan')}\n",
            f"Current plan: {bold(esc(current_plan.upper()))}\n",
        ]
        if current_plan in ("free", "trial"):
            lines_msg.append(f"\u26a1 {bold('Pro')} \u2014 $29/mo or $228/yr")
            lines_msg.append("Full signals, alerts, scanner, /format\n")
            lines_msg.append(f"\U0001f3c6 {bold('Elite')} \u2014 $99/mo or $790/yr")
            lines_msg.append("Everything \\+ priority alerts \\+ API\n")
        elif current_plan == "pro":
            lines_msg.append(f"\U0001f3c6 {bold('Elite')} \u2014 $99/mo or $790/yr")
            lines_msg.append("Everything \\+ priority alerts \\+ API")
            lines_msg.append("\n\u2728 Prorated upgrade \u2014 pay only the difference\n")

        buttons = []
        if current_plan in ("free", "trial"):
            buttons.append([
                cards.InlineKeyboardButton("\u26a1 Pro Monthly", callback_data="upgrade:pro:monthly"),
                cards.InlineKeyboardButton("\u26a1 Pro Yearly", callback_data="upgrade:pro:yearly"),
            ])
        if current_plan in ("free", "trial", "pro"):
            buttons.append([
                cards.InlineKeyboardButton("\U0001f3c6 Elite Monthly", callback_data="upgrade:elite:monthly"),
                cards.InlineKeyboardButton("\U0001f3c6 Elite Yearly", callback_data="upgrade:elite:yearly"),
            ])
        if token:
            buttons.append([cards.InlineKeyboardButton("\U0001f4cb Manage Billing", callback_data="billing_portal")])

        await update.message.reply_text(
            "\n".join(lines_msg),
            parse_mode=ParseMode.MARKDOWN_V2,
            reply_markup=cards.InlineKeyboardMarkup(buttons) if buttons else None,
        )
        return

    token = store.get_token(update.effective_user.id)
    if not token:
        await update.message.reply_text("\u26a0\ufe0f Log in first with /login")
        return
    try:
        result = await api.billing_checkout(token, plan, period)
        if result.get("upgraded"):
            await update.message.reply_text(
                f"\u2705 {bold('Upgraded to ' + esc(plan.upper()) + '!')}\n\n"
                f"Your subscription has been updated with prorated billing\\.\n"
                f"New features are available immediately\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return
        url = result.get("url")
        if not url:
            await update.message.reply_text("\u26a0\ufe0f Couldn\'t create checkout\\. Try again\\.", parse_mode=ParseMode.MARKDOWN_V2)
            return
        await update.message.reply_text(
            f"\U0001f4b3 {bold(esc(plan.upper()) + ' ' + esc(period.capitalize()) + ' Checkout')}\n\n"
            f"Click below to complete your subscription:\n\n"
            f"\U0001f449 {link('Open Checkout', url)}\n\n"
            f"Secure payment via Stripe\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, "upgrade", e)
# ═══════════════════════════════════════════════════════════════════
#  SUPPORT COMMANDS
# ═══════════════════════════════════════════════════════════════════

@rate_limited
async def cmd_about(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        f"🧠 {bold('AgoraIQ')} — AI\\-Verified Signal Intelligence\n\n"
        "AgoraIQ tracks and verifies crypto trading signals from "
        "Telegram and Discord providers\\. We score providers by "
        "real performance, not promises\\.\n\n"
        "🔹 Smart Alert Engine\n"
        "🔹 Market Scanner & Screener\n"
        "🔹 Provider IQ Leaderboard\n"
        "🔹 Trading Journal\n"
        "🔹 AI Market Brief\n\n"
        f"👉 {link('Learn more', LANDING)}",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


@rate_limited
async def cmd_support(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        f"🆘 {bold('Support')}\n\n"
        f"📧 Email: {mono('support@agoraiq.net')}\n"
        f"💬 Or use /feedback to send a message directly\\.",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


@rate_limited
async def cmd_faq(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        f"❓ {bold('FAQ')}\n\n"
        f"{bold('What is AgoraIQ?')}\n"
        "A crypto signal intelligence platform that tracks, verifies, "
        "and scores trading signal providers\\.\n\n"
        f"{bold('Is it free?')}\n"
        "The Free tier gives you market overview and limited signals\\. "
        "Pro and Elite unlock full access\\.\n\n"
        f"{bold('How do I link my account?')}\n"
        "Use /connect — you'll get a one\\-time code to enter on the web\\.\n\n"
        f"{bold('How are signals verified?')}\n"
        "We track entry, TP, and SL against real market data\\. "
        "Results are published on the /proof page\\.\n\n"
        f"👉 {link('Full FAQ', LANDING + '/faq')}",
        parse_mode=ParseMode.MARKDOWN_V2,
    )


FEEDBACK_TEXT = range(1)


@rate_limited
async def cmd_feedback(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    await update.message.reply_text(
        "💬 Send me your feedback and I'll forward it to the team:",
        parse_mode=ParseMode.MARKDOWN_V2,
    )
    return FEEDBACK_TEXT[0]


async def feedback_receive(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    text = update.message.text
    user = update.effective_user
    log.info(f"FEEDBACK from {user.id} (@{user.username}): {text}")
    await update.message.reply_text(
        "✅ Thanks\\! Your feedback has been received\\.",
        parse_mode=ParseMode.MARKDOWN_V2,
    )
    return ConversationHandler.END


async def cancel(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> int:
    await update.message.reply_text("Cancelled\\.", parse_mode=ParseMode.MARKDOWN_V2)
    return ConversationHandler.END


# ═══════════════════════════════════════════════════════════════════
#  V3: SIGNAL MANAGEMENT + BILLING COMMANDS
# ═══════════════════════════════════════════════════════════════════

@rate_limited
@require_link
async def cmd_cancel_signal(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Cancel a tracked signal: /cancel_signal <ID>"""
    args = ctx.args
    if not args:
        await update.message.reply_text(
            "Usage: /cancel\\_signal SIGNAL\\_ID\n\n"
            "Find your signal IDs with /my\\_signals",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
        return

    signal_id = args[0].strip()
    token = store.get_token(update.effective_user.id)
    try:
        result = await api.signal_cancel(token, signal_id)
        sym = result.get("symbol", "—")
        await update.message.reply_text(
            f"🚫 Signal cancelled\n\n"
            f"📊 {bold(esc(str(sym)))} → CANCELLED\n\n"
            "Signal will no longer be tracked against market data\\.",
            parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        code = getattr(getattr(e, "response", None), "status_code", 0)
        if code == 404:
            await update.message.reply_text(
                "❌ Signal not found\\. Check the ID with /my\\_signals",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
        elif code == 409:
            await update.message.reply_text(
                "⚠️ Signal already resolved — can't cancel\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
        else:
            await api_error(update, "cancel signal", e)


@rate_limited
@require_link
async def cmd_my_stats(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Show personal tracking stats: /my_stats"""
    token = store.get_token(update.effective_user.id)
    try:
        s = await api.user_signal_stats(token)
        total = s.get("total", 0)
        if total == 0:
            await update.message.reply_text(
                "📭 No tracked signals yet\\. Use /track to submit one\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return

        wr = s.get("winRate")
        wr_str = f"{wr * 100:.1f}%" if wr is not None else "—"

        lines = [
            f"📊 {bold('Your Signal Stats')}\n",
            f"Total tracked: {bold(esc(str(total)))}",
            f"Open: {bold(esc(str(s.get('open', 0))))}",
            f"Wins: {bold(esc(str(s.get('wins', 0))))} / {esc(str(s.get('totalResolved', 0)))} resolved",
            f"Win rate: {bold(esc(wr_str))}",
        ]

        best = s.get("best")
        if best:
            bp = pct(best.get("result"))
            lines.append(f"\n🏆 Best: {bold(esc(str(best.get('symbol', '—'))))} {esc(bp)}")

        worst = s.get("worst")
        if worst:
            wp = pct(worst.get("result"))
            lines.append(f"💀 Worst: {bold(esc(str(worst.get('symbol', '—'))))} {esc(wp)}")

        monthly = s.get("monthly", [])
        if monthly:
            lines.append(f"\n📅 {bold('Monthly')}")
            for m in monthly[:4]:
                mp = pct(m.get("avgPnl"))
                lines.append(
                    f"  {esc(m['month'])}:  "
                    f"{m['wins']}W / {m['losses']}L  "
                    f"avg {esc(mp)}"
                )

        await update.message.reply_text(
            "\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, "user stats", e)


@rate_limited
@require_link
async def cmd_billing(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Manage subscription: /billing"""
    token = store.get_token(update.effective_user.id)
    try:
        status = await api.billing_status(token)
        plan = status.get("plan", "free")
        sub_status = status.get("status", "none")

        if plan in ("free", "expired", "no_account") or sub_status == "none":
            await update.message.reply_text(
                f"📋 {bold('Billing')}\n\n"
                f"Plan: {bold('Free')}\n\n"
                f"Use /upgrade pro or /upgrade elite to subscribe\\.",
                parse_mode=ParseMode.MARKDOWN_V2,
            )
            return

        portal = await api.billing_portal(token)
        portal_url = portal.get("url")

        lines = [
            f"📋 {bold('Billing')}\n",
            f"Plan: {bold(esc(plan.upper()))}",
            f"Status: {esc(sub_status)}",
        ]

        if status.get("expiresAt"):
            lines.append(f"Renews/expires: {esc(str(status['expiresAt'])[:10])}")

        if portal_url:
            lines.append(f"\n👉 {link('Manage Subscription', portal_url)}")

        await update.message.reply_text(
            "\n".join(lines), parse_mode=ParseMode.MARKDOWN_V2,
        )
    except Exception as e:
        await api_error(update, "billing", e)


# ═══════════════════════════════════════════════════════════════════
#  BOT SETUP
# ═══════════════════════════════════════════════════════════════════

BOT_COMMANDS = [
    # Core
    BotCommand("start", "Welcome message"),
    BotCommand("help", "All commands"),
    # Breakout & Signals
    BotCommand("signals", "Latest breakout signals"),
    BotCommand("breakouts", "Active breakout setups"),
    BotCommand("latest", "Most recent alerts"),
    BotCommand("watchlist", "Monitored pairs"),
    BotCommand("pair", "Breakout data for a pair"),
    BotCommand("setup", "Entry, SL, TPs, confidence"),
    # Alerts
    BotCommand("alerts", "Your active alerts"),
    BotCommand("addalert", "Add alert"),
    BotCommand("removealert", "Remove alert"),
    BotCommand("pausealerts", "Pause all alerts"),
    BotCommand("resumealerts", "Resume all alerts"),
    BotCommand("settings", "Alert preferences"),
    # Intelligence
    BotCommand("market", "Market overview"),
    BotCommand("top", "Top breakout candidates"),
    BotCommand("momentum", "Strongest momentum"),
    BotCommand("volume", "Unusual volume"),
    BotCommand("oi", "Open interest movers"),
    BotCommand("funding", "Funding rate extremes"),
    # Track
    BotCommand("track", "Submit a signal to track"),
    BotCommand("my_signals", "Your tracked signals"),
    BotCommand("signal_status", "Check signal status"),
    BotCommand("cancel_signal", "Cancel a tracked signal"),
    BotCommand("my_stats", "Your signal tracking stats"),
    # Proof & Trust
    BotCommand("proof", "Verified performance"),
    BotCommand("history", "Past signals"),
    BotCommand("wins", "Winning signals"),
    BotCommand("stats", "Performance stats"),
    # Account
    BotCommand("connect", "Link Telegram to AgoraIQ"),
    BotCommand("disconnect", "Unlink account"),
    BotCommand("status", "Account & subscription"),
    BotCommand("profile", "Bot profile"),
    BotCommand("plan", "Current plan"),
    BotCommand("upgrade", "Upgrade access"),
    BotCommand("billing", "Manage subscription"),
    # Providers
    BotCommand("providers", "Signal provider leaderboard"),
    BotCommand("top_providers", "Top rated providers"),
    BotCommand("follow", "Follow a provider"),
    BotCommand("unfollow", "Unfollow a provider"),
    # Support
    BotCommand("support", "Contact support"),
    BotCommand("faq", "Common questions"),
    BotCommand("feedback", "Send feedback"),
    BotCommand("about", "What is AgoraIQ"),
]


async def post_init(app: Application) -> None:
    await app.bot.set_my_commands(BOT_COMMANDS)
    # Push notifications are handled by backend workers (BullMQ on port 4300).
    # The bot's pushworker.py is kept as fallback — enable by setting PUSH_POLL_SECONDS > 0
    poll_sec = int(os.environ.get("PUSH_POLL_SECONDS", "0"))
    if poll_sec > 0:
        asyncio.create_task(pushworker.start_push_worker(app.bot))
        log.info("Bot-side push worker enabled (fallback mode)")
    log.info("Bot commands registered.")


async def post_shutdown(app: Application) -> None:
    pushworker.stop_push_worker()
    await api.close_client()
    store.close()
    log.info("Cleanup complete.")


def main() -> None:
    token = os.environ["BOT_TOKEN"]

    app = Application.builder().token(token).post_init(post_init).post_shutdown(post_shutdown).build()

    # ── track conversation ──────────────────────────────────────
    track_conv = ConversationHandler(
        entry_points=[CommandHandler("track", cmd_track)],
        states={
            TRACK_INPUT[0]: [MessageHandler(filters.TEXT & ~filters.COMMAND, track_receive)],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )

    # ── feedback conversation ───────────────────────────────────
    feedback_conv = ConversationHandler(
        entry_points=[CommandHandler("feedback", cmd_feedback)],
        states={
            FEEDBACK_TEXT[0]: [MessageHandler(filters.TEXT & ~filters.COMMAND, feedback_receive)],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
    )

    from telegram.ext import CallbackQueryHandler
    app.add_handler(CallbackQueryHandler(upgrade_callback, pattern="^upgrade:"))
    app.add_handler(CallbackQueryHandler(billing_portal_callback, pattern="^billing_portal$"))
    app.add_handler(CallbackQueryHandler(track_from_format_callback, pattern="^track_from_format$"))
    app.add_handler(CallbackQueryHandler(track_signal_callback, pattern="^track:"))
    from telegram.ext import CallbackQueryHandler
    app.add_handler(track_conv)
    app.add_handler(feedback_conv)

    # Core
    for cmd, fn in [
        ("start", cmd_start), ("help", cmd_help), ("register", cmd_register),
        ("login", cmd_login), ("pricing", cmd_pricing), ("status", cmd_status),
    ]:
        app.add_handler(CommandHandler(cmd, fn))

    # Breakout
    for cmd, fn in [
        ("signals", cmd_signals), ("breakouts", cmd_breakouts), ("latest", cmd_latest),
        ("watchlist", cmd_watchlist), ("pair", cmd_pair), ("setup", cmd_setup),
    ]:
        app.add_handler(CommandHandler(cmd, fn))

    # Alerts
    for cmd, fn in [
        ("alerts", cmd_alerts), ("addalert", cmd_addalert), ("removealert", cmd_removealert),
        ("pausealerts", cmd_pausealerts), ("resumealerts", cmd_resumealerts),
        ("settings", cmd_settings),
    ]:
        app.add_handler(CommandHandler(cmd, fn))

    # Intelligence
    for cmd, fn in [
        ("market", cmd_market), ("top", cmd_top), ("momentum", cmd_momentum),
        ("volume", cmd_volume), ("oi", cmd_oi), ("funding", cmd_funding),
    ]:
        app.add_handler(CommandHandler(cmd, fn))

    # Proof
    for cmd, fn in [
        ("proof", cmd_proof), ("history", cmd_history),
        ("wins", cmd_wins), ("stats", cmd_stats),
    ]:
        app.add_handler(CommandHandler(cmd, fn))

    # Providers
    for cmd, fn in [
        ("providers", cmd_providers), ("top_providers", cmd_top_providers),
        ("follow", cmd_follow), ("unfollow", cmd_unfollow),
    ]:
        app.add_handler(CommandHandler(cmd, fn))

    # User signals
    for cmd, fn in [
        ("my_signals", cmd_my_signals), ("signal_status", cmd_signal_status),
        ("cancel_signal", cmd_cancel_signal), ("my_stats", cmd_my_stats),
    ]:
        app.add_handler(CommandHandler(cmd, fn))

    # Account
    for cmd, fn in [
        ("connect", cmd_connect), ("disconnect", cmd_disconnect),
        ("profile", cmd_profile), ("plan", cmd_plan), ("upgrade", cmd_upgrade),
        ("billing", cmd_billing),
    ]:
        app.add_handler(CommandHandler(cmd, fn))

    # Support
    for cmd, fn in [
        ("about", cmd_about), ("support", cmd_support), ("faq", cmd_faq),
    ]:
        app.add_handler(CommandHandler(cmd, fn))

    log.info("Starting AgoraIQ Breakout Bot…")
    # /format — Signal Formatter
    app.add_handler(CommandHandler("format", cmd_format))
    app.run_polling(drop_pending_updates=True)




# ═══════════════════════════════════════════════════════════════════
#  PROVIDER COMMANDS
#  Register in main():
#    app.add_handler(CommandHandler("provider",  cmd_provider))
#    app.add_handler(CommandHandler("providers", cmd_providers))
# ═══════════════════════════════════════════════════════════════════

@rate_limited
async def cmd_providers(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    token = store.get_token(user.id)
    try:
        data = await api.providers_list(token)
        providers = data if isinstance(data, list) else data.get("providers", [])
        total = len(providers)
        msg = cards.provider_list_card(providers, total=total)
        await update.message.reply_text(
            msg,
            parse_mode="MarkdownV2",
            reply_markup=cards.InlineKeyboardMarkup([[
                cards.InlineKeyboardButton("🌐 Browse on Web", url=f"{APP_URL}/providers.html")
            ]]),
        )
    except Exception as e:
        log.warning("cmd_providers error: %s", e)
        await update.message.reply_text("⚠️ Could not load providers. Try again shortly.")


@rate_limited
async def cmd_provider(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    plan = cards.get_plan(update, store)

    if not cards.is_premium(plan):
        await update.message.reply_text(
            cards.provider_card_locked(),
            parse_mode="MarkdownV2",
            reply_markup=cards.InlineKeyboardMarkup([[
                cards.InlineKeyboardButton("💎 Upgrade to Pro", url=f"{LANDING}/pricing")
            ]]),
        )
        return

    name_query = " ".join(ctx.args).strip() if ctx.args else ""
    if not name_query:
        await update.message.reply_text(
            "Usage: `/provider NAME`\nExample: `/provider Fat Pig Signals`",
            parse_mode="MarkdownV2",
        )
        return

    token = store.get_token(user.id)
    try:
        data = await api.provider_by_name(name_query, token)
        provider = data if isinstance(data, dict) and "name" in data else (
            data[0] if isinstance(data, list) and data else None
        )
    except Exception as e:
        log.warning("provider lookup error: %s", e)
        await update.message.reply_text("⚠️ Provider not found. Check the name and try again.")
        return

    if not provider:
        await update.message.reply_text(
            f"❌ No provider found matching `{cards._e(name_query)}`\.\n\nUse /providers to browse all\.",
            parse_mode="MarkdownV2",
        )
        return

    channel = provider.get("channel", "")
    tg_info = {}
    if channel and provider.get("platform", "telegram") == "telegram":
        tg_info = await api.get_telegram_channel_info(ctx.bot, channel)

    msg = cards.provider_card(provider, tg_info=tg_info)
    slug = provider.get("slug", "")
    await update.message.reply_text(
        msg,
        parse_mode="MarkdownV2",
        reply_markup=cards.provider_keyboard(slug, channel),
    )


# ═══════════════════════════════════════════════════════════════════
#  /format  — Signal Formatter (Pro + Elite)
#  Register in main():
#    app.add_handler(CommandHandler("format", cmd_format))
#    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, cmd_format_message))
#  Add to BotCommand list:
#    BotCommand("format", "Clean + structure any signal (Pro+)"),
# ═══════════════════════════════════════════════════════════════════

@rate_limited
async def cmd_format(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """
    /format <signal text>
    Or just send a message after /format with no args — bot will ask.
    Pro + Elite only.
    """
    user = update.effective_user
    plan = cards.get_plan(update, store)

    if not cards.is_premium(plan):
        await update.message.reply_text(
            cards.format_card_locked(),
            parse_mode="MarkdownV2",
            reply_markup=cards.InlineKeyboardMarkup([[
                cards.InlineKeyboardButton("💎 Upgrade to Pro", url=f"{LANDING}/pricing")
            ]]),
        )
        return

    # Get text from args or prompt
    raw = " ".join(ctx.args).strip() if ctx.args else ""
    if not raw:
        await update.message.reply_text(
            "📋 Paste your signal text and I'll clean it up\.\n\nExample:\n`/format BTCUSDT long entry 95000 sl 93000 tp1 97000 tp2 99000`",
            parse_mode="MarkdownV2",
        )
        return

    token = store.get_token(user.id)

    try:
        result = await api.signal_format(token, raw)
        parsed = result if isinstance(result, dict) else {}

        if not parsed.get("symbol"):
            await update.message.reply_text(
                "⚠️ Couldn\'t parse that signal\. Try including symbol, direction, entry, SL and TP\.",
                parse_mode="MarkdownV2",
            )
            return

        ctx.user_data["last_formatted_signal"] = raw
        msg = cards.format_card_plain(parsed, raw)
        await update.message.reply_text(
            msg,
            reply_markup=cards.InlineKeyboardMarkup([[
                cards.InlineKeyboardButton("📡 Track this signal", callback_data="track_from_format"),
            ]]),
        )

    except Exception as e:
        log.warning("cmd_format error: %s", e)
        await update.message.reply_text("⚠️ Could not format signal\. Try again shortly\.", parse_mode="MarkdownV2")

if __name__ == "__main__":
    main()
