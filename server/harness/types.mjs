// AuroraView harness — event-record types.
//
// This module is the load-bearing contract. Every stage in the pipeline
// receives an Event and returns an Event with additional fields appended.
// Stages MUST NOT mutate fields owned by other stages, and they MUST NOT
// produce a new event id — the same record traces end-to-end so we can
// reconstruct the full life of an alert from logs.
//
// Pipeline (each arrow = one stage that appends fields):
//
//   raw frame
//     │
//     ▼  tier0.mjs  (motion + Frigate detector — always-on, ~free)
//   detection_event
//     │
//     ▼  tier1.mjs  (classical ML — face match, weapon score, anomaly)
//   classified_event
//     │
//     ▼  router.mjs (rule engine — decide whether to ask T2)
//     │  (if no escalation, event terminates here, logged for telemetry)
//     ▼  tier2.mjs  (local VLM — describe scene, refine boxes)
//   described_event
//     │
//     ▼  router.mjs (rule engine — decide whether to alert / wake T3)
//     │  (if no alert, event terminates here)
//     ▼
//   alert_event
//     │
//     ▼  surface (SSE / push / webhook)
//   operator_action  (optional, recorded if user reacts in UI)
//
// IMPORTANT: this file is JS-side ESM with JSDoc types so we keep zero
// type-only dependencies in the harness bundle. The TypeScript surface for
// the frontend mirrors this in src/features/live/types.ts.

/**
 * @typedef {"motion"|"object_detected"|"audio_event"|"manual_query"} EventOrigin
 *
 * @typedef {{label: string, score: number, bbox: [number,number,number,number]}} BBoxDetection
 *   Bbox is normalized [x, y, w, h] in 0..1.
 *
 * @typedef {{name: string, embedding: Float32Array|null, known: boolean, person_id: number|null, similarity: number|null}} FaceMatch
 */

/**
 * Stage 0 — raw event entering the pipeline.
 * Produced by tier0.mjs from Frigate's event stream or a manual UI poll.
 *
 * @typedef {object} DetectionEvent
 * @property {string}      id           UUID, traces the event end-to-end across stages
 * @property {string}      tenant_id    For multi-tenant cost attribution
 * @property {string}      cam          Camera wire name
 * @property {EventOrigin} origin       What triggered this event
 * @property {number}      ts           ms epoch when the event was minted
 * @property {boolean}     motion       Whether motion was present in this frame
 * @property {BBoxDetection[]} objects  Always present (may be empty)
 * @property {string=}     snapshot_url Server-internal URL to the JPEG (if any)
 * @property {object}      meta         Stage-local notes for debugging
 */

/**
 * Stage 1 — classified event. Adds outputs from any classical ML we ran.
 * All fields beyond DetectionEvent are optional because stages are skippable.
 *
 * @typedef {object} ClassifiedEvent
 * @property {DetectionEvent} _    All fields from DetectionEvent are spread in
 * @property {FaceMatch[]=}   faces
 * @property {number=}        weapon_score      0..1
 * @property {number=}        anomaly_score     0..1
 * @property {object=}        tier1_meta        per-stage timing + model info
 */

/**
 * Stage 2 — described event. The local VLM (T2) has weighed in.
 *
 * @typedef {object} DescribedEvent
 * @property {ClassifiedEvent} _                All previous fields
 * @property {string=}         scene            One-line caption from VLM
 * @property {boolean=}        scene_change     Did the scene meaningfully change?
 * @property {("normal"|"notable"|"critical")=} severity
 *   Structured label, NOT pattern-matched from `scene` text.
 *   Replaces the brittle scene.includes("[critical]") approach.
 * @property {string=}         alert_type
 *   Optional structured tag: "unknown_face" | "loitering" | "object_left" | etc.
 * @property {number=}         confidence       0..1, T2's confidence in the call
 * @property {string=}         reason           Plain-language explanation
 * @property {object=}         tier2_meta       per-stage timing + model info
 */

/**
 * Stage 3 — alert event. The router has decided this needs an operator's eyes.
 *
 * @typedef {object} AlertEvent
 * @property {DescribedEvent} _              All previous fields
 * @property {string}         alert_id       Stable id for cooldown / dedup
 * @property {("low"|"medium"|"high")} priority
 * @property {string}         headline       <= 80 chars, agent-written
 * @property {string=}        suggested_tool Optional GUI tool to surface
 * @property {object=}        tier3_meta     T3 summarization timing + cost
 */

// ---- Stage names (used by telemetry + logs) ----
export const STAGE = Object.freeze({
  TIER0: "tier0",
  TIER1: "tier1",
  TIER2: "tier2",
  ROUTER_T2: "router.t2",
  ROUTER_T3: "router.t3",
  TIER3: "tier3",
  ALERT: "alert",
});

// ---- Topics on the event bus (eventbus.mjs) ----
export const TOPIC = Object.freeze({
  DETECTION: "detection",   // tier0 → tier1
  CLASSIFIED: "classified", // tier1 → router → tier2
  DESCRIBED: "described",   // tier2 → router → alert
  ALERT: "alert",           // alert → SSE / webhook
  TELEMETRY: "telemetry",   // any stage → telemetry.mjs
  HEALTH: "health",         // upstream health probes → health.mjs
});

// ---- Severity ordering (so >= comparisons work) ----
export const SEVERITY = Object.freeze({ normal: 0, notable: 1, critical: 2 });

/**
 * Mint a new DetectionEvent. The factory enforces id and timestamp so callers
 * can't accidentally produce duplicate ids or back-dated events.
 * @param {Partial<DetectionEvent>} fields
 * @returns {DetectionEvent}
 */
export function newDetectionEvent(fields) {
  const id =
    fields.id ??
    (typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  return {
    id,
    tenant_id: fields.tenant_id ?? "default",
    cam: fields.cam ?? "",
    origin: fields.origin ?? "motion",
    ts: fields.ts ?? Date.now(),
    motion: fields.motion ?? false,
    objects: Array.isArray(fields.objects) ? fields.objects : [],
    snapshot_url: fields.snapshot_url,
    meta: fields.meta ?? {},
  };
}
