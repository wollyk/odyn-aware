// Behavior under test:
//   - apiFetch always sends credentials: "include"
//   - On 401, it dispatches the SESSION_EXPIRED_EVENT (unless silent401)
//   - Non-401 responses do NOT dispatch
//   - Bursts of 401 are coalesced into a single event within 1s

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  apiFetch,
  SESSION_EXPIRED_EVENT,
  _resetApiFetchForTests,
} from "./apiFetch";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  _resetApiFetchForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
});

describe("apiFetch", () => {
  it("forwards credentials: include on every call", async () => {
    let received: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_input, init) => {
      received = init as RequestInit;
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;

    await apiFetch("/api/foo");
    expect(received?.credentials).toBe("include");
  });

  it("dispatches session-expired event on 401", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"unauthenticated"}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const spy = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, spy);
    try {
      const res = await apiFetch("/api/foo");
      expect(res.status).toBe(401);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, spy);
    }
  });

  it("does NOT dispatch on 200", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }),
    ) as unknown as typeof fetch;

    const spy = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, spy);
    try {
      await apiFetch("/api/foo");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, spy);
    }
  });

  it("does NOT dispatch on 401 when silent401 is set (login endpoint)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"bad_creds"}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const spy = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, spy);
    try {
      await apiFetch("/api/auth/login", { method: "POST", silent401: true });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, spy);
    }
  });

  it("coalesces a burst of 401s into a single event (1s window)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"error":"unauthenticated"}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const spy = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, spy);
    try {
      await apiFetch("/a");
      await apiFetch("/b");
      await apiFetch("/c");
      // Five concurrent 401s from five polling hooks must not produce
      // five banner-toggles.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, spy);
    }
  });
});
