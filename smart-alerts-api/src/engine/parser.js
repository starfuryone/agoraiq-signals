"use strict";

/**
 * Plain-English → DSL parser.
 *
 * Strategy: deterministic regex rules, each emitting one condition and
 * contributing to a confidence score. If the aggregate confidence is
 * below the threshold (0.5) the caller may fall back to the LLM path.
 *
 * Returns:
 *   {
 *     rule: { logic, conditions: [...] },
 *     confidence: 0..1,
 *     source: "regex" | "fallback",
 *     tokensMatched: [...],
 *   }
 */

const { normalizeSymbol } = require("./dsl");

const DIRECTION_WORDS = {
  long:  ["long", "longs", "buy", "buys", "bullish", "up"],
  short: ["short", "shorts", "sell", "sells", "bearish", "down"],
};

const PROVIDER_WORDS = /\b(?:from|by|provider)\s+([a-z0-9_\-]+)/i;
const TIMEFRAME_RE = /\b(?:on\s+)?(1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w)\b/i;
const SIGNAL_TYPE_RE = /\b(scalp|swing|position|breakout|pullback|continuation|reversal)\b/i;
const ENTRY_TYPE_RE = /\b(market|limit|stop-limit|stop)\b/i;

const SYMBOL_RE = /\b(?:for\s+|on\s+|symbol\s+)?([A-Z]{2,10})(?:\s*(?:\/|-)?\s*(USDT|USD|BUSD|FDUSD))?\b/;

function parse(text) {
  const t = String(text || "").trim();
  if (!t) {
    return fallback("empty input");
  }

  const conditions = [];
  const tokens = [];
  let score = 0;
  let weights = 0;

  // AI score / confidence numeric thresholds
  //  "ai score above 80", "confidence >= 70", "score over 85"
  const aiRe = /\b(?:ai[\s-]?score|score|confidence)\s*(?:is\s+)?(?:>=|<=|>|<|above|over|under|below|at\s+least|at\s+most|equal\s+to|=)?\s*(\d{1,3})\b/i;
  const aim = t.match(aiRe);
  if (aim) {
    const word = aim[0].toLowerCase();
    const n = Math.min(parseInt(aim[1], 10), 100);
    const field = /confidence/.test(word) ? "confidence" : "ai_score";
    let op = "gte";
    if (/\b(<=|at\s+most|under|below)\b/.test(word) || /<=/.test(word) || /</.test(word)) op = "lte";
    else if (/\b(<)\b/.test(word)) op = "lt";
    else if (/\b(>)\b/.test(word)) op = "gt";
    else if (/\b(=|equal)\b/.test(word)) op = "eq";
    conditions.push({ field, operator: op, value: n });
    tokens.push(aim[0]);
    score += 1.0; weights += 1;
  }

  // Risk/reward
  //  "rr above 2", "risk reward >= 3", "r:r > 2.5"
  const rrRe = /\b(?:r\s*[:/]\s*r|rr|risk[\s-]?reward)\s*(?:is\s+)?(?:>=|>|<=|<|above|over|under|below|at\s+least|at\s+most|=)?\s*(\d+(?:\.\d+)?)\b/i;
  const rrm = t.match(rrRe);
  if (rrm) {
    const n = parseFloat(rrm[1]);
    let op = "gte";
    if (/<=|at\s+most|under|below|</.test(rrm[0])) op = "lte";
    else if (/>/.test(rrm[0]) && !/>=/.test(rrm[0])) op = "gt";
    conditions.push({ field: "risk_reward", operator: op, value: n });
    tokens.push(rrm[0]);
    score += 0.9; weights += 1;
  }

  // Direction
  for (const [dir, words] of Object.entries(DIRECTION_WORDS)) {
    const re = new RegExp(`\\b(?:only\\s+)?(?:${words.join("|")})\\b`, "i");
    if (re.test(t)) {
      conditions.push({ field: "direction", operator: "eq", value: dir });
      tokens.push(dir);
      score += 0.8; weights += 1;
      break;
    }
  }

  // Provider
  const pm = t.match(PROVIDER_WORDS);
  if (pm) {
    conditions.push({ field: "provider", operator: "eq", value: pm[1].toLowerCase() });
    tokens.push(pm[0]);
    score += 0.6; weights += 1;
  }

  // Timeframe
  const tm = t.match(TIMEFRAME_RE);
  if (tm) {
    conditions.push({ field: "timeframe", operator: "eq", value: tm[1].toLowerCase() });
    tokens.push(tm[1]);
    score += 0.7; weights += 1;
  }

  // Signal type
  const stm = t.match(SIGNAL_TYPE_RE);
  if (stm) {
    conditions.push({ field: "signal_type", operator: "eq", value: stm[1].toLowerCase() });
    tokens.push(stm[1]);
    score += 0.6; weights += 1;
  }

  // Entry type
  const etm = t.match(ENTRY_TYPE_RE);
  if (etm) {
    conditions.push({ field: "entry_type", operator: "eq", value: etm[1].toLowerCase() });
    tokens.push(etm[1]);
    score += 0.5; weights += 1;
  }

  // Trending
  if (/\btrending\b/i.test(t)) {
    conditions.push({ field: "trending", operator: "eq", value: true });
    tokens.push("trending");
    score += 0.6; weights += 1;
  }

  // Leverage max
  //  "leverage up to 10", "max leverage 5", "leverage <= 20"
  const levRe = /\b(?:max\s+)?leverage\s*(?:up\s+to|<=|<|=|at\s+most)?\s*(\d{1,3})x?\b/i;
  const levm = t.match(levRe);
  if (levm) {
    conditions.push({ field: "leverage_max", operator: "lte", value: parseInt(levm[1], 10) });
    tokens.push(levm[0]);
    score += 0.5; weights += 1;
  }

  // Symbol (last, so we don't eat timeframe tokens first)
  //  excludes words already matched
  const upper = t.toUpperCase();
  const sm = upper.match(/\b([A-Z]{2,10})(?:\s*\/\s*(USDT|USD|BUSD|FDUSD))?\b/);
  if (sm && !isCommonWord(sm[1])) {
    const raw = sm[2] ? `${sm[1]}${sm[2]}` : sm[1];
    conditions.push({ field: "symbol", operator: "eq", value: normalizeSymbol(raw) });
    tokens.push(sm[0]);
    score += 0.9; weights += 1;
  }

  if (conditions.length === 0) {
    return fallback("no matching tokens");
  }

  // Normalize confidence to 0..1. Weights upper-bounded at 6.
  const confidence = Math.max(0.1, Math.min(1.0, score / Math.max(weights, 1) * (Math.min(weights, 6) / 6 + 0.3)));

  return {
    rule: { logic: "AND", conditions },
    confidence: Number(confidence.toFixed(3)),
    source: "regex",
    tokensMatched: tokens,
  };
}

const COMMON = new Set([
  "LONG","SHORT","BUY","SELL","AI","SCORE","RR","RISK","REWARD","ABOVE","BELOW",
  "OVER","UNDER","AT","LEAST","MOST","ONLY","SYMBOL","FROM","PROVIDER","LEVERAGE",
  "UP","TO","MAX","CONFIDENCE","TRENDING","AND","OR","ON","FOR","THE","WITH",
  "SCALP","SWING","POSITION","BREAKOUT","PULLBACK","CONTINUATION","REVERSAL",
  "MARKET","LIMIT","STOP","BULLISH","BEARISH","EQUAL","IS",
]);
function isCommonWord(w) { return COMMON.has(w); }

function fallback(reason) {
  // Fallback = "high confidence only" default safety net.
  return {
    rule: {
      logic: "AND",
      conditions: [
        { field: "ai_score", operator: "gte", value: 85 },
      ],
    },
    confidence: 0.2,
    source: "fallback",
    reason,
    tokensMatched: [],
  };
}

module.exports = { parse };
