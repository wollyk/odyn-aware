// Helpers: link faces to tracks / Frigate clips; search by probe vector.

import { listTrackObservations } from "../db/tracks.mjs";
import {
  getFaceIdentitySettings,
  listFaceMatchesForSearch,
} from "../db/face-identity.mjs";
import { cosine } from "./face.mjs";

let cachedDb = null;

export function init({ db }) {
  cachedDb = db;
}

export function getSettings() {
  if (!cachedDb) return null;
  return getFaceIdentitySettings(cachedDb);
}

/**
 * Find open track session whose normalized bbox contains the face center.
 */
export function findTrackForFace(camera, faceBboxAbs, imgW, imgH) {
  if (!cachedDb || !camera || !imgW || !imgH || !Array.isArray(faceBboxAbs)) return null;
  const cx = (faceBboxAbs[0] + faceBboxAbs[2]) / 2 / imgW;
  const cy = (faceBboxAbs[1] + faceBboxAbs[3]) / 2 / imgH;
  const rows = listTrackObservations(cachedDb, {
    camera,
    openOnly: true,
    sinceMs: Date.now() - 15_000,
    limit: 50,
  });
  for (const t of rows) {
    const x = t.bbox_x;
    const y = t.bbox_y;
    const w = t.bbox_w;
    const h = t.bbox_h;
    if (cx >= x && cx <= x + w && cy >= y && cy <= y + h) {
      return t.session_id;
    }
  }
  return null;
}

/**
 * Best-effort: newest Frigate event with a clip in the last ~60s.
 */
export async function findFrigateEventId(frigate, camera) {
  if (!frigate?.getEvents || !camera) return null;
  try {
    const after = Math.floor(Date.now() / 1000) - 60;
    const events = await frigate.getEvents({
      camera,
      limit: 10,
      has_clip: true,
      after,
    });
    const list = Array.isArray(events) ? events : [];
    const open = list.find((e) => !e.end_time);
    return (open ?? list[0])?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Scan stored match vectors for cosine >= threshold.
 */
export function searchByVector(probe, { model, threshold, since_ms, limit = 25 } = {}) {
  if (!cachedDb || !probe?.length) return [];
  const rows = listFaceMatchesForSearch(cachedDb, { model, since_ms, limit: 5000 });
  const hits = [];
  for (const r of rows) {
    if (!r.vec?.length) continue;
    const sim = cosine(probe, r.vec);
    if (sim >= threshold) {
      hits.push({
        match_id: r.id,
        created_at: r.created_at,
        camera: r.camera,
        person_id: r.person_id,
        person_name: r.person_name,
        similarity: Number(sim.toFixed(4)),
        quality: r.quality,
        frigate_event_id: r.frigate_event_id,
        cluster_id: r.cluster_id,
        thumb_path: r.thumb_path ?? null,
        has_thumb: Boolean(r.thumb_path),
      });
    }
  }
  hits.sort((a, b) => b.similarity - a.similarity);
  return hits.slice(0, limit);
}
