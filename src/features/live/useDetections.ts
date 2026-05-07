// Snapshot-based vision detection polling — Phase 3.
//
// The server-side endpoint is now router-driven: every tick runs T2 (local
// Ollama VLM, $0). T3 (GPT-4o-mini vision) only fires when T2 says
// severity >= notable AND we're past the per-camera refresh window. The
// hook surface picks up T2 scene + severity + tier badge so the operator
// can see exactly why the system did or didn't pay for cloud vision this
// tick.
//
// Cost guards still in place:
//   - tab-not-visible → no poll at all
//   - server-side per-camera quota (returns 429)

import { useEffect, useState } from "react";
import type { Camera, Detection, DetectionResult } from "./types";

const POLL_MS = 5000;

export type UseDetectionsResult = {
  detections: Detection[];
  summary: string;
  status: DetectionResult["status"] | null;
  /** T2 sidecar (Phase 3). */
  localScene: string;
  severity: DetectionResult["severity"] | null;
  alertType: string | null;
  tier: DetectionResult["tier"] | null;
  escalationRan: boolean;
  escalationReason: string | null;
  t3AgeMs: number | null;
};

const EMPTY: UseDetectionsResult = {
  detections: [],
  summary: "",
  status: null,
  localScene: "",
  severity: null,
  alertType: null,
  tier: null,
  escalationRan: false,
  escalationReason: null,
  t3AgeMs: null,
};

export function useDetections(cam: Camera | null): UseDetectionsResult {
  const [state, setState] = useState<UseDetectionsResult>(EMPTY);

  useEffect(() => {
    if (!cam) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        timer = setTimeout(tick, POLL_MS);
        return;
      }
      try {
        const res = await fetch(
          `/api/agent/detections?camera=${encodeURIComponent(cam.name)}`,
          { credentials: "include" },
        );
        if (cancelled) return;
        if (res.ok) {
          const d: DetectionResult = await res.json();
          setState({
            detections: d.detections ?? [],
            summary: d.summary ?? "",
            status: d.status,
            localScene: d.local_scene ?? "",
            severity: d.severity ?? null,
            alertType: d.alert_type ?? null,
            tier: d.tier ?? null,
            escalationRan: Boolean(d.escalation?.ran),
            escalationReason: d.escalation?.reason ?? null,
            t3AgeMs: typeof d.t3_age_ms === "number" ? d.t3_age_ms : null,
          });
        }
      } catch {
        // Swallow transient errors; the next tick will try again.
      } finally {
        if (!cancelled) timer = setTimeout(tick, POLL_MS);
      }
    };

    const onVis = () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        if (timer) clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVis);

    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [cam]);

  return state;
}
