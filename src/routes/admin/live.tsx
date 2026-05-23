import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { AgentStatus, StreamMode } from "@/features/live/types";
import { useCameras } from "@/features/live/useCameras";
import { VideoTile } from "@/features/live/VideoTile";
import { ChatPanel } from "@/features/live/ChatPanel";
import { DailySummaryPanel } from "@/features/live/DailySummaryPanel";
import { TimelinePanel } from "@/features/live/TimelinePanel";
import {
  AdminHeader,
  AuthDeniedScreen,
  AuthLoadingScreen,
  useAdminAuth,
} from "@/components/admin-shell";

export const Route = createFileRoute("/admin/live")({
  component: AdminLive,
});

function AdminLive() {
  const { state: authState, me, logout, error: authError } = useAdminAuth();
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

  // Pull agent status once we're authenticated. Auth itself is owned by
  // useAdminAuth(); this effect only does the harness-status fetch.
  useEffect(() => {
    if (authState !== "ok") return;
    let cancelled = false;
    fetch("/api/agent/status", { credentials: "include" })
      .then(async (r) => {
        if (cancelled || !r.ok) return;
        setAgentStatus(await r.json());
      })
      .catch(() => { /* harness optional */ });
    return () => { cancelled = true; };
  }, [authState]);

  // Auto-select first camera once we have any. Survives empty intermediates
  // because useCameras keeps last known good — we never accidentally clear.
  // Honor `?camera=NAME` (used by the /admin/map page when an operator
  // double-clicks a node) so the requested camera takes priority over the
  // arbitrary first-in-list pick.
  useEffect(() => {
    if (camList.cameras.length === 0) return;
    if (typeof window !== "undefined") {
      const requested = new URLSearchParams(window.location.search).get("camera");
      if (requested && camList.cameras.some((c) => c.name === requested)) {
        if (camera !== requested) setCamera(requested);
        return;
      }
    }
    if (!camera) setCamera(camList.cameras[0].name);
  }, [camList.cameras, camera]);

  if (authState === "loading") return <AuthLoadingScreen />;
  if (authState === "denied") return <AuthDeniedScreen error={authError} />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminHeader active="live" me={me} logout={logout} maxWidthClass="max-w-[1600px]" />

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        <DailySummaryPanel />

        <div className="mb-4 flex items-center gap-4">
          <span className="font-mono text-xs text-alert">[02]</span>
          <span className="label-mono">Live View</span>
          <span className="h-px flex-1 bg-border" />
          {/* Map shortcut — sits just left of the camera dropdown so an
              operator can pivot from any single camera view to the spatial
              overview without losing the live page in their history. */}
          <Link
            to="/admin/map"
            className="border border-border bg-background px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
            aria-label="Open map overview"
          >
            [ Map ]
          </Link>
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

        <TimelinePanel camera={cam?.name ?? null} />

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
