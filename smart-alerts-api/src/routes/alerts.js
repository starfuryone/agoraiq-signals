"use strict";

const { Router } = require("express");
const { requireAuth } = require("../middleware/auth");
const { userLimiter } = require("../middleware/rateLimit");
const { requirePaid } = require("../lib/plan");
const { limitsFor } = require("../lib/plans");
const AlertRule = require("../models/alertRule");
const TriggerLog = require("../models/triggerLog");
const Audit = require("../models/auditEvent");
const ruleIndex = require("../engine/ruleIndex");
const parser = require("../engine/parser");
const llm = require("../engine/llmFallback");
const dsl = require("../engine/dsl");
const evaluator = require("../engine/evaluator");
const { dispatch, normalizeSignal } = require("../queue/dispatcher");
const log = require("../lib/logger");

const router = Router();

// Every route on this sub-router requires auth + paid plan.
router.use(requireAuth, userLimiter, requirePaid);

// ── create ─────────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  const userId = req.userId;
  const tier = req.planTier;
  const limits = limitsFor(tier);
  if (!limits) return res.status(403).json({ error: "invalid_plan_tier" });

  const { prompt, name, cooldown_seconds, delivery_target, delivery_channel, rule_json } = req.body || {};
  if (!prompt && !rule_json) {
    return res.status(400).json({ error: "prompt_or_rule_json_required" });
  }

  const existing = await AlertRule.countActive(userId);
  if (existing >= limits.maxAlerts) {
    return res.status(409).json({
      error: "alert_limit_reached",
      current: existing,
      limit: limits.maxAlerts,
      upgrade_url: tier === "pro" ? "/pricing.html" : null,
    });
  }

  // Resolve rule: user-supplied rule_json overrides the NL parser.
  let parsed;
  if (rule_json) {
    const v = dsl.validate(rule_json);
    if (!v.ok) return res.status(400).json({ error: "invalid_rule_json", detail: v.error });
    parsed = {
      rule: dsl.normalize(rule_json),
      confidence: 1.0,
      source: "regex",
    };
  } else {
    parsed = parser.parse(prompt);
    if (parsed.confidence < 0.5 && llm.isEnabled()) {
      const alt = await llm.parseWithLLM(prompt);
      if (alt) parsed = alt;
    }
    const v = dsl.validate(parsed.rule);
    if (!v.ok) return res.status(400).json({ error: "invalid_rule", detail: v.error });
    parsed.rule = dsl.normalize(parsed.rule);
  }

  if (parsed.rule.conditions.length > limits.maxConditionsPerRule) {
    return res.status(400).json({
      error: "too_many_conditions",
      limit: limits.maxConditionsPerRule,
    });
  }

  const cooldownSec = Math.max(
    limits.minCooldownSeconds,
    parseInt(cooldown_seconds ?? limits.minCooldownSeconds, 10) || limits.minCooldownSeconds
  );

  const row = await AlertRule.create({
    user_id: userId,
    plan_tier: tier,
    name: (name || prompt || "Alert").slice(0, 120),
    natural_language: prompt || "",
    rule_json: parsed.rule,
    cooldown_seconds: cooldownSec,
    daily_limit: limits.dailyTriggers,
    priority: limits.priority,
    parse_confidence: parsed.confidence,
    parse_source: parsed.source,
    delivery_channel: delivery_channel || "telegram",
    delivery_target: delivery_target || null,
  });

  ruleIndex.upsert(row);
  await Audit.record({
    user_id: userId, actor: "user", action: "alert.create",
    target_type: "alert_rule", target_id: row.id,
    metadata: { source: parsed.source, confidence: parsed.confidence },
  });

  res.status(201).json({
    alert: row,
    parse: { source: parsed.source, confidence: parsed.confidence },
    limits,
  });
});

// ── list ───────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  const rows = await AlertRule.findByUser(req.userId);
  const limits = limitsFor(req.planTier);
  const activeCount = rows.filter(r => r.status !== "deleted").length;
  res.json({
    alerts: rows,
    usage: { active: activeCount, max: limits.maxAlerts },
    limits,
  });
});

// ── pause / resume ────────────────────────────────────────────────
router.post("/:id/pause", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid_id" });
  const row = await AlertRule.setStatus(id, req.userId, "paused");
  if (!row) return res.status(404).json({ error: "not_found" });
  ruleIndex.remove(id);
  await Audit.record({ user_id: req.userId, actor: "user", action: "alert.pause", target_type: "alert_rule", target_id: id });
  res.json({ alert: row });
});

router.post("/:id/resume", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid_id" });
  const row = await AlertRule.setStatus(id, req.userId, "active");
  if (!row) return res.status(404).json({ error: "not_found" });
  ruleIndex.upsert(row);
  await Audit.record({ user_id: req.userId, actor: "user", action: "alert.resume", target_type: "alert_rule", target_id: id });
  res.json({ alert: row });
});

// ── delete ────────────────────────────────────────────────────────
router.delete("/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: "invalid_id" });
  const ok = await AlertRule.softDelete(id, req.userId);
  if (!ok) return res.status(404).json({ error: "not_found" });
  ruleIndex.remove(id);
  await Audit.record({ user_id: req.userId, actor: "user", action: "alert.delete", target_type: "alert_rule", target_id: id });
  res.status(204).end();
});

// ── test (dry run) ────────────────────────────────────────────────
router.post("/test", async (req, res) => {
  const { prompt, rule_json, signal } = req.body || {};
  let parsed;
  if (rule_json) {
    const v = dsl.validate(rule_json);
    if (!v.ok) return res.status(400).json({ error: "invalid_rule_json", detail: v.error });
    parsed = { rule: dsl.normalize(rule_json), confidence: 1.0, source: "regex" };
  } else if (prompt) {
    parsed = parser.parse(prompt);
    if (parsed.confidence < 0.5 && llm.isEnabled()) {
      const alt = await llm.parseWithLLM(prompt);
      if (alt) parsed = alt;
    }
  } else {
    return res.status(400).json({ error: "prompt_or_rule_json_required" });
  }

  let match = null;
  if (signal) {
    const normalized = normalizeSignal(signal) || signal;
    match = evaluator.evaluate(parsed.rule, normalized);
  }
  res.json({ parsed, match });
});

module.exports = router;
