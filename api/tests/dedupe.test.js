"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// dedupe pulls in db + redis at top-level. Stub them so the pure computeHash
// tests run without infrastructure.
const dbPath = require.resolve("../src/lib/db");
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: { query: async () => ({ rows: [] }) },
};
const redisPath = require.resolve("../src/lib/redis");
require.cache[redisPath] = {
  id: redisPath,
  filename: redisPath,
  loaded: true,
  exports: {
    getRedis: () => ({
      set: async () => "OK",
      get: async () => null,
      del: async () => 1,
    }),
  },
};

const { computeHash, WINDOW_MIN } = require("../src/lib/dedupe");

const WINDOW_MS = WINDOW_MIN * 60 * 1000;

const sample = (overrides = {}) => ({
  symbol: "BTCUSDT",
  direction: "LONG",
  entry: 50000,
  timeframe: "1h",
  signal_ts: 1700000000000,
  ...overrides,
});

test("computeHash: deterministic for identical input", () => {
  const a = computeHash(sample());
  const b = computeHash(sample());
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);
});

test("computeHash: changes with symbol", () => {
  assert.notEqual(computeHash(sample()), computeHash(sample({ symbol: "ETHUSDT" })));
});

test("computeHash: changes with direction", () => {
  assert.notEqual(computeHash(sample()), computeHash(sample({ direction: "SHORT" })));
});

test("computeHash: stable across float jitter at the rounding precision", () => {
  // entry rounded to 8 decimals
  const a = computeHash(sample({ entry: 50000.000000001 }));
  const b = computeHash(sample({ entry: 50000.000000002 }));
  assert.equal(a, b);
});

test("computeHash: different timeframe → different hash", () => {
  assert.notEqual(computeHash(sample()), computeHash(sample({ timeframe: "4h" })));
});

test("computeHash: same bucket window collapses two near-in-time signals", () => {
  // Both timestamps land inside the same WINDOW_MS bucket
  const t = 1_700_000_000_000;
  const a = computeHash(sample({ signal_ts: t }));
  const b = computeHash(sample({ signal_ts: t + 60_000 })); // +1 min, well within 15 min bucket
  assert.equal(a, b);
});

test("computeHash: bucketOffset=-1 returns a different hash than current bucket", () => {
  const s = sample();
  const cur = computeHash(s, 0);
  const prev = computeHash(s, -1);
  assert.notEqual(cur, prev);
});

test("computeHash: prev-bucket of bucket N equals current-bucket of bucket N-1", () => {
  const t = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS; // bucket boundary
  const prevHash = computeHash(sample({ signal_ts: t }), -1);
  const curHashOfPrevBucket = computeHash(sample({ signal_ts: t - WINDOW_MS }), 0);
  assert.equal(prevHash, curHashOfPrevBucket);
});
