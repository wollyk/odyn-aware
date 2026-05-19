// Online clustering for unknown faces. Gated by admin face_identity settings.

import { publish } from "./eventbus.mjs";
import { TOPIC } from "./types.mjs";
import { cosine } from "./face.mjs";
import {
  loadClusterCentroids,
  createFaceCluster,
  mergeIntoFaceCluster,
  updateFaceMatchCluster,
  getFaceCluster,
} from "../db/face-identity.mjs";
import { buildAlertPayload } from "./alerts.mjs";

let cachedDb = null;
let centroidCache = null;
let centroidCacheAt = 0;
const CACHE_TTL_MS = 60_000;

export function init({ db }) {
  cachedDb = db;
}

export function invalidateClusterCache() {
  centroidCache = null;
  centroidCacheAt = 0;
}

async function ensureCentroids(model, tenant_id = "default") {
  if (!cachedDb) return [];
  const now = Date.now();
  if (centroidCache && now - centroidCacheAt < CACHE_TTL_MS) return centroidCache;
  centroidCache = loadClusterCentroids(cachedDb, { tenant_id, model });
  centroidCacheAt = now;
  return centroidCache;
}

/**
 * Assign an unknown-face match to a cluster (or create one).
 * Returns { cluster_id, member_count, alert_fired }.
 */
export async function clusterUnknownMatch(
  {
    match_id,
    vec,
    model,
    camera,
    quality,
    settings,
    tenant_id = "default",
  },
) {
  if (!cachedDb || !settings?.cluster_unknown_faces || !vec?.length) {
    return { cluster_id: null, member_count: 0, alert_fired: false };
  }

  const threshold = Number(settings.cluster_merge_threshold ?? 0.55);
  const centroids = await ensureCentroids(model, tenant_id);
  let bestId = -1;
  let bestSim = -Infinity;
  for (let i = 0; i < centroids.length; i++) {
    const s = cosine(vec, centroids[i].vec);
    if (s > bestSim) {
      bestSim = s;
      bestId = centroids[i].id;
    }
  }

  const seen_at = new Date().toISOString();
  let clusterId;
  let prevCount = 0;

  if (bestId >= 0 && bestSim >= threshold) {
    const row = centroids.find((c) => c.id === bestId);
    prevCount = row?.member_count ?? 0;
    const merged = mergeCentroid(row.vec, vec, prevCount + 1);
    mergeIntoFaceCluster(cachedDb, bestId, {
      centroid: merged,
      camera,
      match_id,
      quality,
      seen_at,
    });
    clusterId = bestId;
  } else {
    clusterId = createFaceCluster(cachedDb, {
      tenant_id,
      centroid: normalizeVec(vec),
      vec_dim: vec.length,
      model,
      camera,
      match_id,
      quality,
      seen_at,
    });
    invalidateClusterCache();
  }

  updateFaceMatchCluster(cachedDb, match_id, clusterId);

  const updated = getFaceCluster(cachedDb, clusterId);
  const memberCount = updated?.member_count ?? 1;
  const minAlert = Number(settings.cluster_alert_min_sightings ?? 0);
  let alert_fired = false;
  if (
    minAlert > 0 &&
    prevCount < minAlert &&
    memberCount >= minAlert
  ) {
    try {
      const cameras = safeParseArray(updated.cameras_json);
      publish(
        TOPIC.ALERT,
        buildAlertPayload({
          event_id: `cluster_${clusterId}_${Date.now()}`,
          camera: camera || cameras[0] || "unknown",
          tenant_id,
          result: {
            severity: "notable",
            alert_type: "recurring_stranger",
            summary: `Recurring unknown visitor (cluster #${clusterId}, ${memberCount} sightings).`,
            confidence: bestSim >= 0 ? bestSim : 0.5,
            known_face_count: 0,
            unknown_face_count: 1,
            weapon: { decision: "clear" },
          },
        }),
      );
      alert_fired = true;
    } catch (err) {
      console.warn("[face_cluster] alert publish failed:", err?.message);
    }
  }

  invalidateClusterCache();
  return { cluster_id: clusterId, member_count: memberCount, alert_fired };
}

function mergeCentroid(oldVec, newVec, newCount) {
  const n = Math.min(oldVec.length, newVec.length);
  const out = new Float32Array(n);
  const wOld = (newCount - 1) / newCount;
  const wNew = 1 / newCount;
  for (let i = 0; i < n; i++) out[i] = oldVec[i] * wOld + newVec[i] * wNew;
  return normalizeVec(out);
}

function normalizeVec(v) {
  const arr = v instanceof Float32Array ? v : Float32Array.from(v);
  let n = 0;
  for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < arr.length; i++) arr[i] /= n;
  return arr;
}

function safeParseArray(s) {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
