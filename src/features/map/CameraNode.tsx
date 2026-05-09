// Konva camera-node group: a draggable dot + FOV cone.
//
// One ring (12px circle) marks the camera body. A semi-transparent
// wedge fans out from the ring at `heading_deg ± fov_deg/2` over
// `range_px`. Selection state is carried through props so the parent
// can wire it to the inspector panel.
//
// Rotation gesture: a small handle is rendered at the cone's tip when
// selected. Dragging it updates `heading_deg`. We do this here (vs. a
// number input) because angles are notoriously bad to type and the
// gesture is the killer feature on a 2D map.

import { useCallback, useMemo } from "react";
import { Arc, Circle, Group, Line, Text } from "react-konva";
import type { CameraPlacement } from "./types";

export type CameraNodeProps = {
  placement: CameraPlacement;
  selected: boolean;
  onSelect: (name: string) => void;
  onChange: (next: CameraPlacement) => void;
  onOpenLive: (name: string) => void;
};

const NODE_RADIUS = 8;
const NODE_FILL = "#10b981"; // emerald-500
const NODE_STROKE = "#022c22"; // emerald-950
const CONE_FILL = "rgba(16, 185, 129, 0.18)";
const CONE_STROKE = "rgba(16, 185, 129, 0.55)";
const SELECTED_STROKE = "#fbbf24"; // amber-400
const HANDLE_RADIUS = 6;
const HANDLE_FILL = "#fbbf24";

export function CameraNode({
  placement,
  selected,
  onSelect,
  onChange,
  onOpenLive,
}: CameraNodeProps) {
  // Konva's Arc uses degrees with 0 = +x (east) and grows clockwise
  // through +y (down). Compass heading 0° = up (north), so we shift
  // -90° to align frames.
  const startDeg = placement.heading_deg - 90 - placement.fov_deg / 2;

  // Tip of the cone (used as anchor for the rotation handle).
  const tip = useMemo(() => {
    const headingRad = ((placement.heading_deg - 90) * Math.PI) / 180;
    return {
      x: placement.x_px + Math.cos(headingRad) * placement.range_px,
      y: placement.y_px + Math.sin(headingRad) * placement.range_px,
    };
  }, [placement.x_px, placement.y_px, placement.heading_deg, placement.range_px]);

  const handleDragMoveBody = useCallback(
    (e: { target: { x: () => number; y: () => number } }) => {
      onChange({
        ...placement,
        x_px: Math.round(e.target.x()),
        y_px: Math.round(e.target.y()),
      });
    },
    [onChange, placement],
  );

  // Handle drag → recompute heading from the angle between body and
  // handle position. Range is updated to reflect the new tip distance,
  // which feels intuitive ("pulling the cone longer").
  const handleDragMoveTip = useCallback(
    (e: { target: { x: () => number; y: () => number } }) => {
      const tx = e.target.x();
      const ty = e.target.y();
      const dx = tx - placement.x_px;
      const dy = ty - placement.y_px;
      const range = Math.max(20, Math.round(Math.hypot(dx, dy)));
      // Convert canvas-y-down angle back to compass.
      const angleDeg = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      // Normalize to [0, 360).
      const heading = ((Math.round(angleDeg) % 360) + 360) % 360;
      onChange({ ...placement, heading_deg: heading, range_px: range });
    },
    [onChange, placement],
  );

  return (
    <Group>
      {/* FOV cone — drawn as an Arc with both radii closed by lines. */}
      <Arc
        x={placement.x_px}
        y={placement.y_px}
        innerRadius={0}
        outerRadius={placement.range_px}
        angle={placement.fov_deg}
        rotation={startDeg}
        fill={CONE_FILL}
        stroke={CONE_STROKE}
        strokeWidth={1}
        listening={false}
      />
      {/* Camera body — draggable dot. */}
      <Circle
        x={placement.x_px}
        y={placement.y_px}
        radius={NODE_RADIUS}
        fill={NODE_FILL}
        stroke={selected ? SELECTED_STROKE : NODE_STROKE}
        strokeWidth={selected ? 2.5 : 1.5}
        draggable
        onDragMove={handleDragMoveBody}
        onClick={() => onSelect(placement.name)}
        onTap={() => onSelect(placement.name)}
        onDblClick={() => onOpenLive(placement.name)}
        onDblTap={() => onOpenLive(placement.name)}
      />
      {/* Label below the dot. Pointer-events disabled so it doesn't
          eat clicks on overlapping cones. */}
      <Text
        x={placement.x_px - 60}
        y={placement.y_px + NODE_RADIUS + 4}
        width={120}
        align="center"
        text={placement.name}
        fontSize={11}
        fontStyle="500"
        fontFamily="monospace"
        fill="#e2e8f0"
        listening={false}
      />
      {/* Heading line (subtle), only when selected. */}
      {selected && (
        <Line
          points={[placement.x_px, placement.y_px, tip.x, tip.y]}
          stroke={SELECTED_STROKE}
          strokeWidth={1}
          dash={[4, 4]}
          listening={false}
        />
      )}
      {/* Rotation handle at the cone tip — only when selected. */}
      {selected && (
        <Circle
          x={tip.x}
          y={tip.y}
          radius={HANDLE_RADIUS}
          fill={HANDLE_FILL}
          stroke="#0f172a"
          strokeWidth={1.5}
          draggable
          onDragMove={handleDragMoveTip}
        />
      )}
    </Group>
  );
}
