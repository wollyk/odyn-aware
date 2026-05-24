// Phase-15 timeline scrubber — admin REST + proxy surface.
//
//   GET /api/agent/timeline/:camera/segments
//   GET /api/agent/timeline/:camera/matches
//   GET /api/agent/timeline/:camera/hls/master.m3u8
//   GET /api/agent/timeline/:camera/hls/:profile/index.m3u8
//   GET /api/agent/timeline/:camera/hls/:profile/seg/:name
//   GET /api/agent/timeline/:camera/clip.mp4
//
// The HLS playlist endpoints rewrite Frigate's absolute upstream URIs
// to point back at us so the browser's hls.js never tries to fetch
// frigate.local directly.

import { send, requireAdmin } from "../http-utils.mjs";
import { listMatchesInWindow } from "../db/face-timeline.mjs";
import {
  MAX_VOD_SPAN_MS,
  buildHlsMasterUrl,
  buildHlsChildUrl,
  buildHlsSegmentUrl,
  buildClipUrl,
  openRangeFetch,
  listRecordingsWindow,
  probeRecordings,
  probeHlsMaster,
} from "../frigate-vod.mjs";

const CAM_RE = /^\/api\/agent\/timeline\/([A-Za-z0-9_\-]+)\/(.*)$/;

// Tiny ring buffer of recent VOD proxy attempts. Exposed via
// /api/agent/timeline/_recent so an admin can see exactly what was
// requested upstream and what came back, without needing server logs.
const RECENT_MAX = 50;
const recent = [];
function recordProxy(entry) {
  recent.push({ at: new Date().toISOString(), ...entry });
  while (recent.length > RECENT_MAX) recent.shift();
}

// Exported so tests can call without bringing up a full HTTP server.
export async function handle(req, res, url, ctx) {
  const { db, frigate, vod = null } = ctx;

  // Lightweight admin-only diagnostic — last 50 VOD proxy attempts
  // with their upstream status codes and timings. No camera-name in
  // path so it falls outside CAM_RE.
  if (url.pathname === "/api/agent/timeline/_recent") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    send(res, 200, { count: recent.length, entries: [...recent].reverse() });
    return true;
  }

  const m = url.pathname.match(CAM_RE);
  if (!m) return false;
  const camera = m[1];
  const rest = m[2];

  const me = requireAdmin(db, req, res);
  if (!me) return true;

  // All endpoints share the same window pair.
  const start_ms = Number(url.searchParams.get("start_ms"));
  const end_ms = Number(url.searchParams.get("end_ms"));
  if (!Number.isFinite(start_ms) || !Number.isFinite(end_ms)) {
    send(res, 400, { error: "invalid_window", detail: "start_ms/end_ms required" });
    return true;
  }
  if (end_ms <= start_ms) {
    send(res, 400, { error: "invalid_window", detail: "end_ms must be > start_ms" });
    return true;
  }
  if (end_ms - start_ms > MAX_VOD_SPAN_MS) {
    send(res, 400, {
      error: "window_too_large",
      detail: `max span is ${MAX_VOD_SPAN_MS}ms (24h)`,
    });
    return true;
  }

  // ---- /matches ---------------------------------------------------------
  if (req.method === "GET" && rest === "matches") {
    const personRaw = url.searchParams.get("person_id");
    let person_id = null;
    if (personRaw === "unknown") person_id = "unknown";
    else if (personRaw && /^\d+$/.test(personRaw)) person_id = Number(personRaw);
    try {
      const rows = listMatchesInWindow(db, {
        camera,
        start_ms,
        end_ms,
        person_id,
      });
      const matches = rows.map((r) => ({
        id: r.id,
        ts_ms: r.ts_ms,
        person_id: r.person_id,
        person_name: r.person_name,
        similarity: r.similarity,
        quality: r.quality,
        bbox: r.bbox,
        thumb_url: r.thumb_path ? `/api/agent/faces/matches/${r.id}/thumb` : null,
      }));
      send(res, 200, {
        camera,
        start_ms,
        end_ms,
        count: matches.length,
        matches,
      });
    } catch (err) {
      send(res, 500, { error: "matches_failed", detail: err.message });
    }
    return true;
  }

  // ---- /diagnose --------------------------------------------------------
  // Returns the raw upstream response so an admin can see EXACTLY what
  // Frigate is sending back (status, content-type, body preview). Useful
  // when /segments returns "frigate_unreachable" and you need to know why.
  if (req.method === "GET" && rest === "diagnose") {
    if (!frigate.isConfigured()) {
      send(res, 200, {
        frigate_configured: false,
        detail: "FRIGATE_USER/FRIGATE_PASS not set on this server",
      });
      return true;
    }
    try {
      const recProbe = vod?.probeRecordings ?? probeRecordings;
      const hlsProbe = vod?.probeHlsMaster ?? probeHlsMaster;
      const [recordings, hls] = await Promise.all([
        recProbe(camera, start_ms, end_ms),
        hlsProbe(camera, start_ms, end_ms),
      ]);
      send(res, 200, {
        camera,
        start_ms,
        end_ms,
        frigate_configured: true,
        recordings,
        hls,
      });
    } catch (err) {
      send(res, 500, { error: "diagnose_failed", detail: err.message });
    }
    return true;
  }

  // ---- /segments --------------------------------------------------------
  if (req.method === "GET" && rest === "segments") {
    if (!frigate.isConfigured()) {
      send(res, 200, { camera, start_ms, end_ms, segments: [], frigate_configured: false });
      return true;
    }
    try {
      const out = await (vod?.listRecordingsWindow ?? listRecordingsWindow)(
        camera,
        start_ms,
        end_ms,
      );
      send(res, 200, { camera, ...out });
    } catch (err) {
      // Always include the detail so the UI can show the real reason.
      send(res, 502, {
        error: "frigate_unreachable",
        detail: err?.message ?? String(err),
        hint: "GET /api/agent/timeline/<cam>/diagnose?start_ms=...&end_ms=... for raw upstream info",
      });
    }
    return true;
  }

  // ---- /hls/master.m3u8 -------------------------------------------------
  if (req.method === "GET" && rest === "hls/master.m3u8") {
    if (!frigate.isConfigured()) {
      send(res, 503, { error: "frigate_not_configured" });
      return true;
    }
    const t0 = Date.now();
    let upstreamUrl = null;
    try {
      upstreamUrl = (vod?.buildHlsMasterUrl ?? buildHlsMasterUrl)(
        camera,
        start_ms,
        end_ms,
      );
      const up = await (vod?.openRangeFetch ?? openRangeFetch)(upstreamUrl, null);
      if (up.status !== 200) {
        const bodyPreview = (await collect(up.stream)).subarray(0, 200).toString("utf8");
        recordProxy({
          kind: "master.m3u8",
          camera,
          upstream_url: upstreamUrl.toString(),
          upstream_status: up.status,
          ms: Date.now() - t0,
          body_preview: bodyPreview,
        });
        send(res, up.status, {
          error: "upstream",
          status: up.status,
          upstream_url: upstreamUrl.toString(),
          body_preview: bodyPreview,
        });
        return true;
      }
      const buf = await collect(up.stream);
      const rewritten = rewriteMasterPlaylist(
        buf.toString("utf8"),
        camera,
        start_ms,
        end_ms,
      );
      recordProxy({
        kind: "master.m3u8",
        camera,
        upstream_url: upstreamUrl.toString(),
        upstream_status: 200,
        ms: Date.now() - t0,
        rewritten_bytes: rewritten.length,
      });
      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "private, max-age=10",
      });
      res.end(rewritten);
    } catch (err) {
      recordProxy({
        kind: "master.m3u8",
        camera,
        upstream_url: upstreamUrl?.toString() ?? null,
        upstream_status: 0,
        ms: Date.now() - t0,
        error: err?.message ?? String(err),
      });
      send(res, 502, {
        error: "frigate_unreachable",
        detail: err.message,
        upstream_url: upstreamUrl?.toString() ?? null,
      });
    }
    return true;
  }

  // ---- /hls/:profile/index.m3u8 ----------------------------------------
  const mChild = rest.match(/^hls\/([A-Za-z0-9_.-]+)\/index\.m3u8$/);
  if (req.method === "GET" && mChild) {
    if (!frigate.isConfigured()) {
      send(res, 503, { error: "frigate_not_configured" });
      return true;
    }
    try {
      const upstreamUrl = (vod?.buildHlsChildUrl ?? buildHlsChildUrl)(
        camera,
        start_ms,
        end_ms,
        mChild[1],
      );
      const up = await (vod?.openRangeFetch ?? openRangeFetch)(upstreamUrl, null);
      if (up.status !== 200) {
        send(res, up.status, { error: "upstream", status: up.status });
        return true;
      }
      const buf = await collect(up.stream);
      const rewritten = rewriteChildPlaylist(
        buf.toString("utf8"),
        camera,
        start_ms,
        end_ms,
        mChild[1],
      );
      res.writeHead(200, {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "private, max-age=10",
      });
      res.end(rewritten);
    } catch (err) {
      send(res, 502, { error: "frigate_unreachable", detail: err.message });
    }
    return true;
  }

  // ---- /hls/:profile/seg/:name -----------------------------------------
  const mSeg = rest.match(/^hls\/([A-Za-z0-9_.-]+)\/seg\/([A-Za-z0-9_.-]+)$/);
  if (req.method === "GET" && mSeg) {
    if (!frigate.isConfigured()) {
      send(res, 503, { error: "frigate_not_configured" });
      return true;
    }
    try {
      const upstreamUrl = (vod?.buildHlsSegmentUrl ?? buildHlsSegmentUrl)(
        camera,
        start_ms,
        end_ms,
        mSeg[1],
        mSeg[2],
      );
      const up = await (vod?.openRangeFetch ?? openRangeFetch)(
        upstreamUrl,
        req.headers.range ?? null,
      );
      if (up.status !== 200 && up.status !== 206) {
        send(res, up.status, { error: "upstream", status: up.status });
        return true;
      }
      pipeUpstream(res, up);
    } catch (err) {
      send(res, 502, { error: "frigate_unreachable", detail: err.message });
    }
    return true;
  }

  // ---- /clip.mp4 --------------------------------------------------------
  if (req.method === "GET" && rest === "clip.mp4") {
    if (!frigate.isConfigured()) {
      send(res, 503, { error: "frigate_not_configured" });
      return true;
    }
    try {
      const upstreamUrl = (vod?.buildClipUrl ?? buildClipUrl)(camera, start_ms, end_ms);
      const up = await (vod?.openRangeFetch ?? openRangeFetch)(
        upstreamUrl,
        req.headers.range ?? null,
      );
      if (up.status !== 200 && up.status !== 206) {
        send(res, up.status, { error: "upstream", status: up.status });
        return true;
      }
      pipeUpstream(res, up);
    } catch (err) {
      send(res, 502, { error: "frigate_unreachable", detail: err.message });
    }
    return true;
  }

  return false;
}

// Route registrar — matches the (req, res, url, ctx) shape used by every
// other route module. Returning true means "we handled this".
export async function register(req, res, url, ctx) {
  if (!url.pathname.startsWith("/api/agent/timeline/")) return false;
  return handle(req, res, url, ctx);
}

// -- helpers --------------------------------------------------------------

function collect(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

function pipeUpstream(res, up) {
  const outHeaders = {
    "Content-Type": up.headers["content-type"] || "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (up.headers["content-length"]) outHeaders["Content-Length"] = up.headers["content-length"];
  if (up.headers["content-range"]) outHeaders["Content-Range"] = up.headers["content-range"];
  res.writeHead(up.status, outHeaders);
  up.stream.pipe(res);
}

// Rewrites the absolute upstream URIs that Frigate emits in playlists so
// they point back at our proxy. Exported for unit tests.
export function rewriteMasterPlaylist(text, camera, start_ms, end_ms) {
  const qs = `start_ms=${start_ms}&end_ms=${end_ms}`;
  return text.replace(/^(?!#)(\S+)\.m3u8\s*$/gm, (line) => {
    const trimmed = line.trim();
    // Extract a profile name from any reasonable shape. Frigate emits
    // things like "rendition0/index.m3u8" or absolute URLs ending in
    // "/<profile>/index.m3u8".
    const m = trimmed.match(/([A-Za-z0-9_.-]+)\/index\.m3u8$/) || trimmed.match(/([A-Za-z0-9_.-]+)\.m3u8$/);
    const profile = m ? m[1].replace(/\.m3u8$/, "") : "default";
    return `/api/agent/timeline/${encodeURIComponent(camera)}/hls/${profile}/index.m3u8?${qs}`;
  });
}

export function rewriteChildPlaylist(text, camera, start_ms, end_ms, profile) {
  const qs = `start_ms=${start_ms}&end_ms=${end_ms}`;
  return text.replace(/^(?!#)(\S+\.(ts|m4s|mp4))\s*$/gm, (line) => {
    const trimmed = line.trim();
    const segName = trimmed.split("/").pop();
    return `/api/agent/timeline/${encodeURIComponent(camera)}/hls/${profile}/seg/${segName}?${qs}`;
  });
}
