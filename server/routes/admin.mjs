// Admin-session-gated routes that don't fit into the agent or camera
// buckets. Currently just the early-access submissions list.

import { searchEarlyAccess } from "../db.mjs";
import { send, requireAdmin } from "../http-utils.mjs";

export async function register(req, res, url, ctx) {
  const { db } = ctx;

  if (req.method === "GET" && url.pathname === "/api/admin/submissions") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const q = url.searchParams.get("q") ?? "";
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200), 1), 1000);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
    const sort = url.searchParams.get("sort") ?? "id";
    const order = url.searchParams.get("order") ?? "desc";
    send(res, 200, searchEarlyAccess(db, { q, limit, offset, sort, order }));
    return true;
  }

  return false;
}
