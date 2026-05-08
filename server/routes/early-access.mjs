// Public early-access form + legacy admin token list endpoint.
//
// Pre-refactor: lived inline in api.mjs.
// Surface (unchanged):
//   POST /api/early-access      public form submission, optional SMTP notify
//   GET  /api/early-access      legacy admin-token gated list (back-compat)
//
// The new admin-session-gated list is in routes/admin.mjs.

import { z } from "zod";
import { insertEarlyAccess, listEarlyAccess } from "../db.mjs";
import { send, readJson, clientIp } from "../http-utils.mjs";

const earlyAccessSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  company: z.string().trim().min(1).max(150),
  environment: z.enum(["hangar", "industrial", "logistics", "other"]),
  message: z.string().trim().max(1000).optional(),
});

/**
 * Best-effort email notification on a new submission. Lazy-loads
 * nodemailer so the server doesn't pay the require cost when SMTP is
 * unconfigured (the common dev case).
 */
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

/**
 * Try-handle handler. Returns true if the request was matched and a
 * response was sent.
 *
 * @param {{ db: object }} ctx
 */
export async function register(req, res, url, ctx) {
  const { db } = ctx;

  if (req.method === "POST" && url.pathname === "/api/early-access") {
    const body = await readJson(req);
    const parsed = earlyAccessSchema.safeParse(body);
    if (!parsed.success) {
      send(res, 400, { error: "validation", issues: parsed.error.issues });
      return true;
    }
    const ip = clientIp(req);
    const ua = req.headers["user-agent"] ?? "";
    insertEarlyAccess(db, { ...parsed.data, ip, user_agent: ua });
    notifyEmail(parsed.data).catch((err) => console.error("[email] notify failed:", err.message));
    send(res, 201, { ok: true });
    return true;
  }

  // Legacy admin token endpoint (kept for back-compat with older tooling).
  if (
    req.method === "GET" &&
    url.pathname === "/api/early-access" &&
    req.headers["x-admin-token"] === process.env.ADMIN_TOKEN
  ) {
    send(res, 200, { rows: listEarlyAccess(db, 200) });
    return true;
  }

  return false;
}
