// Live polling endpoints used by the operator UI.
//
//   GET /api/agent/detections   T2-gates-T3 routed call. Default mode
//                                "t2-gates-t3" cuts T3 cost ~70-95% vs
//                                always-on. ?mode= overrides for debugging.
//                                Phase 4: also returns face[]/known_face_count.
//   GET /api/agent/scene        T2-only scene description. Cheap, $0.
//
// Both routes go through harness.checkQuota / recordQuota so noisy cameras
// can't burn the shared GPU/dollars budget.

import { send, requireAdmin } from "../http-utils.mjs";

export async function register(req, res, url, ctx) {
  const { db, frigate, harness } = ctx;

  if (req.method === "GET" && url.pathname === "/api/agent/detections") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const camera = url.searchParams.get("camera") ?? "";
    if (!/^[A-Za-z0-9_\-]+$/.test(camera)) {
      send(res, 400, { error: "invalid_camera" });
      return true;
    }
    if (!frigate.isConfigured()) {
      send(res, 200, { detections: [], status: "frigate_not_configured" });
      return true;
    }

    // Optional ?mode= override (admin debugging). Falls back to
    // DETECTION_ROUTER_MODE env (default "t2-gates-t3").
    const allowedModes = new Set(["always-t3", "t2-gates-t3", "t2-only", "off"]);
    const reqMode = url.searchParams.get("mode");
    const mode = allowedModes.has(reqMode) ? reqMode : undefined;

    const tenant = "default";
    const t2Gate = harness.checkQuota({ tenant, camera, kind: "t2-vision" });
    if (!t2Gate.allowed) {
      send(res, 429, { error: "quota_exceeded", reason: t2Gate.reason, kind: "t2-vision" });
      return true;
    }

    try {
      const snap = await frigate.getSnapshot(camera, { height: 480 });
      const result = await harness.timed("agent.detections", () =>
        harness.analyzeImageRouted({ imageBuffer: snap.body, camera, mode }),
      );
      // Always charge T2; charge T3 only if it actually fired live.
      harness.recordQuota({ tenant, camera, kind: "t2-vision", dollars: 0 });
      if (result.escalation?.ran) {
        harness.recordQuota({ tenant, camera, kind: "t3-vision", dollars: 0.0001 });
      }
      send(res, 200, { camera, ...result });
    } catch (err) {
      console.error("[agent] detections failed:", err.message);
      send(res, 502, { error: "agent_failed", detail: err.message });
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/agent/scene") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const camera = url.searchParams.get("camera") ?? "";
    if (!/^[A-Za-z0-9_\-]+$/.test(camera)) {
      send(res, 400, { error: "invalid_camera" });
      return true;
    }
    if (!frigate.isConfigured()) {
      send(res, 200, { status: "frigate_not_configured", tier: "T2" });
      return true;
    }
    const tenant = "default";
    const gate = harness.checkQuota({ tenant, camera, kind: "t2-vision" });
    if (!gate.allowed) {
      send(res, 429, { error: "quota_exceeded", reason: gate.reason });
      return true;
    }
    try {
      // h=240 is enough for moondream-class scene description and keeps
      // the prompt token count low (~750 tokens vs ~2000 at h=480).
      const snap = await frigate.getSnapshot(camera, { height: 240 });
      const result = await harness.timed("agent.scene", () =>
        harness.analyzeImageLocal({ imageBuffer: snap.body, camera }),
      );
      if (result.ok) harness.recordQuota({ tenant, camera, kind: "t2-vision", dollars: 0 });
      send(res, 200, {
        camera,
        tier: "T2",
        status: result.ok ? "ok" : "error",
        scene: result.scene,
        severity: result.severity,
        alert_type: result.alert_type,
        confidence: result.confidence,
        reason: result.reason,
        model: result.tier2_meta?.model ?? null,
        tookMs: result.tier2_meta?.tookMs ?? null,
        error: result.ok ? null : result.tier2_meta?.errorDetail ?? "unknown",
      });
    } catch (err) {
      console.error("[agent] scene failed:", err.message);
      send(res, 502, { error: "scene_failed", detail: err.message, tier: "T2" });
    }
    return true;
  }

  return false;
}
