// Konva stage that hosts the background image + camera nodes.
//
// Sizing & gesture model:
//   - Stage matches its parent's width/height (resize-observed).
//   - Background fits-to-contain on first load. After that the operator
//     owns the view: drag empty area to pan, wheel to pan, shift+wheel
//     to zoom around the cursor. A "fit" button restores the framed
//     view if they get lost.
//   - Camera placements live in IMAGE-PIXEL space and inherit the
//     layer transform, so they pan/zoom with the image automatically.
//
// PAN IMPLEMENTATION — read me before changing this file:
//
//   We do NOT make the content layer Konva-draggable. Two earlier
//   attempts ran aground:
//
//     attempt 1: layer.draggable = true. Worked, but a near-miss click
//                on the small (8px) camera dot fell through to the
//                pannable layer, so dragging "near a camera" panned the
//                map and looked like the camera was hauling the map.
//
//     attempt 2: dragstart guard on the layer that called
//                `layer.stopDrag()` if the actual drag target was a
//                child node. Konva's drag is GLOBAL — only one node
//                drags at a time — so `stopDrag()` aborted whatever
//                drag was active, including the camera dot's. That
//                killed camera dragging entirely.
//
//   Working approach: keep camera dots Konva-draggable (their own
//   isolated drag), and implement layer pan at the STAGE level using
//   plain mousedown/mousemove/mouseup. The pan handler only engages
//   when `e.target === stage` — i.e. the cursor missed every listening
//   shape. Clicking a camera dot or rotation handle reports
//   `e.target === Circle`, the pan handler bails, and Konva runs the
//   Circle's drag in the normal way. No nested draggables means no
//   hierarchy conflict.

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

  // True once the operator has manually panned/zoomed. Stops auto-fit
  // from yanking their view back when the container resizes.
  const userInteractedRef = useRef(false);

  // Pan state lives in refs so we don't re-render on every mousemove
  // event during a pan (we only re-render via setView with the
  // committed delta).
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ mouseX: 0, mouseY: 0, viewX: 0, viewY: 0 });

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

  // Auto-fit the background to "contain" on first load + container
  // resizes, but only if the operator hasn't started panning/zooming.
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

  // Wheel = pan; shift+wheel = zoom around cursor.
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
        const factor = 1 + (e.evt.deltaY > 0 ? -0.1 : 0.1);
        const newScale = Math.max(0.1, Math.min(4, oldScale * factor));
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

  // Stage-level pan — see the file header for why this isn't a layer
  // draggable. Engages only when the cursor missed every listening
  // shape (camera dot, rotation handle), so camera drag and map pan
  // never compete for the same gesture.
  const onStageMouseDown = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      const stage = e.target.getStage();
      if (!stage) return;
      if (e.target !== stage) return; // a listening shape will handle it
      const pt = stage.getPointerPosition();
      if (!pt) return;
      isPanningRef.current = true;
      userInteractedRef.current = true;
      panStartRef.current = {
        mouseX: pt.x,
        mouseY: pt.y,
        viewX: view.x,
        viewY: view.y,
      };
    },
    [view.x, view.y],
  );

  const onStageMouseMove = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (!isPanningRef.current) return;
      const stage = e.target.getStage();
      if (!stage) return;
      const pt = stage.getPointerPosition();
      if (!pt) return;
      const dx = pt.x - panStartRef.current.mouseX;
      const dy = pt.y - panStartRef.current.mouseY;
      setView((v) => ({
        ...v,
        x: panStartRef.current.viewX + dx,
        y: panStartRef.current.viewY + dy,
      }));
    },
    [],
  );

  const endPan = useCallback(() => {
    isPanningRef.current = false;
  }, []);

  // Window-level safety net: if the operator releases the mouse off
  // the stage (e.g. on the inspector panel), we still need to end the
  // pan or the next mousemove over the stage would treat it as a
  // continuation.
  useEffect(() => {
    window.addEventListener("mouseup", endPan);
    window.addEventListener("touchend", endPan);
    window.addEventListener("touchcancel", endPan);
    return () => {
      window.removeEventListener("mouseup", endPan);
      window.removeEventListener("touchend", endPan);
      window.removeEventListener("touchcancel", endPan);
    };
  }, [endPan]);

  // Click on truly empty stage → deselect. Konva's onClick fires only
  // when mousedown and mouseup land at the same point, so a pan won't
  // accidentally clear the selection.
  const onStageClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (e.target !== e.target.getStage()) return;
      onSelectCamera(null);
    },
    [onSelectCamera],
  );

  // Reset back to fit-to-screen.
  const refit = useCallback(() => {
    userInteractedRef.current = false;
    setSize((s) => ({ ...s }));
  }, []);

  const placements = layout.placements;

  // Subtle grid backdrop when no image is set.
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
      <Stage
        width={size.w}
        height={size.h}
        onWheel={onWheel}
        onMouseDown={onStageMouseDown}
        onTouchStart={onStageMouseDown}
        onMouseMove={onStageMouseMove}
        onTouchMove={onStageMouseMove}
        onMouseUp={endPan}
        onTouchEnd={endPan}
        onClick={onStageClick}
        onTap={onStageClick}
      >
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
        {/* Content layer: NOT draggable. View transform comes from
            stage-level pan/zoom handlers above. */}
        <Layer x={view.x} y={view.y} scaleX={view.scale} scaleY={view.scale}>
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

      {/* HUD: zoom indicator + manual fit. */}
      <div className="pointer-events-none absolute right-3 top-3 flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-foreground/55">
        <span className="bg-black/60 px-2 py-0.5">{Math.round(view.scale * 100)}%</span>
        <button
          type="button"
          onClick={refit}
          className="pointer-events-auto bg-black/60 px-2 py-0.5 hover:text-foreground"
        >
          fit
        </button>
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 max-w-md font-mono text-[10px] uppercase tracking-widest text-foreground/40">
        drag empty area · pan map &nbsp;|&nbsp; scroll · pan &nbsp;|&nbsp; shift+scroll · zoom &nbsp;|&nbsp; drag dot · move camera &nbsp;|&nbsp; double-click · open live
      </div>
    </div>
  );
}
