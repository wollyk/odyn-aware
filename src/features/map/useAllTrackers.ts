// Phase-13B: fan-in tracker WebSockets across every camera placed on
// the map.
//
// useTracker subscribes to one camera. The map needs N parallel
// subscriptions and a unified projected-dot list. Rather than mounting
// N <Tracker> components and hoisting state, we keep all the
// subscriptions inside one hook so the consumer just gets back a flat
// projected-dots array.
//
// Subscription lifecycle:
//   - One WebSocket per (cameraName, image w/h) tuple. The tuple is
//     used as a React key so adding/removing/renaming a camera on the
//     map opens/closes exactly that WS.
//   - Each WS replaces its camera's slot in a ref-held tracks map.
//   - We coalesce render updates into a microtask so a burst of WS
//     messages doesn't trigger N renders.
//   - On unmount, every WS gets a .close().
//
// Auth: same as useTracker — the WS proxy gates on the admin session
// cookie via /api/tracker/<camera>.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CameraPlacement } from "./types";
import {
  projectTrackToMap,
  type ProjectedDot,
  type TrackInput,
} from "./projection";

/** What useAllTrackers exposes. */
export type AllTrackersResult = {
  /** Flat list of all currently-known projected dots, freshest only.
   *  Caller is responsible for filtering by motion / staleness etc. */
  dots: ProjectedDot[];
  /** Per-camera image dims (latest tick). Useful for projection if it
   *  ever needs raw pixel coords. */
  imageSizes: Record<string, { w: number; h: number; tickAt: number }>;
  /** Per-camera connection status badge ("open" / "reconnecting" /...) */
  cameraStatus: Record<string, string>;
};

const EMPTY: AllTrackersResult = { dots: [], imageSizes: {}, cameraStatus: {} };
const STALE_AFTER_MS = 4_000; // dot disappears if no fresh tick within this

type CameraSlot = {
  ws: WebSocket | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoff: number;
  status: string;
  tickAt: number;
  imageW: number | null;
  imageH: number | null;
  tracks: TrackInput[];
};

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;

export function useAllTrackers(
  placements: CameraPlacement[],
  scaleMperPx: number | null,
): AllTrackersResult {
  const [result, setResult] = useState<AllTrackersResult>(EMPTY);
  // Slots are kept in a ref so message handlers don't fight React's
  // batching. We push to setResult via a debounced microtask.
  const slotsRef = useRef<Map<string, CameraSlot>>(new Map());
  const aliveRef = useRef(true);
  const renderPendingRef = useRef(false);
  const placementsRef = useRef(placements);
  placementsRef.current = placements;
  const scaleRef = useRef(scaleMperPx);
  scaleRef.current = scaleMperPx;

  // ----- render coalescer -------------------------------------------------
  const scheduleRender = () => {
    if (renderPendingRef.current) return;
    renderPendingRef.current = true;
    queueMicrotask(() => {
      renderPendingRef.current = false;
      if (!aliveRef.current) return;
      const slots = slotsRef.current;
      const placementsByName = new Map(
        placementsRef.current.map((p) => [p.name, p] as const),
      );
      const now = Date.now();
      const dots: ProjectedDot[] = [];
      const imageSizes: Record<string, { w: number; h: number; tickAt: number }> = {};
      const cameraStatus: Record<string, string> = {};
      for (const [name, slot] of slots.entries()) {
        cameraStatus[name] = slot.status;
        if (slot.imageW && slot.imageH) {
          imageSizes[name] = {
            w: slot.imageW,
            h: slot.imageH,
            tickAt: slot.tickAt,
          };
        }
        if (now - slot.tickAt > STALE_AFTER_MS) continue;
        const placement = placementsByName.get(name);
        if (!placement) continue;
        for (const t of slot.tracks) {
          const proj = projectTrackToMap(placement, t, scaleRef.current);
          if (proj) dots.push(proj);
        }
      }
      setResult({ dots, imageSizes, cameraStatus });
    });
  };

  // ----- subscription manager --------------------------------------------
  useEffect(() => {
    aliveRef.current = true;
    const slots = slotsRef.current;

    const ensureSlot = (name: string) => {
      let slot = slots.get(name);
      if (slot) return slot;
      slot = {
        ws: null,
        reconnectTimer: null,
        backoff: INITIAL_BACKOFF_MS,
        status: "idle",
        tickAt: 0,
        imageW: null,
        imageH: null,
        tracks: [],
      };
      slots.set(name, slot);
      connect(name);
      return slot;
    };

    const connect = (name: string) => {
      const slot = slots.get(name);
      if (!slot || !aliveRef.current) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${location.host}/api/tracker/${encodeURIComponent(name)}`;
      slot.status =
        slot.backoff === INITIAL_BACKOFF_MS ? "connecting" : "reconnecting";
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect(name);
        return;
      }
      slot.ws = ws;
      ws.onopen = () => {
        if (!aliveRef.current) return;
        slot.backoff = INITIAL_BACKOFF_MS;
        slot.status = "open";
        scheduleRender();
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
          slot.status = "open";
          scheduleRender();
          return;
        }
        const tracks = Array.isArray(p.tracks)
          ? (p.tracks as TrackInput[])
          : [];
        slot.tracks = tracks;
        slot.tickAt = typeof p.tick_at === "number" ? p.tick_at : Date.now();
        slot.imageW = typeof p.image_w === "number" ? p.image_w : slot.imageW;
        slot.imageH = typeof p.image_h === "number" ? p.image_h : slot.imageH;
        scheduleRender();
      };
      ws.onerror = () => {
        slot.status = "error";
        scheduleRender();
      };
      ws.onclose = () => {
        slot.ws = null;
        if (!aliveRef.current) return;
        scheduleReconnect(name);
      };
    };

    const scheduleReconnect = (name: string) => {
      const slot = slots.get(name);
      if (!slot || !aliveRef.current) return;
      if (slot.reconnectTimer) return;
      const jitter = Math.random() * 250;
      const delay = Math.min(MAX_BACKOFF_MS, slot.backoff) + jitter;
      slot.backoff = Math.min(MAX_BACKOFF_MS, slot.backoff * 2);
      slot.status = "reconnecting";
      slot.reconnectTimer = setTimeout(() => {
        if (!slots.get(name)) return;
        slot.reconnectTimer = null;
        connect(name);
      }, delay);
      scheduleRender();
    };

    const closeSlot = (name: string) => {
      const slot = slots.get(name);
      if (!slot) return;
      if (slot.reconnectTimer) clearTimeout(slot.reconnectTimer);
      try {
        slot.ws?.close();
      } catch {
        /* ignore */
      }
      slots.delete(name);
    };

    // Diff placements → ensure/close slots. We key only on `name` —
    // changes to pose just affect projection, not the subscription.
    const wantedNames = new Set(placements.map((p) => p.name));
    for (const n of wantedNames) ensureSlot(n);
    for (const n of Array.from(slots.keys())) {
      if (!wantedNames.has(n)) closeSlot(n);
    }
    scheduleRender();

    return () => {
      aliveRef.current = false;
      for (const n of Array.from(slots.keys())) closeSlot(n);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements.map((p) => p.name).sort().join("|")]);

  // Re-project on pose / scale change without tearing down WSes.
  useEffect(() => {
    scheduleRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements, scaleMperPx]);

  // Periodic re-tick so dots fade out when their camera goes silent.
  useEffect(() => {
    const t = setInterval(() => {
      if (aliveRef.current) scheduleRender();
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useMemo(() => result, [result]);
}
