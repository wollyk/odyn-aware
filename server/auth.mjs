// Password hashing (scrypt, std-lib only), cookie helpers, session lookup.
// Hash format: scrypt$<logN>$<r>$<p>$<saltHex>$<keyHex>

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createSession,
  deleteSession,
  getSessionWithUser,
  purgeExpiredSessions,
  touchUserLogin,
} from "./db.mjs";

const SCRYPT_LOG_N = 15; // N = 2^15 = 32768
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SCRYPT_OPTS = { N: 1 << SCRYPT_LOG_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 };

const SESSION_COOKIE = "av_session";
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS ?? 7);
const SESSION_SECURE = (process.env.SESSION_SECURE ?? "true").toLowerCase() !== "false";

export function hashPassword(plain) {
  if (typeof plain !== "string" || plain.length < 8) {
    throw new Error("password must be at least 8 characters");
  }
  const salt = randomBytes(16);
  const key = scryptSync(plain, salt, KEY_LEN, SCRYPT_OPTS);
  return `scrypt$${SCRYPT_LOG_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${key.toString("hex")}`;
}

export function verifyPassword(plain, stored) {
  if (typeof plain !== "string" || typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  if (!Number.isFinite(logN) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const computed = scryptSync(plain, salt, expected.length, {
    N: 1 << logN,
    r,
    p,
    maxmem: 128 * 1024 * 1024,
  });
  if (computed.length !== expected.length) return false;
  return timingSafeEqual(computed, expected);
}

// Cookies ------------------------------------------------------------------

export function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setCookieHeader(res, value) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, value]);
  } else {
    res.setHeader("Set-Cookie", [existing, value]);
  }
}

export function setSessionCookie(res, sid) {
  const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
  const flags = [
    `${SESSION_COOKIE}=${sid}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (SESSION_SECURE) flags.push("Secure");
  setCookieHeader(res, flags.join("; "));
}

export function clearSessionCookie(res) {
  const flags = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (SESSION_SECURE) flags.push("Secure");
  setCookieHeader(res, flags.join("; "));
}

// Session lifecycle --------------------------------------------------------

export function startSession(db, { user_id, ip, user_agent }) {
  const id = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  createSession(db, {
    id,
    user_id,
    expires_at: expires.toISOString(),
    ip,
    user_agent,
  });
  touchUserLogin(db, user_id);
  return id;
}

export function endSession(db, sid) {
  if (sid) deleteSession(db, sid);
}

// Returns { user_id, email, role } or null.
export function getCurrentUser(db, req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const row = getSessionWithUser(db, sid);
  if (!row) return null;
  if (Date.parse(row.expires_at) <= Date.now()) {
    deleteSession(db, sid);
    return null;
  }
  return { user_id: row.user_id, email: row.email, role: row.role, sid: row.sid };
}

let lastSweep = 0;
export function maybeSweepSessions(db) {
  const now = Date.now();
  if (now - lastSweep < 60 * 60 * 1000) return; // hourly
  lastSweep = now;
  try {
    purgeExpiredSessions(db);
  } catch {
    // best-effort cleanup
  }
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
