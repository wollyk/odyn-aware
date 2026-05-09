// Konva stage that hosts the background image + camera nodes.
//
// Sizing strategy:
//   - The Stage matches its parent's width/height (resize-observed).
//   - The background image is rendered at its natural pixel size and
//     translated/scaled by `view` (zoom + pan). Camera placements live
//     in image-pixel space, so they share the same transform.
//   - Wheel + middle-mouse drag pan; shift-wheel zoom. We cap zoom at
//     0.1..4x.
//
// Why one transform instead of CSS-scaled stage:
//   We want the camera dots to stay a constant SCREEN size regardless
//   of zoom (a zoomed-in property still has 8px dots). We do that by
//   un-scaling the dot/handle radii via the inverse of the current
//   zoom; that requires keeping the transform on the stage layer.

import Konva from "konva";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Rect, Stage } from "react-konva";
import { CameraNode } from "./CameraNode";
import type { CameraPlacement, MapLayout } from "./types";

export type MapCanvasProps = {
  layout: MapLayout;
  selectedCamera: string | null;
  onSelectCamera: (name: string | null) => void;
  onChangePlacement: (next: CameraPlacement) => void;
  onOpenLive: (name: string) => void;
};

export function MapCanvas({
  layout,
  selectedCamera,
  onSelectCamera,
  onChangePlacement,
  onOpenLive,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);

  // ResizeObserver — keep the stage flush with its parent.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect;
        if (width > 0 && height > 0) setSize({ w: Math.floor(width), h: Math.floor(height) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Decode the image data URL into an HTMLImageElement Konva can paint.
  useEffect(() => {
    if (!layout.image_data) {
      setBgImage(null);
      return;
    }
    const img = new window.Image();
    img.onload = () => setBgImage(img);
    img.onerror = () => setBgImage(null);
    img.src = layout.image_data;
  }, [layout.image_data]);

  // Auto-fit: when an image first loads (or the container resizes
  // before any user pan/zoom), center it in the stage.
  const userInteractedRef = useRef(false);
  useEffect(() => {
    if (userInteractedRef.current) return;
    if (!layout.image_width || !layout.image_height) return;
    const fitScale = Math.min(
      size.w / layout.image_width,
      size.h / layout.image_height,
      1,
    );
    setView({
      x: (size.w - layout.image_width * fitScale) / 2,
      y: (size.h - layout.image_height * fitScale) / 2,
      scale: fitScale,
    });
  }, [size.w, size.h, layout.image_width, layout.image_height]);

  // Wheel = pan, shift+wheel = zoom around cursor. Middle-button drag
  // is also pan but Konva handles that via `draggable` on the layer.
  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      userInteractedRef.current = true;
      if (e.evt.shiftKey) {
        const stage = e.target.getStage();
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        if (!pointer) return;
        const oldScale = view.scale;
        const dir = e.evt.deltaY > 0 ? -1 : 1;
        const factor = 1 + dir * 0.1;
        const newScale = Math.max(0.1, Math.min(4, oldScale * factor));
        // Anchor zoom around the cursor.
        const mx = (pointer.x - view.x) / oldScale;
        const my = (pointer.y - view.y) / oldScale;
        setView({
          scale: newScale,
          x: pointer.x - mx * newScale,
          y: pointer.y - my * newScale,
        });
      } else {
        setView((v) => ({ ...v, x: v.x - e.evt.deltaX, y: v.y - e.evt.deltaY }));
      }
    },
    [view],
  );

  // Click on empty stage → deselect.
  const onStageClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      // If the click bubbled up from a node, ignore it.
      if (e.target !== e.target.getStage() && e.target.className !== "Rect") return;
      onSelectCamera(null);
    },
    [onSelectCamera],
  );

  const placements = layout.placements;

  // Inverse-scale the handles inside CameraNode by overriding via a
  // Group transform. Right now the camera node draws constant-pixel
  // dots; if they need to stay constant SCREEN size we wrap them in a
  // Group that pre-multiplies by 1/view.scale. V1 keeps it simple and
  // lets dots grow/shrink with the map — easier to read at a glance.

  const checkerboard = useMemo(() => {
    // When no image is loaded, draw a subtle grid so the operator
    // sees they're inside a working canvas instead of a void.
    const gridSize = 40;
    const cells: { x: number; y: number; key: string }[] = [];
    if (layout.image_data) return cells;
    for (let y = 0; y < size.h; y += gridSize) {
      for (let x = 0; x < size.w; x += gridSize) {
        if (((x + y) / gridSize) % 2 === 0) cells.push({ x, y, key: `${x}-${y}` });
      }
    }
    return cells;
  }, [size.w, size.h, layout.image_data]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-foreground/[0.02]"
      onContextMenu={(e) => e.preventDefault()}
    >
      <Stage
        width={size.w}
        height={size.h}
        onWheel={onWheel}
        onClick={onStageClick}
        onTap={onStageClick}
      >
        <Layer listening={false}>
          {/* Backdrop pattern when no image. */}
          {checkerboard.map((c) => (
            <Rect
              key={c.key}
              x={c.x}
              y={c.y}
              width={40}
              height={40}
              fill="rgba(255,255,255,0.015)"
            />
          ))}
        </Layer>
        <Layer
          x={view.x}
          y={view.y}
          scaleX={view.scale}
          scaleY={view.scale}
          draggable
          onDragEnd={(e) => {
            userInteractedRef.current = true;
            setView((v) => ({ ...v, x: e.target.x(), y: e.target.y() }));
          }}
        >
          {bgImage && (
            <KonvaImage
              image={bgImage}
              x={0}
              y={0}
              width={layout.image_width}
              height={layout.image_height}
              listening={false}
            />
          )}
          {/* Camera nodes — drawn last so they sit above the image. */}
          {placements.map((p) => (
            <CameraNode
              key={p.name}
              placement={p}
              selected={p.name === selectedCamera}
              onSelect={onSelectCamera}
              onChange={onChangePlacement}
              onOpenLive={onOpenLive}
            />
          ))}
        </Layer>
      </Stage>

      {/* HUD: zoom level + reset-fit hint. Pure DOM, sits above the
          stage. Doesn't capture pointer events except on the buttons. */}
      <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-foreground/55">
        <span className="bg-black/60 px-2 py-0.5">
          {Math.round(view.scale * 100)}%
        </span>
        <button
          type="button"
          className="pointer-events-auto bg-black/60 px-2 py-0.5 hover:text-foreground"
          onClick={() => {
            userInteractedRef.current = false;
            // re-trigger auto-fit by nudging size state
            setSize((s) => ({ ...s }));
          }}
        >
          fit
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 max-w-md font-mono text-[10px] uppercase tracking-widest text-foreground/40">
        scroll · pan &nbsp;|&nbsp; shift+scroll · zoom &nbsp;|&nbsp; drag empty area · pan &nbsp;|&nbsp; double-click camera · open live
      </div>
    </div>
  );
}
