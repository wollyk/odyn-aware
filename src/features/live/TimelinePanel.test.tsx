import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { TimelinePanel } from "./TimelinePanel";
import { LIVE_MODE, type PlaybackMode } from "./playbackMode";
import {
  installFetchMock,
  jsonResponse,
  type FetchMock,
} from "../../test/fetch-mock";

let mock: FetchMock;

beforeEach(() => {
  mock = installFetchMock();
  mock.on("GET", /\/matches/, () =>
    jsonResponse({
      matches: [
        {
          id: 17,
          ts_ms: Date.now() - 60_000,
          person_id: null,
          person_name: null,
          similarity: 0.55,
          quality: 0.6,
          bbox: [0.1, 0.1, 0.2, 0.2],
          thumb_url: "/api/agent/faces/matches/17/thumb",
        },
      ],
    }),
  );
  mock.on("GET", /\/segments/, () =>
    jsonResponse({
      bin_ms: 60_000,
      segments: [{ start_ms: Date.now() - 60_000, end_ms: Date.now(), bytes: 5000 }],
    }),
  );
});

afterEach(() => mock.restore());

/**
 * Test helper: render TimelinePanel inside a state container so we can
 * verify it correctly emits onPlaybackChange and reacts to controlled
 * playback updates the same way the parent would.
 */
function Harness({ camera = "Driveway" as string | null }: { camera?: string | null }) {
  const [playback, setPlayback] = useState<PlaybackMode>(LIVE_MODE);
  return (
    <div>
      <div data-testid="hmode">{playback.kind}</div>
      <div data-testid="hcursor">
        {playback.kind === "past" ? String(playback.cursorMs) : "—"}
      </div>
      <div data-testid="hactive-id">
        {playback.kind === "past" && playback.activeMatch
          ? String(playback.activeMatch.id)
          : "—"}
      </div>
      <TimelinePanel
        camera={camera}
        playback={playback}
        onPlaybackChange={setPlayback}
      />
    </div>
  );
}

describe("TimelinePanel (controlled)", () => {
  it("renders disabled state when camera is null", () => {
    render(
      <TimelinePanel
        camera={null}
        playback={LIVE_MODE}
        onPlaybackChange={() => {}}
      />,
    );
    expect(screen.getByText(/Timeline disabled/i)).toBeInTheDocument();
  });

  it("fetches matches and segments when a camera is provided", async () => {
    render(<Harness />);
    await waitFor(() => {
      expect(mock.calls.some((c) => c.url.includes("/matches"))).toBe(true);
      expect(mock.calls.some((c) => c.url.includes("/segments"))).toBe(true);
    });
  });

  it("clicking a match dot emits past playback with that match active", async () => {
    render(<Harness />);
    await waitFor(() =>
      expect(screen.queryByTestId("match-dot")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("match-dot"));
    expect(screen.getByTestId("hmode").textContent).toBe("past");
    expect(screen.getByTestId("hactive-id").textContent).toBe("17");
  });

  it("dragging the strip emits past playback with the dragged cursor", async () => {
    render(<Harness />);
    await waitFor(() =>
      expect(screen.queryByTestId("timeline-strip")).toBeInTheDocument(),
    );
    const strip = screen.getByTestId("timeline-strip") as HTMLElement;
    Object.defineProperty(strip, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(strip, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        left: 0, top: 0, right: 800, bottom: 100,
        width: 800, height: 100, x: 0, y: 0, toJSON() {},
      }),
    });
    fireEvent.pointerDown(strip, { clientX: 200, button: 0, pointerId: 1 });
    fireEvent.pointerMove(strip, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(strip, { clientX: 400, pointerId: 1 });

    expect(screen.getByTestId("hmode").textContent).toBe("past");
    expect(screen.getByTestId("hactive-id").textContent).toBe("—");
    expect(Number(screen.getByTestId("hcursor").textContent)).toBeGreaterThan(0);
  });

  it("clicking [Now] returns to live mode", async () => {
    render(<Harness />);
    await waitFor(() =>
      expect(screen.queryByTestId("match-dot")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("match-dot"));
    expect(screen.getByTestId("hmode").textContent).toBe("past");
    fireEvent.click(screen.getByRole("button", { name: /\[ Now \]/i }));
    expect(screen.getByTestId("hmode").textContent).toBe("live");
  });

  it("camera change forces back to live mode (does not strand a past window)", async () => {
    function CameraSwitcher() {
      const [cam, setCam] = useState("Driveway" as string);
      const [playback, setPlayback] = useState<PlaybackMode>({
        kind: "past",
        startMs: Date.now() - 60_000,
        endMs: Date.now(),
        cursorMs: Date.now() - 30_000,
        activeMatch: null,
      });
      return (
        <div>
          <div data-testid="hmode">{playback.kind}</div>
          <button type="button" onClick={() => setCam("Backyard")}>
            switch
          </button>
          <TimelinePanel
            camera={cam}
            playback={playback}
            onPlaybackChange={setPlayback}
          />
        </div>
      );
    }
    render(<CameraSwitcher />);
    expect(screen.getByTestId("hmode").textContent).toBe("past");
    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    await waitFor(() =>
      expect(screen.getByTestId("hmode").textContent).toBe("live"),
    );
  });

  it("span toggle re-issues fetches", async () => {
    render(<Harness />);
    await waitFor(() =>
      expect(mock.calls.some((c) => c.url.includes("/matches"))).toBe(true),
    );
    const before = mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() => expect(mock.calls.length).toBeGreaterThan(before));
  });
});
