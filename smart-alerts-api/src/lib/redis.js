"use strict";

const Redis = require("ioredis");
const log = require("./logger");

const URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const PREFIX = process.env.REDIS_PREFIX || "sa:";

let _app = null;
let _bull = null;

function baseOptions() {
  return {
    lazyConnect: false,
    keepAlive: 30_000,
  };
}

/** Application-side Redis with keyspace prefix. Use for cooldowns, dedup, counters. */
function getRedis() {
  if (!_app) {
    _app = new Redis(URL, {
      ...baseOptions(),
      keyPrefix: PREFIX,
    });
    _app.on("error", e => log.error("[redis:app]", e.message));
  }
  return _app;
}

/**
 * BullMQ-compatible connection (no keyPrefix — BullMQ manages its own).
 * Queue names are namespaced by convention (sa-dispatch, sa-deliver).
 */
function getBullConnection() {
  if (!_bull) {
    _bull = new Redis(URL, {
      ...baseOptions(),
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    _bull.on("error", e => log.error("[redis:bull]", e.message));
  }
  return _bull;
}

async function closeAll() {
  if (_app) { try { await _app.quit(); } catch {} _app = null; }
  if (_bull) { try { await _bull.quit(); } catch {} _bull = null; }
}

module.exports = { getRedis, getBullConnection, closeAll, PREFIX };
