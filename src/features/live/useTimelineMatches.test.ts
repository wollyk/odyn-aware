import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { installFetchMock, jsonResponse, type FetchMock } from "../../test/fetch-mock";
import { useTimelineMatches } from "./useTimelineMatches";

let mock: FetchMock;

beforeEach(() => {
  mock = installFetchMock();
});

afterEach(() => {
  mock.restore();
});

describe("useTimelineMatches", () => {
  it("returns empty + no fetch when camera is null", () => {
    const { result } = renderHook(() =>
      useTimelineMatches(null, { start_ms: 0, end_ms: 1000 }, { debounceMs: 0 }),
    );
    expect(result.current.matches).toEqual([]);
    expect(mock.calls.length).toBe(0);
  });

  it("fetches matches for the window and parses them", async () => {
    mock.on("GET", /\/api\/agent\/timeline\/Driveway\/matches/, () =>
      jsonResponse({
        matches: [
          {
            id: 1,
            ts_ms: 500,
            person_id: null,
            person_name: null,
            similarity: 0.8,
            quality: 0.9,
            bbox: [0, 0, 1, 1],
            thumb_url: null,
          },
        ],
      }),
    );
    const { result } = renderHook(() =>
      useTimelineMatches("Driveway", { start_ms: 0, end_ms: 1000 }, { debounceMs: 0 }),
    );
    await waitFor(() => expect(result.current.matches).toHaveLength(1));
    expect(result.current.matches[0].id).toBe(1);
    expect(result.current.error).toBeNull();
  });

  it("surfaces error on non-JSON response", async () => {
    mock.on("GET", /\/api\/agent\/timeline\/.+\/matches/, () =>
      new Response("<html>oops</html>", { status: 502, headers: { "Content-Type": "text/html" } }),
    );
    const { result } = renderHook(() =>
      useTimelineMatches("Driveway", { start_ms: 0, end_ms: 1000 }, { debounceMs: 0 }),
    );
    await waitFor(() => expect(result.current.error).toMatch(/non_json/));
  });

  it("sends person_id=unknown when filter set to unknown", async () => {
    mock.on("GET", /matches/, () => jsonResponse({ matches: [] }));
    renderHook(() =>
      useTimelineMatches(
        "Driveway",
        { start_ms: 0, end_ms: 1000 },
        { personFilter: "unknown", debounceMs: 0 },
      ),
    );
    await waitFor(() => expect(mock.calls.length).toBeGreaterThan(0));
    const url = mock.calls[0].url;
    expect(url).toMatch(/person_id=unknown/);
  });

  it("debounces rapid window changes into a single fetch", async () => {
    vi.useFakeTimers();
    mock.on("GET", /matches/, () => jsonResponse({ matches: [] }));
    const { rerender } = renderHook(
      ({ end }) =>
        useTimelineMatches(
          "Driveway",
          { start_ms: 0, end_ms: end },
          { debounceMs: 200 },
        ),
      { initialProps: { end: 1000 } },
    );
    rerender({ end: 1100 });
    rerender({ end: 1200 });
    rerender({ end: 1300 });
    expect(mock.calls.length).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    vi.useRealTimers();
    await waitFor(() => expect(mock.calls.length).toBe(1));
    expect(mock.calls[0].url).toMatch(/end_ms=1300/);
  });
});
