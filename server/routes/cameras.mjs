// Frigate proxy endpoints: cameras list, snapshot, events, labels.
//
// Resilience contract for /api/cam/cameras:
//   1. Try a live fetch from Frigate.
//   2. If that fails but we have an in-process cache, serve cached
//      with freshness="stale-mem".
//   3. If the in-process cache is empty too, fall back to kv_cache on disk.
//   4. Only return 502 if we have NEVER seen a Frigate config.
//
// On every successful live fetch, persist the raw config to kv_cache so a
// future cold boot can serve last-known-good before Frigate is reachable.

import { kvGet, kvSet, listCamLabels } from "../db.mjs";
import { send, requireAdmin } from "../http-utils.mjs";

const KV_FRIGATE_CONFIG = "frigate:rawConfig";

export async function register(req, res, url, ctx) {
  const { db, frigate } = ctx;

  if (req.method === "GET" && url.pathname === "/api/cam/cameras") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    if (!frigate.isConfigured()) {
      send(res, 200, { configured: false, cameras: [], freshness: "n/a" });
      return true;
    }
    try {
      const result = await frigate.listCamerasWithFreshness();
      // Persist raw cache on fresh fetches so cold-boot has data.
      if (result.freshness === "fresh" && frigate.getCachedRawConfig) {
        const raw = frigate.getCachedRawConfig();
        if (raw) {
          try { kvSet(db, KV_FRIGATE_CONFIG, raw); } catch { /* non-fatal */ }
        }
      }
      send(res, 200, {
        configured: true,
        cameras: result.cameras,
        freshness: result.freshness,
        fetched_at: result.fetched_at,
      });
      return true;
    } catch (err) {
      // Live + in-process cache both unavailable. Try disk fallback.
      const persisted = kvGet(db, KV_FRIGATE_CONFIG);
      if (persisted?.value?.cameras) {
        frigate.hydrateConfigCache(persisted.value);
        try {
          const result = await frigate.listCamerasWithFreshness();
          send(res, 200, {
            configured: true,
            cameras: result.cameras,
            freshness: "stale-from-disk",
            fetched_at: persisted.fresh_at,
            age_ms: persisted.age_ms,
          });
          return true;
        } catch { /* fall through to 502 */ }
      }
      console.error("[cam] listCameras failed (no cache):", err.message);
      send(res, 502, { error: "frigate_unreachable", detail: err.message });
      return true;
    }
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/cam/snapshot/")) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const camera = decodeURIComponent(url.pathname.slice("/api/cam/snapshot/".length));
    if (!camera || !/^[A-Za-z0-9_\-]+$/.test(camera)) {
      send(res, 400, { error: "invalid_camera" });
      return true;
    }
    if (!frigate.isConfigured()) {
      send(res, 503, { error: "frigate_not_configured" });
      return true;
    }
    const heightParam = url.searchParams.get("h");
    const height = heightParam ? Math.min(Math.max(Number(heightParam) || 0, 60), 1600) : undefined;
    try {
      const snap = await frigate.getSnapshot(camera, { height });
      res.writeHead(200, {
        "Content-Type": snap.contentType,
        "Cache-Control": "no-store",
        "Last-Modified": snap.lastModified,
        "X-Camera": camera,
      });
      res.end(snap.body);
      return true;
    } catch (err) {
      console.error("[cam] snapshot failed:", err.message);
      send(res, 502, { error: "frigate_unreachable", detail: err.message });
      return true;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/cam/events") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    if (!frigate.isConfigured()) {
      send(res, 200, { events: [] });
      return true;
    }
    const camera = url.searchParams.get("camera") ?? undefined;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 200);
    const label = url.searchParams.get("label") ?? undefined;
    const after = url.searchParams.get("after") ?? undefined;
    const before = url.searchParams.get("before") ?? undefined;
    try {
      const events = await frigate.getEvents({ camera, limit, label, after, before });
      send(res, 200, { events });
      return true;
    } catch (err) {
      console.error("[cam] events failed:", err.message);
      send(res, 502, { error: "frigate_unreachable", detail: err.message });
      return true;
    }
  }

  if (req.method === "GET" && url.pathname === "/api/cam/labels") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    send(res, 200, { labels: listCamLabels(db) });
    return true;
  }

  return false;
}

/** Boot helper: hydrate the in-process Frigate config cache from kv_cache. */
export function hydrateOnBoot({ db, frigate }) {
  try {
    const persisted = kvGet(db, KV_FRIGATE_CONFIG);
    if (persisted?.value && frigate.hydrateConfigCache) {
      frigate.hydrateConfigCache(persisted.value);
      console.log(`[boot] hydrated frigate config cache from kv_cache (age=${Math.round(persisted.age_ms / 1000)}s)`);
    }
  } catch (err) {
    console.warn("[boot] failed to hydrate frigate cache:", err.message);
  }
}
