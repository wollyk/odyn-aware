// /admin/map — Phase-12 map + Phase-13B projection + Phase-13C chat.
//
// Layout (Option A, per operator pick):
//
//   ┌── header ─────────────────────────────────────────────────────────┐
//   │── status bar + bg controls ───────────────────────────────────────│
//   │── toolbar: measure · dots toggle · scale ──────────────────────────│
//   ├── 280px inspector │ canvas (1fr) │ 420px chat ──────────────────────│
//   │  · camera list    │  · map + dots │  · agent (text only)            │
//   │  · pose editor    │               │                                  │
//   │  · tilt slider    │               │                                  │
//   └────────────────────────────────────────────────────────────────────┘
//
// The chat panel lives in the same right-rail position as /admin/live so
// muscle memory carries over. It uses the existing ChatPanel component;
// the only difference here is that `cam` is bound to the currently-
// selected map camera (or null when nothing is selected), letting the
// agent answer questions like "what's happening in front of Garage?"
// without us writing a new chat UI.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AdminHeader,
  AuthDeniedScreen,
  AuthLoadingScreen,
  useAdminAuth,
} from "@/components/admin-shell";
import { ChatPanel } from "@/features/live/ChatPanel";
import { useCameras } from "@/features/live/useCameras";
import type { AgentStatus } from "@/features/live/types";
import { MapCanvas } from "@/features/map/MapCanvas";
import { useMapLayout } from "@/features/map/useMapLayout";
import { useAllTrackers } from "@/features/map/useAllTrackers";
import {
  MeasureToolbar,
  useMeasureController,
} from "@/features/map/MeasureTool";
import { DEFAULT_TILT_DEG, type CameraPlacement } from "@/features/map/types";

export const Route = createFileRoute("/admin/map")({
  component: AdminMap,
});

function AdminMap() {
  const { state, me, logout } = useAdminAuth();
  const navigate = useNavigate();
  const { cameras } = useCameras();
  const {
    layout,
    setBackground,
    upsertPlacement,
    removePlacement,
    resetLayout,
    updateLayout,
    ensurePlacementsForCameras,
  } = useMapLayout();

  const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
  const [showStatic, setShowStatic] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const measure = useMeasureController();

  useEffect(() => {
    if (cameras.length === 0) return;
    ensurePlacementsForCameras(cameras.map((c) => c.name));
  }, [cameras, ensurePlacementsForCameras]);

  // Optional harness status: lets the chat panel show "agent online".
  useEffect(() => {
    if (state !== "ok") return;
    let cancelled = false;
    fetch("/api/agent/status", { credentials: "include" })
      .then(async (r) => {
        if (cancelled || !r.ok) return;
        setAgentStatus(await r.json());
      })
      .catch(() => {
        /* harness optional */
      });
    return () => {
      cancelled = true;
    };
  }, [state]);

  const onPickBackground = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onBgFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0] ?? null;
      try {
        await setBackground(f);
      } catch (err) {
        console.error("[map] background upload failed", err);
      } finally {
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [setBackground],
  );

  const openLive = useCallback(
    (name: string) => {
      navigate({ to: "/admin/live", search: { camera: name } as never });
    },
    [navigate],
  );

  const selected = useMemo(
    () => layout.placements.find((p) => p.name === selectedCamera) ?? null,
    [layout.placements, selectedCamera],
  );

  // Bind ChatPanel's cam to the selected placement's underlying Camera
  // record so the agent has the same scene context it does on /admin/live.
  const chatCam = useMemo(() => {
    if (!selectedCamera) return null;
    return cameras.find((c) => c.name === selectedCamera) ?? null;
  }, [cameras, selectedCamera]);

  // Phase-13B: live projected dots, one stream per placed camera.
  const { dots, cameraStatus } = useAllTrackers(
    layout.placements,
    layout.scale_m_per_px,
  );

  const onApplyScale = useCallback(
    (mPerPx: number) => {
      updateLayout({ scale_m_per_px: mPerPx });
    },
    [updateLayout],
  );

  if (state === "loading") return <AuthLoadingScreen />;
  if (state === "denied") return <AuthDeniedScreen />;

  const placedCount = layout.placements.length;
  const totalCams = cameras.length;
  const hasBg = Boolean(layout.image_data);
  const movingDotCount = dots.filter((d) => d.motion !== "static").length;
  const staticDotCount = dots.filter((d) => d.motion === "static").length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminHeader
        active="map"
        me={me}
        logout={logout}
        maxWidthClass="max-w-[1600px]"
      />
      <main className="mx-auto flex max-w-[1600px] flex-col gap-2 px-6 py-4">
        {/* Status + bg controls */}
        <div className="flex flex-wrap items-center justify-between gap-3 border border-foreground/15 bg-foreground/[0.02] px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-foreground/55">
          <div className="flex flex-wrap items-center gap-4">
            <span>[12+13] · map · v1.1</span>
            <span>
              cameras:{" "}
              <span className="text-foreground/85">{placedCount}</span>
              <span className="text-foreground/40"> / {totalCams}</span>
            </span>
            <span>
              layout:{" "}
              <span className="text-foreground/85">
                {hasBg
                  ? `${layout.image_width}×${layout.image_height}`
                  : "no-image"}
              </span>
            </span>
            <span>
              tracks:{" "}
              <span className="text-emerald-400">{movingDotCount}</span>
              <span className="text-foreground/40">
                {" "}
                + {staticDotCount} static
              </span>
            </span>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onBgFile}
            />
            <button
              type="button"
              onClick={onPickBackground}
              className="border border-foreground/30 px-2.5 py-1 text-foreground/85 hover:border-foreground/60 hover:text-foreground"
            >
              {hasBg ? "↻ replace bg" : "↑ upload bg"}
            </button>
            {hasBg && (
              <button
                type="button"
                onClick={() => setBackground(null)}
                className="border border-foreground/15 px-2.5 py-1 text-foreground/55 hover:text-red-400"
              >
                clear bg
              </button>
            )}
            <button
              type="button"
              onClick={() =>
                resetLayout(() =>
                  window.confirm(
                    "Reset map layout? This clears the background and all camera positions.",
                  ),
                )
              }
              className="border border-foreground/15 px-2.5 py-1 text-foreground/55 hover:text-red-400"
            >
              reset
            </button>
          </div>
        </div>

        {/* Phase-13B toolbar: dots toggle + measure */}
        <div className="flex flex-wrap items-center justify-between gap-3 border border-foreground/15 bg-foreground/[0.02] px-4 py-2">
          <label className="flex items-center gap-2 font-mono text-xs text-foreground/70">
            <input
              type="checkbox"
              checked={showStatic}
              onChange={(e) => setShowStatic(e.target.checked)}
            />
            show static dots
            <span className="ml-1 text-foreground/40">
              (default = only moving)
            </span>
          </label>
          <MeasureToolbar
            controller={measure}
            currentMPerPx={layout.scale_m_per_px}
            onApply={onApplyScale}
          />
        </div>

        {/* Three-column body */}
        <div className="grid h-[calc(100vh-260px)] grid-cols-[280px_1fr_420px] gap-3">
          {/* Left rail: inspector */}
          <Inspector
            placement={selected}
            cameras={layout.placements}
            cameraStatus={cameraStatus}
            onSelect={setSelectedCamera}
            onChange={upsertPlacement}
            onRemove={(name) => {
              removePlacement(name);
              setSelectedCamera(null);
            }}
            onOpenLive={openLive}
          />

          {/* Canvas */}
          <div className="border border-foreground/15">
            <MapCanvas
              layout={layout}
              selectedCamera={selectedCamera}
              onSelectCamera={setSelectedCamera}
              onChangePlacement={upsertPlacement}
              onOpenLive={openLive}
              dots={dots}
              showStaticDots={showStatic}
              measure={measure}
            />
          </div>

          {/* Right rail: chat (Phase-13C) */}
          <aside className="flex min-h-0 flex-col border border-foreground/15 bg-foreground/[0.02]">
            <div className="border-b border-foreground/10 px-3 py-2 font-mono text-[10px] uppercase tracking-widest text-foreground/55">
              [13C] · agent ·{" "}
              {chatCam ? (
                <span className="text-foreground/85">{chatCam.name}</span>
              ) : (
                <span className="text-foreground/40">
                  no camera selected
                </span>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatPanel cam={chatCam} agentStatus={agentStatus} />
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

// ---- Inspector panel ---------------------------------------------------

function Inspector({
  placement,
  cameras,
  cameraStatus,
  onSelect,
  onChange,
  onRemove,
  onOpenLive,
}: {
  placement: CameraPlacement | null;
  cameras: CameraPlacement[];
  cameraStatus: Record<string, string>;
  onSelect: (name: string | null) => void;
  onChange: (next: CameraPlacement) => void;
  onRemove: (name: string) => void;
  onOpenLive: (name: string) => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col gap-3 overflow-auto border border-foreground/15 bg-foreground/[0.02] p-3">
      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-foreground/55">
          cameras
        </div>
        {cameras.length === 0 ? (
          <div className="font-mono text-xs text-foreground/55">(none)</div>
        ) : (
          <ul className="space-y-1">
            {cameras.map((c) => {
              const status = cameraStatus[c.name];
              const dot =
                status === "open"
                  ? "text-emerald-400"
                  : status === "reconnecting" || status === "connecting"
                    ? "text-amber-400"
                    : status === "error"
                      ? "text-red-400"
                      : "text-foreground/40";
              return (
                <li key={c.name}>
                  <button
                    type="button"
                    onClick={() => onSelect(c.name)}
                    className={`block w-full px-2 py-1 text-left font-mono text-xs ${
                      placement?.name === c.name
                        ? "border border-amber-400/60 bg-amber-400/10 text-amber-200"
                        : "border border-transparent text-foreground/85 hover:border-foreground/30"
                    }`}
                  >
                    <span className={dot} title={status ?? "idle"}>
                      ●
                    </span>{" "}
                    {c.name}{" "}
                    <span className="text-foreground/40">
                      ({Math.round(c.x_px)}, {Math.round(c.y_px)})
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <hr className="border-foreground/10" />

      {placement ? (
        <PlacementEditor
          placement={placement}
          onChange={onChange}
          onRemove={onRemove}
          onOpenLive={onOpenLive}
        />
      ) : (
        <div className="font-mono text-xs text-foreground/55">
          <div className="mb-1 uppercase tracking-widest text-[10px]">
            no selection
          </div>
          click a camera dot or list item to edit. drag the dot to move; drag
          the amber handle to rotate / extend the FOV cone.
        </div>
      )}
    </aside>
  );
}

function PlacementEditor({
  placement,
  onChange,
  onRemove,
  onOpenLive,
}: {
  placement: CameraPlacement;
  onChange: (next: CameraPlacement) => void;
  onRemove: (name: string) => void;
  onOpenLive: (name: string) => void;
}) {
  const set = (patch: Partial<CameraPlacement>) =>
    onChange({ ...placement, ...patch });

  return (
    <div className="flex flex-col gap-2 font-mono text-xs">
      <div className="font-mono text-[10px] uppercase tracking-widest text-foreground/55">
        selected · {placement.name}
      </div>

      <NumberRow
        label="heading °"
        value={placement.heading_deg}
        min={0}
        max={359}
        step={1}
        onChange={(v) => set({ heading_deg: v })}
      />
      <NumberRow
        label="fov °"
        value={placement.fov_deg}
        min={10}
        max={170}
        step={1}
        onChange={(v) => set({ fov_deg: v })}
      />
      <NumberRow
        label="range px"
        value={placement.range_px}
        min={20}
        max={600}
        step={2}
        onChange={(v) => set({ range_px: v })}
      />
      <NumberRow
        label="height m"
        value={placement.height_m}
        min={0}
        max={20}
        step={0.1}
        onChange={(v) => set({ height_m: v })}
      />
      <NumberRow
        label="tilt °"
        value={placement.tilt_deg ?? DEFAULT_TILT_DEG}
        min={1}
        max={89}
        step={1}
        onChange={(v) => set({ tilt_deg: v })}
      />
      <div className="text-[10px] text-foreground/40">
        tilt = optical-axis pitch below horizontal. 15° matches a typical
        eaves-mounted dome; smaller values project further out.
      </div>

      <label className="block">
        <span className="block text-foreground/55 uppercase tracking-widest text-[10px]">
          notes
        </span>
        <textarea
          rows={2}
          value={placement.notes ?? ""}
          onChange={(e) => set({ notes: e.target.value })}
          className="mt-1 w-full border border-foreground/20 bg-background p-1 font-mono text-xs"
        />
      </label>

      <div className="mt-2 flex flex-col gap-1">
        <button
          type="button"
          onClick={() => onOpenLive(placement.name)}
          className="border border-foreground/30 bg-foreground/5 px-2 py-1 uppercase tracking-widest text-[10px] text-foreground/85 hover:border-foreground/60 hover:text-foreground"
        >
          → open live
        </button>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(`Remove ${placement.name} from map?`))
              onRemove(placement.name);
          }}
          className="border border-foreground/15 px-2 py-1 uppercase tracking-widest text-[10px] text-foreground/55 hover:text-red-400"
        >
          remove from map
        </button>
      </div>
    </div>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between text-[10px] uppercase tracking-widest text-foreground/55">
        <span>{label}</span>
        <span className="text-foreground/85">
          {Number.isInteger(step) ? Math.round(value) : value.toFixed(1)}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 w-full"
      />
    </label>
  );
}
