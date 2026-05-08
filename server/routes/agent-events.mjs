// Harness event log: list + per-event timeline. Used by the operator
// review UI and the chat agent's `get_recent_events` tool.

import { listEvents, getEventTimeline } from "../db.mjs";
import { send, requireAdmin } from "../http-utils.mjs";

export async function register(req, res, url, ctx) {
  const { db } = ctx;

  if (req.method === "GET" && url.pathname === "/api/agent/events") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const camera = url.searchParams.get("camera") || undefined;
    const severity = url.searchParams.get("severity") || undefined;
    const since_ms = url.searchParams.get("since_ms")
      ? Number(url.searchParams.get("since_ms"))
      : undefined;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
    try {
      const rows = listEvents(db, { camera, severity, since_ms, limit });
      send(res, 200, { rows, count: rows.length });
    } catch (err) {
      send(res, 500, { error: "events_failed", detail: err.message });
    }
    return true;
  }

  // Reconstruct the full life of one event by id (all stages).
  if (req.method === "GET" && url.pathname.startsWith("/api/agent/events/")) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const event_id = decodeURIComponent(url.pathname.slice("/api/agent/events/".length));
    if (!/^[A-Za-z0-9_\-]+$/.test(event_id)) {
      send(res, 400, { error: "invalid_event_id" });
      return true;
    }
    try {
      const timeline = getEventTimeline(db, event_id);
      send(res, 200, { event_id, timeline });
    } catch (err) {
      send(res, 500, { error: "timeline_failed", detail: err.message });
    }
    return true;
  }

  return false;
}
