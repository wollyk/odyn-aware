import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useHlsPlayer } from "./useHlsPlayer";

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
  // jsdom doesn't render the <video>, so we attach an element after the hook
  // mounts and trigger a re-render.
  const v = document.createElement("video");
  (result.current as { videoRef: { current: HTMLVideoElement | null } }).videoRef.current = v;
  return v;
}

describe("useHlsPlayer", () => {
  it("idle when src is null", () => {
    const { result } = renderHook(() =>
      useHlsPlayer({ src: null, windowStartMs: 0 }),
    );
    expect(result.current.status).toBe("idle");
  });

  it("uses native HLS when canPlayType is truthy", () => {
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "probably",
    });
    const { result, rerender } = renderHook(
      ({ src }: { src: string | null }) =>
        useHlsPlayer({ src, windowStartMs: 0 }),
      { initialProps: { src: null as string | null } },
    );
    attachVideo(result);
    rerender({ src: "/api/agent/timeline/X/hls/master.m3u8?start_ms=0&end_ms=1" });
    expect(result.current.videoRef.current?.src).toMatch(/master\.m3u8/);
  });

  it("constructs hls.js when native HLS is unsupported", async () => {
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "",
    });
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
    await act(async () => {
      await Promise.resolve();
    });
    expect((mod.default as unknown as typeof FakeHls).isSupported).toHaveBeenCalled();
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
});
