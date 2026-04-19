#!/usr/bin/env node
"use strict";

require("dotenv").config({ override: true });

const express = require("express");
const cors = require("cors");
const db = require("./lib/db");
const log = require("./lib/logger");
const ruleIndex = require("./engine/ruleIndex");

const PORT = parseInt(process.env.PORT || "4310", 10);

const app = express();

app.disable("x-powered-by");
app.use(cors());

// Access logging (skip health noise)
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    if (req.path !== "/api/internal/health") {
      log.info(`${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
    }
  });
  next();
});

// Internal routes (raw body is captured inside the router itself
// because HMAC must be verified against exact bytes).
app.use("/api/internal", require("./routes/internal"));

// JSON body parser for everything else — small limit, this is a
// filter API not a bulk importer.
app.use(express.json({ limit: "64kb" }));

app.use("/api/v1/alerts", require("./routes/alerts"));

// Minimal version/health alias at root too
app.get("/health", (req, res) => res.json({ ok: true, service: "smart-alerts-api" }));

app.use((req, res) => res.status(404).json({ error: "not_found", path: req.path }));
app.use((err, req, res, _next) => {
  log.error("[unhandled]", err.stack || err.message);
  res.status(500).json({ error: "internal_error" });
});

async function start() {
  try {
    const r = await db.query("SELECT NOW() AS now, current_database() AS name");
    log.info(`[db] connected (${r.rows[0].name}) at ${r.rows[0].now}`);
  } catch (err) {
    log.error("[db] connection failed:", err.message);
    process.exit(1);
  }
  try { await ruleIndex.load(); }
  catch (err) {
    log.error("[rule-index] initial load failed:", err.message);
    // do not abort — service can still accept new rules; index is rebuildable
  }

  const server = app.listen(PORT, "127.0.0.1", () => {
    log.info(`[api] agoraiq-smart-alerts listening on 127.0.0.1:${PORT}`);
  });

  const shutdown = async (sig) => {
    log.info(`[api] ${sig} — draining`);
    server.close(async () => {
      try { await db.end(); } catch {}
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

start().catch(err => { log.error("[fatal]", err.stack || err.message); process.exit(1); });
