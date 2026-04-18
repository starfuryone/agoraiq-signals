"use strict";

/**
 * LLM fallback for rule parsing.
 *
 * Only called when regex confidence < 0.5 AND LLM_ENABLED=true.
 * Uses the same HuggingFace Inference API pattern used by the main
 * agoraiq-signals-api. The call is isolated — no shared HF client is
 * imported from the main app; this is a local fetch.
 *
 * The LLM is constrained to emit strict JSON that matches the DSL.
 * Any non-JSON or schema-invalid response is discarded and the caller
 * falls back to the regex output.
 */

const fetch = require("node-fetch");
const log = require("../lib/logger");
const { validate, normalize } = require("./dsl");

const ENABLED = String(process.env.LLM_ENABLED || "false").toLowerCase() === "true";
const HF_KEY = process.env.HF_API_KEY || "";
const HF_BASE = (process.env.HF_BASE_URL || "https://api-inference.huggingface.co").replace(/\/$/, "");
const HF_MODEL = process.env.HF_MODEL || "mistralai/Mistral-7B-Instruct-v0.3";

function isEnabled() {
  return ENABLED && !!HF_KEY;
}

const SYSTEM_PROMPT = `You convert a trader's plain-English alert filter into
a strict JSON rule. Respond with ONLY a JSON object, no prose, no backticks.

Schema:
{
  "logic": "AND" | "OR",
  "conditions": [
    { "field": "<field>", "operator": "<op>", "value": <value> }
  ]
}

Fields and types:
  symbol        string  ops: eq,neq,in,nin,contains,startswith
  ai_score      number  ops: eq,neq,gt,gte,lt,lte,between
  confidence    number  ops: same as ai_score
  direction     "long"|"short"  ops: eq,neq,in,nin
  risk_reward   number  ops: same as ai_score
  provider      string  ops: eq,neq,in,nin,contains
  timeframe     string  ops: eq,neq,in,nin
  entry_type    string  ops: eq,neq,in,nin
  trending      boolean ops: eq,neq
  signal_type   string  ops: eq,neq,in,nin
  leverage_max  number  ops: eq,neq,gt,gte,lt,lte

If the request is ambiguous, return { "logic": "AND",
"conditions": [ { "field": "ai_score", "operator": "gte", "value": 85 } ] }.`;

async function parseWithLLM(text) {
  if (!isEnabled()) return null;
  const prompt = `<s>[INST] ${SYSTEM_PROMPT}\n\nUser filter: """${text}"""\n\nJSON: [/INST]`;
  try {
    const res = await fetch(`${HF_BASE}/models/${HF_MODEL}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${HF_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { max_new_tokens: 300, temperature: 0.1, return_full_text: false },
      }),
      timeout: 10000,
    });
    if (!res.ok) {
      log.warn(`[llm] ${res.status} ${res.statusText}`);
      return null;
    }
    const body = await res.json();
    const raw = Array.isArray(body) ? (body[0]?.generated_text || "") : (body.generated_text || "");
    const json = extractJson(raw);
    if (!json) return null;
    const v = validate(json);
    if (!v.ok) {
      log.warn("[llm] rejected:", v.error);
      return null;
    }
    return {
      rule: normalize(json),
      confidence: 0.8,
      source: "llm",
      tokensMatched: [],
    };
  } catch (e) {
    log.warn("[llm] error:", e.message);
    return null;
  }
}

function extractJson(s) {
  if (!s) return null;
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

module.exports = { parseWithLLM, isEnabled };
