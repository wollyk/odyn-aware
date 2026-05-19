"""Phase-13A tracking eval harness.

Replays a video file through the SAME pipeline that runs in production
(YOLOv8s + ByteTrack + _TrackVoter + _BBoxHistory + _VLMVerifier) and
emits a per-frame JSONL plus a summary, so the operator can A/B test
tracker config changes without standing in front of a real camera.

Why this is structured the way it is:
  - The eval imports production classes directly from `app.py`. That's
    deliberate: if the eval drifts from prod, the test stops testing
    what actually runs. If app.py grows past the refactor threshold,
    we extract those classes to a shared module — but until then, a
    sibling import keeps things minimal.
  - VLM verification is OFF by default. It's slow (200-2000ms per
    static blob) and we usually want to tune the cheap upstream
    filters in isolation. Toggle on with --vlm to also stress the
    Moondream call path.
  - One YOLO model per process, so multiple concurrent evals won't
    accidentally share ByteTrack state.

Subcommands:
  run    — frame-by-frame replay, emits JSONL.
  diff   — compares two run JSONLs. Tracks are matched by IoU per
           frame; output describes the deltas in label distribution,
           track lifespans, ID switches, and suppression counts.

CLI examples:
  python eval.py run \\
      --video /var/lib/auroraview-tracker/eval-corpus/porch.mp4 \\
      --out  /var/lib/auroraview-tracker/evals/<uuid>.jsonl

  python eval.py diff \\
      --a /var/lib/auroraview-tracker/evals/baseline.jsonl \\
      --b /var/lib/auroraview-tracker/evals/tighter.jsonl

The /eval/* HTTP endpoints in eval_routes.py spawn this CLI via
asyncio.create_subprocess_exec to avoid blocking uvicorn.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import time
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

import httpx

# Production imports. Importing here pulls torch + ultralytics + cv2,
# so the CLI takes ~3s to start cold. Acceptable — runs are minutes long.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app import (  # type: ignore  # noqa: E402
    ALLOWED_CLASSES,
    CONF_THRESHOLD,
    IMGSZ,
    IOU_THRESHOLD,
    MIN_STATIC_DWELL_S,
    MIN_TRACK_FRAMES,
    MODEL_PATH,
    PER_CLASS_CONF,
    PER_CLASS_DEFAULT_CONF,
    STATIC_REQUIRE_VERIFY,
    _BBoxHistory,
    _iou_xyxy,
    _TrackVoter,
    _VLMVerifier,
)


# ---------------------------------------------------------------------------
# Config: the knobs operators commonly want to vary in an eval.
# Anything not listed here uses the production module-level constant.
# ---------------------------------------------------------------------------
CONFIG_DEFAULTS: dict[str, Any] = {
    "conf_threshold": CONF_THRESHOLD,
    "iou_threshold": IOU_THRESHOLD,
    "imgsz": IMGSZ,
    "min_track_frames": MIN_TRACK_FRAMES,
    "min_static_dwell_s": MIN_STATIC_DWELL_S,
    "per_class_default_conf": PER_CLASS_DEFAULT_CONF,
    "per_class_conf": dict(PER_CLASS_CONF),
    "allowed_classes": sorted(ALLOWED_CLASSES) if ALLOWED_CLASSES else [],
    "static_require_verify": STATIC_REQUIRE_VERIFY,
    "vlm_enabled": False,  # off by default; flip with --vlm
    "faces_enabled": True,  # InsightFace sidecar; emits per-frame face bboxes
    "face_min_quality": 0.55,
    "max_frames": None,  # None = entire video
    "fps_cap": None,  # None = use video's native fps
}

FACE_EMBEDDER_URL = os.environ.get("FACE_EMBEDDER_URL", "http://127.0.0.1:8765").rstrip("/")


def merge_config(overrides: dict[str, Any] | None) -> dict[str, Any]:
    cfg = {k: (dict(v) if isinstance(v, dict) else (list(v) if isinstance(v, list) else v))
           for k, v in CONFIG_DEFAULTS.items()}
    if overrides:
        for k, v in overrides.items():
            if k in cfg:
                cfg[k] = v
    return cfg


def detect_faces_on_frame(
    pil,
    ow: int,
    oh: int,
    *,
    enabled: bool,
    min_quality: float,
) -> list[dict[str, Any]]:
    """Call the face-embedder sidecar; return normalized xywh face boxes."""
    if not enabled or ow <= 0 or oh <= 0:
        return []
    buf = io.BytesIO()
    pil.convert("RGB").save(buf, format="JPEG", quality=85)
    try:
        with httpx.Client(timeout=15.0) as client:
            res = client.post(
                f"{FACE_EMBEDDER_URL}/embed",
                files={"image": ("frame.jpg", buf.getvalue(), "image/jpeg")},
            )
        res.raise_for_status()
        data = res.json()
    except Exception as exc:  # noqa: BLE001
        print(f"[eval] face embedder warn: {exc}", flush=True)
        return []

    faces_out: list[dict[str, Any]] = []
    for f in data.get("faces") or []:
        q = float(f.get("quality") or 0.0)
        if q < min_quality:
            continue
        bbox = f.get("bbox")
        if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
            continue
        x1, y1, x2, y2 = (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
        w = max(0.0, x2 - x1)
        h = max(0.0, y2 - y1)
        if w <= 0 or h <= 0:
            continue
        faces_out.append(
            {
                "bbox": [
                    round(x1 / ow, 5),
                    round(y1 / oh, 5),
                    round(w / ow, 5),
                    round(h / oh, 5),
                ],
                "quality": round(q, 4),
            }
        )
    return faces_out


def hash_config(cfg: dict[str, Any]) -> str:
    """Stable hash of the eval-relevant config so two identical configs
    produce the same hash even when key order differs."""
    payload = json.dumps(cfg, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# Frame source
# ---------------------------------------------------------------------------
# The eval reads frames from either:
#   1. A video file (cv2.VideoCapture path) — native fps from container
#   2. A directory of images (.tif / .jpg / .png in sorted order) — synthetic
#      fps because image-sequence datasets like UCSD don't carry one.
#
# The directory branch is what makes pictures-as-input work: production
# inference already runs on snapshots from Frigate, so an image sequence
# is the more representative input shape. Both branches yield PIL.Image
# objects so the rest of the pipeline is source-agnostic.

_IMAGE_EXTS = (".tif", ".tiff", ".jpg", ".jpeg", ".png", ".bmp", ".webp")
# Default fps assumed for image-sequence sources when the user doesn't
# pass --fps. UCSD is recorded at 10 Hz; most surveillance datasets sit
# in the 5-15 Hz range. 10 is a safe middle.
DEFAULT_SEQUENCE_FPS = 10.0


class _FrameSource:
    """Common interface over video file + image-sequence sources.

    Attributes:
      kind       — "video" or "sequence" (recorded in JSONL header for the UI)
      native_fps — float; container fps for videos, DEFAULT_SEQUENCE_FPS for sequences
      width/height — measured from the first frame
      n_frames   — total count when known (0 for live-style video w/o index)
    """

    kind: str
    native_fps: float
    width: int
    height: int
    n_frames: int

    def read(self):  # -> PIL.Image | None
        raise NotImplementedError

    def release(self) -> None:
        raise NotImplementedError


class _VideoFrameSource(_FrameSource):
    def __init__(self, path: str):
        import cv2  # type: ignore  # cv2 is pulled by ultralytics, always present

        self.kind = "video"
        self._cv2 = cv2
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            raise RuntimeError(f"video_open_failed: {path}")
        self._cap = cap
        self.native_fps = float(cap.get(cv2.CAP_PROP_FPS) or 30.0)
        self.width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        self.height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.n_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)

    def read(self):
        ok, frame_bgr = self._cap.read()
        if not ok:
            return None
        from PIL import Image

        rgb = self._cv2.cvtColor(frame_bgr, self._cv2.COLOR_BGR2RGB)
        return Image.fromarray(rgb)

    def release(self) -> None:
        self._cap.release()


class _SequenceFrameSource(_FrameSource):
    """Read a directory of images in sorted-filename order.

    Hidden files and .gt/_gt folders (UCSD groundtruth masks) are
    skipped. PIL handles TIFF natively — same code path as JPEG.
    """

    def __init__(self, path: str):
        self.kind = "sequence"
        root = Path(path)
        if not root.is_dir():
            raise RuntimeError(f"sequence_dir_not_found: {path}")
        # Skip groundtruth folders next door — UCSD ships them as
        # `Test004_gt/` siblings of `Test004/`. Operator shouldn't see
        # those as candidates.
        files = sorted(
            p for p in root.iterdir()
            if p.is_file()
            and not p.name.startswith(".")
            and p.suffix.lower() in _IMAGE_EXTS
        )
        if not files:
            raise RuntimeError(f"no_images_in_dir: {path}")
        self._files = files
        self._i = 0
        self.n_frames = len(files)
        self.native_fps = DEFAULT_SEQUENCE_FPS
        # Probe the first frame for dimensions. PIL is lazy so we have
        # to .load() (or read width/height which forces decode of the
        # IFD only — cheap).
        from PIL import Image

        with Image.open(files[0]) as probe:
            self.width = int(probe.width)
            self.height = int(probe.height)

    def read(self):
        if self._i >= len(self._files):
            return None
        from PIL import Image

        p = self._files[self._i]
        self._i += 1
        with Image.open(p) as im:
            # convert("RGB") forces full decode + drops alpha/palette
            # quirks so YOLO sees a plain HxWx3 ndarray downstream.
            return im.convert("RGB")

    def release(self) -> None:
        pass


def _open_source(path: str) -> _FrameSource:
    """Pick the right frame source based on what `path` points to.

    A directory → image sequence; a file with a video extension or
    anything else → video (cv2 will raise if it really can't decode).
    """
    p = Path(path)
    if p.is_dir():
        return _SequenceFrameSource(str(p))
    return _VideoFrameSource(str(p))


# ---------------------------------------------------------------------------
# Run command
# ---------------------------------------------------------------------------
def cmd_run(args: argparse.Namespace) -> int:
    overrides: dict[str, Any] = {}
    if args.config:
        with open(args.config, "r", encoding="utf-8") as f:
            overrides = json.load(f)
    if args.vlm:
        overrides["vlm_enabled"] = True
    if getattr(args, "no_faces", False):
        overrides["faces_enabled"] = False
    if args.max_frames is not None:
        overrides["max_frames"] = args.max_frames
    if args.fps is not None:
        overrides["fps_cap"] = args.fps
    cfg = merge_config(overrides)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    run_id = args.run_id or uuid.uuid4().hex
    started_at = time.time()
    print(f"[eval:{run_id}] starting · video={args.video} cfg={hash_config(cfg)}", flush=True)

    src = _open_source(args.video)
    native_fps = src.native_fps
    vw, vh, n_frames = src.width, src.height, src.n_frames
    target_fps = cfg["fps_cap"] or native_fps
    frame_skip = max(1, round(native_fps / target_fps)) if target_fps and native_fps > target_fps else 1

    # Lazy import keeps `python eval.py --help` snappy.
    from ultralytics import YOLO  # type: ignore

    model = YOLO(MODEL_PATH)
    voter = _TrackVoter()
    bhist = _BBoxHistory()
    vlm = _VLMVerifier() if cfg["vlm_enabled"] else None

    # Per-track lifetime aggregation (used in the summary).
    track_lifetimes: dict[int, dict[str, Any]] = {}
    label_counter: Counter = Counter()
    raw_label_counter: Counter = Counter()
    suppressed_counter: Counter = Counter()  # reason -> count
    infer_ms: list[int] = []

    with out_path.open("w", encoding="utf-8") as fout:
        # Header line — the diff command keys off this.
        header = {
            "type": "header",
            "version": 1,
            "run_id": run_id,
            "video": str(Path(args.video).resolve()),
            # `source_kind` lets the player decide between <video> + Range
            # streaming (for "video") and per-frame canvas drawing (for
            # "sequence"). Older runs without this field default to "video".
            "source_kind": src.kind,
            "video_fps": round(native_fps, 3),
            "target_fps": round(target_fps, 3),
            "frame_skip": frame_skip,
            "video_w": vw,
            "video_h": vh,
            "video_frames": n_frames,
            "model": MODEL_PATH,
            "config": cfg,
            "config_hash": hash_config(cfg),
            "started_at": started_at,
        }
        fout.write(json.dumps(header) + "\n")
        fout.flush()

        frame_idx = 0
        kept_idx = 0
        max_frames = cfg["max_frames"]
        try:
            while True:
                pil = src.read()
                if pil is None:
                    break
                if frame_idx % frame_skip != 0:
                    frame_idx += 1
                    continue
                if max_frames and kept_idx >= max_frames:
                    break

                ow, oh = pil.size
                t0 = time.monotonic()
                results = model.track(
                    pil,
                    persist=True,
                    tracker="bytetrack.yaml",
                    conf=cfg["conf_threshold"],
                    iou=cfg["iou_threshold"],
                    imgsz=cfg["imgsz"],
                    verbose=False,
                    device="cpu",
                )
                t_infer_ms = int((time.monotonic() - t0) * 1000)
                infer_ms.append(t_infer_ms)

                tracks_emitted: list[dict] = []
                if results:
                    r = results[0]
                    boxes = getattr(r, "boxes", None)
                    if boxes is not None and len(boxes) > 0 and boxes.id is not None:
                        names = model.names
                        xyxy = boxes.xyxy.cpu().numpy()
                        ids = boxes.id.cpu().numpy().astype(int)
                        cls_arr = boxes.cls.cpu().numpy().astype(int)
                        confs = boxes.conf.cpu().numpy()
                        now_ts = kept_idx / target_fps  # synthetic monotonic clock

                        for i in range(len(xyxy)):
                            tid = int(ids[i])
                            raw_cls = int(cls_arr[i])
                            raw_conf = float(confs[i])
                            x1, y1, x2, y2 = (float(v) for v in xyxy[i].tolist())
                            xyxy_t = (x1, y1, x2, y2)

                            raw_label = str(names.get(raw_cls, str(raw_cls))).lower()
                            raw_label_counter[raw_label] += 1

                            bhist.update(tid, xyxy_t, now_ts)
                            voted_cls, voted_conf, frames = voter.update(
                                tid, raw_cls, raw_conf, now_ts
                            )

                            # ---- suppression reason chain (mirrors prod) ----
                            if frames < cfg["min_track_frames"] or voted_cls is None:
                                suppressed_counter["below_min_frames_or_no_majority"] += 1
                                continue
                            label = str(names.get(voted_cls, str(voted_cls))).lower()
                            allow = set(cfg["allowed_classes"]) if cfg["allowed_classes"] else None
                            if allow and label not in allow:
                                suppressed_counter[f"class_not_allowed:{label}"] += 1
                                continue
                            floor = cfg["per_class_conf"].get(label, cfg["per_class_default_conf"])
                            if voted_conf < floor:
                                suppressed_counter[f"below_conf_floor:{label}"] += 1
                                continue
                            w = max(0.0, x2 - x1)
                            h = max(0.0, y2 - y1)
                            if w <= 0 or h <= 0:
                                suppressed_counter["degenerate_bbox"] += 1
                                continue

                            is_static = bhist.is_static(tid)
                            motion = (
                                "moving" if is_static is False
                                else ("static" if is_static else "warming")
                            )
                            verified: bool | None = None

                            if cfg["vlm_enabled"] and vlm is not None and is_static:
                                cached = vlm.cached(tid, label, now_ts)
                                if cached is not None:
                                    verified = cached[0]
                                    if verified is False:
                                        suppressed_counter[f"vlm_rejected:{label}"] += 1
                                        continue
                                else:
                                    # Eval skips actually firing the VLM —
                                    # we'd need the live HTTP endpoint and
                                    # crop encoding, both expensive. We just
                                    # count the would-be call and (per
                                    # operator preference) suppress unverified
                                    # statics.
                                    if cfg["static_require_verify"]:
                                        suppressed_counter[f"vlm_pending:{label}"] += 1
                                        continue

                            bbox_norm = [
                                round(x1 / ow, 5),
                                round(y1 / oh, 5),
                                round(w / ow, 5),
                                round(h / oh, 5),
                            ]
                            track_emit = {
                                "id": tid,
                                "label": label,
                                "raw_label": raw_label,
                                "conf": round(voted_conf, 4),
                                "bbox": bbox_norm,
                                "motion": motion,
                                "verified": verified,
                            }
                            tracks_emitted.append(track_emit)

                            label_counter[label] += 1
                            life = track_lifetimes.setdefault(
                                tid,
                                {
                                    "labels": Counter(),
                                    "first_frame": kept_idx,
                                    "last_frame": kept_idx,
                                    "frames_emitted": 0,
                                },
                            )
                            life["labels"][label] += 1
                            life["last_frame"] = kept_idx
                            life["frames_emitted"] += 1

                        voter.gc(now_ts)
                        bhist.gc(now_ts)
                        if vlm is not None:
                            vlm.gc(now_ts)

                faces_emitted = detect_faces_on_frame(
                    pil,
                    ow,
                    oh,
                    enabled=bool(cfg.get("faces_enabled", True)),
                    min_quality=float(cfg.get("face_min_quality", 0.55)),
                )

                fout.write(
                    json.dumps(
                        {
                            "type": "frame",
                            "frame": kept_idx,
                            "ts_s": round(kept_idx / target_fps, 3),
                            "image_w": ow,
                            "image_h": oh,
                            "infer_ms": t_infer_ms,
                            "tracks": tracks_emitted,
                            "faces": faces_emitted,
                        }
                    )
                    + "\n"
                )
                if kept_idx % 30 == 0:
                    fout.flush()
                    print(
                        f"[eval:{run_id}] frame={kept_idx} infer={t_infer_ms}ms "
                        f"emitted={len(tracks_emitted)} faces={len(faces_emitted)}",
                        flush=True,
                    )

                kept_idx += 1
                frame_idx += 1
        finally:
            src.release()

        # Trailer summary line.
        finished_at = time.time()
        infer_sorted = sorted(infer_ms)

        def pct(p: float) -> int:
            if not infer_sorted:
                return 0
            i = min(len(infer_sorted) - 1, int(len(infer_sorted) * p))
            return infer_sorted[i]

        # ID-switches: count tracks whose modal label changed at least
        # once during their lifetime. Crude but useful — under heavy
        # flicker this number explodes.
        id_switches = 0
        for tid, life in track_lifetimes.items():
            if len(life["labels"]) > 1:
                id_switches += 1

        summary = {
            "type": "summary",
            "run_id": run_id,
            "frames_processed": kept_idx,
            "duration_s": round(kept_idx / target_fps, 2),
            "wallclock_s": round(finished_at - started_at, 2),
            "unique_tracks": len(track_lifetimes),
            "tracks_with_label_switches": id_switches,
            "label_distribution": dict(label_counter),
            "raw_label_distribution": dict(raw_label_counter),
            "suppression_reasons": dict(suppressed_counter),
            "infer_ms_p50": pct(0.5),
            "infer_ms_p95": pct(0.95),
            "infer_ms_max": (max(infer_ms) if infer_ms else 0),
            "config_hash": hash_config(cfg),
            "finished_at": finished_at,
        }
        fout.write(json.dumps(summary) + "\n")
        print(
            f"[eval:{run_id}] done · frames={kept_idx} unique_tracks={len(track_lifetimes)} "
            f"label_switches={id_switches} wallclock={summary['wallclock_s']}s",
            flush=True,
        )
    return 0


# ---------------------------------------------------------------------------
# Diff command
# ---------------------------------------------------------------------------
def _read_run(path: str) -> tuple[dict, list[dict], dict]:
    header: dict = {}
    frames: list[dict] = []
    summary: dict = {}
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            t = obj.get("type")
            if t == "header":
                header = obj
            elif t == "frame":
                frames.append(obj)
            elif t == "summary":
                summary = obj
    return header, frames, summary


def _match_tracks_iou(
    a_tracks: list[dict], b_tracks: list[dict], threshold: float = 0.5
) -> list[tuple[dict | None, dict | None]]:
    """Greedy IoU matching of tracks across two runs at a single frame.

    Returns a list of (a_track, b_track) pairs. Either side can be None
    for unmatched tracks, which are the interesting ones in the diff.
    """
    pairs: list[tuple[dict | None, dict | None]] = []
    used_b = set()
    for at in a_tracks:
        ax, ay, aw, ah = at["bbox"]
        a_xyxy = (ax, ay, ax + aw, ay + ah)
        best_b = None
        best_iou = threshold
        for j, bt in enumerate(b_tracks):
            if j in used_b:
                continue
            bx, by, bw, bh = bt["bbox"]
            iou = _iou_xyxy(a_xyxy, (bx, by, bx + bw, by + bh))
            if iou > best_iou:
                best_iou = iou
                best_b = (j, bt)
        if best_b is not None:
            used_b.add(best_b[0])
            pairs.append((at, best_b[1]))
        else:
            pairs.append((at, None))
    for j, bt in enumerate(b_tracks):
        if j not in used_b:
            pairs.append((None, bt))
    return pairs


def cmd_diff(args: argparse.Namespace) -> int:
    ah, af, asum = _read_run(args.a)
    bh, bf, bsum = _read_run(args.b)

    a_by_frame: dict[int, list[dict]] = {f["frame"]: f["tracks"] for f in af}
    b_by_frame: dict[int, list[dict]] = {f["frame"]: f["tracks"] for f in bf}
    all_frames = sorted(set(a_by_frame) | set(b_by_frame))

    only_a = 0
    only_b = 0
    label_changes: Counter = Counter()  # "A_label->B_label" → count
    matched = 0

    for frame in all_frames:
        ats = a_by_frame.get(frame, [])
        bts = b_by_frame.get(frame, [])
        for at, bt in _match_tracks_iou(ats, bts):
            if at and bt:
                matched += 1
                if at["label"] != bt["label"]:
                    label_changes[f"{at['label']}->{bt['label']}"] += 1
            elif at and not bt:
                only_a += 1
            elif bt and not at:
                only_b += 1

    diff = {
        "type": "diff",
        "version": 1,
        "a": {
            "run_id": ah.get("run_id"),
            "config_hash": ah.get("config_hash"),
            "video": ah.get("video"),
            "summary": asum,
        },
        "b": {
            "run_id": bh.get("run_id"),
            "config_hash": bh.get("config_hash"),
            "video": bh.get("video"),
            "summary": bsum,
        },
        "matched_track_frames": matched,
        "tracks_only_in_a": only_a,
        "tracks_only_in_b": only_b,
        "label_changes": dict(label_changes),
        "label_distribution_delta": _label_dist_delta(asum, bsum),
        "suppression_reasons_delta": _label_dist_delta(asum, bsum, key="suppression_reasons"),
        "p50_infer_ms_delta": (bsum.get("infer_ms_p50", 0) or 0) - (asum.get("infer_ms_p50", 0) or 0),
        "wallclock_delta_s": round(
            (bsum.get("wallclock_s", 0) or 0) - (asum.get("wallclock_s", 0) or 0), 2
        ),
    }
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as fout:
            json.dump(diff, fout, indent=2)
    json.dump(diff, sys.stdout, indent=2)
    sys.stdout.write("\n")
    return 0


def _label_dist_delta(asum: dict, bsum: dict, key: str = "label_distribution") -> dict[str, int]:
    a = asum.get(key, {}) or {}
    b = bsum.get(key, {}) or {}
    keys = set(a) | set(b)
    return {k: int(b.get(k, 0)) - int(a.get(k, 0)) for k in sorted(keys)}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="AuroraView tracking eval harness")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_run = sub.add_parser("run", help="run eval over one video")
    p_run.add_argument("--video", required=True)
    p_run.add_argument("--out", required=True, help="JSONL output path")
    p_run.add_argument("--config", help="JSON config overrides")
    p_run.add_argument("--vlm", action="store_true", help="enable VLM verification path")
    p_run.add_argument(
        "--no-faces",
        action="store_true",
        help="skip InsightFace face boxes (default: faces on)",
    )
    p_run.add_argument("--max-frames", type=int, dest="max_frames")
    p_run.add_argument("--fps", type=float, help="override target fps (default = video fps)")
    p_run.add_argument("--run-id", dest="run_id", help="optional explicit run UUID")
    p_run.set_defaults(func=cmd_run)

    p_diff = sub.add_parser("diff", help="diff two run JSONLs")
    p_diff.add_argument("--a", required=True)
    p_diff.add_argument("--b", required=True)
    p_diff.add_argument("--out", help="optional path to write the diff JSON")
    p_diff.set_defaults(func=cmd_diff)

    args = ap.parse_args()
    return int(args.func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
