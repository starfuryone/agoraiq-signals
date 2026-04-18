"""Async HTTP client for agoraiq-signals-api (standalone).

All traffic goes to one local API on one port.
No shared endpoints. No cross-service calls.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

import httpx

API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:4300/api/v1")
INTERNAL_SECRET = os.environ.get("INTERNAL_API_SECRET", "")

_client: Optional[httpx.AsyncClient] = None


def _get_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(timeout=15.0)
    return _client


async def close_client() -> None:
    global _client
    if _client and not _client.is_closed:
        await _client.aclose()
        _client = None


def _headers(token: Optional[str] = None) -> Dict[str, str]:
    h: Dict[str, str] = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    if INTERNAL_SECRET:
        h["X-Internal-Auth"] = INTERNAL_SECRET
    return h


async def _get(url: str, token: Optional[str] = None) -> Dict[str, Any]:
    r = await _get_client().get(url, headers=_headers(token))
    r.raise_for_status()
    return r.json()


async def _post(url: str, body: Dict[str, Any], token: Optional[str] = None) -> Dict[str, Any]:
    r = await _get_client().post(url, json=body, headers=_headers(token))
    r.raise_for_status()
    return r.json()


async def _patch(url: str, body: Dict[str, Any], token: Optional[str] = None) -> Dict[str, Any]:
    r = await _get_client().patch(url, json=body, headers=_headers(token))
    r.raise_for_status()
    return r.json()


async def _delete(url: str, token: Optional[str] = None) -> Dict[str, Any]:
    r = await _get_client().delete(url, headers=_headers(token))
    r.raise_for_status()
    return r.json()


# ═══════════════════════════════════════════════════════════════════
#  AUTH (standalone — own users, own JWTs)
# ═══════════════════════════════════════════════════════════════════

async def auth_me(token: str) -> Dict[str, Any]:
    return await _get(f"{API_BASE}/auth/me", token)


async def register_user(email: str, password: str) -> Dict[str, Any]:
    return await _post(f"{API_BASE}/auth/register", {"email": email, "password": password})


async def login_user(email: str, password: str) -> Dict[str, Any]:
    return await _post(f"{API_BASE}/auth/login", {"email": email, "password": password})


async def telegram_auth(telegram_id: int) -> Dict[str, Any]:
    """POST /auth/telegram-auth — get JWT for linked telegram user (localhost only)"""
    return await _post(f"{API_BASE}/auth/telegram-auth", {"telegram_id": telegram_id})


# ═══════════════════════════════════════════════════════════════════
#  SIGNALS
# ═══════════════════════════════════════════════════════════════════

async def signals_latest(limit: int = 10) -> Any:
    return await _get(f"{API_BASE}/signals?limit={limit}")


async def signals_history(limit: int = 20) -> Any:
    return await _get(f"{API_BASE}/signals/history?limit={limit}")


async def signal_submit(token: str, raw_text: str) -> Any:
    return await _post(f"{API_BASE}/signals/submit", {"raw_text": raw_text}, token)


async def signal_cancel(token: str, signal_id: str) -> Any:
    return await _post(f"{API_BASE}/signals/{signal_id}/cancel", {}, token)


async def user_signals(token: str, limit: int = 10) -> Any:
    return await _get(f"{API_BASE}/signals/user?limit={limit}", token)


async def signal_detail(token: str, signal_id: str) -> Any:
    return await _get(f"{API_BASE}/signals/{signal_id}", token)


async def user_signal_stats(token: str) -> Any:
    return await _get(f"{API_BASE}/signals/user/stats", token)


# ═══════════════════════════════════════════════════════════════════
#  PROOF / PERFORMANCE
# ═══════════════════════════════════════════════════════════════════

async def proof_stats() -> Dict[str, Any]:
    return await _get(f"{API_BASE}/proof/stats")


async def proof_monthly() -> Dict[str, Any]:
    return await _get(f"{API_BASE}/proof/monthly")


async def proof_recent(limit: int = 10) -> Any:
    return await _get(f"{API_BASE}/proof/recent?limit={limit}")


# ═══════════════════════════════════════════════════════════════════
#  SCANNER / MARKET
# ═══════════════════════════════════════════════════════════════════

async def scanner_overview() -> Dict[str, Any]:
    return await _get(f"{API_BASE}/scanner/overview")


async def scanner_breakouts() -> Any:
    return await _get(f"{API_BASE}/scanner/breakouts")


async def scanner_pair(symbol: str) -> Dict[str, Any]:
    return await _get(f"{API_BASE}/scanner/pair/{symbol.upper()}")


async def scanner_top() -> Any:
    return await _get(f"{API_BASE}/scanner/top")


async def scanner_momentum() -> Any:
    return await _get(f"{API_BASE}/scanner/momentum")


async def scanner_volume() -> Any:
    return await _get(f"{API_BASE}/scanner/volume")


async def scanner_oi() -> Any:
    return await _get(f"{API_BASE}/scanner/oi")


async def scanner_funding() -> Any:
    return await _get(f"{API_BASE}/scanner/funding")


# ═══════════════════════════════════════════════════════════════════
#  PROVIDERS
# ═══════════════════════════════════════════════════════════════════

async def providers_list(limit: int = 10) -> Any:
    return await _get(f"{API_BASE}/providers?limit={limit}")


async def providers_top() -> Any:
    return await _get(f"{API_BASE}/providers/top")


async def provider_detail(provider_id: str) -> Any:
    return await _get(f"{API_BASE}/providers/{provider_id}")


async def provider_follow(token: str, provider_id: str) -> Any:
    return await _post(f"{API_BASE}/providers/{provider_id}/follow", {}, token)


async def provider_unfollow(token: str, provider_id: str) -> Any:
    return await _delete(f"{API_BASE}/providers/{provider_id}/follow", token)


async def provider_following(token: str) -> Any:
    return await _get(f"{API_BASE}/providers/following", token)


# ═══════════════════════════════════════════════════════════════════
#  TELEGRAM LINK (standalone flow)
# ═══════════════════════════════════════════════════════════════════

async def telegram_link_start(telegram_id: int, telegram_username: str = None) -> Any:
    body = {"telegram_id": telegram_id}
    if telegram_username:
        body["telegram_username"] = telegram_username
    return await _post(f"{API_BASE}/telegram/link/start", body)


async def telegram_link_confirm(token: str, code: str) -> Any:
    return await _post(f"{API_BASE}/telegram/link/confirm", {"code": code}, token)


async def telegram_unlink(token: str) -> Any:
    return await _delete(f"{API_BASE}/telegram/link", token)


async def telegram_status(token: str) -> Any:
    return await _get(f"{API_BASE}/telegram/status", token)


# ═══════════════════════════════════════════════════════════════════
#  BILLING (standalone Stripe)
# ═══════════════════════════════════════════════════════════════════

async def billing_consent_config() -> Any:
    """Fetch the current consent version + required documents from the API.
    The bot must show these to the user and capture their acceptance
    *before* calling billing_checkout — it is NOT allowed to synthesize
    consent on the user's behalf."""
    return await _get(f"{API_BASE}/billing/consent-config")


async def billing_prices() -> Any:
    """Fetch the live Stripe price catalog so the bot never displays
    hardcoded amounts that could drift from what Stripe will actually charge."""
    return await _get(f"{API_BASE}/billing/prices")


async def billing_checkout(
    token: str,
    plan: str,
    period: str = "monthly",
    *,
    consent: Dict[str, Any],
    idempotency_key: Optional[str] = None,
) -> Any:
    """Create a Stripe Checkout or apply an immediate plan change.

    The caller MUST pass a consent object that was produced by real user
    interaction (e.g. the user tapped an in-bot confirm button that
    displayed the consent documents). The API rejects any consent that
    doesn't exactly match /billing/consent-config.
    """
    if not isinstance(consent, dict) or consent.get("accepted") is not True:
        raise ValueError("billing_checkout requires explicit user-accepted consent")

    body: Dict[str, Any] = {
        "plan": plan,
        "period": period,
        "source": "telegram",
        "consent": consent,
    }
    if idempotency_key:
        body["idempotencyKey"] = idempotency_key

    headers = _headers(token)
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    r = await _get_client().post(f"{API_BASE}/billing/checkout", json=body, headers=headers)
    r.raise_for_status()
    return r.json()


async def billing_portal(token: str) -> Any:
    return await _post(f"{API_BASE}/billing/portal", {}, token)


async def billing_status(token: str) -> Any:
    return await _get(f"{API_BASE}/billing/status", token)


# ═══════════════════════════════════════════════════════════════════
#  PROVIDER API CALLS
# ═══════════════════════════════════════════════════════════════════

async def providers_list(token=None):
    return await _get(f"{API_BASE}/providers", token)


async def provider_by_name(name, token=None):
    r = await _get_client().get(
        f"{API_BASE}/providers/search",
        params={"q": name},
        headers=_headers(token),
    )
    r.raise_for_status()
    return r.json()


import datetime

async def get_telegram_channel_info(bot, channel_username):
    result = {}
    if not channel_username:
        return result
    handle = channel_username.lstrip("@")
    try:
        chat = await bot.get_chat(f"@{handle}")
        if hasattr(chat, "date") and chat.date:
            delta = datetime.datetime.now(datetime.timezone.utc) - chat.date
            result["age_days"] = delta.days
    except Exception:
        pass
    try:
        count = await bot.get_chat_member_count(f"@{handle}")
        result["members"] = count
    except Exception:
        pass
    return result


async def signal_format(token: str, raw_text: str) -> Any:
    """POST /api/v1/signals/format — parse and structure a signal without tracking it."""
    return await _post(f"{API_BASE}/signals/format", {"text": raw_text}, token)
