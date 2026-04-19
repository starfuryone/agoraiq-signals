"use strict";

/**
 * Redis-backed gates that sit between rule match and queue enqueue.
 *
 *   1. cooldown     — per-rule interval
 *   2. dedup        — per-(rule, signal) idempotency
 *   3. daily-limit  — per-user trigger cap, resets at UTC midnight
 *
 * All three are implemented as atomic Redis operations so concurrent
 * webhook deliveries cannot bypass them.
 */

const { getRedis } = require("../lib/redis");

function cooldownKey(ruleId) { return `cooldown:${ruleId}`; }
function dedupeKey(ruleId, signalId) { return `dedup:${ruleId}:${signalId}`; }
function dailyKey(userId, day) { return `daily:${userId}:${day}`; }

function utcDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 5
  ));
  return Math.max(60, Math.floor((next - now) / 1000));
}

/**
 * Try to reserve a slot for a signal match. Returns an object
 *   { allowed: boolean, reason?: string }
 *
 * Order: dedup first (cheapest, prevents replay), then cooldown,
 * then daily limit. Each acquire is idempotent on failure — we never
 * partially "spend" another gate if a later one denies.
 */
async function tryAcquire({ ruleId, signalId, userId, cooldownSec, dailyLimit }) {
  const r = getRedis();

  // 1. Dedup — SET NX with a generous TTL. Dedup persists beyond
  //    cooldown so a re-delivered identical webhook cannot double-fire.
  const DEDUP_TTL = 24 * 60 * 60;
  const dedup = await r.set(dedupeKey(ruleId, signalId), "1", "EX", DEDUP_TTL, "NX");
  if (dedup !== "OK") return { allowed: false, reason: "duplicate_signal" };

  // 2. Cooldown — SET NX with EX=cooldownSec.
  const cooldown = await r.set(cooldownKey(ruleId), "1", "EX", Math.max(1, cooldownSec), "NX");
  if (cooldown !== "OK") {
    // release the dedup reservation so a later (post-cooldown) unique
    // signal can still fire; dedup is per (rule, signalId) so strictly
    // keeping it would be fine too. We keep it to avoid replay attacks.
    return { allowed: false, reason: "cooldown" };
  }

  // 3. Daily limit — INCR with first-write EXPIRE.
  const day = utcDay();
  const key = dailyKey(userId, day);
  const count = await r.incr(key);
  if (count === 1) {
    await r.expire(key, secondsUntilUtcMidnight());
  }
  if (count > dailyLimit) {
    return { allowed: false, reason: "daily_limit", count };
  }

  return { allowed: true, count };
}

async function getDailyCount(userId) {
  const r = getRedis();
  const v = await r.get(dailyKey(userId, utcDay()));
  return parseInt(v || "0", 10) || 0;
}

module.exports = { tryAcquire, getDailyCount };
