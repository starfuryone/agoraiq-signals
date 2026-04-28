// /opt/agoraiq-signals/api/src/lib/ai-haiku.js
//
// Anthropic Claude Haiku — narration provider for AgoraIQ signals.
//
// CACHING ARCHITECTURE
//   Layer 1: DB row (meta.ai_thesis)        — primary, persistent, cross-cluster
//   Layer 2: In-memory LRU (this file)      — per-worker hot cache, this layer
//   Layer 3: Redis (not implemented)        — would share across cluster, n/a today
//
//   Cache key = sha256(prompt) — any change in input or heuristic score
//   produces a different prompt and a different key, so stale entries are
//   impossible by construction.
//
// PRIMARY function: narrateWithHaiku(input, heuristic)
//   Heuristic computes the score; Haiku writes a thesis that justifies it.
//   Returns: { thesis, model, provider, latency_ms, cost_usd } or null.
//
// LEGACY function: scoreWithHaiku(input)  — full standalone scoring, kept for compat.
//
// Diagnostic: cacheStats() — returns { size, hits, misses, hit_rate, budget_used_usd }
//
// Env required: ANTHROPIC_API_KEY
// Env optional: ANTHROPIC_HAIKU_MODEL, HAIKU_DAILY_BUDGET_USD, HAIKU_TIMEOUT_MS,
//               HAIKU_CACHE_TTL_DAYS (default 7), HAIKU_CACHE_MAX (default 5000)

"use strict";

const path   = require("path");
const crypto = require("crypto");

require("dotenv").config({
  path: path.join(__dirname, "../../.env"),
  override: true,
});

const HAIKU_MODEL = process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001";
const API_URL    = "https://api.anthropic.com/v1/messages";
const TIMEOUT_MS = parseInt(process.env.HAIKU_TIMEOUT_MS || "8000", 10);
const MAX_OUTPUT_TOKENS = 220;

const PRICE_INPUT  = 1.0  / 1_000_000;
const PRICE_OUTPUT = 5.0  / 1_000_000;

const DAILY_BUDGET_USD = parseFloat(process.env.HAIKU_DAILY_BUDGET_USD || "5.00");

const CACHE_TTL_MS = parseInt(process.env.HAIKU_CACHE_TTL_DAYS || "7", 10) * 86400 * 1000;
const CACHE_MAX    = parseInt(process.env.HAIKU_CACHE_MAX || "5000", 10);

// ── Daily budget tracker ──
let _budgetUsd  = 0;
let _budgetDate = new Date().toISOString().slice(0, 10);

function checkBudget() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _budgetDate) { _budgetUsd = 0; _budgetDate = today; }
  return _budgetUsd < DAILY_BUDGET_USD;
}

function estimateCost(inTok, outTok) {
  return (inTok || 0) * PRICE_INPUT + (outTok || 0) * PRICE_OUTPUT;
}

// ════════════════════════════════════════════════════════════════
// In-memory LRU cache
//   - Map preserves insertion order, so re-inserting on read = LRU bump
//   - TTL checked on read, evicted opportunistically
//   - Max size enforced on write, oldest evicted first
// ════════════════════════════════════════════════════════════════

const _cache = new Map();
let _cacheHits   = 0;
let _cacheMisses = 0;

function cacheKey(prompt) {
  return crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 32);
}

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(key);
    return null;
  }
  // LRU bump: re-insert moves to most-recent
  _cache.delete(key);
  _cache.set(key, entry);
  return entry.value;
}

function cacheSet(key, value) {
  if (_cache.size >= CACHE_MAX) {
    // Evict oldest (first key in iteration order)
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function cacheStats() {
  const total = _cacheHits + _cacheMisses;
  return {
    size:           _cache.size,
    max:            CACHE_MAX,
    ttl_days:       CACHE_TTL_MS / 86400 / 1000,
    hits:           _cacheHits,
    misses:         _cacheMisses,
    hit_rate:       total > 0 ? +(_cacheHits / total).toFixed(3) : null,
    budget_used:    +_budgetUsd.toFixed(4),
    budget_max:     DAILY_BUDGET_USD,
  };
}

// ── HTTP call with timeout + 1 retry on 429/5xx ──
async function callHaiku(prompt, retries = 1) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const ctl   = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json",
      },
      body: JSON.stringify({
        model:      HAIKU_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages:   [{ role: "user", content: prompt }],
      }),
      signal: ctl.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      if ((res.status === 429 || res.status >= 500) && retries > 0) {
        await new Promise(r => setTimeout(r, 1000));
        return callHaiku(prompt, retries - 1);
      }
      const body = await res.text().catch(() => "");
      throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
    }

    const data  = await res.json();
    const text  = data?.content?.[0]?.text || "";
    const usage = data?.usage || {};
    return {
      text,
      inputTokens:  usage.input_tokens  || 0,
      outputTokens: usage.output_tokens || 0,
    };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") throw new Error(`Haiku timeout after ${TIMEOUT_MS}ms`);
    throw err;
  }
}

function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// ════════════════════════════════════════════════════════════════
// PRIMARY: narrateWithHaiku
// ════════════════════════════════════════════════════════════════

function buildNarrationPrompt(input, heuristic) {
  const tStr = (Array.isArray(input.targets) && input.targets.length)
    ? input.targets.join(", ") : "none";

  const e = parseFloat(input.entry) || 0;
  const s = parseFloat(input.stop) || 0;
  const t1 = (input.targets && input.targets[0]) ? parseFloat(input.targets[0]) : 0;
  let rr = null, riskPct = null, rewardPct = null;
  if (e > 0) {
    if (s > 0) riskPct = ((Math.abs(e - s) / e) * 100).toFixed(2);
    if (t1 > 0) rewardPct = ((Math.abs(t1 - e) / e) * 100).toFixed(2);
    if (s > 0 && t1 > 0) {
      const risk = Math.abs(e - s);
      if (risk > 0) rr = (Math.abs(t1 - e) / risk).toFixed(2);
    }
  }

  const score = heuristic.score;
  const confLabel = score >= 80 ? "strong" : score >= 65 ? "good" : score >= 50 ? "speculative" : "weak";
  const bd = heuristic.score_breakdown || {};
  const tags = (heuristic.tags || []).join(", ") || "none";

  return [
    `You are explaining a crypto trading signal that has been scored ${score}/100 by a quantitative model.`,
    `Confidence level: ${confLabel}.`,
    "",
    "Trade context:",
    `- Symbol: ${input.symbol}`,
    `- Direction: ${input.direction}`,
    `- Entry: ${input.entry ?? "n/a"}`,
    s > 0 ? `- Stop: ${input.stop} (risk: ${riskPct}%)` : "- Stop: none (no stop loss defined)",
    `- Targets: ${tStr}` + (rewardPct ? ` (TP1 reward: ${rewardPct}%)` : ""),
    rr ? `- Risk/Reward ratio: ${rr}` : null,
    `- Volume change (24h): ${input.volume_change != null ? input.volume_change + "%" : "n/a"}`,
    `- Number of targets: ${(input.targets || []).length}`,
    `- Tags: ${tags}`,
    "",
    `Sub-scores: breakout=${bd.breakout ?? "-"}, volume=${bd.volume ?? "-"}, regime=${bd.regime ?? "-"}, provider=${bd.provider ?? "-"}, risk_penalty=${bd.risk_penalty ?? 0}`,
    "",
    `Write a 20-40 word thesis explaining WHY this earned ${score}/100. Reference specific numbers (R:R, volume %, target count, stop level). Match the ${confLabel} confidence in tone. No fluff, no disclaimers, no hedging like "however" or "but".`,
    "",
    'Output STRICT JSON only: {"thesis": "<text>"}'
  ].filter(Boolean).join("\n");
}

async function narrateWithHaiku(input, heuristic) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!heuristic || typeof heuristic.score !== "number") {
    console.warn(`[ai-haiku] narrateWithHaiku called without heuristic — refusing`);
    return null;
  }

  const prompt = buildNarrationPrompt(input, heuristic);
  const key    = cacheKey(prompt);

  // ── Cache layer 2: in-memory LRU ──
  const hit = cacheGet(key);
  if (hit) {
    _cacheHits++;
    return {
      ...hit,
      latency_ms: 0,
      cost_usd:   0,
      provider:   "anthropic-haiku-narration-cached",
    };
  }
  _cacheMisses++;

  // Budget check applies only on cache miss (cached entries are free)
  if (!checkBudget()) {
    console.warn(`[ai-haiku] daily budget $${DAILY_BUDGET_USD} reached (used $${_budgetUsd.toFixed(4)}), skipping`);
    return null;
  }

  const start = Date.now();

  try {
    const { text, inputTokens, outputTokens } = await callHaiku(prompt, 1);
    let parsed = parseJson(text);

    if (!parsed || typeof parsed.thesis !== "string" || parsed.thesis.trim().length < 10) {
      const fix = [
        "Your previous output was not valid JSON or thesis was too short.",
        'Output ONLY this JSON, nothing else: {"thesis": "<20-40 word explanation>"}',
        "",
        "Previous output:",
        text.slice(0, 500),
      ].join("\n");
      const retry = await callHaiku(fix, 0);
      parsed = parseJson(retry.text);
      if (!parsed || typeof parsed.thesis !== "string" || parsed.thesis.trim().length < 10) {
        console.warn(`[ai-haiku] narration parse failed for ${input.symbol}`);
        return null;
      }
    }

    const cost = estimateCost(inputTokens, outputTokens);
    _budgetUsd += cost;

    const result = {
      thesis:     parsed.thesis.trim().slice(0, 400),
      model:      HAIKU_MODEL,
      provider:   "anthropic-haiku-narration",
      latency_ms: Date.now() - start,
      cost_usd:   cost,
    };

    cacheSet(key, result);
    return result;
  } catch (err) {
    console.warn(`[ai-haiku] narrate ${input.symbol || "?"}: ${err.message}`);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// LEGACY: scoreWithHaiku — full standalone scoring, kept for compat
// ════════════════════════════════════════════════════════════════

function buildScoringPrompt(input) {
  const tStr = (Array.isArray(input.targets) && input.targets.length)
    ? input.targets.join(", ") : "none";
  return [
    "You are AgoraIQ's quantitative signal analyst. Score this crypto signal 0-100 and write a 1-2 sentence thesis.",
    "",
    `Symbol: ${input.symbol}`,
    `Direction: ${input.direction}`,
    `Entry: ${input.entry ?? "n/a"}`,
    `Stop: ${input.stop ?? "none"}`,
    `Targets: ${tStr}`,
    `Volume change: ${input.volume_change ?? "n/a"}`,
    `OI direction: ${input.oi_direction ?? "n/a"}`,
    `Funding rate: ${input.funding_rate ?? "n/a"}`,
    "",
    "Score factors: risk/reward ratio, target count, volume confirmation, stop discipline.",
    "Thesis: 20-40 words, concrete, no fluff.",
    "",
    "Output STRICT JSON only:",
    '{"score": <0-100>, "thesis": "<text>", "regime": "<breakout|trend|chop|mean_reversion>", "risk_flags": [<from: crowded, thin_liquidity, extreme_funding, no_stop_loss, extreme_leverage, low_rr, high_leverage>]}'
  ].join("\n");
}

function sanitizeFullScore(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const score  = Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 0)));
  const thesis = typeof parsed.thesis === "string" ? parsed.thesis.trim().slice(0, 400) : "";
  const regime = typeof parsed.regime === "string" ? parsed.regime.trim().slice(0, 32) : null;
  const risk_flags = Array.isArray(parsed.risk_flags)
    ? parsed.risk_flags.filter(f => typeof f === "string").map(f => f.trim().toLowerCase().replace(/[\s-]+/g, "_")).slice(0, 6)
    : [];
  if (!score || !thesis) return null;
  return { score, thesis, regime, risk_flags };
}

async function scoreWithHaiku(input) {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const prompt = buildScoringPrompt(input);
  const key    = cacheKey(prompt);

  const hit = cacheGet(key);
  if (hit) {
    _cacheHits++;
    return { ...hit, latency_ms: 0, cost_usd: 0, provider: hit.provider + "-cached" };
  }
  _cacheMisses++;

  if (!checkBudget()) return null;

  const start = Date.now();
  try {
    const { text, inputTokens, outputTokens } = await callHaiku(prompt, 1);
    let result = sanitizeFullScore(parseJson(text));

    if (!result) {
      const fix = [
        'Output ONLY this JSON: {"score": <0-100>, "thesis": "<text>", "regime": "<breakout|trend|chop|mean_reversion>", "risk_flags": []}',
        "Previous output:",
        text.slice(0, 500),
      ].join("\n");
      const retry = await callHaiku(fix, 0);
      result = sanitizeFullScore(parseJson(retry.text));
      if (!result) return null;
    }

    const cost = estimateCost(inputTokens, outputTokens);
    _budgetUsd += cost;

    const out = {
      score: result.score, thesis: result.thesis, regime: result.regime, risk_flags: result.risk_flags,
      reasoning: result.thesis, model: HAIKU_MODEL, provider: "anthropic-haiku",
      latency_ms: Date.now() - start, cost_usd: cost, tags: [], score_breakdown: null,
    };

    cacheSet(key, out);
    return out;
  } catch (err) {
    console.warn(`[ai-haiku] score ${input.symbol || "?"}: ${err.message}`);
    return null;
  }
}

module.exports = { narrateWithHaiku, scoreWithHaiku, cacheStats };
