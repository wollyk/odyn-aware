// Face recognition client + recognizer.
//
// Two responsibilities:
//   1. embed(image): proxy an HTTP call to the InsightFace sidecar
//      (services/face-embedder). Returns the list of detected faces with
//      512-d embeddings already L2-normalized.
//   2. recognize(image, opts): embed + score against the in-memory matrix
//      of known embeddings loaded from db.face_embeddings. Returns one
//      result per detected face: { person_id, person_name, similarity,
//      bbox, quality, decision: "match" | "unknown" | "low_quality" }.
//
// We keep the in-memory matrix here (NOT in db.mjs) because:
//   - it's a hot path (one matrix multiply per recognition),
//   - it has its own staleness contract (reload on enrollment changes,
//     periodic refresh as a safety net),
//   - and it's the only place that knows the embedder dimensionality.
//
// Cost: free (local CPU). Latency: ~50-150ms for embedding + a few ms for
// the cosine scan.

import { request } from "node:http";
import { URL } from "node:url";
import { loadEmbeddingsForRecognition } from "../db.mjs";
import { insertFaceMatchExtended, updateFaceMatchThumb } from "../db/face-identity.mjs";
import { saveFaceThumb } from "../util/face-thumb.mjs";
import { getSettings, findTrackForFace } from "./face_identity.mjs";
import { clusterUnknownMatch } from "./face_cluster.mjs";
import { updateTrackIdentity } from "../db/face-identity.mjs";

const FACE_EMBEDDER_URL = process.env.FACE_EMBEDDER_URL ?? "http://127.0.0.1:8765";
const FACE_MODEL = process.env.FACE_EMBEDDER_MODEL ?? "buffalo_l";
const VEC_DIM = Number(process.env.FACE_EMBEDDER_DIM ?? 512);
// Stored embeddings are tagged with this composite name so multiple
// embedder versions can coexist.
const STORED_MODEL_TAG = `insightface-${FACE_MODEL}-${VEC_DIM}`;
// Below this similarity, a face is treated as unknown.
const MATCH_THRESHOLD = Number(process.env.FACE_MATCH_THRESHOLD ?? 0.45);
// Below this detector quality we ignore the face entirely. Helps avoid
// false matches on tiny / heavily-rotated / motion-blurred faces.
const MIN_DETECTOR_QUALITY = Number(process.env.FACE_MIN_DETECTOR_QUALITY ?? 0.55);

let cachedDb = null;
let cachedMatrix = null;     // { vecs: [Float32Array, ...], rows: [{person_id, person_name, embedding_id, quality}] }
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;
let inflightReload = null;

/**
 * Initialize the recognizer. Just stashes a db handle and ensures the
 * cache loads on first call. Safe to call multiple times.
 */
export function init({ db }) {
  cachedDb = db;
}

/** Force a reload of the in-memory embedding matrix (call after enroll/delete). */
export function invalidate() {
  cachedMatrix = null;
  cachedAt = 0;
}

async function ensureLoaded() {
  if (!cachedDb) throw new Error("face.init({db}) was never called");
  const now = Date.now();
  if (cachedMatrix && now - cachedAt < CACHE_TTL_MS) return cachedMatrix;
  if (inflightReload) return inflightReload;
  inflightReload = (async () => {
    const rows = loadEmbeddingsForRecognition(cachedDb, { model: STORED_MODEL_TAG });
    cachedMatrix = {
      vecs: rows.map((r) => r.vec),
      rows: rows.map((r) => ({
        person_id: r.person_id,
        person_name: r.person_name,
        embedding_id: r.embedding_id,
        quality: r.quality,
      })),
    };
    cachedAt = Date.now();
    return cachedMatrix;
  })().finally(() => {
    inflightReload = null;
  });
  return inflightReload;
}

// ---- Sidecar HTTP -------------------------------------------------------

/**
 * Multipart-encode a JPEG buffer + POST it to /embed. Avoids pulling in
 * a multipart dependency by hand-rolling the boundary (sidecar parses with
 * standard FastAPI/python-multipart).
 */
function postEmbed(image, { filename = "frame.jpg", contentType = "image/jpeg", timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL("/embed", FACE_EMBEDDER_URL); }
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
            return reject(new Error(`embedder_http_${res.statusCode}: ${text.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(new Error(`embedder_bad_json: ${err.message}`));
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("embedder_timeout")));
    req.write(body);
    req.end();
  });
}

/**
 * Call the sidecar /embed endpoint. Returns the parsed payload:
 *   { ok, model, vec_dim, took_ms, faces: [{bbox, quality, embedding}] }
 */
export async function embed(image, opts) {
  if (!Buffer.isBuffer(image) || image.length === 0) {
    throw new Error("embed: image buffer required");
  }
  const out = await postEmbed(image, opts);
  if (!out?.ok) throw new Error(`embedder_failed: ${JSON.stringify(out).slice(0, 200)}`);
  return out;
}

/** Sidecar health check. Returns { ok, model, loaded_in_ms, vec_dim }. */
export async function ping(timeoutMs = 4000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL("/health", FACE_EMBEDDER_URL); }
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
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            resolve({ ok: false, error: err.message });
          }
        });
      },
    );
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error("ping_timeout")));
    req.end();
  });
}

// ---- Recognition --------------------------------------------------------

/**
 * Compute cosine similarity between two unit-normalized Float32Arrays.
 * The sidecar normalizes embeddings before sending, and stored embeddings
 * are stored unit-normalized — so this is a plain dot product.
 */
export function cosine(a, b) {
  const len = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < len; i++) s += a[i] * b[i];
  return s;
}

/**
 * Recognize every face detected in `image`. Each result:
 *   {
 *     bbox: [x1, y1, x2, y2],
 *     quality: number,
 *     person_id: number | null,    // null = unknown / below threshold
 *     person_name: string | null,
 *     similarity: number,           // best similarity to any known person
 *     decision: "match" | "unknown" | "low_quality",
 *   }
 *
 * Side-effect: every face is logged to face_matches (for chat history /
 * audits). Pass { recordMatch: false } to skip logging in tests.
 */
export async function recognize(
  image,
  {
    camera = "",
    event_id = null,
    recordMatch = true,
    track_session_id = null,
    frigate_event_id = null,
    imgW = 0,
    imgH = 0,
    tenant_id = "default",
  } = {},
) {
  const out = await embed(image);
  const { rows, vecs } = await ensureLoaded();
  const settings = recordMatch ? getSettings() : null;
  const results = [];

  for (const f of out.faces ?? []) {
    const probeQuality = Number(f.quality ?? 0);
    if (probeQuality < MIN_DETECTOR_QUALITY) {
      results.push({
        bbox: f.bbox,
        quality: probeQuality,
        person_id: null,
        person_name: null,
        similarity: 0,
        decision: "low_quality",
      });
      continue;
    }
    const probe = Float32Array.from(f.embedding ?? []);
    let bestIdx = -1;
    let bestSim = -Infinity;
    for (let i = 0; i < vecs.length; i++) {
      const s = cosine(probe, vecs[i]);
      if (s > bestSim) { bestSim = s; bestIdx = i; }
    }
    const matched = bestIdx >= 0 && bestSim >= MATCH_THRESHOLD;
    const personRow = matched ? rows[bestIdx] : null;
    const result = {
      bbox: f.bbox,
      quality: probeQuality,
      person_id: matched ? personRow.person_id : null,
      person_name: matched ? personRow.person_name : null,
      similarity: matched ? bestSim : (bestIdx >= 0 ? bestSim : 0),
      decision: matched ? "match" : "unknown",
    };
    let match_id = null;
    let cluster_id = null;

    if (recordMatch && cachedDb && camera) {
      try {
        const storeVec = settings?.store_match_vectors !== false;
        const probe = Float32Array.from(f.embedding ?? []);
        const linkedTrack =
          settings?.link_tracks !== false && imgW && imgH
            ? findTrackForFace(camera, f.bbox, imgW, imgH) ?? track_session_id
            : track_session_id;
        const ins = insertFaceMatchExtended(cachedDb, {
          tenant_id,
          camera,
          event_id,
          person_id: result.person_id,
          similarity: result.similarity,
          bbox: result.bbox,
          quality: result.quality,
          model: STORED_MODEL_TAG,
          vec: storeVec && probe.length ? probe : null,
          vec_dim: storeVec ? VEC_DIM : null,
          track_session_id: settings?.link_tracks !== false ? linkedTrack : null,
          frigate_event_id:
            settings?.link_frigate_clips ? frigate_event_id : null,
        });
        match_id = ins.id;

        if (
          result.decision === "unknown" &&
          settings?.cluster_unknown_faces &&
          storeVec &&
          probe.length
        ) {
          const cl = await clusterUnknownMatch({
            match_id,
            vec: probe,
            model: STORED_MODEL_TAG,
            camera,
            quality: result.quality,
            settings,
            tenant_id,
          });
          cluster_id = cl.cluster_id;
        }

        if (linkedTrack && settings?.link_tracks !== false) {
          updateTrackIdentity(cachedDb, linkedTrack, {
            person_id: result.person_id,
            cluster_id,
            frigate_event_id: settings?.link_frigate_clips ? frigate_event_id : null,
          });
        }

        if (
          settings?.store_match_thumbnails !== false &&
          match_id &&
          Array.isArray(f.bbox) &&
          f.bbox.length === 4 &&
          image?.length
        ) {
          try {
            const maxPx = Number(settings.thumbnail_max_px ?? 256) || 256;
            const rel = await saveFaceThumb(image, f.bbox, {
              kind: "match",
              id: match_id,
              maxPx,
            });
            updateFaceMatchThumb(cachedDb, match_id, rel);
          } catch (thumbErr) {
            console.warn("[face] thumb save failed:", thumbErr?.message);
          }
        }
      } catch (err) {
        console.warn("[face] insertFaceMatchExtended failed:", err?.message);
      }
    }

    results.push({ ...result, match_id, cluster_id });
  }
  return {
    ok: true,
    model: STORED_MODEL_TAG,
    embedder_took_ms: out.took_ms,
    known_count: rows.length,
    threshold: MATCH_THRESHOLD,
    faces: results,
  };
}

// Constants exported for /api/agent/status and tests.
export const FACE_CONFIG = Object.freeze({
  url: FACE_EMBEDDER_URL,
  model_tag: STORED_MODEL_TAG,
  vec_dim: VEC_DIM,
  match_threshold: MATCH_THRESHOLD,
  min_detector_quality: MIN_DETECTOR_QUALITY,
});
