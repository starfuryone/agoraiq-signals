const crypto = require("crypto");
const db = require("./db");

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ANTHROPIC_TIMEOUT_MS = 25000;
const MAX_OUTPUT_TOKENS = 280;

const PRICE_INPUT_PER_MTOK = 1.0;
const PRICE_OUTPUT_PER_MTOK = 5.0;

const RATE_BUCKET = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60 * 60 * 1000;

function ipRateLimit(req, res, next) {
  const ip = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const bucket = RATE_BUCKET.get(ip) || [];
  const fresh = bucket.filter((t) => now - t < RATE_WINDOW_MS);
  if (fresh.length >= RATE_LIMIT) {
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }
  fresh.push(now);
  RATE_BUCKET.set(ip, fresh);
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of RATE_BUCKET) {
    const fresh = bucket.filter((t) => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) RATE_BUCKET.delete(ip);
    else RATE_BUCKET.set(ip, fresh);
  }
}, 5 * 60 * 1000).unref();

async function fetchProviderStats(providerId) {
  try {
    const r = await db.query(
      "SELECT p.id, p.name, COALESCE(p.channel,'') AS channel, COALESCE(p.platform,'telegram') AS platform, ps.win_rate, COALESCE(ps.total_signals, ps.trade_count, 0) AS total_signals, COALESCE(ps.avg_rr, ps.expectancy_r) AS avg_rr, ps.profit_factor, ps.expectancy_r, ps.max_drawdown, ps.trust_score FROM providers p LEFT JOIN provider_stats_snapshot ps ON ps.provider_id = p.id WHERE p.id = $1 LIMIT 1",
      [providerId]
    );
    if (r.rows[0]) return r.rows[0];
  } catch (e) {}

  const r = await db.query(
    "SELECT id, name, COALESCE(channel,'') AS channel, COALESCE(platform,'telegram') AS platform FROM providers WHERE id = $1 LIMIT 1",
    [providerId]
  );
  return r.rows[0] || null;
}

function hashStats(stats) {
  const keyed = {
    name: stats.name || "",
    channel: stats.channel || "",
    platform: stats.platform || "",
    win_rate: stats.win_rate == null ? null : Number(stats.win_rate),
    total_signals: stats.total_signals == null ? 0 : Number(stats.total_signals),
    avg_rr: stats.avg_rr == null ? null : Number(stats.avg_rr),
    profit_factor: stats.profit_factor == null ? null : Number(stats.profit_factor),
    expectancy_r: stats.expectancy_r == null ? null : Number(stats.expectancy_r),
    max_drawdown: stats.max_drawdown == null ? null : Number(stats.max_drawdown),
    trust_score: stats.trust_score == null ? null : Number(stats.trust_score),
  };
  return crypto.createHash("sha256").update(JSON.stringify(keyed)).digest("hex").slice(0, 32);
}

const SYSTEM_PROMPT = "You are AgoraIQ's provider analyst. AgoraIQ is a crypto signal verification platform that tracks signal providers and ranks them by real measured performance.\n\nYour job: in 2-4 sentences, describe what stands out about a given provider's edge based on the data provided. Be specific, factual, and avoid hype.\n\nSTRICT RULES:\n- 2-4 sentences MAXIMUM\n- No emojis, no markdown, no headings\n- No price predictions, no recommendations to buy/sell\n- If data is sparse (null win rate, zero signals), describe what the channel/platform tells us about the provider's apparent focus, and note that performance tracking is still building\n- Never invent statistics. If a number isn't in the data, don't make one up.\n- Plain prose, complete sentences";

function buildUserPrompt(stats) {
  const rows = [];
  rows.push("Provider: " + stats.name);
  if (stats.channel) rows.push("Channel/focus label: " + stats.channel);
  rows.push("Platform: " + stats.platform);
  if (stats.total_signals != null) rows.push("Tracked signals: " + stats.total_signals);
  if (stats.win_rate != null) {
    const wr = Number(stats.win_rate);
    rows.push("Win rate: " + (wr > 1 ? wr.toFixed(1) : (wr * 100).toFixed(1)) + "%");
  }
  if (stats.avg_rr != null) rows.push("Avg R:R: " + Number(stats.avg_rr).toFixed(2));
  if (stats.expectancy_r != null) rows.push("Expectancy (R): " + Number(stats.expectancy_r).toFixed(2));
  if (stats.profit_factor != null) rows.push("Profit factor: " + Number(stats.profit_factor).toFixed(2));
  if (stats.max_drawdown != null) rows.push("Max drawdown: " + Number(stats.max_drawdown).toFixed(2));
  if (stats.trust_score != null) rows.push("Trust score: " + Number(stats.trust_score).toFixed(2));
  return rows.join("\n") + "\n\nGive a 2-4 sentence analytical read on this provider's apparent edge or focus. Output prose only - no preamble, no labels.";
}

async function callAnthropic(stats) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    const err = new Error("ANTHROPIC_API_KEY not set");
    err.code = "no_api_key";
    throw err;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserPrompt(stats) }],
      }),
    });
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    const err = new Error("Anthropic " + resp.status + ": " + body.slice(0, 200));
    err.code = "anthropic_error";
    throw err;
  }

  const data = await resp.json();
  const text = ((data.content && data.content[0] && data.content[0].text) || "").trim();
  if (!text) throw new Error("Anthropic returned empty text");

  const usage = data.usage || {};
  const inTok = Number(usage.input_tokens || 0);
  const outTok = Number(usage.output_tokens || 0);
  const cost = (inTok / 1e6) * PRICE_INPUT_PER_MTOK + (outTok / 1e6) * PRICE_OUTPUT_PER_MTOK;

  return {
    text: text,
    model: data.model || MODEL,
    inputTokens: inTok,
    outputTokens: outTok,
    costUsd: Number(cost.toFixed(6)),
  };
}

async function getOrGenerate(providerId) {
  const stats = await fetchProviderStats(providerId);
  if (!stats) {
    const err = new Error("Provider not found");
    err.code = "not_found";
    throw err;
  }

  const statsHash = hashStats(stats);

  let cacheRow = null;
  try {
    const r = await db.query(
      "SELECT response_text, model, generated_at, stats_hash FROM provider_iq_cache WHERE provider_id = $1",
      [providerId]
    );
    cacheRow = r.rows[0] || null;
  } catch (e) {
    console.error("[provider_iq] cache lookup failed:", e.message);
  }

  if (cacheRow) {
    const ageMs = Date.now() - new Date(cacheRow.generated_at).getTime();
    const sameHash = cacheRow.stats_hash === statsHash;
    if (sameHash && ageMs < CACHE_TTL_MS) {
      return {
        text: cacheRow.response_text,
        cached: true,
        generatedAt: cacheRow.generated_at,
        model: cacheRow.model,
      };
    }
  }

  let result;
  try {
    result = await callAnthropic(stats);
  } catch (err) {
    if (cacheRow) {
      console.warn("[provider_iq] anthropic failed, returning stale cache:", err.message);
      return {
        text: cacheRow.response_text,
        cached: true,
        stale: true,
        generatedAt: cacheRow.generated_at,
        model: cacheRow.model,
      };
    }
    throw err;
  }

  try {
    await db.query(
      "INSERT INTO provider_iq_cache (provider_id, stats_hash, response_text, model, generated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (provider_id) DO UPDATE SET stats_hash = EXCLUDED.stats_hash, response_text = EXCLUDED.response_text, model = EXCLUDED.model, generated_at = EXCLUDED.generated_at",
      [providerId, statsHash, result.text, result.model]
    );
  } catch (e) {
    console.error("[provider_iq] cache write failed:", e.message);
  }

  try {
    await db.query(
      "INSERT INTO provider_iq_responses (provider_id, stats_hash, stats_snapshot, response_text, model, input_tokens, output_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [providerId, statsHash, JSON.stringify(stats), result.text, result.model, result.inputTokens, result.outputTokens, result.costUsd]
    );
  } catch (e) {
    console.error("[provider_iq] audit write failed:", e.message);
  }

  return {
    text: result.text,
    cached: false,
    generatedAt: new Date().toISOString(),
    model: result.model,
  };
}

module.exports = { getOrGenerate, ipRateLimit };
