// Tests for frigate-vod URL builders + segment aggregation.
//
// URL builders are pure functions over their inputs and FRIGATE_BASE.
// We don't network-test openRangeFetch here — that's covered indirectly
// by the route tests which inject a fake.

import { test } from "node:test";
import assert from "node:assert/strict";

// Pin FRIGATE_BASE before importing the module so the URL builders
// produce deterministic output regardless of the dev's local env.
process.env.FRIGATE_BASE = "https://frigate.local:3000";

const vod = await import("./frigate-vod.mjs");

test("buildHlsMasterUrl produces expected path", () => {
  const u = vod.buildHlsMasterUrl("Driveway", 1764093600000, 1764093660000);
  assert.equal(
    u,
    "https://frigate.local:3000/vod/Driveway/start/1764093600.000/end/1764093660.000/master.m3u8",
  );
});

test("buildHlsMasterUrl URL-encodes camera names with spaces", () => {
  const u = vod.buildHlsMasterUrl("Front Door", 1764093600000, 1764093660000);
  assert.match(u, /\/vod\/Front%20Door\//);
});

test("buildClipUrl uses integer Unix seconds", () => {
  const u = vod.buildClipUrl("Driveway", 1764093600000, 1764093660500);
  assert.equal(
    u,
    "https://frigate.local:3000/api/Driveway/recordings/1764093600/1764093660.mp4",
  );
});

test("start>=end throws invalid_window", () => {
  assert.throws(() => vod.buildHlsMasterUrl("X", 2, 1), { code: "invalid_window" });
  assert.throws(() => vod.buildHlsMasterUrl("X", 5, 5), { code: "invalid_window" });
});

test("window > 24h throws vod_window_too_large", () => {
  assert.throws(
    () => vod.buildHlsMasterUrl("X", 0, vod.MAX_VOD_SPAN_MS + 1),
    { code: "vod_window_too_large" },
  );
});

test("buildHlsSubUrl preserves a flat sibling filename", () => {
  const u = vod.buildHlsSubUrl(
    "Driveway",
    1764093600000,
    1764093660000,
    "index-v1.m3u8",
  );
  assert.equal(
    u,
    "https://frigate.local:3000/vod/Driveway/start/1764093600.000/end/1764093660.000/index-v1.m3u8",
  );
});

test("buildHlsSubUrl preserves a nested rendition path", () => {
  const u = vod.buildHlsSubUrl(
    "Driveway",
    1764093600000,
    1764093660000,
    "rendition0/index.m3u8",
  );
  assert.match(u, /\/rendition0\/index\.m3u8$/);
});

test("buildHlsSubUrl strips traversal payloads from each segment", () => {
  const u = vod.buildHlsSubUrl(
    "Driveway",
    1764093600000,
    1764093660000,
    "../../etc/passwd",
  );
  assert.doesNotMatch(u, /\.\./);
});

test("buildHlsSubUrl rejects an empty path", () => {
  assert.throws(
    () => vod.buildHlsSubUrl("X", 1, 2, "///"),
    { code: "bad_path" },
  );
});

test("aggregateSegments produces 1m bins for <=1h windows", () => {
  const startMs = 1764093600000;
  const endMs = startMs + 60 * 60 * 1000;
  const raw = [
    { start_time: startMs / 1000, end_time: startMs / 1000 + 10, segment_size: 1000 },
    { start_time: startMs / 1000 + 30, end_time: startMs / 1000 + 90, segment_size: 2000 },
  ];
  const out = vod.aggregateSegments(raw, startMs, endMs);
  assert.equal(out.bin_ms, 60_000);
  assert.ok(out.segments.length >= 1);
  const total = out.segments.reduce((s, b) => s + b.bytes, 0);
  assert.equal(total, 3000);
});

test("aggregateSegments produces 5m bins for 1h<span<=6h windows", () => {
  const startMs = 1764093600000;
  const endMs = startMs + 3 * 60 * 60 * 1000;
  const out = vod.aggregateSegments([], startMs, endMs);
  assert.equal(out.bin_ms, 5 * 60_000);
});

test("aggregateSegments produces 15m bins for 6h<span<=24h windows", () => {
  const startMs = 1764093600000;
  const endMs = startMs + 18 * 60 * 60 * 1000;
  const out = vod.aggregateSegments([], startMs, endMs);
  assert.equal(out.bin_ms, 15 * 60_000);
});

test("aggregateSegments skips segments outside the window", () => {
  const startMs = 1764093600000;
  const endMs = startMs + 60_000;
  const raw = [
    { start_time: (startMs / 1000) - 100, end_time: (startMs / 1000) - 90, segment_size: 1 },
    { start_time: endMs / 1000 + 100, end_time: endMs / 1000 + 110, segment_size: 1 },
  ];
  const out = vod.aggregateSegments(raw, startMs, endMs);
  assert.equal(out.segments.length, 0);
});
