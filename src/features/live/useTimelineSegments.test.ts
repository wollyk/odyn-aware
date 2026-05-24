import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { installFetchMock, jsonResponse, type FetchMock } from "../../test/fetch-mock";
import { useTimelineSegments } from "./useTimelineSegments";

let mock: FetchMock;

beforeEach(() => {
  mock = installFetchMock();
});

afterEach(() => {
  mock.restore();
});

describe("useTimelineSegments", () => {
  it("returns empty + no fetch when camera is null", () => {
    const { result } = renderHook(() =>
      useTimelineSegments(null, { start_ms: 0, end_ms: 1000 }, { debounceMs: 0 }),
    );
    expect(result.current.segments).toEqual([]);
    expect(mock.calls.length).toBe(0);
  });

  it("parses segments + binMs from response", async () => {
    mock.on("GET", /\/segments/, () =>
      jsonResponse({
        bin_ms: 5 * 60_000,
        segments: [{ start_ms: 0, end_ms: 5 * 60_000, bytes: 100 }],
      }),
    );
    const { result } = renderHook(() =>
      useTimelineSegments("Driveway", { start_ms: 0, end_ms: 60_000 }, { debounceMs: 0 }),
    );
    await waitFor(() => expect(result.current.segments).toHaveLength(1));
    expect(result.current.binMs).toBe(5 * 60_000);
  });

  it("surfaces error on 5xx", async () => {
    mock.on("GET", /\/segments/, () =>
      jsonResponse({ error: "frigate_unreachable" }, { status: 502 }),
    );
    const { result } = renderHook(() =>
      useTimelineSegments("Driveway", { start_ms: 0, end_ms: 60_000 }, { debounceMs: 0 }),
    );
    await waitFor(() => expect(result.current.error).toBe("frigate_unreachable"));
  });

  it("includes detail field in the error message when present", async () => {
    mock.on("GET", /\/segments/, () =>
      jsonResponse(
        { error: "frigate_unreachable", detail: "frigate recordings 401" },
        { status: 502 },
      ),
    );
    const { result } = renderHook(() =>
      useTimelineSegments("Driveway", { start_ms: 0, end_ms: 60_000 }, { debounceMs: 0 }),
    );
    await waitFor(() =>
      expect(result.current.error).toBe("frigate_unreachable: frigate recordings 401"),
    );
  });
});
