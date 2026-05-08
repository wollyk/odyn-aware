// Phase-7 alert delivery — schema + CRUD.
//
// Kept in a sidecar so server/db.mjs stays under the 1000-line refactor
// trigger. The shape is intentionally narrow:
//
//   alert_destinations  — operator-managed list of where alerts go.
//                         type ∈ {email, webhook}. webhook_secret is an
//                         optional HMAC-SHA256 shared secret the receiver
//                         can use to verify the body.
//
//   alert_dispatches    — append-only audit log of every send attempt
//                         (including suppressed-by-cooldown). Denormalized
//                         destination_target so audit history survives
//                         a destination delete.
//
// Cooldowns live in-memory in server/harness/alerts.mjs and are hydrated
// from this table on boot so a restart doesn't immediately re-fire every
// stale alert.

/**
 * Apply the alerts schema. Idempotent — safe to call on every boot.
 * Wired from openDb().
 */
export function applyAlertsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS alert_destinations (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id          TEXT NOT NULL DEFAULT 'default',
      type               TEXT NOT NULL CHECK (type IN ('email','webhook')),
      target             TEXT NOT NULL,
      label              TEXT,
      status             TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active','disabled')),
      min_severity       TEXT NOT NULL DEFAULT 'critical'
                            CHECK (min_severity IN ('notable','critical')),
      cooldown_seconds   INTEGER NOT NULL DEFAULT 300,
      webhook_secret     TEXT,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE (tenant_id, type, target)
    );
    CREATE INDEX IF NOT EXISTS idx_alert_destinations_tenant
      ON alert_destinations(tenant_id, status);

    CREATE TABLE IF NOT EXISTS alert_dispatches (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id           TEXT NOT NULL DEFAULT 'default',
      destination_id      INTEGER REFERENCES alert_destinations(id) ON DELETE SET NULL,
      destination_type    TEXT NOT NULL,
      destination_target  TEXT NOT NULL,
      event_id            TEXT,
      camera              TEXT,
      severity            TEXT,
      alert_type          TEXT,
      title               TEXT NOT NULL,
      body                TEXT NOT NULL,
      status              TEXT NOT NULL CHECK (status IN ('sent','failed','suppressed')),
      http_status         INTEGER,
      error               TEXT,
      duration_ms         INTEGER,
      sent_at             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_alert_dispatches_recent
      ON alert_dispatches(tenant_id, sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_alert_dispatches_dest
      ON alert_dispatches(destination_id, sent_at DESC);
  `);
}

// ---- destinations -------------------------------------------------------

export function listAlertDestinations(
  db,
  { tenant_id = "default", status = "active", limit = 200 } = {},
) {
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  // Note: includes webhook_secret in the SELECT so the alerts dispatcher
  // can sign requests. Route handlers MUST strip the secret before
  // sending to the wire — see server/routes/agent-alerts.mjs.
  if (status === "all") {
    return db
      .prepare(
        `SELECT id, tenant_id, type, target, label, status,
                min_severity, cooldown_seconds, webhook_secret,
                CASE WHEN webhook_secret IS NULL THEN 0 ELSE 1 END AS has_webhook_secret,
                created_at, updated_at
           FROM alert_destinations
          WHERE tenant_id = ?
       ORDER BY status ASC, id ASC
          LIMIT ?`,
      )
      .all(tenant_id, lim);
  }
  return db
    .prepare(
      `SELECT id, tenant_id, type, target, label, status,
              min_severity, cooldown_seconds, webhook_secret,
              CASE WHEN webhook_secret IS NULL THEN 0 ELSE 1 END AS has_webhook_secret,
              created_at, updated_at
         FROM alert_destinations
        WHERE tenant_id = ? AND status = ?
     ORDER BY id ASC
        LIMIT ?`,
    )
    .all(tenant_id, status, lim);
}

export function getAlertDestination(db, id, { tenant_id = "default" } = {}) {
  return db
    .prepare(
      `SELECT id, tenant_id, type, target, label, status,
              min_severity, cooldown_seconds, webhook_secret,
              created_at, updated_at
         FROM alert_destinations
        WHERE id = ? AND tenant_id = ?`,
    )
    .get(id, tenant_id);
}

export function createAlertDestination(
  db,
  {
    tenant_id = "default",
    type,
    target,
    label = null,
    min_severity = "critical",
    cooldown_seconds = 300,
    webhook_secret = null,
    created_by = null,
  } = {},
) {
  const r = db
    .prepare(
      `INSERT INTO alert_destinations
            (tenant_id, type, target, label,
             min_severity, cooldown_seconds, webhook_secret, created_by)
         VALUES
            (@tenant_id, @type, @target, @label,
             @min_severity, @cooldown_seconds, @webhook_secret, @created_by)`,
    )
    .run({ tenant_id, type, target, label, min_severity, cooldown_seconds, webhook_secret, created_by });
  return getAlertDestination(db, r.lastInsertRowid, { tenant_id });
}

export function updateAlertDestination(
  db,
  id,
  fields,
  { tenant_id = "default" } = {},
) {
  const allowed = ["label", "status", "min_severity", "cooldown_seconds", "webhook_secret"];
  const keys = Object.keys(fields).filter((k) => allowed.includes(k));
  if (keys.length === 0) return getAlertDestination(db, id, { tenant_id });
  const set = keys.map((k) => `${k} = @${k}`).join(", ");
  db.prepare(
    `UPDATE alert_destinations
        SET ${set}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = @id AND tenant_id = @tenant_id`,
  ).run({ ...fields, id, tenant_id });
  return getAlertDestination(db, id, { tenant_id });
}

export function archiveAlertDestination(db, id, { tenant_id = "default" } = {}) {
  return db
    .prepare(
      `UPDATE alert_destinations
          SET status = 'disabled',
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ? AND tenant_id = ?`,
    )
    .run(id, tenant_id);
}

// ---- dispatches ---------------------------------------------------------

/**
 * Append one row to the audit log. Used by every send path including
 * "suppressed by cooldown" — we want suppressions visible to the operator
 * so they understand why an event they expected to alert on didn't.
 */
export function recordAlertDispatch(db, row) {
  return db
    .prepare(
      `INSERT INTO alert_dispatches
            (tenant_id, destination_id, destination_type, destination_target,
             event_id, camera, severity, alert_type,
             title, body, status, http_status, error, duration_ms)
         VALUES
            (@tenant_id, @destination_id, @destination_type, @destination_target,
             @event_id, @camera, @severity, @alert_type,
             @title, @body, @status, @http_status, @error, @duration_ms)`,
    )
    .run({
      tenant_id: row.tenant_id ?? "default",
      destination_id: row.destination_id ?? null,
      destination_type: row.destination_type,
      destination_target: row.destination_target,
      event_id: row.event_id ?? null,
      camera: row.camera ?? null,
      severity: row.severity ?? null,
      alert_type: row.alert_type ?? null,
      title: row.title,
      body: row.body,
      status: row.status,
      http_status: row.http_status ?? null,
      error: row.error ?? null,
      duration_ms: row.duration_ms ?? null,
    });
}

export function listRecentAlertDispatches(
  db,
  { tenant_id = "default", camera = null, status = null, since_ms = null, limit = 100 } = {},
) {
  const where = ["d.tenant_id = @tenant_id"];
  const params = { tenant_id };
  if (camera) {
    where.push("d.camera = @camera");
    params.camera = camera;
  }
  if (status) {
    where.push("d.status = @status");
    params.status = status;
  }
  if (since_ms) {
    where.push("d.sent_at >= @since_iso");
    params.since_iso = new Date(since_ms).toISOString();
  }
  params.limit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  return db
    .prepare(
      `SELECT d.id, d.tenant_id, d.destination_id, d.destination_type, d.destination_target,
              d.event_id, d.camera, d.severity, d.alert_type,
              d.title, d.body, d.status, d.http_status, d.error, d.duration_ms, d.sent_at,
              ad.label AS destination_label,
              ad.status AS destination_current_status
         FROM alert_dispatches d
    LEFT JOIN alert_destinations ad ON ad.id = d.destination_id
        WHERE ${where.join(" AND ")}
     ORDER BY d.id DESC
        LIMIT @limit`,
    )
    .all(params);
}

/**
 * For cooldown hydration on boot. Returns the latest sent_at for every
 * (destination_id, camera, alert_type) where status='sent'. The harness
 * uses this to seed its in-memory cooldown map so a restart doesn't
 * immediately re-fire stale alerts.
 */
export function hydrateCooldownMap(db, { tenant_id = "default" } = {}) {
  return db
    .prepare(
      `SELECT destination_id, camera, alert_type, MAX(sent_at) AS last_sent
         FROM alert_dispatches
        WHERE tenant_id = ? AND status = 'sent'
        GROUP BY destination_id, camera, alert_type`,
    )
    .all(tenant_id);
}
