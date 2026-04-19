"use strict";

const fetch = require("node-fetch");
const log = require("../lib/logger");

const TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || "";
const TIMEOUT = parseInt(process.env.TELEGRAM_SEND_TIMEOUT_MS || "5000", 10);

function enabled() { return !!TOKEN; }

function format(payload) {
  const s = payload.signal || {};
  const a = payload.alert || {};
  const arrow = s.direction === "short" ? "🔻" : "🟢";
  const lines = [
    `${arrow} *${esc(a.name || "Smart Alert")}*`,
    `Signal ${esc(s.symbol || "?")} · ${esc((s.direction || "").toUpperCase())}`,
  ];
  if (s.ai_score != null)    lines.push(`AI Score: *${esc(s.ai_score)}*`);
  if (s.confidence != null)  lines.push(`Confidence: *${esc(s.confidence)}*`);
  if (s.risk_reward != null) lines.push(`R/R: *${esc(s.risk_reward)}*`);
  if (s.timeframe)           lines.push(`TF: *${esc(s.timeframe)}*`);
  if (s.provider)            lines.push(`Provider: ${esc(s.provider)}`);
  if (s.signal_type)         lines.push(`Type: ${esc(s.signal_type)}`);
  return lines.join("\n");
}

// Escape all MarkdownV2 reserved characters. Telegram rejects messages
// with any unescaped instance of: _ * [ ] ( ) ~ ` > # + - = | { } . !
function esc(v) {
  if (v == null) return "";
  return String(v).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function send(chatId, payload) {
  if (!enabled()) throw new Error("telegram_disabled");
  if (!chatId) throw new Error("missing_chat_id");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: format(payload),
        parse_mode: "MarkdownV2",
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`telegram_${res.status}: ${body.slice(0, 200)}`);
    }
    const body = await res.json();
    if (!body.ok) throw new Error(`telegram_api: ${body.description || "unknown"}`);
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { send, format, enabled };
