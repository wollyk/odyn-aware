// AuroraView agent harness — public entry point.
//
// THIS IS THE ONLY FILE OUTSIDE server/harness/* THAT api.mjs SHOULD IMPORT.
// Every other module in this directory is internal. This boundary exists so
// the entire harness can later be physically extracted into a separate
// process or npm package without touching the rest of the app.
//
// Decoupling principles:
//   - The harness depends on a small, named set of injected services
//     (db helpers, frigate snapshot fetcher) — never on full module paths
//     outside the harness directory.
//   - The harness uses its OWN event bus internally; the host app interacts
//     via function calls (chat, ingest, status) and SSE iterators.
//   - All persistence is via injected db helpers. If we later move the
//     harness to its own SQLite file, only the wiring in index.mjs changes.
//
// Public surface (what api.mjs uses):
//   start(deps)             — boot stages, wire the bus
//   stop()                  — graceful shutdown
//   ingestSnapshot({...})   — inject a manual T0 event
//   chat(...)               — re-export of streamChatGpt for chat path
//   analyzeImage(...)       — re-export of vision analysis
//   status()                — health/quotas/telemetry snapshot
//   subscribeAlerts(signal) — async iterator of alert events for SSE
//   subscribeHealth(signal) — async iterator of health snapshots for SSE

import { TOPIC } from "./types.mjs";
import { subscribeIterator, inspect as inspectBus } from "./eventbus.mjs";
import * as router from "./router.mjs";
import * as tier0 from "./tier0.mjs";
import * as tier1 from "./tier1.mjs";
import * as tier2 from "./tier2.mjs";
import * as tier3 from "./tier3.mjs";
import * as health from "./health.mjs";
import * as eventlog from "./eventlog.mjs";
import { quotaGate } from "./quota.mjs";
import { snapshot as telemetrySnapshot } from "./telemetry.mjs";
import { workingMemory } from "./memory.mjs";

let started = false;
let _gate = null;
let _deps = null;

/**
 * Boot the harness. `deps` provides anything from outside the harness
 * directory the stages might need.
 *
 * @param {{
 *   db: object,
 *   frigate: { isConfigured: () => boolean, getSnapshot: (cam: string) => Promise<{body: Buffer}>, listCameras: () => Promise<unknown[]> },
 * }} deps
 */
export function start(deps) {
  if (started) return;
  if (!deps?.db || !deps?.frigate) {
    throw new Error("harness.start requires { db, frigate }");
  }
  _deps = deps;
  _gate = quotaGate({ db: deps.db });

  // Persistence subscriber — must start BEFORE any tier so we don't miss
  // the first events emitted at boot. Tiers publish, eventlog records.
  eventlog.start({ db: deps.db });

  // Stages that need wiring to the bus.
  tier1.start();
  tier2.start({
    fetchSnapshot: async (cam) => (await deps.frigate.getSnapshot(cam)).body,
    router,
  });

  // Health probes — uses local Ollama for upstream checks (cost-free).
  health.startProbes({
    frigate: deps.frigate,
    ollama: tier2,                 // tier2.ping() is the Ollama probe
    intervalMs: 60_000,
  });

  started = true;
}

export function stop() {
  if (!started) return;
  tier1.stop();
  tier2.stop();
  eventlog.stop();
  health.stopProbes();
  started = false;
}

// ---- Re-exports forming the harness's public API ---------------------------

export { streamChatGpt as chat, analyzeImage } from "./tier3.mjs";
export const ingestSnapshot = tier0.injectManual;
export const subscribeAlerts = (signal) => subscribeIterator(TOPIC.ALERT, { signal });
export const subscribeHealth = (signal) => subscribeIterator(TOPIC.HEALTH, { signal });

/**
 * Run a cheap local (T2) vision call on a single image. No bus side-effects;
 * intended for direct API endpoints that want a fast scene description
 * without paying T3 cloud costs.
 *
 * @param {{ imageBuffer: Buffer, camera?: string, model?: string }} opts
 */
export async function analyzeImageLocal({ imageBuffer, camera = "", model } = {}) {
  return tier2.analyzeFreeText({ image: imageBuffer, camera, model });
}

/** Ollama health probe (model availability + reachability). */
export async function pingTier2() {
  return tier2.ping();
}

// Quota + telemetry — exposed so the API layer can gate calls and observe
// latency without reaching into the harness internals.
export { observeLatency, increment, timed } from "./telemetry.mjs";

/**
 * Returns a quota decision for the given call. SAFE TO CALL even before
 * harness.start() — falls open (allow) but logs a warning, so an unwired
 * harness never blocks user traffic.
 */
export function checkQuota({ tenant = "default", camera = null, kind }) {
  if (!_gate) return { allowed: true, reason: "no_gate" };
  return _gate.allow({ tenant, camera, kind });
}

/** Record consumption against the quota ledger. Same fall-open semantics. */
export function recordQuota({ tenant = "default", camera = null, kind, dollars = null, cost = 1 }) {
  if (!_gate) return;
  _gate.record({ tenant, camera, kind, dollars, cost });
}

/**
 * One-shot status snapshot for /api/agent/status.
 *
 * NOTE: tier2 ping is async (network probe to Ollama); we expose a sync
 * snapshot here and provide `statusAsync()` for callers that want the live
 * Ollama check.
 */
export function status() {
  return {
    started,
    bus: inspectBus(),
    quota: _gate?.snapshot?.() ?? {},
    telemetry: telemetrySnapshot(),
    memory: workingMemory.inspect(),
    tier3: tier3.ping(),
  };
}

/** Status snapshot including a live Ollama probe (slower; hits the network). */
export async function statusAsync() {
  const [t2] = await Promise.all([tier2.ping().catch((err) => ({ ok: false, error: err?.message }))]);
  return { ...status(), tier2: t2 };
}

export const HARNESS = { router, tier0, tier1, tier2, tier3, TOPIC };
