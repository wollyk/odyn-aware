// Tests for face-timeline schema + range query.
//
// Uses an in-memory SQLite database so the tests are hermetic.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applyFaceTimelineSchema, listMatchesInWindow } from "./face-timeline.mjs";

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  // Minimal subset of the production schema — just enough for face_matches
  // + the people join in listMatchesInWindow.
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );
    CREATE TABLE face_matches (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id     TEXT NOT NULL DEFAULT 'default',
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      camera        TEXT NOT NULL,
      event_id      TEXT,
      person_id     INTEGER REFERENCES people(id) ON DELETE SET NULL,
      similarity    REAL NOT NULL,
      bbox_json     TEXT,
      quality       REAL,
      model         TEXT NOT NULL DEFAULT 'test',
      vec_dim       INTEGER,
      vec_blob      BLOB,
      track_session_id TEXT,
      frigate_event_id TEXT,
      cluster_id    INTEGER,
      thumb_path    TEXT
    );
  `);
  return db;
}

test("migration is idempotent", () => {
  const db = makeDb();
  applyFaceTimelineSchema(db);
  applyFaceTimelineSchema(db); // must not throw
  const cols = db.prepare("PRAGMA table_info(face_matches)").all();
  assert.ok(cols.some((c) => c.name === "created_ms"));
});

test("backfill populates created_ms from created_at", () => {
  const db = makeDb();
  // Insert a row with an explicit created_at, no created_ms yet.
  db.prepare(
    `INSERT INTO face_matches (created_at, camera, similarity) VALUES (?, ?, ?)`,
  ).run("2026-05-23T17:00:00.000Z", "Driveway", 0.91);
  applyFaceTimelineSchema(db);
  const row = db.prepare(`SELECT created_ms FROM face_matches`).get();
  assert.equal(row.created_ms, Date.parse("2026-05-23T17:00:00.000Z"));
});

test("listMatchesInWindow filters by camera and time", () => {
  const db = makeDb();
  applyFaceTimelineSchema(db);
  const p = db.prepare(`INSERT INTO people (name) VALUES (?)`).run("Alice");
  const t0 = 1764093600000;
  const insert = db.prepare(
    `INSERT INTO face_matches (created_ms, created_at, camera, similarity, person_id, bbox_json, quality, thumb_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(t0 + 1000, new Date(t0 + 1000).toISOString(), "Driveway", 0.9, p.lastInsertRowid, JSON.stringify([0.1, 0.2, 0.3, 0.4]), 0.85, "thumbs/a.jpg");
  insert.run(t0 + 2000, new Date(t0 + 2000).toISOString(), "Driveway", 0.8, null, null, 0.6, null);
  insert.run(t0 + 3000, new Date(t0 + 3000).toISOString(), "Backyard", 0.95, p.lastInsertRowid, null, 0.7, null);

  const rows = listMatchesInWindow(db, {
    camera: "Driveway",
    start_ms: t0,
    end_ms: t0 + 5000,
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].bbox, [0.1, 0.2, 0.3, 0.4]);
  assert.equal(rows[0].person_name, "Alice");
  assert.equal(rows[1].person_name, null);
});

test("listMatchesInWindow respects person_id=unknown", () => {
  const db = makeDb();
  applyFaceTimelineSchema(db);
  const p = db.prepare(`INSERT INTO people (name) VALUES (?)`).run("Alice");
  const t0 = 1764093600000;
  const insert = db.prepare(
    `INSERT INTO face_matches (created_ms, created_at, camera, similarity, person_id)
       VALUES (?, ?, ?, ?, ?)`,
  );
  insert.run(t0 + 1000, new Date(t0 + 1000).toISOString(), "Driveway", 0.9, p.lastInsertRowid);
  insert.run(t0 + 2000, new Date(t0 + 2000).toISOString(), "Driveway", 0.8, null);

  const onlyUnknown = listMatchesInWindow(db, {
    camera: "Driveway",
    start_ms: t0,
    end_ms: t0 + 5000,
    person_id: "unknown",
  });
  assert.equal(onlyUnknown.length, 1);
  assert.equal(onlyUnknown[0].person_id, null);
});

test("listMatchesInWindow throws on invalid window", () => {
  const db = makeDb();
  applyFaceTimelineSchema(db);
  assert.throws(
    () => listMatchesInWindow(db, { camera: "X", start_ms: 2, end_ms: 1 }),
    /invalid_window/,
  );
  assert.throws(
    () => listMatchesInWindow(db, { camera: "X", start_ms: NaN, end_ms: 1 }),
    /invalid_window/,
  );
});

test("listMatchesInWindow returns empty array when no matches", () => {
  const db = makeDb();
  applyFaceTimelineSchema(db);
  const rows = listMatchesInWindow(db, {
    camera: "Driveway",
    start_ms: 0,
    end_ms: 1000,
  });
  assert.deepEqual(rows, []);
});
