// Konva stage that hosts the background image + camera nodes.
//
// V1 sizing model — INTENTIONALLY locked, no pan/zoom:
//   - The Stage matches its parent's width/height (resize-observed).
//   - The background image is fit-to-screen ("contain"): scaled to the
//     largest factor where the whole image stays inside the canvas, then
//     centered horizontally and vertically.
//   - Camera placements live in IMAGE-PIXEL space; the layer transform
//     applies the same fit so cameras follow the image automatically.
//
// We removed the layer-level `draggable` because nested draggables
// (a draggable Circle inside a draggable Layer) caused the map to pan
// alongside the camera node during a drag — confusing, and we don't
// need pan in V1. Operators report "fixed map, draggable cameras" is
// what they want; we'll bring back gestural pan/zoom with proper
// intent isolation in V1.5 if the request comes back.

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

  // Fit-to-screen is recomputed every render from current container size
  // and image natural size. There's no user-controlled view state, so
  // the map is *always* in its canonical fitted position. Cameras follow
  // because they share the same layer transform.
  const fit = useMemo(() => {
    const iw = layout.image_width || 0;
    const ih = layout.image_height || 0;
    if (iw <= 0 || ih <= 0) return { x: 0, y: 0, scale: 1 };
    const scale = Math.min(size.w / iw, size.h / ih);
    return {
      scale,
      x: (size.w - iw * scale) / 2,
      y: (size.h - ih * scale) / 2,
    };
  }, [size.w, size.h, layout.image_width, layout.image_height]);

  // Click on empty stage → deselect. We only deselect when the click
  // target is the stage itself (not a node, not the background image),
  // so dragging cameras doesn't accidentally clear the selection on
  // mouseup.
  const onStageClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (e.target !== e.target.getStage()) return;
      onSelectCamera(null);
    },
    [onSelectCamera],
  );

  const placements = layout.placements;

  // Subtle grid backdrop when no image is set, so the canvas doesn't
  // look like a void on first load.
  const checkerboard = useMemo(() => {
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
      <Stage width={size.w} height={size.h} onClick={onStageClick} onTap={onStageClick}>
        <Layer listening={false}>
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
        {/* Map + camera layer. NOT draggable — see header note. */}
        <Layer x={fit.x} y={fit.y} scaleX={fit.scale} scaleY={fit.scale}>
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

      {/* Bottom-left hint: only the gestures we actually support. */}
      <div className="pointer-events-none absolute bottom-3 left-3 max-w-md font-mono text-[10px] uppercase tracking-widest text-foreground/40">
        drag dot · move camera &nbsp;|&nbsp; drag amber handle · rotate / extend FOV &nbsp;|&nbsp; double-click · open live
      </div>
    </div>
  );
}
