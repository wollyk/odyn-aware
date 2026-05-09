// Live object tracker — WebSocket subscription to the tracker sidecar.
//
// Why this is a separate hook from useDetections:
//   - useDetections polls /api/agent/detections every 2-5s for the
//     narration / face / weapon / severity surfaces. Those are slow,
//     expensive signals that come from VLMs and don't need real-time
//     cadence.
//   - useTracker subscribes to a WebSocket fed by the persistent
//     YOLOv8s + ByteTrack loop, getting per-frame tracker state at ~5Hz.
//     This is what drives the canvas overlay (tight, ID-stable, real-CV
//     bounding boxes).
//
// Reconnect strategy: exponential backoff with jitter, capped at 10s.
// Browser-tab hidden: WS stays open passively (the server-side loop is
// reference-counted, so we'd lose our slot in the grace window if we
// closed). On hidden, we just stop calling setState to avoid React
// renders the user can't see.
//
// Auth: the backend WS proxy (`/api/tracker/<camera>`) checks the
// admin session cookie before upgrading. No token to manage in the
// browser — the cookie travels with the WS handshake automatically.

import { useEffect, useRef, useState } from "react";
import type { Camera } from "./types";

/** A single tracked object on a single tick. */
export type TrackedBox = {
  /** Persistent integer ID assigned by ByteTrack. Same object across
   *  frames keeps the same id; new objects get fresh ids. Useful for
   *  stable-keyed React lists and for tagging events. */
  id: number;
  /** COCO label (lowercase). e.g. "person", "car", "dog". */
  label: string;
  /** Detector confidence 0..1. */
  conf: number;
  /** Normalized [x, y, w, h] in 0..1 of the source frame. */
  bbox: [number, number, number, number];
  /** Phase-11A motion classification:
   *   - "moving"  → IoU(newest, oldest) below static threshold
   *   - "static"  → IoU stayed high → object hasn't moved
   *   - "warming" → not enough frames yet to decide
   *  Sidecar may omit this on legacy payloads; default to undefined. */
  motion?: "moving" | "static" | "warming";
  /** Phase-11A VLM verification verdict for static tracks:
   *   - true   → Moondream confirmed the YOLO label
   *   - false  → Moondream rejected (track is suppressed at sidecar, so
   *              this normally won't reach the client)
   *   - null   → static but verdict pending OR moving (skipped VLM) */
  verified?: boolean | null;
};

export type TrackerStatus =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "error"
  | "closed";

export type TrackerTookMs = {
  fetch: number;
  decode: number;
  infer: number;
  total: number;
};

export type UseTrackerResult = {
  status: TrackerStatus;
  tracks: TrackedBox[];
  /** Wall-clock ms when this payload was assembled by the sidecar.
   *  Used by the overlay for stale-fade. */
  tickAt: number | null;
  imageW: number | null;
  imageH: number | null;
  tookMs: TrackerTookMs | null;
  /** Last error message from the sidecar, if any. Cleared on the next
   *  successful tick. */
  error: string | null;
};

const EMPTY: UseTrackerResult = {
  status: "idle",
  tracks: [],
  tickAt: null,
  imageW: null,
  imageH: null,
  tookMs: null,
  error: null,
};

const MAX_BACKOFF_MS = 10_000;
const INITIAL_BACKOFF_MS = 500;

export function useTracker(cam: Camera | null): UseTrackerResult {
  const [state, setState] = useState<UseTrackerResult>(EMPTY);
  // Keep an "alive" flag separate from setState so reconnect logic can
  // bail on unmount without racing.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    if (!cam) {
      setState(EMPTY);
      return;
    }

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoff = INITIAL_BACKOFF_MS;

    const connect = () => {
      if (!aliveRef.current) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/api/tracker/${encodeURIComponent(cam.name)}`;
      setState((s) => ({ ...s, status: backoff === INITIAL_BACKOFF_MS ? "connecting" : "reconnecting" }));
      try {
        ws = new WebSocket(url);
      } catch (err) {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        if (!aliveRef.current) return;
        backoff = INITIAL_BACKOFF_MS;
        setState((s) => ({ ...s, status: "open" }));
      };
      ws.onmessage = (ev) => {
        if (!aliveRef.current) return;
        let payload: unknown;
        try {
          payload = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        } catch {
          return;
        }
        if (!payload || typeof payload !== "object") return;
        const p = payload as Record<string, unknown>;
        if (p.type === "error") {
          setState((s) => ({
            ...s,
            status: "open",
            error: typeof p.error === "string" ? p.error : "tracker_error",
          }));
          return;
        }
        // type === "tick" (or unset for older payloads)
        const tracks = Array.isArray(p.tracks) ? (p.tracks as TrackedBox[]) : [];
        setState({
          status: "open",
          tracks,
          tickAt: typeof p.tick_at === "number" ? p.tick_at : Date.now(),
          imageW: typeof p.image_w === "number" ? p.image_w : null,
          imageH: typeof p.image_h === "number" ? p.image_h : null,
          tookMs: (p.took_ms as TrackerTookMs) ?? null,
          error: null,
        });
      };
      ws.onerror = () => {
        if (!aliveRef.current) return;
        setState((s) => ({ ...s, status: "error" }));
      };
      ws.onclose = () => {
        ws = null;
        if (!aliveRef.current) return;
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (!aliveRef.current) return;
      if (reconnectTimer) return;
      const jitter = Math.random() * 250;
      const delay = Math.min(MAX_BACKOFF_MS, backoff) + jitter;
      backoff = Math.min(MAX_BACKOFF_MS, backoff * 2);
      setState((s) => ({ ...s, status: "reconnecting" }));
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect();

    return () => {
      aliveRef.current = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { ws?.close(); } catch { /* ignore */ }
    };
  }, [cam?.name]);

  return state;
}
