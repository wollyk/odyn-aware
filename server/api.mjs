// Tiny Node API server for AuroraView early-access submissions.
// - No framework: built-in http + URL.
// - Validates with Zod, persists to SQLite via better-sqlite3, optional SMTP notify via nodemailer.
// - Designed to bind 127.0.0.1:3001 behind nginx on the VPS.
//
// Env (all optional except DB_PATH default):
//   PORT=3001
//   HOST=127.0.0.1
//   DB_PATH=/var/www/auroraview/data/auroraview.db
//   ALLOWED_ORIGINS=https://example.com,https://www.example.com
//   SMTP_HOST=, SMTP_PORT=587, SMTP_USER=, SMTP_PASS=, SMTP_FROM=, NOTIFY_TO=

import http from "node:http";
import { z } from "zod";
import {
  openDb,
  insertEarlyAccess,
  listEarlyAccess,
  searchEarlyAccess,
  getUserByEmail,
  listCamLabels,
  getCamLabel,
  kvGet,
  kvSet,
  listEvents,
  getEventTimeline,
  createPerson,
  findPersonByName,
  listPeople,
  archivePerson,
  insertFaceEmbedding,
  listRecentFaceMatches,
} from "./db.mjs";
import {
  verifyPassword,
  startSession,
  endSession,
  getCurrentUser,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
  maybeSweepSessions,
  SESSION_COOKIE_NAME,
} from "./auth.mjs";
import * as frigate from "./frigate.mjs";
import { streamChatGpt, isChatConfigured } from "./agent.mjs";
import * as harness from "./harness/index.mjs";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";
const ALLOWED = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const earlyAccessSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  company: z.string().trim().min(1).max(150),
  environment: z.enum(["hangar", "industrial", "logistics", "other"]),
  message: z.string().trim().max(1000).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(1).max(200),
});

const db = openDb();

// Resilience: hydrate the in-process Frigate config cache from kv_cache on
// boot, so /api/cam/cameras serves last-known-good immediately even if Frigate
// is mid-restart at startup.
const KV_FRIGATE_CONFIG = "frigate:rawConfig";
try {
  const persisted = kvGet(db, KV_FRIGATE_CONFIG);
  if (persisted?.value && frigate.hydrateConfigCache) {
    frigate.hydrateConfigCache(persisted.value);
    console.log(`[boot] hydrated frigate config cache from kv_cache (age=${Math.round(persisted.age_ms / 1000)}s)`);
  }
} catch (err) {
  console.warn("[boot] failed to hydrate frigate cache:", err.message);
}

// Boot the agent harness (event bus + tier wiring + health probes).
// This is the ONLY place api.mjs reaches into server/harness/* — all further
// interaction goes through the surface defined in harness/index.mjs. Keeping
// this boundary tight is what makes the harness extractable to a separate
// process/repo later without touching api.mjs again.
try {
  harness.start({ db, frigate });
  console.log("[boot] agent harness started");
} catch (err) {
  console.warn("[boot] harness start failed (non-fatal):", err.message);
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) || req.socket.remoteAddress || "";
}

async function notifyEmail(payload) {
  if (!process.env.SMTP_HOST || !process.env.NOTIFY_TO) return;
  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: process.env.NOTIFY_TO,
    subject: `[AuroraView] Deployment request: ${payload.company}`,
    text: [
      `Name:        ${payload.name}`,
      `Email:       ${payload.email}`,
      `Company:     ${payload.company}`,
      `Environment: ${payload.environment}`,
      "",
      payload.message ?? "(no message)",
    ].join("\n"),
  });
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readJson(req, limit = 32 * 1024) {
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

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  try {
    maybeSweepSessions(db);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/early-access") {
      const body = await readJson(req);
      const parsed = earlyAccessSchema.safeParse(body);
      if (!parsed.success) {
        return send(res, 400, { error: "validation", issues: parsed.error.issues });
      }
      const ip = clientIp(req);
      const ua = req.headers["user-agent"] ?? "";
      insertEarlyAccess(db, { ...parsed.data, ip, user_agent: ua });
      notifyEmail(parsed.data).catch((err) => console.error("[email] notify failed:", err.message));
      return send(res, 201, { ok: true });
    }

    // Legacy admin token endpoint (kept for back-compat with older tooling).
    if (req.method === "GET" && url.pathname === "/api/early-access" && req.headers["x-admin-token"] === process.env.ADMIN_TOKEN) {
      return send(res, 200, { rows: listEarlyAccess(db, 200) });
    }

    // ----- Auth ----------------------------------------------------------
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      const body = await readJson(req);
      const parsed = loginSchema.safeParse(body);
      if (!parsed.success) {
        await delay(200);
        return send(res, 400, { error: "validation", issues: parsed.error.issues });
      }
      const user = getUserByEmail(db, parsed.data.email);
      const ok = user && verifyPassword(parsed.data.password, user.password_hash);
      if (!ok) {
        await delay(200);
        return send(res, 401, { error: "invalid_credentials" });
      }
      const sid = startSession(db, {
        user_id: user.id,
        ip: clientIp(req),
        user_agent: req.headers["user-agent"] ?? "",
      });
      setSessionCookie(res, sid);
      return send(res, 200, { user: { email: user.email, role: user.role } });
    }

    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      const sid = parseCookies(req)[SESSION_COOKIE_NAME];
      endSession(db, sid);
      clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/auth/me") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      return send(res, 200, { user: { email: me.email, role: me.role } });
    }

    // ----- Admin ---------------------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/admin/submissions") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      const q = url.searchParams.get("q") ?? "";
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 200), 1), 1000);
      const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);
      const sort = url.searchParams.get("sort") ?? "id";
      const order = url.searchParams.get("order") ?? "desc";
      const result = searchEarlyAccess(db, { q, limit, offset, sort, order });
      return send(res, 200, result);
    }

    // ----- Cameras (admin-gated proxy to Frigate) ------------------------
    //
    // Resilience contract:
    //   1. Try a live fetch from Frigate.
    //   2. If that fails but we have an in-process cache, serve cached + freshness="stale-mem".
    //   3. If the in-process cache is empty too, fall back to kv_cache on disk.
    //   4. Only return 502 if we have NEVER seen a Frigate config (cold + Frigate down).
    //
    // On every successful live fetch, persist the raw config to kv_cache so a
    // future cold boot can serve last-known-good before Frigate is reachable.
    if (req.method === "GET" && url.pathname === "/api/cam/cameras") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      if (!frigate.isConfigured()) {
        return send(res, 200, { configured: false, cameras: [], freshness: "n/a" });
      }
      try {
        const result = await frigate.listCamerasWithFreshness();
        // Persist raw cache on fresh fetches so cold-boot has data.
        if (result.freshness === "fresh" && frigate.getCachedRawConfig) {
          const raw = frigate.getCachedRawConfig();
          if (raw) {
            try { kvSet(db, KV_FRIGATE_CONFIG, raw); } catch { /* non-fatal */ }
          }
        }
        return send(res, 200, {
          configured: true,
          cameras: result.cameras,
          freshness: result.freshness,
          fetched_at: result.fetched_at,
        });
      } catch (err) {
        // Live + in-process cache both unavailable. Try disk fallback.
        const persisted = kvGet(db, KV_FRIGATE_CONFIG);
        if (persisted?.value?.cameras) {
          // Re-shape from raw config using frigate.mjs's own logic by
          // hydrating + retrying once.
          frigate.hydrateConfigCache(persisted.value);
          try {
            const result = await frigate.listCamerasWithFreshness();
            return send(res, 200, {
              configured: true,
              cameras: result.cameras,
              freshness: "stale-from-disk",
              fetched_at: persisted.fresh_at,
              age_ms: persisted.age_ms,
            });
          } catch {
            // fall through to 502
          }
        }
        console.error("[cam] listCameras failed (no cache):", err.message);
        return send(res, 502, { error: "frigate_unreachable", detail: err.message });
      }
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/cam/snapshot/")) {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      const camera = decodeURIComponent(url.pathname.slice("/api/cam/snapshot/".length));
      if (!camera || !/^[A-Za-z0-9_\-]+$/.test(camera)) {
        return send(res, 400, { error: "invalid_camera" });
      }
      if (!frigate.isConfigured()) return send(res, 503, { error: "frigate_not_configured" });
      const heightParam = url.searchParams.get("h");
      const height = heightParam ? Math.min(Math.max(Number(heightParam) || 0, 60), 1600) : undefined;
      try {
        const snap = await frigate.getSnapshot(camera, { height });
        res.writeHead(200, {
          "Content-Type": snap.contentType,
          "Cache-Control": "no-store",
          "Last-Modified": snap.lastModified,
          "X-Camera": camera,
        });
        return res.end(snap.body);
      } catch (err) {
        console.error("[cam] snapshot failed:", err.message);
        return send(res, 502, { error: "frigate_unreachable", detail: err.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/cam/events") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      if (!frigate.isConfigured()) return send(res, 200, { events: [] });
      const camera = url.searchParams.get("camera") ?? undefined;
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 20), 1), 200);
      const label = url.searchParams.get("label") ?? undefined;
      const after = url.searchParams.get("after") ?? undefined;
      const before = url.searchParams.get("before") ?? undefined;
      try {
        const events = await frigate.getEvents({ camera, limit, label, after, before });
        return send(res, 200, { events });
      } catch (err) {
        console.error("[cam] events failed:", err.message);
        return send(res, 502, { error: "frigate_unreachable", detail: err.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/cam/labels") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      return send(res, 200, { labels: listCamLabels(db) });
    }

    // ----- Agent (admin-gated) -------------------------------------------
    if (req.method === "GET" && url.pathname === "/api/agent/status") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      // Augment with harness diagnostics: bus subscribers, telemetry, quotas,
      // tier3 readiness, AND a live tier2 (Ollama) probe. The harness internals
      // are still hidden — what we expose is exactly what the index.mjs facade
      // chooses to publish.
      // Optional ?probe=async to include the live Ollama tier2 ping. We keep
      // the default sync to avoid making the page-load /status call
      // network-dependent on the Ollama box.
      const wantAsync = url.searchParams.get("probe") === "async";
      let harness_status = null;
      try {
        harness_status = wantAsync ? await harness.statusAsync() : harness.status();
      } catch { /* harness optional */ }
      return send(res, 200, {
        chat_configured: isChatConfigured(),
        frigate_configured: frigate.isConfigured(),
        harness: harness_status,
      });
    }

    // SSE health channel — backed by the harness's TOPIC.HEALTH stream.
    // Wire format: each `data: {...}` line is a JSON snapshot from the
    // 60-second probe (Frigate reachability, Ollama reachability). The
    // frontend can use this to softly indicate stream-source health without
    // needing a "reconnect now" button.
    //
    // Cost: 0. Probes are local-only and cheap. Per the design rule, any
    // narrative summarization on top is routed through the LOCAL Gemma model
    // (server/harness/health.mjs::summarize), never GPT.
    if (req.method === "GET" && url.pathname === "/api/health/cameras") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no", // disable nginx buffering for SSE
      });
      res.write(`: ok\n\n`); // keep-alive comment so the connection opens immediately
      const ac = new AbortController();
      req.on("close", () => ac.abort());
      (async () => {
        try {
          for await (const ev of harness.subscribeHealth(ac.signal)) {
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
          }
        } catch {
          // swallow — connection close is normal
        } finally {
          try { res.end(); } catch { /* ignore */ }
        }
      })();
      return;
    }

    // Read recent harness events (admin-gated). Filter by camera, severity,
    // since (ms epoch). Returns rows newest-first. Used by the future
    // operator review UI and by the chat agent's `get_recent_events` tool.
    if (req.method === "GET" && url.pathname === "/api/agent/events") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      const camera = url.searchParams.get("camera") || undefined;
      const severity = url.searchParams.get("severity") || undefined;
      const since_ms = url.searchParams.get("since_ms")
        ? Number(url.searchParams.get("since_ms"))
        : undefined;
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
      try {
        const rows = listEvents(db, { camera, severity, since_ms, limit });
        return send(res, 200, { rows, count: rows.length });
      } catch (err) {
        return send(res, 500, { error: "events_failed", detail: err.message });
      }
    }

    // Reconstruct the full life of one event by id (all stages).
    if (req.method === "GET" && url.pathname.startsWith("/api/agent/events/")) {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      const event_id = decodeURIComponent(url.pathname.slice("/api/agent/events/".length));
      if (!/^[A-Za-z0-9_\-]+$/.test(event_id)) {
        return send(res, 400, { error: "invalid_event_id" });
      }
      try {
        const timeline = getEventTimeline(db, event_id);
        return send(res, 200, { event_id, timeline });
      } catch (err) {
        return send(res, 500, { error: "timeline_failed", detail: err.message });
      }
    }

    // ---- Phase 4: Face DB endpoints ---------------------------------------
    //
    // Auth: all face endpoints require an admin session. Faces are PII —
    // even a list of names without photos is a security-relevant surface.
    //
    // Storage policy (matches the design doc): we keep the embedding in
    // SQLite by default and DROP the original photo. This is the
    // privacy-default. If we later add an "enable photo retention" flag we
    // can plumb it through here without touching the embedder.

    // List known people (active, with embedding counts).
    if (req.method === "GET" && url.pathname === "/api/agent/faces/people") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      try {
        const status = url.searchParams.get("status") === "archived" ? "archived" : "active";
        const rows = listPeople(db, { status });
        return send(res, 200, { rows, count: rows.length });
      } catch (err) {
        return send(res, 500, { error: "list_failed", detail: err.message });
      }
    }

    // Soft-delete (archive) a known person. Embeddings cascade; face_matches
    // keep their person_id NULL'd so audit history survives.
    if (req.method === "DELETE" && url.pathname.startsWith("/api/agent/faces/people/")) {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      const id = Number(url.pathname.slice("/api/agent/faces/people/".length));
      if (!Number.isInteger(id) || id <= 0) return send(res, 400, { error: "invalid_id" });
      try {
        const r = archivePerson(db, id);
        harness.invalidateFaceCache();
        return send(res, 200, { ok: true, archived: r.changes });
      } catch (err) {
        return send(res, 500, { error: "archive_failed", detail: err.message });
      }
    }

    // Enroll a new face. Body: { name, notes?, image_base64, source_camera? }.
    // The base64 ceiling here is ~10MB, comfortably above any phone-grade JPEG.
    if (req.method === "POST" && url.pathname === "/api/agent/faces/enroll") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });

      let body;
      try {
        body = await readJson(req, 10 * 1024 * 1024);
      } catch (err) {
        return send(res, 400, { error: "bad_body", detail: err.message });
      }
      const enrollSchema = z.object({
        name: z.string().trim().min(1).max(100),
        notes: z.string().trim().max(500).optional(),
        image_base64: z.string().min(64),
        source_camera: z.string().optional(),
      });
      const parsed = enrollSchema.safeParse(body);
      if (!parsed.success) {
        return send(res, 400, { error: "invalid_input", detail: parsed.error.issues });
      }
      const { name, notes, image_base64 } = parsed.data;

      let imageBuffer;
      try {
        // Tolerate "data:image/jpeg;base64," prefix from frontend FileReader.
        const stripped = image_base64.replace(/^data:image\/[^;]+;base64,/, "");
        imageBuffer = Buffer.from(stripped, "base64");
        if (imageBuffer.length < 200) throw new Error("decoded image too small");
      } catch (err) {
        return send(res, 400, { error: "bad_image", detail: err.message });
      }

      let embedded;
      try {
        embedded = await harness.recognizeFaces({
          imageBuffer,
          camera: parsed.data.source_camera ?? "",
          recordMatch: false, // enrollment isn't a "match event"
        });
      } catch (err) {
        return send(res, 502, { error: "embedder_unreachable", detail: err.message });
      }
      if (!embedded?.faces?.length) {
        return send(res, 422, {
          error: "no_face_detected",
          known_count: embedded?.known_count ?? 0,
        });
      }
      // Use the highest-quality face. Multi-face enrollment frames are an
      // operator error — we surface the best one and tell them.
      const sorted = [...embedded.faces].sort((a, b) => b.quality - a.quality);
      const best = sorted[0];
      if (best.quality < 0.4) {
        return send(res, 422, {
          error: "face_too_low_quality",
          quality: best.quality,
          hint: "Re-shoot with better light, ~1m from camera, looking forward.",
        });
      }

      // Get-or-create the person. Adds another embedding if name already exists.
      let person = findPersonByName(db, { name });
      if (!person) {
        person = createPerson(db, { name, notes: notes ?? null, created_by: me.user_id });
      }

      // Re-embed via the sidecar to get the raw 512-d vector (recognize()
      // already has it, but we don't expose it on its return shape).
      // Pull it from the embedder directly to keep storage exact.
      let rawEmbed;
      try {
        rawEmbed = await harness.embedFace({ imageBuffer });
      } catch (err) {
        return send(res, 502, { error: "embedder_unreachable_on_store", detail: err.message });
      }
      const bestRaw = rawEmbed?.faces?.length
        ? [...rawEmbed.faces].sort((a, b) => b.quality - a.quality)[0]
        : null;
      if (!bestRaw) {
        return send(res, 500, { error: "embedder_inconsistent", detail: "second-pass embed returned no face" });
      }

      const embedding = Float32Array.from(bestRaw.embedding);
      const embedding_id = insertFaceEmbedding(db, {
        person_id: person.id,
        model: harness.FACE_CONFIG.model_tag,
        vec: embedding,
        quality: bestRaw.quality,
        source: "enrollment",
        photo_path: null,
        created_by: me.user_id,
      });
      harness.invalidateFaceCache();

      return send(res, 200, {
        ok: true,
        person: {
          id: person.id,
          name: person.name,
          notes: person.notes,
        },
        embedding: {
          id: embedding_id,
          quality: bestRaw.quality,
          vec_dim: embedding.length,
          model: harness.FACE_CONFIG.model_tag,
        },
        face_count_in_frame: embedded.faces.length,
      });
    }

    // Run recognition against a live snapshot — operator's "test recognition"
    // button. Doesn't write to face_matches by default so it doesn't pollute
    // history (caller can pass record=true).
    if (req.method === "POST" && url.pathname === "/api/agent/faces/recognize-now") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      let body;
      try { body = await readJson(req); } catch (err) { return send(res, 400, { error: "bad_body", detail: err.message }); }
      const camera = String(body?.camera ?? "").trim();
      if (!camera) return send(res, 400, { error: "camera_required" });
      let snap;
      try {
        snap = await frigate.getSnapshot(camera, { height: 720 });
      } catch (err) {
        return send(res, 502, { error: "snapshot_failed", detail: err.message });
      }
      try {
        const r = await harness.recognizeFaces({
          imageBuffer: snap.body,
          camera,
          recordMatch: Boolean(body?.record),
        });
        return send(res, 200, r);
      } catch (err) {
        return send(res, 502, { error: "embedder_unreachable", detail: err.message });
      }
    }

    // Recent face_matches log (for chat tool + admin UI).
    if (req.method === "GET" && url.pathname === "/api/agent/faces/matches") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      const camera = url.searchParams.get("camera") || null;
      const personRaw = url.searchParams.get("person_id");
      const person_id =
        personRaw === "unknown" ? "unknown" :
        personRaw ? Number(personRaw) :
        null;
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 500);
      try {
        const rows = listRecentFaceMatches(db, { camera, person_id, limit });
        return send(res, 200, { rows, count: rows.length });
      } catch (err) {
        return send(res, 500, { error: "matches_failed", detail: err.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/agent/detections") {
      // Phase 3: this endpoint is now ROUTER-DRIVEN.
      //   - T2 (local Ollama VLM, $0) runs every tick — cheap.
      //   - T3 (GPT-4o-mini vision, ~$0.0001) only fires when T2 says
      //     severity >= notable AND we're past the per-camera refresh window.
      // Cost: ~70-95% reduction vs Phase 2 in typical usage.
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      const camera = url.searchParams.get("camera") ?? "";
      if (!/^[A-Za-z0-9_\-]+$/.test(camera)) return send(res, 400, { error: "invalid_camera" });
      if (!frigate.isConfigured()) return send(res, 200, { detections: [], status: "frigate_not_configured" });

      // Optional ?mode= override (admin debugging). Falls back to
      // DETECTION_ROUTER_MODE env (default "t2-gates-t3").
      const allowedModes = new Set(["always-t3", "t2-gates-t3", "t2-only", "off"]);
      const reqMode = url.searchParams.get("mode");
      const mode = allowedModes.has(reqMode) ? reqMode : undefined;

      const tenant = "default";

      // T2 quota gate — even local calls use shared GPU; protect it.
      const t2Gate = harness.checkQuota({ tenant, camera, kind: "t2-vision" });
      if (!t2Gate.allowed) {
        return send(res, 429, { error: "quota_exceeded", reason: t2Gate.reason, kind: "t2-vision" });
      }

      try {
        const snap = await frigate.getSnapshot(camera, { height: 480 });
        const result = await harness.timed("agent.detections", () =>
          harness.analyzeImageRouted({ imageBuffer: snap.body, camera, mode }),
        );

        // Record T2 always. Record T3 ONLY if it actually ran live.
        harness.recordQuota({ tenant, camera, kind: "t2-vision", dollars: 0 });
        if (result.escalation?.ran) {
          // Re-check T3 budget AFTER the call so a quota cap reduces but
          // doesn't outright block a critical T3 escalation. Ledger keeps
          // the spend honest even if the gate would have refused.
          harness.recordQuota({ tenant, camera, kind: "t3-vision", dollars: 0.0001 });
        }

        return send(res, 200, { camera, ...result });
      } catch (err) {
        console.error("[agent] detections failed:", err.message);
        return send(res, 502, { error: "agent_failed", detail: err.message });
      }
    }

    if (req.method === "GET" && url.pathname === "/api/agent/scene") {
      // Tier 2 (local Ollama VLM) scene description. Cheap, $0 marginal —
      // gated by per-camera/tenant quota only to protect GPU budget on the
      // shared Ollama box, not to control dollars.
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      const camera = url.searchParams.get("camera") ?? "";
      if (!/^[A-Za-z0-9_\-]+$/.test(camera)) return send(res, 400, { error: "invalid_camera" });
      if (!frigate.isConfigured()) return send(res, 200, { status: "frigate_not_configured", tier: "T2" });
      const tenant = "default";
      const gate = harness.checkQuota({ tenant, camera, kind: "t2-vision" });
      if (!gate.allowed) {
        return send(res, 429, { error: "quota_exceeded", reason: gate.reason });
      }
      try {
        // h=240 is enough for moondream-class scene description and keeps
        // the prompt token count low (~750 tokens vs ~2000 at h=480).
        const snap = await frigate.getSnapshot(camera, { height: 240 });
        const result = await harness.timed("agent.scene", () =>
          harness.analyzeImageLocal({ imageBuffer: snap.body, camera }),
        );
        if (result.ok) {
          harness.recordQuota({ tenant, camera, kind: "t2-vision", dollars: 0 });
        }
        return send(res, 200, {
          camera,
          tier: "T2",
          status: result.ok ? "ok" : "error",
          scene: result.scene,
          severity: result.severity,
          alert_type: result.alert_type,
          confidence: result.confidence,
          reason: result.reason,
          model: result.tier2_meta?.model ?? null,
          tookMs: result.tier2_meta?.tookMs ?? null,
          error: result.ok ? null : result.tier2_meta?.errorDetail ?? "unknown",
        });
      } catch (err) {
        console.error("[agent] scene failed:", err.message);
        return send(res, 502, { error: "scene_failed", detail: err.message, tier: "T2" });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/agent/chat") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return send(res, 400, { error: "invalid_json" });
      }
      const messages = Array.isArray(body?.messages) ? body.messages.slice(-20) : [];
      const camera = String(body?.camera ?? "").slice(0, 64) || "Garage";
      const labelRow = getCamLabel(db, camera);
      const cameraLabel = labelRow?.label ?? camera;
      const cleanMessages = messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (cleanMessages.length === 0 || cleanMessages.at(-1).role !== "user") {
        return send(res, 400, { error: "messages must end with a user turn" });
      }

      // Quota gate. Chat is per-tenant only (camera not gated for chat
      // because it's user-driven, not stream-driven).
      const tenant = "default";
      const gate = harness.checkQuota({ tenant, kind: "t3-chat" });
      if (!gate.allowed) {
        return send(res, 429, { error: "quota_exceeded", reason: gate.reason });
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const writeEvent = (obj) => {
        try {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        } catch {
          /* client disconnected */
        }
      };

      const ac = new AbortController();
      req.on("close", () => ac.abort());
      const t0 = Date.now();
      let chatErrored = false;
      try {
        for await (const evt of streamChatGpt({
          messages: cleanMessages,
          camera,
          cameraLabel,
          db,
          user: { id: me.user_id, email: me.email, role: me.role },
          // Inject the harness public surface so chat tools can read T2 scene,
          // router status, etc. without agent.mjs ever importing harness/*.
          harness,
          signal: ac.signal,
        })) {
          writeEvent(evt);
          if (evt.type === "done") break;
          if (evt.type === "error") chatErrored = true;
        }
      } catch (err) {
        chatErrored = true;
        writeEvent({ type: "error", message: err.message });
        writeEvent({ type: "done" });
      } finally {
        // Telemetry + quota record happen at end-of-stream regardless of
        // success/failure so we always know what happened.
        harness.observeLatency(chatErrored ? "agent.chat.error" : "agent.chat", Date.now() - t0);
        if (!chatErrored) {
          harness.recordQuota({ tenant, kind: "t3-chat" });
        }
      }
      return res.end();
    }

    return send(res, 404, { error: "not_found" });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "server_error" });
  }
});

// ----- WebSocket: live MSE stream proxy ---------------------------------
// Path: /api/cam/stream/<camera>
// Auth: same admin session cookie as REST routes (verified in `verifyClient`).
// Upstream: Frigate's /live/mse/api/ws?src=<camera> (wss, self-signed loopback).
// We pipe text+binary frames in BOTH directions:
//   client -> upstream: codec init message ({"type":"mse","value":"..."})
//   upstream -> client: codec ack + fMP4 init segment + media segments
//
// Treads carefully:
//   - Auth is checked BEFORE the upgrade completes (so unauth attempts get a clean 401).
//   - Either side closing tears the other down within ~50ms; no zombie sockets.
//   - All upstream errors are swallowed and logged; api server stays alive.
const camStreamWss = new WebSocketServer({ noServer: true });

// Set of every open (client, upstream) WS pair. Lets us drain cleanly on
// SIGTERM instead of waiting 90s for systemd to kill us. Each entry is a
// `() => void` that closes both sides and removes itself from the set.
const openStreamCloseFns = new Set();

server.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
    if (!url.pathname.startsWith("/api/cam/stream/")) {
      socket.destroy();
      return;
    }

    // Authenticate using the same session cookie used by REST routes.
    const me = getCurrentUser(db, req);
    if (!me || me.role !== "admin") {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    const camera = decodeURIComponent(url.pathname.slice("/api/cam/stream/".length));
    if (!camera || !/^[A-Za-z0-9_\-]+$/.test(camera)) {
      socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!frigate.isConfigured()) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    // Open upstream FIRST. If it fails, return 502 without ever upgrading the client.
    let upstream;
    try {
      upstream = await frigate.openMseStream(camera);
    } catch (err) {
      console.error("[cam/stream] upstream open failed:", err.message);
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    // Wait for upstream "open" before completing the client upgrade — that way
    // if Frigate rejects auth or the camera, we surface 502 cleanly.
    upstream.once("open", () => {
      camStreamWss.handleUpgrade(req, socket, head, (client) => {
        let closer;
        const closeBoth = (reason) => {
          try { client.close(1011, reason); } catch {}
          try { upstream.close(); } catch {}
          if (closer) openStreamCloseFns.delete(closer);
        };
        // Register for graceful-shutdown drain.
        closer = () => closeBoth("server_shutdown");
        openStreamCloseFns.add(closer);

        // client -> upstream
        client.on("message", (data, isBinary) => {
          if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary });
        });
        client.on("close", () => closeBoth("client_closed"));
        client.on("error", (err) => {
          console.error("[cam/stream] client error:", err.message);
          closeBoth("client_error");
        });

        // upstream -> client
        upstream.on("message", (data, isBinary) => {
          if (client.readyState === client.OPEN) client.send(data, { binary: isBinary });
        });
        upstream.on("close", () => closeBoth("upstream_closed"));
        upstream.on("error", (err) => {
          console.error("[cam/stream] upstream error:", err.message);
          closeBoth("upstream_error");
        });

        console.log(`[cam/stream] proxy open: ${me.email} -> Frigate(${camera})`);
      });
    });
    upstream.once("error", (err) => {
      console.error("[cam/stream] upstream early error:", err.message);
      try {
        socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      } catch {}
      socket.destroy();
    });
  } catch (err) {
    console.error("[cam/stream] upgrade handler error:", err);
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[auroraview-api] listening on http://${HOST}:${PORT}`);
});

// Graceful shutdown — without explicit draining of long-lived WebSockets,
// `server.close()` waits forever and systemd kills us at the 90s timeout.
// We:
//   1. Stop accepting new HTTP connections.
//   2. Close every open MSE proxy pair (clients reconnect on restart).
//   3. Stop the harness (which closes its own WS to Frigate + cancels timers).
//   4. Wait up to 5s for the http server to drain, then exit.
let shuttingDown = false;
function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[auroraview-api] received ${sig}, shutting down`);
  server.close(() => {
    console.log("[auroraview-api] server.close completed");
  });
  // Drain MSE pairs.
  const n = openStreamCloseFns.size;
  for (const fn of [...openStreamCloseFns]) {
    try { fn(); } catch (err) { console.warn("[shutdown] close fn threw:", err?.message); }
  }
  openStreamCloseFns.clear();
  console.log(`[auroraview-api] closed ${n} MSE stream(s)`);
  // Stop the harness (T0 ws, T1, eventlog, health timers).
  try { harness.stop(); } catch (err) { console.warn("[shutdown] harness.stop threw:", err?.message); }
  // Hard-cap the wait: if anything still holds the loop open, force-exit.
  setTimeout(() => {
    console.log("[auroraview-api] forced exit after drain timeout");
    process.exit(0);
  }, 5000).unref();
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => gracefulShutdown(sig));
}
