// Phase 4: Face DB endpoints.
//
// All routes require an admin session — faces are PII, even just names.
//
// Storage policy (matches the design doc): we keep the embedding in
// SQLite by default and DROP the original photo. If we later add an
// "enable photo retention" flag we can plumb it through here without
// touching the embedder.
//
// Surface:
//   GET    /api/agent/faces/people              list active (or ?status=archived)
//   DELETE /api/agent/faces/people/:id          archive a person
//   POST   /api/agent/faces/enroll              base64 image -> embedding
//   POST   /api/agent/faces/recognize-now       live snapshot -> face[]
//   GET    /api/agent/faces/matches             recent face_matches log
//   GET    /api/agent/faces/settings            admin identity config
//   PUT    /api/agent/faces/settings            update identity config
//   GET    /api/agent/faces/clusters            recurring stranger clusters
//   POST   /api/agent/faces/clusters/:id/promote  name a stranger → people
//   POST   /api/agent/faces/clusters/:id/ignore   dismiss cluster
//   POST   /api/agent/faces/search              find similar faces in history
//   GET    /api/agent/faces/sightings           person timeline search
//   GET    /api/agent/faces/matches/:id/thumb   face crop JPEG (admin)
//   GET    /api/agent/faces/embeddings/:id/thumb enroll crop JPEG (admin)

import { z } from "zod";
import {
  DEFAULT_FACE_IDENTITY_SETTINGS,
  getFaceIdentitySettings,
  getFaceMatchVector,
  getFaceCluster,
  getFaceMatchThumbPath,
} from "../db/face-identity.mjs";
import {
  createPerson,
  findPersonByName,
  listPeople,
  archivePerson,
  insertFaceEmbedding,
  listRecentFaceMatches,
  updateFaceEmbeddingPhotoPath,
  getFaceEmbeddingPhotoPath,
} from "../db.mjs";
import { send, readJson, requireAdmin } from "../http-utils.mjs";
import { readFaceThumb, saveFaceThumb } from "../util/face-thumb.mjs";

const settingsSchema = z.object({
  store_match_vectors: z.boolean().optional(),
  cluster_unknown_faces: z.boolean().optional(),
  cluster_merge_threshold: z.number().min(0.3).max(0.95).optional(),
  cluster_alert_min_sightings: z.number().int().min(0).max(100).optional(),
  link_tracks: z.boolean().optional(),
  link_frigate_clips: z.boolean().optional(),
  search_similarity_threshold: z.number().min(0.3).max(0.95).optional(),
  store_match_thumbnails: z.boolean().optional(),
  thumbnail_max_px: z.number().int().min(64).max(512).optional(),
  store_enroll_thumbnails: z.boolean().optional(),
});

function sendThumb(res, jpegBuffer) {
  res.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Cache-Control": "private, max-age=3600",
    "Content-Length": jpegBuffer.length,
  });
  res.end(jpegBuffer);
}

const enrollSchema = z.object({
  name: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(500).optional(),
  image_base64: z.string().min(64),
  source_camera: z.string().optional(),
});

/**
 * Translate an embedder error into the right HTTP status:
 *   - embedder_http_4xx → 422 (caller's image is bad)
 *   - anything else     → 502 (sidecar is down)
 */
function sendEmbedderError(res, err, badImageError = "embedder_rejected_image") {
  const msg = err?.message ?? "";
  if (/embedder_http_4\d\d/.test(msg)) {
    send(res, 422, { error: badImageError, detail: msg });
  } else {
    send(res, 502, { error: "embedder_unreachable", detail: msg });
  }
}

export async function register(req, res, url, ctx) {
  const { db, frigate, harness } = ctx;

  // List known people.
  if (req.method === "GET" && url.pathname === "/api/agent/faces/people") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    try {
      const status = url.searchParams.get("status") === "archived" ? "archived" : "active";
      const rows = listPeople(db, { status });
      send(res, 200, { rows, count: rows.length });
    } catch (err) {
      send(res, 500, { error: "list_failed", detail: err.message });
    }
    return true;
  }

  // Archive (soft-delete). Embeddings cascade; face_matches keep the
  // person_id NULL'd via ON DELETE SET NULL so audit history survives.
  if (req.method === "DELETE" && url.pathname.startsWith("/api/agent/faces/people/")) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const id = Number(url.pathname.slice("/api/agent/faces/people/".length));
    if (!Number.isInteger(id) || id <= 0) {
      send(res, 400, { error: "invalid_id" });
      return true;
    }
    try {
      const r = archivePerson(db, id);
      harness.invalidateFaceCache();
      send(res, 200, { ok: true, archived: r.changes });
    } catch (err) {
      send(res, 500, { error: "archive_failed", detail: err.message });
    }
    return true;
  }

  // Enroll. Body: { name, notes?, image_base64, source_camera? }.
  // 10MB ceiling — comfortably above any phone-grade JPEG.
  if (req.method === "POST" && url.pathname === "/api/agent/faces/enroll") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;

    let body;
    try { body = await readJson(req, 10 * 1024 * 1024); }
    catch (err) { send(res, 400, { error: "bad_body", detail: err.message }); return true; }

    const parsed = enrollSchema.safeParse(body);
    if (!parsed.success) {
      send(res, 400, { error: "invalid_input", detail: parsed.error.issues });
      return true;
    }
    const { name, notes, image_base64 } = parsed.data;

    let imageBuffer;
    try {
      // Tolerate "data:image/jpeg;base64," prefix from frontend FileReader.
      const stripped = image_base64.replace(/^data:image\/[^;]+;base64,/, "");
      imageBuffer = Buffer.from(stripped, "base64");
      if (imageBuffer.length < 200) throw new Error("decoded image too small");
    } catch (err) {
      send(res, 400, { error: "bad_image", detail: err.message });
      return true;
    }

    let embedded;
    try {
      embedded = await harness.recognizeFaces({
        imageBuffer,
        camera: parsed.data.source_camera ?? "",
        recordMatch: false, // enrollment isn't a match event
      });
    } catch (err) { sendEmbedderError(res, err); return true; }

    if (!embedded?.faces?.length) {
      send(res, 422, { error: "no_face_detected", known_count: embedded?.known_count ?? 0 });
      return true;
    }
    // Use the highest-quality face. Multi-face frames are an operator
    // mistake — we surface the best one and warn via face_count_in_frame.
    const sorted = [...embedded.faces].sort((a, b) => b.quality - a.quality);
    const best = sorted[0];
    if (best.quality < 0.4) {
      send(res, 422, {
        error: "face_too_low_quality",
        quality: best.quality,
        hint: "Re-shoot with better light, ~1m from camera, looking forward.",
      });
      return true;
    }

    // Get-or-create the person.
    let person = findPersonByName(db, { name });
    if (!person) {
      person = createPerson(db, { name, notes: notes ?? null, created_by: me.user_id });
    }

    // Re-embed via the sidecar to get the raw 512-d vector. recognize() has
    // it but doesn't expose it; we want the storage-exact bytes.
    let rawEmbed;
    try { rawEmbed = await harness.embedFace({ imageBuffer }); }
    catch (err) { sendEmbedderError(res, err, "embedder_rejected_image_on_store"); return true; }

    const bestRaw = rawEmbed?.faces?.length
      ? [...rawEmbed.faces].sort((a, b) => b.quality - a.quality)[0]
      : null;
    if (!bestRaw) {
      send(res, 500, { error: "embedder_inconsistent", detail: "second-pass embed returned no face" });
      return true;
    }

    const embedding = Float32Array.from(bestRaw.embedding);
    const embedding_id = Number(
      insertFaceEmbedding(db, {
        person_id: person.id,
        model: harness.FACE_CONFIG.model_tag,
        vec: embedding,
        quality: bestRaw.quality,
        source: "enrollment",
        photo_path: null,
        created_by: me.user_id,
      }),
    );
    const identitySettings = getFaceIdentitySettings(db);
    let enroll_thumb_path = null;
    if (
      identitySettings.store_enroll_thumbnails !== false &&
      Array.isArray(bestRaw.bbox) &&
      bestRaw.bbox.length === 4
    ) {
      try {
        const maxPx = Number(identitySettings.thumbnail_max_px ?? 256) || 256;
        enroll_thumb_path = await saveFaceThumb(imageBuffer, bestRaw.bbox, {
          kind: "enroll",
          id: embedding_id,
          maxPx,
        });
        updateFaceEmbeddingPhotoPath(db, embedding_id, enroll_thumb_path);
      } catch (thumbErr) {
        console.warn("[faces/enroll] thumb save failed:", thumbErr?.message);
      }
    }
    harness.invalidateFaceCache();

    send(res, 200, {
      ok: true,
      person: { id: person.id, name: person.name, notes: person.notes },
      embedding: {
        id: embedding_id,
        quality: bestRaw.quality,
        vec_dim: embedding.length,
        model: harness.FACE_CONFIG.model_tag,
        thumb_path: enroll_thumb_path,
      },
      face_count_in_frame: embedded.faces.length,
    });
    return true;
  }

  // Recognize against a live snapshot — operator's "test recognition" button.
  if (req.method === "POST" && url.pathname === "/api/agent/faces/recognize-now") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let body;
    try { body = await readJson(req); }
    catch (err) { send(res, 400, { error: "bad_body", detail: err.message }); return true; }
    const camera = String(body?.camera ?? "").trim();
    if (!camera) { send(res, 400, { error: "camera_required" }); return true; }

    let snap;
    try { snap = await frigate.getSnapshot(camera, { height: 720 }); }
    catch (err) { send(res, 502, { error: "snapshot_failed", detail: err.message }); return true; }

    try {
      const r = await harness.recognizeFaces({
        imageBuffer: snap.body,
        camera,
        recordMatch: Boolean(body?.record),
      });
      send(res, 200, r);
    } catch (err) { sendEmbedderError(res, err); }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/faces/settings") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    send(res, 200, {
      settings: harness.getFaceIdentitySettings?.() ?? getFaceIdentitySettings(db),
      defaults: DEFAULT_FACE_IDENTITY_SETTINGS,
    });
    return true;
  }

  if (req.method === "PUT" && url.pathname === "/api/agent/faces/settings") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let body;
    try { body = await readJson(req); }
    catch (err) { send(res, 400, { error: "bad_body", detail: err.message }); return true; }
    const parsed = settingsSchema.safeParse(body?.settings ?? body);
    if (!parsed.success) {
      send(res, 400, { error: "invalid_settings", detail: parsed.error.issues });
      return true;
    }
    try {
      const merged = harness.saveFaceIdentitySettings(parsed.data, { updated_by: me.user_id });
      send(res, 200, { ok: true, settings: merged });
    } catch (err) {
      send(res, 500, { error: "save_failed", detail: err.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/faces/clusters") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const status = url.searchParams.get("status") || "unreviewed";
    const limit = Number(url.searchParams.get("limit") ?? 50);
    try {
      const rows = harness.listFaceClustersFromDb({ status, limit });
      send(res, 200, {
        rows: rows.map((r) => ({
          ...r,
          cameras: JSON.parse(r.cameras_json || "[]"),
        })),
        count: rows.length,
      });
    } catch (err) {
      send(res, 500, { error: "clusters_failed", detail: err.message });
    }
    return true;
  }

  const clusterPromoteMatch = url.pathname.match(/^\/api\/agent\/faces\/clusters\/(\d+)\/promote$/);
  if (req.method === "POST" && clusterPromoteMatch) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const clusterId = Number(clusterPromoteMatch[1]);
    let body;
    try { body = await readJson(req); }
    catch (err) { send(res, 400, { error: "bad_body" }); return true; }
    const name = String(body?.name ?? "").trim();
    if (!name) { send(res, 400, { error: "name_required" }); return true; }
    try {
      const cluster = getFaceCluster(db, clusterId);
      if (!cluster) { send(res, 404, { error: "cluster_not_found" }); return true; }
      let person = findPersonByName(db, { name });
      if (!person) {
        person = createPerson(db, { name, notes: body?.notes ?? null, created_by: me.user_id });
      }
      const matchId = cluster.best_match_id;
      const vecRow = matchId ? getFaceMatchVector(db, matchId) : null;
      if (vecRow?.vec) {
        insertFaceEmbedding(db, {
          person_id: person.id,
          model: vecRow.model ?? harness.FACE_CONFIG.model_tag,
          vec: vecRow.vec,
          quality: vecRow.quality ?? 0.5,
          source: "auto",
          created_by: me.user_id,
        });
      }
      harness.setFaceClusterStatus(clusterId, "promoted", {
        promoted_to_person_id: person.id,
      });
      harness.invalidateFaceCache();
      send(res, 200, { ok: true, person: { id: person.id, name: person.name }, cluster_id: clusterId });
    } catch (err) {
      send(res, 500, { error: "promote_failed", detail: err.message });
    }
    return true;
  }

  const clusterIgnoreMatch = url.pathname.match(/^\/api\/agent\/faces\/clusters\/(\d+)\/ignore$/);
  if (req.method === "POST" && clusterIgnoreMatch) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const clusterId = Number(clusterIgnoreMatch[1]);
    try {
      harness.setFaceClusterStatus(clusterId, "ignored");
      send(res, 200, { ok: true });
    } catch (err) {
      send(res, 500, { error: "ignore_failed", detail: err.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/faces/search") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let body;
    try { body = await readJson(req, 10 * 1024 * 1024); }
    catch (err) { send(res, 400, { error: "bad_body" }); return true; }
    const settings = getFaceIdentitySettings(db);
    if (!settings.store_match_vectors) {
      send(res, 403, { error: "search_disabled", detail: "Enable store_match_vectors in face settings." });
      return true;
    }
    let imageBuffer;
    try {
      const b64 = String(body?.image_base64 ?? "").replace(/^data:image\/[^;]+;base64,/, "");
      imageBuffer = Buffer.from(b64, "base64");
    } catch {
      send(res, 400, { error: "bad_image" });
      return true;
    }
    try {
      const raw = await harness.embedFace({ imageBuffer });
      const best = raw?.faces?.sort((a, b) => b.quality - a.quality)[0];
      if (!best?.embedding?.length) {
        send(res, 422, { error: "no_face_detected" });
        return true;
      }
      const probe = Float32Array.from(best.embedding);
      const since_ms = body?.since_ms ? Number(body.since_ms) : Date.now() - 7 * 86400000;
      const threshold = Number(body?.threshold ?? settings.search_similarity_threshold ?? 0.45);
      const hits = harness.searchFacesByProbe(probe, {
        model: harness.FACE_CONFIG.model_tag,
        threshold,
        since_ms,
        limit: Math.min(Number(body?.limit ?? 25), 100),
      });
      send(res, 200, { ok: true, count: hits.length, hits, threshold });
    } catch (err) {
      sendEmbedderError(res, err);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/faces/sightings") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const person_id = Number(url.searchParams.get("person_id"));
    if (!Number.isInteger(person_id) || person_id <= 0) {
      send(res, 400, { error: "person_id_required" });
      return true;
    }
    const camera = url.searchParams.get("camera") || null;
    const since = url.searchParams.get("since");
    const until = url.searchParams.get("until");
    const since_ms = since ? Date.parse(since) : Date.now() - 7 * 86400000;
    const until_ms = until ? Date.parse(until) : null;
    try {
      const rows = harness.findPersonSightingsFromDb({
        person_id,
        camera,
        since_ms: Number.isFinite(since_ms) ? since_ms : null,
        until_ms: until_ms && Number.isFinite(until_ms) ? until_ms : null,
        limit: Number(url.searchParams.get("limit") ?? 100),
      });
      send(res, 200, { rows, count: rows.length });
    } catch (err) {
      send(res, 500, { error: "sightings_failed", detail: err.message });
    }
    return true;
  }

  const matchThumbMatch = url.pathname.match(/^\/api\/agent\/faces\/matches\/(\d+)\/thumb$/);
  if (req.method === "GET" && matchThumbMatch) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const matchId = Number(matchThumbMatch[1]);
    try {
      const rel = getFaceMatchThumbPath(db, matchId);
      if (!rel) {
        send(res, 404, { error: "thumb_not_found" });
        return true;
      }
      const buf = await readFaceThumb(rel);
      sendThumb(res, buf);
    } catch (err) {
      send(res, err?.message?.includes("ENOENT") ? 404 : 500, {
        error: "thumb_read_failed",
        detail: err.message,
      });
    }
    return true;
  }

  const embedThumbMatch = url.pathname.match(/^\/api\/agent\/faces\/embeddings\/(\d+)\/thumb$/);
  if (req.method === "GET" && embedThumbMatch) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const embId = Number(embedThumbMatch[1]);
    try {
      const rel = getFaceEmbeddingPhotoPath(db, embId);
      if (!rel) {
        send(res, 404, { error: "thumb_not_found" });
        return true;
      }
      const buf = await readFaceThumb(rel);
      sendThumb(res, buf);
    } catch (err) {
      send(res, err?.message?.includes("ENOENT") ? 404 : 500, {
        error: "thumb_read_failed",
        detail: err.message,
      });
    }
    return true;
  }

  // Recent face_matches log.
  if (req.method === "GET" && url.pathname === "/api/agent/faces/matches") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const camera = url.searchParams.get("camera") || null;
    const personRaw = url.searchParams.get("person_id");
    const person_id =
      personRaw === "unknown" ? "unknown" :
      personRaw ? Number(personRaw) :
      null;
    const since = url.searchParams.get("since");
    const since_ms = since ? Date.parse(since) : null;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
    try {
      const rows = listRecentFaceMatches(db, {
        camera,
        person_id,
        since_ms: since_ms && Number.isFinite(since_ms) ? since_ms : null,
        limit,
      });
      send(res, 200, { rows, count: rows.length });
    } catch (err) {
      send(res, 500, { error: "matches_failed", detail: err.message });
    }
    return true;
  }

  return false;
}
