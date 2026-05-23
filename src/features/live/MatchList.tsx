// Scrollable list of recent face matches with thumbnails.
//
// Companion to TimelineStrip: same data set, alternate presentation
// optimized for reading person names + clicking a specific row.

import type { TimelineMatch } from "./useTimelineMatches";

export type MatchListProps = {
  matches: TimelineMatch[];
  selectedMatchId?: number | null;
  onPick: (m: TimelineMatch) => void;
};

export function MatchList({ matches, selectedMatchId, onPick }: MatchListProps) {
  if (matches.length === 0) {
    return (
      <div className="border border-foreground/15 bg-foreground/[0.02] p-3 font-mono text-[10px] text-foreground/55">
        No face matches in this window.
      </div>
    );
  }
  return (
    <div
      data-testid="match-list"
      className="max-h-64 overflow-y-auto border border-foreground/15 bg-foreground/[0.02]"
    >
      <table className="w-full border-collapse font-mono text-[10px]">
        <thead>
          <tr className="sticky top-0 border-b border-foreground/15 bg-background text-left uppercase tracking-widest text-foreground/55">
            <th className="px-2 py-2">Thumb</th>
            <th className="px-2 py-2">When</th>
            <th className="px-2 py-2">Who</th>
            <th className="px-2 py-2">Sim</th>
          </tr>
        </thead>
        <tbody>
          {matches.map((m) => {
            const selected = selectedMatchId === m.id;
            return (
              <tr
                key={m.id}
                data-testid="match-row"
                data-selected={selected ? "true" : "false"}
                onClick={() => onPick(m)}
                className={`cursor-pointer border-b border-foreground/10 ${
                  selected ? "bg-pink-500/10" : "hover:bg-foreground/[0.04]"
                }`}
              >
                <td className="px-2 py-2">
                  {m.thumb_url ? (
                    <img
                      src={m.thumb_url}
                      alt="face"
                      className="h-8 w-8 border border-foreground/15 object-cover"
                    />
                  ) : (
                    <span className="text-foreground/35">—</span>
                  )}
                </td>
                <td className="px-2 py-2 text-foreground/80">
                  {new Date(m.ts_ms).toLocaleTimeString()}
                </td>
                <td
                  className={`px-2 py-2 ${m.person_id ? "text-emerald-300" : "text-amber-300"}`}
                >
                  {m.person_name ?? "unknown"}
                </td>
                <td className="px-2 py-2 text-sky-300">
                  {(m.similarity * 100).toFixed(0)}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
