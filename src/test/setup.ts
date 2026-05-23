// Vitest setup — jsdom polyfills + matchers shared by every test file.
//
// Browser APIs that jsdom doesn't ship by default:
//   - MediaSource / SourceBuffer (MSE stream tests)
//   - ResizeObserver (canvas overlay components)
//   - HTMLMediaElement.play/pause are stubs so we can assert on them.

import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

afterEach(() => {
  cleanup();
});

// ResizeObserver — used by Radix and our timeline strip's measure hook.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// HTMLMediaElement bits jsdom doesn't implement.
if (typeof window !== "undefined" && window.HTMLMediaElement) {
  Object.defineProperty(window.HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn(() => Promise.resolve()),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "load", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
    configurable: true,
    value: vi.fn(() => ""),
  });
}

// MediaSource minimal stub — useMseStream constructs one but most tests
// don't exercise the WS flow; existing live tests can override per-test.
if (typeof globalThis.MediaSource === "undefined") {
  globalThis.MediaSource = class {
    readyState = "closed";
    addEventListener() {}
    removeEventListener() {}
    addSourceBuffer() {
      return { mode: "segments", addEventListener: () => {} };
    }
    removeSourceBuffer() {}
    endOfStream() {}
    static isTypeSupported() {
      return true;
    }
  } as unknown as typeof MediaSource;
}

// URL.createObjectURL — not in jsdom.
if (typeof URL.createObjectURL === "undefined") {
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
}
