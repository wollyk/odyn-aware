import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import {
  installFetchMock,
  jsonResponse,
  type FetchMock,
} from "../../test/fetch-mock";

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

describe("TimelinePanel", () => {
  it("renders disabled state when camera is null", () => {
    render(<TimelinePanel camera={null} />);
    expect(screen.getByText(/Timeline disabled/i)).toBeInTheDocument();
  });

  it("fetches matches and segments when a camera is provided", async () => {
    render(<TimelinePanel camera="Driveway" hlsModule={fakeHlsModule as unknown as typeof import("hls.js")} />);
    await waitFor(() => {
      expect(mock.calls.some((c) => c.url.includes("/matches"))).toBe(true);
      expect(mock.calls.some((c) => c.url.includes("/segments"))).toBe(true);
    });
  });

  it("clicking a match dot opens the PastPlayer", async () => {
    render(<TimelinePanel camera="Driveway" hlsModule={fakeHlsModule as unknown as typeof import("hls.js")} />);
    await waitFor(() =>
      expect(screen.queryByTestId("match-dot")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("match-dot"));
    expect(screen.getByTestId("past-player")).toBeInTheDocument();
  });

  it("clicking [Now] resets pinned window", async () => {
    render(<TimelinePanel camera="Driveway" hlsModule={fakeHlsModule as unknown as typeof import("hls.js")} />);
    await waitFor(() =>
      expect(screen.queryByTestId("match-dot")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("match-dot"));
    expect(screen.getByTestId("past-player")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /\[ Now \]/i }));
    expect(screen.queryByTestId("past-player")).not.toBeInTheDocument();
  });

  it("span toggle re-issues fetches", async () => {
    render(<TimelinePanel camera="Driveway" />);
    await waitFor(() =>
      expect(mock.calls.some((c) => c.url.includes("/matches"))).toBe(true),
    );
    const before = mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "24h" }));
    await waitFor(() => expect(mock.calls.length).toBeGreaterThan(before));
  });
});
