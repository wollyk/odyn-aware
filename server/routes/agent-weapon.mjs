// Phase 6: weapon / suspicious-object debug endpoints.
//
// The hot path runs weapon scoring INSIDE analyzeImageRouted (in
// server/harness/index.mjs) — those calls don't go through this route at
// all. This module exposes operator-facing debug endpoints:
//
//   POST /api/agent/weapon/score-now  body: { camera, record? }
//      -> runs the YOLOv8 sidecar against a live snapshot and returns the
//         result. "Test detection on this camera now" button.
//
//   GET  /api/agent/weapon/health
//      -> proxies the sidecar's /health. Useful for the admin status
//         pane to show "weapon detector: green/red".
//
// All routes require admin. Reviewer-aligned framing applies: we never
// say "weapon detected", we say "suspicious_object". The Node side
// surfaces the sidecar's class name verbatim (e.g. "knife", "baseball bat")
// — so the UI can decide its own copy.

import { send, readJson, requireAdmin } from "../http-utils.mjs";

/**
 * Translate a sidecar error into the right HTTP status. Mirrors
 * sendEmbedderError in routes/agent-faces.mjs for consistency.
 *   - weapon_http_4xx        -> 422 (bad image / bad input)
 *   - everything else        -> 502 (sidecar down / network)
 */
function sendWeaponError(res, err) {
  const msg = err?.message ?? "";
  if (/weapon_http_4\d\d/.test(msg)) {
    send(res, 422, { error: "weapon_rejected_image", detail: msg });
  } else {
    send(res, 502, { error: "weapon_unreachable", detail: msg });
  }
}

export async function register(req, res, url, ctx) {
  const { db, frigate, harness } = ctx;

  if (req.method === "GET" && url.pathname === "/api/agent/weapon/health") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    try {
      const h = await harness.pingWeaponDetector();
      send(res, 200, h);
    } catch (err) {
      send(res, 502, { error: "weapon_unreachable", detail: err.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/weapon/score-now") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let body;
    try { body = await readJson(req); }
    catch (err) { send(res, 400, { error: "bad_body", detail: err.message }); return true; }
    const camera = String(body?.camera ?? "").trim();
    if (!camera || !/^[A-Za-z0-9_\-]+$/.test(camera)) {
      send(res, 400, { error: "invalid_camera" });
      return true;
    }
    if (!frigate.isConfigured()) {
      send(res, 503, { error: "frigate_not_configured" });
      return true;
    }
    let snap;
    try { snap = await frigate.getSnapshot(camera, { height: 720 }); }
    catch (err) { send(res, 502, { error: "snapshot_failed", detail: err.message }); return true; }

    try {
      const r = await harness.scoreWeapon({ imageBuffer: snap.body });
      send(res, 200, { camera, ...r });
    } catch (err) { sendWeaponError(res, err); }
    return true;
  }

  return false;
}
