// Frigate recordings / VOD client.
//
// Why this is separate from frigate.mjs:
//   - frigate.mjs is the auth-and-config core. Adding VOD URL building +
//     range fetches there bloats it.
//   - Mocking just this module in the route tests keeps the seams clean.
//
// Frigate's relevant endpoints (v0.14+):
//
//   GET /api/<cam>/recordings?after=<unix_s>&before=<unix_s>
//     Returns a flat list of { start_time, end_time, duration, motion,
//     objects, segment_size } recordings within the window. Per-second
//     granularity. We aggregate into minute bins so the timeline doesn't
//     try to render 86_400 rects per day.
//
//   GET /vod/<cam>/start/<unix_s.ms>/end/<unix_s.ms>/master.m3u8
//     HLS master playlist for a window. Children + segments referenced
//     via relative URIs.
//
//   GET /api/<cam>/recordings/<start_unix>/<end_unix>.mp4
//     Single-shot MP4 cut, suitable for browsers that prefer downloads
//     over HLS, and for our "Range" fallback path.

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { getAuthCookie } from "./frigate.mjs";

const FRIGATE_BASE = process.env.FRIGATE_BASE ?? "https://127.0.0.1:3000";

// Hard cap on the time window we'll let a single request describe. 24h
// keeps Frigate's response size sane and lets us aggressively short the
// upstream call when callers send something unreasonable. Bumping this
// is a deliberate decision; don't do it without considering the m3u8
// download size.
export const MAX_VOD_SPAN_MS = 24 * 60 * 60 * 1000;

function frigateUrl(pathAndQuery) {
  return new URL(pathAndQuery, FRIGATE_BASE);
}

function unixSecondsWithMs(ms) {
  return (ms / 1000).toFixed(3);
}

function encodeCam(cam) {
  return encodeURIComponent(cam);
}

function assertWindow(startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    const err = new RangeError("invalid window");
    err.code = "invalid_window";
    throw err;
  }
  if (endMs <= startMs) {
    const err = new RangeError("invalid window");
    err.code = "invalid_window";
    throw err;
  }
  if (endMs - startMs > MAX_VOD_SPAN_MS) {
    const err = new RangeError("vod_window_too_large");
    err.code = "vod_window_too_large";
    throw err;
  }
}

// -- URL builders -----------------------------------------------------------

export function buildHlsMasterUrl(camera, startMs, endMs) {
  assertWindow(startMs, endMs);
  return frigateUrl(
    `/vod/${encodeCam(camera)}/start/${unixSecondsWithMs(startMs)}/end/${unixSecondsWithMs(endMs)}/master.m3u8`,
  ).toString();
}

function sanitizePathSegment(s) {
  // Strip path separators, drop any `..` runs, drop leading dots so the
  // segment can never be a traversal payload.
  return String(s)
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .replace(/\.{2,}/g, "")
    .replace(/^\.+/, "");
}

/**
 * Build the upstream URL for an arbitrary HLS sub-resource (child
 * playlist, segment, init.mp4) referenced *relative* to master.m3u8.
 *
 * nginx-vod-module emits children + segments as flat siblings of
 * master.m3u8, so the relative path is opaque to us. We split on "/",
 * sanitize each segment defensively, and join back. A single trailing
 * `.m3u8` / `.ts` / `.m4s` / `.mp4` extension is preserved.
 */
export function buildHlsSubUrl(camera, startMs, endMs, relPath) {
  assertWindow(startMs, endMs);
  const cleaned = String(relPath)
    .split("/")
    .map((seg) => sanitizePathSegment(seg))
    .filter((seg) => seg.length > 0)
    .join("/");
  if (!cleaned) {
    const err = new RangeError("empty rel path");
    err.code = "bad_path";
    throw err;
  }
  return frigateUrl(
    `/vod/${encodeCam(camera)}/start/${unixSecondsWithMs(startMs)}/end/${unixSecondsWithMs(endMs)}/${cleaned}`,
  ).toString();
}

export function buildClipUrl(camera, startMs, endMs) {
  assertWindow(startMs, endMs);
  return frigateUrl(
    `/api/${encodeCam(camera)}/recordings/${Math.floor(startMs / 1000)}/${Math.floor(endMs / 1000)}.mp4`,
  ).toString();
}

// -- Range-aware fetch ------------------------------------------------------

// Returns the raw node:http(s) IncomingMessage so the caller can pipe
// bytes back to its own response (preserves Content-Range / Content-Type).
//
// Authenticated by default: attaches the Frigate JWT cookie. Without this
// every VOD/recordings endpoint returns 401 on Frigate >= 0.14. On 401 we
// retry exactly once with a forced re-login, mirroring frigate.mjs's
// frigateFetch behavior.
//
// Resolves on the response headers; the body is the IncomingMessage stream.
export function openRangeFetch(upstreamUrl, rangeHeader = null, extraHeaders = {}) {
  return _doRangeFetch(upstreamUrl, rangeHeader, extraHeaders, /*allowRetry*/ true);
}

async function _doRangeFetch(upstreamUrl, rangeHeader, extraHeaders, allowRetry) {
  // Caller can pre-supply a Cookie via extraHeaders; otherwise we attach
  // the cached Frigate JWT. Auth-disabled environments end up with no
  // cookie and that's fine (loginIfNeeded throws frigate_not_configured
  // long before we get here).
  let headers = { ...extraHeaders };
  if (!headers.Cookie && !headers.cookie) {
    try {
      headers.Cookie = await getAuthCookie();
    } catch (err) {
      // Surface the auth failure as the immediate error; the route layer
      // turns it into a 502 with the message intact.
      throw new Error(`frigate_auth_failed: ${err?.message ?? err}`);
    }
  }
  if (rangeHeader) headers.range = rangeHeader;

  const res = await new Promise((resolve, reject) => {
    const u = upstreamUrl instanceof URL ? upstreamUrl : new URL(upstreamUrl);
    const isHttps = u.protocol === "https:";
    const opts = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: "GET",
      headers,
      // Frigate's loopback nginx uses a self-signed cert. Same posture
      // as frigate.mjs::rawRequest.
      rejectUnauthorized: false,
    };
    const req = (isHttps ? httpsRequest : httpRequest)(opts, (r) => {
      resolve({ status: r.statusCode ?? 0, headers: r.headers, stream: r });
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`vod request timed out: ${u.pathname}`));
    });
    req.end();
  });

  if (res.status === 401 && allowRetry) {
    // Drain the body so the socket can be reused.
    res.stream.resume();
    try {
      const fresh = await getAuthCookie({ refresh: true });
      const newHeaders = { ...extraHeaders, Cookie: fresh };
      return _doRangeFetch(upstreamUrl, rangeHeader, newHeaders, /*allowRetry*/ false);
    } catch (err) {
      throw new Error(`frigate_auth_failed: ${err?.message ?? err}`);
    }
  }

  return res;
}

// -- Recordings density ----------------------------------------------------

/**
 * Fetch raw per-segment recordings from Frigate and aggregate into
 * coarser bins suitable for the timeline density background.
 *
 * Bin size scales with window length: 1m bins for ≤1h, 5m for ≤6h, 15m
 * for ≤24h. Each bin's `bytes` is summed `segment_size` across the
 * segments that intersect the bin.
 */
export async function listRecordingsWindow(camera, startMs, endMs) {
  assertWindow(startMs, endMs);
  const url = frigateUrl(
    `/api/${encodeCam(camera)}/recordings?after=${(startMs / 1000).toFixed(3)}&before=${(endMs / 1000).toFixed(3)}`,
  );
  const upstream = await openRangeFetch(url, null);
  if (upstream.status !== 200) {
    const err = new Error(`frigate recordings ${upstream.status}`);
    err.code = "upstream_status";
    err.status = upstream.status;
    throw err;
  }
  const buf = await collect(upstream.stream);
  let raw;
  try {
    raw = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new Error("frigate recordings: not JSON");
  }
  const segments = Array.isArray(raw) ? raw : [];
  return aggregateSegments(segments, startMs, endMs);
}

/**
 * Diagnostic probe of an arbitrary upstream URL — returns raw status,
 * content-type, and a small body preview. Lower-level helper.
 */
export async function probeUrl(url, { maxBytes = 400, rangeHeader = null } = {}) {
  try {
    const upstream = await openRangeFetch(url, rangeHeader);
    const buf = await collect(upstream.stream);
    return {
      upstream_url: url.toString(),
      status: upstream.status,
      content_type: upstream.headers["content-type"] ?? null,
      body_preview: buf.subarray(0, maxBytes).toString("utf8"),
      body_bytes: buf.length,
    };
  } catch (err) {
    return {
      upstream_url: url.toString(),
      status: 0,
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Diagnostic probe: returns raw status, content-type, and the first
 * `maxBytes` bytes of the body. Lets an admin see EXACTLY why Frigate
 * is rejecting a recordings request without me having to read logs.
 */
export async function probeRecordings(camera, startMs, endMs, opts = {}) {
  assertWindow(startMs, endMs);
  const url = frigateUrl(
    `/api/${encodeCam(camera)}/recordings?after=${(startMs / 1000).toFixed(3)}&before=${(endMs / 1000).toFixed(3)}`,
  );
  return probeUrl(url, opts);
}

/**
 * Diagnostic probe of the HLS master playlist URL. Returns the raw
 * upstream status + body preview so we can tell whether Frigate's
 * /vod/<cam>/start/.../master.m3u8 endpoint is serving anything for
 * the requested window.
 */
export async function probeHlsMaster(camera, startMs, endMs, opts = {}) {
  assertWindow(startMs, endMs);
  const url = buildHlsMasterUrl(camera, startMs, endMs);
  return probeUrl(new URL(url), opts);
}

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Exported for unit tests; aggregates Frigate raw segments into bins.
export function aggregateSegments(rawSegments, startMs, endMs) {
  const spanMs = endMs - startMs;
  let binMs;
  if (spanMs <= 60 * 60 * 1000) binMs = 60_000;
  else if (spanMs <= 6 * 60 * 60 * 1000) binMs = 5 * 60_000;
  else binMs = 15 * 60_000;

  const bins = new Map();
  for (const s of rawSegments) {
    if (typeof s?.start_time !== "number" || typeof s?.end_time !== "number") continue;
    const sMs = s.start_time * 1000;
    const eMs = s.end_time * 1000;
    if (eMs <= startMs || sMs >= endMs) continue;
    const binStart = Math.floor(Math.max(sMs, startMs) / binMs) * binMs;
    const key = binStart;
    const cur = bins.get(key) ?? { start_ms: binStart, end_ms: binStart + binMs, bytes: 0 };
    cur.bytes += Number(s.segment_size ?? 0);
    bins.set(key, cur);
  }
  return {
    start_ms: startMs,
    end_ms: endMs,
    bin_ms: binMs,
    segments: [...bins.values()].sort((a, b) => a.start_ms - b.start_ms),
  };
}
