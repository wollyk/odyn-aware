// Browser-side eval-corpus uploader.
//
// Drop one or more video files (or click to pick). Each file is sent as
// a raw-body POST to /api/agent/evals/upload with ?name=<filename>.
// Uploads run sequentially so an admin uploading several clips on a
// slow connection doesn't saturate the link or compete for tracker disk
// throughput.
//
// XHR (not fetch) is used because we need upload-progress events for
// the per-file progress bar, which the fetch() API still doesn't expose
// in any browser. The tracker doesn't care which client we use.
//
// Validation happens twice on the client (extension + size) so the user
// gets immediate feedback before bytes go on the wire. The tracker
// re-validates everything authoritatively.

import { useCallback, useRef, useState } from "react";

export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MB
const ALLOWED_EXTS = new Set(["mp4", "mov", "mkv", "webm", "avi"]);

export type UploadedClip = {
  path: string;
  size_bytes: number;
  mtime: number;
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

function uploadOne(
  file: File,
  onProgress: (frac: number) => void,
): Promise<UploadedClip> {
  return new Promise<UploadedClip>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadedClip);
        } catch {
          reject(new Error("bad_response"));
        }
      } else {
        let msg = `http_${xhr.status}`;
        try {
          const j = JSON.parse(xhr.responseText);
          msg = j.error || j.detail || msg;
        } catch {
          /* keep msg */
        }
        reject(new Error(msg));
      }
    });
    xhr.addEventListener("error", () => reject(new Error("network_error")));
    xhr.addEventListener("abort", () => reject(new Error("aborted")));
    xhr.open(
      "POST",
      `/api/agent/evals/upload?name=${encodeURIComponent(file.name)}`,
    );
    xhr.withCredentials = true;
    xhr.setRequestHeader(
      "content-type",
      file.type || "application/octet-stream",
    );
    xhr.send(file);
  });
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
          .mp4 .mov .mkv .webm .avi · max {formatBytes(MAX_UPLOAD_BYTES)} ·
          uploads run sequentially
        </span>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".mp4,.mov,.mkv,.webm,.avi,video/*"
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
