// Snapshot-based vision detection polling.
//
// Cost guard: each tick is one GPT-4o-mini vision call (~$0.0001). At 5s
// cadence that's ~$1.40/day if the tab is left open. We pause when
// document.visibilityState !== "visible" so a backgrounded tab costs $0.
//
// Future: this hook is the natural place to switch from T3 (cloud GPT) to
// T2 (local Ollama VLM) once the harness wires Ollama in. The hook contract
// stays the same; only the underlying server endpoint flips.

import { useEffect, useState } from "react";
import type { Camera, Detection, DetectionResult } from "./types";

const POLL_MS = 5000;

export type UseDetectionsResult = {
  detections: Detection[];
  summary: string;
  status: DetectionResult["status"] | null;
};

export function useDetections(cam: Camera | null): UseDetectionsResult {
  const [detections, setDetections] = useState<Detection[]>([]);
  const [summary, setSummary] = useState<string>("");
  const [status, setStatus] = useState<DetectionResult["status"] | null>(null);

  useEffect(() => {
    if (!cam) {
      setDetections([]);
      setSummary("");
      setStatus(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      // Skip the call entirely if the tab isn't visible.
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
          const data: DetectionResult = await res.json();
          setDetections(data.detections ?? []);
          setSummary(data.summary ?? "");
          setStatus(data.status);
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

  return { detections, summary, status };
}
