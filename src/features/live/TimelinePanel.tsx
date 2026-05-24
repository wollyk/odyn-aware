// Live timeline panel — the composite "Option C" feature.
//
// Layout:
//   row 1: span selector  ·  loaded counts  ·  refresh
//   row 2: TimelineStrip (full width)
//   row 3: PastPlayer (left) + MatchList (right)
//
// State machine: `mode` here is just for the strip — past playback only
// becomes active when the user clicks a match (or scrubs to a non-now
// cursor and presses play). Until then the panel sits dormant so its
// data fetches don't block the live view above it.

import { useEffect, useMemo, useState } from "react";
import { useTimelineMatches, type TimelineMatch } from "./useTimelineMatches";
import { useTimelineSegments } from "./useTimelineSegments";
import { TimelineStrip } from "./TimelineStrip";
import { PastPlayer } from "./PastPlayer";
import { MatchList } from "./MatchList";

type SpanKey = "15m" | "1h" | "6h" | "24h";

const SPAN_MS: Record<SpanKey, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

export type TimelinePanelProps = {
  camera: string | null;
  /** Optional injection point for tests so we can skip dynamic-imports. */
  hlsModule?: typeof import("hls.js");
};

export function TimelinePanel({ camera, hlsModule }: TimelinePanelProps) {
  const [span, setSpan] = useState<SpanKey>("1h");
  const [now, setNow] = useState(Date.now());
  const [activeMatch, setActiveMatch] = useState<TimelineMatch | null>(null);
  const [pinnedWindow, setPinnedWindow] = useState<
    { start_ms: number; end_ms: number } | null
  >(null);
  const [cursorMs, setCursorMs] = useState<number>(Date.now());

  // Refresh "now" once per minute when nothing is pinned. We deliberately
  // don't refetch on a second-by-second cadence — matches/segments are
  // cheap but not free, and the human is fine with ±60s freshness.
  useEffect(() => {
    if (pinnedWindow) return;
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, [pinnedWindow]);

  const window_ = useMemo(() => {
    if (pinnedWindow) return pinnedWindow;
    return { start_ms: now - SPAN_MS[span], end_ms: now };
  }, [pinnedWindow, span, now]);

  const { matches, loading: mLoading, error: mError } = useTimelineMatches(
    camera,
    window_,
  );
  const { segments, loading: sLoading, error: sError } = useTimelineSegments(
    camera,
    window_,
  );

  // When the user changes camera or span, drop any active match/cursor.
  useEffect(() => {
    setActiveMatch(null);
    setPinnedWindow(null);
    setCursorMs(window_.end_ms);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, span]);

  if (!camera) {
    return (
      <section className="mt-6 border border-foreground/15 bg-foreground/[0.02] p-3 font-mono text-[10px] text-foreground/55">
        Timeline disabled: no camera selected.
      </section>
    );
  }

  return (
    <section className="mt-6" data-testid="timeline-panel">
      <div className="mb-3 flex items-center gap-3">
        <span className="font-mono text-xs text-alert">[03]</span>
        <span className="font-mono text-[11px] uppercase tracking-widest text-foreground/85">
          Timeline · {camera}
        </span>
        <span className="h-px flex-1 bg-border" />
        <SpanToggle value={span} onChange={setSpan} />
        <button
          type="button"
          onClick={() => {
            setActiveMatch(null);
            setPinnedWindow(null);
            setNow(Date.now());
          }}
          className="border border-border bg-background px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:border-foreground hover:text-foreground"
        >
          [ Now ]
        </button>
      </div>

      <TimelineStrip
        startMs={window_.start_ms}
        endMs={window_.end_ms}
        cursorMs={cursorMs}
        segments={segments}
        matches={matches}
        selectedMatchId={activeMatch?.id ?? null}
        onSeek={(ms) => {
          setCursorMs(ms);
          if (!pinnedWindow) setPinnedWindow(window_);
        }}
        onMatchClick={(m) => {
          setActiveMatch(m);
          setCursorMs(m.ts_ms);
          if (!pinnedWindow) setPinnedWindow(window_);
        }}
      />

      <div className="mt-1 flex justify-between font-mono text-[10px] text-foreground/55">
        <span>
          {matches.length} match{matches.length === 1 ? "" : "es"} ·{" "}
          {segments.length} recording{segments.length === 1 ? "" : "s"}
          {mLoading || sLoading ? " · loading…" : ""}
        </span>
        <span>
          {new Date(window_.start_ms).toLocaleString()} →{" "}
          {new Date(window_.end_ms).toLocaleString()}
        </span>
      </div>

      {(mError || sError) && (
        <div className="mt-2 border border-amber-400/40 bg-amber-400/10 px-2 py-1 font-mono text-[10px] text-amber-200">
          {mError && <div>matches: {mError}</div>}
          {sError && <div>segments: {sError}</div>}
        </div>
      )}

      {/* Past-playback panel: open whenever the user has scrubbed off
          "now" (pinnedWindow is set) OR clicked a match dot. Selected
          match is optional — without one we just play the recording. */}
      {(pinnedWindow || activeMatch) && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_360px]">
          <PastPlayer
            camera={camera}
            startMs={window_.start_ms}
            endMs={window_.end_ms}
            cursorMs={cursorMs}
            selectedMatch={activeMatch}
            onCursorChange={(ms) => setCursorMs(ms)}
            hlsModule={hlsModule}
          />
          <MatchList
            matches={matches}
            selectedMatchId={activeMatch?.id ?? null}
            onPick={(m) => {
              setActiveMatch(m);
              setCursorMs(m.ts_ms);
            }}
          />
        </div>
      )}
    </section>
  );
}

function SpanToggle({
  value,
  onChange,
}: {
  value: SpanKey;
  onChange: (v: SpanKey) => void;
}) {
  const items: SpanKey[] = ["15m", "1h", "6h", "24h"];
  return (
    <div className="inline-flex border border-border">
      {items.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onChange(k)}
          className={`px-2 py-1 font-mono text-[10px] uppercase tracking-widest transition-colors ${
            value === k
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {k}
        </button>
      ))}
    </div>
  );
}
