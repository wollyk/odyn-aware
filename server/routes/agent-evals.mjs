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
            if (!s.ok || !s.body) return;
            if (s.body.status && s.body.status !== "running") {
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
