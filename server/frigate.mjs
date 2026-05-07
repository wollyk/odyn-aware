// Frigate API client.
//
// Connects to Frigate v0.17+ at FRIGATE_BASE (e.g. https://127.0.0.1:3000).
// Frigate uses a self-signed cert on its bundled nginx, so we skip cert
// verification — connection is loopback-only on the same box.
//
// Auth flow: POST /api/login {user,password} → Set-Cookie: frigate_token=<JWT>
// JWTs last 24h; we re-login proactively at 23h or on any 401.
//
// Public surface used by api.mjs:
//   getSnapshot(camera, { height? }) -> { contentType, body: Buffer, headers }
//   getEvents({ camera, limit, label, after, before })
//   listCameras() -> [{ name, label, enabled, fps, width, height, tracks }]
//   getProfile() -> { username, role, allowed_cameras }
//   isConfigured() -> boolean
//
// All calls auto-retry once on 401 with a fresh login.

import { request } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import WebSocket from "ws";

const FRIGATE_BASE = process.env.FRIGATE_BASE ?? "https://127.0.0.1:3000";
const FRIGATE_USER = process.env.FRIGATE_USER ?? "";
const FRIGATE_PASS = process.env.FRIGATE_PASS ?? "";

let cachedToken = null;
let cachedTokenExpiresAt = 0; // ms epoch
let cachedConfig = null;
let cachedConfigAt = 0;

export function isConfigured() {
  return Boolean(FRIGATE_USER && FRIGATE_PASS);
}

function frigateUrl(path) {
  return new URL(path, FRIGATE_BASE);
}

function rawRequest(url, { method = "GET", headers = {}, body, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = url instanceof URL ? url : new URL(url);
    const isHttps = u.protocol === "https:";
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      // Frigate's bundled nginx uses a self-signed cert on loopback.
      rejectUnauthorized: false,
    };
    const req = (isHttps ? request : httpRequest)(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`frigate request timed out: ${u.pathname}`));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function loginIfNeeded(force = false) {
  if (!isConfigured()) {
    throw new Error("frigate_not_configured");
  }
  const now = Date.now();
  if (!force && cachedToken && now < cachedTokenExpiresAt - 60_000) {
    return cachedToken;
  }
  const res = await rawRequest(frigateUrl("/api/login"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user: FRIGATE_USER, password: FRIGATE_PASS }),
  });
  if (res.status !== 200) {
    cachedToken = null;
    cachedTokenExpiresAt = 0;
    throw new Error(`frigate login failed: ${res.status}`);
  }
  const setCookie = (res.headers["set-cookie"] ?? []).join(", ");
  const m = /frigate_token=([^;]+)/.exec(setCookie);
  if (!m) throw new Error("frigate login: no token in Set-Cookie");
  cachedToken = m[1];
  // JWT body: parse exp claim if possible; default to 23h.
  let ttlMs = 23 * 60 * 60 * 1000;
  try {
    const parts = cachedToken.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    if (payload.exp) ttlMs = payload.exp * 1000 - Date.now();
  } catch {
    // ignore, use default
  }
  cachedTokenExpiresAt = Date.now() + Math.max(60_000, ttlMs);
  return cachedToken;
}

async function frigateFetch(path, opts = {}) {
  const token = await loginIfNeeded();
  const url = frigateUrl(path);
  const headers = { ...(opts.headers || {}), Cookie: `frigate_token=${token}` };
  let res = await rawRequest(url, { ...opts, headers });
  if (res.status === 401) {
    const fresh = await loginIfNeeded(true);
    headers.Cookie = `frigate_token=${fresh}`;
    res = await rawRequest(url, { ...opts, headers });
  }
  return res;
}

export async function getSnapshot(camera, { height } = {}) {
  const qs = height ? `?h=${Number(height)}` : "";
  const res = await frigateFetch(`/api/${encodeURIComponent(camera)}/latest.jpg${qs}`);
  if (res.status !== 200) {
    throw new Error(`frigate snapshot failed: ${camera} ${res.status}`);
  }
  return {
    contentType: res.headers["content-type"] ?? "image/jpeg",
    body: res.body,
    lastModified: res.headers["last-modified"] ?? new Date().toUTCString(),
  };
}

export async function getEvents({ camera, limit = 20, label, after, before, has_clip, has_snapshot } = {}) {
  const params = new URLSearchParams();
  if (camera) params.set("camera", camera);
  params.set("limit", String(Math.min(Math.max(Number(limit) || 20, 1), 200)));
  params.set("include_thumbnails", "0");
  if (label) params.set("label", label);
  if (after) params.set("after", String(after));
  if (before) params.set("before", String(before));
  if (typeof has_clip === "boolean") params.set("has_clip", has_clip ? "1" : "0");
  if (typeof has_snapshot === "boolean") params.set("has_snapshot", has_snapshot ? "1" : "0");
  const res = await frigateFetch(`/api/events?${params.toString()}`);
  if (res.status !== 200) throw new Error(`frigate events failed: ${res.status}`);
  return JSON.parse(res.body.toString("utf8"));
}

export async function getProfile() {
  const res = await frigateFetch(`/api/profile`);
  if (res.status !== 200) throw new Error(`frigate profile failed: ${res.status}`);
  return JSON.parse(res.body.toString("utf8"));
}

// Stale-while-revalidate config fetch.
//
// Behavior:
//   - If we have a cache hit younger than CONFIG_TTL_MS, serve it (fast, fresh).
//   - Otherwise try a live fetch from Frigate.
//   - If the live fetch FAILS but we have ANY prior cached value, return that
//     cached value rather than throwing. The caller can decide what to do with
//     "old data".
//   - Only if we have no cache AND the fetch fails do we propagate the error.
//
// This is the resilience contract: once we've ever successfully read Frigate's
// config, our /api/cam/cameras endpoint will keep working through restart
// loops, network blips, and Frigate auth failures.
const CONFIG_TTL_MS = 5 * 60 * 1000;

async function getRawConfig({ allowStale = true } = {}) {
  const now = Date.now();
  if (cachedConfig && now - cachedConfigAt < CONFIG_TTL_MS) return cachedConfig;
  try {
    const res = await frigateFetch(`/api/config`);
    if (res.status !== 200) throw new Error(`frigate config failed: ${res.status}`);
    cachedConfig = JSON.parse(res.body.toString("utf8"));
    cachedConfigAt = now;
    return cachedConfig;
  } catch (err) {
    if (allowStale && cachedConfig) {
      // Frigate is unhappy but we have prior data. Serve it.
      return cachedConfig;
    }
    throw err;
  }
}

// Returns { cameras, freshness, fetched_at }
//
//   freshness: "fresh" (live this call), "stale-mem" (in-process cache hit),
//              or "stale-from-disk" (caller hydrated us from kv_cache earlier).
//
// The disk-fallback path is owned by the caller (api.mjs), which sees an
// exception from this function and consults kvGet("frigate:cameras"). We do
// it that way to keep frigate.mjs free of any DB dependency — important
// for the "decouple later" goal.
function shapeCameras(cfg) {
  const cams = cfg.cameras ?? {};
  return Object.entries(cams).map(([name, c]) => {
    const detect = c.detect ?? {};
    return {
      name,
      label: name,
      enabled: c.enabled !== false,
      detect_enabled: detect.enabled !== false,
      width: detect.width ?? null,
      height: detect.height ?? null,
      fps: detect.fps ?? null,
      tracks: c.objects?.track ?? cfg.objects?.track ?? [],
      zones: Object.keys(c.zones ?? {}),
    };
  });
}

export async function listCameras() {
  const cfg = await getRawConfig();
  return shapeCameras(cfg);
}

// listCamerasWithFreshness() distinguishes "live result" from "served from
// stale memory cache". Use this in the API layer so the frontend can show
// a soft staleness indicator without ever blanking the dropdown.
export async function listCamerasWithFreshness() {
  const beforeAt = cachedConfigAt;
  let cfg;
  try {
    cfg = await getRawConfig();
  } catch (err) {
    // No cache, no live: caller is responsible for disk fallback.
    throw err;
  }
  const freshness = cachedConfigAt === beforeAt ? "stale-mem" : "fresh";
  return {
    cameras: shapeCameras(cfg),
    freshness,
    fetched_at: new Date(cachedConfigAt || Date.now()).toISOString(),
  };
}

// Hydrate the in-process cache from a previously persisted snapshot (e.g.
// SQLite kv_cache). Lets the API serve cameras immediately on cold boot even
// if Frigate hasn't come up yet.
export function hydrateConfigCache(cfg) {
  if (!cfg || typeof cfg !== "object") return false;
  cachedConfig = cfg;
  // We hydrate as "ancient" so the next call still tries a live fetch, but
  // we'll fall back to this cache if that fetch fails.
  cachedConfigAt = 1;
  return true;
}

// Snapshot accessor for the API layer to persist to kv_cache after a fresh
// live fetch. Returns null if we've never seen a config.
export function getCachedRawConfig() {
  return cachedConfig;
}

// Convenience: invalidate the config cache (use after rename or future config edits).
export function invalidateCache() {
  cachedConfig = null;
  cachedConfigAt = 0;
}

// Open Frigate's general events WebSocket at /ws.
//
// What this WS actually emits (verified empirically on v0.17.1 with
// detect.enabled=false):
//   - "<cam>/status/detect"  : "online" — heartbeat (~10s cadence)
//   - "<cam>/status/audio"   : "online"
//   - "<cam>/status/record"  : "online"
//   - "stats"                : full stats payload (~30s cadence)
//
// What it does NOT emit in this configuration:
//   - "<cam>/motion"     — needs MQTT broker configured in Frigate
//   - "<cam>/<label>"    — needs detect.enabled=true (we have it off)
//   - "events"           — same, needs detector
//
// So the ingestor we build on top of this WS is more of a "Frigate is
// alive" channel than a "things are happening" channel. For real motion
// data we either need MQTT plumbing or per-camera snapshot diffs (later).
export async function openEventsWs() {
  const token = await loginIfNeeded();
  const base = new URL(FRIGATE_BASE);
  const wsScheme = base.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsScheme}//${base.host}/ws`;
  const ws = new WebSocket(url, {
    headers: { Cookie: `frigate_token=${token}` },
    rejectUnauthorized: false,
    perMessageDeflate: false,
    handshakeTimeout: 8000,
  });
  return ws;
}

// Per-camera motion summary — buckets of motion-frame-count by hour for
// the last 24 hours. Useful for daily summaries and "how much was happening
// at 2pm" queries.
export async function getRecordingsSummary(camera) {
  const res = await frigateFetch(`/api/${encodeURIComponent(camera)}/recordings/summary`);
  if (res.status !== 200) {
    throw new Error(`frigate recordings summary failed: ${camera} ${res.status}`);
  }
  return JSON.parse(res.body.toString("utf8"));
}

// Open an upstream MSE WebSocket to Frigate's go2rtc.
//
// Returns a `ws` WebSocket already authenticated with our cached frigate_token.
// Bypasses Frigate's detection-disabled latest.jpg placeholder by going straight
// through go2rtc's stream pipeline.
//
// Wire protocol (after upgrade):
//   client -> server (JSON text): {"type":"mse","value":"<MP4 codec string>"}
//   server -> client (JSON text): {"type":"mse","value":"<chosen codecs>"}
//   server -> client (binary):    fragmented MP4 init segment + media segments
//
// The caller is responsible for sending the init message and handling errors.
export async function openMseStream(camera) {
  const token = await loginIfNeeded();
  const base = new URL(FRIGATE_BASE);
  const wsScheme = base.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsScheme}//${base.host}/live/mse/api/ws?src=${encodeURIComponent(camera)}`;
  const ws = new WebSocket(url, {
    headers: { Cookie: `frigate_token=${token}` },
    rejectUnauthorized: false,
    perMessageDeflate: false,
    handshakeTimeout: 8000,
    maxPayload: 16 * 1024 * 1024, // 16MB cap per frame; init+media chunks are well under this
  });
  return ws;
}

export const FRIGATE = { FRIGATE_BASE };
