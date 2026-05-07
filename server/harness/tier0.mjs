// Tier 0 — frame-level event ingestor.
//
// Responsibilities:
//   1. Subscribe to upstream events (Frigate MQTT/WS, motion detector, etc.).
//   2. Normalize each into a DetectionEvent (types.mjs).
//   3. Publish on TOPIC.DETECTION for downstream stages.
//
// Phase plan:
//   - v0 (now): explicit poke from /api/agent/detections — every UI snapshot
//                request creates a synthetic T0 event.
//   - v1:        subscribe to Frigate's events websocket
//                (wss://.../api/events/ws) and emit one event per frame change.
//   - v2:        also subscribe to motion-only events (no detector) for the
//                "Frigate detection disabled" branch.
//
// Nothing here calls an LLM. T0 is allowed to inject a Frigate detector
// result if Frigate is configured with a real detector model — that's still
// classical and free.

import { publish } from "./eventbus.mjs";
import { newDetectionEvent } from "./types.mjs";
import { TOPIC } from "./types.mjs";

/**
 * Synchronously inject a manual event (used by the API layer when the user
 * triggers an "analyze now" from the UI). Returns the event so the caller
 * can pass it directly into the rest of the pipeline if needed.
 *
 * @param {{ cam: string, tenant_id?: string, snapshot_url?: string, objects?: object[], motion?: boolean }} fields
 */
export function injectManual(fields) {
  const ev = newDetectionEvent({
    origin: "manual_query",
    motion: fields.motion ?? true,
    cam: fields.cam,
    tenant_id: fields.tenant_id,
    snapshot_url: fields.snapshot_url,
    objects: fields.objects,
  });
  publish(TOPIC.DETECTION, ev);
  return ev;
}

/**
 * Start the Frigate event-stream subscriber. No-op stub for v0 — wires up in
 * a later phase. The exported shape matches what the eventual implementation
 * will provide so callers don't need to change.
 *
 * @param {{ frigateClient?: object, signal?: AbortSignal }} opts
 * @returns {{ close: () => void }}
 */
export function startFrigateIngestor(/* opts */) {
  // TODO(phase-3): connect to Frigate's events websocket and translate each
  // frame-level event into a DetectionEvent. Until then, the only T0 source
  // is `injectManual`.
  return {
    close: () => {},
  };
}
