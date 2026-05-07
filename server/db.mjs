import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const DEFAULT_PATH = path.resolve(process.cwd(), "data/odyn.db");

export function openDb(file = process.env.DB_PATH ?? DEFAULT_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS early_access (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      company     TEXT NOT NULL,
      environment TEXT NOT NULL,
      message     TEXT,
      ip          TEXT,
      user_agent  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_early_access_email ON early_access(email);
    CREATE INDEX IF NOT EXISTS idx_early_access_created ON early_access(created_at);

    CREATE TABLE IF NOT EXISTS users (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      email           TEXT NOT NULL UNIQUE,
      password_hash   TEXT NOT NULL,
      role            TEXT NOT NULL DEFAULT 'customer' CHECK (role IN ('admin','customer')),
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_login_at   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS sessions (
      id          TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at  TEXT NOT NULL,
      ip          TEXT,
      user_agent  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    -- Camera display labels (set via the live-view chat agent: "rename garage to ...").
    -- camera = Frigate camera name (the wire name); label = human-friendly display name.
    CREATE TABLE IF NOT EXISTS cam_labels (
      camera      TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
    );

    -- Stub for proposed/active alert rules (chat tool: "alert me when ...").
    -- We only PERSIST the proposal here; wiring to the actual detection pipeline is later.
    CREATE TABLE IF NOT EXISTS alert_rules (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      camera       TEXT NOT NULL,
      description  TEXT NOT NULL,        -- natural-language summary of the rule
      spec         TEXT NOT NULL,        -- JSON: { trigger, conditions, action }
      status       TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','disabled')),
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alert_rules_camera ON alert_rules(camera);
    CREATE INDEX IF NOT EXISTS idx_alert_rules_status ON alert_rules(status);

    -- Stale-while-revalidate cache used by the resilience layer.
    -- Survives server restarts so the API can serve last-known-good data even
    -- when the upstream (Frigate, Ollama, etc.) has never come up this boot.
    -- Caller decides what counts as "stale" via fresh_at.
    CREATE TABLE IF NOT EXISTS kv_cache (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,                                    -- JSON
      fresh_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      stale_at   TEXT                                              -- optional hard expiry
    );

    -- Event log for the harness pipeline. ONE ROW PER STAGE APPEND, all
    -- linked by event_id so we can reconstruct the full life of an event:
    -- detection → classified → described → alert → operator_action.
    --
    -- Schema is intentionally append-only: stages don't UPDATE earlier rows,
    -- they INSERT a new row with the same event_id and a new stage label.
    -- That makes the log replayable, debuggable, and trivially exportable.
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id    TEXT NOT NULL,                       -- UUID, links rows in one event's life
      stage       TEXT NOT NULL,                       -- "detection" | "classified" | "described" | "alert"
      tenant_id   TEXT NOT NULL DEFAULT 'default',
      camera      TEXT NOT NULL,
      origin      TEXT,                                -- motion | object_detected | manual_query | ...
      severity    TEXT,                                -- normal | notable | critical (set by T2)
      payload     TEXT NOT NULL,                       -- full JSON snapshot of the event at this stage
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);
    CREATE INDEX IF NOT EXISTS idx_events_camera_created ON events(camera, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_tenant_created ON events(tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);

    -- Quota ledger for cost control. ONE ROW PER CONSUMPTION (lightweight,
    -- pruned by the harness periodically). Per-tenant + per-camera in the
    -- same table, distinguished by scope: 'tenant' or 'camera'.
    CREATE TABLE IF NOT EXISTS quota_ledger (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id   TEXT NOT NULL,
      camera      TEXT,                                -- NULL for tenant-scoped rows
      kind        TEXT NOT NULL,                       -- t3-chat | t3-vision | t2-vision | ...
      scope       TEXT NOT NULL CHECK (scope IN ('tenant','camera')),
      cost        REAL NOT NULL DEFAULT 1,             -- abstract cost (1 = one call)
      dollars     REAL,                                -- optional explicit dollar attribution
      ts          INTEGER NOT NULL                     -- ms epoch (faster than ISO for windowing)
    );
    CREATE INDEX IF NOT EXISTS idx_quota_tenant_kind_ts ON quota_ledger(tenant_id, kind, ts);
    CREATE INDEX IF NOT EXISTS idx_quota_camera_kind_ts ON quota_ledger(tenant_id, camera, kind, ts);
  `);
  return db;
}

export function insertEarlyAccess(db, row) {
  const stmt = db.prepare(`
    INSERT INTO early_access (name, email, company, environment, message, ip, user_agent)
    VALUES (@name, @email, @company, @environment, @message, @ip, @user_agent)
  `);
  return stmt.run({
    name: row.name,
    email: row.email,
    company: row.company,
    environment: row.environment,
    message: row.message ?? null,
    ip: row.ip ?? null,
    user_agent: row.user_agent ?? null,
  });
}

export function listEarlyAccess(db, limit = 100) {
  return db.prepare(`SELECT * FROM early_access ORDER BY id DESC LIMIT ?`).all(limit);
}

// Returns rows + total matching count (for pagination + search).
export function searchEarlyAccess(db, { q = "", limit = 100, offset = 0, sort = "id", order = "desc" } = {}) {
  const sortable = new Set(["id", "created_at", "name", "email", "company", "environment"]);
  const sortCol = sortable.has(sort) ? sort : "id";
  const orderDir = String(order).toLowerCase() === "asc" ? "ASC" : "DESC";
  const where = q ? `WHERE name LIKE @q OR email LIKE @q OR company LIKE @q OR message LIKE @q` : "";
  const params = q ? { q: `%${q}%`, limit, offset } : { limit, offset };
  const rows = db
    .prepare(`SELECT id, created_at, name, email, company, environment, message, ip FROM early_access ${where} ORDER BY ${sortCol} ${orderDir} LIMIT @limit OFFSET @offset`)
    .all(params);
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM early_access ${where}`)
    .get(q ? { q: `%${q}%` } : {}).n;
  return { rows, total };
}

// User helpers -------------------------------------------------------------

export function getUserByEmail(db, email) {
  return db.prepare(`SELECT * FROM users WHERE email = ? COLLATE NOCASE`).get(email);
}

export function upsertUser(db, { email, password_hash, role = "customer" }) {
  // Insert or update password_hash + role for the given email (used by seed-admin).
  const existing = getUserByEmail(db, email);
  if (existing) {
    db.prepare(`UPDATE users SET password_hash = ?, role = ? WHERE id = ?`).run(password_hash, role, existing.id);
    return { ...existing, password_hash, role, updated: true };
  }
  const info = db
    .prepare(`INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)`)
    .run(email, password_hash, role);
  return { id: info.lastInsertRowid, email, role, updated: false };
}

export function touchUserLogin(db, user_id) {
  db.prepare(`UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(user_id);
}

// Session helpers ----------------------------------------------------------

export function createSession(db, { id, user_id, expires_at, ip, user_agent }) {
  db.prepare(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, user_id, expires_at, ip ?? null, user_agent ?? null);
}

export function getSessionWithUser(db, id) {
  return db
    .prepare(
      `SELECT s.id AS sid, s.expires_at, u.id AS user_id, u.email, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
    .get(id);
}

export function deleteSession(db, id) {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

export function purgeExpiredSessions(db) {
  db.prepare(`DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')`).run();
}

// Camera label helpers (set via chat agent) ----------------------------------

export function listCamLabels(db) {
  return db.prepare(`SELECT camera, label, updated_at FROM cam_labels`).all();
}

export function getCamLabel(db, camera) {
  return db.prepare(`SELECT camera, label FROM cam_labels WHERE camera = ?`).get(camera);
}

export function setCamLabel(db, { camera, label, updated_by }) {
  db.prepare(
    `INSERT INTO cam_labels (camera, label, updated_by)
     VALUES (?, ?, ?)
     ON CONFLICT(camera) DO UPDATE SET
       label = excluded.label,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_by = excluded.updated_by`,
  ).run(camera, label, updated_by ?? null);
  return { camera, label };
}

// Alert-rule helpers (proposed via chat agent) -------------------------------

export function insertAlertRule(db, { camera, description, spec, created_by }) {
  const info = db
    .prepare(
      `INSERT INTO alert_rules (camera, description, spec, created_by)
       VALUES (?, ?, ?, ?)`,
    )
    .run(camera, description, JSON.stringify(spec ?? {}), created_by ?? null);
  return { id: info.lastInsertRowid, camera, description, status: "proposed" };
}

export function listAlertRules(db, { camera, status } = {}) {
  const where = [];
  const params = {};
  if (camera) {
    where.push("camera = @camera");
    params.camera = camera;
  }
  if (status) {
    where.push("status = @status");
    params.status = status;
  }
  const sql = `SELECT * FROM alert_rules ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC`;
  return db.prepare(sql).all(params);
}

// kv_cache helpers (stale-while-revalidate persistence) ----------------------
//
// Usage:
//   kvSet(db, "frigate:cameras", { cameras: [...] });
//   const hit = kvGet(db, "frigate:cameras");
//   // hit = { value, fresh_at: ISO, stale_at: ISO|null, age_ms }
//
// Callers decide what counts as fresh vs stale based on their own TTL.

export function kvSet(db, key, value, { stale_at = null } = {}) {
  const json = JSON.stringify(value);
  db.prepare(
    `INSERT INTO kv_cache (key, value, fresh_at, stale_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       fresh_at = excluded.fresh_at,
       stale_at = excluded.stale_at`,
  ).run(key, json, stale_at);
  return { key, fresh_at: new Date().toISOString(), stale_at };
}

export function kvGet(db, key) {
  const row = db.prepare(`SELECT value, fresh_at, stale_at FROM kv_cache WHERE key = ?`).get(key);
  if (!row) return null;
  let value;
  try {
    value = JSON.parse(row.value);
  } catch {
    return null;
  }
  const age_ms = Date.now() - new Date(row.fresh_at).getTime();
  return { value, fresh_at: row.fresh_at, stale_at: row.stale_at, age_ms };
}

export function kvDelete(db, key) {
  db.prepare(`DELETE FROM kv_cache WHERE key = ?`).run(key);
}

// Event log helpers (append-only) -------------------------------------------
//
// The harness writes one row per stage append. The shape of `payload` is
// the FULL event object at that stage — readers reconstruct timelines by
// grouping on `event_id`.

/**
 * Append a single event-stage row to the log.
 * @param {object} db better-sqlite3 handle
 * @param {{ event_id: string, stage: string, tenant_id?: string, camera: string,
 *           origin?: string, severity?: string, payload: object }} row
 */
export function appendEvent(db, row) {
  const stmt = db.prepare(
    `INSERT INTO events (event_id, stage, tenant_id, camera, origin, severity, payload)
     VALUES (@event_id, @stage, @tenant_id, @camera, @origin, @severity, @payload)`,
  );
  return stmt.run({
    event_id: row.event_id,
    stage: row.stage,
    tenant_id: row.tenant_id ?? "default",
    camera: row.camera,
    origin: row.origin ?? null,
    severity: row.severity ?? null,
    payload: JSON.stringify(row.payload ?? {}),
  });
}

/**
 * Read recent events. Filter by camera / tenant / severity / since (ms epoch).
 * Default ordering: newest first.
 *
 * @param {object} db
 * @param {{ camera?: string, tenant_id?: string, severity?: string, since_ms?: number, limit?: number }} [filter]
 */
export function listEvents(db, { camera, tenant_id, severity, since_ms, limit = 100 } = {}) {
  const where = [];
  const params = {};
  if (camera) {
    where.push("camera = @camera");
    params.camera = camera;
  }
  if (tenant_id) {
    where.push("tenant_id = @tenant_id");
    params.tenant_id = tenant_id;
  }
  if (severity) {
    where.push("severity = @severity");
    params.severity = severity;
  }
  if (since_ms) {
    // SQLite ISO timestamps compare correctly as strings; convert ms to ISO.
    where.push("created_at >= @since_iso");
    params.since_iso = new Date(since_ms).toISOString();
  }
  const sql = `
    SELECT id, event_id, stage, tenant_id, camera, origin, severity, payload, created_at
      FROM events
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY id DESC
     LIMIT @limit
  `;
  params.limit = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const rows = db.prepare(sql).all(params);
  // Eagerly parse the JSON payload so callers don't need to.
  return rows.map((r) => ({ ...r, payload: safeParse(r.payload) }));
}

/**
 * Reconstruct the full life of one event (all stages, oldest first).
 * @param {object} db
 * @param {string} event_id
 */
export function getEventTimeline(db, event_id) {
  const rows = db
    .prepare(
      `SELECT stage, payload, created_at FROM events
        WHERE event_id = ? ORDER BY id ASC`,
    )
    .all(event_id);
  return rows.map((r) => ({ ...r, payload: safeParse(r.payload) }));
}

/**
 * Prune events older than `older_than_ms` epoch. Called periodically by the
 * harness to keep the log bounded.
 */
export function pruneEvents(db, older_than_ms) {
  const cutoff = new Date(older_than_ms).toISOString();
  return db.prepare(`DELETE FROM events WHERE created_at < ?`).run(cutoff);
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

// Quota ledger helpers (cost control) ----------------------------------------
//
// We persist every consumption with its timestamp so a process restart
// rebuilds an accurate rolling-window view. Pruning is the caller's
// responsibility (the harness runs it on a debounced timer).

/**
 * Record a single consumption. Returns nothing.
 * @param {object} db
 * @param {{ tenant_id: string, camera?: string|null, kind: string, scope: 'tenant'|'camera', cost?: number, dollars?: number|null, ts?: number }} row
 */
export function recordQuota(db, row) {
  db.prepare(
    `INSERT INTO quota_ledger (tenant_id, camera, kind, scope, cost, dollars, ts)
     VALUES (@tenant_id, @camera, @kind, @scope, @cost, @dollars, @ts)`,
  ).run({
    tenant_id: row.tenant_id,
    camera: row.camera ?? null,
    kind: row.kind,
    scope: row.scope,
    cost: row.cost ?? 1,
    dollars: row.dollars ?? null,
    ts: row.ts ?? Date.now(),
  });
}

/**
 * Count consumptions in a window. Returns total cost (NOT row count — these
 * are the same when cost=1 but differ for variable-cost ops like big chats).
 * @param {object} db
 * @param {{ tenant_id: string, camera?: string|null, kind: string, scope: 'tenant'|'camera', since_ms: number }} q
 */
export function countQuota(db, { tenant_id, camera, kind, scope, since_ms }) {
  let sql, params;
  if (scope === "camera") {
    sql = `SELECT COALESCE(SUM(cost), 0) AS total FROM quota_ledger
            WHERE tenant_id = @tenant_id AND camera = @camera AND kind = @kind AND scope = 'camera' AND ts >= @since_ms`;
    params = { tenant_id, camera, kind, since_ms };
  } else {
    sql = `SELECT COALESCE(SUM(cost), 0) AS total FROM quota_ledger
            WHERE tenant_id = @tenant_id AND kind = @kind AND scope = 'tenant' AND ts >= @since_ms`;
    params = { tenant_id, kind, since_ms };
  }
  return db.prepare(sql).get(params).total;
}

/** Drop ledger rows older than the cutoff. */
export function pruneQuota(db, older_than_ms) {
  return db.prepare(`DELETE FROM quota_ledger WHERE ts < ?`).run(older_than_ms);
}
