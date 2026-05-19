"""
AuroraView face-embedder sidecar.

Tiny HTTP service that wraps InsightFace's `buffalo_l` pack.
Runs CPU-only on the same VPS as the Node API; lifecycle is managed by
systemd (services/face-embedder/face-embedder.service).

Endpoints
---------
GET  /health
    -> {"ok": true, "model": "...", "loaded_in_ms": <int>, "version": "..."}

POST /embed   (multipart/form-data with field "image")
    -> {
         "ok": true,
         "model": "buffalo_l",
         "vec_dim": 512,
         "took_ms": <int>,
         "faces": [
            {"bbox": [x1, y1, x2, y2], "quality": <float>, "embedding": [512 floats]},
            ...
         ]
       }

POST /similarity
    JSON body: { "a": [..512 floats..], "b": [..512 floats..] }
    -> {"ok": true, "cosine": <float in [-1, 1]>}
    Convenience endpoint for the Node side to validate without
    re-implementing the math (Node side does its own cosine for the hot
    path; this is for diagnostics).

Why this isn't merged into the Node process
--------------------------------------------
1. InsightFace + onnxruntime are Python-only ergonomic.
2. Loading a 256MB model into the API server's heap would blow our
   systemctl restart budget (we just fixed the 90s drain).
3. The sidecar can be replaced or moved to a GPU box later without
   touching server/api.mjs — only the env var FACE_EMBEDDER_URL changes.

Single-file by design — the only Python in this repo.
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
from typing import Any

import numpy as np
import json

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps

# Load InsightFace lazily so unit tests can import this module without
# pulling 250MB of model weights.
_app_state: dict[str, Any] = {"face_app": None, "loaded_in_ms": 0}


def _load_face_app():
    """Load InsightFace buffalo_l once. Returns the FaceAnalysis instance."""
    if _app_state["face_app"] is not None:
        return _app_state["face_app"]
    from insightface.app import FaceAnalysis  # heavy import, do it lazily

    t0 = time.monotonic()
    providers = ["CPUExecutionProvider"]
    fa = FaceAnalysis(name="buffalo_l", providers=providers)
    # ctx_id=-1 forces CPU. det_size: 640 is a good speed/recall balance for
    # cameras at ~720p+. The detector internally rescales.
    fa.prepare(ctx_id=-1, det_size=(640, 640))
    _app_state["face_app"] = fa
    _app_state["loaded_in_ms"] = int((time.monotonic() - t0) * 1000)
    return fa


api = FastAPI(title="auroraview-face-embedder", version="0.1.0")


@api.on_event("startup")
def _warmup() -> None:
    # Eagerly load the model at boot so the first request isn't slow.
    # If this fails, we let the process die so systemd can surface the error.
    try:
        _load_face_app()
        print(
            f"[face-embedder] buffalo_l loaded in {_app_state['loaded_in_ms']}ms",
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"[face-embedder] FATAL: model load failed: {exc}", flush=True)
        # Re-raise so uvicorn exits with non-zero, systemd will retry.
        raise


@api.get("/health")
def health() -> JSONResponse:
    fa = _app_state["face_app"]
    return JSONResponse(
        {
            "ok": fa is not None,
            "model": "buffalo_l",
            "vec_dim": 512,
            "loaded_in_ms": _app_state["loaded_in_ms"],
            "version": "0.1.0",
        }
    )


def _decode_image(raw: bytes) -> np.ndarray:
    """JPEG/PNG bytes -> RGB ndarray (H, W, 3) uint8 -> BGR for InsightFace."""
    try:
        im = Image.open(io.BytesIO(raw))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad_image: {exc}") from exc
    # Honor EXIF orientation so phone uploads aren't rotated.
    im = ImageOps.exif_transpose(im).convert("RGB")
    arr = np.asarray(im)
    # InsightFace expects BGR (it wraps OpenCV under the hood).
    return arr[:, :, ::-1].copy()


@api.post("/embed")
async def embed(image: UploadFile = File(...)) -> JSONResponse:
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"bad_content_type: {image.content_type}")
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty_body")

    fa = _load_face_app()
    bgr = _decode_image(raw)

    t0 = time.monotonic()
    faces = fa.get(bgr)  # list of insightface.app.common.Face
    took_ms = int((time.monotonic() - t0) * 1000)

    out = []
    for f in faces:
        # f.embedding is float32 (512,). Normalize once here so the Node
        # side can use plain dot product instead of full cosine.
        emb = np.asarray(f.embedding, dtype=np.float32)
        n = float(np.linalg.norm(emb))
        if n > 0:
            emb = emb / n
        bbox = [float(x) for x in f.bbox.tolist()]
        # det_score = detector confidence; ranges roughly 0..1 in our setup.
        quality = float(getattr(f, "det_score", 0.0))
        out.append(
            {
                "bbox": bbox,
                "quality": quality,
                "embedding": emb.tolist(),
            }
        )

    return JSONResponse(
        {
            "ok": True,
            "model": "buffalo_l",
            "vec_dim": 512,
            "took_ms": took_ms,
            "faces": out,
        }
    )


@api.post("/crop")
async def crop_face(
    image: UploadFile = File(...),
    bbox: str = Form(...),
    max_px: int = Form(256),
    padding: float = Form(0.12),
) -> Response:
    """Crop a face region from a JPEG/PNG and return a small JPEG thumbnail."""
    if image.content_type and not image.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail=f"bad_content_type: {image.content_type}")
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty_body")
    try:
        box = json.loads(bbox)
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            raise ValueError("bbox must be [x1,y1,x2,y2]")
        x1, y1, x2, y2 = (float(box[0]), float(box[1]), float(box[2]), float(box[3]))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad_bbox: {exc}") from exc

    try:
        im = Image.open(io.BytesIO(raw))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"bad_image: {exc}") from exc
    im = ImageOps.exif_transpose(im).convert("RGB")
    w, h = im.size
    bw = max(1.0, x2 - x1)
    bh = max(1.0, y2 - y1)
    pad = max(0.0, min(float(padding), 0.5))
    px = bw * pad
    py = bh * pad
    left = int(max(0, min(w - 1, x1 - px)))
    top = int(max(0, min(h - 1, y1 - py)))
    right = int(max(left + 1, min(w, x2 + px)))
    bottom = int(max(top + 1, min(h, y2 + py)))
    cropped = im.crop((left, top, right, bottom))
    max_px = max(32, min(int(max_px), 512))
    cropped.thumbnail((max_px, max_px), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    cropped.save(out, format="JPEG", quality=85, optimize=True)
    return Response(content=out.getvalue(), media_type="image/jpeg")


@api.post("/similarity")
async def similarity(body: dict) -> JSONResponse:
    a = np.asarray(body.get("a") or [], dtype=np.float32)
    b = np.asarray(body.get("b") or [], dtype=np.float32)
    if a.size == 0 or b.size == 0 or a.size != b.size:
        raise HTTPException(status_code=400, detail="bad_vectors")
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0 or nb == 0:
        raise HTTPException(status_code=400, detail="zero_norm")
    cos = float(np.dot(a, b) / (na * nb))
    return JSONResponse({"ok": True, "cosine": cos})


def _print_routes() -> None:
    """Useful for ops: dump the routes list when called as `python app.py routes`."""
    for r in api.routes:
        methods = ",".join(sorted(getattr(r, "methods", set()) - {"HEAD"}))
        print(f"  {methods:8s}  {r.path}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "routes":
        _print_routes()
        sys.exit(0)
    # Allow `python app.py` for local dev. systemd uses uvicorn directly.
    import uvicorn  # noqa: E402

    host = os.environ.get("FACE_EMBEDDER_HOST", "127.0.0.1")
    port = int(os.environ.get("FACE_EMBEDDER_PORT", "8765"))
    uvicorn.run(api, host=host, port=port, log_level="info")
