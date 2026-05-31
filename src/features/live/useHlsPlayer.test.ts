import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useHlsPlayer } from "./useHlsPlayer";
import { installFetchMock, type FetchMock } from "../../test/fetch-mock";
import { SESSION_EXPIRED_EVENT } from "@/lib/apiFetch";

// Minimal fake mirroring the hls.js API surface we actually touch.
class FakeHls {
  static Events = { ERROR: "hlsError" };
  static isSupported = vi.fn(() => true);
  destroy = vi.fn();
  loadSource = vi.fn();
  attachMedia = vi.fn();
  on = vi.fn();
}

function fakeHlsModule() {
  return { default: FakeHls as unknown as typeof import("hls.js").default };
}

function attachVideo(result: ReturnType<typeof renderHook>["result"]) {
  const v = document.createElement("video");
  (result.current as { videoRef: { current: HTMLVideoElement | null } }).videoRef.current = v;
  return v;
}

const VALID_M3U8 =
  "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=1280x720\nrendition0/index.m3u8\n";

let mock: FetchMock;

beforeEach(() => {
  mock = installFetchMock();
});

afterEach(() => {
  mock.restore();
});

describe("useHlsPlayer", () => {
  it("idle when src is null", () => {
    const { result } = renderHook(() =>
      useHlsPlayer({ src: null, windowStartMs: 0 }),
    );
    expect(result.current.status).toBe("idle");
  });

  it("uses native HLS when canPlayType is truthy and manifest probe succeeds", async () => {
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "probably",
    });
    mock.on("GET", /master\.m3u8/, () =>
      new Response(VALID_M3U8, { status: 200, headers: { "Content-Type": "application/vnd.apple.mpegurl" } }),
    );
    const { result, rerender } = renderHook(
      ({ src }: { src: string | null }) =>
        useHlsPlayer({ src, windowStartMs: 0 }),
      { initialProps: { src: null as string | null } },
    );
    attachVideo(result);
    rerender({ src: "/api/agent/timeline/X/hls/master.m3u8?start_ms=0&end_ms=1" });
    await waitFor(() => {
      expect(result.current.videoRef.current?.src).toMatch(/master\.m3u8/);
    });
  });

  it("constructs hls.js when native HLS is unsupported and manifest is valid", async () => {
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "",
    });
    mock.on("GET", /master\.m3u8/, () =>
      new Response(VALID_M3U8, { status: 200 }),
    );
    const mod = fakeHlsModule();
    const { result, rerender } = renderHook(
      ({ src }: { src: string | null }) =>
        useHlsPlayer({
          src,
          windowStartMs: 0,
          hlsModule: mod as unknown as typeof import("hls.js"),
        }),
      { initialProps: { src: null as string | null } },
    );
    attachVideo(result);
    rerender({ src: "/x/master.m3u8" });
    await waitFor(() => {
      expect((mod.default as unknown as typeof FakeHls).isSupported).toHaveBeenCalled();
    });
  });

  it("transitions to error with detail when the manifest probe returns 502", async () => {
    mock.on("GET", /master\.m3u8/, () =>
      new Response(
        JSON.stringify({ error: "frigate_unreachable", detail: "frigate recordings 404" }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { result, rerender } = renderHook(
      ({ src }: { src: string | null }) =>
        useHlsPlayer({ src, windowStartMs: 0 }),
      { initialProps: { src: null as string | null } },
    );
    attachVideo(result);
    rerender({ src: "/x/master.m3u8" });
    await waitFor(() => {
      expect(result.current.status).toBe("error");
      expect(result.current.error).toMatch(/frigate_unreachable/);
      expect(result.current.error).toMatch(/404/);
    });
  });

  it("transitions to error when the manifest body is not HLS", async () => {
    mock.on("GET", /master\.m3u8/, () =>
      new Response("<html>not a playlist</html>", { status: 200 }),
    );
    const { result, rerender } = renderHook(
      ({ src }: { src: string | null }) =>
        useHlsPlayer({ src, windowStartMs: 0 }),
      { initialProps: { src: null as string | null } },
    );
    attachVideo(result);
    rerender({ src: "/x/master.m3u8" });
    await waitFor(() => {
      expect(result.current.status).toBe("error");
      expect(result.current.error).toMatch(/bad_manifest/);
    });
  });

  it("seekToMs converts wall-clock ms to video.currentTime seconds", () => {
    const { result } = renderHook(() =>
      useHlsPlayer({ src: null, windowStartMs: 1_000_000 }),
    );
    const v = attachVideo(result);
    Object.defineProperty(v, "currentTime", {
      configurable: true,
      get() { return this._t ?? 0; },
      set(val) { this._t = val; },
    });
    act(() => result.current.seekToMs(1_001_500));
    expect((v as unknown as { _t: number })._t).toBe(1.5);
  });

  it("currentMs starts at windowStartMs", () => {
    const { result } = renderHook(() =>
      useHlsPlayer({ src: null, windowStartMs: 12345 }),
    );
    expect(result.current.currentMs).toBe(12345);
  });

  it("transitions loading -> paused on loadedmetadata (no manual play required)", async () => {
    // Regression for the prod symptom: status stuck on "loading"
    // because the only path out was a real "play" event from a user
    // gesture, which controls-based playback never fired without
    // autoplay.
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "probably",
    });
    mock.on("GET", /master\.m3u8/, () =>
      new Response(VALID_M3U8, { status: 200 }),
    );
    const { result, rerender } = renderHook(
      ({ src }: { src: string | null }) =>
        useHlsPlayer({ src, windowStartMs: 0 }),
      { initialProps: { src: null as string | null } },
    );
    const v = attachVideo(result);
    rerender({ src: "/x/master.m3u8" });
    await waitFor(() => {
      expect(result.current.videoRef.current?.src).toMatch(/master\.m3u8/);
    });
    // Simulate the browser firing loadedmetadata after the manifest
    // and segments are ready.
    await act(async () => {
      v.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(result.current.status).toBe("paused");
  });

  // Regression: when the admin session silently expired, the master.m3u8
  // probe returned 401 and the player surfaced an opaque "401:
  // {\"error\":\"unauthenticated\"}" string. That looked like a generic
  // playback fault and hid the actual recoverable root cause.
  //
  // Contract: 401 → error="session_expired" AND the global
  // SESSION_EXPIRED_EVENT must fire so a banner can prompt re-login.
  it("surfaces a 401 manifest as error=session_expired and dispatches the global event", async () => {
    mock.on("GET", /master\.m3u8/, () =>
      new Response('{"error":"unauthenticated"}', {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const evtSpy = vi.fn();
    window.addEventListener(SESSION_EXPIRED_EVENT, evtSpy);
    try {
      const { result, rerender } = renderHook(
        ({ src }: { src: string | null }) =>
          useHlsPlayer({ src, windowStartMs: 0 }),
        { initialProps: { src: null as string | null } },
      );
      attachVideo(result);
      rerender({ src: "/x/master.m3u8" });
      await waitFor(() => {
        expect(result.current.status).toBe("error");
        expect(result.current.error).toBe("session_expired");
      });
      expect(evtSpy).toHaveBeenCalled();
    } finally {
      window.removeEventListener(SESSION_EXPIRED_EVENT, evtSpy);
    }
  });

  it("loadedmetadata does not overwrite a 'playing' status", async () => {
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "probably",
    });
    mock.on("GET", /master\.m3u8/, () =>
      new Response(VALID_M3U8, { status: 200 }),
    );
    const { result, rerender } = renderHook(
      ({ src }: { src: string | null }) =>
        useHlsPlayer({ src, windowStartMs: 0 }),
      { initialProps: { src: null as string | null } },
    );
    const v = attachVideo(result);
    rerender({ src: "/x/master.m3u8" });
    await waitFor(() => {
      expect(result.current.videoRef.current?.src).toMatch(/master\.m3u8/);
    });
    await act(async () => {
      v.dispatchEvent(new Event("play"));
    });
    expect(result.current.status).toBe("playing");
    // canplay arrives later — must NOT clobber "playing".
    await act(async () => {
      v.dispatchEvent(new Event("canplay"));
    });
    expect(result.current.status).toBe("playing");
  });
});
