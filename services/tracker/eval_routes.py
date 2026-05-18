"""HTTP surface for Phase-13A eval runs.

Three endpoints, mounted as an APIRouter into the tracker's FastAPI app:

  GET  /eval/corpus           list video files in TRACKER_EVAL_CORPUS_DIR
  POST /eval/run              spawn `python eval.py run …` as a subprocess
  GET  /eval/status/{run_id}  return process state + tail of stdout
  GET  /eval/result/{run_id}  return header + summary (full JSONL via raw)
  GET  /eval/result/{run_id}/raw  stream the JSONL itself
  POST /eval/diff             spawn `python eval.py diff …`
  GET  /eval/diff/{diff_id}   return diff JSON

Authn: this surface is reachable only via the Node API proxy (which is
admin-gated). We additionally require a shared secret in
`X-Eval-Secret` to match `TRACKER_EVAL_SECRET` (same shape as the
existing ingest secret) so a misconfigured nginx can't accidentally
expose this on the open internet.

State: in-memory dict of run_id → asyncio.subprocess.Process. Survives
multiple concurrent runs (each loads its own YOLO model — ~70 MB
each). On tracker restart, all in-flight evals lose their status entry
but their output JSONL on disk is intact.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import re
import shutil
import sys
import time
import uuid
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/eval", tags=["eval"])

# ---- config ---------------------------------------------------------------
CORPUS_DIR = Path(
    os.environ.get("TRACKER_EVAL_CORPUS_DIR", "/var/lib/auroraview-tracker/eval-corpus")
)
RUNS_DIR = Path(
    os.environ.get("TRACKER_EVAL_RUNS_DIR", "/var/lib/auroraview-tracker/evals")
)
EVAL_SECRET = os.environ.get("TRACKER_EVAL_SECRET", "").strip()
EVAL_PY = Path(__file__).resolve().parent / "eval.py"

# Hard cap on a single uploaded clip. Defaults to 500 MB so the admin UI
# can upload typical 1080p test footage without surprises. Configurable
# via env so we can shrink it on tiny instances.
MAX_UPLOAD_BYTES = int(
    os.environ.get("TRACKER_EVAL_MAX_UPLOAD_BYTES", str(500 * 1024 * 1024))
)
ALLOWED_VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".webm", ".avi"}
# Image-sequence support: a .zip upload is extracted to a directory
# under CORPUS_DIR, and that directory then behaves as a single "clip"
# in the corpus listing. The image extensions below are the ones we
# allow inside a zip — anything else is silently skipped on extract
# (so __MACOSX/, .DS_Store, .gt, README.txt etc. don't poison the dir).
ALLOWED_IMAGE_EXTS = {".tif", ".tiff", ".jpg", ".jpeg", ".png", ".bmp", ".webp"}
ALLOWED_UPLOAD_EXTS = ALLOWED_VIDEO_EXTS | {".zip"}
# Hard cap on individual file count inside a zip (DoS guard). UCSD's
# longest test clip is 200 frames; 5000 covers any reasonable surveillance
# clip while preventing a malicious zip from spawning a million files.
MAX_SEQUENCE_FRAMES = int(os.environ.get("TRACKER_EVAL_MAX_SEQUENCE_FRAMES", "5000"))

# ---- in-memory tracking ---------------------------------------------------
_runs: dict[str, dict[str, Any]] = {}
_diffs: dict[str, dict[str, Any]] = {}


def _require_secret(x_eval_secret: str | None) -> None:
    if not EVAL_SECRET:
        raise HTTPException(503, "eval_secret_unset")
    if (x_eval_secret or "") != EVAL_SECRET:
        raise HTTPException(401, "bad_secret")


def _safe_corpus_path(rel: str) -> Path:
    """Resolve `rel` relative to CORPUS_DIR and reject escape attempts.

    Accepts EITHER a video file OR an image-sequence directory. The
    eval CLI handles both; callers that need a specific kind should
    check `target.is_file()` themselves.
    """
    target = (CORPUS_DIR / rel).resolve()
    try:
        target.relative_to(CORPUS_DIR.resolve())
    except ValueError:
        raise HTTPException(400, "path_outside_corpus")
    if not (target.is_file() or target.is_dir()):
        raise HTTPException(404, "clip_not_found")
    return target


def _count_sequence_frames(dir_path: Path) -> int:
    """Count image files in a sequence directory (non-recursive)."""
    try:
        return sum(
            1 for p in dir_path.iterdir()
            if p.is_file()
            and not p.name.startswith(".")
            and p.suffix.lower() in ALLOWED_IMAGE_EXTS
        )
    except OSError:
        return 0


def _dir_size_bytes(dir_path: Path) -> int:
    """Sum size of all images in a sequence directory (non-recursive)."""
    total = 0
    try:
        for p in dir_path.iterdir():
            if p.is_file() and p.suffix.lower() in ALLOWED_IMAGE_EXTS:
                try:
                    total += p.stat().st_size
                except OSError:
                    pass
    except OSError:
        pass
    return total


# ---- corpus listing -------------------------------------------------------
@router.get("/corpus")
async def list_corpus(x_eval_secret: str | None = Header(default=None)) -> JSONResponse:
    """List clips in CORPUS_DIR.

    A "clip" is either:
      - a single video file at the top level (kind: "video")
      - a subdirectory containing image files (kind: "sequence")

    Only top-level entries are reported. Image files INSIDE sequence
    directories are never listed individually — that would clutter
    the dropdown to thousands of entries for a single dataset.
    """
    _require_secret(x_eval_secret)
    if not CORPUS_DIR.exists():
        return JSONResponse({"corpus_dir": str(CORPUS_DIR), "clips": []})
    clips: list[dict] = []
    try:
        entries = sorted(CORPUS_DIR.iterdir(), key=lambda p: p.name.lower())
    except OSError:
        entries = []
    for entry in entries:
        if entry.name.startswith("."):
            continue
        if entry.is_file() and entry.suffix.lower() in ALLOWED_VIDEO_EXTS:
            st = entry.stat()
            clips.append(
                {
                    "path": entry.name,
                    "kind": "video",
                    "size_bytes": st.st_size,
                    "mtime": st.st_mtime,
                }
            )
        elif entry.is_dir():
            n = _count_sequence_frames(entry)
            if n == 0:
                continue
            st = entry.stat()
            clips.append(
                {
                    "path": entry.name,
                    "kind": "sequence",
                    "frames": n,
                    "size_bytes": _dir_size_bytes(entry),
                    "mtime": st.st_mtime,
                }
            )
    return JSONResponse({"corpus_dir": str(CORPUS_DIR), "clips": clips})


# ---- corpus upload --------------------------------------------------------
#
# Raw-body POST (NOT multipart) so we don't have to add python-multipart
# to the tracker venv. The browser side uses `xhr.send(file)` with a
# `?name=...` query parameter for the filename. Content-Type carries the
# MIME from the file picker (informational only — we validate by suffix).
#
# Safety:
#   - filename is reduced to its basename + must match an allowed suffix
#   - duplicates are rejected (409) so re-uploading doesn't silently
#     replace an existing clip that may already be referenced by runs
#   - size is capped at MAX_UPLOAD_BYTES via early Content-Length check
#     AND via streaming byte count (Content-Length can lie)
#   - bytes are streamed to a hidden `.tmp.<uuid>.<name>` file then
#     atomically renamed into place. A crash mid-upload leaves a tmp
#     file but never a partial clip with the final name.

@router.post("/corpus/upload", response_model=None)
async def upload_corpus(
    request: Request,
    name: str = Query(..., min_length=1, max_length=255),
    x_eval_secret: str | None = Header(default=None),
) -> JSONResponse:
    _require_secret(x_eval_secret)

    safe_name = Path(name).name  # strip any directory components from name
    if not safe_name or safe_name.startswith("."):
        raise HTTPException(400, "invalid_filename")
    suffix = Path(safe_name).suffix.lower()
    if suffix not in ALLOWED_UPLOAD_EXTS:
        raise HTTPException(415, "unsupported_extension")
    is_zip = suffix == ".zip"

    # Cheap up-front rejection from Content-Length. Browsers always send
    # it for non-chunked uploads, so we can short-circuit oversized files
    # before reading a single byte.
    cl_raw = request.headers.get("content-length")
    if cl_raw:
        try:
            cl = int(cl_raw)
        except ValueError:
            cl = -1
        if cl == 0:
            raise HTTPException(400, "empty_upload")
        if cl > MAX_UPLOAD_BYTES:
            raise HTTPException(413, "file_too_large")

    CORPUS_DIR.mkdir(parents=True, exist_ok=True)

    # For zips, the on-disk "clip" is the EXTRACTED DIRECTORY, named
    # after the zip with the .zip suffix stripped. Duplicate check
    # uses that directory name so re-uploading the same dataset twice
    # is a 409.
    if is_zip:
        dir_name = Path(safe_name).stem
        if not dir_name:
            raise HTTPException(400, "invalid_filename")
        dest_dir = CORPUS_DIR / dir_name
        if dest_dir.exists():
            raise HTTPException(409, "clip_exists")
    else:
        dest = CORPUS_DIR / safe_name
        if dest.exists():
            raise HTTPException(409, "clip_exists")

    # Stream bytes to a hidden .tmp file regardless of upload kind.
    # Atomic rename happens at the end (single video) or after zip
    # extraction (image sequence).
    tmp = CORPUS_DIR / f".tmp.{uuid.uuid4().hex}.{safe_name}"
    bytes_written = 0
    try:
        with open(tmp, "wb") as fout:
            async for chunk in request.stream():
                if not chunk:
                    continue
                bytes_written += len(chunk)
                if bytes_written > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, "file_too_large")
                fout.write(chunk)
        if bytes_written == 0:
            raise HTTPException(400, "empty_upload")

        if is_zip:
            # Extract the zip into a sibling tmp directory, then
            # rename atomically. We never extract directly into
            # dest_dir — a crash mid-extract would leave a half-
            # populated dir under the final name.
            tmp_extract = CORPUS_DIR / f".tmp.{uuid.uuid4().hex}.extract"
            tmp_extract.mkdir(parents=True, exist_ok=False)
            try:
                frames_extracted = _extract_sequence_zip(tmp, tmp_extract)
            except HTTPException:
                shutil.rmtree(tmp_extract, ignore_errors=True)
                raise
            if frames_extracted == 0:
                shutil.rmtree(tmp_extract, ignore_errors=True)
                raise HTTPException(400, "zip_contains_no_images")
            os.replace(tmp_extract, dest_dir)
            tmp.unlink(missing_ok=True)
            st = dest_dir.stat()
            return JSONResponse(
                {
                    "path": dir_name,
                    "kind": "sequence",
                    "frames": frames_extracted,
                    "size_bytes": _dir_size_bytes(dest_dir),
                    "mtime": st.st_mtime,
                }
            )

        os.replace(tmp, dest)
    except HTTPException:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        raise
    except Exception as exc:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        raise HTTPException(500, f"write_failed: {exc}") from exc

    st = dest.stat()
    return JSONResponse(
        {
            "path": safe_name,
            "kind": "video",
            "size_bytes": st.st_size,
            "mtime": st.st_mtime,
        }
    )


def _extract_sequence_zip(zip_path: Path, out_dir: Path) -> int:
    """Extract image files from `zip_path` into `out_dir` (flat).

    Behavior:
      - Any directory hierarchy inside the zip is FLATTENED — only the
        basename survives. UCSD's zips usually have one top-level dir;
        flattening means the operator doesn't have to know whether it's
        present.
      - Files outside ALLOWED_IMAGE_EXTS are silently skipped (so
        __MACOSX/, .DS_Store, README, .gt masks etc. don't poison the
        sequence).
      - Directory traversal attempts (../, absolute paths, symlinks)
        are rejected; the flatten step makes that hard but we re-check.
      - Hard caps to keep one bad zip from being a DoS vector:
          MAX_SEQUENCE_FRAMES file count
          MAX_UPLOAD_BYTES   uncompressed total

    Returns the count of image files written.
    """
    if not zipfile.is_zipfile(zip_path):
        raise HTTPException(400, "not_a_zip")
    n_written = 0
    total_uncompressed = 0
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            base = Path(info.filename).name
            if not base or base.startswith("."):
                continue
            suffix = Path(base).suffix.lower()
            if suffix not in ALLOWED_IMAGE_EXTS:
                continue
            # Defense in depth: refuse anything that looks like a path
            # escape even after flattening (some zips embed null bytes
            # or odd separators).
            if "/" in base or "\\" in base or ".." in base:
                continue
            if n_written >= MAX_SEQUENCE_FRAMES:
                raise HTTPException(413, "too_many_frames_in_zip")
            # Avoid the zip-bomb shape (1 MB compressed → 10 GB
            # uncompressed). file_size is the uncompressed size from
            # the zip header — if it's wildly larger than the cap, bail.
            total_uncompressed += int(info.file_size)
            if total_uncompressed > MAX_UPLOAD_BYTES * 4:
                # Allow 4x headroom for headers/etc — adjust if real
                # datasets push past this.
                raise HTTPException(413, "zip_uncompressed_too_large")
            dest_file = out_dir / base
            with zf.open(info, "r") as src_f, open(dest_file, "wb") as dst_f:
                shutil.copyfileobj(src_f, dst_f, length=1024 * 64)
            n_written += 1
    return n_written


@router.delete("/corpus/{name}")
async def delete_corpus(
    name: str,
    x_eval_secret: str | None = Header(default=None),
) -> JSONResponse:
    """Delete a clip from CORPUS_DIR (video file OR sequence directory).

    Runs that referenced this clip stay on disk and remain queryable
    (their JSONL is unaffected), but `GET /eval/clip/{run_id}` and
    `/eval/sequence/{run_id}/...` will start returning 404 once the
    source clip is gone. The admin UI surfaces that with a "clip
    missing" badge.
    """
    _require_secret(x_eval_secret)
    target = _safe_corpus_path(name)
    try:
        if target.is_dir():
            shutil.rmtree(target)
        else:
            target.unlink()
    except FileNotFoundError:
        raise HTTPException(404, "clip_not_found")
    except OSError as exc:
        raise HTTPException(500, f"delete_failed: {exc}") from exc
    return JSONResponse({"deleted": name})


# ---- run ------------------------------------------------------------------
class RunReq(BaseModel):
    clip: str = Field(..., description="path relative to CORPUS_DIR")
    config: dict[str, Any] = Field(default_factory=dict)
    vlm: bool = False
    max_frames: int | None = None
    fps: float | None = None
    # Optional human-readable label for the run.
    name: str | None = None


@router.post("/run")
async def run_eval(
    req: RunReq,
    x_eval_secret: str | None = Header(default=None),
) -> JSONResponse:
    _require_secret(x_eval_secret)
    clip = _safe_corpus_path(req.clip)
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    run_id = uuid.uuid4().hex
    out_path = RUNS_DIR / f"{run_id}.jsonl"
    log_path = RUNS_DIR / f"{run_id}.log"

    config_path: Path | None = None
    if req.config:
        config_path = RUNS_DIR / f"{run_id}.config.json"
        config_path.write_text(json.dumps(req.config, indent=2), encoding="utf-8")

    argv: list[str] = [
        sys.executable,
        str(EVAL_PY),
        "run",
        "--video", str(clip),
        "--out", str(out_path),
        "--run-id", run_id,
    ]
    if config_path:
        argv += ["--config", str(config_path)]
    if req.vlm:
        argv.append("--vlm")
    if req.max_frames:
        argv += ["--max-frames", str(req.max_frames)]
    if req.fps:
        argv += ["--fps", str(req.fps)]

    log_fh = log_path.open("wb")
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=log_fh,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(EVAL_PY.parent),
    )
    _runs[run_id] = {
        "run_id": run_id,
        "name": req.name or clip.name,
        "clip": req.clip,
        "config": req.config,
        "out_path": str(out_path),
        "log_path": str(log_path),
        "started_at": time.time(),
        "pid": proc.pid,
        "process": proc,
        "log_fh": log_fh,
        "status": "running",
    }
    # Reap in the background so the dict reflects exit cleanly.
    asyncio.create_task(_reap(run_id), name=f"eval-reap-{run_id}")

    return JSONResponse(
        {
            "run_id": run_id,
            "name": _runs[run_id]["name"],
            "clip": req.clip,
            "out_path": str(out_path),
            "status": "running",
            "started_at": _runs[run_id]["started_at"],
        }
    )


async def _reap(run_id: str) -> None:
    entry = _runs.get(run_id)
    if not entry:
        return
    proc: asyncio.subprocess.Process = entry["process"]
    code = await proc.wait()
    entry["status"] = "ok" if code == 0 else "failed"
    entry["exit_code"] = code
    entry["finished_at"] = time.time()
    try:
        entry["log_fh"].close()
    except Exception:
        pass


# ---- status ---------------------------------------------------------------
@router.get("/status/{run_id}")
async def run_status(
    run_id: str,
    tail: int = Query(default=2048, ge=0, le=65536),
    x_eval_secret: str | None = Header(default=None),
) -> JSONResponse:
    _require_secret(x_eval_secret)
    entry = _runs.get(run_id)
    if not entry:
        # Cold lookup: the run may have completed before a tracker
        # restart. Reconstruct as much as we can from the output file.
        out_path = RUNS_DIR / f"{run_id}.jsonl"
        log_path = RUNS_DIR / f"{run_id}.log"
        if not out_path.exists():
            raise HTTPException(404, "unknown_run")
        return JSONResponse(
            {
                "run_id": run_id,
                "status": "ok",
                "out_path": str(out_path),
                "log_tail": _tail_text(log_path, tail),
                "cold": True,
            }
        )
    log_tail = _tail_text(Path(entry["log_path"]), tail)
    return JSONResponse(
        {
            "run_id": run_id,
            "status": entry["status"],
            "started_at": entry.get("started_at"),
            "finished_at": entry.get("finished_at"),
            "exit_code": entry.get("exit_code"),
            "out_path": entry["out_path"],
            "log_tail": log_tail,
            "pid": entry.get("pid"),
        }
    )


def _tail_text(path: Path, n_bytes: int) -> str:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            start = max(0, size - n_bytes)
            f.seek(start)
            data = f.read()
        return data.decode("utf-8", errors="replace")
    except FileNotFoundError:
        return ""


# ---- result (header + summary) -------------------------------------------
@router.get("/result/{run_id}")
async def run_result(
    run_id: str,
    x_eval_secret: str | None = Header(default=None),
) -> JSONResponse:
    _require_secret(x_eval_secret)
    out_path = RUNS_DIR / f"{run_id}.jsonl"
    if not out_path.exists():
        raise HTTPException(404, "no_output")
    header: dict | None = None
    summary: dict | None = None
    frames_count = 0
    with out_path.open("r", encoding="utf-8") as f:
        for line in f:
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
            elif t == "summary":
                summary = obj
            elif t == "frame":
                frames_count += 1
    return JSONResponse(
        {
            "run_id": run_id,
            "header": header,
            "summary": summary,
            "frames_in_file": frames_count,
            "complete": summary is not None,
        }
    )


@router.get("/result/{run_id}/raw")
async def run_result_raw(
    run_id: str,
    x_eval_secret: str | None = Header(default=None),
) -> FileResponse:
    _require_secret(x_eval_secret)
    out_path = RUNS_DIR / f"{run_id}.jsonl"
    if not out_path.exists():
        raise HTTPException(404, "no_output")
    return FileResponse(str(out_path), media_type="application/x-ndjson")


# ---- clip streaming (with HTTP Range support) ----------------------------
#
# The eval admin UI plays the source MP4 with overlaid bboxes from the
# JSONL. <video> needs Range support so the browser can scrub without
# re-downloading from byte 0. Starlette's FileResponse does NOT honor
# Range automatically, so we implement the bytes=START-END math here.
#
# Source path is read from the run's JSONL header — that's the canonical
# record of which clip this run was generated from, surviving file
# renames in the corpus (header path is the resolved absolute path that
# the eval CLI actually opened).
#
# Security: the resolved path MUST live under CORPUS_DIR. Without that
# check, a malicious run_id holder who could write a JSONL with a
# crafted header could potentially read arbitrary files. The tracker
# runs under ProtectSystem=strict so the blast radius is small, but
# defense in depth.

_MIME_BY_SUFFIX = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
}


def _read_run_header(run_id: str) -> dict:
    """Parse the JSONL header for a run. Raises HTTPException on errors."""
    out_path = RUNS_DIR / f"{run_id}.jsonl"
    if not out_path.exists():
        raise HTTPException(404, "no_output")
    try:
        with out_path.open("r", encoding="utf-8") as f:
            first_line = f.readline().strip()
        header = json.loads(first_line) if first_line else {}
    except Exception:
        raise HTTPException(500, "bad_header")
    if header.get("type") != "header":
        raise HTTPException(500, "bad_header")
    return header


def _resolve_run_clip(run_id: str) -> Path:
    """Return the absolute corpus path of the source VIDEO file for a run.

    For image-sequence runs this raises 404 with code "clip_is_sequence"
    so the player knows to switch to the sequence-frame endpoints.
    """
    header = _read_run_header(run_id)
    raw = header.get("video", "")
    if not raw:
        raise HTTPException(404, "no_clip_path_in_header")
    video_path = Path(raw)
    try:
        video_path.resolve().relative_to(CORPUS_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "clip_outside_corpus")
    if video_path.is_dir():
        # Sequences can't be served via <video>; tell the player
        # explicitly so it falls back to /sequence/{run_id}/frame/{N}.
        raise HTTPException(404, "clip_is_sequence")
    if not video_path.is_file():
        raise HTTPException(404, "clip_missing")
    return video_path


def _resolve_run_sequence(run_id: str) -> tuple[Path, list[Path]]:
    """Return (dir_path, sorted_image_files) for a sequence run.

    Raises 404 if the run isn't a sequence, or the dir is gone.
    """
    header = _read_run_header(run_id)
    raw = header.get("video", "")
    if not raw:
        raise HTTPException(404, "no_clip_path_in_header")
    dir_path = Path(raw)
    try:
        dir_path.resolve().relative_to(CORPUS_DIR.resolve())
    except ValueError:
        raise HTTPException(403, "clip_outside_corpus")
    if not dir_path.is_dir():
        raise HTTPException(404, "clip_not_sequence")
    files = sorted(
        p for p in dir_path.iterdir()
        if p.is_file()
        and not p.name.startswith(".")
        and p.suffix.lower() in ALLOWED_IMAGE_EXTS
    )
    if not files:
        raise HTTPException(404, "sequence_empty")
    return dir_path, files


@router.get("/clip/{run_id}", response_model=None)
async def run_clip(
    run_id: str,
    request: Request,
    x_eval_secret: str | None = Header(default=None),
) -> StreamingResponse | FileResponse:
    """Stream the source MP4 with HTTP Range support so the player can
    scrub without re-downloading the file."""
    _require_secret(x_eval_secret)
    video_path = _resolve_run_clip(run_id)
    file_size = video_path.stat().st_size
    suffix = video_path.suffix.lower()
    media_type = _MIME_BY_SUFFIX.get(suffix, "application/octet-stream")

    range_header = request.headers.get("range") or request.headers.get("Range")
    if not range_header:
        # Full-file response. FileResponse handles ETag / Last-Modified.
        return FileResponse(
            str(video_path),
            media_type=media_type,
            headers={"Accept-Ranges": "bytes"},
        )

    # Parse "bytes=START-END" — END is optional and inclusive when present.
    m = re.match(r"bytes=(\d*)-(\d*)$", range_header.strip())
    if not m:
        raise HTTPException(416, "bad_range")
    start_s, end_s = m.group(1), m.group(2)
    if start_s == "" and end_s == "":
        raise HTTPException(416, "bad_range")
    if start_s == "":
        # "bytes=-N" → last N bytes.
        suffix_len = int(end_s)
        if suffix_len <= 0:
            raise HTTPException(416, "bad_range")
        start = max(0, file_size - suffix_len)
        end = file_size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else file_size - 1
    end = min(end, file_size - 1)
    if start < 0 or start > end:
        raise HTTPException(416, "range_unsatisfiable")
    chunk_size = end - start + 1

    def iter_chunk():
        with open(video_path, "rb") as f:
            f.seek(start)
            remaining = chunk_size
            while remaining > 0:
                read_size = min(64 * 1024, remaining)
                data = f.read(read_size)
                if not data:
                    break
                remaining -= len(data)
                yield data

    return StreamingResponse(
        iter_chunk(),
        status_code=206,
        media_type=media_type,
        headers={
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(chunk_size),
        },
    )


# ---- sequence streaming (per-frame, for image-sequence runs) -------------
#
# The browser can't play a directory of TIFFs via <video>. For sequence
# runs the player asks for a manifest (frame count + frame size + fps)
# and then fetches each frame on demand. Frames are decoded server-side
# with PIL and re-encoded as JPEG so the browser doesn't need a TIFF
# decoder. The eval JSONL already carries the synthesized fps in the
# header (matches the playback timebase used by the per-frame draw).

@router.get("/sequence/{run_id}/manifest")
async def sequence_manifest(
    run_id: str,
    x_eval_secret: str | None = Header(default=None),
) -> JSONResponse:
    _require_secret(x_eval_secret)
    header = _read_run_header(run_id)
    _, files = _resolve_run_sequence(run_id)
    return JSONResponse(
        {
            "run_id": run_id,
            "frame_count": len(files),
            "width": int(header.get("video_w") or 0),
            "height": int(header.get("video_h") or 0),
            "fps": float(header.get("target_fps") or header.get("video_fps") or 10.0),
        }
    )


@router.get("/sequence/{run_id}/frame/{n}", response_model=None)
async def sequence_frame(
    run_id: str,
    n: int,
    x_eval_secret: str | None = Header(default=None),
) -> Response:
    """Return the Nth (0-indexed) frame of a sequence run as JPEG.

    Decoding happens on every request; cheap (TIFF→PIL→JPEG at q=85
    is ~5-10ms for 320×240 UCSD frames). If this ever becomes a hot
    path we can cache to disk, but for an admin-only eval UI it's
    not worth the complexity.
    """
    _require_secret(x_eval_secret)
    _, files = _resolve_run_sequence(run_id)
    if n < 0 or n >= len(files):
        raise HTTPException(404, "frame_out_of_range")
    src_path = files[n]
    try:
        from PIL import Image

        with Image.open(src_path) as im:
            rgb = im.convert("RGB")
            buf = io.BytesIO()
            rgb.save(buf, format="JPEG", quality=85, optimize=False)
            jpeg = buf.getvalue()
    except Exception as exc:
        raise HTTPException(500, f"decode_failed: {exc}") from exc
    # Frames are immutable for the lifetime of the run; safe to cache
    # aggressively. The player relies on this so seeking back is instant.
    return Response(
        content=jpeg,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "public, max-age=86400, immutable",
            "Content-Length": str(len(jpeg)),
        },
    )


# ---- diff -----------------------------------------------------------------
class DiffReq(BaseModel):
    a: str = Field(..., description="run_id A")
    b: str = Field(..., description="run_id B")


@router.post("/diff")
async def run_diff(
    req: DiffReq,
    x_eval_secret: str | None = Header(default=None),
) -> JSONResponse:
    _require_secret(x_eval_secret)
    a_path = RUNS_DIR / f"{req.a}.jsonl"
    b_path = RUNS_DIR / f"{req.b}.jsonl"
    if not a_path.exists() or not b_path.exists():
        raise HTTPException(404, "run_not_found")
    diff_id = uuid.uuid4().hex
    out_path = RUNS_DIR / f"diff-{diff_id}.json"
    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        str(EVAL_PY),
        "diff",
        "--a", str(a_path),
        "--b", str(b_path),
        "--out", str(out_path),
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(EVAL_PY.parent),
    )
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        return JSONResponse(
            {"ok": False, "error": (stderr or b"").decode("utf-8", errors="replace")[:500]},
            status_code=500,
        )
    diff = json.loads(out_path.read_text(encoding="utf-8"))
    _diffs[diff_id] = {"diff_id": diff_id, "a": req.a, "b": req.b, "out_path": str(out_path)}
    return JSONResponse({"diff_id": diff_id, "diff": diff})


@router.get("/diff/{diff_id}")
async def get_diff(
    diff_id: str,
    x_eval_secret: str | None = Header(default=None),
) -> JSONResponse:
    _require_secret(x_eval_secret)
    out_path = RUNS_DIR / f"diff-{diff_id}.json"
    if not out_path.exists():
        raise HTTPException(404, "no_diff")
    return JSONResponse(json.loads(out_path.read_text(encoding="utf-8")))


# ---- listing all runs (cold reconstruction) -------------------------------
@router.get("/runs")
async def list_runs(
    x_eval_secret: str | None = Header(default=None),
    limit: int = Query(default=100, ge=1, le=500),
) -> JSONResponse:
    """List runs visible on disk (warm + cold). Sorted by mtime desc.

    Each entry includes header + summary if the JSONL is complete; if
    not, status reflects whether the producing subprocess is still
    alive in `_runs`.
    """
    _require_secret(x_eval_secret)
    if not RUNS_DIR.exists():
        return JSONResponse({"runs": []})
    entries: list[dict] = []
    files = sorted(
        (p for p in RUNS_DIR.glob("*.jsonl") if p.is_file()),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )[:limit]
    for p in files:
        rid = p.stem
        header: dict | None = None
        summary: dict | None = None
        try:
            with p.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    obj = json.loads(line)
                    if obj.get("type") == "header":
                        header = obj
                    elif obj.get("type") == "summary":
                        summary = obj
                        break  # header always precedes summary
        except Exception:
            pass
        warm = _runs.get(rid)
        status = (warm or {}).get("status") if warm else ("ok" if summary else "incomplete")
        entries.append(
            {
                "run_id": rid,
                "name": (warm or {}).get("name"),
                "status": status,
                "header": header,
                "summary": summary,
                "mtime": p.stat().st_mtime,
            }
        )
    return JSONResponse({"runs": entries})
