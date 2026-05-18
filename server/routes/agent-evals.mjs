// Phase-13A eval admin REST surface.
//
// All routes here are admin-gated. They proxy the heavy lifting to the
// tracker sidecar's /eval/* endpoints (which spawn the actual eval.py
// subprocess) and persist a record per run/diff in SQLite so the admin
// UI can list history without scanning the tracker host's filesystem.
//
// Flow:
//   POST /api/agent/evals/run     → POST tracker /eval/run, write running row
//   GET  /api/agent/evals         → list from DB + status hydrate from tracker
//   GET  /api/agent/evals/:id     → DB row + (if running) live tracker status
//   GET  /api/agent/evals/:id/log → tracker log tail (passthrough)
//   GET  /api/agent/evals/:id/raw → tracker JSONL streamed (passthrough)
//   POST /api/agent/evals/diff    → POST tracker /eval/diff, persist row
//   GET  /api/agent/evals/diff/:id → DB row
//   GET  /api/agent/evals/corpus  → list video clips from tracker corpus
//
// Why we persist to SQLite even though the tracker has its own files:
//   - List-of-runs needs to be cheap. Scanning N JSONLs every page load
//     doesn't scale.
//   - Cross-restart history. If the tracker reboots, the admin UI
//     should still list past runs.
//   - "Who started this run" attribution lives only in the Node session.

import { z } from "zod";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  upsertEvalRun,
  listEvalRuns,
  getEvalRun,
  insertEvalDiff,
  listEvalDiffs,
  getEvalDiff,
} from "../db/evals.mjs";
import { send, readJson, requireAdmin } from "../http-utils.mjs";

// The tracker HTTP base. The WS proxy uses TRACKER_BASE ("ws://..."); we
// derive an HTTP base from that (replace scheme) or honor an explicit
// override. Default to local loopback on the tracker's port.
const TRACKER_HTTP_BASE = (
  process.env.TRACKER_HTTP_BASE ??
  (process.env.TRACKER_BASE ?? "ws://127.0.0.1:8767")
    .replace(/^ws:/i, "http:")
    .replace(/^wss:/i, "https:")
).replace(/\/$/, "");

const EVAL_SECRET = process.env.TRACKER_EVAL_SECRET ?? "";
if (!EVAL_SECRET) {
  console.warn(
    "[agent-evals] TRACKER_EVAL_SECRET unset — eval endpoints will refuse to proxy.",
  );
}

// Mirror the tracker's MAX_UPLOAD_BYTES. We could query it from the
// tracker on boot, but a static mirror keeps the request flow simple
// and lets us reject oversized uploads before opening a socket to the
// tracker at all.
const MAX_UPLOAD_BYTES = Number(
  process.env.TRACKER_EVAL_MAX_UPLOAD_BYTES ?? 500 * 1024 * 1024,
);
// `.zip` is for image-sequence uploads — the tracker extracts them
// into a sequence directory inside the corpus. See
// services/tracker/eval_routes.py::_extract_sequence_zip for the
// allowed images inside (.tif/.jpg/.png/etc).
const ALLOWED_UPLOAD_EXTS = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".zip",
]);

// -- chunked upload state ----------------------------------------------------
//
// Why this exists: the public TLS proxy in front of auroraview.tech enforces
// a 1 MB client_max_body_size on POSTs. The single-shot /upload route works
// only for tiny files (and is unreachable for anything bigger). Chunking
// keeps every individual request under that ceiling while still landing a
// 500 MB file end-to-end. The server reassembles into a single .part file
// on the DL380's local disk, then streams that file to the tracker's
// /eval/corpus/upload endpoint over loopback (no nginx in the path) so the
// full size limit applies only once and only for the local hop.
//
// Storage layout:
//   /tmp/auroraview-uploads/<upload_id>.part
//
// Each .part file is the raw concatenation of received chunks. Strict
// sequential ordering is enforced: chunk N must arrive after chunk N-1 with
// the running byte count matching what the server already wrote. That makes
// retry-after-failure deterministic — the client can re-POST chunk N if it
// times out — and avoids any seek/seek/seek race shape on the server.
const CHUNK_UPLOAD_DIR = path.join(os.tmpdir(), "auroraview-uploads");
// Cap each chunk body. The public TLS proxy in front of auroraview.tech
// is configured with client_max_body_size ~64 KB, so anything above that
// gets a 413 from nginx BEFORE the request reaches Node. We allow a
// comfortable bit of headroom over the client's 48 KB default so an
// occasional larger chunk (e.g. last partial chunk of a file) doesn't
// trip a 413 from us, but stay well under 64 KB.
const MAX_CHUNK_BYTES = 60 * 1024;
// Sessions older than this with no activity are GC'd on the next sweep.
const CHUNK_SESSION_TTL_MS = 60 * 60 * 1000;
const CHUNK_GC_INTERVAL_MS = 5 * 60 * 1000;

const _chunkSessions = new Map(); // upload_id -> session record

async function _ensureChunkDir() {
  await fsp.mkdir(CHUNK_UPLOAD_DIR, { recursive: true });
}

async function _gcChunkSessions() {
  const now = Date.now();
  // First clear out in-memory sessions that exceeded the TTL.
  for (const [id, s] of _chunkSessions) {
    if (now - s.lastSeenAt > CHUNK_SESSION_TTL_MS) {
      _chunkSessions.delete(id);
      try {
        await fsp.unlink(s.partPath);
      } catch {
        /* already gone or never created */
      }
    }
  }
  // Then sweep orphan files on disk (server restart leaves files behind).
  try {
    const entries = await fsp.readdir(CHUNK_UPLOAD_DIR);
    for (const f of entries) {
      if (!f.endsWith(".part")) continue;
      const p = path.join(CHUNK_UPLOAD_DIR, f);
      try {
        const st = await fsp.stat(p);
        if (now - st.mtimeMs > CHUNK_SESSION_TTL_MS) {
          await fsp.unlink(p);
        }
      } catch {
        /* race with another GC pass */
      }
    }
  } catch {
    /* dir not created yet */
  }
}

let _gcStarted = false;
function _startGcOnce() {
  if (_gcStarted) return;
  _gcStarted = true;
  // unref() so the interval doesn't block a graceful shutdown.
  const t = setInterval(() => {
    _gcChunkSessions().catch(() => {});
  }, CHUNK_GC_INTERVAL_MS);
  if (typeof t.unref === "function") t.unref();
}

async function _readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    req.on("data", (c) => {
      total += c.length;
      if (total > limit) {
        reject(Object.assign(new Error("chunk_too_large"), { code: "chunk_too_large" }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const runSchema = z.object({
  clip: z.string().min(1).max(512),
  name: z.string().max(120).optional(),
  config: z.record(z.string(), z.any()).optional(),
  vlm: z.boolean().optional(),
  max_frames: z.number().int().min(1).max(50_000).optional(),
  fps: z.number().positive().max(60).optional(),
});

const diffSchema = z.object({
  a: z.string().min(8).max(64),
  b: z.string().min(8).max(64),
});

function trackerHeaders() {
  return {
    "content-type": "application/json",
    "x-eval-secret": EVAL_SECRET,
  };
}

async function trackerFetch(pathAndQuery, init = {}) {
  if (!EVAL_SECRET) {
    throw new Error("eval_secret_unset");
  }
  const res = await fetch(`${TRACKER_HTTP_BASE}${pathAndQuery}`, {
    ...init,
    headers: { ...trackerHeaders(), ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { ok: res.ok, status: res.status, body, text };
}

export async function register(req, res, url, ctx) {
  const { db } = ctx;

  // -- corpus listing -----------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/agent/evals/corpus") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    try {
      const upstream = await trackerFetch("/eval/corpus");
      send(res, upstream.status, upstream.body ?? { error: "no_body" });
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- corpus upload (raw body, streamed to tracker) ----------------------
  //
  // Client side: `xhr.send(file)` with `?name=<filename>` query param.
  // Browser progress events come from the upload phase here, not from
  // the tracker, so we get a live progress bar without any tracker
  // changes. Body is piped straight to fetch with `duplex: "half"` so
  // we never buffer 500 MB in Node memory.
  if (req.method === "POST" && url.pathname === "/api/agent/evals/upload") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    if (!EVAL_SECRET) {
      send(res, 503, { error: "eval_secret_unset" });
      return true;
    }
    const name = url.searchParams.get("name") ?? "";
    if (!name) {
      send(res, 400, { error: "missing_name" });
      return true;
    }
    // Strip directory components defensively (the tracker also does this).
    const safeName = name.replace(/^.*[\\/]/, "");
    const dotIdx = safeName.lastIndexOf(".");
    const ext = dotIdx > 0 ? safeName.slice(dotIdx).toLowerCase() : "";
    if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
      send(res, 415, { error: "unsupported_extension", got: ext });
      return true;
    }
    const cl = Number(req.headers["content-length"] ?? "0");
    if (!Number.isFinite(cl) || cl <= 0) {
      send(res, 411, { error: "length_required" });
      return true;
    }
    if (cl > MAX_UPLOAD_BYTES) {
      send(res, 413, { error: "file_too_large", limit: MAX_UPLOAD_BYTES });
      return true;
    }
    try {
      const upstream = await fetch(
        `${TRACKER_HTTP_BASE}/eval/corpus/upload?name=${encodeURIComponent(safeName)}`,
        {
          method: "POST",
          headers: {
            "x-eval-secret": EVAL_SECRET,
            "content-type":
              req.headers["content-type"] || "application/octet-stream",
            "content-length": String(cl),
          },
          body: req,
          duplex: "half",
        },
      );
      const txt = await upstream.text();
      let body;
      try {
        body = txt ? JSON.parse(txt) : null;
      } catch {
        body = { raw: txt };
      }
      send(res, upstream.status, body ?? { ok: upstream.ok });
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- chunked upload: start ----------------------------------------------
  //
  // Mints an upload_id, creates an empty .part file under CHUNK_UPLOAD_DIR,
  // and records a session in memory. The client then sends N chunks via
  // /upload/chunk and finally /upload/complete which streams the assembled
  // file to the tracker. Body is small — no rate limiting needed here.
  if (req.method === "POST" && url.pathname === "/api/agent/evals/upload/start") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let body;
    try {
      body = await readJson(req, 4 * 1024);
    } catch {
      body = {};
    }
    const rawName = String(body?.name ?? "");
    const safeName = rawName.replace(/^.*[\\/]/, "");
    const dotIdx = safeName.lastIndexOf(".");
    const ext = dotIdx > 0 ? safeName.slice(dotIdx).toLowerCase() : "";
    if (!safeName || !ALLOWED_UPLOAD_EXTS.has(ext)) {
      send(res, 415, { error: "unsupported_extension", got: ext });
      return true;
    }
    const totalSize = Number(body?.size ?? 0);
    if (!Number.isFinite(totalSize) || totalSize <= 0) {
      send(res, 400, { error: "bad_size" });
      return true;
    }
    if (totalSize > MAX_UPLOAD_BYTES) {
      send(res, 413, { error: "file_too_large", limit: MAX_UPLOAD_BYTES });
      return true;
    }
    try {
      await _ensureChunkDir();
      _startGcOnce();
      const uploadId = randomUUID();
      const partPath = path.join(CHUNK_UPLOAD_DIR, `${uploadId}.part`);
      // Touch the file so we can append later.
      await fsp.writeFile(partPath, Buffer.alloc(0));
      _chunkSessions.set(uploadId, {
        name: safeName,
        ext,
        totalSize,
        partPath,
        receivedBytes: 0,
        nextChunkIndex: 0,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        owner: me.email,
      });
      send(res, 200, {
        upload_id: uploadId,
        max_chunk_bytes: MAX_CHUNK_BYTES,
      });
    } catch (err) {
      send(res, 500, { error: "start_failed", detail: err.message });
    }
    return true;
  }

  // -- chunked upload: append one chunk -----------------------------------
  //
  // Body is the raw chunk (octet-stream). Query params:
  //   id  — upload_id minted by /start
  //   n   — chunk index, strictly sequential starting at 0
  //
  // The server appends the body to the .part file. If `n` doesn't match
  // the expected next-index we return 409 with the expected number so the
  // client can rewind. This makes retries deterministic.
  if (req.method === "POST" && url.pathname === "/api/agent/evals/upload/chunk") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const id = url.searchParams.get("id") ?? "";
    const n = Number(url.searchParams.get("n") ?? "-1");
    if (!id || !Number.isInteger(n) || n < 0) {
      send(res, 400, { error: "bad_params" });
      return true;
    }
    const session = _chunkSessions.get(id);
    if (!session) {
      send(res, 404, { error: "unknown_upload" });
      return true;
    }
    if (session.owner !== me.email) {
      send(res, 403, { error: "not_your_upload" });
      return true;
    }
    if (n !== session.nextChunkIndex) {
      send(res, 409, {
        error: "out_of_order",
        expected: session.nextChunkIndex,
        got: n,
      });
      return true;
    }
    const cl = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(cl) && cl > MAX_CHUNK_BYTES) {
      send(res, 413, { error: "chunk_too_large", limit: MAX_CHUNK_BYTES });
      return true;
    }
    let buf;
    try {
      buf = await _readBody(req, MAX_CHUNK_BYTES);
    } catch (err) {
      if (err?.code === "chunk_too_large") {
        send(res, 413, { error: "chunk_too_large", limit: MAX_CHUNK_BYTES });
      } else {
        send(res, 400, { error: "bad_body", detail: err?.message });
      }
      return true;
    }
    if (buf.length === 0) {
      send(res, 400, { error: "empty_chunk" });
      return true;
    }
    if (session.receivedBytes + buf.length > session.totalSize) {
      send(res, 413, {
        error: "exceeds_declared_size",
        declared: session.totalSize,
        received: session.receivedBytes,
        chunk: buf.length,
      });
      return true;
    }
    try {
      await fsp.appendFile(session.partPath, buf);
    } catch (err) {
      send(res, 500, { error: "append_failed", detail: err.message });
      return true;
    }
    session.receivedBytes += buf.length;
    session.nextChunkIndex += 1;
    session.lastSeenAt = Date.now();
    send(res, 200, {
      received_bytes: session.receivedBytes,
      next_chunk_index: session.nextChunkIndex,
    });
    return true;
  }

  // -- chunked upload: complete -------------------------------------------
  //
  // Streams the assembled .part file to the tracker's /eval/corpus/upload
  // endpoint (loopback, no public-proxy nginx in the path). Returns whatever
  // the tracker returns, then deletes the .part file. On any failure we
  // keep the .part file in place so the GC can clean it up after the TTL.
  if (req.method === "POST" && url.pathname === "/api/agent/evals/upload/complete") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    if (!EVAL_SECRET) {
      send(res, 503, { error: "eval_secret_unset" });
      return true;
    }
    const id = url.searchParams.get("id") ?? "";
    const session = _chunkSessions.get(id);
    if (!session) {
      send(res, 404, { error: "unknown_upload" });
      return true;
    }
    if (session.owner !== me.email) {
      send(res, 403, { error: "not_your_upload" });
      return true;
    }
    if (session.receivedBytes !== session.totalSize) {
      send(res, 400, {
        error: "size_mismatch",
        declared: session.totalSize,
        received: session.receivedBytes,
      });
      return true;
    }
    const overrideName = (url.searchParams.get("name") ?? "").trim();
    const finalName = (overrideName || session.name).replace(/^.*[\\/]/, "");
    const dotIdx = finalName.lastIndexOf(".");
    const ext = dotIdx > 0 ? finalName.slice(dotIdx).toLowerCase() : "";
    if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
      send(res, 415, { error: "unsupported_extension", got: ext });
      return true;
    }
    const partPath = session.partPath;
    try {
      // Drop in-memory session now; even if the upstream upload fails we
      // don't want the client to retry the same id (it would re-stream
      // bytes we already consumed). The .part file is cleaned up below.
      _chunkSessions.delete(id);

      const fileStream = fs.createReadStream(partPath);
      const upstream = await fetch(
        `${TRACKER_HTTP_BASE}/eval/corpus/upload?name=${encodeURIComponent(finalName)}`,
        {
          method: "POST",
          headers: {
            "x-eval-secret": EVAL_SECRET,
            "content-type": "application/octet-stream",
            "content-length": String(session.totalSize),
          },
          body: Readable.toWeb(fileStream),
          duplex: "half",
        },
      );
      const txt = await upstream.text();
      let upBody;
      try {
        upBody = txt ? JSON.parse(txt) : null;
      } catch {
        upBody = { raw: txt };
      }
      try {
        await fsp.unlink(partPath);
      } catch {
        /* GC will clean up later */
      }
      send(res, upstream.status, upBody ?? { ok: upstream.ok });
    } catch (err) {
      // Leave .part file for the GC sweep so a transient tracker hiccup
      // doesn't lose 500 MB of bytes mid-upload.
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- corpus delete ------------------------------------------------------
  //
  // The clip name may contain URI-reserved characters, so we accept a
  // wildcard tail and decode it before forwarding. The tracker validates
  // that the resolved path lives inside CORPUS_DIR, so a malicious name
  // can't escape via "../".
  const mDelClip = url.pathname.match(/^\/api\/agent\/evals\/corpus\/(.+)$/);
  if (req.method === "DELETE" && mDelClip) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let name;
    try {
      name = decodeURIComponent(mDelClip[1]);
    } catch {
      send(res, 400, { error: "bad_name" });
      return true;
    }
    try {
      const upstream = await trackerFetch(
        `/eval/corpus/${encodeURIComponent(name)}`,
        { method: "DELETE" },
      );
      send(res, upstream.status, upstream.body ?? { ok: upstream.ok });
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- start a run --------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/agent/evals/run") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let body;
    try {
      body = await readJson(req, 64 * 1024);
    } catch (err) {
      send(res, 400, { error: "bad_body", detail: err.message });
      return true;
    }
    const parsed = runSchema.safeParse(body);
    if (!parsed.success) {
      send(res, 400, { error: "invalid_input", detail: parsed.error.issues });
      return true;
    }
    try {
      const upstream = await trackerFetch("/eval/run", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      if (!upstream.ok) {
        send(res, upstream.status, upstream.body ?? { error: "tracker_error" });
        return true;
      }
      const { run_id, name, clip, status, started_at } = upstream.body ?? {};
      upsertEvalRun(db, {
        runId: run_id,
        name: name ?? parsed.data.name ?? clip,
        clip,
        configJson: JSON.stringify(parsed.data.config ?? {}),
        configHash: null,
        status: status ?? "running",
        outPath: upstream.body?.out_path ?? null,
        summaryJson: null,
        headerJson: null,
        startedAtMs: started_at ? Math.round(started_at * 1000) : Date.now(),
        finishedAtMs: null,
        createdBy: me.email,
      });
      send(res, 200, upstream.body);
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- list runs (hydrates running rows from tracker) ---------------------
  if (req.method === "GET" && url.pathname === "/api/agent/evals") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1),
      500,
    );
    let rows = listEvalRuns(db, { limit });
    // For any rows still "running", ask the tracker if they've completed.
    // Doing it lazily here keeps the writer simple — no daemon needed.
    const stillRunning = rows.filter((r) => r.status === "running");
    if (stillRunning.length > 0) {
      await Promise.all(
        stillRunning.map(async (r) => {
          try {
            const s = await trackerFetch(`/eval/status/${r.run_id}`);
            // Happy path: tracker still has the in-memory _runs entry.
            if (s.ok && s.body && s.body.status && s.body.status !== "running") {
              const result = await trackerFetch(`/eval/result/${r.run_id}`);
              const header = result.body?.header ?? null;
              const summary = result.body?.summary ?? null;
              upsertEvalRun(db, {
                runId: r.run_id,
                name: r.name,
                clip: r.clip,
                configJson: JSON.stringify(r.config ?? {}),
                configHash: header?.config_hash ?? null,
                status: s.body.status,
                outPath: r.out_path,
                summaryJson: summary ? JSON.stringify(summary) : null,
                headerJson: header ? JSON.stringify(header) : null,
                startedAtMs: r.started_at_ms,
                finishedAtMs: s.body.finished_at
                  ? Math.round(s.body.finished_at * 1000)
                  : Date.now(),
                createdBy: r.created_by,
              });
              return;
            }
            if (s.ok && s.body && s.body.status === "running") {
              // Genuinely still running. Skip the disk fallback.
              return;
            }
            // Fallback: tracker doesn't know this run (likely restarted
            // after the eval finished, dropping the in-memory dict).
            // /eval/result reads the JSONL straight off disk, so if the
            // run actually completed before the restart we can recover
            // its summary here. Without this an eval row stays "Running"
            // forever after a tracker restart even though the data is
            // on disk and the Watch view works.
            const diskResult = await trackerFetch(`/eval/result/${r.run_id}`);
            if (diskResult.ok && diskResult.body?.summary) {
              const header = diskResult.body.header ?? null;
              const summary = diskResult.body.summary;
              upsertEvalRun(db, {
                runId: r.run_id,
                name: r.name,
                clip: r.clip,
                configJson: JSON.stringify(r.config ?? {}),
                configHash: header?.config_hash ?? null,
                status: "ok",
                outPath: r.out_path,
                summaryJson: JSON.stringify(summary),
                headerJson: header ? JSON.stringify(header) : null,
                startedAtMs: r.started_at_ms,
                finishedAtMs: summary?.finished_at
                  ? Math.round(summary.finished_at * 1000)
                  : Date.now(),
                createdBy: r.created_by,
              });
            }
          } catch {
            /* keep "running" until next page load */
          }
        }),
      );
      rows = listEvalRuns(db, { limit });
    }
    send(res, 200, { rows, count: rows.length });
    return true;
  }

  // -- detail (single run) ------------------------------------------------
  const mDetail = url.pathname.match(/^\/api\/agent\/evals\/([0-9a-f]{8,64})$/i);
  if (req.method === "GET" && mDetail) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const runId = mDetail[1];
    const row = getEvalRun(db, runId);
    if (!row) {
      send(res, 404, { error: "not_found" });
      return true;
    }
    // If still running, hydrate live state for the UI.
    let live = null;
    if (row.status === "running") {
      try {
        const s = await trackerFetch(`/eval/status/${runId}?tail=4096`);
        live = s.body;
      } catch {
        /* ignore */
      }
    }
    send(res, 200, { run: row, live });
    return true;
  }

  // -- log tail (live stdout) --------------------------------------------
  const mLog = url.pathname.match(/^\/api\/agent\/evals\/([0-9a-f]{8,64})\/log$/i);
  if (req.method === "GET" && mLog) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    try {
      const tail = url.searchParams.get("tail") ?? "8192";
      const s = await trackerFetch(`/eval/status/${mLog[1]}?tail=${encodeURIComponent(tail)}`);
      send(res, s.status, s.body ?? { error: "no_body" });
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- raw JSONL passthrough (streamed) ----------------------------------
  const mRaw = url.pathname.match(/^\/api\/agent\/evals\/([0-9a-f]{8,64})\/raw$/i);
  if (req.method === "GET" && mRaw) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    try {
      const upstream = await fetch(
        `${TRACKER_HTTP_BASE}/eval/result/${mRaw[1]}/raw`,
        { headers: trackerHeaders() },
      );
      if (!upstream.ok) {
        send(res, upstream.status, { error: "upstream", status: upstream.status });
        return true;
      }
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "cache-control": "no-store",
      });
      const reader = upstream.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- clip streaming (with HTTP Range pass-through) ----------------------
  //
  // The eval player <video> element needs to scrub the source MP4. We
  // forward the browser's `Range` header to the tracker and proxy the
  // partial-content response back, preserving Content-Range so
  // HTMLMediaElement seeking works. No buffering — straight pipe.
  const mClip = url.pathname.match(/^\/api\/agent\/evals\/([0-9a-f]{8,64})\/clip$/i);
  if (req.method === "GET" && mClip) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    if (!EVAL_SECRET) {
      send(res, 503, { error: "eval_secret_unset" });
      return true;
    }
    try {
      const upstreamHeaders = { "x-eval-secret": EVAL_SECRET };
      if (req.headers.range) upstreamHeaders.range = req.headers.range;
      const upstream = await fetch(
        `${TRACKER_HTTP_BASE}/eval/clip/${mClip[1]}`,
        { headers: upstreamHeaders },
      );
      if (!upstream.ok && upstream.status !== 206) {
        const txt = await upstream.text().catch(() => "");
        send(res, upstream.status, {
          error: "upstream",
          status: upstream.status,
          body: txt.slice(0, 200),
        });
        return true;
      }
      const outHeaders = {
        "content-type":
          upstream.headers.get("content-type") || "application/octet-stream",
        "accept-ranges": "bytes",
        "cache-control": "no-store",
      };
      const cl = upstream.headers.get("content-length");
      if (cl) outHeaders["content-length"] = cl;
      const cr = upstream.headers.get("content-range");
      if (cr) outHeaders["content-range"] = cr;
      res.writeHead(upstream.status, outHeaders);
      const reader = upstream.body.getReader();
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- sequence manifest (per-frame playback metadata) -------------------
  const mSeqManifest = url.pathname.match(
    /^\/api\/agent\/evals\/([0-9a-f]{8,64})\/sequence$/i,
  );
  if (req.method === "GET" && mSeqManifest) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    try {
      const upstream = await trackerFetch(`/eval/sequence/${mSeqManifest[1]}/manifest`);
      send(res, upstream.status, upstream.body ?? { error: "no_body" });
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- sequence frame (per-frame JPEG for image-sequence runs) -----------
  //
  // Server-decoded JPEG so the browser doesn't need a TIFF decoder.
  // Frames are immutable for the lifetime of a run, so we let the
  // tracker set Cache-Control: immutable and forward it.
  const mSeqFrame = url.pathname.match(
    /^\/api\/agent\/evals\/([0-9a-f]{8,64})\/frame\/(\d+)$/i,
  );
  if (req.method === "GET" && mSeqFrame) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    if (!EVAL_SECRET) {
      send(res, 503, { error: "eval_secret_unset" });
      return true;
    }
    try {
      const upstream = await fetch(
        `${TRACKER_HTTP_BASE}/eval/sequence/${mSeqFrame[1]}/frame/${mSeqFrame[2]}`,
        { headers: { "x-eval-secret": EVAL_SECRET } },
      );
      if (!upstream.ok) {
        send(res, upstream.status, {
          error: "upstream",
          status: upstream.status,
        });
        return true;
      }
      const ab = await upstream.arrayBuffer();
      const cc = upstream.headers.get("cache-control") || "public, max-age=86400, immutable";
      res.writeHead(200, {
        "content-type": upstream.headers.get("content-type") || "image/jpeg",
        "content-length": String(ab.byteLength),
        "cache-control": cc,
      });
      res.end(Buffer.from(ab));
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- diff: create -------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/api/agent/evals/diff") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    let body;
    try {
      body = await readJson(req, 16 * 1024);
    } catch (err) {
      send(res, 400, { error: "bad_body", detail: err.message });
      return true;
    }
    const parsed = diffSchema.safeParse(body);
    if (!parsed.success) {
      send(res, 400, { error: "invalid_input", detail: parsed.error.issues });
      return true;
    }
    try {
      const upstream = await trackerFetch("/eval/diff", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      if (!upstream.ok) {
        send(res, upstream.status, upstream.body ?? { error: "tracker_error" });
        return true;
      }
      const { diff_id, diff } = upstream.body ?? {};
      if (diff_id && diff) {
        insertEvalDiff(db, {
          diffId: diff_id,
          runA: parsed.data.a,
          runB: parsed.data.b,
          diffJson: JSON.stringify(diff),
          createdBy: me.email,
        });
      }
      send(res, 200, upstream.body);
    } catch (err) {
      send(res, 502, { error: "tracker_unreachable", detail: err.message });
    }
    return true;
  }

  // -- diff: read one -----------------------------------------------------
  const mDiff = url.pathname.match(/^\/api\/agent\/evals\/diff\/([0-9a-f]{8,64})$/i);
  if (req.method === "GET" && mDiff) {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const row = getEvalDiff(db, mDiff[1]);
    if (!row) {
      send(res, 404, { error: "not_found" });
      return true;
    }
    send(res, 200, row);
    return true;
  }

  // -- diffs: list --------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/api/agent/evals/diffs") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1),
      200,
    );
    const rows = listEvalDiffs(db, { limit });
    send(res, 200, { rows, count: rows.length });
    return true;
  }

  return false;
}
