// Regression test for the "frigate_unreachable" production bug.
//
// History: the first version of frigate-vod.mjs made unauthenticated
// requests to Frigate. Real Frigate (>=0.14) returns 401 on
// /api/<cam>/recordings without a frigate_token cookie. Our route layer
// turned that 401 into a generic "frigate_unreachable" with no detail,
// and because the route-level tests mocked the upstream they never
// noticed.
//
// This file tests the actual openRangeFetch -> Frigate path by spinning
// up a tiny HTTP server that demands `Cookie: frigate_token=...`. If
// frigate-vod stops attaching the cookie, this test fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

// Pre-pin env so the module under test resolves URLs against our fake.
const fakeServer = http.createServer();
let port = 0;
await new Promise((resolve) => {
  fakeServer.listen(0, "127.0.0.1", () => {
    port = fakeServer.address().port;
    resolve();
  });
});
process.env.FRIGATE_BASE = `http://127.0.0.1:${port}`;
process.env.FRIGATE_USER = "test";
process.env.FRIGATE_PASS = "test";

// Frigate mock: requires a token cookie on /api/* (except login). The
// login endpoint hands out a fake JWT that frigate.mjs can parse.
const fakeJwt = (() => {
  const header = Buffer.from('{"alg":"none"}').toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  return `${header}.${payload}.sig`;
})();

let requestsSeen = [];
fakeServer.removeAllListeners("request");
fakeServer.on("request", (req, res) => {
  requestsSeen.push({ url: req.url, cookie: req.headers.cookie ?? null });
  if (req.url === "/api/login" && req.method === "POST") {
    res.setHeader("Set-Cookie", `frigate_token=${fakeJwt}; Path=/`);
    res.writeHead(200);
    res.end("{}");
    return;
  }
  if (!req.headers.cookie || !req.headers.cookie.includes("frigate_token=")) {
    res.writeHead(401);
    res.end("unauthorized");
    return;
  }
  if (req.url.startsWith("/api/Driveway/recordings")) {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify([
      { start_time: 1, end_time: 2, segment_size: 100 },
    ]));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

const vod = await import("./frigate-vod.mjs");

test("openRangeFetch attaches frigate_token cookie automatically", async () => {
  requestsSeen.length = 0;
  const url = `http://127.0.0.1:${port}/api/Driveway/recordings?after=0.000&before=1.000`;
  const res = await vod.openRangeFetch(url);
  assert.equal(res.status, 200);
  // Drain the stream so the socket can close.
  await new Promise((resolve) => {
    res.stream.on("data", () => {});
    res.stream.on("end", resolve);
  });
  // First request: POST /api/login. Second: the actual recordings GET
  // with the cookie attached.
  const recordingReq = requestsSeen.find((r) => r.url.includes("/recordings"));
  assert.ok(recordingReq, "expected a recordings request to be sent");
  assert.match(recordingReq.cookie ?? "", /frigate_token=/);
});

test("listRecordingsWindow succeeds when Frigate requires auth", async () => {
  requestsSeen.length = 0;
  const out = await vod.listRecordingsWindow("Driveway", 1000, 60_000);
  assert.equal(out.bin_ms, 60_000);
  assert.ok(Array.isArray(out.segments));
  const recordingReq = requestsSeen.find((r) => r.url.includes("/recordings"));
  assert.ok(recordingReq, "expected upstream request");
  assert.match(recordingReq.cookie ?? "", /frigate_token=/);
});

test("probeRecordings returns raw upstream status + body preview", async () => {
  requestsSeen.length = 0;
  const probe = await vod.probeRecordings("Driveway", 1000, 60_000);
  assert.equal(probe.status, 200);
  assert.equal(probe.content_type, "application/json");
  assert.ok(probe.body_preview.startsWith("[{"));
});

test.after(() => {
  fakeServer.close();
});
