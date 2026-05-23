import { describe, it, expect } from "vitest";
import {
  clampCursor,
  enterPast,
  LIVE_MODE,
  nudgeCursor,
  windowFor,
} from "./playbackMode";

describe("windowFor", () => {
  it("returns [now-span, now]", () => {
    const now = 1_764_000_000_000;
    expect(windowFor(now, 3_600_000)).toEqual({
      start_ms: now - 3_600_000,
      end_ms: now,
    });
  });

  it("throws on invalid inputs", () => {
    expect(() => windowFor(NaN, 1000)).toThrow();
    expect(() => windowFor(1, 0)).toThrow();
    expect(() => windowFor(1, -10)).toThrow();
  });
});

describe("clampCursor", () => {
  const mode = enterPast(100, 200, 150);
  it("returns ms unchanged when in range", () => {
    expect(clampCursor(mode, 150)).toBe(150);
  });
  it("clamps below startMs", () => {
    expect(clampCursor(mode, 50)).toBe(100);
  });
  it("clamps above endMs", () => {
    expect(clampCursor(mode, 9999)).toBe(200);
  });
  it("is a no-op in live mode", () => {
    expect(clampCursor(LIVE_MODE, 42)).toBe(42);
  });
});

describe("nudgeCursor", () => {
  it("moves cursor forward but clamps to endMs", () => {
    const m = enterPast(100, 200, 195);
    const next = nudgeCursor(m, 100);
    expect(next).toEqual({ kind: "past", startMs: 100, endMs: 200, cursorMs: 200 });
  });
  it("returns a NEW mode object (not a mutation)", () => {
    const m = enterPast(100, 200, 150);
    const next = nudgeCursor(m, 10);
    expect(next).not.toBe(m);
    expect(m.cursorMs).toBe(150);
  });
  it("is a no-op in live mode", () => {
    expect(nudgeCursor(LIVE_MODE, 10)).toBe(LIVE_MODE);
  });
});

describe("enterPast", () => {
  it("clamps the cursor into the window", () => {
    expect(enterPast(100, 200, 50).cursorMs).toBe(100);
    expect(enterPast(100, 200, 9999).cursorMs).toBe(200);
  });
  it("throws on invalid window", () => {
    expect(() => enterPast(200, 100, 150)).toThrow();
    expect(() => enterPast(100, 100, 150)).toThrow();
    expect(() => enterPast(NaN, 200, 150)).toThrow();
  });
});
