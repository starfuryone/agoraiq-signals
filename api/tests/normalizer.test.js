"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// parser.js pulls in DB / fetch deps via lib/messages — stub it so the
// normalizer test can run hermetically.
const Module = require("module");
const origResolve = Module._resolve_filename || Module._resolveFilename;
const origLoad = Module._load;
const PARSER_PATH = require.resolve("../src/lib/parser");
require.cache[PARSER_PATH] = {
  id: PARSER_PATH,
  filename: PARSER_PATH,
  loaded: true,
  exports: {
    parseSignal(text) {
      // Deterministic stub: caller passes JSON-stringified hint
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.__not_signal) return { parseStatus: "not_signal" };
        return parsed;
      } catch {
        return { parseStatus: "not_signal" };
      }
    },
  },
};

const { normalize, NormalizationError } = require("../src/lib/normalizer");

test("normalize: structured LONG payload produces canonical shape", () => {
  const out = normalize({
    structured: {
      symbol: "btc/usdt",
      direction: "buy",
      entry: 100,
      stop: 95,
      targets: [110, 120],
    },
    source: "scanner",
    timeframe: "1h",
  });
  assert.equal(out.symbol, "BTCUSDT");
  assert.equal(out.direction, "LONG");
  assert.equal(out.entry, 100);
  assert.equal(out.stop, 95);
  assert.deepEqual(out.targets, [110, 120]);
  assert.equal(out.timeframe, "1h");
});

test("normalize: range entry collapses to midpoint", () => {
  const out = normalize({
    structured: {
      symbol: "ETHUSDT",
      direction: "LONG",
      entry: [100, 110],
      stop: 95,
      targets: [120],
    },
    source: "scanner",
  });
  assert.equal(out.entry, 105);
});

test("normalize: SHORT targets sorted descending (closest to entry first)", () => {
  const out = normalize({
    structured: {
      symbol: "ETHUSDT",
      direction: "SHORT",
      entry: 1000,
      stop: 1050,
      targets: [900, 800, 950], // unsorted
    },
    source: "user",
  });
  assert.deepEqual(out.targets, [950, 900, 800]);
});

test("normalize: LONG targets sorted ascending", () => {
  const out = normalize({
    structured: {
      symbol: "ETHUSDT",
      direction: "LONG",
      entry: 1000,
      stop: 950,
      targets: [1200, 1050, 1100],
    },
    source: "user",
  });
  assert.deepEqual(out.targets, [1050, 1100, 1200]);
});

test("normalize: missing direction throws NormalizationError", () => {
  assert.throws(
    () =>
      normalize({
        structured: { symbol: "BTCUSDT", entry: 1, stop: 0.9, targets: [1.1] },
        source: "user",
      }),
    NormalizationError
  );
});

test("normalize: invalid source throws NormalizationError", () => {
  assert.throws(
    () =>
      normalize({
        structured: { symbol: "BTCUSDT", direction: "LONG", entry: 1, stop: 0.9, targets: [1.1] },
        source: "facebook",
      }),
    /invalid_source/
  );
});

test("normalize: missing payload body throws", () => {
  assert.throws(
    () => normalize({ source: "user" }),
    /missing_payload_body/
  );
});

test("normalize: range string '0.42 - 0.45' collapses to midpoint", () => {
  const out = normalize({
    structured: {
      symbol: "BTCUSDT",
      direction: "LONG",
      entry: "0.42 - 0.45",
      stop: 0.4,
      targets: [0.5],
    },
    source: "user",
  });
  assert.ok(Math.abs(out.entry - 0.435) < 1e-9);
});

test("normalize: BUY/SELL aliases", () => {
  const buy = normalize({
    structured: { symbol: "BTCUSDT", direction: "BUY", entry: 1, stop: 0.9, targets: [1.1] },
    source: "user",
  });
  assert.equal(buy.direction, "LONG");

  const sell = normalize({
    structured: { symbol: "BTCUSDT", direction: "SELL", entry: 1, stop: 1.1, targets: [0.9] },
    source: "user",
  });
  assert.equal(sell.direction, "SHORT");
});

test("normalize: BTCUSD is mapped to BTCUSDT", () => {
  const out = normalize({
    structured: { symbol: "BTCUSD", direction: "LONG", entry: 1, stop: 0.9, targets: [1.1] },
    source: "user",
  });
  assert.equal(out.symbol, "BTCUSDT");
});
