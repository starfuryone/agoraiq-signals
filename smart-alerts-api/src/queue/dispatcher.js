"use strict";

/**
 * Dispatcher — the hot path from signal webhook → delivery queue.
 *
 * 1. Look up candidate rules from the in-memory index
 * 2. Evaluate each
 * 3. Apply Redis gates (dedup, cooldown, daily limit)
 * 4. Record a trigger log row
 * 5. Enqueue a delivery job with priority based on plan tier
 *
 * Returns an array of dispatch outcomes for observability/debugging.
 */

const ruleIndex = require("../engine/ruleIndex");
const evaluator = require("../engine/evaluator");
const gates = require("../engine/gates");
const AlertRule = require("../models/alertRule");
const TriggerLog = require("../models/triggerLog");
const DeliveryAttempt = require("../models/deliveryAttempt");
const { deliveryQueue } = require("./queues");
const log = require("../lib/logger");

/**
 * Normalize an inbound signal to a flat, canonical shape the evaluator
 * understands. Input is whatever the main app decided to emit; output
 * is strictly typed.
 */
function normalizeSignal(raw) {
  if (!raw || typeof raw !== "object") return null;
  const symbol = raw.symbol || raw.pair || null;
  return {
    id: String(raw.id ?? raw.signal_id ?? raw.uuid ?? ""),
    symbol: symbol ? String(symbol).toUpperCase().replace(/[/\-_\s]/g, "") : null,
    ai_score: numOrNull(raw.ai_score ?? raw.score),
    confidence: numOrNull(raw.confidence),
    direction: raw.direction ? String(raw.direction).toLowerCase() : null,
    risk_reward: numOrNull(raw.risk_reward ?? raw.rr),
    provider: raw.provider ? String(raw.provider).toLowerCase() : null,
    timeframe: raw.timeframe ? String(raw.timeframe).toLowerCase() : null,
    entry_type: raw.entry_type ? String(raw.entry_type).toLowerCase() : null,
    trending: raw.trending === true || raw.trending === "true",
    signal_type: raw.signal_type ? String(raw.signal_type).toLowerCase() : null,
    leverage_max: numOrNull(raw.leverage_max ?? raw.leverage),
    raw,
  };
}

function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function dispatch(rawSignal) {
  const signal = normalizeSignal(rawSignal);
  if (!signal || !signal.id) {
    return { accepted: false, reason: "invalid_signal" };
  }
  const candidates = ruleIndex.candidates(signal);
  if (candidates.length === 0) {
    return { accepted: true, evaluated: 0, matched: 0, dispatched: 0 };
  }

  const outcomes = [];
  let matched = 0;
  let dispatched = 0;

  // Evaluate in parallel batches — each rule is CPU cheap.
  await Promise.all(candidates.map(async (rule) => {
    try {
      // Skip paused/deleted rows the index hasn't caught up on yet.
      if (rule.status !== "active") return;

      const evalRes = evaluator.evaluate(rule.rule_json, signal);
      if (!evalRes.match) return;
      matched++;

      const gate = await gates.tryAcquire({
        ruleId: rule.id,
        signalId: signal.id,
        userId: rule.user_id,
        cooldownSec: rule.cooldown_seconds,
        dailyLimit: rule.daily_limit,
      });

      if (!gate.allowed) {
        await TriggerLog.record({
          alert_rule_id: rule.id,
          user_id: rule.user_id,
          signal_id: signal.id,
          signal_snapshot: signal.raw,
          matched_fields: evalRes.matchedFields,
          suppressed: true,
          suppressed_reason: gate.reason,
        });
        outcomes.push({ ruleId: rule.id, status: "suppressed", reason: gate.reason });
        return;
      }

      const triggerRow = await TriggerLog.record({
        alert_rule_id: rule.id,
        user_id: rule.user_id,
        signal_id: signal.id,
        signal_snapshot: signal.raw,
        matched_fields: evalRes.matchedFields,
      });
      if (!triggerRow) {
        // Unique (rule_id, signal_id) already inserted — dedup conflict
        outcomes.push({ ruleId: rule.id, status: "dedup_db" });
        return;
      }
      await AlertRule.incrementMatchCount(rule.id);

      const deliveryId = await DeliveryAttempt.create({
        trigger_log_id: triggerRow.id,
        alert_rule_id: rule.id,
        user_id: rule.user_id,
        channel: rule.delivery_channel || "telegram",
        target: rule.delivery_target,
        payload: buildPayload(rule, signal, evalRes),
      });

      const q = deliveryQueue();
      await q.add(
        "deliver",
        { deliveryId },
        {
          priority: rule.priority || 5,
          jobId: `d-${deliveryId}`,
        }
      );
      dispatched++;
      outcomes.push({ ruleId: rule.id, status: "dispatched", deliveryId });
    } catch (e) {
      log.error(`[dispatch] rule ${rule.id}:`, e.message);
      outcomes.push({ ruleId: rule.id, status: "error", error: e.message });
    }
  }));

  return {
    accepted: true,
    signalId: signal.id,
    evaluated: candidates.length,
    matched,
    dispatched,
    outcomes,
  };
}

function buildPayload(rule, signal, evalRes) {
  return {
    alert: {
      id: rule.id,
      name: rule.name,
      tier: rule.plan_tier,
    },
    signal: {
      id: signal.id,
      symbol: signal.symbol,
      direction: signal.direction,
      ai_score: signal.ai_score,
      confidence: signal.confidence,
      risk_reward: signal.risk_reward,
      provider: signal.provider,
      timeframe: signal.timeframe,
      signal_type: signal.signal_type,
      entry_type: signal.entry_type,
    },
    matched_fields: evalRes.matchedFields,
    fired_at: new Date().toISOString(),
  };
}

module.exports = { dispatch, normalizeSignal };
