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

export function buildHlsChildUrl(camera, startMs, endMs, profile) {
  assertWindow(startMs, endMs);
  const prof = sanitizePathSegment(profile);
  return frigateUrl(
    `/vod/${encodeCam(camera)}/start/${unixSecondsWithMs(startMs)}/end/${unixSecondsWithMs(endMs)}/${prof}/index.m3u8`,
  ).toString();
}

export function buildHlsSegmentUrl(camera, startMs, endMs, profile, segName) {
  assertWindow(startMs, endMs);
  const prof = sanitizePathSegment(profile);
  const seg = sanitizePathSegment(segName);
  return frigateUrl(
    `/vod/${encodeCam(camera)}/start/${unixSecondsWithMs(startMs)}/end/${unixSecondsWithMs(endMs)}/${prof}/${seg}`,
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
// Resolves on the response headers; the body is the IncomingMessage stream.
export function openRangeFetch(upstreamUrl, rangeHeader = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = upstreamUrl instanceof URL ? upstreamUrl : new URL(upstreamUrl);
    const isHttps = u.protocol === "https:";
    const headers = { ...extraHeaders };
    if (rangeHeader) headers.range = rangeHeader;
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
    const req = (isHttps ? httpsRequest : httpRequest)(opts, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        stream: res,
      });
    });
    req.on("error", reject);
    req.setTimeout(30_000, () => {
      req.destroy(new Error(`vod request timed out: ${u.pathname}`));
    });
    req.end();
  });
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
export async function listRecordingsWindow(camera, startMs, endMs, { auth } = {}) {
  assertWindow(startMs, endMs);
  const url = frigateUrl(
    `/api/${encodeCam(camera)}/recordings?after=${(startMs / 1000).toFixed(3)}&before=${(endMs / 1000).toFixed(3)}`,
  );
  const headers = {};
  if (auth) headers.Cookie = `frigate_token=${auth}`;
  const upstream = await openRangeFetch(url, null, headers);
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
