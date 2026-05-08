// Session auth: login / logout / me.
//
// Notes:
//   - We deliberately add a 200ms delay on every login attempt (success
//     OR failure) to make timing attacks against verifyPassword much
//     harder. Don't remove without a thought-through replacement.
//   - The session cookie is HttpOnly + Secure + SameSite=Lax (auth.mjs).

import { z } from "zod";
import {
  verifyPassword,
  startSession,
  endSession,
  getCurrentUser,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  SESSION_COOKIE_NAME,
} from "../auth.mjs";
import { getUserByEmail } from "../db.mjs";
import { send, readJson, delay, clientIp } from "../http-utils.mjs";

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
});

export async function register(req, res, url, ctx) {
  const { db } = ctx;

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJson(req);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      await delay(200);
      send(res, 400, { error: "validation", issues: parsed.error.issues });
      return true;
    }
    const user = getUserByEmail(db, parsed.data.email);
    const ok = user && verifyPassword(parsed.data.password, user.password_hash);
    if (!ok) {
      await delay(200);
      send(res, 401, { error: "invalid_credentials" });
      return true;
    }
    const sid = startSession(db, {
      user_id: user.id,
      ip: clientIp(req),
      user_agent: req.headers["user-agent"] ?? "",
    });
    setSessionCookie(res, sid);
    send(res, 200, { user: { email: user.email, role: user.role } });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/logout") {
    const sid = parseCookies(req)[SESSION_COOKIE_NAME];
    endSession(db, sid);
    clearSessionCookie(res);
    send(res, 200, { ok: true });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/auth/me") {
    const me = getCurrentUser(db, req);
    if (!me) {
      send(res, 401, { error: "unauthenticated" });
      return true;
    }
    send(res, 200, { user: { email: me.email, role: me.role } });
    return true;
  }

  return false;
}
