// Shared HTTP helpers used by every route module + api.mjs.
//
// Why split out:
//   - api.mjs was over 1000 lines and the 'send/readJson/setCors' helpers
//     were imported nowhere else. Moving them here lets each route module
//     import only what it needs without re-implementing.
//   - `requireAdmin` consolidates the "401 if no session, 403 if not admin"
//     pattern that appeared in 15+ places. Returning the user object on
//     success avoids duplicate getCurrentUser calls.
//
// All functions here are pure (no module state). Anything stateful goes in
// a route module or a separate service.

import { getCurrentUser } from "./auth.mjs";

export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Return the best-guess client IP, honoring trusted X-Forwarded-For. */
export function clientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    ""
  );
}

/**
 * Set CORS headers if the request origin is in ALLOWED_ORIGINS. Always
 * advertises the methods we accept (browsers preflight against this).
 */
export function setCors(req, res, allowed = ALLOWED_ORIGINS) {
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** Send a JSON (or pre-serialized string) response. */
export function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

/**
 * Read a JSON body up to `limit` bytes. Default 32KB. Pass higher for
 * endpoints that accept image base64 (e.g. enroll uses 10MB).
 */
export async function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/** Sleep utility — used to even out brute-force timing on auth endpoints. */
export async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Authenticate + authorize for admin routes in one shot.
 *
 *   const me = requireAdmin(db, req, res);
 *   if (!me) return; // response already sent (401 or 403)
 *
 * On success returns the user row from auth.mjs (id, email, role, etc.).
 * On failure sends the appropriate response and returns null.
 */
export function requireAdmin(db, req, res) {
  const me = getCurrentUser(db, req);
  if (!me) {
    send(res, 401, { error: "unauthenticated" });
    return null;
  }
  if (me.role !== "admin") {
    send(res, 403, { error: "forbidden" });
    return null;
  }
  return me;
}

/**
 * Lift a Set into a closer-bag pattern: register/unregister + drain.
 * Used by the WebSocket upgrade handler for graceful-shutdown drain.
 */
export class CloserBag {
  constructor() { this._set = new Set(); }
  add(fn) { this._set.add(fn); return () => this._set.delete(fn); }
  size() { return this._set.size; }
  drainAll(label = "closerbag") {
    const n = this._set.size;
    for (const fn of [...this._set]) {
      try { fn(); } catch (err) { console.warn(`[${label}] closer threw:`, err?.message); }
    }
    this._set.clear();
    return n;
  }
}
