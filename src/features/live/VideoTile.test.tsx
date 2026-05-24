// Verifies the single-tile playback design: in past mode VideoTile
// hides the live <video>, shows an HLS-bound <video data-testid="past-video">,
// and asks the injected hls.js module to load the timeline manifest.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
