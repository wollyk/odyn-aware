import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MatchList } from "./MatchList";
import type { TimelineMatch } from "./useTimelineMatches";

const known: TimelineMatch = {
  id: 1, ts_ms: 1000, person_id: 7, person_name: "Bob",
  similarity: 0.91, quality: 0.85, bbox: null, thumb_url: "/x.jpg",
};
const unknown: TimelineMatch = {
  id: 2, ts_ms: 2000, person_id: null, person_name: null,
  similarity: 0.42, quality: 0.66, bbox: null, thumb_url: null,
};

describe("MatchList", () => {
  it("shows empty state when no matches", () => {
    render(<MatchList matches={[]} onPick={vi.fn()} />);
    expect(screen.getByText(/no face matches/i)).toBeInTheDocument();
  });

  it("renders one row per match", () => {
    render(<MatchList matches={[known, unknown]} onPick={vi.fn()} />);
    expect(screen.getAllByTestId("match-row")).toHaveLength(2);
  });

  it("calls onPick when a row is clicked", () => {
    const onPick = vi.fn();
    render(<MatchList matches={[known]} onPick={onPick} />);
    fireEvent.click(screen.getByTestId("match-row"));
    expect(onPick).toHaveBeenCalledWith(known);
  });

  it("marks selected row with data-selected=true", () => {
    render(<MatchList matches={[known]} selectedMatchId={1} onPick={vi.fn()} />);
    expect(screen.getByTestId("match-row").getAttribute("data-selected")).toBe("true");
  });
});
