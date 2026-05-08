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
import type {
  Camera,
  Detection,
  DetectionResult,
  FaceRecord,
  OverlayBox,
  WeaponSummary,
} from "./types";

// Adaptive poll cadence:
//   - Active scene (any signal): 2s for near-real-time bbox updates.
//   - Idle scene (motion gate or quiet): 5s.
// The motion gate already short-circuits idle ticks server-side so we
// can afford 2s on active cameras without proportional cost.
const POLL_MS_ACTIVE = 2000;
const POLL_MS_IDLE = 5000;

const EMPTY_WEAPON: WeaponSummary = {
  decision: "clear",
  suspicious_object_score: 0,
  suspicious_class: null,
  suspicious_count: 0,
  took_ms: 0,
};

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
  /** Phase-4 faces (this tick). */
  faces: FaceRecord[];
  faceStatus: string;
  knownFaceCount: number;
  unknownFaceCount: number;
  /** Phase-6 weapon summary (always present — zeroed when sidecar down). */
  weapon: WeaponSummary;
  weaponStatus: string;
  /** Phase-8 motion gate — true when this tick was a cached replay. */
  gated: boolean;
  gateReason: string | null;
  cachedAgeMs: number | null;
  /** Phase-9 unified overlay (face + weapon real-CV boxes). */
  boxes: OverlayBox[];
  tickAt: number | null;
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
  faces: [],
  faceStatus: "ok",
  knownFaceCount: 0,
  unknownFaceCount: 0,
  weapon: EMPTY_WEAPON,
  weaponStatus: "ok",
  gated: false,
  gateReason: null,
  cachedAgeMs: null,
  boxes: [],
  tickAt: null,
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
    let nextDelayMs = POLL_MS_IDLE;

    const tick = async () => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        timer = setTimeout(tick, POLL_MS_IDLE);
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
          // Pick the next poll delay based on what the server returned.
          // Anything that looks like a real signal (non-normal severity,
          // any overlay box, unknown face, suspicious weapon, gate not
          // engaged) → speed up. Otherwise idle cadence.
          const hasSignal =
            (d.severity && d.severity !== "normal") ||
            ((d.boxes ?? []).length > 0) ||
            (d.unknown_face_count ?? 0) > 0 ||
            d.weapon?.decision === "suspicious";
          nextDelayMs = !d.gated && hasSignal ? POLL_MS_ACTIVE : POLL_MS_IDLE;
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
            faces: d.faces ?? [],
            faceStatus: d.face_status ?? "ok",
            knownFaceCount: d.known_face_count ?? 0,
            unknownFaceCount: d.unknown_face_count ?? 0,
            weapon: d.weapon ?? EMPTY_WEAPON,
            weaponStatus: d.weapon_status ?? "ok",
            gated: Boolean(d.gated),
            gateReason: d.gate_reason ?? null,
            cachedAgeMs: typeof d.cached_age_ms === "number" ? d.cached_age_ms : null,
            boxes: d.boxes ?? [],
            tickAt: typeof d.tickAt === "number" ? d.tickAt : Date.now(),
          });
        }
      } catch {
        // Swallow transient errors; the next tick will try again.
      } finally {
        if (!cancelled) timer = setTimeout(tick, nextDelayMs);
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
