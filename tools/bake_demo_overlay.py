"""Bake the live bbox overlay onto an eval clip, producing a single
self-contained MP4 suitable for the public homepage.

Why this exists:
    The /admin/evals "Watch" panel paints overlays on a <canvas> sitting
    over a <video> at runtime — see src/features/evals/EvalPlayer.tsx::
    drawOverlay(). Great for the admin who can authenticate and load the
    JSONL. Useless for the unauthenticated marketing homepage which just
    wants to drop in a <video autoplay loop muted>. This tool composites
    the same boxes server-side and writes a single MP4.

Pipeline:
    1. Parse the eval JSONL (header + frame events) into an in-memory
       dict keyed by frame index.
    2. Read the source video with OpenCV one frame at a time.
    3. For each frame, look up its tracks, draw rectangles + a small
       label band per track using the same color palette as EvalPlayer's
       colorForLabel().
    4. Write the composite frames to an mp4v-encoded intermediate (cv2's
       VideoWriter is reliable across builds with mp4v; H.264 fourccs
       depend on the ffmpeg build OpenCV was linked against).
    5. Re-encode the intermediate to web-friendly H.264 + AAC-less +
       +faststart via ffmpeg so the resulting MP4 will autoplay across
       all browsers, with no audio track (autoplay policies require
       muted videos and audio bloats the file).

Output sizing: the source is preserved; we don't downscale. The eval
typically operates on 640x360 or similar so the result is naturally
small. Bitrate is capped via CRF in the ffmpeg pass.

CLI:
    python tools/bake_demo_overlay.py \\
        --video  /var/lib/auroraview-tracker/eval-corpus/19.mp4 \\
        --jsonl  /var/lib/auroraview-tracker/evals/<RUN_ID>.jsonl \\
        --out    /var/www/odyn-aware/data/demo/aurora-tracking.mp4
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import cv2

# Palette mirrors EvalPlayer's colorForLabel(). Values here are BGR
# tuples since cv2 takes BGR.
_PERSON_BGR = (153, 211, 52)        # #34d399
_PET_BGR = (252, 211, 125)          # #7dd3fc
_VEHICLE_BGR = (36, 191, 251)       # #fbbf24
_OTHER_BGR = (225, 213, 203)        # #cbd5e1


def _color_for_label(label: str) -> tuple[int, int, int]:
    if label == "person":
        return _PERSON_BGR
    if label in ("dog", "cat"):
        return _PET_BGR
    if label in ("car", "truck", "bus", "motorcycle", "bicycle"):
        return _VEHICLE_BGR
    return _OTHER_BGR


def _load_jsonl(path: Path) -> tuple[dict, dict[int, dict]]:
    """Return (header_dict, {frame_index: frame_event_dict})."""
    header: dict = {}
    frames: dict[int, dict] = {}
    with path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            t = obj.get("type")
            if t == "header":
                header = obj
            elif t == "frame":
                frames[int(obj["frame"])] = obj
    return header, frames


def _draw_track(img, t: dict, w: int, h: int, show_labels: bool) -> None:
    bx, by, bw, bh = t["bbox"]
    x1 = max(0, int(bx * w))
    y1 = max(0, int(by * h))
    x2 = min(w - 1, int((bx + bw) * w))
    y2 = min(h - 1, int((by + bh) * h))
    color = _color_for_label(t.get("label", ""))
    motion = t.get("motion") or ""

    # Dashed for static, solid for moving — same convention as the
    # admin live player.
    if motion == "static":
        # cv2 has no native dashed rect; approximate with short
        # segments along each side. 6px on, 4px off.
        _dashed_rect(img, (x1, y1), (x2, y2), color, 2, dash=6, gap=4)
    else:
        cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)

    if show_labels:
        lbl = f"{t.get('label', '?')}"
        # Compact label; the live player shows more but homepage demo
        # benefits from a clean look.
        font = cv2.FONT_HERSHEY_SIMPLEX
        scale = 0.45
        thick = 1
        (tw, th), _ = cv2.getTextSize(lbl, font, scale, thick)
        pad = 3
        ly1 = max(0, y1 - th - 2 * pad)
        ly2 = ly1 + th + 2 * pad
        lx1 = x1
        lx2 = min(w - 1, x1 + tw + 2 * pad)
        cv2.rectangle(img, (lx1, ly1), (lx2, ly2), color, -1)
        cv2.putText(
            img,
            lbl,
            (lx1 + pad, ly2 - pad),
            font,
            scale,
            (10, 10, 10),
            thick,
            cv2.LINE_AA,
        )


def _dashed_rect(img, p1, p2, color, thick, dash=6, gap=4) -> None:
    x1, y1 = p1
    x2, y2 = p2
    step = dash + gap
    # top/bottom
    for x in range(x1, x2, step):
        xe = min(x2, x + dash)
        cv2.line(img, (x, y1), (xe, y1), color, thick)
        cv2.line(img, (x, y2), (xe, y2), color, thick)
    # left/right
    for y in range(y1, y2, step):
        ye = min(y2, y + dash)
        cv2.line(img, (x1, y), (x1, ye), color, thick)
        cv2.line(img, (x2, y), (x2, ye), color, thick)


def bake(video_path: Path, jsonl_path: Path, out_path: Path) -> dict:
    """Render the bbox overlay onto every frame of `video_path` using
    bbox coords from `jsonl_path` and write the result to `out_path`.

    Returns a small diagnostics dict for the caller to log.
    """
    if not video_path.is_file():
        raise FileNotFoundError(f"video not found: {video_path}")
    if not jsonl_path.is_file():
        raise FileNotFoundError(f"jsonl not found: {jsonl_path}")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg not on PATH; install it before running this")

    header, frames_map = _load_jsonl(jsonl_path)
    frame_skip = max(1, int(header.get("frame_skip", 1)))

    cap = cv2.VideoCapture(str(video_path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if w == 0 or h == 0:
        raise RuntimeError(f"could not open video: {video_path}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Two-stage: cv2 writes intermediate w/ widely-available mp4v
    # fourcc, then ffmpeg recompresses to web-friendly H.264 with
    # +faststart so browsers can begin playback before the file is
    # fully downloaded.
    with tempfile.TemporaryDirectory(prefix="aurora-bake-") as td:
        intermediate = Path(td) / "intermediate.mp4"
        fourcc = cv2.VideoWriter_fourcc(*"mp4v")
        writer = cv2.VideoWriter(str(intermediate), fourcc, fps, (w, h))
        if not writer.isOpened():
            raise RuntimeError("cv2.VideoWriter failed to open (mp4v)")

        # Index into kept_frame space. The eval JSONL stores frames in
        # the kept-frame index (after frame_skip), so source-frame N
        # corresponds to kept-frame (N // frame_skip) iff N % skip == 0.
        # We re-emit the source's NON-kept frames with no overlay so
        # playback stays smooth — better than holding a frozen frame.
        kept_idx = 0
        raw_idx = 0
        n_drawn = 0
        n_boxes = 0
        while True:
            ok, img = cap.read()
            if not ok:
                break
            if raw_idx % frame_skip == 0:
                ev = frames_map.get(kept_idx)
                if ev is not None:
                    for trk in ev.get("tracks", []):
                        _draw_track(img, trk, w, h, show_labels=True)
                        n_boxes += 1
                    n_drawn += 1
                kept_idx += 1
            writer.write(img)
            raw_idx += 1

        writer.release()
        cap.release()

        # Recompress for the web. Lower CRF than the upload-time
        # transcode (18 vs 20) since this is a hero asset; the file
        # is tiny anyway. Drop audio so autoplay policies are happy.
        out_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = [
            "ffmpeg",
            "-y",
            "-i", str(intermediate),
            "-an",                              # no audio
            "-c:v", "libx264",
            "-preset", "slow",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            "-loglevel", "error",
            str(out_path),
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError(
                f"ffmpeg recompress failed (rc={result.returncode})\n"
                f"stderr: {result.stderr.strip()}"
            )

    size_bytes = out_path.stat().st_size
    return {
        "out": str(out_path),
        "size_bytes": size_bytes,
        "size_mb": round(size_bytes / (1024 * 1024), 2),
        "width": w,
        "height": h,
        "fps": round(fps, 2),
        "frames_total": raw_idx,
        "frames_overlaid": n_drawn,
        "boxes_drawn": n_boxes,
        "frame_skip": frame_skip,
        "source_video": str(video_path),
        "source_jsonl": str(jsonl_path),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--video", required=True, help="path to eval source MP4/AVI")
    ap.add_argument("--jsonl", required=True, help="path to eval JSONL output")
    ap.add_argument("--out", required=True, help="destination MP4 path")
    args = ap.parse_args()

    info = bake(Path(args.video), Path(args.jsonl), Path(args.out))
    print(json.dumps(info, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
