import { describe, it, expect } from "vitest";
import {
  formatTick,
  generateTicks,
  msToPx,
  pickTickInterval,
  pxToMs,
} from "./timeline-math";

describe("msToPx", () => {
  it("maps startMs to 0 and endMs to widthPx", () => {
    expect(msToPx(0, 0, 1000, 200)).toBe(0);
    expect(msToPx(1000, 0, 1000, 200)).toBe(200);
  });
  it("maps midpoint to half width", () => {
    expect(msToPx(500, 0, 1000, 200)).toBe(100);
  });
  it("clamps out-of-range to [0, widthPx]", () => {
    expect(msToPx(-100, 0, 1000, 200)).toBe(0);
    expect(msToPx(9999, 0, 1000, 200)).toBe(200);
  });
  it("returns 0 on degenerate inputs", () => {
    expect(msToPx(500, 0, 0, 200)).toBe(0);
    expect(msToPx(500, 0, 1000, 0)).toBe(0);
  });
});

describe("pxToMs", () => {
  it("inverts msToPx within 1ms", () => {
    const target = 12345678;
    const px = msToPx(target, 12000000, 13000000, 1000);
    const back = pxToMs(px, 12000000, 13000000, 1000);
    expect(Math.abs(back - target)).toBeLessThanOrEqual(1000);
  });
  it("clamps to startMs / endMs", () => {
    expect(pxToMs(-50, 100, 200, 100)).toBe(100);
    expect(pxToMs(9999, 100, 200, 100)).toBe(200);
  });
});

describe("pickTickInterval", () => {
  it("uses 1m ticks for <=5m windows", () => {
    expect(pickTickInterval(60_000).stepMs).toBe(60_000);
  });
  it("uses 30m ticks for 2h<span<=6h", () => {
    expect(pickTickInterval(4 * 60 * 60_000).stepMs).toBe(30 * 60_000);
  });
  it("uses 2h ticks for 6h<span<=24h", () => {
    expect(pickTickInterval(18 * 60 * 60_000).stepMs).toBe(2 * 60 * 60_000);
  });
});

describe("generateTicks", () => {
  it("emits ticks aligned to the step", () => {
    const startMs = 1_764_000_000_000;
    const endMs = startMs + 6 * 60 * 60_000; // 6h
    const ticks = generateTicks(startMs, endMs);
    expect(ticks.length).toBeGreaterThan(5);
    const step = ticks[1] - ticks[0];
    expect(step).toBe(30 * 60_000);
    for (const t of ticks) {
      expect(t).toBeGreaterThanOrEqual(startMs);
      expect(t).toBeLessThan(endMs);
      expect(t % step).toBe(0);
    }
  });
});

describe("formatTick", () => {
  it("uses provided formatter when supplied", () => {
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: "UTC",
    });
    const out = formatTick(Date.UTC(2026, 4, 23, 17, 30), "time", fmt);
    expect(out).toBe("17:30");
  });
});
