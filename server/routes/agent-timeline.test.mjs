// Tests for /api/agent/timeline/* routes.
//
// Strategy: drive the route module's `handle()` directly with fake req/res
// + an in-memory DB. The route module accepts a `vod` override in ctx so
// we can stub frigate-vod's network surface without touching real
// sockets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { URL } from "node:url";
import Database from "better-sqlite3";

process.env.FRIGATE_BASE = "https://frigate.local:3000";

const { applyFaceTimelineSchema } = await import("../db/face-timeline.mjs");
const { handle, rewriteMasterPlaylist, rewriteChildPlaylist } = await import(
  "./agent-timeline.mjs"
);

// -- fakes ------------------------------------------------------------------

function makeDb({ withAdmin = true } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'customer',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_login_at TEXT
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at TEXT NOT NULL,
      ip TEXT, user_agent TEXT
    );
    CREATE TABLE people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
    CREATE TABLE face_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      camera TEXT NOT NULL,
      event_id TEXT, person_id INTEGER, similarity REAL NOT NULL,
      bbox_json TEXT, quality REAL, model TEXT NOT NULL DEFAULT 'test',
      vec_dim INTEGER, vec_blob BLOB, track_session_id TEXT,
      frigate_event_id TEXT, cluster_id INTEGER, thumb_path TEXT
    );
  `);
  applyFaceTimelineSchema(db);
  if (withAdmin) {
    const u = db.prepare(`INSERT INTO users (email, role) VALUES ('a@x', 'admin')`).run();
    db.prepare(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ('sid-admin', ?, '2099-01-01T00:00:00Z')`,
    ).run(u.lastInsertRowid);
  }
  return db;
}

function makeReq({
  method = "GET",
  path = "/api/agent/timeline/Driveway/matches",
  query = {},
  sessionId = "sid-admin",
  range = null,
} = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = new URL(`http://localhost${path}${qs ? `?${qs}` : ""}`);
  const headers = {};
  if (sessionId) headers.cookie = `av_session=${sessionId}`;
  if (range) headers.range = range;
  return {
    req: { method, headers, url: url.pathname + url.search },
    url,
  };
}

class FakeRes extends EventEmitter {
  constructor() {
    super();
    this.statusCode = null;
    this.headers = {};
    this.body = Buffer.alloc(0);
    this.ended = false;
  }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    this.headers = { ...this.headers, ...headers };
    return this;
  }
  setHeader(k, v) { this.headers[k] = v; }
  write(chunk) {
    this.body = Buffer.concat([this.body, Buffer.from(chunk)]);
  }
  end(chunk) {
    if (chunk) this.write(chunk);
    this.ended = true;
    this.emit("finish");
  }
  json() {
    return JSON.parse(this.body.toString("utf8"));
  }
}

function fakeFrigate({ configured = true } = {}) {
  return { isConfigured: () => configured };
}

// -- tests -----------------------------------------------------------------

test("401 when unauthenticated", async () => {
  const db = makeDb({ withAdmin: false });
  const { req, url } = makeReq({ query: { start_ms: 0, end_ms: 1000 }, sessionId: null });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate() });
  assert.equal(res.statusCode, 401);
});

test("400 invalid_window when start_ms is missing", async () => {
  const db = makeDb();
  const { req, url } = makeReq({ query: {} });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate() });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_window");
});

test("400 invalid_window when end_ms <= start_ms", async () => {
  const db = makeDb();
  const { req, url } = makeReq({ query: { start_ms: 5, end_ms: 5 } });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate() });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "invalid_window");
});

test("400 window_too_large when span > 24h", async () => {
  const db = makeDb();
  const tooBig = 24 * 60 * 60 * 1000 + 1;
  const { req, url } = makeReq({ query: { start_ms: 0, end_ms: tooBig } });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate() });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, "window_too_large");
});

test("/matches returns rows ordered by ts_ms ascending", async () => {
  const db = makeDb();
  const t0 = 1_764_000_000_000;
  const stmt = db.prepare(
    `INSERT INTO face_matches (created_ms, created_at, camera, similarity, person_id)
       VALUES (?, ?, ?, ?, NULL)`,
  );
  stmt.run(t0 + 2000, new Date(t0 + 2000).toISOString(), "Driveway", 0.8);
  stmt.run(t0 + 1000, new Date(t0 + 1000).toISOString(), "Driveway", 0.9);
  const { req, url } = makeReq({
    path: "/api/agent/timeline/Driveway/matches",
    query: { start_ms: t0, end_ms: t0 + 5000 },
  });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate() });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.count, 2);
  assert.equal(body.matches[0].ts_ms, t0 + 1000);
  assert.equal(body.matches[1].ts_ms, t0 + 2000);
});

test("/matches?person_id=unknown filters person_id IS NULL", async () => {
  const db = makeDb();
  const t0 = 1_764_000_000_000;
  const p = db.prepare(`INSERT INTO people (name) VALUES ('Alice')`).run();
  const stmt = db.prepare(
    `INSERT INTO face_matches (created_ms, created_at, camera, similarity, person_id)
       VALUES (?, ?, ?, ?, ?)`,
  );
  stmt.run(t0 + 1000, new Date(t0 + 1000).toISOString(), "Driveway", 0.9, p.lastInsertRowid);
  stmt.run(t0 + 2000, new Date(t0 + 2000).toISOString(), "Driveway", 0.8, null);
  const { req, url } = makeReq({
    path: "/api/agent/timeline/Driveway/matches",
    query: { start_ms: t0, end_ms: t0 + 5000, person_id: "unknown" },
  });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate() });
  const body = res.json();
  assert.equal(body.count, 1);
  assert.equal(body.matches[0].person_id, null);
});

test("/segments proxies frigate-vod and serializes its output", async () => {
  const db = makeDb();
  const vod = {
    listRecordingsWindow: async () => ({
      start_ms: 1,
      end_ms: 2,
      bin_ms: 60_000,
      segments: [{ start_ms: 1, end_ms: 61_001, bytes: 12345 }],
    }),
  };
  const { req, url } = makeReq({
    path: "/api/agent/timeline/Driveway/segments",
    query: { start_ms: 0, end_ms: 60_000 },
  });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate(), vod });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.segments.length, 1);
  assert.equal(body.segments[0].bytes, 12345);
});

test("/segments returns empty list when frigate not configured", async () => {
  const db = makeDb();
  const { req, url } = makeReq({
    path: "/api/agent/timeline/Driveway/segments",
    query: { start_ms: 0, end_ms: 60_000 },
  });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate({ configured: false }) });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.segments.length, 0);
  assert.equal(body.frigate_configured, false);
});

test("/hls/master.m3u8 rewrites upstream child URIs", async () => {
  const db = makeDb();
  const upstreamBody = [
    "#EXTM3U",
    "#EXT-X-STREAM-INF:BANDWIDTH=1500000",
    "https://frigate.local:3000/vod/Driveway/start/1.000/end/2.000/rendition0/index.m3u8",
  ].join("\n");
  const vod = {
    buildHlsMasterUrl: () => "https://frigate.local:3000/.../master.m3u8",
    openRangeFetch: async () => ({
      status: 200,
      headers: { "content-type": "application/vnd.apple.mpegurl" },
      stream: Readable.from([Buffer.from(upstreamBody)]),
    }),
  };
  const { req, url } = makeReq({
    path: "/api/agent/timeline/Driveway/hls/master.m3u8",
    query: { start_ms: 1000, end_ms: 2000 },
  });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate(), vod });
  assert.equal(res.statusCode, 200);
  const text = res.body.toString("utf8");
  assert.match(text, /\/api\/agent\/timeline\/Driveway\/hls\/rendition0\/index\.m3u8/);
  assert.doesNotMatch(text, /frigate\.local/);
});

test("rewriteMasterPlaylist preserves header lines", () => {
  const out = rewriteMasterPlaylist(
    "#EXTM3U\n#EXT-X-VERSION:3\nrendition0/index.m3u8\n",
    "Driveway",
    1000,
    2000,
  );
  assert.match(out, /^#EXTM3U/);
  assert.match(out, /#EXT-X-VERSION:3/);
  assert.match(out, /\/api\/agent\/timeline\/Driveway\/hls\/rendition0\/index\.m3u8/);
});

test("rewriteChildPlaylist rewrites .ts and .m4s segments", () => {
  const out = rewriteChildPlaylist(
    "#EXTM3U\n#EXTINF:6.0,\nsegment-0000.ts\n#EXTINF:6.0,\nsegment-0001.m4s\n",
    "Driveway",
    1000,
    2000,
    "rendition0",
  );
  assert.match(out, /\/api\/agent\/timeline\/Driveway\/hls\/rendition0\/seg\/segment-0000\.ts/);
  assert.match(out, /\/api\/agent\/timeline\/Driveway\/hls\/rendition0\/seg\/segment-0001\.m4s/);
});

test("/clip.mp4 forwards Range and pipes upstream stream", async () => {
  const db = makeDb();
  const vod = {
    buildClipUrl: () => "https://frigate.local:3000/.../clip.mp4",
    openRangeFetch: async (_url, range) => ({
      status: range ? 206 : 200,
      headers: {
        "content-type": "video/mp4",
        "content-range": range ? "bytes 0-99/1000" : undefined,
      },
      stream: Readable.from([Buffer.from("PARTIAL_BYTES")]),
    }),
  };
  const { req, url } = makeReq({
    path: "/api/agent/timeline/Driveway/clip.mp4",
    query: { start_ms: 0, end_ms: 60_000 },
    range: "bytes=0-99",
  });
  const res = new FakeRes();
  await new Promise((resolve) => {
    res.on("finish", resolve);
    handle(req, res, url, { db, frigate: fakeFrigate(), vod });
  });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers["Content-Range"], "bytes 0-99/1000");
  assert.equal(res.body.toString("utf8"), "PARTIAL_BYTES");
});

test("/clip.mp4 returns 502 when upstream throws", async () => {
  const db = makeDb();
  const vod = {
    buildClipUrl: () => "https://frigate.local:3000/.../clip.mp4",
    openRangeFetch: async () => {
      throw new Error("ECONNREFUSED");
    },
  };
  const { req, url } = makeReq({
    path: "/api/agent/timeline/Driveway/clip.mp4",
    query: { start_ms: 0, end_ms: 60_000 },
  });
  const res = new FakeRes();
  await handle(req, res, url, { db, frigate: fakeFrigate(), vod });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "frigate_unreachable");
});
