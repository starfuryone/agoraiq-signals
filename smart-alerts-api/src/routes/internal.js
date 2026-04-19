"use strict";

const { Router } = require("express");
const { requireSignalHmac } = require("../middleware/hmac");
const { dispatch } = require("../queue/dispatcher");
const ruleIndex = require("../engine/ruleIndex");
const db = require("../lib/db");
const log = require("../lib/logger");

const router = Router();

// ── Signal ingestion ──────────────────────────────────────────────
//
// The route mounts its own raw body parser so HMAC can be verified
// over the exact bytes the main app signed. JSON is parsed manually
// AFTER signature verification.
router.post(
  "/signals",
  (req, res, next) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      req.rawBody = Buffer.concat(chunks);
      next();
    });
    req.on("error", (e) => next(e));
  },
  requireSignalHmac,
  async (req, res) => {
    let body;
    try {
      body = req.rawBody.length ? JSON.parse(req.rawBody.toString("utf8")) : {};
    } catch {
      return res.status(400).json({ error: "invalid_json" });
    }
    // Allow either a single signal object or a batch: { signals: [...] }
    const batch = Array.isArray(body) ? body
                : Array.isArray(body.signals) ? body.signals
                : [body];

    // Dispatch in parallel but bounded.
    const results = [];
    const CHUNK = 16;
    for (let i = 0; i < batch.length; i += CHUNK) {
      const slice = batch.slice(i, i + CHUNK);
      results.push(...await Promise.all(slice.map(dispatch)));
    }
    res.json({ ok: true, count: batch.length, results });
  }
);

// ── Health ────────────────────────────────────────────────────────
router.get("/health", async (req, res) => {
  const out = {
    service: "agoraiq-smart-alerts",
    version: "1.0.0",
    status: "ok",
    uptime: process.uptime(),
    rule_index: ruleIndex.stats(),
    db: "unknown",
  };
  try { await db.query("SELECT 1"); out.db = "ok"; }
  catch (e) { out.db = "error"; out.status = "degraded"; out.db_error = e.message; }
  res.status(out.status === "ok" ? 200 : 503).json(out);
});

// ── Rule index reload (internal ops, HMAC-gated) ──────────────────
router.post(
  "/rule-index/reload",
  (req, res, next) => {
    let chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { req.rawBody = Buffer.concat(chunks); next(); });
    req.on("error", next);
  },
  requireSignalHmac,
  async (req, res) => {
    try {
      await ruleIndex.load();
      res.json({ ok: true, stats: ruleIndex.stats() });
    } catch (e) {
      log.error("[reload]", e.message);
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
