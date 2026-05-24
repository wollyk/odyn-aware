// Tiny state-machine type for the live/past toggle.
//
// Pure functions; no side effects. The component owning the state
// just calls these helpers with the current mode and the user's
// intent, gets a new mode back, and renders.

import type { TimelineMatch } from "./useTimelineMatches";

export type PlaybackMode =
  | { kind: "live" }
  | {
      kind: "past";
      startMs: number;
      endMs: number;
      cursorMs: number;
      /** Optional — populated when the user clicked a face dot.
       *  Used by VideoTile to draw the pink probe bbox. */
      activeMatch?: TimelineMatch | null;
    };

export const LIVE: PlaybackMode = { kind: "live" };

/** Default window for the past timeline strip: most recent N ms. */
export function windowFor(now: number, spanMs: number): {
  start_ms: number;
  end_ms: number;
} {
  if (!Number.isFinite(now) || !Number.isFinite(spanMs) || spanMs <= 0) {
    throw new RangeError("invalid window inputs");
  }
  return { start_ms: now - spanMs, end_ms: now };
}

/** Force a cursor into the [startMs, endMs] window. */
export function clampCursor(
  mode: PlaybackMode,
  ms: number,
): number {
  if (mode.kind !== "past") return ms;
  if (ms < mode.startMs) return mode.startMs;
  if (ms > mode.endMs) return mode.endMs;
  return ms;
}

/** Returns a new past mode with cursor moved by `deltaMs` (clamped). */
export function nudgeCursor(
  mode: PlaybackMode,
  deltaMs: number,
): PlaybackMode {
  if (mode.kind !== "past") return mode;
  const next = mode.cursorMs + deltaMs;
  return {
    kind: "past",
    startMs: mode.startMs,
    endMs: mode.endMs,
    cursorMs: clampCursor(mode, next),
  };
}

/** Switch from live → past at a given cursor, with an explicit window. */
export function enterPast(
  startMs: number,
  endMs: number,
  cursorMs: number,
): PlaybackMode {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new RangeError("invalid window");
  }
  if (endMs <= startMs) {
    throw new RangeError("invalid window");
  }
  const cm = Math.max(startMs, Math.min(endMs, cursorMs));
  return { kind: "past", startMs, endMs, cursorMs: cm };
}

export const LIVE_MODE: PlaybackMode = { kind: "live" };
