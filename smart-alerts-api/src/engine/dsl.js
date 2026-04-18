"use strict";

/**
 * DSL shape
 * ─────────
 * {
 *   "logic": "AND" | "OR",
 *   "conditions": [
 *     { "field": "<field>", "operator": "<op>", "value": <any> }
 *   ]
 * }
 *
 * Supported fields map to the signal envelope posted by the main app.
 * Unknown fields are rejected by validate(); unknown operators for a
 * given field type are rejected too.
 */

const FIELD_TYPES = {
  symbol:       "string",
  ai_score:     "number",
  confidence:   "number",
  direction:    "enum:long,short",
  risk_reward:  "number",
  provider:     "string",
  timeframe:    "string",
  entry_type:   "string",
  trending:     "boolean",
  signal_type:  "string",
  leverage_max: "number",
};

const NUMERIC_OPS = new Set(["eq", "neq", "gt", "gte", "lt", "lte", "between"]);
const STRING_OPS  = new Set(["eq", "neq", "in", "nin", "contains", "startswith"]);
const BOOL_OPS    = new Set(["eq", "neq"]);

function opsForType(t) {
  if (t === "number") return NUMERIC_OPS;
  if (t === "boolean") return BOOL_OPS;
  if (t.startsWith("enum:")) return new Set(["eq", "neq", "in", "nin"]);
  return STRING_OPS;
}

function validate(rule) {
  if (!rule || typeof rule !== "object") {
    return { ok: false, error: "rule must be an object" };
  }
  const logic = (rule.logic || "AND").toUpperCase();
  if (logic !== "AND" && logic !== "OR") {
    return { ok: false, error: "logic must be AND or OR" };
  }
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
    return { ok: false, error: "conditions must be a non-empty array" };
  }

  for (let i = 0; i < rule.conditions.length; i++) {
    const c = rule.conditions[i];
    if (!c || typeof c !== "object") {
      return { ok: false, error: `conditions[${i}] must be an object` };
    }
    const type = FIELD_TYPES[c.field];
    if (!type) return { ok: false, error: `conditions[${i}]: unknown field "${c.field}"` };

    const ops = opsForType(type);
    if (!ops.has(c.operator)) {
      return { ok: false, error: `conditions[${i}]: operator "${c.operator}" not valid for field "${c.field}"` };
    }

    if (c.operator === "between") {
      if (!Array.isArray(c.value) || c.value.length !== 2
          || typeof c.value[0] !== "number" || typeof c.value[1] !== "number") {
        return { ok: false, error: `conditions[${i}]: between requires [min,max] numbers` };
      }
    } else if (c.operator === "in" || c.operator === "nin") {
      if (!Array.isArray(c.value) || c.value.length === 0) {
        return { ok: false, error: `conditions[${i}]: ${c.operator} requires a non-empty array` };
      }
    } else if (type === "number" && typeof c.value !== "number") {
      return { ok: false, error: `conditions[${i}]: value must be a number` };
    } else if (type === "boolean" && typeof c.value !== "boolean") {
      return { ok: false, error: `conditions[${i}]: value must be a boolean` };
    } else if (type.startsWith("enum:")) {
      const allowed = type.slice(5).split(",");
      const v = Array.isArray(c.value) ? c.value : [c.value];
      for (const x of v) {
        if (typeof x !== "string" || !allowed.includes(x.toLowerCase())) {
          return { ok: false, error: `conditions[${i}]: value must be one of ${allowed.join("|")}` };
        }
      }
    }
  }
  return { ok: true };
}

function normalize(rule) {
  return {
    logic: (rule.logic || "AND").toUpperCase(),
    conditions: rule.conditions.map(c => ({
      field: c.field,
      operator: c.operator,
      value: c.field === "symbol" && typeof c.value === "string"
        ? normalizeSymbol(c.value)
        : c.value,
    })),
  };
}

function normalizeSymbol(sym) {
  const s = String(sym).trim().toUpperCase().replace(/[/\-_\s]/g, "");
  if (!s) return s;
  if (s.endsWith("USDT") || s.endsWith("USD") || s.endsWith("BUSD") || s.endsWith("FDUSD")) return s;
  return `${s}USDT`;
}

module.exports = { FIELD_TYPES, validate, normalize, normalizeSymbol };
