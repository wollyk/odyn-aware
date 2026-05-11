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
import json
import os
import sys
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
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

# ---- in-memory tracking ---------------------------------------------------
_runs: dict[str, dict[str, Any]] = {}
_diffs: dict[str, dict[str, Any]] = {}


def _require_secret(x_eval_secret: str | None) -> None:
    if not EVAL_SECRET:
        raise HTTPException(503, "eval_secret_unset")
    if (x_eval_secret or "") != EVAL_SECRET:
        raise HTTPException(401, "bad_secret")


def _safe_corpus_path(rel: str) -> Path:
    """Resolve `rel` relative to CORPUS_DIR and reject escape attempts."""
    target = (CORPUS_DIR / rel).resolve()
    try:
        target.relative_to(CORPUS_DIR.resolve())
    except ValueError:
        raise HTTPException(400, "path_outside_corpus")
    if not target.is_file():
        raise HTTPException(404, "clip_not_found")
    return target


# ---- corpus listing -------------------------------------------------------
@router.get("/corpus")
async def list_corpus(x_eval_secret: str | None = Header(default=None)) -> JSONResponse:
    _require_secret(x_eval_secret)
    if not CORPUS_DIR.exists():
        return JSONResponse({"corpus_dir": str(CORPUS_DIR), "clips": []})
    clips: list[dict] = []
    for entry in sorted(CORPUS_DIR.rglob("*")):
        if not entry.is_file():
            continue
        if entry.suffix.lower() not in {".mp4", ".mov", ".mkv", ".webm", ".avi"}:
            continue
        st = entry.stat()
        clips.append(
            {
                "path": str(entry.relative_to(CORPUS_DIR)),
                "size_bytes": st.st_size,
                "mtime": st.st_mtime,
            }
        )
    return JSONResponse({"corpus_dir": str(CORPUS_DIR), "clips": clips})


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
