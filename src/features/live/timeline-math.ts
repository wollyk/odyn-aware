// Pure px↔ms math used by the timeline strip + its tooltip + the cursor
// drag. Kept separate so we can unit-test without a DOM.

export function msToPx(
  ms: number,
  startMs: number,
  endMs: number,
  widthPx: number,
): number {
  if (widthPx <= 0 || endMs <= startMs) return 0;
  const ratio = (ms - startMs) / (endMs - startMs);
  return Math.max(0, Math.min(widthPx, ratio * widthPx));
}

export function pxToMs(
  px: number,
  startMs: number,
  endMs: number,
  widthPx: number,
): number {
  if (widthPx <= 0 || endMs <= startMs) return startMs;
  const ratio = Math.max(0, Math.min(1, px / widthPx));
  return Math.round(startMs + ratio * (endMs - startMs));
}

export type TickKind = "time" | "date";

/**
 * Pick a tick interval based on visible span length. The returned step
 * keeps the number of visible ticks roughly in [6, 12], which is the
 * sweet spot for readability across desktop widths.
 */
export function pickTickInterval(spanMs: number): {
  stepMs: number;
  kind: TickKind;
} {
  if (spanMs <= 5 * 60_000) return { stepMs: 60_000, kind: "time" };
  if (spanMs <= 30 * 60_000) return { stepMs: 5 * 60_000, kind: "time" };
  if (spanMs <= 2 * 60 * 60_000) return { stepMs: 10 * 60_000, kind: "time" };
  if (spanMs <= 6 * 60 * 60_000) return { stepMs: 30 * 60_000, kind: "time" };
  if (spanMs <= 24 * 60 * 60_000) return { stepMs: 2 * 60 * 60_000, kind: "time" };
  return { stepMs: 6 * 60 * 60_000, kind: "date" };
}

/**
 * Generate the tick stamps that should be labeled inside [startMs, endMs].
 * Returns ms values aligned to the chosen step.
 */
export function generateTicks(startMs: number, endMs: number): number[] {
  const { stepMs } = pickTickInterval(endMs - startMs);
  const first = Math.ceil(startMs / stepMs) * stepMs;
  const out: number[] = [];
  for (let t = first; t < endMs; t += stepMs) {
    out.push(t);
    if (out.length > 50) break; // hard guard
  }
  return out;
}

/**
 * Format a tick label. Tests pin this to a deterministic UTC offset
 * by passing in a `formatter`. Production callers can use the default.
 */
export function formatTick(
  ms: number,
  kind: TickKind,
  formatter: Intl.DateTimeFormat | null = null,
): string {
  if (formatter) return formatter.format(new Date(ms));
  if (kind === "date") {
    return new Date(ms).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
