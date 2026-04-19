"use strict";

/**
 * Pure evaluator: given a rule and a normalized signal, decide whether
 * the signal matches. Returns { match, matchedFields } — never throws.
 */

function coerceNumber(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function coerceString(v) {
  if (v == null) return null;
  return String(v);
}

function matchCondition(cond, signal) {
  const raw = signal[cond.field];
  switch (cond.field) {
    case "ai_score":
    case "confidence":
    case "risk_reward":
    case "leverage_max": {
      const a = coerceNumber(raw);
      if (a == null) return false;
      return numOp(a, cond.operator, cond.value);
    }
    case "trending": {
      const a = raw === true || raw === "true" || raw === 1;
      return boolOp(a, cond.operator, cond.value);
    }
    case "direction": {
      const a = coerceString(raw)?.toLowerCase();
      return strOp(a, cond.operator, lowerVal(cond.value));
    }
    case "symbol": {
      const a = coerceString(raw)?.toUpperCase();
      return strOp(a, cond.operator, upperVal(cond.value));
    }
    default: {
      const a = coerceString(raw)?.toLowerCase();
      return strOp(a, cond.operator, lowerVal(cond.value));
    }
  }
}

function lowerVal(v) {
  if (Array.isArray(v)) return v.map(x => String(x).toLowerCase());
  return typeof v === "string" ? v.toLowerCase() : v;
}
function upperVal(v) {
  if (Array.isArray(v)) return v.map(x => String(x).toUpperCase());
  return typeof v === "string" ? v.toUpperCase() : v;
}

function numOp(a, op, b) {
  switch (op) {
    case "eq":  return a === b;
    case "neq": return a !== b;
    case "gt":  return a > b;
    case "gte": return a >= b;
    case "lt":  return a < b;
    case "lte": return a <= b;
    case "between":
      return Array.isArray(b) && a >= b[0] && a <= b[1];
    default: return false;
  }
}

function strOp(a, op, b) {
  if (a == null) return op === "neq";
  switch (op) {
    case "eq":  return a === b;
    case "neq": return a !== b;
    case "in":  return Array.isArray(b) && b.includes(a);
    case "nin": return Array.isArray(b) && !b.includes(a);
    case "contains":   return typeof b === "string" && a.includes(b);
    case "startswith": return typeof b === "string" && a.startsWith(b);
    default: return false;
  }
}

function boolOp(a, op, b) {
  switch (op) {
    case "eq":  return a === b;
    case "neq": return a !== b;
    default: return false;
  }
}

function evaluate(rule, signal) {
  const logic = (rule.logic || "AND").toUpperCase();
  const conditions = rule.conditions || [];
  const matched = [];
  let matches;
  if (logic === "OR") {
    matches = false;
    for (const c of conditions) {
      const ok = matchCondition(c, signal);
      if (ok) { matched.push(c); matches = true; }
    }
  } else {
    matches = true;
    for (const c of conditions) {
      const ok = matchCondition(c, signal);
      if (!ok) { matches = false; }
      else matched.push(c);
    }
  }
  return { match: matches, matchedFields: matched };
}

module.exports = { evaluate, matchCondition };
