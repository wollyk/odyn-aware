// Phase-15 timeline scrubber — supporting schema + read helpers.
//
// Why a separate module:
//   - face-identity.mjs already owns the face_matches table; this module
//     piggybacks on it with one additive column (created_ms) and one
//     read helper (listMatchesInWindow) used by /api/agent/timeline/*.
//   - Keeping these in their own file makes the migration easy to reason
//     about and lets us unit-test the SQL in isolation.
//
// Column rationale:
//   `created_at` is an ISO-8601 TEXT. Range-scanning by time means
//   string comparison (fine when zero-padded — which we do), but
//   client-side we work in JS Date.now() ms and would otherwise be
//   converting both ends. `created_ms` is the same instant in JS ms,
//   so the timeline can do `WHERE created_ms BETWEEN ? AND ?` with a
//   pure integer index — fast and obvious.

export function applyFaceTimelineSchema(db) {
  // Add the column if it isn't there yet. SQLite has no IF NOT EXISTS for
  // ADD COLUMN; the duplicate-error catch is how every other migration in
  // this codebase handles it.
  try {
    db.exec("ALTER TABLE face_matches ADD COLUMN created_ms INTEGER");
  } catch (err) {
    if (!/duplicate column name/i.test(err?.message ?? "")) throw err;
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fm_cam_ms
      ON face_matches(tenant_id, camera, created_ms DESC);
  `);

  // Backfill any rows where created_ms is still null. julianday returns
  // days since 4713-11-24 noon UTC; the Unix epoch in that calendar is
  // 2440587.5. Multiplying the delta by 86_400_000 yields JS ms.
  db.exec(`
    UPDATE face_matches
       SET created_ms = CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER)
     WHERE created_ms IS NULL AND created_at IS NOT NULL;
  `);
}

/**
 * Range-scan face_matches for the timeline UI.
 *
 * Returned shape mirrors what the route hands the client:
 *   { id, ts_ms, camera, person_id, person_name, similarity, quality, bbox, thumb_path }
 *
 * Note: `bbox` is parsed from bbox_json (or null). Caller is responsible
 * for turning thumb_path into a thumb_url (route layer does that).
 */
export function listMatchesInWindow(
  db,
  {
    tenant_id = "default",
    camera,
    start_ms,
    end_ms,
    person_id = null,
    limit = 500,
  } = {},
) {
  if (!camera) throw new Error("camera_required");
  if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms)) {
    throw new Error("invalid_window");
  }
  if (end_ms <= start_ms) throw new Error("invalid_window");

  const where = [
    "fm.tenant_id = @tenant_id",
    "fm.camera = @camera",
    "fm.created_ms >= @start_ms",
    "fm.created_ms <  @end_ms",
  ];
  const params = { tenant_id, camera, start_ms, end_ms };

  if (person_id === "unknown") {
    where.push("fm.person_id IS NULL");
  } else if (person_id !== null && person_id !== undefined) {
    where.push("fm.person_id = @person_id");
    params.person_id = Number(person_id);
  }
  params.limit = Math.min(Math.max(Number(limit) || 500, 1), 5000);

  return db
    .prepare(
      `SELECT fm.id, fm.created_ms AS ts_ms, fm.camera,
              fm.person_id, p.name AS person_name,
              fm.similarity, fm.quality, fm.bbox_json, fm.thumb_path
         FROM face_matches fm
    LEFT JOIN people p ON p.id = fm.person_id
        WHERE ${where.join(" AND ")}
        ORDER BY fm.created_ms ASC
        LIMIT @limit`,
    )
    .all(params)
    .map((r) => ({
      id: r.id,
      ts_ms: r.ts_ms,
      camera: r.camera,
      person_id: r.person_id,
      person_name: r.person_name,
      similarity: r.similarity,
      quality: r.quality,
      bbox: r.bbox_json ? safeParseBbox(r.bbox_json) : null,
      thumb_path: r.thumb_path,
    }));
}

function safeParseBbox(json) {
  try {
    const v = JSON.parse(json);
    if (
      Array.isArray(v) &&
      v.length === 4 &&
      v.every((n) => typeof n === "number")
    ) {
      return v;
    }
  } catch {
    /* fall through */
  }
  return null;
}
