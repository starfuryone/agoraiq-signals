"""
API-backed session cache for the agoraiq-signals Telegram bot.

Postgres (via the signals API) is the sole source of truth.
This module is a thin in-memory cache — no local database, no SQLite.

Token flow:
  1. Bot calls /auth/telegram-auth with telegram_id (localhost only)
  2. API looks up bot_telegram_accounts -> bot_users, returns a JWT
  3. Bot caches the JWT in memory with a TTL
  4. On expiry or miss, bot re-fetches from API

If the API says the user is not linked, the bot treats them as unlinked.
No Fernet, no SQLite, no local persistence.
"""

from __future__ import annotations

import os
import time
from typing import Optional

import httpx

API_BASE = os.environ.get("API_BASE", "http://127.0.0.1:4300/api/v1")
CACHE_TTL = int(os.environ.get("TOKEN_CACHE_TTL", "300"))

# { telegram_id: { token, email, plan_tier, fetched_at } }
_cache: dict[int, dict] = {}


def _is_fresh(entry: dict) -> bool:
    return (time.time() - entry.get("fetched_at", 0)) < CACHE_TTL


def _sync_fetch(telegram_id: int) -> Optional[dict]:
    try:
        with httpx.Client(timeout=10.0) as client:
            r = client.post(
                f"{API_BASE}/auth/telegram-auth",
                json={"telegram_id": telegram_id},
                headers={"Content-Type": "application/json"},
            )
            if r.status_code == 200:
                return r.json()
            return None
    except Exception:
        return None


async def _async_fetch(telegram_id: int) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{API_BASE}/auth/telegram-auth",
                json={"telegram_id": telegram_id},
                headers={"Content-Type": "application/json"},
            )
            if r.status_code == 200:
                return r.json()
            return None
    except Exception:
        return None


def save_link(telegram_id: int, email: str, token: str, plan_tier: str = "free") -> None:
    _cache[telegram_id] = {
        "token": token,
        "email": email,
        "plan_tier": plan_tier,
        "fetched_at": time.time(),
    }


def get_token(telegram_id: int) -> Optional[str]:
    entry = _cache.get(telegram_id)
    if entry and _is_fresh(entry):
        return entry["token"]

    result = _sync_fetch(telegram_id)
    if not result or not result.get("token"):
        _cache.pop(telegram_id, None)
        return None

    user = result.get("user", {})
    save_link(telegram_id, user.get("email", ""), result["token"], user.get("planTier", "free"))
    return result["token"]


async def async_get_token(telegram_id: int) -> Optional[str]:
    entry = _cache.get(telegram_id)
    if entry and _is_fresh(entry):
        return entry["token"]

    result = await _async_fetch(telegram_id)
    if not result or not result.get("token"):
        _cache.pop(telegram_id, None)
        return None

    user = result.get("user", {})
    save_link(telegram_id, user.get("email", ""), result["token"], user.get("planTier", "free"))
    return result["token"]


def get_user(telegram_id: int) -> Optional[dict]:
    entry = _cache.get(telegram_id)
    if entry and _is_fresh(entry):
        return {"telegram_id": telegram_id, "email": entry["email"], "plan_tier": entry["plan_tier"], "linked_at": None}

    result = _sync_fetch(telegram_id)
    if not result or not result.get("token"):
        _cache.pop(telegram_id, None)
        return None

    user = result.get("user", {})
    save_link(telegram_id, user.get("email", ""), result["token"], user.get("planTier", "free"))
    return {"telegram_id": telegram_id, "email": user.get("email", ""), "plan_tier": user.get("planTier", "free"), "linked_at": None}


def remove_link(telegram_id: int) -> bool:
    removed = telegram_id in _cache
    _cache.pop(telegram_id, None)
    return removed


def close() -> None:
    pass
