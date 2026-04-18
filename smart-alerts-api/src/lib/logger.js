"use strict";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const THRESHOLD = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] || 20;

function emit(level, args) {
  if ((LEVELS[level] || 20) < THRESHOLD) return;
  const ts = new Date().toISOString();
  const line = args
    .map(a => (typeof a === "string" ? a : safeStringify(a)))
    .join(" ");
  (level === "error" ? console.error : console.log)(`${ts} [${level}] ${line}`);
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

module.exports = {
  debug: (...a) => emit("debug", a),
  info:  (...a) => emit("info", a),
  warn:  (...a) => emit("warn", a),
  error: (...a) => emit("error", a),
};
