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
import { openDb, insertEarlyAccess, listEarlyAccess } from "./db.mjs";

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

const db = openDb();

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

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === "OPTIONS") return send(res, 204, "");
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/early-access") {
      const body = await readJson(req);
      const parsed = earlyAccessSchema.safeParse(body);
      if (!parsed.success) {
        return send(res, 400, { error: "validation", issues: parsed.error.issues });
      }
      const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) || req.socket.remoteAddress || "";
      const ua = req.headers["user-agent"] ?? "";
      insertEarlyAccess(db, { ...parsed.data, ip, user_agent: ua });
      notifyEmail(parsed.data).catch((err) => console.error("[email] notify failed:", err.message));
      return send(res, 201, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/early-access" && req.headers["x-admin-token"] === process.env.ADMIN_TOKEN) {
      return send(res, 200, { rows: listEarlyAccess(db, 200) });
    }

    return send(res, 404, { error: "not_found" });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: "server_error" });
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
