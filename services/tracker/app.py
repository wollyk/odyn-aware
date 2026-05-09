"""AuroraView object tracker sidecar.

Persistent per-camera detection + tracking loop:
  - Pull latest.jpg from Frigate at ~5Hz (lazy: only while subscribers are
    attached).
  - Run YOLOv8s + ByteTrack with persist=True so track IDs survive across
    frames.
  - Broadcast {tick_at, image_w, image_h, took_ms, tracks: [{id, label,
    conf, bbox: [x,y,w,h] normalized 0..1}]} to every open websocket
    listening on /ws?camera=<name>.

Why this exists:
  - The previous /api/agent/detections path called YOLO every 5s with no
    tracker, no continuity, no smoothing. Boxes pulsed and IDs didn't
    persist, so the operator UI couldn't show "this is the same person
    from 3s ago". This sidecar fixes that by owning the loop.

Cost / scaling notes:
  - One YOLO model instance per camera (track persist state is held on
    the model). Memory: ~70MB per camera. Fine for the 1-3 cams we have;
    if we go to 10+ we'll switch to a shared model + manual BYTETracker
    instances.
  - Loops are reference-counted: started on the first WS subscriber,
    stopped GRACE_SHUTDOWN_S seconds after the last unsubscribe so a
    page reload doesn't drop the loop.

Failure modes considered:
  - Frigate down: loop logs and broadcasts an empty-tracks payload, then
    keeps trying.
  - Frame decode error: skipped, loop continues.
  - WS client disconnects mid-broadcast: removed, loop continues for any
    remaining subscribers.
  - Ultralytics throws: caught, broadcast empty-tracks, loop continues.
"""
from __future__ import annotations

import asyncio
import base64
import io
import os
import ssl
import time
from collections import Counter, deque
from typing import Any

import httpx
from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

# ---- Config ----------------------------------------------------------------
TRACKER_HOST = os.environ.get("TRACKER_HOST", "127.0.0.1")
TRACKER_PORT = int(os.environ.get("TRACKER_PORT", "8767"))

# Frigate snapshot source. Default points to the same instance the API
# server uses; verify=False because the local Frigate runs on a self-signed
# cert.
FRIGATE_BASE = os.environ.get("FRIGATE_BASE", "https://127.0.0.1:3000")
FRIGATE_USER = os.environ.get("FRIGATE_USER", "")
FRIGATE_PASS = os.environ.get("FRIGATE_PASS", "")
FRIGATE_VERIFY = os.environ.get("FRIGATE_VERIFY", "false").lower() == "true"

# Snapshot height in px. Tracker accuracy improves a lot from 480 → 720;
# inference cost goes up ~1.5x. 720 is the right default for YOLOv8s on
# CPU.
SNAPSHOT_HEIGHT = int(os.environ.get("TRACKER_SNAPSHOT_HEIGHT", "720"))

# Target loop FPS. We back off if a single tick exceeds 1/TARGET_FPS so we
# don't pile work indefinitely.
TARGET_FPS = float(os.environ.get("TRACKER_FPS", "5"))
LOOP_INTERVAL_S = 1.0 / max(0.5, TARGET_FPS)

# Detection thresholds. Ultralytics defaults to 0.25 / 0.7 for YOLO; we use
# 0.30 conf (stricter than the weapon-detector's 0.35 because we WANT to
# surface persons even at distance) and 0.45 IOU (slightly looser to keep
# the tracker happy when boxes drift between frames).
CONF_THRESHOLD = float(os.environ.get("TRACKER_CONF", "0.30"))
IOU_THRESHOLD = float(os.environ.get("TRACKER_IOU", "0.45"))
IMGSZ = int(os.environ.get("TRACKER_IMGSZ", "640"))

# YOLO model path. Pre-downloaded by install.sh to a writable absolute path
# because ProtectSystem=strict makes the deploy dir read-only.
MODEL_PATH = os.environ.get(
    "TRACKER_MODEL", "/var/lib/auroraview-tracker/yolov8s.pt"
)
if not os.path.isfile(MODEL_PATH):
    # Local dev fallback so we don't crash importing the module.
    MODEL_PATH = "yolov8s.pt"

# COCO class allowlist. We only broadcast tracks for classes we care about.
# Operator can override via env if they want broader coverage. Default is
# tight on purpose: a security operator cares about people, vehicles, and
# pets — not the full COCO long-tail. Suitcase/backpack/umbrella in
# particular are common YOLOv8s mis-fires for clothing, jackets, and
# tripods, so they're excluded to enforce "miss-rather-than-mistag".
DEFAULT_CLASSES = "person,bicycle,car,motorcycle,bus,truck,dog,cat"
ALLOWED_CLASSES = {
    s.strip().lower() for s in os.environ.get("TRACKER_CLASSES", DEFAULT_CLASSES).split(",") if s.strip()
}

# Per-class minimum *voted* confidence floor (applied after modal-class
# voting below, not raw YOLO conf). Anything not listed inherits
# PER_CLASS_DEFAULT_CONF. Format: "class=val,class=val,...".
#
# Tuned for "miss rather than mistag" on a security camera. Person is the
# class YOLOv8s is most reliable on, so it gets the lowest floor; animals
# are the most confused class family, so they get the highest.
PER_CLASS_DEFAULT_CONF = float(os.environ.get("TRACKER_PER_CLASS_DEFAULT_CONF", "0.55"))


def _parse_per_class_conf(raw: str) -> dict[str, float]:
    out: dict[str, float] = {}
    for tok in raw.split(","):
        tok = tok.strip()
        if not tok or "=" not in tok:
            continue
        k, v = tok.split("=", 1)
        try:
            out[k.strip().lower()] = float(v.strip())
        except ValueError:
            continue
    return out


PER_CLASS_CONF = _parse_per_class_conf(
    os.environ.get(
        "TRACKER_PER_CLASS_CONF",
        "person=0.50,car=0.55,truck=0.55,bus=0.55,motorcycle=0.55,bicycle=0.55,dog=0.60,cat=0.60",
    )
)

# Modal-class voting parameters. A track must have been observed at least
# MIN_TRACK_FRAMES times in its recent window before any box is emitted —
# this kills 1-frame flickers. Inside the window we count classes seen
# and emit only the modal class IF it owns ≥ VOTE_MAJORITY of the window.
# A 60% majority means a track that flips between "couch" and "dog" will
# be suppressed entirely instead of strobing.
MIN_TRACK_FRAMES = int(os.environ.get("TRACKER_MIN_FRAMES", "3"))
VOTE_WINDOW = int(os.environ.get("TRACKER_VOTE_WINDOW", "8"))
VOTE_MAJORITY = float(os.environ.get("TRACKER_VOTE_MAJORITY", "0.6"))

# How long to keep a track's voting history alive after we last saw it.
# Older entries get GC'd to keep memory bounded under busy scenes.
TRACK_TTL_S = float(os.environ.get("TRACKER_TRACK_TTL_S", "5.0"))

# ---- Motion classification + VLM verification ------------------------------
#
# Motion model: per-track ring buffer of bbox xyxy. A track is "static"
# when IoU(newest, oldest) over a MOTION_WINDOW-frame window stays above
# STATIC_IOU_THRESHOLD. IoU is robust to small wind-jitter (a tarp
# swaying ~5px in 1080p stays at ~0.95 IoU) but drops sharply when the
# whole object translates (a walking person drops to ~0.3-0.5 in 1.6s).
#
# Why we still WANT to detect parked cars: per the operator, the goal is
# "miss rather than mistag", but stationary vehicles ARE valid targets.
# So static tracks aren't suppressed unconditionally — we escalate them
# once to a local VLM (Moondream via Ollama) for a yes/no
# verification. Verified static → keep emitting. Unverified static →
# suppress. This preserves the cheap-fast path for moving objects and
# only spends VLM cost on the static-blob ambiguity.
MOTION_WINDOW = int(os.environ.get("TRACKER_MOTION_WINDOW", "8"))
MIN_MOTION_FRAMES = int(os.environ.get("TRACKER_MIN_MOTION_FRAMES", "5"))
STATIC_IOU_THRESHOLD = float(os.environ.get("TRACKER_STATIC_IOU", "0.85"))

# How long a track has to dwell as "static" before VLM verification is
# triggered. Prevents spending VLM calls on tracks that briefly stop
# mid-walk (e.g. a person standing still for 1s at a crosswalk).
MIN_STATIC_DWELL_S = float(os.environ.get("TRACKER_MIN_STATIC_DWELL_S", "2.0"))

# Master toggle: when False, VLM is skipped entirely and static tracks
# behave like before this change (emitted unconditionally).
VLM_VERIFY_ENABLED = os.environ.get("TRACKER_VLM_VERIFY", "true").lower() == "true"

# When True, static tracks that have not been confirmed (or have been
# rejected) by the VLM are suppressed in the broadcast. Operator's
# "miss > mistag" preference; flip to False if first-render delay is
# unacceptable.
STATIC_REQUIRE_VERIFY = (
    os.environ.get("TRACKER_STATIC_REQUIRE_VERIFY", "true").lower() == "true"
)

# Ollama VLM endpoint. Defaults match the Node harness (server/harness/
# tier2.mjs) so we stay on the same model the rest of the app is using.
OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://192.168.0.137:11434").rstrip("/")
VLM_MODEL = os.environ.get("OLLAMA_VLM_MODEL", "moondream:latest")
VLM_TIMEOUT_S = float(os.environ.get("TRACKER_VLM_TIMEOUT_S", "10.0"))

# Cap concurrent VLM calls so one busy scene doesn't fan out 20 parallel
# requests. Moondream on a single GPU comfortably handles 2 at a time.
VLM_CONCURRENCY = int(os.environ.get("TRACKER_VLM_CONCURRENCY", "2"))

# Don't re-verify the same (track_id, label) more often than this. After
# a successful verdict we cache for VLM_VERDICT_TTL_S; after a failure
# we cool down for VLM_RETRY_COOLDOWN_S before allowing a retry.
VLM_VERDICT_TTL_S = float(os.environ.get("TRACKER_VLM_VERDICT_TTL_S", "300.0"))
VLM_RETRY_COOLDOWN_S = float(os.environ.get("TRACKER_VLM_RETRY_COOLDOWN_S", "30.0"))

# Bbox padding around the YOLO box when we crop for the VLM. A tight
# crop loses context (e.g. just the tarp, no surrounding driveway);
# 15% padding gives Moondream enough scene to ground the answer.
CROP_PAD_RATIO = float(os.environ.get("TRACKER_CROP_PAD_RATIO", "0.15"))

# How long to keep a per-camera loop alive after the last unsubscribe.
# Avoids tearing down + restarting the model when the operator just
# refreshes the page.
GRACE_SHUTDOWN_S = float(os.environ.get("TRACKER_GRACE_S", "30"))

# ---- Frigate client --------------------------------------------------------
class FrigateClient:
    """Minimal async Frigate client. Owns the JWT cookie and refreshes
    on 401. Mirrors the behavior of server/frigate.mjs::loginIfNeeded so
    failures look identical to ops.
    """

    def __init__(self, base: str, user: str, password: str, verify: bool):
        self._base = base.rstrip("/")
        self._user = user
        self._pass = password
        # Frigate runs on self-signed cert locally. Don't fail on it.
        self._client = httpx.AsyncClient(
            verify=verify,
            timeout=httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0),
        )
        self._token: str | None = None
        self._token_lock = asyncio.Lock()

    async def aclose(self):
        await self._client.aclose()

    async def _login(self):
        # Concurrent callers all wait on the same lock so we don't fan out
        # multiple parallel logins.
        async with self._token_lock:
            if self._token is not None:
                return
            res = await self._client.post(
                f"{self._base}/api/login",
                json={"user": self._user, "password": self._pass},
            )
            if res.status_code != 200:
                raise RuntimeError(f"frigate_login_failed: {res.status_code}")
            cookie = res.headers.get("set-cookie", "")
            for part in cookie.split(","):
                if "frigate_token=" in part:
                    self._token = part.split("frigate_token=")[1].split(";")[0]
                    return
            raise RuntimeError("frigate_login_no_cookie")

    async def get_snapshot(self, camera: str, height: int) -> bytes:
        """GET /api/<camera>/latest.jpg?h=<height>. Refreshes token on 401."""
        if self._token is None:
            await self._login()
        url = f"{self._base}/api/{camera}/latest.jpg"
        params = {"h": str(height)}
        headers = {"Cookie": f"frigate_token={self._token}"}
        res = await self._client.get(url, params=params, headers=headers)
        if res.status_code == 401:
            self._token = None
            await self._login()
            headers["Cookie"] = f"frigate_token={self._token}"
            res = await self._client.get(url, params=params, headers=headers)
        if res.status_code != 200:
            raise RuntimeError(f"frigate_snapshot_{res.status_code}")
        return res.content


# ---- Geometry helpers -----------------------------------------------------
def _iou_xyxy(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    """IoU of two xyxy boxes. Returns 0.0 for empty/disjoint, 1.0 for identical.

    Used by motion classification — IoU(newest, oldest) over a small
    window is the cheapest tolerant motion signal we can compute.
    """
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)
    iw = max(0.0, ix2 - ix1)
    ih = max(0.0, iy2 - iy1)
    inter = iw * ih
    if inter <= 0:
        return 0.0
    area_a = max(0.0, ax2 - ax1) * max(0.0, ay2 - ay1)
    area_b = max(0.0, bx2 - bx1) * max(0.0, by2 - by1)
    union = area_a + area_b - inter
    if union <= 0:
        return 0.0
    return inter / union


# ---- Motion history -------------------------------------------------------
class _BBoxHistory:
    """Per-track ring buffer of (xyxy, ts). Used to classify a track as
    static or moving. We keep only the last MOTION_WINDOW samples — it's
    enough to span the wind-jitter timescale (~1-2s) without being
    sluggish to genuine movement.

    `is_static(tid)` returns:
      - True   → IoU(newest, oldest) >= STATIC_IOU_THRESHOLD
      - False  → moving (or insufficient data)
      - None   → unknown (track too young for a verdict)

    `static_for_s(tid)` returns how long the current static streak has
    lasted, used to debounce VLM verification.
    """

    def __init__(self):
        self._h: dict[int, deque[tuple[tuple[float, float, float, float], float]]] = {}
        # When the current static streak began. Reset every time IoU
        # drops below threshold.
        self._static_since: dict[int, float | None] = {}

    def update(self, tid: int, xyxy: tuple[float, float, float, float], ts: float) -> None:
        d = self._h.get(tid)
        if d is None:
            d = deque(maxlen=MOTION_WINDOW)
            self._h[tid] = d
        d.append((xyxy, ts))
        # Recompute static streak.
        if len(d) < MIN_MOTION_FRAMES:
            self._static_since[tid] = None
            return
        oldest = d[0][0]
        newest = d[-1][0]
        is_static_now = _iou_xyxy(oldest, newest) >= STATIC_IOU_THRESHOLD
        if is_static_now:
            if self._static_since.get(tid) is None:
                self._static_since[tid] = ts
        else:
            self._static_since[tid] = None

    def is_static(self, tid: int) -> bool | None:
        d = self._h.get(tid)
        if not d or len(d) < MIN_MOTION_FRAMES:
            return None
        return self._static_since.get(tid) is not None

    def static_for_s(self, tid: int, now_ts: float) -> float:
        since = self._static_since.get(tid)
        if since is None:
            return 0.0
        return max(0.0, now_ts - since)

    def gc(self, now_ts: float) -> None:
        dead = [tid for tid, d in self._h.items() if d and now_ts - d[-1][1] > TRACK_TTL_S]
        for tid in dead:
            self._h.pop(tid, None)
            self._static_since.pop(tid, None)


# ---- VLM verifier ---------------------------------------------------------
class _VLMVerifier:
    """Async wrapper around Ollama's /api/generate for yes/no questions.

    State (cache + in-flight + retry cooldown) is held PER CameraTracker
    because track IDs aren't unique across cameras. The HTTP client and
    semaphore are shared via _state for connection reuse.

    Cache shape: (track_id, label) → (verdict_bool, ts_monotonic)
      verdict_bool=True   → keep emitting static track
      verdict_bool=False  → suppress static track
    No-cache (key absent) → eligible for verification (subject to
                            cooldown). Failures don't poison the cache;
                            they only bump the retry-cooldown timer.
    """

    def __init__(self):
        self.cache: dict[tuple[int, str], tuple[bool, float]] = {}
        self.in_flight: set[tuple[int, str]] = set()
        self.last_attempt: dict[tuple[int, str], float] = {}

    def cached(
        self, tid: int, label: str, now_ts: float
    ) -> tuple[bool, float] | None:
        v = self.cache.get((tid, label))
        if v is None:
            return None
        verdict, ts = v
        if now_ts - ts > VLM_VERDICT_TTL_S:
            # Stale — drop and re-verify next eligible tick.
            self.cache.pop((tid, label), None)
            return None
        return v

    def cooled_down(self, tid: int, label: str, now_ts: float) -> bool:
        last = self.last_attempt.get((tid, label), 0.0)
        return now_ts - last >= VLM_RETRY_COOLDOWN_S

    def gc(self, now_ts: float) -> None:
        """Drop entries whose tids haven't been touched in a while.

        We don't have direct insight into which tracks are gone, so we
        prune any cache/last_attempt older than TRACK_TTL_S * 4 to be
        forgiving; track IDs that get reissued will just re-verify.
        """
        ttl = TRACK_TTL_S * 4
        for d in (self.cache, self.last_attempt):
            stale = [k for k, v in d.items() if now_ts - (v[1] if isinstance(v, tuple) else v) > ttl]
            for k in stale:
                d.pop(k, None)


def _crop_jpeg(
    pil: Image.Image,
    xyxy: tuple[float, float, float, float],
    image_w: int,
    image_h: int,
    pad_ratio: float,
) -> bytes | None:
    """Crop the bbox region (with padding) and encode as JPEG.

    Padding gives the VLM context — a bare car-shaped crop is hard to
    distinguish from an air-conditioner. We clamp to image bounds and
    bail out if the crop ends up empty (rounding edge cases).

    Returns None on encode failure.
    """
    x1, y1, x2, y2 = xyxy
    w = max(0.0, x2 - x1)
    h = max(0.0, y2 - y1)
    if w <= 0 or h <= 0:
        return None
    pad_x = w * pad_ratio
    pad_y = h * pad_ratio
    cx1 = int(max(0.0, x1 - pad_x))
    cy1 = int(max(0.0, y1 - pad_y))
    cx2 = int(min(float(image_w), x2 + pad_x))
    cy2 = int(min(float(image_h), y2 + pad_y))
    if cx2 <= cx1 or cy2 <= cy1:
        return None
    try:
        crop = pil.crop((cx1, cy1, cx2, cy2))
        buf = io.BytesIO()
        # quality=70 is plenty for a 1.6B-param VLM and keeps each
        # request small (~10-30 KB) so we don't pressure the LAN.
        crop.save(buf, format="JPEG", quality=70, optimize=True)
        return buf.getvalue()
    except Exception:
        return None


async def _call_ollama_yes_no(
    client: httpx.AsyncClient, label: str, jpeg_bytes: bytes
) -> bool | None:
    """Ask the VLM 'is this a <label>?'. Returns True/False/None.

    None means the call failed or the response was unparseable — caller
    should treat it as "verdict pending, retry later".
    """
    if not OLLAMA_BASE or not VLM_MODEL:
        return None
    b64 = base64.b64encode(jpeg_bytes).decode("ascii")
    # Keep the prompt tight. Moondream is a 1.6B-param VLM and answers
    # short factual yes/no questions reliably; longer prompts add
    # variance.
    prompt = (
        f"Look at this cropped image. Does it show a {label}? "
        f"Answer with only 'yes' or 'no'."
    )
    payload = {
        "model": VLM_MODEL,
        "prompt": prompt,
        "images": [b64],
        "stream": False,
        "keep_alive": "10m",
        "options": {"temperature": 0.0, "num_predict": 6},
    }
    try:
        res = await client.post(
            f"{OLLAMA_BASE}/api/generate",
            json=payload,
            timeout=httpx.Timeout(VLM_TIMEOUT_S),
        )
        if res.status_code != 200:
            return None
        data = res.json()
        text = (data.get("response") or "").strip().lower()
        if not text:
            return None
        # Tolerant parse: "yes", "yes.", "yes, it's a car." → True
        first_token = text.split()[0].rstrip(".,!?:;")
        if first_token in ("yes", "y"):
            return True
        if first_token in ("no", "n"):
            return False
        return None
    except Exception:
        return None


# ---- Modal-class voter ----------------------------------------------------
class _TrackVoter:
    """Per-track ring buffer of recent (cls_id, conf) observations.

    Why this exists: ByteTrack assigns persistent track IDs but YOLO can
    reclassify the same blob frame-to-frame ("person" → "couch" →
    "person"). Without smoothing, the operator sees the label strobe.
    Voting holds the last VOTE_WINDOW classes per track and emits the
    modal class only if it owns ≥ VOTE_MAJORITY of the window AND the
    track has been seen ≥ MIN_TRACK_FRAMES times. Anything else is
    suppressed — better to miss than to mistag.

    State is per-camera (each CameraTracker owns one) because track IDs
    are not unique across cameras.
    """

    def __init__(self):
        self._tracks: dict[int, deque[tuple[int, float]]] = {}
        self._last_ts: dict[int, float] = {}

    def update(
        self, tid: int, cls: int, conf: float, ts: float
    ) -> tuple[int | None, float, int]:
        """Record one observation; return (modal_cls, avg_conf, frames_seen).

        Returns modal_cls=None when the track lacks a clear winner — the
        caller should suppress that track for this frame.
        """
        d = self._tracks.get(tid)
        if d is None:
            d = deque(maxlen=VOTE_WINDOW)
            self._tracks[tid] = d
        d.append((cls, conf))
        self._last_ts[tid] = ts
        counts = Counter(c for c, _ in d)
        if not counts:
            return None, 0.0, 0
        modal_cls, modal_count = counts.most_common(1)[0]
        majority = modal_count / len(d)
        if majority < VOTE_MAJORITY:
            return None, 0.0, len(d)
        avg_conf = sum(cc for c2, cc in d if c2 == modal_cls) / modal_count
        return modal_cls, avg_conf, len(d)

    def gc(self, now_ts: float) -> None:
        dead = [tid for tid, ts in self._last_ts.items() if now_ts - ts > TRACK_TTL_S]
        for tid in dead:
            self._tracks.pop(tid, None)
            self._last_ts.pop(tid, None)


# ---- Per-camera tracker ---------------------------------------------------
class CameraTracker:
    """Owns a YOLO model + a persistent loop for one camera.

    Lifecycle:
      add_subscriber(ws)    — add WS, start the loop if not running.
      remove_subscriber(ws) — remove WS; if last, schedule a delayed stop.
      stop()                — cancel the loop and drop the model.
    """

    def __init__(self, camera: str, model_path: str, frigate: FrigateClient):
        self.camera = camera
        self.frigate = frigate
        self.model_path = model_path
        self._model: Any = None
        self._task: asyncio.Task | None = None
        self._stop_event = asyncio.Event()
        self._subscribers: set[WebSocket] = set()
        self._latest: dict | None = None
        self._grace_task: asyncio.Task | None = None
        # Per-camera class-voter — see _TrackVoter docstring for why.
        self._voter = _TrackVoter()
        # Per-camera motion history + VLM verifier. Both keyed on track
        # IDs which are camera-local in ByteTrack, so this can't be
        # shared across cameras.
        self._bbox_history = _BBoxHistory()
        self._vlm = _VLMVerifier()

    # -- model loaded lazily so importing this module doesn't block on
    # -- torch + ultralytics warm-up.
    def _load_model(self):
        if self._model is not None:
            return
        from ultralytics import YOLO  # imported here so it doesn't block startup
        self._model = YOLO(self.model_path)

    def add_subscriber(self, ws: WebSocket):
        self._subscribers.add(ws)
        # Cancel any pending grace shutdown — operator is back.
        if self._grace_task and not self._grace_task.done():
            self._grace_task.cancel()
            self._grace_task = None
        if self._task is None or self._task.done():
            self._stop_event.clear()
            self._task = asyncio.create_task(self._run_loop(), name=f"tracker-{self.camera}")

    def remove_subscriber(self, ws: WebSocket):
        self._subscribers.discard(ws)
        if not self._subscribers and (self._grace_task is None or self._grace_task.done()):
            self._grace_task = asyncio.create_task(self._delayed_stop())

    async def _delayed_stop(self):
        try:
            await asyncio.sleep(GRACE_SHUTDOWN_S)
        except asyncio.CancelledError:
            return
        if not self._subscribers:
            await self.stop()

    async def stop(self):
        self._stop_event.set()
        if self._task and not self._task.done():
            try:
                await asyncio.wait_for(self._task, timeout=3.0)
            except asyncio.TimeoutError:
                self._task.cancel()
        self._task = None
        # Keep the model loaded so a quick re-subscribe is fast. Drop only
        # if we want to free RAM (left for ops).

    async def _run_loop(self):
        print(f"[tracker:{self.camera}] loop start fps={TARGET_FPS} h={SNAPSHOT_HEIGHT}", flush=True)
        # Lazy-load the model on the loop coroutine so the FastAPI startup
        # doesn't pay for it on import.
        try:
            self._load_model()
        except Exception as exc:
            print(f"[tracker:{self.camera}] model load failed: {exc}", flush=True)
            return
        consecutive_errors = 0
        while not self._stop_event.is_set():
            tick_started = time.monotonic()
            tick_result = await self._tick()
            if tick_result is not None:
                payload, verify_queue = tick_result
                self._latest = payload
                await self._broadcast(payload)
                # Fire-and-forget VLM verifications. Each task updates
                # the per-camera _VLMVerifier cache; subsequent ticks
                # will see the new verdicts. We never await these — the
                # broadcast cadence is sacred.
                for tid, label, jpeg in verify_queue:
                    asyncio.create_task(
                        self._verify_track(tid, label, jpeg),
                        name=f"vlm-{self.camera}-{tid}-{label}",
                    )
                consecutive_errors = 0
            else:
                consecutive_errors += 1
                # Backoff on sustained errors so we don't flood logs.
                if consecutive_errors >= 5:
                    await asyncio.sleep(min(LOOP_INTERVAL_S * consecutive_errors, 5.0))
                    continue
            elapsed = time.monotonic() - tick_started
            sleep_for = max(0.0, LOOP_INTERVAL_S - elapsed)
            try:
                await asyncio.wait_for(self._stop_event.wait(), timeout=sleep_for)
            except asyncio.TimeoutError:
                pass  # expected — proceed to next tick
        print(f"[tracker:{self.camera}] loop stopped", flush=True)

    async def _verify_track(self, tid: int, label: str, jpeg_bytes: bytes) -> None:
        """Background VLM verification. Updates self._vlm.cache.

        Concurrency is gated by _state["vlm_sem"] so the GPU server
        doesn't see more than VLM_CONCURRENCY simultaneous requests
        across all cameras. On any failure the cache is left untouched
        — the retry-cooldown timer (set when we enqueued) prevents
        immediate re-spawn.
        """
        sem: asyncio.Semaphore = _state["vlm_sem"]
        client: httpx.AsyncClient = _state["vlm_client"]
        try:
            async with sem:
                verdict = await _call_ollama_yes_no(client, label, jpeg_bytes)
            if verdict is None:
                # Failure / unparseable — don't poison cache.
                return
            self._vlm.cache[(tid, label)] = (verdict, time.monotonic())
            print(
                f"[tracker:{self.camera}] vlm verify tid={tid} label={label} → {verdict}",
                flush=True,
            )
        finally:
            self._vlm.in_flight.discard((tid, label))

    async def _tick(self) -> tuple[dict, list[tuple[int, str, bytes]]] | None:
        """One frame: fetch → decode → track → return (payload, verify-queue).

        Returns None on error (caller backs off). The verify-queue is a
        list of (track_id, label, cropped_jpeg_bytes) tuples that the
        loop should hand to the VLM AFTER broadcasting — we never block
        the broadcast on Moondream (would be ~200-2000ms wasted).
        """
        try:
            t_fetch = time.monotonic()
            jpeg = await self.frigate.get_snapshot(self.camera, SNAPSHOT_HEIGHT)
            t_fetched = time.monotonic()
            pil = Image.open(io.BytesIO(jpeg))
            pil = ImageOps.exif_transpose(pil).convert("RGB")
            ow, oh = pil.size
            t_decoded = time.monotonic()
            # Inference + decisions + crop generation all happen in the
            # worker thread so the event loop stays responsive for WS
            # sends and the VLM client.
            tracks, verify_queue = await asyncio.to_thread(
                self._infer_and_classify, pil
            )
            t_inferred = time.monotonic()
            payload = {
                "type": "tick",
                "camera": self.camera,
                "tick_at": int(time.time() * 1000),
                "image_w": ow,
                "image_h": oh,
                "took_ms": {
                    "fetch": int((t_fetched - t_fetch) * 1000),
                    "decode": int((t_decoded - t_fetched) * 1000),
                    "infer": int((t_inferred - t_decoded) * 1000),
                    "total": int((t_inferred - t_fetch) * 1000),
                },
                "tracks": tracks,
            }
            return payload, verify_queue
        except Exception as exc:
            # Broadcast a heartbeat error so subscribers can show "tracker
            # paused" instead of going silent.
            err_payload = {
                "type": "error",
                "camera": self.camera,
                "tick_at": int(time.time() * 1000),
                "error": str(exc)[:200],
            }
            try:
                await self._broadcast(err_payload)
            except Exception:
                pass
            return None

    def _infer_and_classify(
        self, pil: Image.Image
    ) -> tuple[list[dict], list[tuple[int, str, bytes]]]:
        """Run YOLO + ByteTrack, apply voting + motion + verify policy.

        Returns (tracks_to_emit, vlm_verify_queue). The verify queue
        carries jpeg crops ready for an HTTP POST so the loop doesn't
        have to re-encode.

        Called from a worker thread (asyncio.to_thread).
        """
        ow, oh = pil.size
        if ow <= 0 or oh <= 0:
            return [], []
        results = self._model.track(
            pil,
            persist=True,
            tracker="bytetrack.yaml",  # ultralytics ships this config
            conf=CONF_THRESHOLD,
            iou=IOU_THRESHOLD,
            imgsz=IMGSZ,
            verbose=False,
            device="cpu",
        )
        if not results:
            return [], []
        r = results[0]
        boxes = getattr(r, "boxes", None)
        if boxes is None or len(boxes) == 0 or boxes.id is None:
            return [], []
        names = self._model.names
        xyxy = boxes.xyxy.cpu().numpy()
        ids = boxes.id.cpu().numpy().astype(int)
        cls = boxes.cls.cpu().numpy().astype(int)
        confs = boxes.conf.cpu().numpy()

        # Decision pipeline per detection (in this order, fail-fast):
        #   1. Push (cls, conf) into the per-track voter AND bbox-history
        #      — always, so both signals see the full history even for
        #      raw classes we'd ultimately reject.
        #   2. Drop if the track has fewer than MIN_TRACK_FRAMES samples
        #      (kills 1-frame flickers).
        #   3. Drop if no clear modal class (majority < VOTE_MAJORITY).
        #   4. Drop if voted class is not in ALLOWED_CLASSES.
        #   5. Drop if voted-avg conf < per-class floor (or default).
        #   6. Static-handling: if the track is static AND VLM verify is
        #      enabled, look up the cached VLM verdict for (tid, label):
        #         - True  → emit, mark verified=True, motion="static"
        #         - False → suppress (VLM said wrong class)
        #         - None  → suppress for now (if STATIC_REQUIRE_VERIFY)
        #                   AND queue a VLM verification call for after
        #                   the broadcast — only if the track has dwelt
        #                   static for >= MIN_STATIC_DWELL_S and we're
        #                   past the per-track retry cooldown.
        #      Moving tracks bypass VLM entirely (cheap-fast path).
        # Surviving detections inherit the *current* frame's bbox, since
        # voting only changes the label, not where the object is now.
        now_ts = time.monotonic()
        out: list[dict] = []
        verify_queue: list[tuple[int, str, bytes]] = []
        for i in range(len(xyxy)):
            tid = int(ids[i])
            raw_cls = int(cls[i])
            raw_conf = float(confs[i])
            x1, y1, x2, y2 = (float(v) for v in xyxy[i].tolist())
            xyxy_t = (x1, y1, x2, y2)
            self._bbox_history.update(tid, xyxy_t, now_ts)
            voted_cls, voted_conf, frames = self._voter.update(
                tid, raw_cls, raw_conf, now_ts
            )
            if frames < MIN_TRACK_FRAMES or voted_cls is None:
                continue
            label = str(names.get(voted_cls, str(voted_cls))).lower()
            if ALLOWED_CLASSES and label not in ALLOWED_CLASSES:
                continue
            floor = PER_CLASS_CONF.get(label, PER_CLASS_DEFAULT_CONF)
            if voted_conf < floor:
                continue
            w = max(0.0, x2 - x1)
            h = max(0.0, y2 - y1)
            if w <= 0 or h <= 0:
                continue

            is_static = self._bbox_history.is_static(tid)
            # Default motion label for the payload.
            motion = (
                "moving" if is_static is False else ("static" if is_static else "warming")
            )
            verified: bool | None = None  # tri-state: True / False / None=unknown

            if VLM_VERIFY_ENABLED and is_static:
                cached = self._vlm.cached(tid, label, now_ts)
                if cached is not None:
                    verified = cached[0]
                    if verified is False:
                        # VLM explicitly rejected this label for this
                        # static blob — suppress.
                        continue
                else:
                    # Static, no cached verdict. Decide whether to
                    # schedule a verification request.
                    dwell = self._bbox_history.static_for_s(tid, now_ts)
                    eligible = (
                        dwell >= MIN_STATIC_DWELL_S
                        and (tid, label) not in self._vlm.in_flight
                        and self._vlm.cooled_down(tid, label, now_ts)
                    )
                    if eligible:
                        crop = _crop_jpeg(pil, xyxy_t, ow, oh, CROP_PAD_RATIO)
                        if crop is not None:
                            verify_queue.append((tid, label, crop))
                            self._vlm.last_attempt[(tid, label)] = now_ts
                            self._vlm.in_flight.add((tid, label))
                    if STATIC_REQUIRE_VERIFY:
                        # Operator preference: don't show a box we can't
                        # justify. Once the VLM lands a verdict, the
                        # next tick will emit (or permanently suppress).
                        continue

            out.append(
                {
                    "id": tid,
                    "label": label,
                    "conf": round(voted_conf, 3),
                    "bbox": [
                        round(x1 / ow, 5),
                        round(y1 / oh, 5),
                        round(w / ow, 5),
                        round(h / oh, 5),
                    ],
                    "motion": motion,
                    "verified": verified,
                }
            )
        # GC voter + history + verifier so memory stays bounded under
        # long sessions on busy scenes.
        self._voter.gc(now_ts)
        self._bbox_history.gc(now_ts)
        self._vlm.gc(now_ts)
        return out, verify_queue

    async def _broadcast(self, payload: dict):
        if not self._subscribers:
            return
        # Iterate over a copy because send() failures will mutate the set.
        dead: list[WebSocket] = []
        for ws in list(self._subscribers):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._subscribers.discard(ws)

    def latest(self) -> dict | None:
        return self._latest


# ---- App -------------------------------------------------------------------
app = FastAPI(title="auroraview-tracker", version="0.1.0")

_state: dict[str, Any] = {
    "trackers": {},  # camera -> CameraTracker
    "frigate": None,
    "model_loaded_at": None,
    "vlm_client": None,  # shared httpx.AsyncClient for Ollama
    "vlm_sem": None,  # asyncio.Semaphore — caps GPU fan-out
}


@app.on_event("startup")
async def _startup():
    if not FRIGATE_USER or not FRIGATE_PASS:
        print("[tracker] WARNING: FRIGATE_USER/PASS not set — snapshot fetches will fail", flush=True)
    _state["frigate"] = FrigateClient(FRIGATE_BASE, FRIGATE_USER, FRIGATE_PASS, FRIGATE_VERIFY)
    # Shared VLM HTTP client + concurrency gate. Ollama keeps a single
    # model resident; concurrent requests fan out CPU/GPU work, so we
    # cap them globally rather than per camera.
    _state["vlm_client"] = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=3.0, read=VLM_TIMEOUT_S, write=3.0, pool=3.0),
    )
    _state["vlm_sem"] = asyncio.Semaphore(max(1, VLM_CONCURRENCY))
    print(
        f"[tracker] startup; model={MODEL_PATH} fps={TARGET_FPS} h={SNAPSHOT_HEIGHT} "
        f"classes={sorted(ALLOWED_CLASSES)} "
        f"min_frames={MIN_TRACK_FRAMES} vote_window={VOTE_WINDOW} "
        f"vote_majority={VOTE_MAJORITY} per_class_conf={PER_CLASS_CONF} "
        f"vlm_enabled={VLM_VERIFY_ENABLED} vlm_model={VLM_MODEL} "
        f"static_iou={STATIC_IOU_THRESHOLD} min_static_dwell_s={MIN_STATIC_DWELL_S}",
        flush=True,
    )
    # Fire-and-forget VLM probe so a misconfigured Ollama is visible in
    # logs at boot. Doesn't gate startup or change behavior.
    if VLM_VERIFY_ENABLED:
        asyncio.create_task(_self_test_vlm(), name="tracker-vlm-self-test")


async def _self_test_vlm() -> None:
    """One-shot probe that logs whether Ollama responds and whether the
    configured VLM_MODEL is loaded. Operator can act on the warning by
    pulling the model or flipping TRACKER_STATIC_REQUIRE_VERIFY=false.
    """
    client: httpx.AsyncClient = _state["vlm_client"]
    try:
        res = await client.get(
            f"{OLLAMA_BASE}/api/tags",
            timeout=httpx.Timeout(5.0),
        )
        if res.status_code != 200:
            print(
                f"[tracker] vlm self-test FAILED: {OLLAMA_BASE} → HTTP {res.status_code}",
                flush=True,
            )
            return
        data = res.json()
        models = [m.get("name", "") for m in data.get("models", []) if isinstance(m, dict)]
        present = VLM_MODEL in models
        print(
            f"[tracker] vlm self-test ok: base={OLLAMA_BASE} model={VLM_MODEL} "
            f"present={present} models={models}",
            flush=True,
        )
        if not present:
            print(
                f"[tracker] WARNING: VLM_MODEL={VLM_MODEL!r} not loaded in ollama. "
                "Static-track verification will return None → no static tracks emit "
                "while STATIC_REQUIRE_VERIFY=true. Either `ollama pull moondream` or "
                "set TRACKER_STATIC_REQUIRE_VERIFY=false.",
                flush=True,
            )
    except Exception as exc:
        print(
            f"[tracker] vlm self-test FAILED: {OLLAMA_BASE} → {exc!r}. "
            "Static tracks will be suppressed until reachable.",
            flush=True,
        )


@app.on_event("shutdown")
async def _shutdown():
    print("[tracker] shutting down all loops...", flush=True)
    trackers: dict[str, CameraTracker] = _state["trackers"]
    await asyncio.gather(*(t.stop() for t in trackers.values()), return_exceptions=True)
    if _state.get("frigate"):
        await _state["frigate"].aclose()
    if _state.get("vlm_client"):
        await _state["vlm_client"].aclose()
    print("[tracker] shutdown complete.", flush=True)


def _get_tracker(camera: str) -> CameraTracker:
    trackers: dict[str, CameraTracker] = _state["trackers"]
    if camera not in trackers:
        trackers[camera] = CameraTracker(camera, MODEL_PATH, _state["frigate"])
    return trackers[camera]


@app.get("/health")
async def health() -> JSONResponse:
    trackers: dict[str, CameraTracker] = _state["trackers"]
    return JSONResponse(
        {
            "ok": True,
            "model_path": MODEL_PATH,
            "model_present": os.path.isfile(MODEL_PATH),
            "fps": TARGET_FPS,
            "snapshot_height": SNAPSHOT_HEIGHT,
            "imgsz": IMGSZ,
            "conf_threshold": CONF_THRESHOLD,
            "iou_threshold": IOU_THRESHOLD,
            "allowed_classes": sorted(ALLOWED_CLASSES),
            "per_class_conf": PER_CLASS_CONF,
            "per_class_default_conf": PER_CLASS_DEFAULT_CONF,
            "min_track_frames": MIN_TRACK_FRAMES,
            "vote_window": VOTE_WINDOW,
            "vote_majority": VOTE_MAJORITY,
            "vlm": {
                "enabled": VLM_VERIFY_ENABLED,
                "static_require_verify": STATIC_REQUIRE_VERIFY,
                "model": VLM_MODEL,
                "base": OLLAMA_BASE,
                "timeout_s": VLM_TIMEOUT_S,
                "concurrency": VLM_CONCURRENCY,
                "verdict_ttl_s": VLM_VERDICT_TTL_S,
                "retry_cooldown_s": VLM_RETRY_COOLDOWN_S,
                "min_static_dwell_s": MIN_STATIC_DWELL_S,
                "static_iou_threshold": STATIC_IOU_THRESHOLD,
            },
            "active_cameras": [
                {
                    "camera": c,
                    "subscribers": len(t._subscribers),  # noqa: SLF001
                    "running": t._task is not None and not t._task.done(),  # noqa: SLF001
                    "has_latest": t.latest() is not None,
                    "vlm_cache_size": len(t._vlm.cache),  # noqa: SLF001
                    "vlm_in_flight": len(t._vlm.in_flight),  # noqa: SLF001
                }
                for c, t in trackers.items()
            ],
            "version": "0.1.0",
        }
    )


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket, camera: str = Query(..., min_length=1, max_length=64)):
    """Subscribe to a camera's tracker stream.

    On connect: sends the most recent payload (if any) immediately so a
    late subscriber doesn't have to wait up to LOOP_INTERVAL_S for the
    first frame.
    """
    await ws.accept()
    tracker = _get_tracker(camera)
    tracker.add_subscriber(ws)
    # Replay last payload so the UI can render immediately.
    last = tracker.latest()
    if last is not None:
        try:
            await ws.send_json(last)
        except Exception:
            pass
    try:
        while True:
            # Drop incoming frames silently; this is a one-way stream.
            # await is required so disconnects propagate.
            try:
                await ws.receive_text()
            except WebSocketDisconnect:
                break
    finally:
        tracker.remove_subscriber(ws)
        try:
            await ws.close()
        except Exception:
            pass
