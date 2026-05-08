"""
AuroraView weapon-detector sidecar.

A small HTTP service that wraps an ultralytics YOLOv8 model and surfaces
"suspicious object" detections to the Node harness. Mirrors the
services/face-embedder/ pattern (separate venv, separate systemd unit,
FastAPI on a private loopback port).

Why "suspicious object" not "weapon"
------------------------------------
YOLOv8n out-of-the-box is trained on COCO, which doesn't have firearms.
Stage 1 (this file) ships with COCO and surfaces classes that have a
plausible weapon meaning *in some contexts*: knife, baseball bat,
scissors. Stage 2 (later) will load a fine-tuned firearm model in
parallel and union the detections under the same `suspicious_object_score`.

The reviewer's design feedback was explicit on this: "Frame it as
suspicious-object / safety alerting, not weapon certainty." We follow
that consistently — the API never claims "weapon detected", just
"suspicious object: <class> at <confidence>".

Endpoints
---------
GET  /health
    -> {"ok": true, "model": "...", "loaded_in_ms": <int>,
        "suspicious_classes": [...], "version": "..."}

POST /detect   (multipart/form-data with field "image")
    -> {
         "ok": true,
         "model": "yolov8n",
         "took_ms": <int>,
         "detections": [
            {"class_id": int, "class_name": str, "confidence": float,
             "bbox": [x1, y1, x2, y2]},
            ...
         ],
         "suspicious_object_score": <float in [0,1]>,
         "suspicious_class": <str|null>,        // best matching class name
         "suspicious_count": <int>              // total suspicious detections
       }

Why ultralytics and not raw ONNX
--------------------------------
Stage 1: ultralytics is a single dependency that handles model download,
NMS, letterboxing, and class names with no glue code. ~700MB of torch
overhead per process is acceptable on the prod box (41GB free disk).
Stage 2 (firearm model) reuses the same code path with a different .pt.

If we later need to drop torch, the migration is mechanical: export
yolov8n.pt → yolov8n.onnx via `ultralytics export`, swap `from ultralytics
import YOLO` for an onnxruntime+NMS shim. The HTTP surface stays the same.
"""
from __future__ import annotations

import io
import os
import sys
import time
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

# Defaults. All overridable via env, set by the systemd unit.
DEFAULT_MODEL = os.environ.get("WEAPON_MODEL", "yolov8n.pt")
# Comma-separated COCO class names treated as "suspicious".
# (Lowercase. We match against ultralytics' model.names case-insensitive.)
DEFAULT_SUSPICIOUS = os.environ.get(
    "WEAPON_SUSPICIOUS_CLASSES",
    "knife,scissors,baseball bat",
)
# Detector confidence floor below which a detection is dropped entirely.
DEFAULT_CONF = float(os.environ.get("WEAPON_CONF_THRESHOLD", "0.35"))
# IoU for NMS (ultralytics default).
DEFAULT_IOU = float(os.environ.get("WEAPON_IOU_THRESHOLD", "0.45"))
# Inference image size (square). 640 is YOLOv8 default; smaller = faster.
DEFAULT_IMGSZ = int(os.environ.get("WEAPON_IMGSZ", "640"))

# Loaded lazily so unit tests can import without pulling 700MB of torch.
_app_state: dict[str, Any] = {
    "model": None,
    "model_name": DEFAULT_MODEL,
    "loaded_in_ms": 0,
    "class_names": {},  # {id: name}
    "suspicious_ids": set(),
}


def _suspicious_ids_from_names(names: dict[int, str], suspicious_csv: str) -> set[int]:
    """Map a comma-separated CSV of class names to a set of class ids."""
    wanted = {n.strip().lower() for n in suspicious_csv.split(",") if n.strip()}
    out: set[int] = set()
    for cid, cname in names.items():
        if cname.lower() in wanted:
            out.add(int(cid))
    return out


def _load_model():
    """Load YOLO once. Returns the model instance."""
    if _app_state["model"] is not None:
        return _app_state["model"]
    from ultralytics import YOLO  # heavy import; do lazily

    t0 = time.monotonic()
    # `YOLO("yolov8n.pt")` downloads the weights on first run and caches
    # them under the user's torch home (~/.cache/ultralytics or HOME var).
    model = YOLO(_app_state["model_name"])
    # Names is a dict {0: "person", 1: "bicycle", ...}.
    names = {int(k): str(v) for k, v in (model.names or {}).items()}
    _app_state["model"] = model
    _app_state["class_names"] = names
    _app_state["suspicious_ids"] = _suspicious_ids_from_names(names, DEFAULT_SUSPICIOUS)
    _app_state["loaded_in_ms"] = int((time.monotonic() - t0) * 1000)
    return model


api = FastAPI(title="auroraview-weapon-detector", version="0.1.0")


@api.on_event("startup")
def _warmup() -> None:
    # Eagerly load at boot so the first request isn't slow.
    try:
        _load_model()
        names = _app_state["class_names"]
        sus_names = sorted(names[i] for i in _app_state["suspicious_ids"] if i in names)
        print(
            f"[weapon-detector] {_app_state['model_name']} loaded in "
            f"{_app_state['loaded_in_ms']}ms; suspicious={sus_names}",
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[weapon-detector] FATAL: model load failed: {exc}", flush=True)
        raise


@api.get("/health")
def health() -> JSONResponse:
    model = _app_state["model"]
    sus_names = sorted(
        _app_state["class_names"].get(i, str(i))
        for i in _app_state["suspicious_ids"]
    )
    return JSONResponse(
        {
            "ok": model is not None,
            "model": _app_state["model_name"],
            "loaded_in_ms": _app_state["loaded_in_ms"],
            "suspicious_classes": sus_names,
            "conf_threshold": DEFAULT_CONF,
            "iou_threshold": DEFAULT_IOU,
            "imgsz": DEFAULT_IMGSZ,
            "version": "0.1.0",
        }
    )


def _decode_image(raw: bytes):
    """JPEG/PNG bytes -> PIL.Image RGB. ultralytics accepts PIL directly."""
    try:
        im = Image.open(io.BytesIO(raw))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad_image: {exc}") from exc
    # Honor EXIF orientation so phone uploads aren't sideways.
    return ImageOps.exif_transpose(im).convert("RGB")


@api.post("/detect")
async def detect(image: UploadFile = File(...)) -> JSONResponse:
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"bad_content_type: {image.content_type}")
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty_body")

    model = _load_model()
    pil = _decode_image(raw)

    t0 = time.monotonic()
    # verbose=False keeps the systemd journal sane.
    # ultralytics returns a list (length 1 for single image input).
    preds = model.predict(
        pil,
        conf=DEFAULT_CONF,
        iou=DEFAULT_IOU,
        imgsz=DEFAULT_IMGSZ,
        verbose=False,
        device="cpu",
    )
    took_ms = int((time.monotonic() - t0) * 1000)

    detections: list[dict] = []
    sus_score = 0.0
    sus_class: str | None = None
    sus_count = 0
    if preds:
        result = preds[0]
        boxes = getattr(result, "boxes", None)
        if boxes is not None and len(boxes) > 0:
            # .xyxy: tensor(N, 4)  .cls: tensor(N,)  .conf: tensor(N,)
            xyxy = boxes.xyxy.cpu().numpy()
            cls_ids = boxes.cls.cpu().numpy().astype(int)
            confs = boxes.conf.cpu().numpy()
            names = _app_state["class_names"]
            sus = _app_state["suspicious_ids"]
            for i in range(len(xyxy)):
                cid = int(cls_ids[i])
                conf = float(confs[i])
                cname = names.get(cid, str(cid))
                bbox = [float(v) for v in xyxy[i].tolist()]
                detections.append(
                    {
                        "class_id": cid,
                        "class_name": cname,
                        "confidence": conf,
                        "bbox": bbox,
                    }
                )
                if cid in sus:
                    sus_count += 1
                    if conf > sus_score:
                        sus_score = conf
                        sus_class = cname

    return JSONResponse(
        {
            "ok": True,
            "model": _app_state["model_name"],
            "took_ms": took_ms,
            "detections": detections,
            "suspicious_object_score": sus_score,
            "suspicious_class": sus_class,
            "suspicious_count": sus_count,
        }
    )


def _print_routes() -> None:
    """Useful for ops: dump the routes list when called as `python app.py routes`."""
    for r in api.routes:
        methods = ",".join(sorted(getattr(r, "methods", set()) - {"HEAD"}))
        print(f"  {methods:8s}  {r.path}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "routes":
        _print_routes()
        sys.exit(0)
    import uvicorn  # noqa: E402

    host = os.environ.get("WEAPON_DETECTOR_HOST", "127.0.0.1")
    port = int(os.environ.get("WEAPON_DETECTOR_PORT", "8766"))
    uvicorn.run(api, host=host, port=port, log_level="info")
