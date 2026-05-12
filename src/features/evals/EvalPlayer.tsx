// /admin/evals video player + bbox overlay.
//
// The eval CLI writes a JSONL with one `frame` line per processed frame,
// each carrying the bboxes the production pipeline would have emitted
// at that timestamp. This component plays the source MP4 (streamed via
// the /api/agent/evals/<id>/clip proxy with HTTP Range) and overlays
// those bboxes on a <canvas> sized to match the <video>.
//
// Why a <video> + <canvas> instead of re-encoding the clip with bboxes
// burnt in:
//   - No server CPU spent re-encoding.
//   - The operator can scrub freely, change config, and re-run; the
//     overlay updates instantly with no extra work.
//   - Bbox colors / labels / motion indicators can be tuned in CSS-time
//     without touching the tracker.
//
// Sync model: the source video plays at native fps. Eval frames carry
// `ts_s` (synthetic monotonic clock at target_fps). With the default
// fps_cap=null, target_fps=native_fps and frame_skip=1, ts_s ≡
// video.currentTime. With a lower fps_cap, ts_s still maps cleanly to
// video time because frame_skip * frame_idx / native_fps = ts_s.
//
// We drive overlay redraws via requestAnimationFrame so the overlay
// stays smooth at 60fps even while the video plays at 30. Lookup uses
// a linear scan keyed by ts_s — for typical eval lengths (<10k frames)
// this is plenty fast.

import { useEffect, useMemo, useRef, useState } from "react";

type TrackEmit = {
  id: number;
  label: string;
  raw_label?: string;
  conf: number;
  bbox: [number, number, number, number];
  motion: "moving" | "static" | "warming" | null;
  verified: boolean | null;
};

type Frame = {
  type: "frame";
  frame: number;
  ts_s: number;
  image_w: number;
  image_h: number;
  infer_ms: number;
  tracks: TrackEmit[];
};

type Header = {
  type: "header";
  video_fps: number;
  target_fps: number;
  frame_skip: number;
  video_w: number;
  video_h: number;
  config: Record<string, unknown>;
};

export function EvalPlayer({
  runId,
  clipName,
}: {
  runId: string;
  clipName: string;
}) {
  const [header, setHeader] = useState<Header | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const [currentFrame, setCurrentFrame] = useState<Frame | null>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [showLabels, setShowLabels] = useState(true);
  const [showStatic, setShowStatic] = useState(true);

  // -- fetch JSONL ---------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoadingData(true);
    setError(null);
    setHeader(null);
    setFrames([]);
    fetch(`/api/agent/evals/${runId}/raw`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`raw fetch ${r.status}`);
        const text = await r.text();
        if (cancelled) return;
        const lines = text.split("\n");
        let h: Header | null = null;
        const fs: Frame[] = [];
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          try {
            const obj = JSON.parse(s);
            if (obj.type === "header") h = obj as Header;
            else if (obj.type === "frame") fs.push(obj as Frame);
          } catch {
            /* skip malformed lines */
          }
        }
        // Frames should already be sorted by frame index from the
        // writer, but defensive sort just in case.
        fs.sort((a, b) => a.ts_s - b.ts_s);
        setHeader(h);
        setFrames(fs);
      })
      .catch((err) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "load_failed");
      })
      .finally(() => {
        if (!cancelled) setLoadingData(false);
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // -- overlay redraw loop -------------------------------------------------
  // requestAnimationFrame is the right hammer here: video.currentTime
  // updates on the compositor's cadence, but `timeupdate` fires at
  // ~250ms which produces visible lag. rAF keeps the overlay glued to
  // the video.
  const framesRef = useRef<Frame[]>([]);
  framesRef.current = frames;
  const showLabelsRef = useRef(showLabels);
  showLabelsRef.current = showLabels;
  const showStaticRef = useRef(showStatic);
  showStaticRef.current = showStatic;

  useEffect(() => {
    if (!header || frames.length === 0) return;
    const v = videoRef.current;
    const c = canvasRef.current;
    if (!v || !c) return;

    let raf = 0;
    let lastTs = -1;
    let lastFrameIdx = -1;

    const tick = () => {
      const t = v.currentTime;
      if (t !== lastTs) {
        lastTs = t;
        setVideoTime(t);
        const idx = findClosestFrame(framesRef.current, t);
        if (idx !== lastFrameIdx) {
          lastFrameIdx = idx;
          setCurrentFrame(idx >= 0 ? framesRef.current[idx] : null);
        }
      }
      drawOverlay(c, v, framesRef.current[lastFrameIdx] ?? null, {
        showLabels: showLabelsRef.current,
        showStatic: showStaticRef.current,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
    };
  }, [header, frames]);

  // Per-track summary across the whole run — useful below the player.
  const trackSummary = useMemo(() => {
    const map = new Map<
      number,
      { label: string; frames: number; first: number; last: number }
    >();
    for (const f of frames) {
      for (const t of f.tracks) {
        const cur = map.get(t.id);
        if (!cur) {
          map.set(t.id, {
            label: t.label,
            frames: 1,
            first: f.frame,
            last: f.frame,
          });
        } else {
          cur.frames += 1;
          cur.last = f.frame;
          // keep the modal label
          if (t.label !== cur.label) cur.label = t.label;
        }
      }
    }
    return Array.from(map.entries())
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.frames - a.frames);
  }, [frames]);

  if (loadingData) {
    return (
      <div className="font-mono text-xs text-foreground/55">
        loading run data…
      </div>
    );
  }
  if (error) {
    return (
      <div className="font-mono text-xs text-red-400">load error: {error}</div>
    );
  }
  if (!header) {
    return (
      <div className="font-mono text-xs text-foreground/55">
        no header in run output
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-foreground/70">
        <span className="uppercase tracking-widest text-foreground/55">
          clip
        </span>
        <span className="text-foreground/85">{clipName}</span>
        <span className="text-foreground/40">
          · {header.video_w}×{header.video_h} · native{" "}
          {Number(header.video_fps).toFixed(1)}fps · processed{" "}
          {Number(header.target_fps).toFixed(1)}fps · {frames.length} frames
        </span>
      </div>

      <div
        ref={wrapRef}
        className="relative inline-block max-w-full overflow-hidden border border-foreground/15 bg-black"
      >
        <video
          ref={videoRef}
          src={`/api/agent/evals/${runId}/clip`}
          controls
          playsInline
          preload="metadata"
          className="block max-w-full"
          style={{ maxHeight: 640 }}
        />
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute left-0 top-0"
        />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[11px] text-foreground/70">
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showLabels}
              onChange={(e) => setShowLabels(e.target.checked)}
            />
            labels
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showStatic}
              onChange={(e) => setShowStatic(e.target.checked)}
            />
            static tracks
          </label>
        </div>
        <div className="text-foreground/55">
          t = {videoTime.toFixed(2)}s
          {currentFrame ? (
            <>
              {" · "}
              frame {currentFrame.frame}
              {" · "}
              infer {currentFrame.infer_ms}ms
              {" · "}
              <span className="text-foreground/85">
                {currentFrame.tracks.length} emit
              </span>
            </>
          ) : (
            <span className="text-foreground/40"> · no frame at time</span>
          )}
        </div>
      </div>

      {currentFrame && currentFrame.tracks.length > 0 && (
        <div className="border border-foreground/10 bg-foreground/[0.02] p-2 font-mono text-[11px]">
          <div className="mb-1 uppercase tracking-widest text-[10px] text-foreground/55">
            tracks at t={currentFrame.ts_s}s
          </div>
          <ul className="grid grid-cols-1 gap-x-4 sm:grid-cols-2 md:grid-cols-3">
            {currentFrame.tracks.map((t) => (
              <li key={t.id} className="text-foreground/80">
                <span
                  className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                  style={{ backgroundColor: colorForLabel(t.label) }}
                />
                <span className="text-foreground/85">{t.label}</span>{" "}
                <span className="text-foreground/55">#{t.id}</span>{" "}
                <span className="text-foreground/55">
                  {(t.conf * 100).toFixed(0)}%
                </span>{" "}
                {t.motion === "static" && (
                  <span className="text-amber-300">·static</span>
                )}
                {t.motion === "warming" && (
                  <span className="text-foreground/40">·warming</span>
                )}
                {t.verified === true && (
                  <span className="text-emerald-400">·v</span>
                )}
                {t.verified === false && (
                  <span className="text-red-400">·x</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {trackSummary.length > 0 && (
        <details className="border border-foreground/10 bg-foreground/[0.02]">
          <summary className="cursor-pointer px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-foreground/55 hover:text-foreground">
            run-wide track summary · {trackSummary.length} unique track IDs
          </summary>
          <div className="border-t border-foreground/10 p-2">
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-widest text-foreground/55">
                  <th className="py-1 pr-3">ID</th>
                  <th className="py-1 pr-3">Modal label</th>
                  <th className="py-1 pr-3">Frames</th>
                  <th className="py-1 pr-3">First → last</th>
                </tr>
              </thead>
              <tbody>
                {trackSummary.slice(0, 50).map((t) => (
                  <tr key={t.id} className="border-t border-foreground/5">
                    <td className="py-1 pr-3 text-foreground/70">#{t.id}</td>
                    <td className="py-1 pr-3 text-foreground/85">
                      <span
                        className="mr-2 inline-block h-2 w-2 rounded-full align-middle"
                        style={{ backgroundColor: colorForLabel(t.label) }}
                      />
                      {t.label}
                    </td>
                    <td className="py-1 pr-3 text-foreground/70">{t.frames}</td>
                    <td className="py-1 pr-3 text-foreground/55">
                      {t.first} → {t.last}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}

// ---- helpers ------------------------------------------------------------

function findClosestFrame(frames: Frame[], t: number): number {
  // Binary search by ts_s. Returns index of the frame whose ts_s is
  // closest to (and not significantly after) `t`. -1 if none.
  if (frames.length === 0) return -1;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (frames[mid].ts_s <= t) lo = mid;
    else hi = mid - 1;
  }
  // `lo` is the last frame with ts_s <= t. Also consider lo+1 in case
  // it's closer (e.g. t is between two frames).
  const cand = [lo];
  if (lo + 1 < frames.length) cand.push(lo + 1);
  let best = lo;
  let bestDiff = Math.abs(frames[lo].ts_s - t);
  for (const i of cand) {
    const d = Math.abs(frames[i].ts_s - t);
    if (d < bestDiff) {
      best = i;
      bestDiff = d;
    }
  }
  // If the closest frame is more than 1 second away, treat it as "no
  // frame at time" — happens for runs with max_frames truncation.
  if (bestDiff > 1.0) return -1;
  return best;
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  frame: Frame | null,
  opts: { showLabels: boolean; showStatic: boolean },
) {
  // Size the canvas to match the video's displayed size so coordinates
  // line up. Internal canvas size is set to the displayed CSS size in
  // device pixels for crispness on HiDPI.
  const dpr = window.devicePixelRatio || 1;
  const w = video.clientWidth;
  const h = video.clientHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (!frame) return;

  for (const t of frame.tracks) {
    if (!opts.showStatic && t.motion === "static") continue;
    const [bx, by, bw, bh] = t.bbox;
    const x = bx * w;
    const y = by * h;
    const ww = bw * w;
    const hh = bh * h;
    const color = colorForLabel(t.label);

    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    if (t.motion === "static") {
      // Dashed border for static, solid for moving — matches the map's
      // visual language.
      ctx.setLineDash([6, 4]);
    } else {
      ctx.setLineDash([]);
    }
    ctx.strokeRect(x, y, ww, hh);
    ctx.setLineDash([]);

    if (opts.showLabels) {
      const lbl = `${t.label} #${t.id} ${(t.conf * 100).toFixed(0)}%${
        t.verified === true ? " ✓" : t.verified === false ? " ✗" : ""
      }`;
      ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
      const metrics = ctx.measureText(lbl);
      const textH = 14;
      const padX = 4;
      const labelY = y > textH ? y - textH : y + hh;
      ctx.fillStyle = color;
      ctx.fillRect(x, labelY, metrics.width + padX * 2, textH);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillText(lbl, x + padX, labelY + textH - 3);
    }
  }
}

function colorForLabel(label: string): string {
  if (label === "person") return "#34d399";
  if (label === "dog" || label === "cat") return "#7dd3fc";
  if (
    label === "car" ||
    label === "truck" ||
    label === "bus" ||
    label === "motorcycle" ||
    label === "bicycle"
  ) {
    return "#fbbf24";
  }
  return "#cbd5e1";
}
