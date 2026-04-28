/**
 * Lightweight Prometheus-compatible metrics registry.
 *
 * Zero-dependency on purpose: adding prom-client (and its label cardinality
 * footguns) is overkill for our 3-worker pipeline. This module exposes
 * counters and gauges with bounded label cardinality and emits the standard
 * Prometheus text exposition format.
 *
 * Usage:
 *   const m = require("./lib/metrics");
 *   m.incCounter("agoraiq_ingest_total", { stage: "normalize", outcome: "accepted" });
 *   m.setGauge("agoraiq_ingest_queue_depth", { queue: "signal:ingest" }, 12);
 *   const text = m.render();   // Prometheus text format
 *
 * Label safety:
 *   - Label names are sorted before keying so {a:1,b:2} and {b:2,a:1} share
 *     a counter (no metric duplication on insertion order).
 *   - Label values are escaped per the Prom text spec (\\, \", \n).
 *   - Cardinality cap (default 5000 series per metric) prevents a runaway
 *     label dimension (e.g. raw symbols) from blowing up memory.
 *
 * This is in-process state. With multiple replicas, scrape each replica
 * separately or aggregate via the Prom recording rules. We do NOT persist
 * to Redis — counters reset on restart, which is the standard Prom contract.
 */

const COUNTERS = new Map();           // metric name → Map(labelKey → number)
const GAUGES = new Map();             // metric name → Map(labelKey → number)
const HELP = new Map();               // metric name → help string
const TYPES = new Map();              // metric name → "counter" | "gauge"

const MAX_SERIES_PER_METRIC = parseInt(process.env.METRICS_MAX_SERIES || "5000", 10);

function defineCounter(name, help) {
  if (!COUNTERS.has(name)) COUNTERS.set(name, new Map());
  HELP.set(name, help);
  TYPES.set(name, "counter");
}

function defineGauge(name, help) {
  if (!GAUGES.has(name)) GAUGES.set(name, new Map());
  HELP.set(name, help);
  TYPES.set(name, "gauge");
}

function incCounter(name, labels = {}, by = 1) {
  if (!COUNTERS.has(name)) defineCounter(name, "");
  const series = COUNTERS.get(name);
  const key = labelKey(labels);
  if (!series.has(key) && series.size >= MAX_SERIES_PER_METRIC) return;
  series.set(key, (series.get(key) || 0) + by);
}

function setGauge(name, labels = {}, value) {
  if (!GAUGES.has(name)) defineGauge(name, "");
  const series = GAUGES.get(name);
  const key = labelKey(labels);
  if (!series.has(key) && series.size >= MAX_SERIES_PER_METRIC) return;
  series.set(key, value);
}

function getCounter(name, labels = {}) {
  const series = COUNTERS.get(name);
  if (!series) return 0;
  return series.get(labelKey(labels)) || 0;
}

/**
 * Sum a counter across every series whose labels are a superset of `filter`.
 * Lets aggregation queries answer "all rejections at the normalize stage,
 * regardless of source/strategy" without depending on the text format.
 */
function sumCounterByLabels(name, filter = {}) {
  const series = COUNTERS.get(name);
  if (!series) return 0;
  let total = 0;
  for (const [key, value] of series) {
    if (matchesFilter(parseLabelKey(key), filter)) total += value;
  }
  return total;
}

function parseLabelKey(key) {
  if (!key) return {};
  const out = {};
  for (const part of key.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

function matchesFilter(labels, filter) {
  for (const [k, v] of Object.entries(filter)) {
    if (labels[k] !== String(v)) return false;
  }
  return true;
}

function getGauge(name, labels = {}) {
  const series = GAUGES.get(name);
  if (!series) return null;
  const v = series.get(labelKey(labels));
  return v === undefined ? null : v;
}

/**
 * Render all metrics in Prometheus text exposition format.
 */
function render() {
  const out = [];
  for (const [name, series] of COUNTERS) {
    pushMetric(out, name, "counter", series);
  }
  for (const [name, series] of GAUGES) {
    pushMetric(out, name, "gauge", series);
  }
  return out.join("\n") + "\n";
}

function pushMetric(out, name, type, series) {
  if (HELP.get(name)) out.push(`# HELP ${name} ${HELP.get(name)}`);
  out.push(`# TYPE ${name} ${type}`);
  for (const [key, value] of series) {
    out.push(`${name}${renderLabels(key)} ${formatNumber(value)}`);
  }
}

// ── label encoding ──────────────────────────────────────────────────────────

function labelKey(labels) {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts = [];
  for (const k of keys) {
    const v = labels[k];
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${escapeLabelValue(String(v))}`);
  }
  return parts.join(",");
}

function renderLabels(key) {
  if (!key) return "";
  const parts = key.split(",").map((kv) => {
    const eq = kv.indexOf("=");
    if (eq < 0) return kv;
    return `${kv.slice(0, eq)}="${kv.slice(eq + 1)}"`;
  });
  return `{${parts.join(",")}}`;
}

function escapeLabelValue(v) {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return "0";
  return Number.isInteger(n) ? String(n) : n.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

// ── Pre-defined metrics for the AgoraIQ ingestion pipeline ──────────────────

defineCounter(
  "agoraiq_ingest_total",
  "Ingestion pipeline events. labels: stage(normalize|validate|dedupe|persisted), source, strategy, outcome(accepted|rejected)"
);
defineCounter(
  "agoraiq_ingest_rejections_total",
  "Rejections by stage and reason. labels: stage, reason"
);
defineCounter(
  "agoraiq_resolver_transitions_total",
  "Resolver state transitions. labels: transition(TP1|TP2|TP3|SL|EXPIRED|skipped|noop)"
);
defineCounter(
  "agoraiq_enrich_total",
  "Enrichment outcomes. labels: outcome(scored|skipped|failed)"
);

defineGauge(
  "agoraiq_ingest_queue_depth",
  "Current depth of BullMQ queues. labels: queue, state(waiting|active|delayed|failed)"
);
defineGauge(
  "agoraiq_ingest_last_success_unix",
  "Unix seconds of the last successful ingest job per worker. labels: worker"
);
defineGauge(
  "agoraiq_resolver_last_run_unix",
  "Unix seconds of the last resolver tick"
);
defineGauge(
  "agoraiq_enrich_last_success_unix",
  "Unix seconds of the last successful enrich job"
);

module.exports = {
  defineCounter,
  defineGauge,
  incCounter,
  setGauge,
  getCounter,
  getGauge,
  sumCounterByLabels,
  render,
};
