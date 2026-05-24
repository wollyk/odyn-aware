// Fetches recording-density bins for the visible timeline window.
//
// Same shape and debounce/abort discipline as useTimelineMatches —
// kept as a separate hook because the call sites typically need both
// independently and merging would only complicate the abort logic.

import { useEffect, useRef, useState } from "react";
import type { TimelineWindow } from "./useTimelineMatches";

export type TimelineSegment = {
  start_ms: number;
  end_ms: number;
  bytes: number;
};

export function useTimelineSegments(
  camera: string | null,
  window: TimelineWindow | null,
  opts: { debounceMs?: number } = {},
): {
  segments: TimelineSegment[];
  binMs: number;
  loading: boolean;
  error: string | null;
} {
  const [segments, setSegments] = useState<TimelineSegment[]>([]);
  const [binMs, setBinMs] = useState(60_000);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const debounceMs = opts.debounceMs ?? 200;

  useEffect(() => {
    if (!camera || !window) {
      setSegments([]);
      setLoading(false);
      setError(null);
      return;
    }
    const handle = globalThis.setTimeout(() => {
      const ac = new AbortController();
      abortRef.current?.abort();
      abortRef.current = ac;
      setLoading(true);
      const qs = new URLSearchParams({
        start_ms: String(window.start_ms),
        end_ms: String(window.end_ms),
      });
      const url = `/api/agent/timeline/${encodeURIComponent(camera)}/segments?${qs}`;
      fetch(url, { credentials: "include", signal: ac.signal })
        .then(async (r) => {
          const ct = r.headers.get("content-type") ?? "";
          if (!ct.includes("application/json")) {
            throw new Error(`non_json_response (${r.status})`);
          }
          const body = (await r.json()) as {
            segments?: TimelineSegment[];
            bin_ms?: number;
            error?: string;
            detail?: string;
          };
          if (!r.ok) {
            // Include detail so the UI can show the real upstream reason
            // (e.g. "frigate recordings 401") instead of just "frigate_unreachable".
            const base = body.error ?? `http_${r.status}`;
            throw new Error(body.detail ? `${base}: ${body.detail}` : base);
          }
          setSegments(body.segments ?? []);
          setBinMs(body.bin_ms ?? 60_000);
          setError(null);
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "segments_failed");
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, debounceMs);

    return () => {
      globalThis.clearTimeout(handle);
      abortRef.current?.abort();
    };
  }, [camera, window?.start_ms, window?.end_ms, debounceMs]);

  return { segments, binMs, loading, error };
}
