import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AdminHeader,
  AuthDeniedScreen,
  AuthLoadingScreen,
  useAdminAuth,
} from "@/components/admin-shell";

export const Route = createFileRoute("/admin/")({
  component: AdminDashboard,
});

type Submission = {
  id: number;
  created_at: string;
  name: string;
  email: string;
  company: string;
  environment: string;
  message: string | null;
  ip: string | null;
};

type SortKey = "id" | "created_at" | "name" | "email" | "company" | "environment";

function AdminDashboard() {
  const navigate = useNavigate();
  const { state: authState, me, logout, error: authError } = useAdminAuth();
  const [rows, setRows] = useState<Submission[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("id");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<Submission | null>(null);

  const loadRows = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        q,
        sort,
        order,
        limit: "500",
      });
      const res = await fetch(`/api/admin/submissions?${params.toString()}`, {
        credentials: "include",
      });
      if (res.status === 401) {
        navigate({ to: "/admin/login" });
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : "load failed");
    } finally {
      setLoading(false);
    }
  }, [q, sort, order, navigate]);

  useEffect(() => {
    if (authState !== "ok") return;
    loadRows();
  }, [authState, loadRows]);

  // Debounce search input.
  const [pendingQ, setPendingQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(pendingQ.trim()), 250);
    return () => clearTimeout(t);
  }, [pendingQ]);

  const onSort = (key: SortKey) => {
    if (sort === key) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(key);
      setOrder("desc");
    }
  };

  if (authState === "loading") return <AuthLoadingScreen />;
  if (authState === "denied") return <AuthDeniedScreen error={authError ?? error} />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminHeader active="submissions" me={me} logout={logout} />

      <main className="mx-auto max-w-7xl px-6 py-10">
        <div className="mb-8 flex items-center gap-3">
          <span className="font-mono text-xs text-alert">[01]</span>
          <span className="label-mono">Deployment Requests</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <input
            type="search"
            placeholder="Search name, email, company, message…"
            value={pendingQ}
            onChange={(e) => setPendingQ(e.target.value)}
            className="w-full max-w-md border border-border bg-background px-3 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none transition-colors"
          />
          <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <span>{loading ? "Loading…" : `${rows.length} of ${total}`}</span>
            <button
              onClick={loadRows}
              className="text-foreground hover:opacity-80 transition-opacity"
              type="button"
            >
              Refresh
            </button>
          </div>
        </div>

        {error && (
          <p className="mb-4 font-mono text-xs tracking-wider text-alert">● {error}</p>
        )}

        <div className="overflow-x-auto border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-card/40 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <Th sort={sort} order={order} k="id" onSort={onSort}>#</Th>
                <Th sort={sort} order={order} k="created_at" onSort={onSort}>Submitted</Th>
                <Th sort={sort} order={order} k="name" onSort={onSort}>Name</Th>
                <Th sort={sort} order={order} k="email" onSort={onSort}>Email</Th>
                <Th sort={sort} order={order} k="company" onSort={onSort}>Company / Site</Th>
                <Th sort={sort} order={order} k="environment" onSort={onSort}>Environment</Th>
                <th className="px-3 py-3 text-left">Message</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="px-3 py-12 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
                    No submissions yet.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => setSelected(r)}
                  className="cursor-pointer border-b border-border/60 hover:bg-card/40 transition-colors"
                >
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{r.id}</td>
                  <td className="px-3 py-3 font-mono text-xs text-foreground/80">{formatDate(r.created_at)}</td>
                  <td className="px-3 py-3 text-foreground">{r.name}</td>
                  <td className="px-3 py-3 text-foreground/85">
                    <a
                      href={`mailto:${r.email}`}
                      onClick={(e) => e.stopPropagation()}
                      className="hover:text-foreground hover:underline"
                    >
                      {r.email}
                    </a>
                  </td>
                  <td className="px-3 py-3 text-foreground/85">{r.company}</td>
                  <td className="px-3 py-3">
                    <span className="border-l-2 border-alert pl-2 font-mono text-[11px] uppercase tracking-widest text-foreground/85">
                      {r.environment}
                    </span>
                  </td>
                  <td className="px-3 py-3 max-w-[24rem] truncate text-muted-foreground">
                    {r.message || <span className="text-muted-foreground/50">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-6 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Click a row for full details. Sort by clicking column headers.
        </p>
      </main>

      {selected && (
        <DetailDrawer row={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function Th({
  k,
  sort,
  order,
  onSort,
  children,
}: {
  k: SortKey;
  sort: SortKey;
  order: "asc" | "desc";
  onSort: (k: SortKey) => void;
  children: React.ReactNode;
}) {
  const active = sort === k;
  return (
    <th className="px-3 py-3 text-left">
      <button
        type="button"
        onClick={() => onSort(k)}
        className={`flex items-center gap-1 hover:text-foreground transition-colors ${active ? "text-foreground" : ""}`}
      >
        {children}
        {active && <span aria-hidden>{order === "asc" ? "↑" : "↓"}</span>}
      </button>
    </th>
  );
}

function DetailDrawer({ row, onClose }: { row: Submission; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fields = useMemo(
    () => [
      ["ID", String(row.id)],
      ["Submitted", formatDate(row.created_at)],
      ["Name", row.name],
      ["Email", row.email],
      ["Company / Site", row.company],
      ["Environment", row.environment],
      ["IP", row.ip ?? "—"],
    ],
    [row],
  );

  return (
    <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
      <button
        aria-label="Close"
        onClick={onClose}
        className="flex-1 bg-background/80 backdrop-blur-sm"
      />
      <aside className="ml-auto h-full w-full max-w-md overflow-y-auto border-l border-border bg-background p-8">
        <div className="mb-8 flex items-center gap-3">
          <span className="font-mono text-xs text-alert">[REQ-{row.id}]</span>
          <span className="label-mono">Submission</span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground"
          >
            Close ✕
          </button>
        </div>
        <h2 className="text-2xl font-light leading-tight tracking-tight">{row.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{row.company}</p>

        <dl className="mt-8 divide-y divide-border border-y border-border font-mono text-xs">
          {fields.map(([k, v]) => (
            <div key={k} className="grid grid-cols-12 gap-4 py-3">
              <dt className="col-span-4 text-alert tracking-widest uppercase">{k}</dt>
              <dd className="col-span-8 text-foreground/85 break-words">{v}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-8">
          <div className="label-mono mb-2">Message</div>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85">
            {row.message || <span className="text-muted-foreground">No message provided.</span>}
          </p>
        </div>

        <a
          href={`mailto:${row.email}?subject=AuroraView%20deployment%20request`}
          className="mt-10 inline-flex items-center gap-3 bg-foreground px-6 py-3 text-xs font-medium uppercase tracking-[0.2em] text-background hover:bg-foreground/90 transition-colors"
        >
          Reply via email <span aria-hidden>→</span>
        </a>
      </aside>
    </div>
  );
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
