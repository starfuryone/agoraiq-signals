/**
 * HuggingFace AI client — shared brain pattern, standalone instance.
 *
 * Same env naming, model family, scoring taxonomy, request shape
 * as the main AgoraIQ app. Runs against this app's own state.
 *
 * Env vars:
 *   HF_API_KEY, HF_BASE_URL, HF_PROVIDER
 *   HF_SIGNAL_MODEL, HF_REGIME_MODEL, HF_NARRATIVE_MODEL
 *
 * Scoring taxonomy (shared across AgoraIQ products):
 *   ai_confidence_score:  0–100
 *   market_regime:        breakout | trend | chop | mean_reversion
 *   risk_flags:           crowded | thin_liquidity | extreme_funding
 *   narrative_tags:       ETF | listing | whale | macro | hack
 */

const HF_API_KEY = process.env.HF_API_KEY || null;
const HF_BASE_URL = process.env.HF_BASE_URL || "https://router.huggingface.co";
const HF_PROVIDER = process.env.HF_PROVIDER || "hf-inference";

const MODELS = {
  signal: process.env.HF_SIGNAL_MODEL || "mistralai/Mistral-7B-Instruct-v0.3",
  regime: process.env.HF_REGIME_MODEL || "mistralai/Mistral-7B-Instruct-v0.3",
  narrative: process.env.HF_NARRATIVE_MODEL || "mistralai/Mistral-7B-Instruct-v0.3",
};

const REGIMES = ["breakout", "trend", "chop", "mean_reversion"];
const RISK_FLAGS = ["crowded", "thin_liquidity", "extreme_funding"];
const NARRATIVE_TAGS = ["ETF", "listing", "whale", "macro", "hack", "regulation", "partnership", "airdrop"];

// ── Config ────────────────────────────────────────────────────────

const HF_TIMEOUT = parseInt(process.env.HF_TIMEOUT_MS) || 15000;
const HF_RETRIES = parseInt(process.env.HF_RETRIES) || 2;
const HF_RETRY_DELAY = 1000;

// ── HTTP with retry ──────────────────────────────────────────────

async function hfRequest(model, payload, maxTokens = 512) {
  if (!HF_API_KEY) {
    console.warn("[ai] HF_API_KEY not set — returning fallback");
    return null;
  }

  const url = `${HF_BASE_URL}/models/${model}`;
  const body = JSON.stringify({
    inputs: payload,
    parameters: { max_new_tokens: maxTokens, temperature: 0.3 },
  });
  const headers = {
    Authorization: `Bearer ${HF_API_KEY}`,
    "Content-Type": "application/json",
    "X-Provider": HF_PROVIDER,
  };

  for (let attempt = 0; attempt <= HF_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(HF_TIMEOUT),
      });

      // 503 = model loading, retry
      if (res.status === 503 && attempt < HF_RETRIES) {
        console.warn(`[ai] HF 503 (model loading), retry ${attempt + 1}/${HF_RETRIES}`);
        await sleep(HF_RETRY_DELAY * (attempt + 1));
        continue;
      }

      // 429 = rate limited, retry with backoff
      if (res.status === 429 && attempt < HF_RETRIES) {
        const retryAfter = parseInt(res.headers.get("retry-after")) || 2;
        console.warn(`[ai] HF 429 (rate limit), retry after ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        console.error(`[ai] HF ${res.status}: ${text.slice(0, 200)}`);
        return null;
      }

      const data = await res.json();
      if (Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text;
      return data;
    } catch (err) {
      if (err.name === "AbortError" || err.name === "TimeoutError") {
        console.warn(`[ai] HF timeout (${HF_TIMEOUT}ms), attempt ${attempt + 1}`);
        if (attempt < HF_RETRIES) { await sleep(HF_RETRY_DELAY); continue; }
      }
      console.error("[ai] HF request failed:", err.message);
      return null;
    }
  }
  return null;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── Schema validation ────────────────────────────────────────────

function extractJSON(raw) {
  if (typeof raw !== "string") return null;
  // Find the first { ... } block
  const m = raw.match(/\{[\s\S]*?\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function validateScoreSchema(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const score = parseInt(parsed.score);
  if (isNaN(score)) return null;

  return {
    score: clamp(score),
    regime: REGIMES.includes(parsed.regime) ? parsed.regime : "chop",
    risk_flags: Array.isArray(parsed.risk_flags)
      ? parsed.risk_flags.filter((f) => typeof f === "string" && RISK_FLAGS.includes(f))
      : [],
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : "",
  };
}

function validateRegimeSchema(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  return {
    regime: REGIMES.includes(parsed.regime) ? parsed.regime : null,
    confidence: typeof parsed.confidence === "number" ? clamp(parsed.confidence) : null,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : "",
  };
}

function validateNarrativeSchema(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  return {
    tags: Array.isArray(parsed.tags)
      ? parsed.tags.filter((t) => typeof t === "string" && NARRATIVE_TAGS.includes(t))
      : [],
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : "",
  };
}

function clamp(n, lo = 0, hi = 100) {
  const v = parseInt(n, 10);
  return isNaN(v) ? 50 : Math.max(lo, Math.min(hi, v));
}

// ── Signal scoring ───────────────────────────────────────────────

async function scoreSignal(d) {
  const prompt = `You are a crypto signal analyst. Score this signal from 0-100.

Signal:
- Symbol: ${d.symbol}
- Direction: ${d.direction}
- Entry: ${d.entry}
- Stop: ${d.stop}
- Targets: ${(d.targets || []).join(", ")}
- Volume change: ${d.volume_change || "N/A"}%
- OI direction: ${d.oi_direction || "N/A"}
- Funding rate: ${d.funding_rate || "N/A"}

Respond ONLY with JSON:
{"score": <0-100>, "regime": "<breakout|trend|chop|mean_reversion>", "risk_flags": [<flags>], "reasoning": "<1 sentence>"}`;

  const raw = await hfRequest(MODELS.signal, prompt);
  if (!raw) return fallbackScore(d);

  const parsed = extractJSON(raw);
  const validated = validateScoreSchema(parsed);
  if (!validated) return fallbackScore(d);

  return {
    ...validated,
    model: MODELS.signal,
    provider: HF_PROVIDER,
  };
}

// ── Market regime ────────────────────────────────────────────────

async function classifyRegime(m) {
  const prompt = `You are a crypto market analyst. Classify the current regime.

Market data for ${m.symbol}:
- 1h change: ${m.price_1h}%
- 4h change: ${m.price_4h}%
- 24h change: ${m.price_24h}%
- Volume change: ${m.volume_change}%
- OI change: ${m.oi_change}%
- Funding rate: ${m.funding_rate}

Respond ONLY with JSON:
{"regime": "<breakout|trend|chop|mean_reversion>", "confidence": <0-100>, "reasoning": "<1 sentence>"}`;

  const raw = await hfRequest(MODELS.regime, prompt);
  if (!raw) return { regime: "chop", confidence: 50, reasoning: "AI unavailable" };

  const parsed = extractJSON(raw);
  const validated = validateRegimeSchema(parsed);
  if (!validated || !validated.regime) return { regime: "chop", confidence: 50, reasoning: "Parse error" };

  return validated;
}

// ── Narrative tagging ────────────────────────────────────────────

async function tagNarrative(ctx) {
  const prompt = `You are a crypto narrative analyst. Tag the dominant narratives.

Context for ${ctx.symbol}:
${ctx.recent_news ? `- News: ${ctx.recent_news}` : "- No recent news available"}
${ctx.social_volume ? `- Social volume: ${ctx.social_volume}` : ""}
${ctx.whale_activity ? `- Whale activity: ${ctx.whale_activity}` : ""}

Available tags: ${NARRATIVE_TAGS.join(", ")}

Respond ONLY with JSON:
{"tags": [<matching tags>], "reasoning": "<1 sentence>"}`;

  const raw = await hfRequest(MODELS.narrative, prompt);
  if (!raw) return { tags: [], reasoning: "AI unavailable" };

  const parsed = extractJSON(raw);
  const validated = validateNarrativeSchema(parsed);
  if (!validated) return { tags: [], reasoning: "Parse error" };

  return validated;
}

// ── Heuristic fallback ───────────────────────────────────────────

function fallbackScore(d) {
  let score = 45;
  const reasons = [];
  const flags = [];

  // R:R ratio scoring
  const entry = parseFloat(d.entry) || 0;
  const stop = parseFloat(d.stop) || 0;
  const tp1 = (d.targets || [])[0] ? parseFloat(d.targets[0]) : 0;
  if (entry && stop && tp1) {
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(tp1 - entry);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr >= 3) { score += 20; reasons.push("excellent R:R " + rr.toFixed(1)); }
    else if (rr >= 2) { score += 15; reasons.push("good R:R " + rr.toFixed(1)); }
    else if (rr >= 1.5) { score += 10; reasons.push("decent R:R " + rr.toFixed(1)); }
    else if (rr >= 1) { score += 5; reasons.push("marginal R:R " + rr.toFixed(1)); }
    else { score -= 5; reasons.push("poor R:R " + rr.toFixed(1)); flags.push("low_rr"); }
  }

  // Multiple TPs = structured trade
  const tpCount = (d.targets || []).length;
  if (tpCount >= 3) { score += 8; reasons.push(tpCount + " targets"); }
  else if (tpCount >= 2) { score += 5; reasons.push(tpCount + " targets"); }
  else if (tpCount === 1) { score += 3; }

  // Has stop loss
  if (d.stop != null) { score += 5; reasons.push("SL defined"); }
  else { score -= 10; flags.push("no_stop_loss"); reasons.push("no SL"); }

  // Leverage risk
  const lev = parseInt(d.leverage) || 0;
  if (lev > 20) { score -= 10; flags.push("extreme_leverage"); reasons.push(lev + "x leverage"); }
  else if (lev > 10) { score -= 5; flags.push("high_leverage"); reasons.push(lev + "x leverage"); }
  else if (lev > 0 && lev <= 5) { score += 3; reasons.push("conservative " + lev + "x"); }

  // Volume / OI / funding (when available from scanner)
  const vol = parseFloat(d.volume_change) || 0;
  if (vol > 100) { score += 10; reasons.push("high volume"); }
  else if (vol > 50) score += 5;

  if (d.oi_direction === "rising" && d.direction === "LONG") { score += 5; reasons.push("OI confirms"); }
  if (d.oi_direction === "falling" && d.direction === "SHORT") { score += 5; reasons.push("OI confirms"); }

  if (Math.abs(parseFloat(d.funding_rate) || 0) > 0.05) score += 3;

  // Regime guess based on signal shape
  let regime = "chop";
  if (tp1 && entry) {
    const pctMove = Math.abs(tp1 - entry) / entry;
    if (pctMove > 0.08) regime = "breakout";
    else if (pctMove > 0.03) regime = "trend";
    else regime = "mean_reversion";
  }

  return {
    score: clamp(score),
    regime,
    risk_flags: flags,
    reasoning: "Heuristic: " + (reasons.length ? reasons.join(", ") : "basic signal"),
    model: "heuristic-v2",
    provider: "local",
  };
}

module.exports = {
  scoreSignal, classifyRegime, tagNarrative, fallbackScore,
  hfRequest, REGIMES, RISK_FLAGS, NARRATIVE_TAGS,
};
