// Phase-15 timeline scrubber — admin REST + proxy surface.
//
//   GET /api/agent/timeline/:camera/segments
//   GET /api/agent/timeline/:camera/matches
//   GET /api/agent/timeline/:camera/hls/master.m3u8
//   GET /api/agent/timeline/:camera/hls/<rel-path>   (variant playlists + segments)
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
  buildHlsSubUrl,
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

  // ---- /hls/<...anything> ----------------------------------------------
  //
  // Catch-all for any sub-resource referenced from the master/child
  // playlists: child playlists (e.g. "index-v1.m3u8") and media
  // segments (e.g. "seg-1-v1-a1.ts"). nginx-vod-module emits these as
  // flat siblings of master.m3u8, so we proxy whatever relative path
  // the playlists reference straight through to Frigate.
  //
  // The previous implementation assumed `<profile>/index.m3u8` and
  // `<profile>/seg/<name>` subdirectory layouts, which produced 404s
  // against the actual upstream.
  const mAny = rest.match(/^hls\/(.+)$/);
  if (req.method === "GET" && mAny) {
    if (!frigate.isConfigured()) {
      send(res, 503, { error: "frigate_not_configured" });
      return true;
    }
    const rel = mAny[1]; // e.g. "index-v1.m3u8" or "seg-1-v1-a1.ts"
    if (rel.includes("..")) {
      send(res, 400, { error: "bad_path" });
      return true;
    }
    const isPlaylist = rel.endsWith(".m3u8");
    const t0 = Date.now();
    let upstreamUrl = null;
    try {
      upstreamUrl = (vod?.buildHlsSubUrl ?? buildHlsSubUrl)(
        camera,
        start_ms,
        end_ms,
        rel,
      );
      const up = await (vod?.openRangeFetch ?? openRangeFetch)(
        upstreamUrl,
        isPlaylist ? null : req.headers.range ?? null,
      );
      const okStatus = isPlaylist
        ? up.status === 200
        : up.status === 200 || up.status === 206;
      if (!okStatus) {
        const bodyPreview = (await collect(up.stream))
          .subarray(0, 200)
          .toString("utf8");
        recordProxy({
          kind: isPlaylist ? "child.m3u8" : "segment",
          camera,
          upstream_url: upstreamUrl.toString(),
          upstream_status: up.status,
          ms: Date.now() - t0,
          rel,
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
      if (isPlaylist) {
        const buf = await collect(up.stream);
        const rewritten = rewriteChildPlaylist(
          buf.toString("utf8"),
          camera,
          start_ms,
          end_ms,
        );
        recordProxy({
          kind: "child.m3u8",
          camera,
          upstream_url: upstreamUrl.toString(),
          upstream_status: 200,
          ms: Date.now() - t0,
          rel,
          rewritten_bytes: rewritten.length,
        });
        res.writeHead(200, {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Cache-Control": "private, max-age=10",
        });
        res.end(rewritten);
      } else {
        recordProxy({
          kind: "segment",
          camera,
          upstream_url: upstreamUrl.toString(),
          upstream_status: up.status,
          ms: Date.now() - t0,
          rel,
        });
        pipeUpstream(res, up, contentTypeForRel(rel));
      }
    } catch (err) {
      recordProxy({
        kind: isPlaylist ? "child.m3u8" : "segment",
        camera,
        upstream_url: upstreamUrl?.toString() ?? null,
        upstream_status: 0,
        ms: Date.now() - t0,
        rel,
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

function pipeUpstream(res, up, contentTypeOverride = null) {
  const outHeaders = {
    "Content-Type":
      contentTypeOverride ?? up.headers["content-type"] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  if (up.headers["content-length"]) outHeaders["Content-Length"] = up.headers["content-length"];
  if (up.headers["content-range"]) outHeaders["Content-Range"] = up.headers["content-range"];
  res.writeHead(up.status, outHeaders);
  up.stream.pipe(res);
}

function contentTypeForRel(rel) {
  if (rel.endsWith(".m3u8")) return "application/vnd.apple.mpegurl";
  if (rel.endsWith(".ts")) return "video/mp2t";
  if (rel.endsWith(".m4s") || rel.endsWith(".mp4")) return "video/mp4";
  return null;
}

/**
 * Rewrites a playlist body so every `*.m3u8` line points back at our
 * own /hls/<rel> proxy with the timeline window preserved on the
 * query string.
 *
 * Critical: we pass the RELATIVE path through verbatim. nginx-vod-module
 * emits variant playlists as flat siblings of master.m3u8 (e.g.
 * "index-v1.m3u8"), and the previous "split into profile + index.m3u8"
 * parser produced URLs like "/hls/index-v1/index.m3u8" which 404'd
 * upstream. The proxy route is now a catch-all that accepts whatever
 * relative path was inside the playlist, so we have no reason to
 * second-guess it here.
 *
 * We also rewrite every `URI="..."` attribute (used by EXT-X-MEDIA on
 * the master, EXT-X-MAP/KEY on children). The browser resolves those
 * URIs as RELATIVE against the playlist URL and DROPS the playlist's
 * query string, so without this rewrite the proxied URLs would be
 * missing start_ms/end_ms and our route would 400 them.
 */
export function rewriteMasterPlaylist(text, camera, start_ms, end_ms) {
  const qs = `start_ms=${start_ms}&end_ms=${end_ms}`;
  const cam = encodeURIComponent(camera);
  const baseRewrite = text.replace(/^(?!#)(\S+\.m3u8)\s*$/gm, (line) => {
    const rel = stripUpstreamPrefix(line.trim());
    return `/api/agent/timeline/${cam}/hls/${rel}?${qs}`;
  });
  return rewriteUriAttributes(baseRewrite, cam, qs);
}

export function rewriteChildPlaylist(text, camera, start_ms, end_ms) {
  const qs = `start_ms=${start_ms}&end_ms=${end_ms}`;
  const cam = encodeURIComponent(camera);
  const baseRewrite = text.replace(/^(?!#)(\S+\.(ts|m4s|mp4))\s*$/gm, (line) => {
    const rel = stripUpstreamPrefix(line.trim());
    return `/api/agent/timeline/${cam}/hls/${rel}?${qs}`;
  });
  return rewriteUriAttributes(baseRewrite, cam, qs);
}

// Rewrites every `URI="..."` attribute inside the playlist body to
// an absolute proxy path with the window query string. This covers
// EXT-X-MAP (fMP4 init segment), EXT-X-KEY (encryption key), and
// EXT-X-MEDIA (alt audio) tags. Already-absolute URIs (http:// or
// starting with "/") are left as-is so we don't double-rewrite.
function rewriteUriAttributes(text, cam, qs) {
  return text.replace(/(URI=")([^"]+)(")/g, (_, pre, uri, post) => {
    if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(uri) || uri.startsWith("/")) {
      return `${pre}${uri}${post}`;
    }
    const rel = stripUpstreamPrefix(uri);
    return `${pre}/api/agent/timeline/${cam}/hls/${rel}?${qs}${post}`;
  });
}

// If the playlist line is an absolute http(s) URL pointing at the
// Frigate origin, drop the scheme+host so we keep a clean relative
// path under the playlist's own location. For relative entries this
// is a no-op.
function stripUpstreamPrefix(line) {
  try {
    const u = new URL(line);
    // Use the URL pathname minus its leading "/vod/<cam>/start/x/end/y/"
    // so we land on the same relative path nginx-vod-module would have
    // emitted on its own.
    const m = u.pathname.match(/\/vod\/[^/]+\/start\/[^/]+\/end\/[^/]+\/(.*)$/);
    return m ? m[1] : u.pathname.replace(/^\/+/, "");
  } catch {
    return line.replace(/^\/+/, "");
  }
}
