// Face identity log — schema + queries for searchable matches and clusters.
//
// Extends the Phase-4 face_matches table with optional embedding storage,
// track linkage, Frigate clip ids, and online stranger clustering. All
// expensive behaviors are gated by site_settings key `face_identity`
// (see harness/face_settings.mjs).

import { vecToBlob, blobToVec } from "../db.mjs";

const SETTINGS_KEY = "face_identity";

/** Default admin config (overridable via PUT /api/agent/faces/settings). */
export const DEFAULT_FACE_IDENTITY_SETTINGS = Object.freeze({
  /** Persist 512-d vectors on face_matches for search / re-identify. */
  store_match_vectors: true,
  /** Group unknown faces into face_clusters. */
  cluster_unknown_faces: true,
  cluster_merge_threshold: 0.55,
  /** Publish TOPIC.ALERT when a cluster hits this many sightings (0 = off). */
  cluster_alert_min_sightings: 3,
  /** Link face_matches.track_session_id to track_observations. */
  link_tracks: true,
  /** Resolve frigate_event_id on each match (extra Frigate API call). */
  link_frigate_clips: false,
  /** Cosine threshold for POST /search and agent find_similar_faces. */
  search_similarity_threshold: 0.45,
  /** Save a small JPEG crop per face_match for admin review / search UI. */
  store_match_thumbnails: true,
  /** Long edge of stored match thumbnails (pixels). */
  thumbnail_max_px: 256,
  /** Save enroll photo crop on face_embeddings.photo_path. */
  store_enroll_thumbnails: true,
});

export function applyFaceIdentitySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key           TEXT PRIMARY KEY,
      value_json    TEXT NOT NULL,
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS face_clusters (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id             TEXT NOT NULL DEFAULT 'default',
      centroid_blob         BLOB NOT NULL,
      vec_dim               INTEGER NOT NULL,
      model                 TEXT NOT NULL,
      member_count          INTEGER NOT NULL DEFAULT 0,
      best_quality          REAL NOT NULL DEFAULT 0,
      best_match_id         INTEGER REFERENCES face_matches(id) ON DELETE SET NULL,
      cameras_json          TEXT NOT NULL DEFAULT '[]',
      first_seen_at         TEXT NOT NULL,
      last_seen_at          TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'unreviewed'
                            CHECK (status IN ('unreviewed','ignored','promoted')),
      promoted_to_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      notes                 TEXT,
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fc_status ON face_clusters(tenant_id, status, last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fc_members ON face_clusters(tenant_id, member_count DESC, last_seen_at DESC);
  `);

  const alters = [
    "ALTER TABLE face_matches ADD COLUMN vec_dim INTEGER",
    "ALTER TABLE face_matches ADD COLUMN vec_blob BLOB",
    "ALTER TABLE face_matches ADD COLUMN track_session_id TEXT",
    "ALTER TABLE face_matches ADD COLUMN frigate_event_id TEXT",
    "ALTER TABLE face_matches ADD COLUMN cluster_id INTEGER REFERENCES face_clusters(id) ON DELETE SET NULL",
    "ALTER TABLE face_matches ADD COLUMN thumb_path TEXT",
    "ALTER TABLE track_observations ADD COLUMN frigate_event_id TEXT",
    "ALTER TABLE track_observations ADD COLUMN last_known_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL",
    "ALTER TABLE track_observations ADD COLUMN last_known_cluster_id INTEGER REFERENCES face_clusters(id) ON DELETE SET NULL",
  ];
  for (const sql of alters) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(err?.message ?? "")) throw err;
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fm_track ON face_matches(track_session_id);
    CREATE INDEX IF NOT EXISTS idx_fm_frigate ON face_matches(frigate_event_id);
    CREATE INDEX IF NOT EXISTS idx_fm_cluster ON face_matches(cluster_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_fm_unknown ON face_matches(tenant_id, created_at DESC)
      WHERE person_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_fm_person_t ON face_matches(person_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tobs_person ON track_observations(last_known_person_id, last_seen_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_tobs_cluster ON track_observations(last_known_cluster_id, last_seen_ms DESC);
  `);

  seedDefaultSettings(db);
}

function seedDefaultSettings(db) {
  const row = db.prepare(`SELECT key FROM site_settings WHERE key = ?`).get(SETTINGS_KEY);
  if (row) return;
  db.prepare(
    `INSERT INTO site_settings (key, value_json) VALUES (?, ?)`,
  ).run(SETTINGS_KEY, JSON.stringify(DEFAULT_FACE_IDENTITY_SETTINGS));
}

export function getFaceIdentitySettings(db, { tenant_id: _t = "default" } = {}) {
  const row = db.prepare(`SELECT value_json, updated_at, updated_by FROM site_settings WHERE key = ?`).get(SETTINGS_KEY);
  if (!row) return { ...DEFAULT_FACE_IDENTITY_SETTINGS };
  try {
    return { ...DEFAULT_FACE_IDENTITY_SETTINGS, ...JSON.parse(row.value_json) };
  } catch {
    return { ...DEFAULT_FACE_IDENTITY_SETTINGS };
  }
}

export function setFaceIdentitySettings(db, settings, { updated_by = null } = {}) {
  const merged = { ...DEFAULT_FACE_IDENTITY_SETTINGS, ...settings };
  db.prepare(
    `INSERT INTO site_settings (key, value_json, updated_by, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`,
  ).run(SETTINGS_KEY, JSON.stringify(merged), updated_by);
  return merged;
}

/**
 * Extended face_matches insert. Returns { lastInsertRowid }.
 */
export function insertFaceMatchExtended(
  db,
  {
    tenant_id = "default",
    camera,
    event_id = null,
    person_id = null,
    similarity,
    bbox = null,
    quality = null,
    model,
    vec = null,
    vec_dim = null,
    track_session_id = null,
    frigate_event_id = null,
    cluster_id = null,
    thumb_path = null,
  } = {},
) {
  const blob = vec ? vecToBlob(vec) : null;
  const dim = blob ? (vec_dim ?? (vec instanceof Float32Array ? vec.length : vec?.length)) : null;
  const info = db
    .prepare(
      `INSERT INTO face_matches
        (tenant_id, camera, event_id, person_id, similarity, bbox_json, quality, model,
         vec_dim, vec_blob, track_session_id, frigate_event_id, cluster_id, thumb_path)
       VALUES
        (@tenant_id, @camera, @event_id, @person_id, @similarity, @bbox_json, @quality, @model,
         @vec_dim, @vec_blob, @track_session_id, @frigate_event_id, @cluster_id, @thumb_path)`,
    )
    .run({
      tenant_id,
      camera,
      event_id,
      person_id,
      similarity,
      bbox_json: bbox ? JSON.stringify(bbox) : null,
      quality,
      model,
      vec_dim: dim,
      vec_blob: blob,
      track_session_id,
      frigate_event_id,
      cluster_id,
      thumb_path,
    });
  return { id: Number(info.lastInsertRowid) };
}

export function updateFaceMatchThumb(db, matchId, thumb_path) {
  return db.prepare(`UPDATE face_matches SET thumb_path = ? WHERE id = ?`).run(thumb_path, matchId);
}

export function getFaceMatchThumbPath(db, matchId) {
  const row = db.prepare(`SELECT thumb_path FROM face_matches WHERE id = ?`).get(matchId);
  return row?.thumb_path ?? null;
}

export function updateFaceMatchCluster(db, matchId, clusterId) {
  db.prepare(`UPDATE face_matches SET cluster_id = ? WHERE id = ?`).run(clusterId, matchId);
}

export function listFaceClusters(
  db,
  { tenant_id = "default", status = "unreviewed", limit = 50 } = {},
) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return db
    .prepare(
      `SELECT id, tenant_id, vec_dim, model, member_count, best_quality, best_match_id,
              cameras_json, first_seen_at, last_seen_at, status, promoted_to_person_id, notes,
              created_at, updated_at
         FROM face_clusters
        WHERE tenant_id = ? AND status = ?
        ORDER BY member_count DESC, last_seen_at DESC
        LIMIT ?`,
    )
    .all(tenant_id, status, lim);
}

export function getFaceCluster(db, id) {
  return db.prepare(`SELECT * FROM face_clusters WHERE id = ?`).get(id);
}

export function loadClusterCentroids(db, { tenant_id = "default", model } = {}) {
  const rows = db
    .prepare(
      `SELECT id, centroid_blob, vec_dim, member_count, cameras_json, status
         FROM face_clusters
        WHERE tenant_id = ? AND model = ? AND status = 'unreviewed'`,
    )
    .all(tenant_id, model);
  return rows.map((r) => ({
    id: r.id,
    member_count: r.member_count,
    cameras_json: safeParseArray(r.cameras_json),
    vec: blobToVec(r.centroid_blob),
  }));
}

export function createFaceCluster(
  db,
  {
    tenant_id = "default",
    centroid,
    vec_dim,
    model,
    camera,
    match_id,
    quality,
    seen_at,
  },
) {
  const now = seen_at ?? new Date().toISOString();
  const cameras = camera ? JSON.stringify([camera]) : "[]";
  const info = db
    .prepare(
      `INSERT INTO face_clusters
        (tenant_id, centroid_blob, vec_dim, model, member_count, best_quality, best_match_id,
         cameras_json, first_seen_at, last_seen_at)
       VALUES
        (@tenant_id, @centroid_blob, @vec_dim, @model, 1, @best_quality, @best_match_id,
         @cameras_json, @first_seen_at, @last_seen_at)`,
    )
    .run({
      tenant_id,
      centroid_blob: vecToBlob(centroid),
      vec_dim,
      model,
      best_quality: quality ?? 0,
      best_match_id: match_id,
      cameras_json: cameras,
      first_seen_at: now,
      last_seen_at: now,
    });
  return Number(info.lastInsertRowid);
}

export function mergeIntoFaceCluster(
  db,
  clusterId,
  { centroid, camera, match_id, quality, seen_at },
) {
  const row = getFaceCluster(db, clusterId);
  if (!row) return null;
  const cameras = new Set(safeParseArray(row.cameras_json));
  if (camera) cameras.add(camera);
  const newQuality = Math.max(row.best_quality ?? 0, quality ?? 0);
  const bestMatchId =
    (quality ?? 0) >= (row.best_quality ?? 0) ? match_id : row.best_match_id;
  db.prepare(
    `UPDATE face_clusters SET
       centroid_blob = @centroid_blob,
       member_count = member_count + 1,
       best_quality = @best_quality,
       best_match_id = COALESCE(@best_match_id, best_match_id),
       cameras_json = @cameras_json,
       last_seen_at = @last_seen_at,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = @id`,
  ).run({
    id: clusterId,
    centroid_blob: vecToBlob(centroid),
    best_quality: newQuality,
    best_match_id: bestMatchId,
    cameras_json: JSON.stringify([...cameras]),
    last_seen_at: seen_at ?? new Date().toISOString(),
  });
  return clusterId;
}

export function setClusterStatus(db, id, status, { promoted_to_person_id = null, notes = null } = {}) {
  return db
    .prepare(
      `UPDATE face_clusters SET
         status = @status,
         promoted_to_person_id = @promoted_to_person_id,
         notes = COALESCE(@notes, notes),
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = @id`,
    )
    .run({ id, status, promoted_to_person_id, notes });
}

export function listFaceMatchesForSearch(
  db,
  { tenant_id = "default", model, since_ms = null, limit = 5000 } = {},
) {
  const where = ["fm.tenant_id = @tenant_id", "fm.model = @model", "fm.vec_blob IS NOT NULL"];
  const params = { tenant_id, model, limit: Math.min(limit, 10000) };
  if (since_ms) {
    where.push("fm.created_at >= @since_iso");
    params.since_iso = new Date(since_ms).toISOString();
  }
  return db
    .prepare(
      `SELECT fm.id, fm.created_at, fm.camera, fm.person_id, fm.similarity,
              fm.quality, fm.frigate_event_id, fm.cluster_id, fm.thumb_path,
              fm.vec_blob, fm.vec_dim,
              p.name AS person_name
         FROM face_matches fm
    LEFT JOIN people p ON p.id = fm.person_id
        WHERE ${where.join(" AND ")}
        ORDER BY fm.id DESC
        LIMIT @limit`,
    )
    .all(params)
    .map((r) => ({
      ...r,
      vec: blobToVec(r.vec_blob),
    }));
}

export function findPersonSightings(
  db,
  {
    tenant_id = "default",
    person_id,
    camera = null,
    since_ms = null,
    until_ms = null,
    limit = 100,
  } = {},
) {
  const where = ["fm.tenant_id = @tenant_id", "fm.person_id = @person_id"];
  const params = { tenant_id, person_id, limit: Math.min(Math.max(limit, 1), 500) };
  if (camera) {
    where.push("fm.camera = @camera");
    params.camera = camera;
  }
  if (since_ms) {
    where.push("fm.created_at >= @since_iso");
    params.since_iso = new Date(since_ms).toISOString();
  }
  if (until_ms) {
    where.push("fm.created_at <= @until_iso");
    params.until_iso = new Date(until_ms).toISOString();
  }
  return db
    .prepare(
      `SELECT fm.id, fm.created_at, fm.camera, fm.similarity, fm.quality,
              fm.frigate_event_id, fm.track_session_id, fm.event_id, fm.cluster_id,
              p.name AS person_name
         FROM face_matches fm
    LEFT JOIN people p ON p.id = fm.person_id
        WHERE ${where.join(" AND ")}
        ORDER BY fm.created_at DESC
        LIMIT @limit`,
    )
    .all(params);
}

export function getFaceMatchVector(db, matchId) {
  const row = db
    .prepare(
      `SELECT vec_blob, vec_dim, quality, model FROM face_matches WHERE id = ? AND vec_blob IS NOT NULL`,
    )
    .get(matchId);
  if (!row) return null;
  return {
    vec: blobToVec(row.vec_blob),
    vec_dim: row.vec_dim,
    quality: row.quality,
    model: row.model,
  };
}

export function updateTrackIdentity(
  db,
  sessionId,
  { person_id = null, cluster_id = null, frigate_event_id = null } = {},
) {
  const sets = [];
  const params = { session_id: sessionId };
  if (person_id !== undefined) {
    sets.push("last_known_person_id = @person_id");
    params.person_id = person_id;
  }
  if (cluster_id !== undefined) {
    sets.push("last_known_cluster_id = @cluster_id");
    params.cluster_id = cluster_id;
  }
  if (frigate_event_id !== undefined) {
    sets.push("frigate_event_id = @frigate_event_id");
    params.frigate_event_id = frigate_event_id;
  }
  if (sets.length === 0) return { changes: 0 };
  return db
    .prepare(
      `UPDATE track_observations SET ${sets.join(", ")}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE session_id = @session_id AND closed_at_ms IS NULL`,
    )
    .run(params);
}

function safeParseArray(s) {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
