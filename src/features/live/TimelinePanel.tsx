// Controlled timeline panel.
//
// Layout:
//   row 1: span selector  ·  loaded counts  ·  [ Now ]
//   row 2: TimelineStrip (full width)
//   row 3: MatchList (right column when in past mode)
//
// Ownership note: this component is **controlled by the parent**. The
// parent owns `playback` (live vs past) and the cursorMs. We only own
// transient UI state — the span selector and the "now" clock that drives
// live-mode windowing. Every user gesture (click/drag/match-pick/Now)
// translates into an `onPlaybackChange(next)` call. This lets the live
// VideoTile and the timeline stay in sync via a single source of truth.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTimelineMatches, type TimelineMatch } from "./useTimelineMatches";
import { useTimelineSegments } from "./useTimelineSegments";
import { TimelineStrip } from "./TimelineStrip";
import { MatchList } from "./MatchList";
import type { PlaybackMode } from "./playbackMode";

type SpanKey = "15m" | "1h" | "6h" | "24h";

const SPAN_MS: Record<SpanKey, number> = {
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
};

export type TimelinePanelProps = {
  camera: string | null;
  /** Current playback intent — sourced from the parent. */
  playback: PlaybackMode;
  /** Called whenever the user changes the playback intent. */
  onPlaybackChange: (next: PlaybackMode) => void;
};

export function TimelinePanel({
  camera,
  playback,
  onPlaybackChange,
}: TimelinePanelProps) {
  const [span, setSpan] = useState<SpanKey>("1h");
  const [now, setNow] = useState(Date.now());

  const isPast = playback.kind === "past";

  // Refresh "now" once per minute while in live mode. We don't refresh
  // every second — segments/matches are cheap but not free and ±60s is
  // fine for human review.
  useEffect(() => {
    if (isPast) return;
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, [isPast]);

  // Derive the visible time window:
  //   live mode  → [now - span, now]
  //   past mode  → frozen at the window from when the user first scrubbed
  const window_ = useMemo(() => {
    if (isPast) {
      return { start_ms: playback.startMs, end_ms: playback.endMs };
    }
    return { start_ms: now - SPAN_MS[span], end_ms: now };
  }, [isPast, playback, span, now]);

  const cursorMs = isPast ? playback.cursorMs : window_.end_ms;
  const activeMatch = isPast ? playback.activeMatch ?? null : null;

  const { matches, loading: mLoading, error: mError } = useTimelineMatches(
    camera,
    window_,
  );
  const { segments, loading: sLoading, error: sError } = useTimelineSegments(
    camera,
    window_,
  );

  // Camera change → back to live so we don't try to load HLS for a
  // window that referred to a different camera's recording set. We use
  // a ref to skip the initial mount: a parent that hands us
  // `playback={past}` on first render meant it; only later switches
  // should reset.
  const prevCameraRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevCameraRef.current === undefined) {
      prevCameraRef.current = camera;
      return;
    }
    if (prevCameraRef.current !== camera) {
      prevCameraRef.current = camera;
      if (playback.kind === "past") onPlaybackChange({ kind: "live" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera]);

  if (!camera) {
    return (
      <section className="mt-6 border border-foreground/15 bg-foreground/[0.02] p-3 font-mono text-[10px] text-foreground/55">
        Timeline disabled: no camera selected.
      </section>
    );
  }

  const seekTo = (ms: number) => {
    // Snap the timeline window the first time we scrub. Subsequent
    // scrubs reuse the frozen window so the strip doesn't slide.
    if (playback.kind === "past") {
      onPlaybackChange({ ...playback, cursorMs: ms });
    } else {
      onPlaybackChange({
        kind: "past",
        startMs: window_.start_ms,
        endMs: window_.end_ms,
        cursorMs: ms,
        activeMatch: null,
      });
    }
  };

  const pickMatch = (m: TimelineMatch) => {
    if (playback.kind === "past") {
      onPlaybackChange({ ...playback, cursorMs: m.ts_ms, activeMatch: m });
    } else {
      onPlaybackChange({
        kind: "past",
        startMs: window_.start_ms,
        endMs: window_.end_ms,
        cursorMs: m.ts_ms,
        activeMatch: m,
      });
    }
  };

  return (
    <section className="mt-6" data-testid="timeline-panel">
      <div className="mb-3 flex items-center gap-3">
        <span className="font-mono text-xs text-alert">[03]</span>
        <span className="font-mono text-[11px] uppercase tracking-widest text-foreground/85">
          Timeline · {camera}
        </span>
        <span className="h-px flex-1 bg-border" />
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/55">
          {isPast ? "past playback" : "live"}
        </span>
        <SpanToggle value={span} onChange={setSpan} />
        <button
          type="button"
          onClick={() => {
            setNow(Date.now());
            onPlaybackChange({ kind: "live" });
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
        onSeek={seekTo}
        onMatchClick={pickMatch}
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

      {isPast && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_360px]">
          <div className="border border-foreground/15 bg-foreground/[0.02] p-3 font-mono text-[10px] text-foreground/55">
            Playback rendered in the Live View tile above. Drag the
            timeline or pick a match to scrub. Press [ Now ] to return
            to live.
          </div>
          <MatchList
            matches={matches}
            selectedMatchId={activeMatch?.id ?? null}
            onPick={pickMatch}
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
