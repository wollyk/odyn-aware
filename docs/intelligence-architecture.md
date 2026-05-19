# AuroraView Intelligence Architecture

End-to-end reference for every piece of code that participates in producing,
filtering, persisting, or displaying a "tracked object" on the platform.
Every box in the diagrams below is a real file/function — citations are
`path::function_name`. Read this when you need to find where a bug is
likely to live, or before changing any inference behavior.

Last updated: Phase-13A (eval bench + image-sequence support).

---

## Table of contents

1. [The big picture](#the-big-picture)
2. [Live path — Frigate to browser, real time](#live-path--frigate-to-browser-real-time)
3. [Tracker decision pipeline (per frame)](#tracker-decision-pipeline-per-frame)
4. [Persistence path — observations to SQLite](#persistence-path--observations-to-sqlite)
5. [Eval bench (offline replay)](#eval-bench-offline-replay)
6. [Where bugs typically hide](#where-bugs-typically-hide)
7. [Process / deployment topology](#process--deployment-topology)

---

## The big picture

```
                ┌────────────────┐
                │ Frigate NVR    │
                │ (camera RTSPs) │
                └──────┬─────────┘
                       │ /api/<cam>/latest.jpg  (HTTPS, JWT cookie)
                       ▼
            ┌────────────────────────────┐
            │ tracker.service (Python)   │      ┌──────────────────┐
            │ services/tracker/app.py    │◀────▶│ Moondream / Ollama│
            │  - YOLOv8s + ByteTrack     │ VLM  │  192.168.0.137:11434
            │  - voter / motion / VLM    │ verify└──────────────────┘
            └─────┬───────────┬──────────┘
                  │ WS        │ HTTP POST (every 10s)
                  │ /ws       │ /api/tracker/ingest (shared secret)
                  ▼           ▼
            ┌──────────────────────────────────┐
            │ odyn-api.service (Node)          │       ┌────────────┐
            │ server/api.mjs                   │──────▶│ SQLite     │
            │  - WS proxy (admin auth)         │       │ data/*.db  │
            │  - REST API (admin auth)         │       │ - tracks   │
            │  - eval orchestrator (proxy)     │       │ - eval_runs│
            └─────┬────────────────────────────┘       └────────────┘
                  │ HTTPS via nginx (auroraview.tech)
                  ▼
            ┌────────────────────────────────────┐
            │ Browser SPA (React + TanStack)     │
            │  - /admin/live    live overlays    │
            │  - /admin/map     plan view + dots │
            │  - /admin/tracks  historical table │
            │  - /admin/evals   replay + diff    │
            └────────────────────────────────────┘
```

There are **three** processes and **one** external GPU service:


| process            | binary                             | port | what it owns                                                             |
| ------------------ | ---------------------------------- | ---- | ------------------------------------------------------------------------ |
| `tracker.service`  | uvicorn + Python                   | 8767 | YOLO + ByteTrack inference, motion + VLM decisions, eval CLI subprocess  |
| `odyn-api.service` | Node                               | 3001 | Admin auth, WS proxies, REST APIs, SQLite, agent chat, eval orchestrator |
| nginx              | system                             | 80   | TLS termination + path-based routing                                     |
| Ollama (external)  | container on `192.168.0.137:11434` | —    | Moondream 1.6B VLM (yes/no verification)                                 |


---

## Live path — Frigate to browser, real time

The "real-time" path is **every 200 ms** (5 Hz) per camera that has at
least one subscribed websocket. No subscribers ⇒ no inference (the loop
is reference-counted, see `add_subscriber` / `_delayed_stop`).

### Per-frame call chain

```
1. CameraTracker._run_loop()       services/tracker/app.py:663
       loop while not stop_event:
            await _tick()
            sleep(0.2)

2. CameraTracker._tick()           services/tracker/app.py:808
       jpeg = await frigate.get_snapshot(camera, 720)
       pil  = Image.open(jpeg) -> exif_transpose -> RGB
       (tracks, verify_queue) = await asyncio.to_thread(_infer_and_classify, pil)
       payload = {type:"tick", camera, tick_at, image_w/h, took_ms, tracks}
       await _broadcast(payload)
       for (tid, label, jpeg) in verify_queue:
            create_task(_verify_track(...))   # fire-and-forget VLM

3. FrigateClient.get_snapshot()    services/tracker/app.py:271
       GET https://127.0.0.1:3000/api/<cam>/latest.jpg?h=720
       Cookie: frigate_token=<jwt>
       (auto-relogin on 401)

4. CameraTracker._infer_and_classify(pil)   services/tracker/app.py:861
       (see "Tracker decision pipeline" section below)

5. CameraTracker._broadcast(payload)        services/tracker/app.py:1044
       for ws in subscribers: ws.send_json(payload)

6. CameraTracker._verify_track(tid, label, jpeg)   services/tracker/app.py:704
       async with vlm_sem:                        # global concurrency cap (default 2)
           verdict = await _call_ollama_yes_no(...)
       if verdict is not None:
           self._vlm.cache[(tid,label)] = (verdict, ts)

7. _call_ollama_yes_no(client, label, jpeg)  services/tracker/app.py:466
       POST {OLLAMA_BASE}/api/generate
       {model: "moondream:latest",
        prompt: f"Look at this cropped image. Does it show a {label}? Answer with only 'yes' or 'no'.",
        images: [base64(jpeg)],
        options: {temperature: 0.0, num_predict: 6}}
       parse first token: "yes" -> True, "no" -> False, else None
```

### Browser side (WS subscriber)

```
A. useTracker hook                 src/features/live/useTracker.ts
       wss://auroraview.tech/api/tracker/<cam>
       onmessage -> setLatest({tracks, image_w, image_h, took_ms})

B. VideoTile overlay               src/features/live/VideoTile.tsx
       <canvas> sized to MSE video element bounds
       for each track in latest.tracks:
           draw rect at (bbox.x*W, bbox.y*H, bbox.w*W, bbox.h*H)
           color by motion (moving=sky, static=amber, warming=gray)
           label = `${id}·${label}·${conf}` + (verified===false ? "!" : "")

C. Map dots                        src/features/map/useAllTrackers.ts
       opens N parallel WS (one per camera)
       merges all tracks -> projectTrackToMap() -> ProjectedDot[]
       <MapObjectsLayer> renders dots on the konva canvas
```

### Network hops on the live path


| hop | from          | to            | protocol       | auth                    |
| --- | ------------- | ------------- | -------------- | ----------------------- |
| 0   | browser       | nginx :443    | HTTPS          | session cookie          |
| 1   | nginx         | Node :3001    | HTTP (Upgrade) | passes through          |
| 2   | Node WS proxy | tracker :8767 | WS             | none (loopback)         |
| 3   | tracker       | Frigate :3000 | HTTPS          | JWT cookie (per-camera) |
| 4   | tracker       | Ollama :11434 | HTTP           | none (LAN)              |


The WS proxy is `server/routes/cameras.mjs` (see `wsHandler` exports
hooked in `server/api.mjs`). Admin auth is enforced at the upgrade
handshake — see `server/http-utils.mjs::requireAdmin`.

---

## Tracker decision pipeline (per frame)

This is the heart of the system. `_infer_and_classify(pil)` runs this
chain on every detection box returned by YOLO+ByteTrack:

```
Step  Function / file                                  Drops?  Reason
────  ───────────────────────────────────────────────  ──────  ─────────────────────
1.    model.track(pil, persist=True, tracker=...)              YOLOv8s + ByteTrack
        services/tracker/app.py:875
        emits xyxy / track_id / cls / conf for each box

2.    _BBoxHistory.update(tid, xyxy, ts)                       record motion sample
        services/tracker/app.py:337

3.    _TrackVoter.update(tid, cls, conf, ts)                   modal-class voting
        services/tracker/app.py:535
        returns (modal_cls | None, avg_conf, frames_in_window)

4.    if frames < MIN_TRACK_FRAMES (3) or voted=None    DROP   one-frame flicker
        services/tracker/app.py:931                             or no clear winner

5.    label = names[voted_cls].lower()
      if ALLOWED_CLASSES and label not in allowed       DROP   class filter
        services/tracker/app.py:934

6.    floor = PER_CLASS_CONF.get(label, default_conf)
      if voted_conf < floor                             DROP   per-class conf floor
        services/tracker/app.py:937                             (default 0.55, person=0.50)

7.    if w<=0 or h<=0                                   DROP   degenerate bbox
        services/tracker/app.py:941

8.    is_static = _BBoxHistory.is_static(tid)
        services/tracker/app.py:356  →  IoU(oldest,newest) >= 0.85 over 8-frame window
                                            AND >=5 frames present
        returns True / False / None (warming)

9.    if VLM_VERIFY_ENABLED and is_static:
         cached = _VLMVerifier.cached(tid, label, ts)
         services/tracker/app.py:396
         if cached.verdict is True:                            keep, mark verified=True
         elif cached.verdict is False:                  DROP   VLM said no
         else (no cache):
            dwell = _BBoxHistory.static_for_s(tid, ts)
            eligible = (dwell >= MIN_STATIC_DWELL_S    [enqueue VLM call after broadcast]
                        and not in_flight
                        and cooled_down >= 30s)
            if STATIC_REQUIRE_VERIFY:                  DROP   miss > mistag until verified

10.   bbox_norm = [x/W, y/H, w/W, h/H]                         (broadcast payload)
      session = _sessions[tid] | new                           (Phase-11B persistence)
      session.{last_seen_ms, frames_seen+=1, bbox, label, conf, motion, verified}
      out.append({id, label, conf, bbox, motion, verified, session_id})
```

After the per-detection loop, GC runs every frame:

- `_TrackVoter.gc(now)` — drops tracks unseen for `TRACK_TTL_S` (5 s)
- `_BBoxHistory.gc(now)` — same
- `_VLMVerifier.gc(now)` — drops cache entries older than `4*TRACK_TTL_S`
- `_gc_sessions(now)` — drops sessions older than `SESSION_TTL_S` (120 s)

### Key constants and where to tune them


| constant                 | default | env var                          | controls                                          |
| ------------------------ | ------- | -------------------------------- | ------------------------------------------------- |
| `CONF_THRESHOLD`         | 0.30    | `TRACKER_CONF`                   | YOLO raw conf gate (cheap up-front filter)        |
| `IOU_THRESHOLD`          | 0.45    | `TRACKER_IOU`                    | ByteTrack assignment IoU                          |
| `IMGSZ`                  | 640     | `TRACKER_IMGSZ`                  | YOLO input image size                             |
| `MIN_TRACK_FRAMES`       | 3       | `TRACKER_MIN_FRAMES`             | flicker gate                                      |
| `VOTE_WINDOW`            | 8       | `TRACKER_VOTE_WINDOW`            | voter ring buffer size                            |
| `VOTE_MAJORITY`          | 0.6     | `TRACKER_VOTE_MAJORITY`          | modal-class threshold                             |
| `PER_CLASS_DEFAULT_CONF` | 0.55    | `TRACKER_PER_CLASS_DEFAULT_CONF` | voted conf floor (fallback)                       |
| `PER_CLASS_CONF[person]` | 0.50    | `TRACKER_PER_CLASS_CONF`         | per-class voted conf floor                        |
| `MOTION_WINDOW`          | 8       | `TRACKER_MOTION_WINDOW`          | motion ring buffer size                           |
| `MIN_MOTION_FRAMES`      | 5       | `TRACKER_MIN_MOTION_FRAMES`      | min samples before is_static returns non-None     |
| `STATIC_IOU_THRESHOLD`   | 0.85    | `TRACKER_STATIC_IOU`             | IoU(oldest,newest) above this = "static"          |
| `MIN_STATIC_DWELL_S`     | 2.0     | `TRACKER_MIN_STATIC_DWELL_S`     | wait this long before triggering VLM              |
| `STATIC_REQUIRE_VERIFY`  | true    | `TRACKER_STATIC_REQUIRE_VERIFY`  | suppress unverified statics                       |
| `VLM_VERDICT_TTL_S`      | 300     | `TRACKER_VLM_VERDICT_TTL_S`      | how long a yes/no verdict stays valid             |
| `VLM_RETRY_COOLDOWN_S`   | 30      | `TRACKER_VLM_RETRY_COOLDOWN_S`   | min gap between VLM retries for same (tid, label) |
| `VLM_CONCURRENCY`        | 2       | `TRACKER_VLM_CONCURRENCY`        | semaphore on simultaneous Moondream calls         |


---

## Persistence path — observations to SQLite

The tracker does **not** open the DB directly. It POSTs batches every
10 s; Node owns the schema.

```
1. CameraTracker._run_ingest_loop()              services/tracker/app.py:729
       sleeps INGEST_INTERVAL_S (10s), then _flush_to_ingest()

2. CameraTracker._flush_to_ingest()              services/tracker/app.py:759
       observations = [for each fresh session: {
           session_id, track_id, label, conf, bbox, motion,
           verified, frames_seen, first_seen_ms, last_seen_ms
       }]
       POST http://127.0.0.1:3001/api/tracker/ingest
       Headers: X-Tracker-Secret: <env TRACKER_INGEST_SECRET>
       Body: {camera, observations}

3. Node ingest handler                           server/routes/agent-tracks.mjs
       verifies X-Tracker-Secret == process.env.TRACKER_INGEST_SECRET
       upserts each observation into the `tracks` table
         (session_id PRIMARY KEY, camera, label, ..., last_seen_ms)

4. Stale-closer                                  server/db/tracks.mjs
       on every ingest, closes any session whose last_seen_ms is older
       than INGEST_FRESH_WINDOW_S (30s).
```

### Admin reads

- `GET /api/agent/tracks` — server/routes/agent-tracks.mjs → DB → JSON
- `/admin/tracks` page — src/routes/admin/tracks.tsx fetches above, renders table

---

## Eval bench (offline replay)

The eval bench replays a video (or now, an image sequence) through the
**same** decision classes as production. The point: A/B test config
changes without standing in front of a real camera.

### Source of truth: `eval.py` imports from `app.py`

```python
# services/tracker/eval.py:55
from app import (
    ALLOWED_CLASSES, CONF_THRESHOLD, IMGSZ, IOU_THRESHOLD,
    MIN_STATIC_DWELL_S, MIN_TRACK_FRAMES, MODEL_PATH,
    PER_CLASS_CONF, PER_CLASS_DEFAULT_CONF, STATIC_REQUIRE_VERIFY,
    _BBoxHistory, _iou_xyxy, _TrackVoter, _VLMVerifier,
)
```

If you change app.py's pipeline, the eval reflects it on the next run.
**Do not** copy-paste these classes into a sibling module.

### Eval run lifecycle

```
1. Browser: /admin/evals new-run form
       src/routes/admin/evals.tsx → submitRun()
       POST /api/agent/evals/run {clip, config, vlm, max_frames, fps}

2. Node admin route                              server/routes/agent-evals.mjs:124
       requireAdmin() -> trackerFetch("/eval/run", POST)
       upsertEvalRun(db, ...)  -> server/db/evals.mjs

3. Tracker run endpoint                          services/tracker/eval_routes.py:110
       _safe_corpus_path(clip)  -> absolute path
       writes config.json
       spawns `python eval.py run ...` as subprocess
       returns {run_id, status:"running", started_at}

4. eval.py run subprocess                        services/tracker/eval.py:144
       cap = cv2.VideoCapture(video)  OR  dir iterator
       model = YOLO(MODEL_PATH)
       voter = _TrackVoter(); bhist = _BBoxHistory(); vlm = _VLMVerifier() if cfg.vlm
       for each frame:
           pil = _frame_to_pil(frame)
           results = model.track(pil, persist=True, tracker="bytetrack.yaml", ...)
           for each box:
               # mirrors prod _infer_and_classify exactly
               bhist.update(tid, xyxy, ts)
               voted_cls, voted_conf, frames = voter.update(tid, cls, conf, ts)
               if frames < min_track_frames: suppress "below_min_frames_or_no_majority"
               if label not in allowed:      suppress "class_not_allowed:<label>"
               if voted_conf < floor:        suppress "below_conf_floor:<label>"
               if degenerate bbox:           suppress "degenerate_bbox"
               # VLM is *counted* but not called — see eval.py:295
               if cfg.vlm and is_static and not cached and cfg.static_require_verify:
                                             suppress "vlm_pending:<label>"
               emit {id, label, raw_label, conf, bbox, motion, verified}
       writes JSONL: {header} {frame...} {frame...} {summary}

5. Polling                                       src/routes/admin/evals.tsx
       useEffect interval 5s while any row.status === "running"
       GET /api/agent/evals      -> hydrates summary from tracker
       GET /api/agent/evals/:id  -> single row + live status

6. Playback                                       src/features/evals/EvalPlayer.tsx
       <video src="/api/agent/evals/:id/clip"> (HTTP Range-supported)
       fetches /raw JSONL, parses frames
       requestAnimationFrame:
           findClosestFrameByTime(video.currentTime)
           clear canvas, draw bboxes from that frame's tracks

7. Diff                                           src/routes/admin/evals.tsx → runDiff()
       POST /api/agent/evals/diff {a, b}
       Node -> tracker /eval/diff -> spawns eval.py diff subprocess
       per-frame IoU matching of tracks, returns
       {matched_track_frames, tracks_only_in_a/b, label_changes, delta stats}
```

### Eval data on disk

```
/var/lib/auroraview-tracker/eval-corpus/         <- uploaded clips live here
  clip-001.mp4
  ucsd-test001/                                  <- image sequence (directory)
    001.tif
    002.tif
    ...
/var/lib/auroraview-tracker/evals/               <- run outputs
  <run_id>.jsonl                                 <- per-frame trace + header + summary
  <run_id>.log                                   <- subprocess stdout/stderr
  <run_id>.config.json                           <- the config overrides
  diff-<diff_id>.json
```

### Eval ↔ prod symmetry — what differs?

The eval pipeline matches prod **exactly** in:

- model + tracker (YOLOv8s + ByteTrack), conf/IoU/imgsz
- voter + motion classifier + VLM cache shape
- suppression order and labels

It differs from prod in:

- **VLM verification is counted but never actually called.** The eval
records `suppression_reasons["vlm_pending:<label>"]` for each box
that *would* have queued a VLM call, but doesn't open a socket to
Moondream. To smoke the live VLM you have to run against a real
camera.
- **Per-frame "now" is synthetic.** `now_ts = kept_idx / target_fps`,
so motion-dwell calculations are deterministic and reproducible
but won't match wall-clock cadence.
- **No fan-out to WS subscribers / no Phase-11B ingest.** Pure
classifier — no networking, no broadcasts.

---

## Where bugs typically hide

Cross-reference this list with the eval's `suppression_reasons` field
when something "should be detected but isn't":


| symptom                                           | first place to look                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| nothing detected                                  | `CONF_THRESHOLD` too high, or `MODEL_PATH` missing → `model.track` returns 0 boxes                       |
| boxes flicker on/off                              | `MIN_TRACK_FRAMES` too low, OR vote majority not reached (raw labels swapping)                           |
| stuff labeled as "couch" / "umbrella"             | `ALLOWED_CLASSES` includes the wrong noise class, or `PER_CLASS_CONF[bad_label]` floor too low           |
| moving objects shown but parked car never appears | VLM rejected it (`vlm_rejected:<label>` in suppression), OR VLM never called (cooldown / in-flight loop) |
| labels strobe between two classes                 | `VOTE_WINDOW` too short — increase to 12-16                                                              |
| brand-new track delayed by ~1s                    | working as designed: `MIN_TRACK_FRAMES * (1/TARGET_FPS)` = 3 * 200 ms                                    |
| static person at door never appears               | `STATIC_REQUIRE_VERIFY=true` AND VLM is unreachable (check `_VLMVerifier.cooled_down`)                   |
| persistence missing in `/admin/tracks`            | `TRACKER_INGEST_SECRET` mismatch between tracker env and Node env, or POST timing out                    |
| live overlay drifts behind video                  | `image_w/h` in WS payload ≠ MSE video pixel dims — see `VideoTile.tsx` scale calc                        |
| eval result != prod behavior                      | check eval.py's "**no VLM HTTP call**" caveat above, OR config overrides hash differs                    |


### Specific functions worth re-reading when debugging


| concern                                                | function                                                | file                              |
| ------------------------------------------------------ | ------------------------------------------------------- | --------------------------------- |
| "why is this box being dropped"                        | `_infer_and_classify`                                   | services/tracker/app.py:861       |
| "why is motion classified wrong"                       | `_BBoxHistory.update` + `is_static`                     | services/tracker/app.py:337       |
| "why is the label flickering"                          | `_TrackVoter.update`                                    | services/tracker/app.py:535       |
| "why isn't the VLM answering"                          | `_call_ollama_yes_no` + `_verify_track`                 | services/tracker/app.py:466 / 704 |
| "why isn't the static dot showing up after VLM verify" | `VLM_VERDICT_TTL_S` expiry, or cache miss after restart |                                   |
| "why aren't sessions persisting"                       | `_flush_to_ingest` + `agent-tracks.mjs ingest handler`  | services/tracker/app.py:759       |


---

## Process / deployment topology

```
                ┌─────────────────────────────────────────────┐
                │ VPS: 173.230.68.75 / auroraview.tech        │
                │ Ubuntu 24.04, Node 22, Python 3.12          │
                │                                             │
                │  nginx 80 ────────┬─ /api/cam/stream/ → WS proxy → Frigate
                │                   ├─ /api/tracker/    → WS proxy → tracker
                │                   ├─ /api/agent/evals/upload (512 MB)
                │                   ├─ /api/                    (64 KB)
                │                   └─ /                        → static SPA dist
                │                                             │
                │  systemd: odyn-api.service                  │
                │   /var/www/odyn-aware/current/server/api.mjs│
                │   port 3001, EnvironmentFile=api.env        │
                │                                             │
                │  systemd: tracker.service                   │
                │   .venv/bin/python -m uvicorn app:app       │
                │   /var/www/odyn-aware/current/services/tracker
                │   port 8767, EnvironmentFile=api.env        │
                │   home=/var/lib/auroraview-tracker          │
                │      ├─ yolov8s.pt          (model weights) │
                │      ├─ eval-corpus/        (uploaded clips)│
                │      ├─ evals/              (run outputs)   │
                │      └─ .config/Ultralytics                 │
                │                                             │
                │  SQLite at /var/www/odyn-aware/data/*.db    │
                └─────────────────────────────────────────────┘
                              │ external
                              ▼
                ┌────────────────────────────┐
                │ Ollama on 192.168.0.137    │
                │   moondream:latest (VLM)   │
                └────────────────────────────┘
```

### Where each env var is read

- Tracker (Python): `os.environ.get(...)` at module top of
`services/tracker/app.py` (lines 53-228) — values from
`/etc/odyn-aware/api.env` via systemd `EnvironmentFile`.
- Node: `process.env.X` in `server/api.mjs` and the route modules.
- Frontend: nothing read at runtime; only Vite build-time `import.meta.env`.

### How a change reaches prod

```
local: edit code -> npm run deploy
  ├─ git commit + push origin deploy/vps-static-and-api
  ├─ ssh tracker host: git pull, npm ci, npm run build,
  │                    systemctl restart odyn-api
  ├─ verify remote HEAD == local HEAD
  └─ smoke-test public URL

  (Python changes also need:  ssh + systemctl restart tracker)
```

When in doubt: `journalctl -u tracker -n 100 --no-pager` and
`journalctl -u odyn-api -n 100 --no-pager`.