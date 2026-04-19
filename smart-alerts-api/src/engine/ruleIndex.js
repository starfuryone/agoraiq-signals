"use strict";

/**
 * In-memory index of active alert rules.
 *
 * A naive evaluator would scan every active rule for every signal. For
 * thousands of rules this is wasteful. We pre-bucket rules by:
 *   - exact symbol when the rule pins a symbol (biggest wasted work)
 *   - plus a "wildcard" bucket for rules with no symbol condition
 *
 * Signals are then evaluated against the union of the symbol bucket
 * and the wildcard bucket. Further numeric pruning (ai_score thresholds)
 * is applied inside the evaluator; the index's job is just to avoid a
 * full table scan per signal.
 *
 * The index is rebuilt from Postgres on boot and refreshed on demand
 * whenever a rule is created/updated/deleted.
 */

const AlertRule = require("../models/alertRule");
const log = require("../lib/logger");

const state = {
  bySymbol: new Map(),   // symbol(UPPER) -> [rule, ...]
  wildcard: [],          // [rule, ...]
  all: new Map(),        // id -> rule
  lastLoadedAt: 0,
};

function indexOneRule(rule) {
  const sym = extractSymbol(rule.rule_json);
  state.all.set(Number(rule.id), rule);
  if (sym) {
    const bucket = state.bySymbol.get(sym) || [];
    bucket.push(rule);
    state.bySymbol.set(sym, bucket);
  } else {
    state.wildcard.push(rule);
  }
}

function extractSymbol(ruleJson) {
  if (!ruleJson || !Array.isArray(ruleJson.conditions)) return null;
  const logic = (ruleJson.logic || "AND").toUpperCase();
  // Only safe to key off symbol when logic is AND — with OR the rule
  // should still match a different symbol through the OR branch.
  if (logic !== "AND") return null;
  for (const c of ruleJson.conditions) {
    if (c.field === "symbol" && c.operator === "eq" && typeof c.value === "string") {
      return c.value.toUpperCase();
    }
  }
  return null;
}

async function load() {
  const rows = await AlertRule.listAllActive();
  state.bySymbol = new Map();
  state.wildcard = [];
  state.all = new Map();
  for (const row of rows) indexOneRule(row);
  state.lastLoadedAt = Date.now();
  log.info(`[index] loaded ${rows.length} rules (symbol-keyed ${state.bySymbol.size}, wildcard ${state.wildcard.length})`);
}

function upsert(rule) {
  remove(rule.id);
  if (rule.status !== "active") return;
  indexOneRule(rule);
}

function remove(ruleId) {
  const id = Number(ruleId);
  const existing = state.all.get(id);
  if (!existing) return;
  state.all.delete(id);
  const sym = extractSymbol(existing.rule_json);
  if (sym) {
    const bucket = state.bySymbol.get(sym) || [];
    const next = bucket.filter(r => Number(r.id) !== id);
    if (next.length === 0) state.bySymbol.delete(sym);
    else state.bySymbol.set(sym, next);
  } else {
    state.wildcard = state.wildcard.filter(r => Number(r.id) !== id);
  }
}

function candidates(signal) {
  const sym = signal.symbol ? String(signal.symbol).toUpperCase() : null;
  const direct = sym ? (state.bySymbol.get(sym) || []) : [];
  // Small-enough union — O(direct + wildcard). Dedupe by id not needed
  // because a single rule lives in exactly one bucket.
  return direct.concat(state.wildcard);
}

function stats() {
  return {
    total: state.all.size,
    symbolKeyed: state.bySymbol.size,
    wildcard: state.wildcard.length,
    lastLoadedAt: state.lastLoadedAt,
  };
}

module.exports = { load, upsert, remove, candidates, stats };
