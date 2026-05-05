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
