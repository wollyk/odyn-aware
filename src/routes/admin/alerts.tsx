// /admin/alerts — operator UI for the Phase-7 alert dispatcher.
//
// Three sections, mirroring the pattern from admin/faces:
//
//   [01] Add destination
//        - type: email | webhook
//        - target: email address OR https URL (validated server-side too)
//        - label, min_severity, cooldown_seconds
//        - webhook_secret: optional HMAC shared secret (write-only — the
//          server never returns it; we just show "secret set: yes/no")
//
//   [02] Active destinations
//        - Test (sends a synthetic alert + records an audit row)
//        - Disable (sets status='disabled' but keeps audit history)
//
//   [03] Recent dispatches
//        - Append-only log of every send attempt INCLUDING suppressions.
//        - Suppressed rows surface "why" so the operator can see when
//          cooldowns swallowed an alert they were expecting.
//
// What's NOT here yet (Phase 7.1):
//   - Per-camera or per-rule routing (right now every active dest receives
//     every alert that meets its min_severity).
//   - Disabled-destinations list / re-enable workflow.
//   - Bulk import/export.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminHeader,
  AuthDeniedScreen,
  AuthLoadingScreen,
  useAdminAuth,
} from "@/components/admin-shell";

export const Route = createFileRoute("/admin/alerts")({
  component: AdminAlerts,
});

type Destination = {
  id: number;
  type: "email" | "webhook";
  target: string;
  label: string | null;
  status: "active" | "disabled";
  min_severity: "notable" | "critical";
  cooldown_seconds: number;
  has_webhook_secret: 0 | 1;
  created_at: string;
  updated_at: string;
};

type Dispatch = {
  id: number;
  destination_id: number | null;
  destination_type: "email" | "webhook";
  destination_target: string;
  destination_label: string | null;
  destination_current_status: "active" | "disabled" | null;
  event_id: string | null;
  camera: string | null;
  severity: "notable" | "critical" | null;
  alert_type: string | null;
  title: string;
  body: string;
  status: "sent" | "failed" | "suppressed";
  http_status: number | null;
  error: string | null;
  duration_ms: number | null;
  sent_at: string;
};

function AdminAlerts() {
  const navigate = useNavigate();
  const { state: authState, me, logout, error: authError } = useAdminAuth();

  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [dispatches, setDispatches] = useState<Dispatch[]>([]);
  const [destLoading, setDestLoading] = useState(false);
  const [dispLoading, setDispLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedDispatch, setSelectedDispatch] = useState<Dispatch | null>(null);

  const refreshDestinations = useCallback(async () => {
    setDestLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/agent/alerts/destinations", { credentials: "include" });
      if (res.status === 401) return navigate({ to: "/admin/login" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDestinations(data.rows ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "destinations load failed");
    } finally {
      setDestLoading(false);
    }
  }, [navigate]);

  const refreshDispatches = useCallback(async () => {
    setDispLoading(true);
    try {
      const res = await fetch("/api/agent/alerts/recent?limit=100", { credentials: "include" });
      if (res.status === 401) return navigate({ to: "/admin/login" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setDispatches(data.rows ?? []);
    } catch {
      /* observability is non-blocking — swallow */
    } finally {
      setDispLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (authState !== "ok") return;
    refreshDestinations();
    refreshDispatches();
  }, [authState, refreshDestinations, refreshDispatches]);

  if (authState === "loading") return <AuthLoadingScreen />;
  if (authState === "denied") return <AuthDeniedScreen error={authError} />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminHeader active="alerts" me={me} logout={logout} />

      <main className="mx-auto max-w-7xl px-6 py-10 space-y-12">
        <AddDestinationSection
          onAdded={() => {
            refreshDestinations();
          }}
        />

        <DestinationsSection
          rows={destinations}
          loading={destLoading}
          error={listError}
          onRefresh={refreshDestinations}
          onChanged={() => {
            refreshDestinations();
            refreshDispatches();
          }}
        />

        <DispatchesSection
          rows={dispatches}
          loading={dispLoading}
          onRefresh={refreshDispatches}
          onSelect={setSelectedDispatch}
        />

        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Webhook secret is write-only — the server never returns it. Audit history survives a destination delete.
        </p>
      </main>

      {selectedDispatch && (
        <DispatchDrawer row={selectedDispatch} onClose={() => setSelectedDispatch(null)} />
      )}
    </div>
  );
}

// ---- Section: add destination -------------------------------------------

function AddDestinationSection({ onAdded }: { onAdded: () => void }) {
  const [type, setType] = useState<"email" | "webhook">("email");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [minSeverity, setMinSeverity] = useState<"notable" | "critical">("critical");
  const [cooldown, setCooldown] = useState(300);
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target.trim()) {
      setMsg({ kind: "error", text: "Target is required." });
      return;
    }
    setSubmitting(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        type,
        target: target.trim(),
        min_severity: minSeverity,
        cooldown_seconds: Number(cooldown) || 300,
      };
      if (label.trim()) body.label = label.trim();
      if (type === "webhook" && secret.trim()) body.webhook_secret = secret.trim();
      const res = await fetch("/api/agent/alerts/destinations", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg({ kind: "error", text: prettyErr(res.status, data) });
        return;
      }
      setMsg({ kind: "ok", text: `Added ${data.row?.type ?? type} destination.` });
      setTarget("");
      setLabel("");
      setSecret("");
      onAdded();
    } catch (err) {
      setMsg({
        kind: "error",
        text: err instanceof Error ? err.message : "submit failed",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section>
      <div className="mb-6 flex items-center gap-3">
        <span className="font-mono text-xs text-alert">[01]</span>
        <span className="label-mono">Add Destination</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={submit} className="grid gap-4 md:grid-cols-2">
        <Field label="Type" required>
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "email" | "webhook")}
            className="w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-foreground focus:outline-none"
          >
            <option value="email">Email</option>
            <option value="webhook">Webhook (HTTPS POST)</option>
          </select>
        </Field>
        <Field label={type === "email" ? "Email address" : "Webhook URL"} required>
          <input
            type={type === "email" ? "email" : "url"}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={
              type === "email"
                ? "ops@example.com"
                : "https://hooks.example.com/inbox"
            }
            className="w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none transition-colors"
          />
        </Field>
        <Field label="Label (optional)">
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={type === "email" ? "Ops team" : "Slack ingest"}
            maxLength={120}
            className="w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none transition-colors"
          />
        </Field>
        <Field label="Minimum severity">
          <select
            value={minSeverity}
            onChange={(e) => setMinSeverity(e.target.value as "notable" | "critical")}
            className="w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-foreground focus:outline-none"
          >
            <option value="critical">Critical only (recommended)</option>
            <option value="notable">Notable + critical</option>
          </select>
        </Field>
        <Field label="Cooldown (seconds)">
          <input
            type="number"
            min={30}
            max={86400}
            value={cooldown}
            onChange={(e) => setCooldown(Number(e.target.value))}
            className="w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-foreground focus:outline-none"
          />
        </Field>
        {type === "webhook" && (
          <Field label="HMAC secret (optional)">
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="≥ 8 chars"
              autoComplete="new-password"
              className="w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none transition-colors font-mono"
            />
          </Field>
        )}

        <div className="md:col-span-2 flex items-center gap-4 pt-3">
          <button
            type="submit"
            disabled={submitting}
            className="bg-foreground px-6 py-3 text-xs font-medium uppercase tracking-[0.2em] text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? "Adding…" : "Add destination →"}
          </button>
          {msg?.kind === "ok" && (
            <p className="font-mono text-xs tracking-wider text-emerald-400">● {msg.text}</p>
          )}
          {msg?.kind === "error" && (
            <p className="font-mono text-xs tracking-wider text-alert">● {msg.text}</p>
          )}
        </div>
      </form>
    </section>
  );
}

// ---- Section: destinations table ----------------------------------------

function DestinationsSection({
  rows,
  loading,
  error,
  onRefresh,
  onChanged,
}: {
  rows: Destination[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<Record<number, "test" | "delete" | null>>({});
  const [feedback, setFeedback] = useState<{ id: number; kind: "ok" | "error"; text: string } | null>(null);

  async function test(d: Destination) {
    setBusy((b) => ({ ...b, [d.id]: "test" }));
    setFeedback(null);
    try {
      const res = await fetch(`/api/agent/alerts/destinations/${d.id}/test`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setFeedback({
          id: d.id,
          kind: "ok",
          text: `Sent in ${data.duration_ms ?? "?"}ms`,
        });
      } else {
        setFeedback({
          id: d.id,
          kind: "error",
          text: data.error || data.detail || `HTTP ${res.status}`,
        });
      }
    } catch (err) {
      setFeedback({
        id: d.id,
        kind: "error",
        text: err instanceof Error ? err.message : "test failed",
      });
    } finally {
      setBusy((b) => ({ ...b, [d.id]: null }));
      onChanged();
    }
  }

  async function archive(d: Destination) {
    if (!window.confirm(`Disable ${d.label || d.target}?`)) return;
    setBusy((b) => ({ ...b, [d.id]: "delete" }));
    try {
      const res = await fetch(`/api/agent/alerts/destinations/${d.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onChanged();
    } catch (err) {
      setFeedback({
        id: d.id,
        kind: "error",
        text: err instanceof Error ? err.message : "disable failed",
      });
    } finally {
      setBusy((b) => ({ ...b, [d.id]: null }));
    }
  }

  return (
    <section>
      <div className="mb-6 flex items-center gap-3">
        <span className="font-mono text-xs text-alert">[02]</span>
        <span className="label-mono">Active Destinations</span>
        <span className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={onRefresh}
          className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && <p className="mb-4 font-mono text-xs tracking-wider text-alert">● {error}</p>}

      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-card/40 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="px-3 py-3 text-left">Type</th>
              <th className="px-3 py-3 text-left">Target</th>
              <th className="px-3 py-3 text-left">Label</th>
              <th className="px-3 py-3 text-left">Min severity</th>
              <th className="px-3 py-3 text-left">Cooldown</th>
              <th className="px-3 py-3 text-left">Secret</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  No destinations yet. Use [01] above to add one.
                </td>
              </tr>
            )}
            {rows.map((d) => (
              <tr key={d.id} className="border-b border-border/60 hover:bg-card/40 transition-colors">
                <td className="px-3 py-3 font-mono text-xs uppercase tracking-widest text-foreground/85">
                  {d.type}
                </td>
                <td className="px-3 py-3 text-foreground/90 font-mono text-xs break-all">{d.target}</td>
                <td className="px-3 py-3 text-muted-foreground">
                  {d.label || <span className="text-muted-foreground/50">—</span>}
                </td>
                <td className="px-3 py-3">
                  <span
                    className={
                      d.min_severity === "critical"
                        ? "font-mono text-[11px] uppercase tracking-widest text-alert"
                        : "font-mono text-[11px] uppercase tracking-widest text-amber-300"
                    }
                  >
                    {d.min_severity}
                  </span>
                </td>
                <td className="px-3 py-3 font-mono text-xs text-foreground/70">
                  {d.cooldown_seconds}s
                </td>
                <td className="px-3 py-3">
                  {d.type === "webhook" ? (
                    d.has_webhook_secret ? (
                      <span className="font-mono text-[11px] uppercase tracking-widest text-emerald-400">Set</span>
                    ) : (
                      <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground/60">None</span>
                    )
                  ) : (
                    <span className="text-muted-foreground/40">—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    {feedback?.id === d.id && (
                      <span
                        className={`font-mono text-[10px] uppercase tracking-widest ${
                          feedback.kind === "ok" ? "text-emerald-400" : "text-alert"
                        }`}
                      >
                        {feedback.text}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => test(d)}
                      disabled={busy[d.id] != null}
                      className="font-mono text-[10px] uppercase tracking-widest text-foreground hover:opacity-80 disabled:opacity-50 transition-opacity"
                    >
                      {busy[d.id] === "test" ? "Sending…" : "Test"}
                    </button>
                    <button
                      type="button"
                      onClick={() => archive(d)}
                      disabled={busy[d.id] != null}
                      className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-alert disabled:opacity-50 transition-colors"
                    >
                      {busy[d.id] === "delete" ? "Disabling…" : "Disable"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {loading ? "Loading…" : `${rows.length} active`}
      </p>
    </section>
  );
}

// ---- Section: dispatch log ----------------------------------------------

function DispatchesSection({
  rows,
  loading,
  onRefresh,
  onSelect,
}: {
  rows: Dispatch[];
  loading: boolean;
  onRefresh: () => void;
  onSelect: (d: Dispatch) => void;
}) {
  const counts = useMemo(() => {
    const c = { sent: 0, failed: 0, suppressed: 0 };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  return (
    <section>
      <div className="mb-6 flex items-center gap-3">
        <span className="font-mono text-xs text-alert">[03]</span>
        <span className="label-mono">Recent Dispatches</span>
        <span className="font-mono text-[10px] text-muted-foreground/70">
          sent {counts.sent} · failed {counts.failed} · suppressed {counts.suppressed}
        </span>
        <span className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={onRefresh}
          className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-card/40 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="px-3 py-3 text-left">When</th>
              <th className="px-3 py-3 text-left">Status</th>
              <th className="px-3 py-3 text-left">Camera</th>
              <th className="px-3 py-3 text-left">Severity / Type</th>
              <th className="px-3 py-3 text-left">Destination</th>
              <th className="px-3 py-3 text-left">Title</th>
              <th className="px-3 py-3 text-left">Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  No alerts dispatched yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => onSelect(r)}
                className="cursor-pointer border-b border-border/60 hover:bg-card/40 transition-colors"
              >
                <td className="px-3 py-3 font-mono text-xs text-foreground/80 whitespace-nowrap">{formatDate(r.sent_at)}</td>
                <td className="px-3 py-3">
                  <StatusPill status={r.status} />
                </td>
                <td className="px-3 py-3 font-mono text-xs text-foreground/85">{r.camera ?? "—"}</td>
                <td className="px-3 py-3 font-mono text-xs">
                  <span
                    className={
                      r.severity === "critical"
                        ? "text-alert"
                        : r.severity === "notable"
                        ? "text-amber-300"
                        : "text-muted-foreground"
                    }
                  >
                    {r.severity ?? "—"}
                  </span>
                  {r.alert_type && (
                    <span className="ml-2 text-foreground/60">[{r.alert_type}]</span>
                  )}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-foreground/80">
                  <span className="uppercase tracking-widest text-muted-foreground mr-1.5">{r.destination_type}</span>
                  <span className="break-all">{r.destination_target}</span>
                </td>
                <td className="px-3 py-3 max-w-[18rem] truncate text-foreground/85">{r.title}</td>
                <td className="px-3 py-3 max-w-[16rem] truncate font-mono text-xs">
                  {r.error ? (
                    <span className="text-alert">{r.error}</span>
                  ) : r.http_status != null ? (
                    <span className="text-foreground/70">HTTP {r.http_status} · {r.duration_ms ?? "?"}ms</span>
                  ) : (
                    <span className="text-foreground/60">{r.duration_ms ?? "?"}ms</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {loading ? "Loading…" : `${rows.length} most recent · click a row for full detail`}
      </p>
    </section>
  );
}

function StatusPill({ status }: { status: Dispatch["status"] }) {
  const cfg =
    status === "sent"
      ? { dot: "bg-emerald-400", txt: "text-emerald-400" }
      : status === "suppressed"
      ? { dot: "bg-amber-300", txt: "text-amber-300" }
      : { dot: "bg-alert", txt: "text-alert" };
  return (
    <span className="flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest">
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
      <span className={cfg.txt}>{status}</span>
    </span>
  );
}

// ---- Drawer for full dispatch detail ------------------------------------

function DispatchDrawer({ row, onClose }: { row: Dispatch; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <button
        aria-label="Close"
        onClick={onClose}
        className="flex-1 bg-background/80 backdrop-blur-sm"
      />
      <aside className="ml-auto h-full w-full max-w-md overflow-y-auto border-l border-border bg-background p-8">
        <div className="mb-6 flex items-center gap-3">
          <StatusPill status={row.status} />
          <span className="label-mono">Dispatch #{row.id}</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            Close ✕
          </button>
        </div>
        <h2 className="text-lg font-light leading-tight tracking-tight">{row.title}</h2>
        <dl className="mt-6 divide-y divide-border border-y border-border font-mono text-xs">
          <KV k="Sent at" v={formatDate(row.sent_at)} />
          <KV k="Camera" v={row.camera ?? "—"} />
          <KV k="Severity" v={row.severity ?? "—"} />
          <KV k="Alert type" v={row.alert_type ?? "—"} />
          <KV k="Destination" v={`${row.destination_type} · ${row.destination_target}`} />
          {row.destination_label && <KV k="Label" v={row.destination_label} />}
          <KV k="HTTP status" v={row.http_status != null ? String(row.http_status) : "—"} />
          <KV k="Duration" v={row.duration_ms != null ? `${row.duration_ms} ms` : "—"} />
          {row.error && <KV k="Error" v={row.error} tone="alert" />}
          {row.event_id && <KV k="Event id" v={row.event_id} />}
        </dl>
        <div className="mt-6">
          <div className="label-mono mb-2">Body</div>
          <pre className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85 bg-card/40 border border-border p-3 font-mono">
            {row.body}
          </pre>
        </div>
      </aside>
    </div>
  );
}

function KV({ k, v, tone = "default" }: { k: string; v: string; tone?: "default" | "alert" }) {
  return (
    <div className="grid grid-cols-12 gap-4 py-3">
      <dt className="col-span-4 text-alert tracking-widest uppercase">{k}</dt>
      <dd
        className={`col-span-8 break-words ${
          tone === "alert" ? "text-alert" : "text-foreground/85"
        }`}
      >
        {v}
      </dd>
    </div>
  );
}

// ---- helpers -------------------------------------------------------------

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-alert">*</span>}
      </span>
      {children}
    </label>
  );
}

function prettyErr(status: number, body: { error?: string; detail?: unknown }): string {
  const e = body?.error ?? "unknown_error";
  if (e === "duplicate_destination") return "That destination already exists.";
  if (e === "invalid_email") return "Invalid email address.";
  if (e === "invalid_webhook_url") return "Webhook URL must be http(s).";
  if (e === "webhook_must_be_http") return "Only http and https URLs are allowed.";
  if (e === "invalid_input") return "Input invalid. Check the form.";
  if (status >= 500) return `Server error (${status}). ${e}`;
  return `Add failed: ${e}`;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
