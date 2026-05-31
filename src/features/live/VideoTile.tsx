// Video tile: video element OR snapshot image, plus canvas overlay + HUD chrome.
//
// UX principle: the only user-visible status states are "playing" and "error".
// Everything else (idle, connecting, negotiating, reconnecting, closed) is
// collapsed into a single soft "Connecting…" affordance with the last known
// frame still visible underneath. Don't surface raw state names.

import { useEffect, useRef, useState } from "react";
import type {
  AgentStatus,
  Camera,
  DetectionResult,
  FaceRecord,
  StreamMode,
  WeaponSummary,
} from "./types";
import { useMseStream } from "./useMseStream";
import { useDetections } from "./useDetections";
import { useTracker, type TrackedBox } from "./useTracker";
import { useHlsPlayer } from "./useHlsPlayer";
import type { PlaybackMode } from "./playbackMode";
import { LIVE_MODE } from "./playbackMode";

export type VideoTileProps = {
  cam: Camera | null;
  mode: StreamMode;
  agentStatus: AgentStatus | null;
  /** Live vs past-playback intent. Defaults to live. */
  playback?: PlaybackMode;
  /** Called when HLS playback advances naturally so the parent can
   *  scroll the timeline cursor in sync. */
  onPastCursorAdvance?: (ms: number) => void;
  /** Test seam: inject hls.js to avoid network imports. */
  hlsModule?: typeof import("hls.js");
};

export function VideoTile({
  cam,
  mode,
  agentStatus,
  playback = LIVE_MODE,
  onPastCursorAdvance,
  hlsModule,
}: VideoTileProps) {
  const isPast = playback.kind === "past";
  const [imgUrl, setImgUrl] = useState<string>("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [snapError, setSnapError] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Live data sources — disabled when scrubbing the past. Disabling
  // them tears down the WebSocket / polling timers cleanly.
  const live = useMseStream(cam?.name ?? null, mode === "live" && !isPast);
  const det = useDetections(isPast ? null : cam);
  const trk = useTracker(isPast ? null : cam);

  // Past playback (HLS). Source URL is null in live mode so the hook
  // sits idle and doesn't poke at the <video>.
  const pastSrc =
    isPast && cam
      ? `/api/agent/timeline/${encodeURIComponent(cam.name)}/hls/master.m3u8?start_ms=${playback.startMs}&end_ms=${playback.endMs}`
      : null;
  const past = useHlsPlayer({
    src: pastSrc,
    windowStartMs: isPast ? playback.startMs : 0,
    autoPlay: true,
    hlsModule,
  });

  // Cursor synchronization between parent state (playback.cursorMs)
  // and the HLS <video> element. Two flows that must not feed back
  // into each other:
  //
  //  Down (parent → video): when the user drags the scrubber, the
  //    parent's cursorMs changes; we seek the video to match. Debounced
  //    so a fast drag doesn't thrash segment loads.
  //
  //  Up (video → parent): during natural playback the video's
  //    currentMs advances on its own; we emit those values back to the
  //    parent so the scrubber follows the playhead.
  //
  // Earlier we shared a single `cursorRef` between the two effects and
  // it produced a snap-back race: while a seek was still pending, the
  // upward-emit effect saw `currentMs == windowStartMs` (way behind
  // the seek target), reported THAT to the parent, and the parent
  // promptly told us to seek BACK to the start. Fix is to keep the
  // two refs separate AND only trust upward emits once the player
  // reports `status === "playing"` past the most-recent seek target.
  const lastSeekTargetRef = useRef<number | null>(null);
  const lastEmittedMsRef = useRef<number>(0);
  const seekTimerRef = useRef<number | null>(null);

  const targetCursorMs = playback.kind === "past" ? playback.cursorMs : null;

  useEffect(() => {
    if (!isPast || targetCursorMs == null) return;
    if (
      lastSeekTargetRef.current != null &&
      Math.abs(lastSeekTargetRef.current - targetCursorMs) < 50
    ) {
      return;
    }
    lastSeekTargetRef.current = targetCursorMs;
    if (seekTimerRef.current != null) {
      window.clearTimeout(seekTimerRef.current);
    }
    seekTimerRef.current = window.setTimeout(() => {
      seekTimerRef.current = null;
      past.seekToMs(targetCursorMs);
    }, 120);
    return () => {
      if (seekTimerRef.current != null) {
        window.clearTimeout(seekTimerRef.current);
        seekTimerRef.current = null;
      }
    };
  }, [isPast, targetCursorMs, past.seekToMs]);

  useEffect(() => {
    if (!isPast || !onPastCursorAdvance) return;
    // Don't emit while the pipeline is loading or paused; the
    // currentMs we'd read is stale (typically pinned to
    // windowStartMs) and would yank the parent's cursor backwards.
    if (past.status !== "playing") return;
    const cur = past.currentMs;
    if (Math.abs(cur - lastEmittedMsRef.current) < 250) return;
    // Suppress upstream emits that would move the cursor BACKWARD
    // past the user's most recent seek target. That's the exact
    // signature of a not-yet-completed seek.
    if (
      lastSeekTargetRef.current != null &&
      cur < lastSeekTargetRef.current - 500
    ) {
      return;
    }
    lastEmittedMsRef.current = cur;
    onPastCursorAdvance(cur);
  }, [isPast, past.currentMs, past.status, onPastCursorAdvance]);

  // Snapshot polling: 1Hz, cache-busted via ?t= (only in live snapshot mode)
  useEffect(() => {
    if (!cam || mode !== "snapshot" || isPast) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const t0 = performance.now();
      const url = `/api/cam/snapshot/${encodeURIComponent(cam.name)}?h=720&t=${Date.now()}`;
      const probe = new Image();
      probe.onload = () => {
        if (cancelled) return;
        setImgUrl(url);
        setLatencyMs(Math.round(performance.now() - t0));
        setSnapError(null);
        timer = setTimeout(tick, 1000);
      };
      probe.onerror = () => {
        if (cancelled) return;
        setSnapError("snapshot failed");
        timer = setTimeout(tick, 2000);
      };
      probe.src = url;
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cam, mode, isPast]);

  // HUD clock
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Canvas overlay — AR-aware + tracker-driven.
  //
  // Box sources (can compose):
  //   1. Tracker WS — person/object boxes at ~5Hz.
  //   2. Detection poll — face boxes (always layered when present) plus
  //      weapon/face fallback when the tracker is offline.
  //
  // AR-aware: the displayed video has `object-contain`, so when source
  // AR ≠ tile AR there are letterbox/pillarbox bars. We compute the
  // ACTUAL displayed video rect using videoWidth/videoHeight (live) or
  // naturalWidth/naturalHeight (snapshot) and project all bboxes into
  // that rect — never into the tile/letterbox area.
  //
  // Stale-fade: tracker payloads supersede each other every 200ms, so
  // we fade based on (now - tickAt). If the WS goes silent, boxes
  // gracefully decay over 1.5s instead of sticking around looking real.
  useEffect(() => {
    const canvas = canvasRef.current;
    const target: HTMLElement | null = isPast
      ? past.videoRef.current
      : mode === "live"
      ? live.videoRef.current
      : imgRef.current;
    if (!canvas || !target) return;

    // COCO-class palette. Picked to be distinct against typical security
    // camera scenes (mostly browns, asphalt, foliage).
    const colorForClass = (label: string): string => {
      if (label === "person") return "110, 231, 183";          // emerald-300
      if (["car","truck","bus","motorcycle","bicycle"].includes(label)) return "96, 165, 250"; // blue-400
      if (["dog","cat","bird","horse","sheep","cow"].includes(label)) return "251, 191, 36";   // amber-400
      if (["backpack","handbag","suitcase","umbrella"].includes(label)) return "192, 132, 252"; // purple-400
      return "148, 163, 184"; // slate-400 fallback
    };

    // Polling fallback styling — used only when tracker is offline.
    const FALLBACK_STYLE: Record<string, string> = {
      face_known: "110, 231, 183",
      face_unknown: "251, 191, 36",
      weapon_suspicious: "248, 113, 113",
      weapon_clear: "148, 163, 184",
    };

    const BOX_FADE_MS = 1500;
    const BOX_MAX_AGE_MS = 2500;

    let raf = 0;

    type DrawBox = {
      rgb: string;          // "R, G, B" string for color composition
      bbox: [number, number, number, number];
      label: string;
      ts: number;           // when the upstream produced it
      lineWidth?: number;
      dashed?: boolean;
    };

    const FACE_SOURCES = new Set(["face_known", "face_unknown"]);

    const computeDisplayedRect = (): { rectX: number; rectY: number; rectW: number; rectH: number; w: number; h: number } | null => {
      const w = target.clientWidth;
      const h = target.clientHeight;
      if (!w || !h) return null;
      let srcW = 0;
      let srcH = 0;
      if (target instanceof HTMLVideoElement) {
        srcW = target.videoWidth || 0;
        srcH = target.videoHeight || 0;
      } else if (target instanceof HTMLImageElement) {
        srcW = target.naturalWidth || 0;
        srcH = target.naturalHeight || 0;
      }
      let rectX = 0, rectY = 0, rectW = w, rectH = h;
      if (srcW > 0 && srcH > 0) {
        const tileAR = w / h;
        const srcAR = srcW / srcH;
        if (srcAR > tileAR) {
          rectW = w;
          rectH = Math.round(w / srcAR);
          rectY = Math.round((h - rectH) / 2);
        } else if (srcAR < tileAR) {
          rectH = h;
          rectW = Math.round(h * srcAR);
          rectX = Math.round((w - rectW) / 2);
        }
      }
      return { rectX, rectY, rectW, rectH, w, h };
    };

    const draw = () => {
      const rect = computeDisplayedRect();
      if (!rect) return;
      const { rectX, rectY, rectW, rectH, w, h } = rect;

      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // In past playback, the only overlay we draw is the active
      // match's pink probe bbox (when the cursor is within ±500ms of
      // its ts_ms). Tracker/detection feeds are paused.
      let drawBoxes: DrawBox[] = [];
      if (isPast) {
        const am = playback.kind === "past" ? playback.activeMatch : null;
        if (am?.bbox && Math.abs(past.currentMs - am.ts_ms) < 500) {
          drawBoxes = [{
            rgb: "244, 114, 182",
            bbox: am.bbox,
            label: am.person_name
              ? `${am.person_name} ${(am.similarity * 100).toFixed(0)}%`
              : `match ${(am.similarity * 100).toFixed(0)}%`,
            ts: Date.now(),
            lineWidth: 2,
          }];
        }
      } else {
        const useTracker = trk.status === "open" && trk.tickAt != null;
        const trackerBoxes: DrawBox[] = useTracker
          ? trk.tracks.map((t: TrackedBox) => ({
              rgb: colorForClass(t.label),
              bbox: t.bbox,
              label: `${t.label} #${t.id} ${t.conf.toFixed(2)}`,
              ts: trk.tickAt ?? Date.now(),
              lineWidth: 2,
            }))
          : [];
        const faceBoxes: DrawBox[] = det.boxes
          .filter((b) => FACE_SOURCES.has(b.source))
          .map((b) => ({
            rgb: b.source === "face_known" ? "56, 189, 248" : "251, 191, 36",
            bbox: b.bbox,
            label: b.confidence > 0 ? `${b.label} ${b.confidence.toFixed(2)}` : b.label,
            ts: b.ts,
            lineWidth: 1,
            dashed: true,
          }));
        drawBoxes = useTracker
          ? [...trackerBoxes, ...faceBoxes]
          : det.boxes.map((b) => ({
              rgb: FALLBACK_STYLE[b.source] ?? "148, 163, 184",
              bbox: b.bbox,
              label: b.confidence > 0 ? `${b.label} ${b.confidence.toFixed(2)}` : b.label,
              ts: b.ts,
            }));
      }
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textBaseline = "top";

      const nowTs = Date.now();
      let anyAlive = false;
      for (const b of drawBoxes) {
        const ageMs = Math.max(0, nowTs - (b.ts ?? 0));
        if (ageMs > BOX_MAX_AGE_MS) continue;
        const alpha = ageMs <= BOX_FADE_MS ? 1 - (ageMs / BOX_FADE_MS) * 0.85 : 0.15;
        if (alpha < 0.1) continue;
        anyAlive = true;
        const stroke = `rgba(${b.rgb}, ${alpha.toFixed(2)})`;
        const fill = `rgba(${b.rgb}, ${(alpha * 0.16).toFixed(2)})`;
        const chip = `rgba(0, 0, 0, ${(alpha * 0.85).toFixed(2)})`;
        const chipText = `rgba(${b.rgb}, ${alpha.toFixed(2)})`;

        const [x, y, ww, hh] = b.bbox;
        const rx = rectX + x * rectW;
        const ry = rectY + y * rectH;
        const rw = ww * rectW;
        const rh = hh * rectH;
        ctx.lineWidth = b.lineWidth ?? 1.5;
        if (b.dashed) ctx.setLineDash([4, 3]);
        else ctx.setLineDash([]);
        ctx.strokeStyle = stroke;
        ctx.fillStyle = fill;
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.setLineDash([]);
        const textW = ctx.measureText(b.label).width + 8;
        const chipH = 16;
        const chipY = Math.max(rectY, ry - chipH);
        ctx.fillStyle = chip;
        ctx.fillRect(rx, chipY, textW, chipH);
        ctx.fillStyle = chipText;
        ctx.fillText(b.label, rx + 4, chipY + 3);
      }

      // Keep the RAF loop alive only while we have something to fade.
      // When the tracker is connected and ticking at 5Hz, this loop is
      // effectively driven by message arrivals (re-running this effect)
      // rather than rAF.
      if (anyAlive) raf = requestAnimationFrame(draw);
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(target);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    trk.tracks, trk.tickAt, trk.status,
    det.boxes, det.tickAt,
    imgUrl, mode, live.status,
    isPast, past.currentMs, playback,
  ]);

  const camLabel = cam ? cam.label : "—";
  const wireName = cam ? cam.name : "";
  const ts = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");

  // ---- HUD label rules ----
  // In past mode we surface a wall-clock playhead so the operator
  // reads timestamps the same way they would on a live cam (not
  // 50:10/59:16 "elapsed/total").
  const pastInstantMs =
    past.currentMs || (playback.kind === "past" ? playback.cursorMs : Date.now());
  const pastInstant = new Date(pastInstantMs);
  const pastTimeStr = pastInstant.toLocaleTimeString(undefined, { hour12: false });
  const pastDateStr = pastInstant.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "2-digit",
  });
  const hudRight = isPast
    ? `${past.status === "playing" ? "▶" : past.status === "paused" ? "⏸" : past.status}`
    : mode === "live"
      ? `${ts} · ${live.status === "playing" ? `${live.bitrateKbps}kbps` : "connecting…"}`
      : `${ts} · ${latencyMs != null ? `${latencyMs}ms` : "…"}`;

  // ---- Center overlay rules ----
  // Only show explicit "error" copy. Everything else is a single calm "Connecting…".
  const showCenterOverlay = isPast
    ? past.status === "loading" || past.status === "error"
    : mode === "live" && live.status !== "playing";
  // Session-expired is a SPECIAL playback error: it's recoverable with
  // a single re-login, and we want to surface a clear CTA rather than
  // the cryptic "session_expired" token.
  const isPastSessionExpired = isPast && past.error === "session_expired";
  const overlayText = isPast
    ? isPastSessionExpired
      ? "Session expired — sign in to resume playback"
      : past.status === "error"
        ? `Playback error${past.error ? `: ${past.error}` : ""}`
        : "Loading recording…"
    : live.status === "error"
      ? `Stream error${live.error ? `: ${live.error}` : ""}`
      : "Connecting…";

  // When the past-playback tile errors out, build a quick admin link
  // back to the diagnose endpoint for THIS exact window. The user can
  // click it to see the raw upstream response.
  const diagnoseHref =
    isPast && cam && playback.kind === "past"
      ? `/api/agent/timeline/${encodeURIComponent(cam.name)}/diagnose?start_ms=${playback.startMs}&end_ms=${playback.endMs}`
      : null;

  return (
    <div className="relative" ref={wrapRef}>
      <div className="relative aspect-video overflow-hidden border border-border bg-black">
        {isPast ? (
          // muted + autoplay so the browser actually plays without a
          // user gesture. Without `muted` Chrome blocks autoplay and
          // the tile sits paused even though loading completed.
          //
          // No native `controls` here on purpose: the default video
          // chrome shows "50:10/59:16" elapsed-from-playlist-start,
          // which is meaningless against the wall-clock timeline
          // the operator is actually navigating. We render our own
          // wall-clock chrome + click-to-toggle overlay below.
          <video
            ref={past.videoRef}
            autoPlay
            muted
            playsInline
            preload="auto"
            onClick={past.togglePlay}
            className="h-full w-full object-contain select-none cursor-pointer"
            data-testid="past-video"
          />
        ) : mode === "live" ? (
          <video
            ref={live.videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-contain select-none pointer-events-none"
          />
        ) : imgUrl ? (
          <img
            ref={imgRef}
            src={imgUrl}
            alt={`Live snapshot from ${wireName}`}
            className="h-full w-full object-contain select-none pointer-events-none"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {snapError ?? "Connecting…"}
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />

        {showCenterOverlay && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div
              className={`max-w-[80%] px-4 py-3 font-mono text-xs tracking-widest ${
                isPastSessionExpired
                  ? "bg-amber-950/90 text-amber-100 border border-amber-400/60"
                  : (isPast && past.status === "error") ||
                      (!isPast && live.status === "error")
                    ? "bg-red-950/85 text-red-200 border border-red-500/60"
                    : "bg-black/70 text-foreground/85"
              }`}
            >
              <div className="text-center uppercase">{overlayText}</div>
              {isPastSessionExpired && (
                <a
                  href="/admin/login"
                  className="mt-2 block text-center text-[10px] underline-offset-2 hover:underline text-amber-100"
                  data-testid="session-expired-signin"
                >
                  Sign in →
                </a>
              )}
              {isPast && past.status === "error" && !isPastSessionExpired && diagnoseHref && (
                <a
                  href={diagnoseHref}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 block text-center text-[10px] underline-offset-2 hover:underline text-red-100"
                  data-testid="diagnose-link"
                >
                  open /diagnose for raw upstream info ↗
                </a>
              )}
            </div>
          </div>
        )}

        {/* Past-playback wall-clock overlay.
            Rendered as a security-camera-style timestamp burn-in at
            the bottom-center of the tile. This is the clock the
            operator actually cares about — the wall time of the
            recorded moment they're looking at. */}
        {isPast && (
          <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 flex items-baseline gap-2.5 bg-black/70 px-3 py-1.5 font-mono tabular-nums text-foreground/95 backdrop-blur-sm border border-fuchsia-500/30">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                past.status === "playing"
                  ? "bg-fuchsia-400 animate-pulse"
                  : past.status === "paused"
                    ? "bg-amber-400"
                    : "bg-foreground/40"
              }`}
            />
            <span className="text-[10px] uppercase tracking-[0.18em] text-fuchsia-300/80">REC</span>
            <span className="text-base">{pastTimeStr}</span>
            <span className="text-[10px] uppercase tracking-[0.18em] text-foreground/55">
              {pastDateStr}
            </span>
          </div>
        )}

        {/* HUD chrome */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
          <div className="flex items-center gap-2 bg-black/65 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                isPast
                  ? "bg-fuchsia-400"
                  : mode === "live" && live.status !== "playing"
                    ? "bg-amber-400"
                    : "bg-red-500 animate-pulse"
              }`}
            />
            {isPast ? "PAST · AURORAVIEW" : mode === "live" ? "LIVE-MSE · AURORAVIEW" : "LIVE · AURORAVIEW"}
          </div>
          <div className="flex items-center gap-2">
            {/* Tracker WS status pill — green dot+count when streaming,
                amber while connecting/reconnecting, hidden when idle. */}
            {trk.status !== "idle" && (
              <div
                className="bg-black/65 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-foreground/85"
                title={
                  trk.status === "open"
                    ? `Tracker ${trk.tracks.length} active · ${trk.tookMs?.total ?? "—"}ms`
                    : `Tracker ${trk.status}${trk.error ? ": " + trk.error : ""}`
                }
              >
                <span
                  className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${
                    trk.status === "open"
                      ? "bg-emerald-400"
                      : trk.status === "error" || trk.status === "closed"
                      ? "bg-red-500"
                      : "bg-amber-400 animate-pulse"
                  }`}
                />
                TRK{trk.status === "open" ? ` · ${trk.tracks.length}` : ""}
              </div>
            )}
            <div className="bg-black/65 px-2.5 py-1 font-mono text-[10px] tracking-widest text-foreground/85">
              {hudRight}
            </div>
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-3">
          <div className="bg-black/65 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground">
            {camLabel}
            {cam && cam.label !== cam.name && (
              <span className="ml-2 text-muted-foreground">({wireName})</span>
            )}
          </div>
          <div className="bg-black/65 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-foreground/85">
            {visionLabel(det.status, det.detections.length)}
          </div>
        </div>

        {/* Tier badge — bottom-left, just above the camera label.
            When the motion gate is active (cached replay, no paid work
            this tick), we collapse to a single "GATED" pill so the
            operator can see the savings happening in real time. */}
        {det.gated ? (
          <div
            className="pointer-events-none absolute left-3 bottom-12 flex items-center gap-1.5 bg-black/65 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-emerald-300/85"
            title={`Idle gate active · cached ${Math.round((det.cachedAgeMs ?? 0) / 1000)}s ago · ${det.gateReason ?? ""}`}
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400/60" />
            <span>GATED</span>
            <span className="ml-1 text-foreground/55 normal-case tracking-normal">
              {Math.round((det.cachedAgeMs ?? 0) / 1000)}s cache
            </span>
          </div>
        ) : (
          <div
            className="pointer-events-none absolute left-3 bottom-12 flex items-center gap-1.5 bg-black/65 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-foreground/85"
            title={det.escalationReason ? `router: ${det.escalationReason}` : "router: idle"}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                det.status === "ok" ? severityDotColor(det.severity) : "bg-foreground/30"
              }`}
              title={`T2 local · severity=${det.severity ?? "—"}`}
            />
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                det.escalationRan
                  ? "bg-emerald-400"
                  : det.tier === "T2-cached-T3"
                  ? "ring-1 ring-emerald-400/60 bg-emerald-400/30"
                  : "bg-foreground/30"
              }`}
              title="T3 cloud · gpt-4o-mini"
            />
            <span className="ml-1 text-foreground/70">{det.tier ?? "—"}</span>
          </div>
        )}
      </div>

      {/* Phase-4/6 status strip: face recognizer + weapon detector summary
          for this tick. Always rendered when vision is on so the operator
          can confirm the specialist sidecars are alive even on quiet frames. */}
      {det.status === "ok" && (
        <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] uppercase tracking-widest">
          <FaceBadge
            status={det.faceStatus}
            knownCount={det.knownFaceCount}
            unknownCount={det.unknownFaceCount}
            faces={det.faces}
          />
          <WeaponBadge status={det.weaponStatus} weapon={det.weapon} />
        </div>
      )}

      {/* T2 scene caption — what the local agent independently thinks is
          going on. Severity colour: amber=notable, red=critical. */}
      {det.localScene && det.status === "ok" && (
        <p
          className={`mt-2 font-mono text-[11px] tracking-wider ${
            det.severity === "critical"
              ? "text-red-400"
              : det.severity === "notable"
              ? "text-amber-300"
              : "text-foreground/75"
          }`}
        >
          <span className="text-foreground/50 mr-1.5">T2-LOCAL ▸</span>
          {det.localScene}
          {det.alertType && (
            <span className="ml-2 text-foreground/45">[{det.alertType}]</span>
          )}
        </p>
      )}

      {det.summary && det.status === "ok" && det.summary !== det.localScene && (
        <p className="mt-1 font-mono text-[11px] tracking-wider text-foreground/80">
          <span className="text-alert">▸</span> {det.summary}
          {det.tier === "T2-cached-T3" && typeof det.t3AgeMs === "number" && (
            <span className="ml-2 text-foreground/35">[T3 cached {Math.round(det.t3AgeMs / 1000)}s ago]</span>
          )}
        </p>
      )}
      {!agentStatus?.chat_configured && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Vision overlay disabled until OPENAI_API_KEY is set on the server.
        </p>
      )}
    </div>
  );
}

function visionLabel(status: DetectionResult["status"] | null, count: number): string {
  if (status === "ok") return `${count} detection${count === 1 ? "" : "s"}`;
  if (status === "vision_disabled") return "Vision: key not set";
  if (status === "error") return "Vision: error";
  return "Vision: …";
}

function severityDotColor(sev: DetectionResult["severity"] | null | undefined): string {
  if (sev === "critical") return "bg-red-500 animate-pulse";
  if (sev === "notable") return "bg-amber-300";
  return "bg-emerald-400";
}

/**
 * FACES badge — Phase-4 surface.
 *   ok + 0/0          → dim (no faces in frame, system healthy)
 *   ok + N known      → emerald
 *   ok + any unknown  → amber, with names of any matches
 *   error             → red, "engine offline"
 */
function FaceBadge({
  status,
  knownCount,
  unknownCount,
  faces,
}: {
  status: string;
  knownCount: number;
  unknownCount: number;
  faces: FaceRecord[];
}) {
  if (status !== "ok") {
    return (
      <span className="flex items-center gap-1.5 bg-card/40 border border-border/60 px-2 py-1 text-alert/80">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-alert" />
        Faces · engine offline
      </span>
    );
  }
  const total = knownCount + unknownCount;
  const dotClass =
    unknownCount > 0
      ? "bg-amber-400"
      : knownCount > 0
      ? "bg-emerald-400"
      : "bg-foreground/30";
  const knownNames = faces
    .filter((f) => f.decision === "match" && f.person_name)
    .map((f) => f.person_name)
    .filter((v, i, arr): v is string => Boolean(v) && arr.indexOf(v) === i);
  const label =
    total === 0
      ? "no faces"
      : `${knownCount} known · ${unknownCount} unknown`;
  return (
    <span
      className={`flex items-center gap-1.5 bg-card/40 border border-border/60 px-2 py-1 ${
        unknownCount > 0 ? "text-amber-200" : "text-foreground/85"
      }`}
      title={
        knownNames.length
          ? `Known: ${knownNames.join(", ")}`
          : total === 0
          ? "No faces detected this tick"
          : "Faces present"
      }
    >
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dotClass}`} />
      Faces · {label}
      {knownNames.length > 0 && (
        <span className="ml-1 text-foreground/60 normal-case tracking-normal">
          ({knownNames.join(", ")})
        </span>
      )}
    </span>
  );
}

/**
 * WEAPON badge — Phase-6 surface.
 *   ok + clear      → dim, "clear"
 *   ok + suspicious → red, pulsing, with class + score
 *   error           → red outline, "engine offline"
 */
function WeaponBadge({
  status,
  weapon,
}: {
  status: string;
  weapon: WeaponSummary;
}) {
  if (status !== "ok") {
    return (
      <span className="flex items-center gap-1.5 bg-card/40 border border-border/60 px-2 py-1 text-alert/80">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-alert" />
        Weapon · engine offline
      </span>
    );
  }
  const isSuspicious = weapon.decision === "suspicious";
  if (!isSuspicious) {
    return (
      <span
        className="flex items-center gap-1.5 bg-card/40 border border-border/60 px-2 py-1 text-foreground/70"
        title={`Last scan ${weapon.took_ms}ms · score ${weapon.suspicious_object_score.toFixed(2)}`}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/30" />
        Weapon · clear
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-1.5 bg-red-950/60 border border-red-500/70 px-2 py-1 text-red-200"
      title={`score ${weapon.suspicious_object_score.toFixed(2)} · ${weapon.suspicious_count} object(s) · escalated to T3`}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
      Weapon · suspicious
      {weapon.suspicious_class && (
        <span className="ml-1 text-red-100">[{weapon.suspicious_class}]</span>
      )}
      <span className="ml-1 text-red-300/80">
        {Math.round(weapon.suspicious_object_score * 100)}%
      </span>
    </span>
  );
}
