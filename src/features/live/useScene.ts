// Tier-2 (local Ollama VLM) scene-description polling.
//
// Companion to useDetections. T3 (GPT) gives us bounding boxes; T2 (local)
// gives us a free-text scene summary + heuristic severity. Surfaced as a
// caption on the video tile so the operator can see the local agent's
// independent reading and we can compare the two tiers side-by-side.
//
// Cost: $0 marginal — Ollama is local. We still poll only when the tab is
// visible (same cost guard as useDetections) to be polite about shared GPU
// time.

import { useEffect, useState } from "react";
import type { Camera, SceneResult } from "./types";

const POLL_MS = 5000;

export type UseSceneResult = {
  scene: string;
  severity: SceneResult["severity"] | null;
  alertType: string | null;
  confidence: number | null;
  status: SceneResult["status"] | null;
  model: string | null;
  tookMs: number | null;
  error: string | null;
};

const EMPTY: UseSceneResult = {
  scene: "",
  severity: null,
  alertType: null,
  confidence: null,
  status: null,
  model: null,
  tookMs: null,
  error: null,
};

export function useScene(cam: Camera | null): UseSceneResult {
  const [data, setData] = useState<UseSceneResult>(EMPTY);

  useEffect(() => {
    if (!cam) {
      setData(EMPTY);
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
          `/api/agent/scene?camera=${encodeURIComponent(cam.name)}`,
          { credentials: "include" },
        );
        if (cancelled) return;
        if (res.ok) {
          const r: SceneResult = await res.json();
          setData({
            scene: r.scene ?? "",
            severity: r.severity ?? null,
            alertType: r.alert_type ?? null,
            confidence: typeof r.confidence === "number" ? r.confidence : null,
            status: r.status,
            model: r.model ?? null,
            tookMs: typeof r.tookMs === "number" ? r.tookMs : null,
            error: r.error ?? null,
          });
        } else if (res.status === 429) {
          // Quota exceeded — keep last value, just note the error.
          setData((prev) => ({ ...prev, error: "quota_exceeded" }));
        }
      } catch {
        // Swallow transient errors; next tick retries.
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

  return data;
}
