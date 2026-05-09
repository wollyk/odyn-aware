// Phase-11B persisted track timeline — REST routes.
//
// Two surfaces:
//
//   POST /api/tracker/ingest     ← sidecar. shared-secret auth.
//   GET  /api/agent/tracks       ← admin. paginated read.
//   GET  /api/agent/tracks/summary
//
// Auth split: ingest uses a static shared secret (TRACKER_INGEST_SECRET)
// because the sidecar lives outside the user-session world and can't
// hold a cookie. The read surfaces use the admin cookie like every
// other /api/agent/ route.
//
// Stale-closure: every ingest call also closes any open observation
// whose last_seen_ms is older than INGEST_STALE_GRACE_MS. The sidecar
// only ever sends "what I see right now" so this is the natural place
// to garbage-collect dead sessions without needing a Node-side timer.

import { z } from "zod";
import {
  upsertTrackObservations,
  closeStaleTrackObservations,
  listTrackObservations,
  trackObservationCounts,
} from "../db/tracks.mjs";
import { send, readJson, requireAdmin } from "../http-utils.mjs";

const INGEST_STALE_GRACE_MS = Number(
  process.env.TRACKER_INGEST_STALE_GRACE_MS ?? 30_000,
);

// Shared secret with the sidecar. If unset we DENY all ingest (so a
// half-configured deploy fails closed instead of accepting unsigned
// data). Op log makes the misconfig visible at boot.
const INGEST_SECRET = process.env.TRACKER_INGEST_SECRET ?? "";
if (!INGEST_SECRET) {
  // eslint-disable-next-line no-console
  console.warn(
    "[agent-tracks] TRACKER_INGEST_SECRET unset — /api/tracker/ingest will reject all requests (fail-closed).",
  );
}

const observationSchema = z.object({
  session_id: z.string().min(8).max(64),
  track_id: z.number().int(),
  label: z.string().min(1).max(64),
  conf: z.number().min(0).max(1.5),
  bbox: z.tuple([
    z.number().min(0).max(1.5),
    z.number().min(0).max(1.5),
    z.number().min(0).max(1.5),
    z.number().min(0).max(1.5),
  ]),
  motion: z.enum(["moving", "static", "warming"]).nullish(),
  verified: z.boolean().nullish(),
  frames_seen: z.number().int().min(1).optional(),
  first_seen_ms: z.number().int(),
  last_seen_ms: z.number().int(),
});

const ingestSchema = z.object({
  camera: z.string().min(1).max(64),
  observations: z.array(observationSchema).max(500),
});

/**
 * Constant-time secret compare. The values are small and the call site
 * is rate-limited by the upstream proxy, but resist the timing attack
 * anyway because it's a 6-line cost.
 */
function secureCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export async function register(req, res, url, ctx) {
  const { db } = ctx;

  // ---- Sidecar ingest ---------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/tracker/ingest") {
    if (!INGEST_SECRET) {
      send(res, 503, { error: "ingest_disabled", detail: "shared secret not configured" });
      return true;
    }
    const provided = req.headers["x-tracker-secret"];
    if (!secureCompare(String(provided ?? ""), INGEST_SECRET)) {
      send(res, 401, { error: "unauthorized" });
      return true;
    }
    let body;
    // Bigger limit than the default 32KB — a busy scene with 50 tracks
    // can produce ~30-50KB JSON. 256KB headroom is plenty.
    try { body = await readJson(req, 256 * 1024); }
    catch (err) { send(res, 400, { error: "bad_body", detail: err.message }); return true; }
    const parsed = ingestSchema.safeParse(body);
    if (!parsed.success) {
      send(res, 400, { error: "invalid_input", detail: parsed.error.issues });
      return true;
    }
    try {
      const { upserted, skipped } = upsertTrackObservations(
        db,
        parsed.data.camera,
        parsed.data.observations,
      );
      // Run the stale-closer on every ingest. Cheap: a single indexed
      // UPDATE on the open-sessions partial index.
      const closed = closeStaleTrackObservations(db, {
        graceMs: INGEST_STALE_GRACE_MS,
      });
      send(res, 200, { ok: true, upserted, skipped, closed });
    } catch (err) {
      send(res, 500, { error: "ingest_failed", detail: err.message });
    }
    return true;
  }

  // ---- Admin read: list -------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/agent/tracks") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const camera = url.searchParams.get("camera") || null;
    const label = url.searchParams.get("label") || null;
    const sinceParam = url.searchParams.get("since_ms");
    const sinceMs = Number.isFinite(Number(sinceParam))
      ? Number(sinceParam)
      : Date.now() - 24 * 60 * 60 * 1000;
    const openOnly = url.searchParams.get("open_only") === "1";
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 200) || 200, 1),
      500,
    );
    try {
      const rows = listTrackObservations(db, {
        camera,
        label,
        sinceMs,
        openOnly,
        limit,
      });
      send(res, 200, {
        rows,
        count: rows.length,
        camera,
        label,
        since_ms: sinceMs,
        open_only: openOnly,
      });
    } catch (err) {
      send(res, 500, { error: "list_failed", detail: err.message });
    }
    return true;
  }

  // ---- Admin read: summary counts --------------------------------------
  if (req.method === "GET" && url.pathname === "/api/agent/tracks/summary") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const sinceParam = url.searchParams.get("since_ms");
    const sinceMs = Number.isFinite(Number(sinceParam))
      ? Number(sinceParam)
      : Date.now() - 24 * 60 * 60 * 1000;
    try {
      const summary = trackObservationCounts(db, { sinceMs });
      send(res, 200, { ...summary, since_ms: sinceMs });
    } catch (err) {
      send(res, 500, { error: "summary_failed", detail: err.message });
    }
    return true;
  }

  return false;
}
