import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const DEFAULT_PATH = path.resolve(process.cwd(), "data/odyn.db");

export function openDb(file = process.env.DB_PATH ?? DEFAULT_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
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
