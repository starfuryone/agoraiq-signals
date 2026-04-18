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
    `${arrow} *${escape(a.name || "Smart Alert")}*`,
    `Signal ${escape(s.symbol || "?")} · ${escape((s.direction || "").toUpperCase())}`,
  ];
  if (s.ai_score != null)    lines.push(`AI Score: *${s.ai_score}*`);
  if (s.confidence != null)  lines.push(`Confidence: *${s.confidence}*`);
  if (s.risk_reward != null) lines.push(`R/R: *${s.risk_reward}*`);
  if (s.timeframe)           lines.push(`TF: *${escape(s.timeframe)}*`);
  if (s.provider)            lines.push(`Provider: ${escape(s.provider)}`);
  if (s.signal_type)         lines.push(`Type: ${escape(s.signal_type)}`);
  return lines.join("\n");
}

function escape(s) {
  return String(s).replace(/([_*[\]()~`>#+=|{}.!-])/g, "\\$1");
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
