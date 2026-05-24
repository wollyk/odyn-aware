// Past-playback player.
//
// Mounts a <video> driven by useHlsPlayer pointed at the HLS proxy. A
// sibling <canvas> overlays a pink bbox when the playhead is within
// ±500ms of the selectedMatch's ts_ms (purely visual — no detection
// happens client-side).
//
// Wall-clock conversion: useHlsPlayer maps video.currentTime <-> windowStartMs
// for us, so all external props can be in JS Date.now() ms.

import { useEffect, useRef } from "react";
import { useHlsPlayer } from "./useHlsPlayer";
import type { TimelineMatch } from "./useTimelineMatches";

export type PastPlayerProps = {
  camera: string;
  startMs: number;
  endMs: number;
  cursorMs: number;
  selectedMatch: TimelineMatch | null;
  onCursorChange?: (ms: number) => void;
  /** Test seam — injected hls.js module to avoid network dependency. */
  hlsModule?: typeof import("hls.js");
};

export function PastPlayer({
  camera,
  startMs,
  endMs,
  cursorMs,
  selectedMatch,
  onCursorChange,
  hlsModule,
}: PastPlayerProps) {
  const src = `/api/agent/timeline/${encodeURIComponent(camera)}/hls/master.m3u8?start_ms=${startMs}&end_ms=${endMs}`;
  const { videoRef, status, error, currentMs, seekToMs, setPlaying } =
    useHlsPlayer({ src, windowStartMs: startMs, hlsModule });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Seek when the consumer changes cursorMs. During an active drag the
  // parent updates cursorMs many times per second; if we seek the HLS
  // pipeline on every change it thrashes segment loads. Debounce the
  // actual `seekToMs` call by ~120ms so it settles on the latest value.
  const cursorRef = useRef(cursorMs);
  const seekTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (Math.abs(cursorRef.current - cursorMs) < 50) return;
    cursorRef.current = cursorMs;
    if (seekTimerRef.current != null) {
      window.clearTimeout(seekTimerRef.current);
    }
    seekTimerRef.current = window.setTimeout(() => {
      seekTimerRef.current = null;
      seekToMs(cursorMs);
    }, 120);
    return () => {
      if (seekTimerRef.current != null) {
        window.clearTimeout(seekTimerRef.current);
        seekTimerRef.current = null;
      }
    };
  }, [cursorMs, seekToMs]);

  // Notify the parent when playback advances naturally (not on every seek).
  useEffect(() => {
    if (!onCursorChange) return;
    if (Math.abs(currentMs - cursorRef.current) < 250) {
      cursorRef.current = currentMs;
      onCursorChange(currentMs);
    } else {
      cursorRef.current = currentMs;
    }
  }, [currentMs, onCursorChange]);

  // Draw the selected match bbox as a pink rect when the playhead is at
  // approximately the right moment.
  useEffect(() => {
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;
    let raf = 0;
    const tick = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = v.clientWidth;
      const h = v.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      c.style.width = `${w}px`;
      c.style.height = `${h}px`;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (selectedMatch?.bbox && Math.abs(currentMs - selectedMatch.ts_ms) < 500) {
        const [bx, by, bw, bh] = selectedMatch.bbox;
        ctx.strokeStyle = "#f472b6";
        ctx.lineWidth = Math.max(2, Math.round(h / 200));
        ctx.strokeRect(bx * w, by * h, bw * w, bh * h);
        ctx.fillStyle = "rgba(244, 114, 182, 0.85)";
        const label = selectedMatch.person_name
          ? `${selectedMatch.person_name} ${(selectedMatch.similarity * 100).toFixed(0)}%`
          : `match ${(selectedMatch.similarity * 100).toFixed(0)}%`;
        ctx.font = `${Math.max(11, Math.round(h / 40))}px ui-monospace, monospace`;
        const m = ctx.measureText(label);
        const pad = 4;
        ctx.fillRect(bx * w, by * h - 18, m.width + pad * 2, 16);
        ctx.fillStyle = "#0a0a0a";
        ctx.fillText(label, bx * w + pad, by * h - 5);
        c.setAttribute("data-probe-box", "true");
      } else {
        c.removeAttribute("data-probe-box");
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [selectedMatch, currentMs, videoRef]);

  return (
    <div className="relative inline-block max-w-full" data-testid="past-player">
      <video
        ref={videoRef}
        controls
        playsInline
        preload="metadata"
        controlsList="nodownload"
        className="block max-w-full"
        style={{ maxHeight: 640 }}
        data-status={status}
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute left-0 top-0"
        data-testid="past-canvas"
      />
      <div className="absolute right-2 top-2 z-10 border border-white/30 bg-black/55 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-white/85">
        past · {new Date(currentMs).toLocaleTimeString()}
        {selectedMatch
          ? ` · ${(selectedMatch.similarity * 100).toFixed(0)}%`
          : ""}
      </div>
      {error && (
        <div className="absolute inset-x-2 bottom-2 z-10 border border-amber-400/50 bg-amber-400/15 px-2 py-1 font-mono text-[10px] text-amber-200">
          playback: {error}
        </div>
      )}
      <button
        type="button"
        onClick={() => setPlaying(status !== "playing")}
        className="absolute left-2 top-2 z-10 border border-white/30 bg-black/55 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-white/85 hover:bg-black/75"
      >
        {status === "playing" ? "⏸ pause" : "▶ play"}
      </button>
    </div>
  );
}
