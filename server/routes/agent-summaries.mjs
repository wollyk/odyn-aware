// Phase 5: daily summaries.
//
// Reads are admin-only (PII risk: people_seen). Regen is admin-only and
// rate-limited inside the harness; we don't add another rate-limit here.
//
// Surface:
//   GET  /api/agent/summaries
//        ?day=YYYY-MM-DD&scope=tenant            single row
//        ?day=YYYY-MM-DD&scope=camera:Garage     camera-scoped row
//        ?since_day=YYYY-MM-DD&limit=14          list (any scope)
//   POST /api/agent/summaries/regenerate
//        Body: { day?, scope, force? }

import { dayKeyUtc, getDailySummary, listDailySummaries } from "../db.mjs";
import { send, readJson, requireAdmin } from "../http-utils.mjs";

export async function register(req, res, url, ctx) {
  const { db, harness } = ctx;

  if (req.method === "GET" && url.pathname === "/api/agent/summaries") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const day = url.searchParams.get("day");
    const scope = url.searchParams.get("scope");
    const since_day = url.searchParams.get("since_day");
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 14), 1), 90);
    try {
      if (day && scope) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
          send(res, 400, { error: "invalid_day" });
          return true;
        }
        const row = getDailySummary(db, { day, scope });
        if (!row) {
          send(res, 404, { error: "not_found", day, scope });
          return true;
        }
        send(res, 200, { row });
        return true;
      }
      const rows = listDailySummaries(db, { since_day, scope: scope || null, limit });
      send(res, 200, { rows, count: rows.length });
    } catch (err) {
      send(res, 500, { error: "summaries_failed", detail: err.message });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/agent/summaries/regenerate") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let body;
    try { body = await readJson(req); }
    catch (err) { send(res, 400, { error: "bad_body", detail: err.message }); return true; }
    const day = (body?.day && /^\d{4}-\d{2}-\d{2}$/.test(body.day)) ? body.day : dayKeyUtc();
    const scope = String(body?.scope ?? "").trim();
    const force = Boolean(body?.force);
    if (!scope) { send(res, 400, { error: "scope_required" }); return true; }
    if (scope !== "tenant" && !scope.startsWith("camera:")) {
      send(res, 400, { error: "invalid_scope", detail: "scope must be 'tenant' or 'camera:<name>'" });
      return true;
    }
    try {
      const out = await harness.regenerateSummary({ db, day, scope, force });
      send(res, 200, out);
    } catch (err) {
      send(res, 500, { error: "regen_failed", detail: err.message });
    }
    return true;
  }

  return false;
}
