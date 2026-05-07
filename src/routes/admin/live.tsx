import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { AgentStatus, StreamMode } from "@/features/live/types";
import { useCameras } from "@/features/live/useCameras";
import { VideoTile } from "@/features/live/VideoTile";
import { ChatPanel } from "@/features/live/ChatPanel";

export const Route = createFileRoute("/admin/live")({
  component: AdminLive,
});

function AdminLive() {
  const navigate = useNavigate();
  const [authState, setAuthState] = useState<"loading" | "ok" | "denied">("loading");
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);

  // Resilient camera fetch: 30s background refresh, never blanks the dropdown
  // on transient errors.
  const camList = useCameras();
  const [camera, setCamera] = useState<string>("");
  // Default to Live MSE (snapshot mode hits Frigate's `latest.jpg` placeholder
  // when detect.enabled=false). MSE taps go2rtc directly.
  const [mode, setMode] = useState<StreamMode>("live");

  const cam = useMemo(
    () => camList.cameras.find((c) => c.name === camera) ?? null,
    [camList.cameras, camera],
  );

  // Auth check + agent status. Camera fetch is owned by useCameras().
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meRes = await fetch("/api/auth/me", { credentials: "include" });
        if (cancelled) return;
        if (meRes.status === 401) return navigate({ to: "/admin/login" });
        const meJson = await meRes.json();
        if (meJson.user?.role !== "admin") {
          setAuthState("denied");
          return;
        }
        setMe(meJson.user);

        const statusRes = await fetch("/api/agent/status", { credentials: "include" });
        if (cancelled) return;
        if (statusRes.ok) {
          setAgentStatus(await statusRes.json());
        }
        setAuthState("ok");
      } catch (err) {
        if (cancelled) return;
        setAuthState("denied");
        console.error(err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  // Auto-select first camera once we have any. Survives empty intermediates
  // because useCameras keeps last known good — we never accidentally clear.
  useEffect(() => {
    if (!camera && camList.cameras.length > 0) {
      setCamera(camList.cameras[0].name);
    }
  }, [camList.cameras, camera]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    navigate({ to: "/admin/login" });
  }

  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Verifying session…
        </span>
      </div>
    );
  }
  if (authState === "denied") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="max-w-md text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-alert">Access denied</p>
          <button
            type="button"
            onClick={() => navigate({ to: "/admin/login" })}
            className="mt-6 inline-flex items-center gap-2 border border-foreground/80 px-4 py-2 text-xs font-medium tracking-widest uppercase text-foreground hover:bg-foreground hover:text-background transition-colors"
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/60 bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <a href="/" className="font-mono text-sm font-semibold tracking-[0.3em] text-foreground">
              AURORAVIEW
            </a>
            <span className="label-mono">/ Admin</span>
          </div>
          <nav className="flex items-center gap-6">
            <a
              href="/admin"
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
            >
              Submissions
            </a>
            <span className="font-mono text-[10px] uppercase tracking-widest text-foreground border-b border-foreground pb-0.5">
              Live View
            </span>
          </nav>
          <div className="flex items-center gap-4">
            <span className="hidden sm:inline font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {me?.email}
            </span>
            <button
              onClick={logout}
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <div className="mb-4 flex items-center gap-4">
          <span className="font-mono text-xs text-alert">[02]</span>
          <span className="label-mono">Live View</span>
          <span className="h-px flex-1 bg-border" />
          {camList.cameras.length > 1 && (
            <select
              value={camera}
              onChange={(e) => setCamera(e.target.value)}
              className="border border-border bg-background px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-foreground focus:border-foreground focus:outline-none"
            >
              {camList.cameras.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <ModeToggle mode={mode} setMode={setMode} />
          <StatusPill agentStatus={agentStatus} freshness={camList.freshness} />
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
          <VideoTile cam={cam} mode={mode} agentStatus={agentStatus} />
          <ChatPanel cam={cam} agentStatus={agentStatus} />
        </div>

        <p className="mt-6 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {mode === "snapshot"
            ? "Snapshot polling 1Hz"
            : "Live MSE stream (go2rtc → Node WS proxy → MediaSource)"}
          {" · "}Vision analysis every 5s · Chat tools: list_cameras, rename_camera,
          get_recent_events, propose_alert_rule
        </p>
      </main>
    </div>
  );
}

function ModeToggle({ mode, setMode }: { mode: StreamMode; setMode: (m: StreamMode) => void }) {
  const opts: { id: StreamMode; label: string }[] = [
    { id: "snapshot", label: "Snapshot 1Hz" },
    { id: "live", label: "Live MSE" },
  ];
  return (
    <div className="inline-flex border border-border">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => setMode(o.id)}
          className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${
            mode === o.id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StatusPill({
  agentStatus,
  freshness,
}: {
  agentStatus: AgentStatus | null;
  freshness: ReturnType<typeof useCameras>["freshness"];
}) {
  if (!agentStatus) return null;
  const items = [
    { key: "Frigate", ok: agentStatus.frigate_configured },
    { key: "Vision/Chat", ok: agentStatus.chat_configured },
  ];
  // Soft staleness indicator: only surfaced when we're showing data older than
  // a live fetch could provide. Color-coded but never a hard error.
  const stale = freshness && freshness !== "fresh" && freshness !== "n/a";
  return (
    <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest">
      {items.map((it) => (
        <span key={it.key} className="flex items-center gap-1.5">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${it.ok ? "bg-green-400" : "bg-alert"}`} />
          <span className={it.ok ? "text-foreground/80" : "text-muted-foreground"}>
            {it.key}: {it.ok ? "ON" : "OFF"}
          </span>
        </span>
      ))}
      {stale && (
        <span className="flex items-center gap-1.5" title={`Camera list freshness: ${freshness}`}>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400/80" />
          <span className="text-muted-foreground">Cached</span>
        </span>
      )}
    </div>
  );
}
