// Horizontal timeline scrubber.
//
// Visual stack (top to bottom):
//   - Density bars (gray): recording-segment density from /segments
//   - Match dots: face matches from /matches, colored by known/unknown
//   - Cursor line: current playback position
//   - Tick labels: aligned to pickTickInterval(spanMs)
//
// Pure presentational — no data fetching here. Owner passes in arrays.

import { useRef, useEffect, useState, useMemo } from "react";
import {
  msToPx,
  pxToMs,
  generateTicks,
  formatTick,
  pickTickInterval,
} from "./timeline-math";
import type { TimelineMatch } from "./useTimelineMatches";
import type { TimelineSegment } from "./useTimelineSegments";

export type TimelineStripProps = {
  startMs: number;
  endMs: number;
  cursorMs: number;
  segments: TimelineSegment[];
  matches: TimelineMatch[];
  onSeek: (ms: number) => void;
  onMatchClick: (m: TimelineMatch) => void;
  selectedMatchId?: number | null;
  heightPx?: number;
};

export function TimelineStrip(props: TimelineStripProps) {
  const {
    startMs,
    endMs,
    cursorMs,
    segments,
    matches,
    onSeek,
    onMatchClick,
    selectedMatchId,
    heightPx = 72,
  } = props;

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [widthPx, setWidthPx] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setWidthPx(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ticks = useMemo(() => generateTicks(startMs, endMs), [startMs, endMs]);
  const tickKind = pickTickInterval(endMs - startMs).kind;
  const maxBytes = useMemo(
    () => Math.max(1, ...segments.map((s) => s.bytes)),
    [segments],
  );

  // Drag scrubbing via pointer events:
  //   - pointerdown: capture, seek, enter "dragging"
  //   - pointermove: continuous seek while captured
  //   - pointerup/cancel: release capture, exit "dragging"
  //
  // The hover state separately tracks the mouse position so we can render
  // a wall-clock tooltip ahead of any commit. Touch users skip the
  // tooltip and just scrub.
  const [dragging, setDragging] = useState(false);
  const [hoverMs, setHoverMs] = useState<number | null>(null);

  const msFromEvent = (clientX: number): number | null => {
    if (!wrapRef.current) return null;
    const rect = wrapRef.current.getBoundingClientRect();
    const w = rect.width || widthPx;
    if (w === 0) return null;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    return pxToMs(x, startMs, endMs, w);
  };

  const onPointerDown: React.PointerEventHandler<HTMLDivElement> = (e) => {
    // Ignore secondary buttons. Note: jsdom often leaves `button`
    // undefined on synthetic pointer events, so we only bail on
    // explicit right/middle clicks (>0) rather than `!== 0`.
    if ((e.button ?? 0) > 0) return;
    if ((e.target as HTMLElement).closest("[data-match-dot]")) return;
    const ms = msFromEvent(e.clientX);
    if (ms == null) return;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    setDragging(true);
    onSeek(ms);
  };

  const onPointerMove: React.PointerEventHandler<HTMLDivElement> = (e) => {
    const ms = msFromEvent(e.clientX);
    if (ms == null) return;
    setHoverMs(ms);
    if (dragging) onSeek(ms);
  };

  const endDrag: React.PointerEventHandler<HTMLDivElement> = (e) => {
    if (!dragging) return;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    setDragging(false);
  };

  const onPointerLeave: React.PointerEventHandler<HTMLDivElement> = () => {
    if (!dragging) setHoverMs(null);
  };

  return (
    <div
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={onPointerLeave}
      role="slider"
      aria-label="Timeline"
      aria-valuemin={startMs}
      aria-valuemax={endMs}
      aria-valuenow={cursorMs}
      data-testid="timeline-strip"
      data-width={widthPx}
      data-dragging={dragging ? "true" : "false"}
      className={`relative w-full touch-none select-none border border-foreground/15 bg-foreground/[0.04] ${
        dragging ? "cursor-grabbing" : "cursor-ew-resize"
      }`}
      style={{ height: heightPx }}
    >
      {/* Density bars */}
      <div className="absolute inset-x-0 bottom-6 top-6 overflow-hidden">
        {segments.map((s) => {
          const x = msToPx(s.start_ms, startMs, endMs, widthPx);
          const w = Math.max(
            1,
            msToPx(s.end_ms, startMs, endMs, widthPx) - x,
          );
          const alpha = Math.min(0.6, 0.1 + 0.5 * (s.bytes / maxBytes));
          return (
            <div
              key={s.start_ms}
              data-testid="density-bar"
              className="absolute bottom-0 top-0"
              style={{
                left: x,
                width: w,
                background: `rgba(148, 163, 184, ${alpha})`,
              }}
            />
          );
        })}
      </div>

      {/* Cursor */}
      <div
        data-testid="cursor"
        className="absolute bottom-0 top-0 z-20 w-px bg-white/85"
        style={{ left: msToPx(cursorMs, startMs, endMs, widthPx) }}
      />

      {/* Cursor knob — bigger hit target hint */}
      <div
        aria-hidden
        className="pointer-events-none absolute z-20 -translate-x-1/2 rounded-full border border-white/80 bg-white/20"
        style={{
          left: msToPx(cursorMs, startMs, endMs, widthPx),
          top: 4,
          width: 8,
          height: 8,
        }}
      />

      {/* Hover tooltip with wall-clock time at the pointer */}
      {hoverMs != null && (
        <div
          data-testid="timeline-tooltip"
          className="pointer-events-none absolute z-30 -translate-x-1/2 whitespace-nowrap border border-white/30 bg-black/80 px-1.5 py-0.5 font-mono text-[10px] text-white/90"
          style={{ left: msToPx(hoverMs, startMs, endMs, widthPx), top: -22 }}
        >
          {new Date(hoverMs).toLocaleTimeString()}
        </div>
      )}

      {/* Match dots */}
      <div className="absolute inset-x-0 bottom-6 top-6">
        {matches.map((m) => {
          const x = msToPx(m.ts_ms, startMs, endMs, widthPx);
          const known = m.person_id != null;
          const selected = selectedMatchId === m.id;
          const color = selected
            ? "#f472b6"
            : known
              ? "#34d399"
              : "#fbbf24";
          return (
            <button
              key={m.id}
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onMatchClick(m);
              }}
              data-testid="match-dot"
              data-match-dot="true"
              data-kind={known ? "known" : "unknown"}
              data-selected={selected ? "true" : "false"}
              title={`${m.person_name ?? "unknown"} · ${(m.similarity * 100).toFixed(0)}% · ${new Date(m.ts_ms).toLocaleTimeString()}`}
              className="absolute z-10 -translate-x-1/2 rounded-full border border-black/40"
              style={{
                left: x,
                top: "50%",
                marginTop: -5,
                width: selected ? 12 : 8,
                height: selected ? 12 : 8,
                background: color,
                boxShadow: selected ? "0 0 0 3px rgba(244,114,182,0.35)" : undefined,
              }}
            />
          );
        })}
      </div>

      {/* Tick labels */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-5 text-[10px] text-foreground/55 font-mono">
        {ticks.map((t) => (
          <span
            key={t}
            className="absolute -translate-x-1/2"
            style={{ left: msToPx(t, startMs, endMs, widthPx) }}
          >
            {formatTick(t, tickKind)}
          </span>
        ))}
      </div>
    </div>
  );
}
