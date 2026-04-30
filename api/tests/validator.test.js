"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { validate } = require("../src/lib/validator");

const baseLong = () => ({
  symbol: "BTCUSDT",
  direction: "LONG",
  entry: 100,
  stop: 95,
  targets: [110, 120],
  source: "user",
  provider: "test",
  strategy: "manual_v1",
  timeframe: "1h",
  signal_ts: Date.now(),
});

const baseShort = () => ({
  ...baseLong(),
  direction: "SHORT",
  stop: 105,
  targets: [90, 80],
});

test("validator: valid LONG passes and emits validation metadata", () => {
  const r = validate(baseLong());
  assert.equal(r.ok, true);
  assert.equal(r.validated.validation.risk, 5);
  assert.equal(r.validated.validation.reward, 10);
  assert.equal(r.validated.validation.rr, 2);
});

test("validator: valid SHORT passes", () => {
  const r = validate(baseShort());
  assert.equal(r.ok, true);
});

test("validator: rejects payload_not_object", () => {
  assert.equal(validate(null).reason, "payload_not_object");
  assert.equal(validate("hi").reason, "payload_not_object");
});

test("validator: rejects invalid_direction", () => {
  const s = baseLong();
  s.direction = "FLAT";
  assert.equal(validate(s).reason, "invalid_direction");
});

test("validator: rejects invalid_entry / invalid_stop", () => {
  const s1 = baseLong();
  s1.entry = -1;
  assert.equal(validate(s1).reason, "invalid_entry");

  const s2 = baseLong();
  s2.stop = 0;
  assert.equal(validate(s2).reason, "invalid_stop");
});

test("validator: rejects entry_equals_stop", () => {
  const s = baseLong();
  s.stop = s.entry;
  assert.equal(validate(s).reason, "entry_equals_stop");
});

test("validator: rejects missing_targets", () => {
  const s = baseLong();
  s.targets = [];
  assert.equal(validate(s).reason, "missing_targets");
});

test("validator: rejects long_stop_at_or_above_entry", () => {
  const s = baseLong();
  s.stop = 105;
  assert.equal(validate(s).reason, "long_stop_at_or_above_entry");
});

test("validator: rejects short_stop_at_or_below_entry", () => {
  const s = baseShort();
  s.stop = 95;
  assert.equal(validate(s).reason, "short_stop_at_or_below_entry");
});

test("validator: rejects long_target_at_or_below_entry on FIRST target", () => {
  const s = baseLong();
  s.targets = [99, 110];
  const r = validate(s);
  assert.equal(r.reason, "long_target_at_or_below_entry");
  assert.equal(r.details.target_index, 0);
});

test("validator: rejects long_target_at_or_below_entry on LATER target (Fix #6)", () => {
  // Validator must check every target, not just targets[0]
  const s = baseLong();
  s.targets = [110, 99]; // second is below entry
  const r = validate(s);
  assert.equal(r.reason, "long_target_at_or_below_entry");
  assert.equal(r.details.target_index, 1);
});

test("validator: rejects short_target_at_or_above_entry on later target", () => {
  const s = baseShort();
  s.targets = [90, 105]; // second is above entry
  const r = validate(s);
  assert.equal(r.reason, "short_target_at_or_above_entry");
  assert.equal(r.details.target_index, 1);
});

test("validator: rejects rr_out_of_bounds (too low)", () => {
  // RR_MIN default 0.5; risk=10, reward=2 → rr=0.2
  const s = baseLong();
  s.entry = 100;
  s.stop = 90;
  s.targets = [102];
  const r = validate(s);
  assert.equal(r.reason, "rr_out_of_bounds");
});

test("validator: rejects rr_out_of_bounds (too high)", () => {
  // risk=1, reward=100 → rr=100
  const s = baseLong();
  s.entry = 100;
  s.stop = 99;
  s.targets = [200];
  const r = validate(s);
  assert.equal(r.reason, "rr_out_of_bounds");
});
