// /admin/evals — Phase-13A automated tracking eval bench.
//
// The operator picks a clip from the tracker's corpus, optionally tweaks
// a few knobs, kicks off a run, and sees the run land in the table when
// it finishes. They can pick two completed runs and diff them.
//
// Why this page exists: the live view is a moving target. To know
// whether tightening the per-class confidence floor actually improves
// "miss > mistag" on a real clip, you need to replay the same pixels
// twice with different config and compare. Doing that manually means
// staring at frames; this page automates the comparison.
//
// Three sections, in order:
//   [01] start a new run
//   [02] run history (newest first, polls while a run is in flight)
//   [03] diff workbench (pick two runs, view the result)

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AdminHeader,
  AuthDeniedScreen,
  AuthLoadingScreen,
  useAdminAuth,
} from "@/components/admin-shell";
import { EvalPlayer } from "@/features/evals/EvalPlayer";
import { UploadDropzone } from "@/features/evals/UploadDropzone";

export const Route = createFileRoute("/admin/evals")({
  component: AdminEvals,
});

// ---- API shapes ----------------------------------------------------------

type CorpusClip = {
  path: string;
  // `kind` distinguishes single videos from extracted image sequences.
  // Older tracker builds don't return this field; we default to "video".
  kind?: "video" | "sequence";
  frames?: number;
  size_bytes: number;
  mtime: number;
  // Set true by the tracker while an ffmpeg transcode is in flight
  // (e.g. .avi → .mp4 so the HTML5 player can decode it). The UI greys
  // out the Start Eval button and shows a "transcoding…" badge until
  // the flag clears.
  transcoding?: boolean;
  transcode_error?: string;
};

type CorpusResp = {
  corpus_dir: string;
  clips: CorpusClip[];
};

type EvalConfig = {
  conf_threshold?: number;
  iou_threshold?: number;
  imgsz?: number;
  min_track_frames?: number;
  per_class_default_conf?: number;
  per_class_conf?: Record<string, number>;
  allowed_classes?: string[];
  static_require_verify?: boolean;
  vlm_enabled?: boolean;
};

type RunSummary = {
  frames_processed?: number;
  duration_s?: number;
  wallclock_s?: number;
  unique_tracks?: number;
  tracks_with_label_switches?: number;
  label_distribution?: Record<string, number>;
  raw_label_distribution?: Record<string, number>;
  suppression_reasons?: Record<string, number>;
  infer_ms_p50?: number;
  infer_ms_p95?: number;
  infer_ms_max?: number;
  config_hash?: string;
};

type RunHeader = {
  video?: string;
  video_w?: number;
  video_h?: number;
  video_fps?: number;
  target_fps?: number;
  model?: string;
  config?: EvalConfig;
  config_hash?: string;
};

type EvalRun = {
  run_id: string;
  name: string | null;
  clip: string;
  config?: EvalConfig;
  config_hash: string | null;
  status: "running" | "ok" | "failed" | "cancelled" | "incomplete";
  out_path: string | null;
  summary: RunSummary | null;
  header: RunHeader | null;
  started_at_ms: number;
  finished_at_ms: number | null;
  created_by: string | null;
  updated_at: string;
};

type EvalListResp = { rows: EvalRun[]; count: number };

type DiffJson = {
  matched_track_frames: number;
  tracks_only_in_a: number;
  tracks_only_in_b: number;
  label_changes: Record<string, number>;
  label_distribution_delta: Record<string, number>;
  suppression_reasons_delta: Record<string, number>;
  p50_infer_ms_delta: number;
  wallclock_delta_s: number;
  a: { run_id: string; config_hash: string | null };
  b: { run_id: string; config_hash: string | null };
};

// ---- formatters ----------------------------------------------------------

function formatTime(ms: number | null | undefined) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function statusBadge(s: EvalRun["status"]) {
  if (s === "running") {
    return (
      <span className="inline-flex items-center gap-1 border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-sky-300">
        Running
      </span>
    );
  }
  if (s === "ok") {
    return (
      <span className="inline-flex items-center gap-1 border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-emerald-400">
        OK
      </span>
    );
  }
  if (s === "failed") {
    return (
      <span className="inline-flex items-center gap-1 border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-red-300">
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 border border-foreground/30 bg-foreground/5 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-foreground/60">
      {s}
    </span>
  );
}

// ---- component -----------------------------------------------------------

function AdminEvals() {
  const { state, me, logout } = useAdminAuth();

  const [corpus, setCorpus] = useState<CorpusResp | null>(null);
  const [rows, setRows] = useState<EvalRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // -- new-run form state
  const [clip, setClip] = useState("");
  const [name, setName] = useState("");
  const [vlm, setVlm] = useState(false);
  const [maxFrames, setMaxFrames] = useState<string>("");
  const [fps, setFps] = useState<string>("");
  // Optional overrides. Empty string means "use prod default".
  const [confT, setConfT] = useState<string>("");
  const [perClassDefault, setPerClassDefault] = useState<string>("");
  const [minFrames, setMinFrames] = useState<string>("");
  const [staticReq, setStaticReq] = useState<"" | "true" | "false">("");
  const [posting, setPosting] = useState(false);
  const [deletingClip, setDeletingClip] = useState(false);

  // -- diff state
  const [diffA, setDiffA] = useState<string>("");
  const [diffB, setDiffB] = useState<string>("");
  const [diff, setDiff] = useState<DiffJson | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);

  // -- player state: which run to play, scrolled-into-view container
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const playerRef = useRef<HTMLDivElement | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [corpusRes, listRes] = await Promise.all([
        fetch("/api/agent/evals/corpus", { credentials: "include" }),
        fetch("/api/agent/evals?limit=100", { credentials: "include" }),
      ]);
      if (!corpusRes.ok) throw new Error(`corpus ${corpusRes.status}`);
      if (!listRes.ok) throw new Error(`list ${listRes.status}`);
      const c = (await corpusRes.json()) as CorpusResp;
      const l = (await listRes.json()) as EvalListResp;
      setCorpus(c);
      setRows(l.rows);
      if (!clip && c.clips.length > 0) setClip(c.clips[0].path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "fetch_failed");
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (state !== "ok") return;
    fetchAll();
    // Poll while anything is running OR while any clip is mid-transcode.
    // Eval rows hydrate themselves lazily; corpus transcoding state only
    // updates on a corpus list, so we have to drive the refresh from
    // either side. 5s is a balance between snappy UI and tracker load.
    const t = setInterval(() => {
      const anyRunning = rowsRef.current.some((r) => r.status === "running");
      const anyTranscoding = (corpusRef.current?.clips ?? []).some(
        (c) => c.transcoding === true,
      );
      if (anyRunning || anyTranscoding) fetchAll();
    }, 5_000);
    return () => clearInterval(t);
  }, [state, fetchAll]);

  // Keep refs of rows + corpus so the interval closure sees fresh data
  // without having to retrigger setInterval on every state change.
  const rowsRef = useMemo(() => ({ current: rows }), [rows]);
  rowsRef.current = rows;
  const corpusRef = useMemo(() => ({ current: corpus }), [corpus]);
  corpusRef.current = corpus;

  // Resolve the currently-selected corpus clip record (or null). Used to
  // disable Start Eval + Delete while an ffmpeg transcode is in flight.
  const selectedClipRecord = useMemo(
    () => corpus?.clips.find((c) => c.path === clip) ?? null,
    [corpus, clip],
  );
  const selectedClipTranscoding = selectedClipRecord?.transcoding === true;

  async function submitRun(e: React.FormEvent) {
    e.preventDefault();
    if (!clip) return;
    setPosting(true);
    setError(null);
    try {
      const config: EvalConfig = {};
      if (confT.trim()) config.conf_threshold = Number(confT);
      if (perClassDefault.trim())
        config.per_class_default_conf = Number(perClassDefault);
      if (minFrames.trim()) config.min_track_frames = Number(minFrames);
      if (staticReq) config.static_require_verify = staticReq === "true";
      const body = {
        clip,
        name: name || clip,
        vlm,
        ...(maxFrames.trim() ? { max_frames: Number(maxFrames) } : {}),
        ...(fps.trim() ? { fps: Number(fps) } : {}),
        config,
      };
      const res = await fetch("/api/agent/evals/run", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(
          (detail && (detail.error || detail.detail)) || `run ${res.status}`,
        );
      }
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "run_failed");
    } finally {
      setPosting(false);
    }
  }

  async function deleteSelectedClip() {
    if (!clip) return;
    const confirmed = window.confirm(
      `Delete "${clip}" from the eval corpus?\n\nExisting runs that referenced this clip will keep their data but lose video playback.`,
    );
    if (!confirmed) return;
    setDeletingClip(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/agent/evals/corpus/${encodeURIComponent(clip)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(
          (detail && (detail.error || detail.detail)) ||
            `delete ${res.status}`,
        );
      }
      // After deletion, the dropdown auto-falls back to the first remaining
      // clip via fetchAll(). Clear `clip` first so the auto-select kicks in.
      setClip("");
      await fetchAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "delete_failed");
    } finally {
      setDeletingClip(false);
    }
  }

  async function runDiff() {
    if (!diffA || !diffB || diffA === diffB) {
      setError("pick two different runs to diff");
      return;
    }
    setDiffBusy(true);
    setDiff(null);
    setError(null);
    try {
      const res = await fetch("/api/agent/evals/diff", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: diffA, b: diffB }),
      });
      if (!res.ok) {
        const detail = await res.json().catch(() => null);
        throw new Error(
          (detail && (detail.error || detail.detail)) || `diff ${res.status}`,
        );
      }
      const body = await res.json();
      setDiff(body.diff as DiffJson);
    } catch (err) {
      setError(err instanceof Error ? err.message : "diff_failed");
    } finally {
      setDiffBusy(false);
    }
  }

  const completedRuns = useMemo(
    () => rows.filter((r) => r.status === "ok"),
    [rows],
  );

  if (state === "loading") return <AuthLoadingScreen />;
  if (state === "denied") return <AuthDeniedScreen />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminHeader active="evals" me={me} logout={logout} />
      <main className="mx-auto max-w-[1200px] px-6 py-6 space-y-6">
        {/* [01] new run --------------------------------------------- */}
        <section className="border border-foreground/15 bg-foreground/[0.02] p-4 space-y-4">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/55">
            [01] · new eval run
            {corpus && (
              <span className="ml-3 text-foreground/40">
                corpus · {corpus.corpus_dir} · {corpus.clips.length} clips
              </span>
            )}
          </h2>
          <UploadDropzone
            existingPaths={corpus?.clips.map((c) => c.path) ?? []}
            onUploaded={(c) => {
              setClip(c.path);
              void fetchAll();
            }}
          />
          {corpus && corpus.clips.length === 0 ? (
            <p className="font-mono text-xs text-foreground/55">
              No clips yet — drop one above to start your first eval run.
            </p>
          ) : (
            <form
              onSubmit={submitRun}
              className="grid grid-cols-1 gap-3 md:grid-cols-2"
            >
              <Field label="Clip">
                <div className="flex gap-2">
                  <select
                    value={clip}
                    onChange={(e) => setClip(e.target.value)}
                    className="flex-1 border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                    required
                  >
                    {corpus?.clips.map((c) => (
                      <option key={c.path} value={c.path}>
                        {c.path}
                        {c.kind === "sequence"
                          ? ` · seq · ${c.frames ?? "?"} frames · ${formatBytes(c.size_bytes)}`
                          : ` · ${formatBytes(c.size_bytes)}`}
                        {c.transcoding ? " · transcoding…" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={deleteSelectedClip}
                    disabled={!clip || deletingClip || selectedClipTranscoding}
                    title={
                      selectedClipTranscoding
                        ? "Wait for transcode to finish before deleting"
                        : clip
                          ? `Delete "${clip}" from corpus`
                          : "Pick a clip first"
                    }
                    className="shrink-0 border border-foreground/15 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-foreground/55 hover:border-red-400/40 hover:text-red-300 disabled:opacity-30 disabled:hover:border-foreground/15 disabled:hover:text-foreground/55"
                  >
                    {deletingClip ? "…" : "× delete"}
                  </button>
                </div>
                {selectedClipTranscoding && (
                  <p className="mt-1 font-mono text-[10px] uppercase tracking-widest text-amber-300/85">
                    transcoding to mp4 for in-browser playback — eval will be available shortly
                  </p>
                )}
                {selectedClipRecord?.transcode_error && (
                  <p
                    className="mt-1 font-mono text-[10px] uppercase tracking-widest text-red-300/85"
                    title={selectedClipRecord.transcode_error}
                  >
                    transcode failed — eval will run on source but Watch may be blank
                  </p>
                )}
              </Field>
              <Field label="Run name (optional)">
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. tighter-conf-baseline"
                  className="w-full border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                />
              </Field>
              <Field label="Conf threshold (default: prod)">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={confT}
                  onChange={(e) => setConfT(e.target.value)}
                  placeholder="0.30"
                  className="w-full border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                />
              </Field>
              <Field label="Per-class default conf (default: prod)">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="1"
                  value={perClassDefault}
                  onChange={(e) => setPerClassDefault(e.target.value)}
                  placeholder="0.55"
                  className="w-full border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                />
              </Field>
              <Field label="Min track frames (default: prod)">
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="60"
                  value={minFrames}
                  onChange={(e) => setMinFrames(e.target.value)}
                  placeholder="3"
                  className="w-full border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                />
              </Field>
              <Field label="Static-require-verify">
                <select
                  value={staticReq}
                  onChange={(e) => setStaticReq(e.target.value as typeof staticReq)}
                  className="w-full border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                >
                  <option value="">(prod default)</option>
                  <option value="true">true · suppress unverified statics</option>
                  <option value="false">false · emit all statics</option>
                </select>
              </Field>
              <Field label="Max frames (optional)">
                <input
                  type="number"
                  step="1"
                  min="1"
                  max="50000"
                  value={maxFrames}
                  onChange={(e) => setMaxFrames(e.target.value)}
                  placeholder="entire video"
                  className="w-full border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                />
              </Field>
              <Field label="Target fps (optional)">
                <input
                  type="number"
                  step="0.5"
                  min="0.5"
                  max="30"
                  value={fps}
                  onChange={(e) => setFps(e.target.value)}
                  placeholder="video fps"
                  className="w-full border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                />
              </Field>
              <label className="flex items-center gap-2 font-mono text-xs text-foreground/70">
                <input
                  type="checkbox"
                  checked={vlm}
                  onChange={(e) => setVlm(e.target.checked)}
                />
                run with VLM verification (slow, only if testing Moondream
                impact)
              </label>
              <div className="flex items-center justify-end md:col-span-2">
                <button
                  type="submit"
                  disabled={posting || !clip || selectedClipTranscoding}
                  title={
                    selectedClipTranscoding
                      ? "Wait for transcode to finish before running eval"
                      : ""
                  }
                  className="border border-foreground/30 bg-foreground/5 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-foreground/85 hover:bg-foreground/10 disabled:opacity-40"
                >
                  {posting
                    ? "starting…"
                    : selectedClipTranscoding
                      ? "transcoding…"
                      : "▶ start eval"}
                </button>
              </div>
            </form>
          )}
        </section>

        {/* [02] history --------------------------------------------- */}
        <section className="border border-foreground/15 bg-foreground/[0.02] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/55">
              [02] · run history {rows.length > 0 ? `· ${rows.length}` : ""}
            </h2>
            <button
              type="button"
              onClick={fetchAll}
              className="font-mono text-[10px] uppercase tracking-widest text-foreground/55 hover:text-foreground"
            >
              ↻ refresh
            </button>
          </div>
          {error && (
            <div className="mb-3 font-mono text-[10px] uppercase tracking-widest text-red-400">
              error: {error}
            </div>
          )}
          {rows.length === 0 ? (
            <div className="font-mono text-xs text-foreground/55">
              {loading ? "loading…" : "no runs yet"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className="border-b border-foreground/15 text-left text-[10px] uppercase tracking-widest text-foreground/55">
                    <th className="py-2 pr-3">Started</th>
                    <th className="py-2 pr-3">Name / clip</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Frames</th>
                    <th className="py-2 pr-3">Tracks</th>
                    <th className="py-2 pr-3">Switches</th>
                    <th className="py-2 pr-3">Top labels</th>
                    <th className="py-2 pr-3">Infer p50/p95</th>
                    <th className="py-2 pr-3">Cfg</th>
                    <th className="py-2 pr-3">By</th>
                    <th className="py-2 pr-3">Watch</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.run_id}
                      className="border-b border-foreground/5 align-top hover:bg-foreground/[0.02]"
                    >
                      <td className="py-2 pr-3 text-foreground/70">
                        {formatTime(r.started_at_ms)}
                      </td>
                      <td className="py-2 pr-3">
                        <div className="text-foreground/85">{r.name || r.clip}</div>
                        <div className="text-foreground/50">{r.clip}</div>
                      </td>
                      <td className="py-2 pr-3">{statusBadge(r.status)}</td>
                      <td className="py-2 pr-3 text-foreground/70">
                        {r.summary?.frames_processed ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-foreground/70">
                        {r.summary?.unique_tracks ?? "—"}
                        {r.status === "ok" &&
                          r.summary?.unique_tracks === 0 && (
                            <span
                              className="ml-2 inline-flex items-center border border-amber-400/40 bg-amber-400/[0.06] px-1.5 py-0.5 text-[9px] uppercase tracking-widest text-amber-300/85"
                              title={
                                "Zero tracks passed suppression. Likely causes:\n" +
                                "  • all raw detections were below the conf floor\n" +
                                "  • detected classes weren't in allowed_classes (e.g. horse, boat)\n" +
                                "  • tracks didn't survive min_track_frames\n\n" +
                                "Try lowering conf_threshold/per_class_default_conf, or widen allowed_classes."
                              }
                            >
                              ! no detections
                            </span>
                          )}
                      </td>
                      <td className="py-2 pr-3 text-foreground/70">
                        {r.summary?.tracks_with_label_switches ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-foreground/70">
                        {r.summary?.label_distribution
                          ? topLabels(r.summary.label_distribution).map((p) => (
                              <span key={p.label} className="mr-2">
                                {p.label}·{p.n}
                              </span>
                            ))
                          : "—"}
                      </td>
                      <td className="py-2 pr-3 text-foreground/70">
                        {r.summary?.infer_ms_p50 != null
                          ? `${r.summary.infer_ms_p50}/${r.summary.infer_ms_p95 ?? "?"}ms`
                          : "—"}
                      </td>
                      <td className="py-2 pr-3 text-foreground/50">
                        {r.config_hash ?? r.summary?.config_hash ?? "—"}
                      </td>
                      <td className="py-2 pr-3 text-foreground/55">
                        {r.created_by ?? "—"}
                      </td>
                      <td className="py-2 pr-3">
                        {r.status === "ok" ? (
                          <button
                            type="button"
                            onClick={() => {
                              setViewingRunId(r.run_id);
                              setTimeout(
                                () =>
                                  playerRef.current?.scrollIntoView({
                                    behavior: "smooth",
                                    block: "start",
                                  }),
                                40,
                              );
                            }}
                            className={`border px-2 py-0.5 text-[10px] uppercase tracking-widest ${
                              viewingRunId === r.run_id
                                ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-300"
                                : "border-foreground/30 bg-foreground/5 text-foreground/85 hover:border-foreground/60"
                            }`}
                          >
                            {viewingRunId === r.run_id ? "▶ watching" : "▶ watch"}
                          </button>
                        ) : (
                          <span className="text-foreground/40">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* [02b] player ----------------------------------------------- */}
        {viewingRunId &&
          (() => {
            const r = rows.find((x) => x.run_id === viewingRunId);
            if (!r) return null;
            return (
              <section
                ref={playerRef}
                className="border border-foreground/15 bg-foreground/[0.02] p-4"
              >
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/55">
                    [02b] · player ·{" "}
                    <span className="text-foreground/85">
                      {r.name || r.clip}
                    </span>
                  </h2>
                  <button
                    type="button"
                    onClick={() => setViewingRunId(null)}
                    className="font-mono text-[10px] uppercase tracking-widest text-foreground/55 hover:text-foreground"
                  >
                    × close
                  </button>
                </div>
                <EvalPlayer
                  key={viewingRunId}
                  runId={viewingRunId}
                  clipName={r.clip}
                />
              </section>
            );
          })()}

        {/* [03] diff workbench -------------------------------------- */}
        <section className="border border-foreground/15 bg-foreground/[0.02] p-4">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-foreground/55">
            [03] · diff workbench
          </h2>
          {completedRuns.length < 2 ? (
            <p className="font-mono text-xs text-foreground/55">
              Need at least two completed runs to diff.
            </p>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Run A">
                <select
                  value={diffA}
                  onChange={(e) => setDiffA(e.target.value)}
                  className="border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                >
                  <option value="">— pick —</option>
                  {completedRuns.map((r) => (
                    <option key={r.run_id} value={r.run_id}>
                      {(r.name || r.clip).slice(0, 60)} · {r.run_id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Run B">
                <select
                  value={diffB}
                  onChange={(e) => setDiffB(e.target.value)}
                  className="border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
                >
                  <option value="">— pick —</option>
                  {completedRuns.map((r) => (
                    <option key={r.run_id} value={r.run_id}>
                      {(r.name || r.clip).slice(0, 60)} · {r.run_id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </Field>
              <button
                type="button"
                onClick={runDiff}
                disabled={diffBusy || !diffA || !diffB || diffA === diffB}
                className="border border-foreground/30 bg-foreground/5 px-3 py-1.5 font-mono text-xs uppercase tracking-widest text-foreground/85 hover:bg-foreground/10 disabled:opacity-40"
              >
                {diffBusy ? "running…" : "▶ diff"}
              </button>
            </div>
          )}
          {diff && (
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
              <Stat label="Matched track-frames" value={diff.matched_track_frames} />
              <Stat
                label="Tracks only in A"
                value={diff.tracks_only_in_a}
                accent="amber"
              />
              <Stat
                label="Tracks only in B"
                value={diff.tracks_only_in_b}
                accent="sky"
              />
              <Stat
                label="p50 infer Δ (ms)"
                value={diff.p50_infer_ms_delta}
                accent={diff.p50_infer_ms_delta > 0 ? "amber" : "emerald"}
              />
              <Stat
                label="Wallclock Δ (s)"
                value={diff.wallclock_delta_s}
                accent={diff.wallclock_delta_s > 0 ? "amber" : "emerald"}
              />
              <BreakdownList
                title="Label dist Δ (B − A)"
                rows={Object.entries(diff.label_distribution_delta).map(
                  ([k, v]) => ({ k, v }),
                )}
              />
              <BreakdownList
                title="Label changes (A→B)"
                rows={Object.entries(diff.label_changes).map(([k, v]) => ({
                  k,
                  v,
                }))}
              />
              <BreakdownList
                title="Suppression Δ (B − A)"
                rows={Object.entries(diff.suppression_reasons_delta).map(
                  ([k, v]) => ({ k, v }),
                )}
              />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ---- helpers -------------------------------------------------------------

function topLabels(dist: Record<string, number>, n = 3) {
  return Object.entries(dist)
    .map(([label, n2]) => ({ label, n: n2 }))
    .sort((a, b) => b.n - a.n)
    .slice(0, n);
}

// ---- subcomponents -------------------------------------------------------

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-widest text-foreground/55">
        {label}
      </span>
      {children}
    </label>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent?: "emerald" | "sky" | "amber";
}) {
  const color =
    accent === "emerald"
      ? "text-emerald-400"
      : accent === "sky"
        ? "text-sky-300"
        : accent === "amber"
          ? "text-amber-300"
          : "text-foreground/85";
  return (
    <div className="border border-foreground/10 bg-foreground/[0.03] p-3">
      <div className="font-mono text-[10px] uppercase tracking-widest text-foreground/55">
        {label}
      </div>
      <div className={`font-mono text-2xl ${color}`}>{value}</div>
    </div>
  );
}

function BreakdownList({
  title,
  rows,
}: {
  title: string;
  rows: { k: string; v: number }[];
}) {
  return (
    <div className="border border-foreground/10 bg-foreground/[0.03] p-3 md:col-span-1">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-foreground/55">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="font-mono text-xs text-foreground/55">none</div>
      ) : (
        <ul className="space-y-1">
          {rows.slice(0, 10).map((r) => (
            <li
              key={r.k}
              className="flex justify-between font-mono text-xs"
              title={r.k}
            >
              <span className="text-foreground/85 truncate">{r.k}</span>
              <span
                className={
                  r.v > 0
                    ? "text-amber-300"
                    : r.v < 0
                      ? "text-emerald-400"
                      : "text-foreground/55"
                }
              >
                {r.v > 0 ? "+" : ""}
                {r.v}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
