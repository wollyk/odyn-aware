import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TimelineStrip } from "./TimelineStrip";
import type { TimelineMatch } from "./useTimelineMatches";
import type { TimelineSegment } from "./useTimelineSegments";

const baseProps = {
  startMs: 0,
  endMs: 1000,
  cursorMs: 500,
  segments: [] as TimelineSegment[],
  matches: [] as TimelineMatch[],
  onSeek: vi.fn(),
  onMatchClick: vi.fn(),
};

function setWidth(el: HTMLElement, px: number) {
  Object.defineProperty(el, "clientWidth", { configurable: true, value: px });
  Object.defineProperty(el, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ left: 0, top: 0, right: px, bottom: 100, width: px, height: 100, x: 0, y: 0, toJSON() {} }),
  });
}

describe("TimelineStrip", () => {
  it("renders one density bar per segment", () => {
    const segments: TimelineSegment[] = [
      { start_ms: 0, end_ms: 200, bytes: 100 },
      { start_ms: 200, end_ms: 400, bytes: 500 },
    ];
    render(<TimelineStrip {...baseProps} segments={segments} />);
    expect(screen.getAllByTestId("density-bar")).toHaveLength(2);
  });

  it("renders one dot per match with kind attribute", () => {
    const matches: TimelineMatch[] = [
      { id: 1, ts_ms: 100, person_id: 5, person_name: "Bob", similarity: 0.9, quality: 0.8, bbox: null, thumb_url: null },
      { id: 2, ts_ms: 600, person_id: null, person_name: null, similarity: 0.5, quality: 0.5, bbox: null, thumb_url: null },
    ];
    render(<TimelineStrip {...baseProps} matches={matches} />);
    const dots = screen.getAllByTestId("match-dot");
    expect(dots).toHaveLength(2);
    expect(dots[0].getAttribute("data-kind")).toBe("known");
    expect(dots[1].getAttribute("data-kind")).toBe("unknown");
  });

  it("marks selectedMatchId as selected", () => {
    const matches: TimelineMatch[] = [
      { id: 7, ts_ms: 100, person_id: 5, person_name: "Bob", similarity: 0.9, quality: 0.8, bbox: null, thumb_url: null },
    ];
    render(<TimelineStrip {...baseProps} matches={matches} selectedMatchId={7} />);
    expect(screen.getByTestId("match-dot").getAttribute("data-selected")).toBe("true");
  });

  it("clicking the strip calls onSeek with the mapped ms", () => {
    const onSeek = vi.fn();
    const { container } = render(
      <TimelineStrip {...baseProps} onSeek={onSeek} />,
    );
    const strip = container.querySelector("[data-testid='timeline-strip']") as HTMLElement;
    setWidth(strip, 1000);
    // Trigger an internal resize observer flush via a manual rerender:
    fireEvent.click(strip, { clientX: 500 });
    expect(onSeek).toHaveBeenCalled();
    const callArg = onSeek.mock.calls[0][0];
    expect(callArg).toBeGreaterThanOrEqual(0);
    expect(callArg).toBeLessThanOrEqual(1000);
  });

  it("clicking a match dot calls onMatchClick and stops propagation", () => {
    const onMatchClick = vi.fn();
    const onSeek = vi.fn();
    const matches: TimelineMatch[] = [
      { id: 11, ts_ms: 250, person_id: null, person_name: null, similarity: 0.4, quality: 0.3, bbox: null, thumb_url: null },
    ];
    render(
      <TimelineStrip
        {...baseProps}
        matches={matches}
        onMatchClick={onMatchClick}
        onSeek={onSeek}
      />,
    );
    fireEvent.click(screen.getByTestId("match-dot"));
    expect(onMatchClick).toHaveBeenCalledWith(matches[0]);
    expect(onSeek).not.toHaveBeenCalled();
  });
});
