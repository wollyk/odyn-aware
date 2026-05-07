// Tier 1 — classical ML specialists (face, weapon, anomaly).
//
// All work here is local CPU/GPU and free at the margin. Output is a
// ClassifiedEvent that augments the inbound DetectionEvent.
//
// Phase plan:
//   - v0 (now):  pure stub. Returns the input untouched. Lets the rest of
//                the pipeline be tested without a model dependency.
//   - v1:        face_recognize() shells out to a sidecar process that runs
//                insightface; weapon_yolo() runs a YOLOv8 model; anomaly_score()
//                runs a one-class SVM trained per-camera.
//   - v2:        embeddings stored / retrieved from face_db (db.mjs).
//
// IMPORTANT: this tier never calls an LLM. If you find yourself reaching for
// one, write the rule in router.mjs instead and let T2 do the language work.

import { publish, subscribe } from "./eventbus.mjs";
import { TOPIC } from "./types.mjs";
import * as face from "./face.mjs";

/** @type {(opts: { event: object }) => Promise<object>} */
export async function classify({ event }) {
  // v0 pass-through. Future: invoke face/weapon/anomaly here.
  const enriched = { ...event, tier1_meta: { passthrough: true, t_ms: 0 } };
  return enriched;
}

/**
 * Wire T1 into the bus: subscribe to TOPIC.DETECTION, publish to
 * TOPIC.CLASSIFIED. Idempotent — calling start() twice is a noop.
 */
let started = false;
let unsubscribe = null;

export function start() {
  if (started) return;
  started = true;
  unsubscribe = subscribe(TOPIC.DETECTION, async (ev) => {
    try {
      const out = await classify({ event: ev });
      publish(TOPIC.CLASSIFIED, out);
    } catch (err) {
      console.error("[tier1] classify failed:", err?.message);
    }
  });
}

export function stop() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  started = false;
}

// ---- Stubbed primitives (replace with real impls in v1) --------------------

/**
 * Face recognition. Embeds the live frame via the InsightFace sidecar and
 * scores against db.face_embeddings. Returns the same shape as
 * face.recognize() so callers don't have to know about the indirection.
 *
 * @param {{ cam: string, image: Buffer, event_id?: string|null }} input
 */
export async function faceRecognize({ cam, image, event_id = null } = {}) {
  if (!image) return { ok: false, error: "missing_image", faces: [] };
  return face.recognize(image, { camera: cam, event_id });
}

/** Quick check that the sidecar is reachable. */
export async function faceEmbedderHealth() {
  return face.ping();
}

/**
 * Weapon score. Returns 0..1 (higher = more likely weapon).
 * @param {{ cam: string, image: Buffer }} _input
 * @returns {Promise<number>}
 */
export async function weaponScore(_input) {
  return 0; // v0 stub
}

/**
 * Anomaly score for the current scene vs. a per-camera baseline.
 * @param {{ cam: string, image: Buffer }} _input
 * @returns {Promise<number>}
 */
export async function anomalyScore(_input) {
  return 0; // v0 stub
}
