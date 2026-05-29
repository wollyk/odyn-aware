// Verifies the single-tile playback design: in past mode VideoTile
// hides the live <video>, shows an HLS-bound <video data-testid="past-video">,
// and asks the injected hls.js module to load the timeline manifest.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { VideoTile } from "./VideoTile";
import { LIVE_MODE, type PlaybackMode } from "./playbackMode";
import type { Camera } from "./types";

const fakeCam: Camera = {
  name: "Driveway",
  label: "Driveway",
  // Camera type has additional optional fields; spread an `any` to
  // avoid coupling the test to the exact shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

class FakeHls {
  static Events = { ERROR: "hlsError" };
  static isSupported = vi.fn(() => true);
  destroy = vi.fn();
  loadSource = vi.fn();
  attachMedia = vi.fn();
  on = vi.fn();
}
const fakeHlsModule = {
  default: FakeHls as unknown as typeof import("hls.js").default,
};

beforeEach(() => {
  FakeHls.isSupported.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("VideoTile playback modes", () => {
  it("renders the live <video> in live mode (no past-video element)", () => {
    render(
      <VideoTile
        cam={fakeCam}
        mode="live"
        agentStatus={null}
        playback={LIVE_MODE}
      />,
    );
    expect(screen.queryByTestId("past-video")).not.toBeInTheDocument();
  });

  it("renders the past-video element when playback is past", () => {
    const playback: PlaybackMode = {
      kind: "past",
      startMs: 0,
      endMs: 60_000,
      cursorMs: 10_000,
      activeMatch: null,
    };
    render(
      <VideoTile
        cam={fakeCam}
        mode="live"
        agentStatus={null}
        playback={playback}
        hlsModule={fakeHlsModule as unknown as typeof import("hls.js")}
      />,
    );
    expect(screen.getByTestId("past-video")).toBeInTheDocument();
  });

  // Regression: when the user drags the timeline to T but the video's
  // currentTime is still 0 (seek in flight), an earlier version of
  // VideoTile emitted that stale 0 back to the parent through
  // onPastCursorAdvance, which then commanded a seek back to start.
  // The fix is to ignore upward emits while past.status !== "playing"
  // and while currentMs is behind the most recent seek target.
  it("does NOT echo cursor backward while seek is pending (status != playing)", async () => {
    // Mock fetch so the useHlsPlayer probe passes immediately.
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response("#EXTM3U\n", {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      }),
    ) as unknown as typeof fetch;

    // Parent harness — the test that would have caught the snap-back
    // bug. It records every emitted cursor so we can assert the video
    // never told the parent to rewind.
    const emitted: number[] = [];
    function Harness() {
      const [playback, setPlayback] = useState<PlaybackMode>({
        kind: "past",
        startMs: 1_000_000,
        endMs: 1_000_000 + 60_000,
        cursorMs: 1_000_000 + 30_000, // user dragged to T+30s
        activeMatch: null,
      });
      return (
        <VideoTile
          cam={fakeCam}
          mode="live"
          agentStatus={null}
          playback={playback}
          onPastCursorAdvance={(ms) => {
            emitted.push(ms);
            if (playback.kind === "past") {
              setPlayback({ ...playback, cursorMs: ms });
            }
          }}
          hlsModule={fakeHlsModule as unknown as typeof import("hls.js")}
        />
      );
    }

    render(<Harness />);
    const video = (await screen.findByTestId("past-video")) as HTMLVideoElement;

    // Player is still "loading" (no play event yet). Fire a timeupdate
    // that would naively read as currentMs=windowStartMs. If the
    // emit guard is missing, the parent would record a backward move.
    Object.defineProperty(video, "currentTime", { value: 0, configurable: true });
    await act(async () => {
      fireEvent.timeUpdate(video);
    });
    expect(emitted).toEqual([]);

    try {
      // Now simulate the player reporting it's actually playing and
      // having caught up past the seek target. The emit MUST happen now.
      Object.defineProperty(video, "currentTime", { value: 31, configurable: true });
      await act(async () => {
        fireEvent.play(video);
        fireEvent.timeUpdate(video);
      });
      expect(emitted.length).toBeGreaterThan(0);
      // And every emitted value should be at-or-after the seek target,
      // not snapped back to windowStartMs.
      for (const v of emitted) {
        expect(v).toBeGreaterThanOrEqual(1_000_000 + 30_000 - 500);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("hides the native <video controls> in past mode so the misleading 50:10/59:16 timer isn't shown", () => {
    const playback: PlaybackMode = {
      kind: "past",
      startMs: 1_700_000_000_000,
      endMs: 1_700_000_000_000 + 60 * 60 * 1000,
      cursorMs: 1_700_000_000_000 + 15 * 60 * 1000,
      activeMatch: null,
    };
    render(
      <VideoTile
        cam={fakeCam}
        mode="live"
        agentStatus={null}
        playback={playback}
        hlsModule={fakeHlsModule as unknown as typeof import("hls.js")}
      />,
    );
    const video = screen.getByTestId("past-video") as HTMLVideoElement;
    // Native chrome MUST be off — that's what surfaced the
    // playlist-relative timer. Operator reads our own wall-clock
    // overlay instead.
    expect(video.hasAttribute("controls")).toBe(false);
  });

  it("renders the REC wall-clock overlay with the playhead's clock time in past mode", () => {
    // Pick a deterministic instant: 2026-05-24T15:30:00Z (15:30 UTC =
    // a known time of day no matter what tz the test runs in we only
    // assert a HH:MM:SS shape).
    const cursorMs = Date.UTC(2026, 4, 24, 15, 30, 0);
    const playback: PlaybackMode = {
      kind: "past",
      startMs: cursorMs - 30_000,
      endMs: cursorMs + 30_000,
      cursorMs,
      activeMatch: null,
    };
    render(
      <VideoTile
        cam={fakeCam}
        mode="live"
        agentStatus={null}
        playback={playback}
        hlsModule={fakeHlsModule as unknown as typeof import("hls.js")}
      />,
    );
    expect(screen.getByText("REC")).toBeInTheDocument();
    // Shape "HH:MM:SS" (24-hour clock). We don't pin the exact value
    // because the test machine's tz is not controlled.
    expect(screen.getByText(/^\d{2}:\d{2}:\d{2}$/)).toBeInTheDocument();
  });

  // Regression: a user pause (or denied autoplay) sets userPausedRef
  // inside useHlsPlayer to true, which then blocks the seeked-event
  // tryPlay() from resuming after every subsequent timeline scrub.
  // The operator observed this as: click a timestamp on the strip,
  // the video lurches to that position, then stays frozen.
  //
  // Contract under test: any parent-driven seek (i.e. a new cursorMs)
  // is treated as an explicit play intent — it clears the soft-paused
  // flag and kicks video.play() so playback resumes.
  it("resumes playback after a timeline scrub even if user paused first", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () =>
      new Response("#EXTM3U\n", {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl" },
      }),
    ) as unknown as typeof fetch;

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      function Harness() {
        const [playback, setPlayback] = useState<PlaybackMode>({
          kind: "past",
          startMs: 1_000_000,
          endMs: 1_000_000 + 60_000,
          cursorMs: 1_000_000 + 10_000,
          activeMatch: null,
        });
        return (
          <>
            <button
              data-testid="scrub"
              onClick={() => {
                if (playback.kind === "past") {
                  setPlayback({ ...playback, cursorMs: 1_000_000 + 30_000 });
                }
              }}
            >
              scrub
            </button>
            <VideoTile
              cam={fakeCam}
              mode="live"
              agentStatus={null}
              playback={playback}
              hlsModule={fakeHlsModule as unknown as typeof import("hls.js")}
            />
          </>
        );
      }

      render(<Harness />);
      const video = (await screen.findByTestId("past-video")) as HTMLVideoElement;
      const playSpy = vi.spyOn(video, "play");

      // Step 1: simulate the operator clicking the video tile to
      // pause. The tile's onClick wires past.togglePlay; we
      // approximate by firing pause on the element directly so we
      // also drive the onPause -> userPausedRef = true path.
      Object.defineProperty(video, "paused", { configurable: true, value: true });
      Object.defineProperty(video, "seeking", { configurable: true, value: false });
      await act(async () => {
        fireEvent.pause(video);
      });

      // Step 2: scrub by emitting a new cursorMs from the parent.
      // The VideoTile seek effect debounces by 120ms before calling
      // past.seekToMs(); after that, play() MUST be called regardless
      // of the prior pause.
      playSpy.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByTestId("scrub"));
      });
      await act(async () => {
        vi.advanceTimersByTime(200);
      });

      expect(playSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      globalThis.fetch = origFetch;
    }
  });

  it("HUD chip changes from LIVE to PAST when playback flips", () => {
    const { rerender } = render(
      <VideoTile
        cam={fakeCam}
        mode="live"
        agentStatus={null}
        playback={LIVE_MODE}
      />,
    );
    expect(screen.getByText(/LIVE-MSE/i)).toBeInTheDocument();
    rerender(
      <VideoTile
        cam={fakeCam}
        mode="live"
        agentStatus={null}
        playback={{
          kind: "past",
          startMs: 0,
          endMs: 60_000,
          cursorMs: 1000,
          activeMatch: null,
        }}
        hlsModule={fakeHlsModule as unknown as typeof import("hls.js")}
      />,
    );
    expect(screen.getByText(/PAST · AURORAVIEW/i)).toBeInTheDocument();
  });
});
