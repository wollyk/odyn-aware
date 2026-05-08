// Tier-1 weapon / suspicious-object client.
//
// Talks to the YOLOv8 sidecar (services/weapon-detector). One responsibility:
// score a single frame for "is there a likely suspicious object in this
// image, and if so what?". The Node side does NO ML — all decisions come
// from the sidecar.
//
// Why a Node client and not just a HTTP fetch in tier1.mjs:
//   - This file owns the multipart encoding, the timeout, the
//     graceful-failure shape (so a sidecar outage falls open in the same
//     way face.mjs does).
//   - This file owns the `decision` semantics: `clear | suspicious`, and
//     the threshold above which we elevate severity. Calibrating those
//     happens here, not in the route handler.
//
// Cost: free (local CPU). Latency on yolov8n CPU: ~100-250ms per frame.
// We only call this when T2 reports a person OR severity >= notable, so
// the tail-latency hit on the typical "no person" tick is zero.

import { request } from "node:http";
import { URL } from "node:url";

const WEAPON_DETECTOR_URL = process.env.WEAPON_DETECTOR_URL ?? "http://127.0.0.1:8766";
// Above this score, we flag the frame as `suspicious`. Set higher (e.g.
// 0.55) once we have telemetry on real-world frames.
const SUSPICIOUS_THRESHOLD = Number(process.env.WEAPON_SUSPICIOUS_THRESHOLD ?? 0.5);
// Hard timeout. Sidecar typically replies in <300ms; give it 5s headroom.
const REQUEST_TIMEOUT_MS = Number(process.env.WEAPON_DETECTOR_TIMEOUT_MS ?? 5000);

let _initialized = false;

/** No-op for now — kept so weapon.init({db}) mirrors face.init({db}). */
export function init() {
  _initialized = true;
}

// ---- Sidecar HTTP -------------------------------------------------------

/**
 * Multipart-encode a JPEG buffer + POST it to /detect.
 * Hand-rolled (no multipart dep), exactly mirroring face.mjs::postEmbed.
 */
function postDetect(image, { filename = "frame.jpg", contentType = "image/jpeg", timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL("/detect", WEAPON_DETECTOR_URL); }
    catch (err) { return reject(err); }
    const boundary = "--av-" + Math.random().toString(36).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, image, tail]);

    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            return reject(new Error(`weapon_http_${res.statusCode}: ${text.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`weapon_bad_json: ${err.message}`));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("weapon_timeout")));
    req.write(body);
    req.end();
  });
}

/** Sidecar health check. Returns { ok, model, suspicious_classes, ... }. */
export async function ping(timeoutMs = 4000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL("/health", WEAPON_DETECTOR_URL); }
    catch (err) { return resolve({ ok: false, error: err.message }); }
    const req = request(
      {
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname,
        method: "GET",
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            return resolve({ ok: false, error: `http_${res.statusCode}` });
          }
          try { resolve(JSON.parse(text)); }
          catch (err) { resolve({ ok: false, error: err.message }); }
        });
      },
    );
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error("ping_timeout")));
    req.end();
  });
}

// ---- Scoring ------------------------------------------------------------

/**
 * Score a single frame. Returns:
 *   {
 *     ok: true,
 *     decision: "clear" | "suspicious",
 *     suspicious_object_score: 0..1,
 *     suspicious_class: string|null,    // best-matching COCO class name
 *     suspicious_count: int,
 *     detections: [{class_id, class_name, confidence, bbox}],
 *     model: string,
 *     took_ms: int,
 *     threshold: number,
 *   }
 * On sidecar failure throws a tagged Error (`weapon_http_4xx`,
 * `weapon_timeout`, etc.) so the caller can fall open exactly like face.mjs.
 */
export async function score(image, opts = {}) {
  if (!Buffer.isBuffer(image) || image.length === 0) {
    throw new Error("weapon.score: image buffer required");
  }
  if (!_initialized) {
    // Don't hard-fail — keep parity with face.mjs which is also lazy.
    init();
  }
  const out = await postDetect(image, opts);
  if (!out?.ok) throw new Error(`weapon_failed: ${JSON.stringify(out).slice(0, 200)}`);
  const susScore = Number(out.suspicious_object_score ?? 0);
  return {
    ok: true,
    decision: susScore >= SUSPICIOUS_THRESHOLD ? "suspicious" : "clear",
    suspicious_object_score: susScore,
    suspicious_class: out.suspicious_class ?? null,
    suspicious_count: Number(out.suspicious_count ?? 0),
    detections: Array.isArray(out.detections) ? out.detections : [],
    model: String(out.model ?? "unknown"),
    took_ms: Number(out.took_ms ?? 0),
    threshold: SUSPICIOUS_THRESHOLD,
  };
}

/**
 * Same as `score()` but never throws. Used by the routed-detection path
 * where the harness must NEVER fail closed because of a missing sidecar.
 *
 * On error the returned shape is:
 *   { ok: false, error: <string>, decision: "clear", suspicious_object_score: 0,
 *     suspicious_class: null, suspicious_count: 0, detections: [],
 *     threshold: <number> }
 */
export async function scoreSafe(image, opts = {}) {
  try {
    return await score(image, opts);
  } catch (err) {
    return {
      ok: false,
      error: err?.message ?? "weapon_failed",
      decision: "clear",
      suspicious_object_score: 0,
      suspicious_class: null,
      suspicious_count: 0,
      detections: [],
      model: "unknown",
      took_ms: 0,
      threshold: SUSPICIOUS_THRESHOLD,
    };
  }
}

export const WEAPON_CONFIG = Object.freeze({
  url: WEAPON_DETECTOR_URL,
  threshold: SUSPICIOUS_THRESHOLD,
  request_timeout_ms: REQUEST_TIMEOUT_MS,
});
