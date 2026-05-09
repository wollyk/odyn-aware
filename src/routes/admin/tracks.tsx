// /admin/tracks — Phase-11B persisted track timeline.
//
// Operator-facing audit view for the YOLOv8s + ByteTrack tracker
// sessions stored by the sidecar via /api/tracker/ingest. Three rows:
//
//   [01] Summary
//        Counts in the last 24h, by camera and label, plus how many
//        sessions were verified-static (the VLM blessed them) vs
//        moving.
//
//   [02] Filters
//        Camera, label, time-since dropdown, "open only" toggle.
//
//   [03] Sessions table
//        Reverse-chrono list of recent sessions with their canonical
//        label, conf, motion class, verification verdict, frames seen,
//        first/last seen times. Used for forensics ("what was tagged
//        truck this morning in Garage?").
//
// Why a separate surface vs. living inside Live View: the live page is
// real-time; this is historical. Mixing them clutters both.

import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminHeader,
  AuthDeniedScreen,
  AuthLoadingScreen,
  useAdminAuth,
} from "@/components/admin-shell";

export const Route = createFileRoute("/admin/tracks")({
  component: AdminTracks,
});

// ---- types match the agent-tracks.mjs response shapes -------------------

type TrackRow = {
  session_id: string;
  camera: string;
  track_id: number;
  label: string;
  conf: number;
  bbox_x: number;
  bbox_y: number;
  bbox_w: number;
  bbox_h: number;
  motion: "moving" | "static" | "warming" | null;
  verified: 0 | 1 | null;
  frames_seen: number;
  first_seen_ms: number;
  last_seen_ms: number;
  closed_at_ms: number | null;
  inserted_at: string;
  updated_at: string;
};

type ListResp = {
  rows: TrackRow[];
  count: number;
  camera: string | null;
  label: string | null;
  since_ms: number;
  open_only: boolean;
};

type SummaryResp = {
  byLabel: { label: string; n: number }[];
  byCamera: { camera: string; n: number }[];
  totals: {
    total: number;
    open_sessions: number;
    verified_static: number;
    moving: number;
  };
  since_ms: number;
};

// ---- time helpers -------------------------------------------------------

const TIME_WINDOWS = [
  { label: "1h", ms: 60 * 60 * 1000 },
  { label: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
];

function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toLocaleString();
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function statusBadge(row: TrackRow) {
  if (row.closed_at_ms != null) {
    return (
      <span className="inline-flex items-center gap-1 border border-foreground/30 bg-foreground/5 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-foreground/60">
        Closed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-emerald-400">
      Open
    </span>
  );
}

function motionBadge(row: TrackRow) {
  if (row.motion === "moving") {
    return (
      <span className="inline-flex items-center gap-1 border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] uppercase tracking-widest text-sky-300">
        Moving
      </span>
    );
  }
  if (row.motion === "static") {
    const ok = row.verified === 1;
    return (
      <span
        className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-[10px] uppercase tracking-widest ${
          ok
            ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
            : "border-foreground/30 bg-foreground/5 text-foreground/60"
        }`}
        title={ok ? "Verified static (VLM ✓)" : "Static (unverified)"}
      >
        Static{ok ? " ✓" : ""}
      </span>
    );
  }
  return <span className="text-foreground/40">—</span>;
}

// ---- main component -----------------------------------------------------

function AdminTracks() {
  const { authState, logout } = useAdminAuth();

  const [summary, setSummary] = useState<SummaryResp | null>(null);
  const [rows, setRows] = useState<TrackRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [windowMs, setWindowMs] = useState(TIME_WINDOWS[2].ms);
  const [cameraFilter, setCameraFilter] = useState<string>("");
  const [labelFilter, setLabelFilter] = useState<string>("");
  const [openOnly, setOpenOnly] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const sinceMs = Date.now() - windowMs;
    const params = new URLSearchParams({
      since_ms: String(sinceMs),
      limit: "300",
    });
    if (cameraFilter.trim()) params.set("camera", cameraFilter.trim());
    if (labelFilter.trim()) params.set("label", labelFilter.trim());
    if (openOnly) params.set("open_only", "1");
    try {
      const [listRes, sumRes] = await Promise.all([
        fetch(`/api/agent/tracks?${params}`, { credentials: "include" }),
        fetch(`/api/agent/tracks/summary?since_ms=${sinceMs}`, { credentials: "include" }),
      ]);
      if (!listRes.ok) throw new Error(`list ${listRes.status}`);
      if (!sumRes.ok) throw new Error(`summary ${sumRes.status}`);
      const list = (await listRes.json()) as ListResp;
      const sum = (await sumRes.json()) as SummaryResp;
      setRows(list.rows);
      setSummary(sum);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "fetch_failed");
    } finally {
      setLoading(false);
    }
  }, [windowMs, cameraFilter, labelFilter, openOnly]);

  useEffect(() => {
    if (authState !== "ok") return;
    fetchAll();
    const t = setInterval(fetchAll, 15_000);
    return () => clearInterval(t);
  }, [authState, fetchAll]);

  const cameraOptions = useMemo(() => {
    const set = new Set<string>();
    summary?.byCamera.forEach((c) => set.add(c.camera));
    rows.forEach((r) => set.add(r.camera));
    return Array.from(set).sort();
  }, [summary, rows]);

  const labelOptions = useMemo(() => {
    const set = new Set<string>();
    summary?.byLabel.forEach((l) => set.add(l.label));
    rows.forEach((r) => set.add(r.label));
    return Array.from(set).sort();
  }, [summary, rows]);

  if (authState === "loading") return <AuthLoadingScreen />;
  if (authState === "denied") return <AuthDeniedScreen />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminHeader active="tracks" onLogout={logout} />
      <main className="mx-auto max-w-[1200px] px-6 py-6 space-y-6">
        {/* [01] Summary --------------------------------------------- */}
        <section className="border border-foreground/15 bg-foreground/[0.02] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/55">
              [01] · summary · last {Math.round(windowMs / 3600000)}h
            </h2>
            <button
              type="button"
              onClick={fetchAll}
              className="font-mono text-[10px] uppercase tracking-widest text-foreground/55 hover:text-foreground"
            >
              ↻ refresh
            </button>
          </div>
          {summary ? (
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <Stat label="Total sessions" value={summary.totals.total} />
              <Stat label="Open" value={summary.totals.open_sessions} accent="emerald" />
              <Stat label="Moving" value={summary.totals.moving} accent="sky" />
              <Stat
                label="Verified static"
                value={summary.totals.verified_static}
                accent="amber"
              />
              <BreakdownList title="By camera" rows={summary.byCamera.map((r) => ({ k: r.camera, v: r.n }))} />
              <BreakdownList title="By label" rows={summary.byLabel.map((r) => ({ k: r.label, v: r.n }))} />
            </div>
          ) : (
            <div className="font-mono text-xs text-foreground/55">{loading ? "loading…" : "no data"}</div>
          )}
        </section>

        {/* [02] Filters --------------------------------------------- */}
        <section className="border border-foreground/15 bg-foreground/[0.02] p-4">
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-widest text-foreground/55">
            [02] · filters
          </h2>
          <div className="flex flex-wrap items-center gap-4">
            <FilterSelect
              label="Window"
              value={String(windowMs)}
              onChange={(v) => setWindowMs(Number(v))}
              options={TIME_WINDOWS.map((w) => ({ value: String(w.ms), label: w.label }))}
            />
            <FilterSelect
              label="Camera"
              value={cameraFilter}
              onChange={setCameraFilter}
              options={[
                { value: "", label: "all" },
                ...cameraOptions.map((c) => ({ value: c, label: c })),
              ]}
            />
            <FilterSelect
              label="Label"
              value={labelFilter}
              onChange={setLabelFilter}
              options={[
                { value: "", label: "all" },
                ...labelOptions.map((l) => ({ value: l, label: l })),
              ]}
            />
            <label className="flex items-center gap-2 font-mono text-xs text-foreground/70">
              <input
                type="checkbox"
                checked={openOnly}
                onChange={(e) => setOpenOnly(e.target.checked)}
              />
              open only
            </label>
          </div>
        </section>

        {/* [03] Sessions ------------------------------------------ */}
        <section className="border border-foreground/15 bg-foreground/[0.02] p-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-mono text-[10px] uppercase tracking-widest text-foreground/55">
              [03] · sessions {rows.length > 0 ? `· ${rows.length}` : ""}
            </h2>
            {error && (
              <span className="font-mono text-[10px] uppercase tracking-widest text-red-400">
                error: {error}
              </span>
            )}
          </div>
          {rows.length === 0 ? (
            <div className="font-mono text-xs text-foreground/55">
              {loading ? "loading…" : "no sessions in this window"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full font-mono text-xs">
                <thead>
                  <tr className="border-b border-foreground/15 text-left text-[10px] uppercase tracking-widest text-foreground/55">
                    <th className="py-2 pr-3">Camera</th>
                    <th className="py-2 pr-3">Label</th>
                    <th className="py-2 pr-3">ID</th>
                    <th className="py-2 pr-3">Conf</th>
                    <th className="py-2 pr-3">Motion</th>
                    <th className="py-2 pr-3">Status</th>
                    <th className="py-2 pr-3">Frames</th>
                    <th className="py-2 pr-3">First seen</th>
                    <th className="py-2 pr-3">Last seen</th>
                    <th className="py-2 pr-3">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr
                      key={r.session_id}
                      className="border-b border-foreground/5 align-top hover:bg-foreground/[0.02]"
                    >
                      <td className="py-2 pr-3 text-foreground/85">{r.camera}</td>
                      <td className="py-2 pr-3">{r.label}</td>
                      <td className="py-2 pr-3 text-foreground/55">#{r.track_id}</td>
                      <td className="py-2 pr-3">{r.conf.toFixed(2)}</td>
                      <td className="py-2 pr-3">{motionBadge(r)}</td>
                      <td className="py-2 pr-3">{statusBadge(r)}</td>
                      <td className="py-2 pr-3 text-foreground/70">{r.frames_seen}</td>
                      <td className="py-2 pr-3 text-foreground/70">{formatTime(r.first_seen_ms)}</td>
                      <td className="py-2 pr-3 text-foreground/70">{formatTime(r.last_seen_ms)}</td>
                      <td className="py-2 pr-3 text-foreground/70">
                        {formatDuration(r.last_seen_ms - r.first_seen_ms)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

// ---- subcomponents ------------------------------------------------------

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
    <div className="border border-foreground/10 bg-foreground/[0.03] p-3 col-span-2">
      <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-foreground/55">
        {title}
      </div>
      {rows.length === 0 ? (
        <div className="font-mono text-xs text-foreground/55">none</div>
      ) : (
        <ul className="space-y-1">
          {rows.slice(0, 8).map((r) => (
            <li key={r.k} className="flex justify-between font-mono text-xs">
              <span className="text-foreground/85">{r.k}</span>
              <span className="text-foreground/70">{r.v}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="flex items-center gap-2 font-mono text-xs text-foreground/70">
      <span className="text-foreground/55 uppercase tracking-widest text-[10px]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="border border-foreground/20 bg-background px-2 py-1 font-mono text-xs"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
