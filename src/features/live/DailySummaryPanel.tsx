// Phase-5 daily summary surface.
//
// One compact strip that lives above the live tile. It pulls today's
// tenant-scoped summary on mount, lets the operator regenerate, and
// degrades gracefully if no summary exists yet (typical first-day
// install — the harness only writes a row after meaningful events).
//
// Shape we read from /api/agent/summaries?day=YYYY-MM-DD&scope=tenant:
//   { row: {
//       day, scope, summary, model, event_count, version, generated_at,
//       stats: { totals, by_camera, by_origin, top_alert_reasons, people_seen },
//     }
//   }
// Or HTTP 404 → "no summary yet".
//
// Regenerate POSTs /api/agent/summaries/regenerate with { scope:"tenant",
// force:true }. The harness handles its own LLM rate limiting.

import { useCallback, useEffect, useState } from "react";

type SummaryStats = {
  totals?: {
    total?: number;
    critical_count?: number;
    notable_count?: number;
    normal_count?: number;
  };
  by_camera?: { camera: string; n: number }[];
  people_seen?: { who: string; n: number }[];
};

type SummaryRow = {
  day: string;
  scope: string;
  summary: string;
  model: string;
  event_count: number;
  version: number;
  generated_at: string;
  stats?: SummaryStats;
};

type State =
  | { kind: "loading" }
  | { kind: "ok"; row: SummaryRow }
  | { kind: "empty"; day: string }
  | { kind: "error"; message: string };

function todayUtcKey() {
  return new Date().toISOString().slice(0, 10);
}

export function DailySummaryPanel() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [regenerating, setRegenerating] = useState(false);
  const [regenError, setRegenError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const day = todayUtcKey();
    setState({ kind: "loading" });
    try {
      const res = await fetch(
        `/api/agent/summaries?day=${day}&scope=tenant`,
        { credentials: "include" },
      );
      if (res.status === 404) {
        setState({ kind: "empty", day });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data?.row) {
        setState({ kind: "empty", day });
        return;
      }
      setState({ kind: "ok", row: data.row });
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "load failed",
      });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function regenerate() {
    setRegenerating(true);
    setRegenError(null);
    try {
      const res = await fetch("/api/agent/summaries/regenerate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          day: todayUtcKey(),
          scope: "tenant",
          force: true,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.detail || data?.error || `HTTP ${res.status}`);
      }
      // The endpoint returns the freshly generated row.
      if (data?.row) {
        setState({ kind: "ok", row: data.row });
      } else {
        load();
      }
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : "regen failed");
    } finally {
      setRegenerating(false);
    }
  }

  return (
    <section className="mb-4 border border-border bg-card/30">
      <div className="flex items-center gap-3 border-b border-border/60 px-4 py-2.5">
        <span className="font-mono text-xs text-alert">[01]</span>
        <span className="label-mono">Today's Summary</span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          {todayUtcKey()} · UTC
        </span>
        <span className="h-px flex-1 bg-border/50" />
        <button
          type="button"
          onClick={regenerate}
          disabled={regenerating}
          className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground disabled:opacity-50 transition-colors"
        >
          {regenerating ? "Regenerating…" : "Regenerate"}
        </button>
      </div>
      <div className="px-4 py-3">
        {state.kind === "loading" && (
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Loading summary…
          </p>
        )}
        {state.kind === "empty" && (
          <p className="font-mono text-xs text-muted-foreground">
            No summary written for {state.day} yet — the agent generates one
            automatically as events accumulate, or hit Regenerate.
          </p>
        )}
        {state.kind === "error" && (
          <p className="font-mono text-xs text-alert">● {state.message}</p>
        )}
        {state.kind === "ok" && <SummaryBody row={state.row} />}
        {regenError && (
          <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-alert">
            ● {regenError}
          </p>
        )}
      </div>
    </section>
  );
}

function SummaryBody({ row }: { row: SummaryRow }) {
  const t = row.stats?.totals ?? {};
  const total = t.total ?? row.event_count ?? 0;
  const critical = t.critical_count ?? 0;
  const notable = t.notable_count ?? 0;
  const normal = t.normal_count ?? 0;
  const top = row.stats?.by_camera?.[0];
  const generated = formatRelative(row.generated_at);

  const knownPeople =
    row.stats?.people_seen?.filter((p) => p.who && p.who !== "(unknown)") ?? [];
  const unknownPeople =
    row.stats?.people_seen?.find((p) => p.who === "(unknown)")?.n ?? 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 font-mono text-[10px] uppercase tracking-widest mb-2">
        <Stat label="Events" value={total} />
        <Stat
          label="Critical"
          value={critical}
          tone={critical > 0 ? "alert" : "muted"}
        />
        <Stat
          label="Notable"
          value={notable}
          tone={notable > 0 ? "amber" : "muted"}
        />
        <Stat label="Normal" value={normal} tone="muted" />
        {top && (
          <Stat
            label="Busiest"
            value={`${top.camera} (${top.n})`}
            tone="default"
          />
        )}
        {(knownPeople.length > 0 || unknownPeople > 0) && (
          <Stat
            label="Faces"
            value={`${knownPeople.length} known · ${unknownPeople} unknown`}
            tone={unknownPeople > 0 ? "amber" : "default"}
          />
        )}
      </div>
      <p className="text-sm text-foreground/85 leading-relaxed">{row.summary}</p>
      <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
        {row.model} · v{row.version} · generated {generated}
      </p>
    </>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number | string;
  tone?: "default" | "muted" | "amber" | "alert";
}) {
  const valueClass =
    tone === "alert"
      ? "text-alert"
      : tone === "amber"
      ? "text-amber-300"
      : tone === "muted"
      ? "text-foreground/70"
      : "text-foreground";
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-muted-foreground/70">{label}</span>
      <span className={valueClass}>{value}</span>
    </span>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
