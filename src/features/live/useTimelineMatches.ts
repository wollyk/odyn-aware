// Fetches face matches for the visible timeline window.
//
// Behaviors:
//   - AbortController on every (camera, window) change
//   - 200ms debounce while the user drags the window
//   - Keeps the previous result while a new fetch is in flight, so the
//     timeline strip doesn't blink on every refetch
//   - Errors are sticky and surfaced for the UI; on retry-success they clear

import { useEffect, useRef, useState } from "react";

export type TimelineMatch = {
  id: number;
  ts_ms: number;
  person_id: number | null;
  person_name: string | null;
  similarity: number;
  quality: number;
  bbox: [number, number, number, number] | null;
  thumb_url: string | null;
};

export type TimelineWindow = { start_ms: number; end_ms: number };

export function useTimelineMatches(
  camera: string | null,
  window: TimelineWindow | null,
  opts: { personFilter?: number | "unknown" | null; debounceMs?: number } = {},
): {
  matches: TimelineMatch[];
  loading: boolean;
  error: string | null;
} {
  const [matches, setMatches] = useState<TimelineMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const debounceMs = opts.debounceMs ?? 200;
  const personFilter = opts.personFilter ?? null;

  useEffect(() => {
    if (!camera || !window) {
      setMatches([]);
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
      if (personFilter === "unknown") qs.set("person_id", "unknown");
      else if (typeof personFilter === "number") qs.set("person_id", String(personFilter));
      const url = `/api/agent/timeline/${encodeURIComponent(camera)}/matches?${qs}`;
      fetch(url, { credentials: "include", signal: ac.signal })
        .then(async (r) => {
          const ct = r.headers.get("content-type") ?? "";
          if (!ct.includes("application/json")) {
            throw new Error(`non_json_response (${r.status})`);
          }
          const body = (await r.json()) as {
            matches?: TimelineMatch[];
            error?: string;
            detail?: string;
          };
          if (!r.ok) {
            const base = body.error ?? `http_${r.status}`;
            throw new Error(body.detail ? `${base}: ${body.detail}` : base);
          }
          setMatches(body.matches ?? []);
          setError(null);
        })
        .catch((err) => {
          if (err?.name === "AbortError") return;
          setError(err instanceof Error ? err.message : "matches_failed");
        })
        .finally(() => {
          if (!ac.signal.aborted) setLoading(false);
        });
    }, debounceMs);

    return () => {
      globalThis.clearTimeout(handle);
      abortRef.current?.abort();
    };
  }, [camera, window?.start_ms, window?.end_ms, personFilter, debounceMs]);

  return { matches, loading, error };
}
