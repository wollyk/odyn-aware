// Browser-side eval-corpus uploader.
//
// Files are uploaded in CHUNKS to /api/agent/evals/upload/{start,chunk,
// complete}. The single-shot /upload route still exists but is bypassed
// here because the public TLS proxy in front of auroraview.tech enforces
// a 1 MB body limit on POSTs, which silently breaks anything bigger than
// a 1 MB file. Chunking sidesteps that ceiling by sending many small
// requests instead of one large one, with the server reassembling them
// on disk before forwarding to the tracker.
//
// Flow per file:
//   1. POST /upload/start { name, size } → { upload_id, max_chunk_bytes }
//   2. For each CHUNK_BYTES slice of the file, POST /upload/chunk?id&n
//      with the binary slice as the body. The server enforces strict
//      sequential ordering (n must equal nextChunkIndex), and 409s with
//      the expected number on mismatch so retries are deterministic.
//   3. POST /upload/complete?id&name → tracker JSON
//
// Uploads run sequentially across files so an admin uploading several
// clips on a slow connection doesn't saturate the link.

import { useCallback, useRef, useState } from "react";

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
// Chunk size on the wire. The public TLS proxy in front of
// auroraview.tech is configured with client_max_body_size ~64KB
// (verified by probing chunk sizes against /upload/chunk), so every
// individual request body has to land below that. 48 KB gives ample
// headroom for HTTP+TLS framing overhead. The server advertises its
// own ceiling via /upload/start's max_chunk_bytes; we clamp to the
// smaller of the two below.
const CHUNK_BYTES = 48 * 1024;
// `.zip` is for image-sequence uploads (e.g. UCSD dataset folders).
// The tracker extracts the zip into a sequence directory under the
// corpus dir. Production inference uses single JPEG snapshots, so a
// frame sequence is the most representative offline input shape.
const ALLOWED_EXTS = new Set(["mp4", "mov", "mkv", "webm", "avi", "zip"]);

export type UploadedClip = {
  path: string;
  kind?: "video" | "sequence";
  size_bytes: number;
  mtime: number;
  frames?: number;
};

export type UploadDropzoneProps = {
  /** Called once per file after the tracker confirms the write. */
  onUploaded: (clip: UploadedClip) => void;
  /** Optional: existing corpus paths, to reject duplicates client-side. */
  existingPaths?: string[];
  /** Optional: render disabled (e.g. tracker secret unset). */
  disabled?: boolean;
};

type QueueItem = {
  id: string;
  file: File;
  status: "queued" | "uploading" | "done" | "error";
  progress: number; // 0..1
  error: string | null;
};

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function extOf(name: string) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

type StartResponse = { upload_id: string; max_chunk_bytes?: number };

async function _postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON — likely an upstream nginx error page (413, 502, …) */
  }
  if (!res.ok) {
    const errObj = (parsed ?? {}) as { error?: string; detail?: string };
    const msg = errObj.error || errObj.detail || `HTTP_${res.status}`;
    throw new Error(msg);
  }
  return parsed as T;
}

async function _putChunk(
  uploadId: string,
  n: number,
  chunk: Blob,
): Promise<void> {
  const res = await fetch(
    `/api/agent/evals/upload/chunk?id=${encodeURIComponent(uploadId)}&n=${n}`,
    {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/octet-stream" },
      body: chunk,
    },
  );
  if (!res.ok) {
    let msg = `HTTP_${res.status}`;
    try {
      const j = (await res.json()) as { error?: string; detail?: string };
      msg = j.error || j.detail || msg;
    } catch {
      /* keep msg */
    }
    throw new Error(msg);
  }
}

async function uploadOne(
  file: File,
  onProgress: (frac: number) => void,
): Promise<UploadedClip> {
  // 1. Start the chunked session so we have an upload_id.
  const start = await _postJson<StartResponse>(
    "/api/agent/evals/upload/start",
    { name: file.name, size: file.size, content_type: file.type || null },
  );
  const uploadId = start.upload_id;
  if (!uploadId) throw new Error("no_upload_id");

  // The server advertises its own max chunk size; honor it if it's
  // smaller than our default. Larger is fine — we just clamp to our
  // safe default to keep individual requests below the proxy ceiling.
  const chunkSize = Math.min(start.max_chunk_bytes ?? CHUNK_BYTES, CHUNK_BYTES);
  const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

  // 2. Push each chunk sequentially. Progress is reported on chunk
  // boundaries — finer than per-chunk byte counts would buy us, given
  // 512 KB chunks and a typical ~10 MB/s wifi link.
  let sent = 0;
  for (let i = 0; i < totalChunks; i += 1) {
    const start_b = i * chunkSize;
    const end_b = Math.min(file.size, start_b + chunkSize);
    const slice = file.slice(start_b, end_b);
    await _putChunk(uploadId, i, slice);
    sent = end_b;
    onProgress(file.size > 0 ? sent / file.size : 1);
  }

  // 3. Finalize. The server streams the assembled file to the tracker
  // over loopback (no public-proxy nginx) and returns the tracker's
  // UploadedClip JSON verbatim.
  const final = await _postJson<UploadedClip>(
    `/api/agent/evals/upload/complete?id=${encodeURIComponent(uploadId)}&name=${encodeURIComponent(file.name)}`,
    {},
  );
  return final;
}

export function UploadDropzone({
  onUploaded,
  existingPaths = [],
  disabled = false,
}: UploadDropzoneProps) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Refs so the queue worker has fresh state without re-running on every render.
  const itemsRef = useRef<QueueItem[]>([]);
  itemsRef.current = items;
  const workingRef = useRef(false);

  const existing = new Set(existingPaths);

  const pump = useCallback(async () => {
    if (workingRef.current) return;
    workingRef.current = true;
    try {
      // Process strictly one-at-a-time. Re-check itemsRef on each loop so
      // newly-dropped items get picked up without restarting the worker.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const next = itemsRef.current.find((it) => it.status === "queued");
        if (!next) break;
        setItems((prev) =>
          prev.map((it) =>
            it.id === next.id ? { ...it, status: "uploading", progress: 0 } : it,
          ),
        );
        try {
          const clip = await uploadOne(next.file, (frac) => {
            setItems((prev) =>
              prev.map((it) =>
                it.id === next.id ? { ...it, progress: frac } : it,
              ),
            );
          });
          setItems((prev) =>
            prev.map((it) =>
              it.id === next.id
                ? { ...it, status: "done", progress: 1, error: null }
                : it,
            ),
          );
          onUploaded(clip);
        } catch (err) {
          const msg = err instanceof Error ? err.message : "upload_failed";
          setItems((prev) =>
            prev.map((it) =>
              it.id === next.id
                ? { ...it, status: "error", error: msg }
                : it,
            ),
          );
        }
      }
    } finally {
      workingRef.current = false;
    }
  }, [onUploaded]);

  const enqueue = useCallback(
    (files: FileList | File[]) => {
      const arr = Array.from(files);
      const additions: QueueItem[] = [];
      for (const f of arr) {
        const ext = extOf(f.name);
        if (!ALLOWED_EXTS.has(ext)) {
          additions.push({
            id: `${Date.now()}-${Math.random()}`,
            file: f,
            status: "error",
            progress: 0,
            error: `unsupported_extension (.${ext || "?"})`,
          });
          continue;
        }
        if (f.size > MAX_UPLOAD_BYTES) {
          additions.push({
            id: `${Date.now()}-${Math.random()}`,
            file: f,
            status: "error",
            progress: 0,
            error: `too_large · ${formatBytes(f.size)} > ${formatBytes(MAX_UPLOAD_BYTES)}`,
          });
          continue;
        }
        if (f.size === 0) {
          additions.push({
            id: `${Date.now()}-${Math.random()}`,
            file: f,
            status: "error",
            progress: 0,
            error: "empty_file",
          });
          continue;
        }
        if (existing.has(f.name)) {
          additions.push({
            id: `${Date.now()}-${Math.random()}`,
            file: f,
            status: "error",
            progress: 0,
            error: "duplicate (delete existing first)",
          });
          continue;
        }
        additions.push({
          id: `${Date.now()}-${Math.random()}-${f.name}`,
          file: f,
          status: "queued",
          progress: 0,
          error: null,
        });
      }
      setItems((prev) => [...prev, ...additions]);
      // Kick off the worker. It's a no-op if already running.
      queueMicrotask(() => {
        void pump();
      });
    },
    [existing, pump],
  );

  const onPick = useCallback(() => {
    inputRef.current?.click();
  }, []);

  return (
    <div className="space-y-2">
      <div
        onDragOver={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (disabled) return;
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) enqueue(e.dataTransfer.files);
        }}
        onClick={() => {
          if (disabled) return;
          onPick();
        }}
        className={[
          "flex flex-col items-center justify-center gap-1 border border-dashed px-4 py-5 font-mono text-xs uppercase tracking-widest transition-colors",
          disabled
            ? "border-foreground/10 bg-foreground/[0.01] text-foreground/30"
            : dragOver
              ? "cursor-copy border-emerald-500/50 bg-emerald-500/[0.06] text-emerald-300"
              : "cursor-pointer border-foreground/20 bg-foreground/[0.02] text-foreground/55 hover:border-foreground/35 hover:text-foreground/75",
        ].join(" ")}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled}
      >
        <span>
          {disabled
            ? "uploads disabled (tracker secret unset)"
            : "drop video clips here · or click to pick"}
        </span>
        <span className="text-[10px] normal-case tracking-normal text-foreground/40">
          .mp4 .mov .mkv .webm .avi · or .zip of image frames (.tif .jpg .png) ·
          max {formatBytes(MAX_UPLOAD_BYTES)} · uploads run sequentially
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".mp4,.mov,.mkv,.webm,.avi,.zip,video/*,application/zip"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              enqueue(e.target.files);
            }
            e.target.value = "";
          }}
        />
      </div>
      {items.length > 0 && (
        <ul className="space-y-1">
          {items.map((it) => (
            <li
              key={it.id}
              className="flex items-center gap-2 border border-foreground/10 bg-foreground/[0.02] px-2 py-1 font-mono text-[11px]"
            >
              <span className="flex-1 truncate text-foreground/85">
                {it.file.name}
              </span>
              <span className="shrink-0 text-foreground/50">
                {formatBytes(it.file.size)}
              </span>
              {it.status === "uploading" && (
                <span className="flex w-24 items-center gap-1 shrink-0">
                  <span className="relative h-1 flex-1 bg-foreground/15">
                    <span
                      className="absolute left-0 top-0 h-full bg-sky-400"
                      style={{ width: `${Math.round(it.progress * 100)}%` }}
                    />
                  </span>
                  <span className="w-8 text-right text-sky-300">
                    {Math.round(it.progress * 100)}%
                  </span>
                </span>
              )}
              {it.status === "queued" && (
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-foreground/45">
                  queued
                </span>
              )}
              {it.status === "done" && (
                <span className="shrink-0 text-[10px] uppercase tracking-widest text-emerald-400">
                  ✓ uploaded
                </span>
              )}
              {it.status === "error" && (
                <span
                  className="shrink-0 text-[10px] uppercase tracking-widest text-red-300"
                  title={it.error ?? ""}
                >
                  ✕ {it.error}
                </span>
              )}
              {(it.status === "done" || it.status === "error") && (
                <button
                  type="button"
                  onClick={() =>
                    setItems((prev) => prev.filter((p) => p.id !== it.id))
                  }
                  className="shrink-0 text-foreground/35 hover:text-foreground/85"
                  aria-label="dismiss"
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
