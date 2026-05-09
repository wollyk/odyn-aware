// AuroraView API server — thin orchestrator.
//
// All actual route handlers live in server/routes/*.mjs. This file's job:
//   1. Open the DB + boot the harness.
//   2. Walk the route registry per request, first match wins.
//   3. Own the WebSocket-upgrade path for live MSE proxying (this CAN'T
//      live in a normal route module because it hooks server.upgrade).
//   4. Graceful shutdown (drain WS pairs, stop harness, exit).
//
// History note: pre-Phase-6 this file was 1,059 lines of sequential
// `if (req.method === "..." && url.pathname === "...")` blocks. The
// refactor extracts those into per-feature route modules so api.mjs stays
// compact even as we add Phase 6 weapon endpoints, future face-search,
// tenant admin, etc. Adding a route is now: write a new routes/*.mjs file
// and import it into the registry below.
//
// Env (all optional except DB_PATH default):
//   PORT=3001
//   HOST=127.0.0.1
//   DB_PATH=/var/www/auroraview/data/auroraview.db
//   ALLOWED_ORIGINS=https://example.com,https://www.example.com
//   SMTP_HOST=, SMTP_PORT=587, SMTP_USER=, SMTP_PASS=, SMTP_FROM=, NOTIFY_TO=
//   PUBLIC_BASE_URL=https://auroraview.tech    (used in alert email body)
//   ALERT_WEBHOOK_TIMEOUT_MS=5000              (Phase-7 webhook deadline)

import http from "node:http";
import { WebSocketServer } from "ws";
import { openDb } from "./db.mjs";
import { getCurrentUser, maybeSweepSessions } from "./auth.mjs";
import * as frigate from "./frigate.mjs";
import * as harness from "./harness/index.mjs";
import { send, setCors, CloserBag } from "./http-utils.mjs";

import * as earlyAccess from "./routes/early-access.mjs";
import * as authRoutes from "./routes/auth.mjs";
import * as adminRoutes from "./routes/admin.mjs";
import * as cameraRoutes from "./routes/cameras.mjs";
import * as agentStatus from "./routes/agent-status.mjs";
import * as agentEvents from "./routes/agent-events.mjs";
import * as agentFaces from "./routes/agent-faces.mjs";
import * as agentWeapon from "./routes/agent-weapon.mjs";
import * as agentSummaries from "./routes/agent-summaries.mjs";
import * as agentDetections from "./routes/agent-detections.mjs";
import * as agentAlerts from "./routes/agent-alerts.mjs";
import * as agentTracks from "./routes/agent-tracks.mjs";
import * as agentChat from "./routes/agent-chat.mjs";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

const db = openDb();

// Hydrate the in-process Frigate config cache from kv_cache so /api/cam/cameras
// serves last-known-good immediately even if Frigate is mid-restart at startup.
cameraRoutes.hydrateOnBoot({ db, frigate });

// Boot the agent harness (event bus + tier wiring + health probes). This
// is the ONLY place api.mjs reaches into server/harness/* — all further
// interaction goes through the surface defined in harness/index.mjs.
try {
  harness.start({ db, frigate });
  console.log("[boot] agent harness started");
} catch (err) {
  console.warn("[boot] harness start failed (non-fatal):", err.message);
}

// Route registry. Walked in order; the first module to return true wins.
// Cheap routes first (health) so the noise floor doesn't pay for the
// whole chain.
const ctx = { db, frigate, harness };
const ROUTES = [
  earlyAccess,
  authRoutes,
  adminRoutes,
  cameraRoutes,
  agentStatus,
  agentEvents,
  agentFaces,
  agentWeapon,
  agentSummaries,
  agentDetections,
  agentAlerts,
  agentTracks,
  agentChat,
];

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  try {
    maybeSweepSessions(db);

    // Cheap health endpoint — kept inline so it's a single line of work.
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true });
    }

    for (const mod of ROUTES) {
      if (await mod.register(req, res, url, ctx)) return;
    }

    return send(res, 404, { error: "not_found" });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "server_error" });
  }
});

// ----- WebSocket: live MSE stream proxy ---------------------------------
// Path: /api/cam/stream/<camera>
// Auth: same admin session cookie as REST routes.
// Upstream: Frigate's /live/mse/api/ws?src=<camera> (wss, self-signed loopback).
//
// Why this isn't a route module: WebSocket upgrades are handled by
// server.on("upgrade") which is on the http.Server itself, not the request
// handler. Keeping it here means the route registry can stay
// request/response-shaped.
const camStreamWss = new WebSocketServer({ noServer: true });
// Phase-10: tracker WS proxy server. Hands a client WS to the upstream
// tracker sidecar at TRACKER_BASE/ws?camera=<name>. Behaves exactly like
// the cam/stream proxy in terms of admin auth + drain on shutdown.
const trackerWss = new WebSocketServer({ noServer: true });
const TRACKER_BASE = process.env.TRACKER_BASE ?? "ws://127.0.0.1:8767";

// Track every open (client, upstream) WS pair so we can drain them on
// SIGTERM instead of waiting 90s for systemd to kill us.
const openStreamCloseFns = new CloserBag();

server.on("upgrade", async (req, socket, head) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);

    // Phase-10: object tracker stream — pass-through to the python sidecar.
    if (url.pathname.startsWith("/api/tracker/")) {
      const me = getCurrentUser(db, req);
      if (!me || me.role !== "admin") {
        socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      const cam = decodeURIComponent(url.pathname.slice("/api/tracker/".length));
      if (!cam || !/^[A-Za-z0-9_\-]+$/.test(cam)) {
        socket.write("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      const upstreamUrl = `${TRACKER_BASE}/ws?camera=${encodeURIComponent(cam)}`;
      let upstream;
      try {
        const WS = (await import("ws")).default;
        upstream = new WS(upstreamUrl);
      } catch (err) {
        console.error("[tracker] upstream open failed:", err.message);
        socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
        socket.destroy();
        return;
      }
      upstream.once("open", () => {
        trackerWss.handleUpgrade(req, socket, head, (client) => {
          let unregister = null;
          const closeBoth = (reason) => {
            try { client.close(1011, reason); } catch { /* ignore */ }
            try { upstream.close(); } catch { /* ignore */ }
            if (unregister) unregister();
          };
          unregister = openStreamCloseFns.add(() => closeBoth("server_shutdown"));
          // upstream -> client (the broadcast)
          upstream.on("message", (data, isBinary) => {
            if (client.readyState === client.OPEN) client.send(data, { binary: isBinary });
          });
          upstream.on("close", () => closeBoth("upstream_closed"));
          upstream.on("error", (err) => {
            console.error("[tracker] upstream error:", err.message);
            closeBoth("upstream_error");
          });
          // client -> upstream (mostly empty; sidecar treats input as a no-op)
          client.on("message", (data, isBinary) => {
            if (upstream.readyState === upstream.OPEN) upstream.send(data, { binary: isBinary });
          });
          client.on("close", () => closeBoth("client_closed"));
          client.on("error", (err) => {
            console.error("[tracker] client error:", err.message);
            closeBoth("client_error");
          });
          console.log(`[tracker] proxy open: ${me.email} -> sidecar(${cam})`);
        });
      });
      upstream.once("error", (err) => {
        console.error("[tracker] upstream early error:", err.message);
        try { socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); } catch { /* ignore */ }
        socket.destroy();
      });
      return;
    }

    if (!url.pathname.startsWith("/api/cam/stream/")) {
      socket.destroy();
      return;
    }

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

    // Open upstream FIRST. If it fails, return 502 without ever upgrading.
    let upstream;
    try {
      upstream = await frigate.openMseStream(camera);
    } catch (err) {
      console.error("[cam/stream] upstream open failed:", err.message);
      socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    // Wait for upstream "open" before completing the client upgrade — that
    // way Frigate auth/camera errors surface as 502 cleanly.
    upstream.once("open", () => {
      camStreamWss.handleUpgrade(req, socket, head, (client) => {
        let unregister = null;
        const closeBoth = (reason) => {
          try { client.close(1011, reason); } catch {}
          try { upstream.close(); } catch {}
          if (unregister) unregister();
        };
        unregister = openStreamCloseFns.add(() => closeBoth("server_shutdown"));

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
      try { socket.write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"); } catch {}
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
//   4. Hard 5s cap then process.exit(0).
let shuttingDown = false;
function gracefulShutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[auroraview-api] received ${sig}, shutting down`);
  server.close(() => console.log("[auroraview-api] server.close completed"));
  const n = openStreamCloseFns.drainAll("cam/stream");
  console.log(`[auroraview-api] closed ${n} MSE stream(s)`);
  try { harness.stop(); }
  catch (err) { console.warn("[shutdown] harness.stop threw:", err?.message); }
  setTimeout(() => {
    console.log("[auroraview-api] forced exit after drain timeout");
    process.exit(0);
  }, 5000).unref();
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => gracefulShutdown(sig));
}
