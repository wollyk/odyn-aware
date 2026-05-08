// Phase-7 alert delivery — REST routes.
//
// Surface (all admin-gated):
//   GET    /api/agent/alerts/destinations          list active (or ?status=disabled|all)
//   POST   /api/agent/alerts/destinations          create
//   PATCH  /api/agent/alerts/destinations/:id      update label/min_severity/cooldown/secret
//   DELETE /api/agent/alerts/destinations/:id      archive (status='disabled')
//   POST   /api/agent/alerts/destinations/:id/test send a synthetic alert
//   GET    /api/agent/alerts/recent                recent dispatch log
//
// We deliberately don't expose webhook_secret on read; we just return
// has_webhook_secret so the operator can see "secret is set" without
// risking the value leaving the server.

import { z } from "zod";
import {
  listAlertDestinations,
  createAlertDestination,
  updateAlertDestination,
  archiveAlertDestination,
  getAlertDestination,
  listRecentAlertDispatches,
} from "../db/alerts.mjs";
import { send, readJson, requireAdmin } from "../http-utils.mjs";

const createSchema = z.object({
  type: z.enum(["email", "webhook"]),
  target: z.string().trim().min(3).max(500),
  label: z.string().trim().max(120).nullish(),
  min_severity: z.enum(["notable", "critical"]).optional(),
  cooldown_seconds: z.number().int().min(30).max(86400).optional(),
  webhook_secret: z.string().trim().min(8).max(256).nullish(),
});

const updateSchema = z.object({
  label: z.string().trim().max(120).nullish(),
  status: z.enum(["active", "disabled"]).optional(),
  min_severity: z.enum(["notable", "critical"]).optional(),
  cooldown_seconds: z.number().int().min(30).max(86400).optional(),
  webhook_secret: z.string().trim().min(8).max(256).nullish(),
});

function validateTarget(type, target) {
  if (type === "email") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)) return "invalid_email";
    return null;
  }
  if (type === "webhook") {
    let url;
    try { url = new URL(target); } catch { return "invalid_webhook_url"; }
    if (!["http:", "https:"].includes(url.protocol)) return "webhook_must_be_http";
    return null;
  }
  return "unsupported_type";
}

export async function register(req, res, url, ctx) {
  const { db, harness } = ctx;

  // List destinations.
  if (req.method === "GET" && url.pathname === "/api/agent/alerts/destinations") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const rawStatus = url.searchParams.get("status") ?? "active";
    const status = ["active", "disabled", "all"].includes(rawStatus) ? rawStatus : "active";
    try {
      const rows = listAlertDestinations(db, { status });
      // Strip webhook_secret before responding — never let it leave the server.
      const safe = rows.map(({ webhook_secret, ...r }) => r);
      send(res, 200, { rows: safe, count: safe.length });
    } catch (err) {
      send(res, 500, { error: "list_failed", detail: err.message });
    }
    return true;
  }

  // Create destination.
  if (req.method === "POST" && url.pathname === "/api/agent/alerts/destinations") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let body;
    try { body = await readJson(req); }
    catch (err) { send(res, 400, { error: "bad_body", detail: err.message }); return true; }
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      send(res, 400, { error: "invalid_input", detail: parsed.error.issues });
      return true;
    }
    const targetErr = validateTarget(parsed.data.type, parsed.data.target);
    if (targetErr) { send(res, 400, { error: targetErr }); return true; }
    try {
      const row = createAlertDestination(db, {
        ...parsed.data,
        created_by: me.user_id,
      });
      // Strip webhook_secret from response.
      const { webhook_secret, ...safe } = row;
      send(res, 201, { row: { ...safe, has_webhook_secret: webhook_secret ? 1 : 0 } });
    } catch (err) {
      // SQLITE_CONSTRAINT_UNIQUE → friendly conflict error.
      if (/UNIQUE/.test(err.message)) {
        send(res, 409, { error: "duplicate_destination", detail: "type+target already exists" });
        return true;
      }
      send(res, 500, { error: "create_failed", detail: err.message });
    }
    return true;
  }

  // Per-destination paths.
  const destBase = "/api/agent/alerts/destinations/";
  if (url.pathname.startsWith(destBase)) {
    const rest = url.pathname.slice(destBase.length);
    const [idStr, action] = rest.split("/");
    const id = Number(idStr);
    if (!Number.isInteger(id) || id <= 0) {
      send(res, 400, { error: "invalid_id" });
      return true;
    }

    // Test alert.
    if (req.method === "POST" && action === "test") {
      const me = requireAdmin(db, req, res);
      if (!me) return true;
      const dest = getAlertDestination(db, id);
      if (!dest) { send(res, 404, { error: "not_found" }); return true; }
      if (dest.status !== "active") {
        send(res, 400, { error: "destination_disabled" });
        return true;
      }
      try {
        const result = await harness.sendTestAlert({
          destination: dest,
          camera: "test",
          actor: me.email,
        });
        if (result.ok) {
          send(res, 200, { ok: true, status: result.status, duration_ms: result.duration_ms });
        } else {
          send(res, 502, {
            ok: false,
            status: result.status,
            error: result.error,
            duration_ms: result.duration_ms,
          });
        }
      } catch (err) {
        send(res, 500, { error: "test_failed", detail: err.message });
      }
      return true;
    }

    // Update.
    if (req.method === "PATCH" && !action) {
      const me = requireAdmin(db, req, res);
      if (!me) return true;
      let body;
      try { body = await readJson(req); }
      catch (err) { send(res, 400, { error: "bad_body", detail: err.message }); return true; }
      const parsed = updateSchema.safeParse(body);
      if (!parsed.success) {
        send(res, 400, { error: "invalid_input", detail: parsed.error.issues });
        return true;
      }
      try {
        const row = updateAlertDestination(db, id, parsed.data);
        if (!row) { send(res, 404, { error: "not_found" }); return true; }
        const { webhook_secret, ...safe } = row;
        send(res, 200, { row: { ...safe, has_webhook_secret: webhook_secret ? 1 : 0 } });
      } catch (err) {
        send(res, 500, { error: "update_failed", detail: err.message });
      }
      return true;
    }

    // Archive.
    if (req.method === "DELETE" && !action) {
      const me = requireAdmin(db, req, res);
      if (!me) return true;
      try {
        const r = archiveAlertDestination(db, id);
        send(res, 200, { ok: true, archived: r.changes });
      } catch (err) {
        send(res, 500, { error: "archive_failed", detail: err.message });
      }
      return true;
    }
  }

  // Recent dispatch log.
  if (req.method === "GET" && url.pathname === "/api/agent/alerts/recent") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const camera = url.searchParams.get("camera") || null;
    const status = url.searchParams.get("status") || null;
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
    try {
      const rows = listRecentAlertDispatches(db, { camera, status, limit });
      send(res, 200, { rows, count: rows.length });
    } catch (err) {
      send(res, 500, { error: "list_failed", detail: err.message });
    }
    return true;
  }

  return false;
}
