// Video tile: video element OR snapshot image, plus canvas overlay + HUD chrome.
//
// UX principle: the only user-visible status states are "playing" and "error".
// Everything else (idle, connecting, negotiating, reconnecting, closed) is
// collapsed into a single soft "Connecting…" affordance with the last known
// frame still visible underneath. Don't surface raw state names.

import { useEffect, useRef, useState } from "react";
import type { AgentStatus, Camera, DetectionResult, SceneResult, StreamMode } from "./types";
import { useMseStream } from "./useMseStream";
import { useDetections } from "./useDetections";
import { useScene } from "./useScene";

export function VideoTile({
  cam,
  mode,
  agentStatus,
}: {
  cam: Camera | null;
  mode: StreamMode;
  agentStatus: AgentStatus | null;
}) {
  const [imgUrl, setImgUrl] = useState<string>("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [snapError, setSnapError] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const live = useMseStream(cam?.name ?? null, mode === "live");
  const det = useDetections(cam);
  const scene = useScene(cam);

  // Snapshot polling: 1Hz, cache-busted via ?t= (only in snapshot mode)
  useEffect(() => {
    if (!cam || mode !== "snapshot") return;
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
  }, [cam, mode]);

  // HUD clock
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Canvas overlay sizing + box drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    const target: HTMLElement | null = mode === "live" ? live.videoRef.current : imgRef.current;
    if (!canvas || !target) return;
    const draw = () => {
      const w = target.clientWidth;
      const h = target.clientHeight;
      if (!w || !h) return;
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
      ctx.lineWidth = 1.5;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textBaseline = "top";
      for (const d of det.detections) {
        const [x, y, ww, hh] = d.bbox;
        const rx = x * w;
        const ry = y * h;
        const rw = ww * w;
        const rh = hh * h;
        ctx.strokeStyle = "rgba(110, 231, 183, 0.95)";
        ctx.fillStyle = "rgba(110, 231, 183, 0.18)";
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
        const label = `${d.label} ${d.confidence.toFixed(2)}`;
        const textW = ctx.measureText(label).width + 8;
        const chipH = 16;
        const chipY = Math.max(0, ry - chipH);
        ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
        ctx.fillRect(rx, chipY, textW, chipH);
        ctx.fillStyle = "rgba(110, 231, 183, 1)";
        ctx.fillText(label, rx + 4, chipY + 3);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(target);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [det.detections, imgUrl, mode, live.status]);

  const camLabel = cam ? cam.label : "—";
  const wireName = cam ? cam.name : "";
  const ts = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");

  // ---- HUD label rules ----
  // mode=live + playing: show bitrate; otherwise show "Connecting…"
  // mode=snapshot:       show latency; otherwise "…"
  const hudRight =
    mode === "live"
      ? `${ts} · ${live.status === "playing" ? `${live.bitrateKbps}kbps` : "connecting…"}`
      : `${ts} · ${latencyMs != null ? `${latencyMs}ms` : "…"}`;

  // ---- Center overlay rules ----
  // Only show explicit "error" copy. Everything else is a single calm "Connecting…".
  const showCenterOverlay = mode === "live" && live.status !== "playing";
  const overlayText =
    live.status === "error"
      ? `Stream error${live.error ? `: ${live.error}` : ""}`
      : "Connecting…";

  return (
    <div className="relative" ref={wrapRef}>
      <div className="relative aspect-video overflow-hidden border border-border bg-black">
        {mode === "live" ? (
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
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="bg-black/70 px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground/85">
              {overlayText}
            </div>
          </div>
        )}

        {/* HUD chrome */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
          <div className="flex items-center gap-2 bg-black/65 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                mode === "live" && live.status !== "playing"
                  ? "bg-amber-400"
                  : "bg-red-500 animate-pulse"
              }`}
            />
            {mode === "live" ? "LIVE-MSE · AURORAVIEW" : "LIVE · AURORAVIEW"}
          </div>
          <div className="bg-black/65 px-2.5 py-1 font-mono text-[10px] tracking-widest text-foreground/85">
            {hudRight}
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
            Two lit dots = T2+T3, one = T3-only, dashed = no signal yet. */}
        <div className="pointer-events-none absolute left-3 bottom-12 flex items-center gap-1.5 bg-black/65 px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-foreground/85">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              scene.status === "ok" ? severityDotColor(scene.severity) : "bg-foreground/30"
            }`}
            title={`T2 local · ${scene.model ?? "ollama"}`}
          />
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              det.status === "ok" ? "bg-emerald-400" : "bg-foreground/30"
            }`}
            title="T3 cloud · gpt-4o-mini"
          />
          <span className="ml-1 text-foreground/70">
            {tierChainLabel(scene.status, det.status)}
          </span>
        </div>
      </div>

      {/* T2 scene caption — independent local reading. Surfaced even when
          T3 is unconfigured, so the operator can still see what the local
          agent thinks is going on. */}
      {scene.scene && scene.status === "ok" && (
        <p
          className={`mt-2 font-mono text-[11px] tracking-wider ${
            scene.severity === "critical"
              ? "text-red-400"
              : scene.severity === "notable"
              ? "text-amber-300"
              : "text-foreground/75"
          }`}
        >
          <span className="text-foreground/50 mr-1.5">T2-LOCAL ▸</span>
          {scene.scene}
          {scene.alertType && (
            <span className="ml-2 text-foreground/45">[{scene.alertType}]</span>
          )}
          {typeof scene.tookMs === "number" && (
            <span className="ml-2 text-foreground/35">{scene.tookMs}ms</span>
          )}
        </p>
      )}

      {det.summary && det.status === "ok" && (
        <p className="mt-1 font-mono text-[11px] tracking-wider text-foreground/80">
          <span className="text-alert">▸</span> {det.summary}
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

function severityDotColor(sev: SceneResult["severity"] | null): string {
  if (sev === "critical") return "bg-red-500 animate-pulse";
  if (sev === "notable") return "bg-amber-300";
  return "bg-emerald-400";
}

function tierChainLabel(
  t2: SceneResult["status"] | null,
  t3: DetectionResult["status"] | null,
): string {
  const t2On = t2 === "ok";
  const t3On = t3 === "ok";
  if (t2On && t3On) return "T2+T3";
  if (t2On) return "T2-only";
  if (t3On) return "T3-only";
  return "—";
}
