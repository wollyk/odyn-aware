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

// PointerEvent — jsdom (as of v22) doesn't ship it. Without this any
// fireEvent.pointer* triggers a plain Event with clientX undefined, which
// breaks the timeline drag tests. We subclass MouseEvent so all the
// coordinate fields are real.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    isPrimary: boolean;
    width: number;
    height: number;
    pressure: number;
    tangentialPressure: number;
    tiltX: number;
    tiltY: number;
    twist: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.pressure = init.pressure ?? 0;
      this.tangentialPressure = init.tangentialPressure ?? 0;
      this.tiltX = init.tiltX ?? 0;
      this.tiltY = init.tiltY ?? 0;
      this.twist = init.twist ?? 0;
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).PointerEvent = PointerEventPolyfill;
}

// jsdom does not implement Element.setPointerCapture / releasePointerCapture.
if (typeof Element !== "undefined") {
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function () {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function () {
      return false;
    };
  }
}
