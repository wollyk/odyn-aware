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

  // Canvas overlay — AR-aware + age-fading.
  //
  // Two correctness fixes vs the previous overlay:
  //
  //   1. The displayed video has `object-contain` and a fixed-AR tile
  //      wrapper, so when source AR ≠ tile AR the video letterboxes.
  //      Previously we projected normalized bboxes onto the FULL canvas
  //      (the tile rect), which stretched them across the letterbox bars.
  //      Now we compute the actual displayed video rect using the source
  //      videoWidth/videoHeight (or naturalWidth/naturalHeight for
  //      snapshots) and project bbox coords into THAT rect only.
  //
  //   2. Boxes carry a `ts` (when the underlying CV detector saw the
  //      object) and we fade opacity 1 → 0 over BOX_FADE_MS, then drop
  //      them entirely after BOX_MAX_AGE_MS. So when an object leaves
  //      the frame, its box gracefully decays instead of being held at
  //      full strength until the next 5s poll arrives.
  //
  // The drawn boxes are real-CV only (face from InsightFace, weapon from
  // YOLO). T3's hallucinated bboxes are intentionally not on the canvas
  // — they were the source of the "boxes are way bigger than the object"
  // complaint.
  useEffect(() => {
    const canvas = canvasRef.current;
    const target: HTMLElement | null = mode === "live" ? live.videoRef.current : imgRef.current;
    if (!canvas || !target) return;

    // Per-source visual styling. Alpha is the BASE alpha — fade multiplies it.
    const STYLE: Record<
      string,
      { stroke: string; fill: string; chip: string; chipText: string }
    > = {
      face_known: {
        stroke: "rgba(110, 231, 183, ALPHA)",     // emerald-300
        fill: "rgba(110, 231, 183, FILL_A)",
        chip: "rgba(0, 0, 0, ALPHA)",
        chipText: "rgba(110, 231, 183, ALPHA)",
      },
      face_unknown: {
        stroke: "rgba(251, 191, 36, ALPHA)",      // amber-400
        fill: "rgba(251, 191, 36, FILL_A)",
        chip: "rgba(0, 0, 0, ALPHA)",
        chipText: "rgba(251, 191, 36, ALPHA)",
      },
      weapon_suspicious: {
        stroke: "rgba(248, 113, 113, ALPHA)",     // red-400
        fill: "rgba(248, 113, 113, FILL_A)",
        chip: "rgba(0, 0, 0, ALPHA)",
        chipText: "rgba(248, 113, 113, ALPHA)",
      },
      weapon_clear: {
        stroke: "rgba(148, 163, 184, ALPHA)",     // slate-400
        fill: "rgba(148, 163, 184, FILL_A)",
        chip: "rgba(0, 0, 0, ALPHA)",
        chipText: "rgba(148, 163, 184, ALPHA)",
      },
    };
    const BOX_FADE_MS = 2000;
    const BOX_MAX_AGE_MS = 3000;

    let raf = 0;

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

      // Resolve the source's intrinsic dimensions so we can compute the
      // real "displayed video rect" inside the letterboxed tile.
      let srcW = 0;
      let srcH = 0;
      if (mode === "live" && target instanceof HTMLVideoElement) {
        srcW = target.videoWidth || 0;
        srcH = target.videoHeight || 0;
      } else if (target instanceof HTMLImageElement) {
        srcW = target.naturalWidth || 0;
        srcH = target.naturalHeight || 0;
      }
      // Until metadata is available, fall back to filling the tile so the
      // first ~ms post-load doesn't draw nothing.
      let rectX = 0,
        rectY = 0,
        rectW = w,
        rectH = h;
      if (srcW > 0 && srcH > 0) {
        const tileAR = w / h;
        const srcAR = srcW / srcH;
        if (srcAR > tileAR) {
          // Source wider than tile → letterbox top/bottom.
          rectW = w;
          rectH = Math.round(w / srcAR);
          rectX = 0;
          rectY = Math.round((h - rectH) / 2);
        } else if (srcAR < tileAR) {
          // Source taller than tile → pillarbox left/right.
          rectH = h;
          rectW = Math.round(h * srcAR);
          rectY = 0;
          rectX = Math.round((w - rectW) / 2);
        }
      }

      ctx.lineWidth = 1.5;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textBaseline = "top";

      const nowTs = Date.now();
      let anyAlive = false;
      for (const b of det.boxes) {
        const ageMs = Math.max(0, nowTs - (b.ts ?? 0));
        if (ageMs > BOX_MAX_AGE_MS) continue;
        const alpha = ageMs <= BOX_FADE_MS ? 1 - ageMs / BOX_FADE_MS / 1.5 : 0.05;
        if (alpha < 0.05) continue;
        anyAlive = true;
        const style = STYLE[b.source] ?? STYLE.face_unknown;
        const stroke = style.stroke
          .replace("ALPHA", alpha.toFixed(2));
        const fill = style.fill.replace("FILL_A", (alpha * 0.18).toFixed(2));
        const chip = style.chip.replace("ALPHA", (alpha * 0.85).toFixed(2));
        const chipText = style.chipText.replace("ALPHA", alpha.toFixed(2));

        const [x, y, ww, hh] = b.bbox;
        const rx = rectX + x * rectW;
        const ry = rectY + y * rectH;
        const rw = ww * rectW;
        const rh = hh * rectH;
        ctx.strokeStyle = stroke;
        ctx.fillStyle = fill;
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
        const label =
          b.confidence > 0
            ? `${b.label} ${b.confidence.toFixed(2)}`
            : b.label;
        const textW = ctx.measureText(label).width + 8;
        const chipH = 16;
        const chipY = Math.max(rectY, ry - chipH);
        ctx.fillStyle = chip;
        ctx.fillRect(rx, chipY, textW, chipH);
        ctx.fillStyle = chipText;
        ctx.fillText(label, rx + 4, chipY + 3);
      }

      // Schedule the next frame ONLY while at least one box is still
      // alive. Once everything has decayed past BOX_MAX_AGE_MS the
      // canvas is empty and we can stop the loop until new state arrives.
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
  }, [det.boxes, det.tickAt, imgUrl, mode, live.status]);

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
