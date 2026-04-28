/**
 * Strategy registry — every signal carries a strategy identifier so EV /
 * win-rate analytics can group apples with apples.
 *
 * Add new entries here when introducing a new producer. The validator does
 * NOT enforce membership in this list (we don't want a typo to drop signals
 * silently); it's a documentation + autocomplete contract.
 */

const STRATEGIES = Object.freeze({
  BREAKOUT_V1: "breakout_v1",
  MEAN_REVERSION_V2: "mean_reversion_v2",
  PROVIDER_EXTERNAL: "provider_external",
  MANUAL_V1: "manual_v1",
  SCANNER_TRACK_V1: "scanner_track_v1",
});

const SCHEMA_VERSION = "v3_clean";

module.exports = { STRATEGIES, SCHEMA_VERSION };
