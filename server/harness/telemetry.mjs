// Telemetry — fixed-window latency + counter aggregator.
//
// Per the design feedback: don't commit to user-facing latency guarantees
// without measuring them. This module tracks each stage's latency, samples,
// and per-tenant cost so we can answer:
//   - "what's our p95 chat latency?"
//   - "how many T3 vision calls did tenant X make today?"
//   - "how often does router.shouldEscalateT3 actually fire?"
//
// In-process aggregator. Snapshot-style readouts; not a full TSDB.
// Phase plan: v0 in-memory; v1 export to /api/health/telemetry SSE; v2
// optional Prometheus exporter.

const RING_SIZE = 256; // samples kept per metric (rolling window)

class Histogram {
  constructor() {
    this.samples = new Float64Array(RING_SIZE);
    this.cursor = 0;
    this.count = 0;
  }
  push(v) {
    this.samples[this.cursor] = v;
    this.cursor = (this.cursor + 1) % RING_SIZE;
    if (this.count < RING_SIZE) this.count += 1;
  }
  /** Returns { count, p50, p95, p99, mean }. */
  summary() {
    if (this.count === 0) return { count: 0, p50: 0, p95: 0, p99: 0, mean: 0 };
    const arr = Array.from(this.samples.slice(0, this.count)).sort((a, b) => a - b);
    const pick = (q) => arr[Math.min(arr.length - 1, Math.floor(arr.length * q))];
    const sum = arr.reduce((a, b) => a + b, 0);
    return {
      count: this.count,
      p50: Math.round(pick(0.5)),
      p95: Math.round(pick(0.95)),
      p99: Math.round(pick(0.99)),
      mean: Math.round(sum / this.count),
    };
  }
}

const histos = new Map();   // metric name → Histogram
const counters = new Map(); // metric name → number

/** @param {string} name @param {number} ms */
export function observeLatency(name, ms) {
  let h = histos.get(name);
  if (!h) {
    h = new Histogram();
    histos.set(name, h);
  }
  h.push(ms);
}

/** @param {string} name @param {number} [delta=1] */
export function increment(name, delta = 1) {
  counters.set(name, (counters.get(name) ?? 0) + delta);
}

/**
 * Returns a structured snapshot of all metrics. Suitable for /api/health
 * or /api/agent/status augmentation.
 */
export function snapshot() {
  const latencies = {};
  for (const [name, h] of histos.entries()) latencies[name] = h.summary();
  const totals = Object.fromEntries(counters.entries());
  return { latencies, counters: totals };
}

/**
 * Convenience: time an async block and observe. Returns whatever the block
 * returns (or rejects with the block's error after recording an "error" tag).
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    observeLatency(name, Date.now() - t0);
    return out;
  } catch (err) {
    observeLatency(`${name}.error`, Date.now() - t0);
    increment(`${name}.errors`);
    throw err;
  }
}

export function _resetForTests() {
  histos.clear();
  counters.clear();
}
