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

import { z } from "zod";
import {
  createPerson,
  findPersonByName,
  listPeople,
  archivePerson,
  insertFaceEmbedding,
  listRecentFaceMatches,
} from "../db.mjs";
import { send, readJson, requireAdmin } from "../http-utils.mjs";

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
    const embedding_id = insertFaceEmbedding(db, {
      person_id: person.id,
      model: harness.FACE_CONFIG.model_tag,
      vec: embedding,
      quality: bestRaw.quality,
      source: "enrollment",
      photo_path: null,
      created_by: me.user_id,
    });
    harness.invalidateFaceCache();

    send(res, 200, {
      ok: true,
      person: { id: person.id, name: person.name, notes: person.notes },
      embedding: {
        id: embedding_id,
        quality: bestRaw.quality,
        vec_dim: embedding.length,
        model: harness.FACE_CONFIG.model_tag,
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
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
    try {
      const rows = listRecentFaceMatches(db, { camera, person_id, limit });
      send(res, 200, { rows, count: rows.length });
    } catch (err) {
      send(res, 500, { error: "matches_failed", detail: err.message });
    }
    return true;
  }

  return false;
}
