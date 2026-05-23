import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PastPlayer } from "./PastPlayer";

class FakeHls {
  static Events = { ERROR: "hlsError" };
  static isSupported = vi.fn(() => true);
  destroy = vi.fn();
  loadSource = vi.fn();
  attachMedia = vi.fn();
  on = vi.fn();
}
const fakeMod = { default: FakeHls as unknown as typeof import("hls.js").default };

describe("PastPlayer", () => {
  it("renders the video element and HUD", () => {
    render(
      <PastPlayer
        camera="Driveway"
        startMs={0}
        endMs={60_000}
        cursorMs={30_000}
        selectedMatch={null}
        hlsModule={fakeMod as unknown as typeof import("hls.js")}
      />,
    );
    expect(screen.getByTestId("past-player")).toBeInTheDocument();
    expect(screen.getByTestId("past-canvas")).toBeInTheDocument();
  });

  it("uses the correct HLS proxy URL for the camera+window", () => {
    Object.defineProperty(window.HTMLMediaElement.prototype, "canPlayType", {
      configurable: true,
      value: () => "probably",
    });
    const { container } = render(
      <PastPlayer
        camera="Front Door"
        startMs={1000}
        endMs={2000}
        cursorMs={1500}
        selectedMatch={null}
        hlsModule={fakeMod as unknown as typeof import("hls.js")}
      />,
    );
    const video = container.querySelector("video");
    expect(video?.src).toContain("/api/agent/timeline/Front%20Door/hls/master.m3u8");
    expect(video?.src).toContain("start_ms=1000");
    expect(video?.src).toContain("end_ms=2000");
  });
});
