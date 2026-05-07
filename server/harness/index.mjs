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
import * as face from "./face.mjs";
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

  // Face DB recognizer — needs a db handle for the in-memory embeddings
  // matrix. Sidecar reachability is opportunistic; it fails open until
  // the InsightFace service is installed (services/face-embedder).
  face.init({ db: deps.db });

  // Health probes — uses local Ollama for upstream checks (cost-free).
  health.startProbes({
    frigate: deps.frigate,
    ollama: tier2,                 // tier2.ping() is the Ollama probe
    intervalMs: 60_000,
  });

  // T0 ingestor — Frigate WS for status transitions + recordings/summary
  // poll for hourly motion totals. See tier0.mjs for what's captured today.
  tier0.startFrigateIngestor({ frigate: deps.frigate });

  started = true;
}

export function stop() {
  if (!started) return;
  tier0.stop();
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

// ---- Phase 4: face recognition --------------------------------------------

/**
 * Run the face recognizer over a single frame. Logs every detected face
 * to db.face_matches for chat history / audit. Returns:
 *   { ok, model, embedder_took_ms, known_count, threshold, faces: [...] }
 *
 * @param {{ imageBuffer: Buffer, camera?: string, event_id?: string|null, recordMatch?: boolean }} opts
 */
export async function recognizeFaces({ imageBuffer, camera = "", event_id = null, recordMatch = true } = {}) {
  return face.recognize(imageBuffer, { camera, event_id, recordMatch });
}

/** Health probe for the InsightFace sidecar. Returns {ok, model, vec_dim, ...}. */
export async function pingFaceEmbedder() {
  return face.ping();
}

/**
 * Raw embed call — used by the enroll endpoint, which needs the actual
 * 512-d vector (recognize() doesn't expose it on its return shape because
 * the operator UI never needs to see embeddings directly).
 *
 * @param {{ imageBuffer: Buffer }} opts
 * @returns {Promise<{ ok, model, vec_dim, took_ms, faces: Array<{bbox, quality, embedding: number[]}> }>}
 */
export async function embedFace({ imageBuffer } = {}) {
  return face.embed(imageBuffer);
}

/** Drop the in-memory face cache. Call after enroll/delete from the API layer. */
export function invalidateFaceCache() {
  face.invalidate();
}

export const FACE_CONFIG = face.FACE_CONFIG;

// ---- Phase 3: routed (cost-controlled) detection ---------------------------
//
// Per-camera in-memory cache of the last T3 call's bboxes + summary. This
// is what the operator sees while T2 keeps watch and T3 only refreshes
// every T3_REFRESH_MS or when something actually changes.
//
// Bounded: one entry per camera. Memory is O(cameras * (detections + ~200B)).
const _t3Cache = new Map(); // camera -> { detections, summary, model, tookMs, ts }
const T3_CACHE_TTL_MS = Number(process.env.DETECTION_T3_CACHE_TTL_MS ?? 30_000);
const T3_REFRESH_MS = Number(process.env.DETECTION_T3_REFRESH_MS ?? 15_000);
const ROUTER_MODE_DEFAULT = process.env.DETECTION_ROUTER_MODE ?? "t2-gates-t3";

function _getCachedT3(camera, now) {
  const e = _t3Cache.get(camera);
  if (!e) return null;
  if (now - e.ts > T3_CACHE_TTL_MS) return null;
  return e;
}

/**
 * Phase 3 orchestrator. Always runs T2 (cheap), conditionally runs T3 (paid),
 * and returns a unified shape that the live UI can render with one poll.
 *
 * Cost-control invariants this function upholds:
 *   - T3 is rate-limited per-camera (router decides).
 *   - When T2 says "normal", T3 is skipped entirely.
 *   - When T2 fails, T3 falls open as a safety net (never zero coverage).
 *   - Cached T3 bboxes are returned for staleness <= T3_CACHE_TTL_MS.
 *
 * @param {{
 *   imageBuffer: Buffer,
 *   camera?: string,
 *   mode?: "always-t3"|"t2-gates-t3"|"t2-only"|"off",
 *   t3?: { call: ({ imageBuffer: Buffer, camera: string }) => Promise<object> }, // injected for tests
 *   now?: number,
 * }} opts
 * @returns {Promise<{
 *   tier: "T2-only"|"T2-then-T3"|"T2-cached-T3"|"T3-only"|"none",
 *   detections: Array,
 *   summary: string,
 *   status: string,
 *   model: string|null,
 *   tookMs: number,
 *   local_scene: string,
 *   severity: "normal"|"notable"|"critical",
 *   alert_type: string|null,
 *   confidence: number,
 *   escalation: { ran: boolean, reason: string, source: "live"|"cache"|"none" },
 *   t3_age_ms: number|null,
 * }>}
 */
export async function analyzeImageRouted({
  imageBuffer,
  camera = "",
  mode = ROUTER_MODE_DEFAULT,
  t2,
  t3,
  now,
} = {}) {
  const wallStart = Date.now();
  const _now = typeof now === "number" ? now : Date.now();
  const t2Caller = t2?.call ?? (({ imageBuffer: ib, camera: c }) =>
    tier2.analyzeFreeText({ image: ib, camera: c })
  );
  const t3Caller = t3?.call ?? (({ imageBuffer: ib, camera: c }) =>
    // Default: real T3 (GPT-4o-mini) via tier3 facade. Lazy-resolved so tests
    // can override without touching network.
    tier3.analyzeImage({ imageBuffer: ib, camera: c })
  );

  // Step 1: T2 always — except when explicitly off.
  let t2Result = null;
  if (mode !== "off" && mode !== "always-t3") {
    t2Result = await t2Caller({ imageBuffer, camera });
  } else if (mode === "always-t3") {
    // Skip T2 in always-t3 mode for parity with old behavior (no extra cost).
    t2Result = { ok: false, severity: "normal", scene: "", alert_type: null, confidence: 0, hits: {} };
  }

  // Step 2: ask the router whether T3 should run.
  const cached = _getCachedT3(camera, _now);
  const decision = router.shouldRunT3FromT2({
    t2: t2Result,
    lastT3Ts: cached?.ts ?? null,
    now: _now,
    mode,
    refreshMs: T3_REFRESH_MS,
  });

  // Step 3: optionally call T3.
  let t3Live = null;
  let t3Error = null;
  if (decision.runT3) {
    try {
      t3Live = await t3Caller({ imageBuffer, camera });
      _t3Cache.set(camera, {
        detections: t3Live.detections ?? [],
        summary: t3Live.summary ?? "",
        model: t3Live.model ?? null,
        tookMs: t3Live.tookMs ?? null,
        ts: Date.now(),
      });
    } catch (err) {
      t3Error = err?.message ?? "t3_failed";
    }
  }

  // Step 4: assemble the unified response.
  // Re-read cache with the *current* timestamp (the t3 call may have just
  // finished, mutating the cache; using `_now` from start-of-call yields
  // negative ages on the live-T3 tick).
  const responseNow = Date.now();
  const cacheAfter = _getCachedT3(camera, responseNow);
  const detections = t3Live?.detections ?? cacheAfter?.detections ?? [];
  const summary = t3Live?.summary ?? cacheAfter?.summary ?? (t2Result?.scene ?? "");
  const t3Model = t3Live?.model ?? cacheAfter?.model ?? null;
  const t3AgeMs = cacheAfter ? Math.max(0, responseNow - cacheAfter.ts) : null;

  let tier;
  let source;
  if (mode === "off") { tier = "none"; source = "none"; }
  else if (mode === "t2-only") { tier = "T2-only"; source = "none"; }
  else if (mode === "always-t3") { tier = "T3-only"; source = t3Live ? "live" : "cache"; }
  else if (t3Live) { tier = "T2-then-T3"; source = "live"; }
  else if (cacheAfter) { tier = "T2-cached-T3"; source = "cache"; }
  else { tier = "T2-only"; source = "none"; }

  return {
    tier,
    detections,
    summary,
    status: t3Error ? "error" : "ok",
    model: t3Model,
    tookMs: Date.now() - wallStart,
    local_scene: t2Result?.scene ?? "",
    severity: t2Result?.severity ?? "normal",
    alert_type: t2Result?.alert_type ?? null,
    confidence: t2Result?.confidence ?? 0,
    escalation: { ran: Boolean(t3Live), reason: decision.reason, source },
    t3_age_ms: t3AgeMs,
    t3_error: t3Error,
  };
}

/** Test/diagnostics: clear all cached T3 results (or one camera). */
export function clearT3Cache(camera = null) {
  if (camera) _t3Cache.delete(camera);
  else _t3Cache.clear();
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
    tier0: tier0.inspect(),
    tier3: tier3.ping(),
  };
}

/** Status snapshot including a live Ollama probe (slower; hits the network). */
export async function statusAsync() {
  const [t2] = await Promise.all([tier2.ping().catch((err) => ({ ok: false, error: err?.message }))]);
  return { ...status(), tier2: t2 };
}

export const HARNESS = { router, tier0, tier1, tier2, tier3, TOPIC };
