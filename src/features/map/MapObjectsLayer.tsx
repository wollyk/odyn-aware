// Phase-13B: Konva group that renders projected tracked-object dots.
//
// One small filled circle per ProjectedDot. Color codes the label:
// people are emerald, vehicles are amber, pets are sky. The dot is
// non-listening so it never steals events from cameras underneath.
// A confidence-faded ring shows how trustworthy the projection is.
//
// This component lives INSIDE the map canvas's pan/zoom Layer so it
// inherits the same view transform as the cameras themselves — a dot
// at map-pixel (100, 80) sits at the same location regardless of zoom.

import { Circle, Group, Text } from "react-konva";
import type { ProjectedDot } from "./projection";

export type MapObjectsLayerProps = {
  dots: ProjectedDot[];
  /** When false, only moving tracks are rendered. Defaults to false —
   *  the user said most static blobs are noise on the map. */
  showStatic: boolean;
  /** When true, draw the label next to each dot. */
  showLabels?: boolean;
};

function colorFor(label: string): string {
  if (label === "person") return "#34d399"; // emerald-400
  if (label === "dog" || label === "cat") return "#7dd3fc"; // sky-300
  if (
    label === "car" ||
    label === "truck" ||
    label === "bus" ||
    label === "motorcycle" ||
    label === "bicycle"
  ) {
    return "#fbbf24"; // amber-400
  }
  return "#cbd5e1"; // slate-300 fallback
}

export function MapObjectsLayer({
  dots,
  showStatic,
  showLabels = true,
}: MapObjectsLayerProps) {
  return (
    <Group listening={false}>
      {dots.map((d) => {
        if (!showStatic && d.motion === "static") return null;
        const key = `${d.cameraName}#${d.trackId}`;
        const color = colorFor(d.label);
        const conf = Math.max(0.15, Math.min(1, d.confidence));
        // The outer "halo" fades with confidence; the inner dot is
        // always solid so the operator can still pick it up at a glance.
        const radius = 5;
        const halo = radius + 4;
        return (
          <Group key={key} x={d.x_px} y={d.y_px}>
            <Circle
              radius={halo}
              fill={color}
              opacity={0.18 * conf}
            />
            <Circle
              radius={radius}
              fill={color}
              stroke="#0f172a"
              strokeWidth={1}
              opacity={d.motion === "static" ? 0.6 : 1}
            />
            {showLabels && (
              <Text
                x={radius + 4}
                y={-7}
                text={`${d.label}${d.motion === "static" ? "·s" : ""}`}
                fontSize={10}
                fontFamily="monospace"
                fill="#e2e8f0"
                opacity={0.85}
              />
            )}
          </Group>
        );
      })}
    </Group>
  );
}
