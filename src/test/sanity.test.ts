// Sanity test — confirms Vitest + jsdom + setup are wired correctly.
// If this fails, no other test in the suite can be trusted.

import { describe, it, expect } from "vitest";

describe("test infrastructure", () => {
  it("runs in jsdom", () => {
    expect(typeof window).toBe("object");
    expect(typeof document).toBe("object");
  });

  it("has ResizeObserver polyfill", () => {
    expect(typeof globalThis.ResizeObserver).toBe("function");
  });

  it("has MediaSource polyfill", () => {
    expect(typeof globalThis.MediaSource).toBe("function");
    expect(MediaSource.isTypeSupported("video/mp4")).toBe(true);
  });
});
