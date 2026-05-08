// Phase-7 alert delivery.
//
// Subscribes to TOPIC.ALERT (published by analyzeImageRouted when
// severity >= notable OR weapon.decision === "suspicious"). For each
// alert, walks all active destinations and dispatches if the
// destination's min_severity is satisfied AND the (dest, camera,
// alert_type) cooldown has elapsed.
//
// Design choices:
//   - In-memory cooldown map. Hydrated from alert_dispatches on boot so
//     a restart doesn't re-fire stale alerts. SQLite write contention
//     would be silly when this is purely an O(destinations × alerts) check.
//   - Fire-and-forget dispatch. Email/webhook latency must NEVER block
//     analyzeImageRouted (which is the user-visible 5s tick).
//   - Append-only audit log. Every dispatch — success, failure, OR
//     suppressed-by-cooldown — writes one row to alert_dispatches.
//   - Webhook signing. If webhook_secret is set, we attach
//     `X-AuroraView-Signature: sha256=<hmac>` so the receiver can verify.
//   - Email sender reuses the same SMTP_* env vars as the early-access
//     notifier; nodemailer is lazy-loaded.
//
// What we DON'T do here:
//   - Per-camera-per-rule routing. v1 is "all destinations get all alerts
//     above their min_severity". A rules editor is Phase 7.1.
//   - SMS / push. Email + webhook covers 95% of MVP.
//   - Image attachments. Privacy-conscious default — link back to the
//     admin/live page instead of shipping a face crop in email.

import { subscribe } from "./eventbus.mjs";
import { TOPIC, SEVERITY } from "./types.mjs";
import { increment } from "./telemetry.mjs";
import {
  listAlertDestinations,
  recordAlertDispatch,
  hydrateCooldownMap,
} from "../db/alerts.mjs";
import crypto from "node:crypto";

let _db = null;
let _started = false;
let _unsubscribe = null;

/**
 * Cooldown map. Key: `${destination_id}:${camera}:${alert_type}`.
 * Value: last-sent epoch ms. Stale entries are GC'd on every check.
 */
const _cooldown = new Map();

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "https://auroraview.tech").replace(/\/+$/, "");
const WEBHOOK_TIMEOUT_MS = Number(process.env.ALERT_WEBHOOK_TIMEOUT_MS ?? 5000);

export function start({ db } = {}) {
  if (!db) throw new Error("alerts.start requires { db }");
  if (_started) return;
  _db = db;
  _started = true;

  // Hydrate cooldowns from the audit log so a restart doesn't immediately
  // re-fire alerts that were sent <cooldown ago.
  try {
    const rows = hydrateCooldownMap(db);
    for (const r of rows) {
      const key = cooldownKey(r.destination_id, r.camera, r.alert_type);
      _cooldown.set(key, new Date(r.last_sent).getTime());
    }
    if (rows.length > 0) {
      console.log(`[alerts] hydrated ${rows.length} cooldown entries from dispatch log`);
    }
  } catch (err) {
    console.error("[alerts] cooldown hydration failed:", err?.message);
  }

  _unsubscribe = subscribe(TOPIC.ALERT, (alert) => {
    // Synchronous in subscriber, but the actual send is async + non-blocking.
    handleAlert(alert).catch((err) => {
      console.error("[alerts] handleAlert threw:", err?.message);
      increment("alerts.handler_errors");
    });
  });
}

export function stop() {
  if (!_started) return;
  if (_unsubscribe) {
    _unsubscribe();
    _unsubscribe = null;
  }
  _started = false;
  _db = null;
  _cooldown.clear();
}

/**
 * Test-only: clear the in-memory cooldown map without bouncing the
 * harness. Used by tests; safe to expose because production cooldown
 * data is durable (alert_dispatches).
 */
export function _resetCooldownsForTests() {
  _cooldown.clear();
}

function cooldownKey(destination_id, camera, alert_type) {
  return `${destination_id ?? "x"}:${camera ?? ""}:${alert_type ?? ""}`;
}

/**
 * Test/operator hook. Used by the "send test alert" button to dispatch
 * a synthetic alert against ONE destination, bypassing cooldown.
 */
export async function sendTestAlert({ destination, camera = "test", actor = "operator" }) {
  if (!destination) throw new Error("destination required");
  const alert = {
    event_id: `test_${Date.now().toString(36)}`,
    tenant_id: destination.tenant_id ?? "default",
    camera,
    severity: "critical",
    alert_type: "test_alert",
    title: `[AuroraView] Test alert: ${camera}`,
    body: [
      `This is a test alert from AuroraView, requested by ${actor}.`,
      "",
      `If you're reading this, the dispatch path to ${destination.type} ${destination.target} is healthy.`,
      "",
      `Open the live view: ${PUBLIC_BASE_URL}/admin/live`,
    ].join("\n"),
    summary: "test alert — no real event",
    confidence: 1.0,
    weapon: { decision: "clear" },
    known_face_count: 0,
    unknown_face_count: 0,
    test: true,
  };
  const result = await dispatch(destination, alert, { ignoreCooldown: true });
  return result;
}

// ---- internals ----------------------------------------------------------

async function handleAlert(alert) {
  if (!_db || !_started) return;
  const tenant_id = alert?.tenant_id ?? "default";

  let destinations;
  try {
    destinations = listAlertDestinations(_db, { tenant_id, status: "active" });
  } catch (err) {
    console.error("[alerts] listAlertDestinations failed:", err?.message);
    increment("alerts.list_errors");
    return;
  }
  if (destinations.length === 0) {
    increment("alerts.no_destinations");
    return;
  }

  // Process destinations in parallel — each one is fail-isolated so a
  // bad webhook can't block the email send.
  await Promise.allSettled(destinations.map((dest) => dispatch(dest, alert, { ignoreCooldown: false })));
}

/**
 * Walk one destination's filter chain. Returns
 *   { ok: boolean, status: "sent"|"failed"|"suppressed", error?: string }.
 */
async function dispatch(destination, alert, { ignoreCooldown = false } = {}) {
  const tenant_id = alert?.tenant_id ?? destination.tenant_id ?? "default";
  const camera = alert?.camera ?? null;
  const alert_type = alert?.alert_type ?? null;

  // 1. min_severity filter. Notable < critical in SEVERITY ordering.
  const wantSev = SEVERITY[destination.min_severity ?? "critical"] ?? SEVERITY.critical;
  const haveSev = SEVERITY[alert?.severity ?? "normal"] ?? SEVERITY.normal;
  if (!ignoreCooldown && haveSev < wantSev) {
    // Below threshold — don't even log; this would be log spam.
    increment("alerts.below_threshold");
    return { ok: false, status: "filtered", error: "below_min_severity" };
  }

  // 2. Cooldown check.
  if (!ignoreCooldown) {
    const key = cooldownKey(destination.id, camera, alert_type);
    const last = _cooldown.get(key);
    const cooldownMs = (Number(destination.cooldown_seconds) || 300) * 1000;
    if (last && Date.now() - last < cooldownMs) {
      const remainSec = Math.ceil((cooldownMs - (Date.now() - last)) / 1000);
      try {
        recordAlertDispatch(_db, {
          tenant_id,
          destination_id: destination.id,
          destination_type: destination.type,
          destination_target: destination.target,
          event_id: alert.event_id,
          camera,
          severity: alert.severity,
          alert_type,
          title: alert.title,
          body: alert.body,
          status: "suppressed",
          error: `cooldown:${remainSec}s_remaining`,
        });
      } catch (err) { /* never break dispatch on audit-write fail */ console.error("[alerts] audit write failed:", err?.message); }
      increment("alerts.suppressed_cooldown");
      return { ok: false, status: "suppressed", error: `cooldown:${remainSec}s` };
    }
  }

  // 3. Send.
  const t0 = Date.now();
  let send;
  if (destination.type === "email") send = sendEmailAlert;
  else if (destination.type === "webhook") send = sendWebhookAlert;
  else {
    return logAndReturn(destination, alert, {
      status: "failed",
      error: `unsupported_destination_type:${destination.type}`,
      duration_ms: 0,
    });
  }

  let outcome;
  try {
    outcome = await send(destination, alert);
  } catch (err) {
    outcome = { ok: false, http_status: null, error: err?.message ?? "send_threw" };
  }
  const duration_ms = Date.now() - t0;

  if (outcome.ok) {
    const key = cooldownKey(destination.id, camera, alert_type);
    _cooldown.set(key, Date.now());
    increment(`alerts.sent.${destination.type}`);
  } else {
    increment(`alerts.failed.${destination.type}`);
  }

  return logAndReturn(destination, alert, {
    status: outcome.ok ? "sent" : "failed",
    http_status: outcome.http_status ?? null,
    error: outcome.error ?? null,
    duration_ms,
  });
}

function logAndReturn(destination, alert, fields) {
  try {
    recordAlertDispatch(_db, {
      tenant_id: alert.tenant_id ?? destination.tenant_id ?? "default",
      destination_id: destination.id,
      destination_type: destination.type,
      destination_target: destination.target,
      event_id: alert.event_id,
      camera: alert.camera,
      severity: alert.severity,
      alert_type: alert.alert_type,
      title: alert.title,
      body: alert.body,
      ...fields,
    });
  } catch (err) {
    console.error("[alerts] audit write failed:", err?.message);
  }
  return { ok: fields.status === "sent", ...fields };
}

// ---- transports ---------------------------------------------------------

async function sendEmailAlert(destination, alert) {
  // Reuse the SMTP_* env vars from the early-access notifier so deploys
  // only need to configure SMTP once.
  if (!process.env.SMTP_HOST) {
    return { ok: false, error: "smtp_not_configured" };
  }
  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: Number(process.env.SMTP_PORT ?? 587) === 465,
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  await transporter.sendMail({
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    to: destination.target,
    subject: alert.title,
    text: alert.body,
  });
  return { ok: true, http_status: 200 };
}

async function sendWebhookAlert(destination, alert) {
  const body = JSON.stringify({
    event_id: alert.event_id,
    tenant_id: alert.tenant_id ?? "default",
    camera: alert.camera,
    severity: alert.severity,
    alert_type: alert.alert_type,
    title: alert.title,
    summary: alert.summary,
    body: alert.body,
    confidence: alert.confidence ?? null,
    weapon: alert.weapon ?? null,
    known_face_count: alert.known_face_count ?? 0,
    unknown_face_count: alert.unknown_face_count ?? 0,
    sent_at: new Date().toISOString(),
    source: "auroraview",
    test: Boolean(alert.test),
  });
  const headers = { "Content-Type": "application/json" };
  if (destination.webhook_secret) {
    const sig = crypto
      .createHmac("sha256", destination.webhook_secret)
      .update(body)
      .digest("hex");
    headers["X-AuroraView-Signature"] = `sha256=${sig}`;
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const r = await fetch(destination.target, {
      method: "POST",
      headers,
      body,
      signal: ctl.signal,
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return {
        ok: false,
        http_status: r.status,
        error: `http_${r.status}:${text.slice(0, 160)}`,
      };
    }
    return { ok: true, http_status: r.status };
  } catch (err) {
    return {
      ok: false,
      http_status: null,
      error: err?.name === "AbortError" ? "timeout" : err?.message ?? "send_failed",
    };
  } finally {
    clearTimeout(t);
  }
}

// ---- alert formatting (used by harness/index.mjs publish call) ---------

/**
 * Turn an analyzeImageRouted result into a publishable alert. Pure — no
 * I/O — so callers can short-circuit if no destinations exist (we use
 * this in tests too).
 */
export function buildAlertPayload({ event_id, camera, result, tenant_id = "default" }) {
  const sev = result?.severity ?? "normal";
  const at = result?.alert_type ?? null;
  const weapon = result?.weapon ?? null;
  const known = result?.known_face_count ?? 0;
  const unknown = result?.unknown_face_count ?? 0;
  const local = (result?.local_scene ?? "").trim();
  const summary = (result?.summary ?? "").trim();
  const conf =
    typeof result?.confidence === "number" ? result.confidence : null;

  const title =
    sev === "critical"
      ? `[AuroraView] CRITICAL: ${at ?? "alert"} on ${camera}`
      : `[AuroraView] Notable: ${at ?? "activity"} on ${camera}`;

  const lines = [
    `AuroraView detected ${at ?? "an event"} on ${camera}.`,
    "",
    `Severity:    ${sev}`,
    `Alert type:  ${at ?? "(none)"}`,
    `Camera:      ${camera}`,
  ];
  if (conf !== null) lines.push(`Confidence:  ${conf.toFixed(2)}`);
  if (weapon?.decision === "suspicious") {
    lines.push(`Weapon:      ${weapon.suspicious_class ?? "unknown"} (score ${(weapon.suspicious_object_score ?? 0).toFixed(2)})`);
  }
  if (known > 0 || unknown > 0) {
    lines.push(`Faces:       ${known} known · ${unknown} unknown`);
  }
  if (local) lines.push("", `T2-LOCAL: ${local}`);
  if (summary && summary !== local) lines.push(`T3-CLOUD: ${summary}`);
  lines.push("", `Open the live view: ${PUBLIC_BASE_URL}/admin/live`);

  return {
    event_id,
    tenant_id,
    camera,
    severity: sev,
    alert_type: at,
    title,
    body: lines.join("\n"),
    summary,
    local_scene: local,
    confidence: conf,
    weapon,
    known_face_count: known,
    unknown_face_count: unknown,
    sent_at: new Date().toISOString(),
  };
}
