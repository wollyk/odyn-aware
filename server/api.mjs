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
import { streamChatGpt, analyzeImage, isChatConfigured } from "./agent.mjs";
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
    if (req.method === "GET" && url.pathname === "/api/cam/cameras") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      if (!frigate.isConfigured()) {
        return send(res, 200, { configured: false, cameras: [] });
      }
      try {
        const cameras = await frigate.listCameras();
        return send(res, 200, { configured: true, cameras });
      } catch (err) {
        console.error("[cam] listCameras failed:", err.message);
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
      return send(res, 200, {
        chat_configured: isChatConfigured(),
        frigate_configured: frigate.isConfigured(),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/agent/detections") {
      const me = getCurrentUser(db, req);
      if (!me) return send(res, 401, { error: "unauthenticated" });
      if (me.role !== "admin") return send(res, 403, { error: "forbidden" });
      const camera = url.searchParams.get("camera") ?? "";
      if (!/^[A-Za-z0-9_\-]+$/.test(camera)) return send(res, 400, { error: "invalid_camera" });
      if (!frigate.isConfigured()) return send(res, 200, { detections: [], status: "frigate_not_configured" });
      try {
        const snap = await frigate.getSnapshot(camera, { height: 480 });
        const result = await analyzeImage({ imageBuffer: snap.body, camera });
        return send(res, 200, { camera, ...result });
      } catch (err) {
        console.error("[agent] detections failed:", err.message);
        return send(res, 502, { error: "agent_failed", detail: err.message });
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
      // Validate message shape
      const cleanMessages = messages
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
      if (cleanMessages.length === 0 || cleanMessages.at(-1).role !== "user") {
        return send(res, 400, { error: "messages must end with a user turn" });
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
      try {
        for await (const evt of streamChatGpt({
          messages: cleanMessages,
          camera,
          cameraLabel,
          db,
          user: { id: me.user_id, email: me.email, role: me.role },
          signal: ac.signal,
        })) {
          writeEvent(evt);
          if (evt.type === "done") break;
        }
      } catch (err) {
        writeEvent({ type: "error", message: err.message });
        writeEvent({ type: "done" });
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
        const closeBoth = (reason) => {
          try { client.close(1011, reason); } catch {}
          try { upstream.close(); } catch {}
        };

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

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`[auroraview-api] received ${sig}, shutting down`);
    server.close(() => process.exit(0));
  });
}
