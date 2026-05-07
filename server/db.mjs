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
