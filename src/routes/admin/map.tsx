// /admin/map — Phase-12 V1 prototype.
//
// Frontend-only for V1: layout (background image + camera placements)
// lives in localStorage. Cameras are pulled from /api/cam/cameras
// (already an existing surface) and seeded onto the map at default
// positions; operator drags them where they belong.
//
// V1 deliberately stops short of:
//   - object position projection (needs homography calibration → V1.5)
//   - server persistence (needs the backend tables → V1.5)
//   - cross-camera identity (needs re-ID → V2)
//
// Layout:
//   ┌─────────────────────────┬─────────────────┐
//   │ MapCanvas (fills space) │ Inspector       │
//   │                         │  (selected cam) │
//   └─────────────────────────┴─────────────────┘
//   ┌─────────────────────────────────────────┐
//   │ Footer: layout controls (upload / fit)  │
//   └─────────────────────────────────────────┘

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  AdminHeader,
  AuthDeniedScreen,
  AuthLoadingScreen,
  useAdminAuth,
} from "@/components/admin-shell";
import { useCameras } from "@/features/live/useCameras";
import { MapCanvas } from "@/features/map/MapCanvas";
import { useMapLayout } from "@/features/map/useMapLayout";
import type { CameraPlacement } from "@/features/map/types";
import { useState } from "react";

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
    ensurePlacementsForCameras,
  } = useMapLayout();

  const [selectedCamera, setSelectedCamera] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // When cameras arrive from /api/cam/cameras, ensure each has a
  // default placement on the map. Idempotent: existing placements are
  // left alone.
  useEffect(() => {
    if (cameras.length === 0) return;
    ensurePlacementsForCameras(cameras.map((c) => c.name));
  }, [cameras, ensurePlacementsForCameras]);

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
        // Reset so re-picking the same file fires onChange.
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [setBackground],
  );

  const openLive = useCallback(
    (name: string) => {
      // Use a raw href so we don't need to declare a search validator on
      // /admin/live; the live route reads `?camera=` directly from
      // window.location.search and biases its auto-select toward it.
      navigate({ to: "/admin/live", search: { camera: name } as never });
    },
    [navigate],
  );

  const selected = useMemo(
    () => layout.placements.find((p) => p.name === selectedCamera) ?? null,
    [layout.placements, selectedCamera],
  );

  if (state === "loading") return <AuthLoadingScreen />;
  if (state === "denied") return <AuthDeniedScreen />;

  const placedCount = layout.placements.length;
  const totalCams = cameras.length;
  const hasBg = Boolean(layout.image_data);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminHeader active="map" me={me} logout={logout} />
      <main className="mx-auto flex max-w-[1400px] flex-col gap-3 px-6 py-4">
        {/* Top status bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border border-foreground/15 bg-foreground/[0.02] px-4 py-2 font-mono text-[11px] uppercase tracking-widest text-foreground/55">
          <div className="flex flex-wrap items-center gap-4">
            <span>[12] · map · v1</span>
            <span>
              cameras: <span className="text-foreground/85">{placedCount}</span>
              <span className="text-foreground/40"> / {totalCams}</span>
            </span>
            <span>
              layout:{" "}
              <span className="text-foreground/85">
                {hasBg ? `${layout.image_width}×${layout.image_height}` : "no-image"}
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
                  window.confirm("Reset map layout? This clears the background and all camera positions."),
                )
              }
              className="border border-foreground/15 px-2.5 py-1 text-foreground/55 hover:text-red-400"
            >
              reset
            </button>
          </div>
        </div>

        {/* Main split: canvas + inspector */}
        <div className="grid h-[calc(100vh-220px)] grid-cols-[1fr_280px] gap-3">
          <div className="border border-foreground/15">
            <MapCanvas
              layout={layout}
              selectedCamera={selectedCamera}
              onSelectCamera={setSelectedCamera}
              onChangePlacement={upsertPlacement}
              onOpenLive={openLive}
            />
          </div>
          <Inspector
            placement={selected}
            cameras={layout.placements}
            onSelect={setSelectedCamera}
            onChange={upsertPlacement}
            onRemove={(name) => {
              removePlacement(name);
              setSelectedCamera(null);
            }}
            onOpenLive={openLive}
          />
        </div>
      </main>
    </div>
  );
}

// ---- Inspector panel ---------------------------------------------------

function Inspector({
  placement,
  cameras,
  onSelect,
  onChange,
  onRemove,
  onOpenLive,
}: {
  placement: CameraPlacement | null;
  cameras: CameraPlacement[];
  onSelect: (name: string | null) => void;
  onChange: (next: CameraPlacement) => void;
  onRemove: (name: string) => void;
  onOpenLive: (name: string) => void;
}) {
  return (
    <aside className="flex flex-col gap-3 overflow-auto border border-foreground/15 bg-foreground/[0.02] p-3">
      <div>
        <div className="mb-2 font-mono text-[10px] uppercase tracking-widest text-foreground/55">
          cameras
        </div>
        {cameras.length === 0 ? (
          <div className="font-mono text-xs text-foreground/55">(none)</div>
        ) : (
          <ul className="space-y-1">
            {cameras.map((c) => (
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
                  <span className="text-foreground/55">●</span> {c.name}{" "}
                  <span className="text-foreground/40">
                    ({Math.round(c.x_px)}, {Math.round(c.y_px)})
                  </span>
                </button>
              </li>
            ))}
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
          <div className="mb-1 uppercase tracking-widest text-[10px]">no selection</div>
          click a camera dot or list item to edit. drag the dot to move; drag the
          amber handle to rotate / extend the FOV cone.
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
  const set = (patch: Partial<CameraPlacement>) => onChange({ ...placement, ...patch });

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
            if (window.confirm(`Remove ${placement.name} from map?`)) onRemove(placement.name);
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
