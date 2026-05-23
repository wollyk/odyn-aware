// /admin/evals player + bbox overlay.
//
// Handles BOTH source kinds the eval can produce:
//   - "video"    → <video src=/clip> streamed with HTTP Range, overlay
//                  driven by requestAnimationFrame against currentTime
//   - "sequence" → <img src=/frame/N> swapped by a setInterval driven
//                  at the header's target_fps; overlay drawn from
//                  frames[N] (frame N is BOTH the canvas frame and the
//                  source image index — there's exactly one image per
//                  emitted eval frame for sequence runs)
//
// The eval CLI writes a JSONL with one `frame` line per processed frame,
// each carrying the bboxes the production pipeline would have emitted
// at that timestamp. The JSONL header's `source_kind` field tells this
// component which playback strategy to use; older runs without that
// field default to "video".
//
// Why a separate playback strategy for sequences instead of re-encoding
// to MP4 server-side:
//   - No ffmpeg dependency in the tracker venv
//   - The display is identical visually (paint frame N + draw overlay)
//   - Browser-side caching (Cache-Control: immutable on /frame/N) makes
//     re-scrubbing instant after the first pass
//
// Sync model:
//   - Video: source plays at native fps; eval frames carry `ts_s`
//     (synthetic monotonic clock at target_fps). With default fps_cap
//     and frame_skip=1, ts_s ≡ video.currentTime.
//   - Sequence: there's no "real" clock; we advance currentFrameIdx at
//     1000/target_fps ms intervals while playing.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type TrackEmit = {
  id: number;
  label: string;
  raw_label?: string;
  conf: number;
  bbox: [number, number, number, number];
  motion: "moving" | "static" | "warming" | null;
  verified: boolean | null;
};

type FaceEmit = {
  bbox: [number, number, number, number];
  quality: number;
  person_name?: string | null;
  decision?: "match" | "unknown" | "low_quality";
};

type Frame = {
  type: "frame";
  frame: number;
  ts_s: number;
  image_w: number;
  image_h: number;
  infer_ms: number;
  tracks: TrackEmit[];
  faces?: FaceEmit[];
};

type Header = {
  type: "header";
  source_kind?: "video" | "sequence"; // missing on pre-13B runs ⇒ video
  video_fps: number;
  target_fps: number;
  frame_skip: number;
  video_w: number;
  video_h: number;
  config: Record<string, unknown>;
};

export type EvalSeekTarget = {
  ts_s: number;
  frame: number;
  face_index?: number;
  similarity?: number;
  bbox?: [number, number, number, number];
  /** Bumped on each seek so repeated clicks on the same frame still run. */
  token: number;
};

export function EvalPlayer({
  runId,
  clipName,
  seekTarget = null,
  probeImage = null,
}: {
  runId: string;
  clipName: string;
  seekTarget?: EvalSeekTarget | null;
  /** Passport / probe photo shown inset on the player for comparison. */
  probeImage?: string | null;
}) {
  const [header, setHeader] = useState<Header | null>(null);
  const [frames, setFrames] = useState<Frame[]>([]);
  const [loadingData, setLoadingData] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const framesRef = useRef<Frame[]>([]);
  const showLabelsRef = useRef(true);
  const showStaticRef = useRef(true);
  const showFacesRef = useRef(true);
  const seekTargetRef = useRef(seekTarget);

  const [currentFrame, setCurrentFrame] = useState<Frame | null>(null);
  const [videoTime, setVideoTime] = useState(0);
  const [showLabels, setShowLabels] = useState(true);
  const [showStatic, setShowStatic] = useState(true);
  const [showFaces, setShowFaces] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Sequence-mode playback state. Ignored when source_kind === "video".
  const [seqIdx, setSeqIdx] = useState(0);
  const [seqPlaying, setSeqPlaying] = useState(false);
  const isSequence = header?.source_kind === "sequence";

  framesRef.current = frames;
  showLabelsRef.current = showLabels;
  showStaticRef.current = showStatic;
  showFacesRef.current = showFaces;
  seekTargetRef.current = seekTarget;

  // Jump to a search hit (video time or sequence frame index).
  useEffect(() => {
    if (!seekTarget || !header || frames.length === 0) return;
    setSeqPlaying(false);
    const fi = findFrameIndexByNumber(frames, seekTarget.frame);
    const frameIdx = fi >= 0 ? fi : findClosestFrame(frames, seekTarget.ts_s);
    if (isSequence) {
      const idx =
        frameIdx >= 0
          ? frameIdx
          : Math.max(0, Math.min(frames.length - 1, seekTarget.frame));
      setSeqIdx(idx);
      setCurrentFrame(frames[idx] ?? null);
    } else {
      const v = videoRef.current;
      if (frameIdx >= 0) setCurrentFrame(frames[frameIdx]);
      if (v) {
        seekVideoTo(v, seekTarget.ts_s, () => {
          setVideoTime(v.currentTime);
          const synced = findClosestFrame(frames, v.currentTime);
          if (synced >= 0) setCurrentFrame(frames[synced]);
        });
      }
    }
  }, [seekTarget, isSequence, frames, header]);

  // Track document fullscreen so we can swap the player's layout
  // class. The native <video> fullscreen button would take JUST the
  // video into the OS fullscreen layer and leave our overlay <canvas>
  // (a sibling in the DOM) behind, which is exactly the bug the user
  // hit. We disable that button via controlsList="nofullscreen" and
  // expose our own button that fullscreens the wrap div instead, so
  // video + canvas travel together.
  useEffect(() => {
    const onChange = () => {
      setIsFullscreen(document.fullscreenElement === wrapRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) {
      document.exitFullscreen().catch(() => {});
    } else {
      el.requestFullscreen().catch(() => {});
    }
  }, []);

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

  const hasFaceData = useMemo(
    () => frames.some((f) => (f.faces?.length ?? 0) > 0),
    [frames],
  );

  // -- video-mode overlay loop --------------------------------------------
  useEffect(() => {
    if (!header || frames.length === 0 || isSequence) return;
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
        showFaces: showFacesRef.current,
        highlightSeek: seekTargetRef.current,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
    };
  }, [header, frames, isSequence]);

  // -- sequence-mode playback loop ---------------------------------------
  // Advances seqIdx at the header's target_fps while playing. The image
  // element loads /frame/N on each idx change; the overlay redraw runs
  // on every rAF so it stays glued even mid-image-load.
  useEffect(() => {
    if (!header || !isSequence || !seqPlaying) return;
    const fps = header.target_fps || 10;
    const stepMs = 1000 / Math.max(1, fps);
    const interval = window.setInterval(() => {
      setSeqIdx((prev) => {
        const next = prev + 1;
        if (next >= frames.length) {
          // Auto-pause at end. User can press play to loop from 0.
          setSeqPlaying(false);
          return frames.length - 1;
        }
        return next;
      });
    }, stepMs);
    return () => window.clearInterval(interval);
  }, [header, isSequence, seqPlaying, frames.length]);

  // -- sequence-mode overlay redraw --------------------------------------
  // The img <-> canvas size sync is the same as video; we just key off
  // the img instead of the video element.
  useEffect(() => {
    if (!header || frames.length === 0 || !isSequence) return;
    const img = imgRef.current;
    const c = canvasRef.current;
    if (!img || !c) return;
    const frame = frames[Math.max(0, Math.min(frames.length - 1, seqIdx))] ?? null;
    setCurrentFrame(frame);

    // rAF so the overlay updates after the img has laid out (the
    // src change triggers a load+paint; we want to redraw the next
    // tick to match).
    let raf = 0;
    const tick = () => {
      drawOverlay(c, img, frame, {
        showLabels: showLabelsRef.current,
        showStatic: showStaticRef.current,
        showFaces: showFacesRef.current,
        highlightSeek: seekTargetRef.current,
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [header, frames, isSequence, seqIdx]);

  // -- sequence controls --------------------------------------------------
  const seqStep = useCallback(
    (delta: number) => {
      setSeqPlaying(false);
      setSeqIdx((prev) =>
        Math.max(0, Math.min(frames.length - 1, prev + delta)),
      );
    },
    [frames.length],
  );

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
          · {header.video_w}×{header.video_h} ·{" "}
          {isSequence ? (
            <>image sequence · {Number(header.target_fps).toFixed(1)}fps</>
          ) : (
            <>
              native {Number(header.video_fps).toFixed(1)}fps · processed{" "}
              {Number(header.target_fps).toFixed(1)}fps
            </>
          )}{" "}
          · {frames.length} frames
        </span>
      </div>
      {!hasFaceData && frames.length > 0 && (
        <p className="font-mono text-[11px] text-amber-400/90 border border-amber-400/30 bg-amber-400/5 px-3 py-2">
          This run has no face boxes in its JSONL (recorded before face-in-eval shipped). Re-run the eval
          to bake head boxes — green = person track, dashed cyan = face.
        </p>
      )}

      <div
        ref={wrapRef}
        // In fullscreen the wrap becomes a flex container so the media
        // can fill the viewport while preserving aspect (object-contain
        // on the <video>/<img>). The overlay canvas tracks the media's
        // rendered area via the letterbox math in drawOverlay below.
        className={[
          "relative overflow-hidden border border-foreground/15 bg-black",
          isFullscreen
            ? "flex h-screen w-screen items-center justify-center"
            : "inline-block max-w-full",
        ].join(" ")}
      >
        {isSequence ? (
          <img
            ref={imgRef}
            src={`/api/agent/evals/${runId}/frame/${seqIdx}`}
            alt={`frame ${seqIdx}`}
            // Hint the layout engine so the canvas overlay knows what
            // CSS pixel size to draw into before the first frame loads.
            width={header.video_w || undefined}
            height={header.video_h || undefined}
            draggable={false}
            className={
              isFullscreen
                ? "block h-full w-full select-none object-contain"
                : "block max-w-full select-none"
            }
            style={isFullscreen ? undefined : { maxHeight: 640 }}
          />
        ) : (
          <video
            ref={videoRef}
            src={`/api/agent/evals/${runId}/clip`}
            controls
            // Drop the native fullscreen button — see comment on
            // toggleFullscreen above. Picture-in-picture and download
            // are also off; they'd take the media out of the wrap and
            // strand the overlay.
            controlsList="nofullscreen nodownload noplaybackrate"
            disablePictureInPicture
            playsInline
            preload="metadata"
            className={
              isFullscreen
                ? "block h-full w-full object-contain"
                : "block max-w-full"
            }
            style={isFullscreen ? undefined : { maxHeight: 640 }}
          />
        )}
        <canvas
          ref={canvasRef}
          // Cover the full wrap; the overlay code positions individual
          // boxes inside the letterbox area via offsetX/offsetY.
          className="pointer-events-none absolute left-0 top-0"
        />
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
          className="absolute right-2 top-2 z-10 border border-white/30 bg-black/55 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-white/85 hover:bg-black/75"
        >
          {isFullscreen ? "⤓ exit" : "⛶ fullscreen"}
        </button>
        {probeImage && (
          <div
            className="pointer-events-none absolute left-3 top-3 z-10 max-w-[22%] border border-pink-400/70 bg-black/75 p-1 shadow-lg backdrop-blur-sm"
            title="Probe photo used for identity search"
          >
            <p className="mb-0.5 font-mono text-[9px] uppercase tracking-widest text-pink-200/90">
              probe
              {seekTarget?.similarity != null
                ? ` · ${(seekTarget.similarity * 100).toFixed(0)}%`
                : ""}
            </p>
            <img
              src={probeImage}
              alt="Search probe"
              className="block max-h-16 w-auto max-w-full object-contain sm:max-h-20"
            />
          </div>
        )}
      </div>

      {isSequence && (
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-foreground/70">
          <button
            type="button"
            onClick={() => seqStep(-10)}
            disabled={seqIdx === 0}
            className="border border-foreground/20 px-2 py-0.5 text-foreground/85 hover:border-foreground/45 disabled:opacity-30"
          >
            ⏮ −10
          </button>
          <button
            type="button"
            onClick={() => seqStep(-1)}
            disabled={seqIdx === 0}
            className="border border-foreground/20 px-2 py-0.5 text-foreground/85 hover:border-foreground/45 disabled:opacity-30"
          >
            ◀ −1
          </button>
          <button
            type="button"
            onClick={() => {
              if (seqIdx >= frames.length - 1) setSeqIdx(0);
              setSeqPlaying((p) => !p);
            }}
            className="border border-foreground/30 bg-foreground/5 px-3 py-0.5 text-foreground/85 hover:bg-foreground/10"
          >
            {seqPlaying ? "⏸ pause" : "▶ play"}
          </button>
          <button
            type="button"
            onClick={() => seqStep(1)}
            disabled={seqIdx >= frames.length - 1}
            className="border border-foreground/20 px-2 py-0.5 text-foreground/85 hover:border-foreground/45 disabled:opacity-30"
          >
            ▶ +1
          </button>
          <button
            type="button"
            onClick={() => seqStep(10)}
            disabled={seqIdx >= frames.length - 1}
            className="border border-foreground/20 px-2 py-0.5 text-foreground/85 hover:border-foreground/45 disabled:opacity-30"
          >
            ⏭ +10
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0, frames.length - 1)}
            value={seqIdx}
            onChange={(e) => {
              setSeqPlaying(false);
              setSeqIdx(Number(e.target.value));
            }}
            className="flex-1 min-w-[200px]"
            aria-label="frame scrubber"
          />
          <span className="text-foreground/55 tabular-nums">
            {seqIdx + 1} / {frames.length}
          </span>
        </div>
      )}

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
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={showFaces}
              onChange={(e) => setShowFaces(e.target.checked)}
            />
            face boxes
          </label>
        </div>
        <div className="text-foreground/55">
          t ={" "}
          {(isSequence
            ? currentFrame?.ts_s ?? 0
            : videoTime
          ).toFixed(2)}
          s
          {currentFrame ? (
            <>
              {" · "}
              frame {currentFrame.frame}
              {" · "}
              infer {currentFrame.infer_ms}ms
              {" · "}
              <span className="text-foreground/85">
                {currentFrame.tracks.length} tracks
                {(currentFrame.faces?.length ?? 0) > 0
                  ? ` · ${currentFrame.faces!.length} faces`
                  : ""}
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

function findFrameIndexByNumber(frames: Frame[], frameNum: number): number {
  let lo = 0;
  let hi = frames.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const f = frames[mid].frame;
    if (f === frameNum) return mid;
    if (f < frameNum) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

function seekVideoTo(
  v: HTMLVideoElement,
  ts_s: number,
  onDone?: () => void,
) {
  const t = Math.max(0, ts_s);
  const run = () => {
    v.pause();
    const bump = Math.abs(v.currentTime - t) < 0.02 ? 0.001 : 0;
    if (onDone) v.addEventListener("seeked", () => onDone(), { once: true });
    v.currentTime = t + bump;
  };
  if (v.readyState >= 2) run();
  else v.addEventListener("loadeddata", run, { once: true });
}

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
  source: HTMLVideoElement | HTMLImageElement,
  frame: Frame | null,
  opts: {
    showLabels: boolean;
    showStatic: boolean;
    showFaces: boolean;
    highlightSeek?: EvalSeekTarget | null;
  },
) {
  // The canvas covers the wrap container's full client box (so it
  // works whether the video is at intrinsic size with no letterboxing
  // OR fullscreened with object-fit:contain producing letterbox bars).
  // Bbox coords are then mapped to the RENDERED MEDIA area inside that
  // box, computed from intrinsic media dimensions vs. element size.
  //
  // Without this, fullscreening a 320×240 source onto a 1920×1080
  // viewport draws boxes against the whole 1920×1080 — they'd appear
  // off-image (or never within the letterbox bars).
  const dpr = window.devicePixelRatio || 1;
  // Canvas's parent is the wrap div. Read its size, falling back to
  // the source's clientWidth/clientHeight if the parent isn't laid
  // out yet (rare; first paint).
  const parent = canvas.parentElement;
  const w = parent?.clientWidth || source.clientWidth;
  const h = parent?.clientHeight || source.clientHeight;
  if (w === 0 || h === 0) return;

  // Intrinsic media size — used to compute the letterboxed rendered area.
  let mediaW = 0;
  let mediaH = 0;
  if (source instanceof HTMLVideoElement) {
    mediaW = source.videoWidth;
    mediaH = source.videoHeight;
  } else {
    mediaW = source.naturalWidth;
    mediaH = source.naturalHeight;
  }
  // If metadata hasn't loaded yet, fall back to the element box —
  // boxes will be slightly off until the first metadata tick, then
  // self-correct on the next rAF.
  if (!mediaW || !mediaH) {
    mediaW = w;
    mediaH = h;
  }

  // object-fit: contain math. In non-fullscreen the source element is
  // at intrinsic size and `renderedW === w, renderedH === h, offsets 0`
  // — i.e. identical to the old code path. In fullscreen the source
  // is `width:100% height:100% object-contain` and we compute the
  // letterbox bars.
  const elemAR = w / h;
  const mediaAR = mediaW / mediaH;
  let renderedW: number;
  let renderedH: number;
  let offsetX: number;
  let offsetY: number;
  if (elemAR > mediaAR) {
    // Pillarbox (bars on left/right).
    renderedH = h;
    renderedW = h * mediaAR;
    offsetX = (w - renderedW) / 2;
    offsetY = 0;
  } else {
    // Letterbox (bars on top/bottom).
    renderedW = w;
    renderedH = w / mediaAR;
    offsetX = 0;
    offsetY = (h - renderedH) / 2;
  }

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

  // Scale line + label sizing with the rendered media height so boxes
  // stay legible on fullscreen 4K and tiny intrinsic 320×240 alike.
  const lineW = Math.max(2, Math.round(renderedH / 240));
  const labelFontPx = Math.max(11, Math.round(renderedH / 50));
  ctx.font = `${labelFontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;

  for (const t of frame.tracks) {
    if (!opts.showStatic && t.motion === "static") continue;
    const [bx, by, bw, bh] = t.bbox;
    const x = offsetX + bx * renderedW;
    const y = offsetY + by * renderedH;
    const ww = bw * renderedW;
    const hh = bh * renderedH;
    const color = colorForLabel(t.label);

    ctx.lineWidth = lineW;
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
      const metrics = ctx.measureText(lbl);
      const textH = labelFontPx + 2;
      const padX = 4;
      const labelY = y > textH ? y - textH : y + hh;
      ctx.fillStyle = color;
      ctx.fillRect(x, labelY, metrics.width + padX * 2, textH);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillText(lbl, x + padX, labelY + textH - 3);
    }
  }

  if (opts.showFaces && frame.faces?.length) {
    const faceLineW = Math.max(1, lineW - 1);
    const faceFontPx = Math.max(10, labelFontPx - 1);
    ctx.font = `${faceFontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    const hi = opts.highlightSeek;
    frame.faces.forEach((f, faceIdx) => {
      const [bx, by, bw, bh] = f.bbox;
      const x = offsetX + bx * renderedW;
      const y = offsetY + by * renderedH;
      const ww = bw * renderedW;
      const hh = bh * renderedH;
      const isHit =
        hi != null &&
        hi.face_index != null &&
        frame.frame === hi.frame &&
        faceIdx === hi.face_index;
      const known = f.decision === "match";
      const color = isHit ? "#f472b6" : known ? "#38bdf8" : "#fbbf24";
      ctx.lineWidth = isHit ? Math.max(3, lineW + 1) : faceLineW;
      ctx.strokeStyle = color;
      ctx.setLineDash(isHit ? [] : [4, 3]);
      ctx.strokeRect(x, y, ww, hh);
      ctx.setLineDash([]);
      if (opts.showLabels) {
        const sim =
          isHit && hi?.similarity != null
            ? ` ${(hi.similarity * 100).toFixed(0)}%`
            : "";
        const lbl = isHit
          ? `probe match${sim}`
          : (f.person_name ??
            (f.quality > 0 ? `face ${(f.quality * 100).toFixed(0)}%` : "face"));
        const metrics = ctx.measureText(lbl);
        const textH = faceFontPx + 2;
        const padX = 4;
        const labelY = y > textH ? y - textH : y + hh;
        ctx.fillStyle = color;
        ctx.fillRect(x, labelY, metrics.width + padX * 2, textH);
        ctx.fillStyle = "#0a0a0a";
        ctx.fillText(lbl, x + padX, labelY + textH - 3);
      }
    });
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
