// Phase-13B: bounding-box → map-pixel projection.
//
// Goal: given a tracked object's bbox in camera image coords (normalized
// 0..1 with (0,0) top-left), produce a single (x_px, y_px) map dot
// for that object, with as little operator calibration as we can get
// away with.
//
// Two layers, fall through:
//
//   1) HOMOGRAPHY (optional, manual). If `placement.homography` is
//      populated (3x3, row-major), we apply it directly to the bbox
//      foot point. Operator-supplied via the future calibration
//      ritual — wins over auto-projection.
//
//   2) AUTO-PROJECTION (default). A simplified pinhole model:
//        - bbox foot point (bottom-center) is the object's ground
//          contact in image coords;
//        - camera height + tilt + assumed vertical FOV give us the
//          downward angle from horizontal to that pixel;
//        - height / tan(angle) → ground-plane distance in meters
//          forward of the camera;
//        - horizontal bbox offset → angular offset around the camera's
//          heading, projecting laterally;
//        - distance in meters / scale_m_per_px = pixels on the map;
//        - rotate into map space using `heading_deg` and offset from
//          the camera node position.
//
// This is intentionally crude. Lens distortion, non-flat ground, and
// the assumption that the bbox-foot equals the object-foot all
// introduce errors. For "where on the map is this car?", at the
// scale of a residential lot, the result is good enough to be useful
// — the operator can see the dot is in the driveway, not the kitchen.
//
// All math is pure-JS, ES2020-compatible, side-effect free. Unit-test
// by importing `projectTrackToMap`.

import { DEFAULT_TILT_DEG, type CameraPlacement } from "./types";

/** A track as it arrives from the tracker WebSocket. */
export type TrackInput = {
  id: number;
  label: string;
  bbox: [number, number, number, number]; // normalized [x, y, w, h]
  motion?: "moving" | "static" | "warming" | null;
  conf?: number;
  verified?: boolean | null;
};

/** Result of projecting one track. `x_px`/`y_px` are in map-image
 * pixel space (same as `CameraPlacement.x_px`). `confidence` is a
 * 0..1 heuristic the renderer can use to fade unreliable dots. */
export type ProjectedDot = {
  cameraName: string;
  trackId: number;
  label: string;
  motion: "moving" | "static" | "warming" | null;
  x_px: number;
  y_px: number;
  /** Range from camera in meters (auto-projection only). */
  range_m?: number;
  /** 0..1; lower = less reliable (e.g. near vanishing-line, very far). */
  confidence: number;
  source: "homography" | "pinhole" | "fallback";
};

const DEFAULT_VERTICAL_FOV_DEG = 50;
const MIN_TILT_DEG = 1;
const MAX_TILT_DEG = 89;
const MAX_REASONABLE_RANGE_M = 80;

// ---- math helpers ---------------------------------------------------------

const deg2rad = (d: number) => (d * Math.PI) / 180;

function rotate2d(dx: number, dy: number, headingDeg: number): { dx: number; dy: number } {
  // Canvas convention: y grows DOWN, +heading rotates clockwise from
  // up-north. So a heading of 0 means forward = -y in screen coords.
  const a = deg2rad(headingDeg);
  // Apply the rotation: x'=cos·x + sin·y, y'=-sin·x + cos·y (CW when y-down).
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // Input is in camera-local frame: +forward = -y_local, +right = +x_local.
  return {
    dx: cos * dx + sin * dy,
    dy: -sin * dx + cos * dy,
  };
}

// ---- homography (optional manual mode) -----------------------------------

function applyHomography(
  H: number[],
  u: number,
  v: number,
): { x: number; y: number } | null {
  if (H.length !== 9) return null;
  const x = H[0] * u + H[1] * v + H[2];
  const y = H[3] * u + H[4] * v + H[5];
  const w = H[6] * u + H[7] * v + H[8];
  if (!isFinite(w) || Math.abs(w) < 1e-9) return null;
  return { x: x / w, y: y / w };
}

// ---- pinhole auto-projection ---------------------------------------------

/** Pinhole-like estimator. See module header for the assumptions.
 *
 * @param placement   camera pose on the map
 * @param footU       bbox foot x (normalized 0..1 in image space)
 * @param footV       bbox foot y (normalized 0..1 in image space; close to 1 = bottom of frame)
 * @param scaleMperPx map-image scale; null → fall back to placement.range_px
 * @returns projected dot or null when geometry is unsolvable
 */
function projectPinhole(
  placement: CameraPlacement,
  footU: number,
  footV: number,
  scaleMperPx: number | null,
): { dx_px: number; dy_px: number; range_m: number; confidence: number } | null {
  const tilt = clamp(placement.tilt_deg ?? DEFAULT_TILT_DEG, MIN_TILT_DEG, MAX_TILT_DEG);
  const fovHDeg = placement.fov_deg || 90;
  // Approximate vertical FOV from horizontal FOV. Most security cameras
  // are ~16:9 sensors; 50° vertical is the common default for a 90° H
  // dome. Fine to be off — the operator can tune via tilt_deg.
  const fovVDeg = Math.min(80, fovHDeg * 0.56);
  // Pitch (downward angle from horizontal) of the foot-pixel.
  // tilt = camera optical-axis pitch below horizontal.
  // v=0.5 means foot is on the optical axis → pitch = tilt.
  // v=1.0 means foot is at the bottom of the frame → pitch = tilt + fovV/2.
  // v=0.0 means foot is at the top → pitch = tilt - fovV/2.
  const pitchDeg = tilt + (footV - 0.5) * fovVDeg;
  if (pitchDeg <= 0) {
    // Foot above the horizon → object is at/above eye level. We can't
    // project to ground; signal a fallback to the caller.
    return null;
  }
  const pitchRad = deg2rad(pitchDeg);
  const h = Math.max(0.5, placement.height_m || 3);
  let range_m = h / Math.tan(pitchRad);
  if (!isFinite(range_m) || range_m <= 0) return null;
  if (range_m > MAX_REASONABLE_RANGE_M) {
    // Clip-and-fade rather than discard — operator still wants to see
    // SOMETHING for a long-range track. Confidence drops to 0.2.
    range_m = MAX_REASONABLE_RANGE_M;
  }

  // Lateral angle from optical axis. footU=0.5 → on axis. footU=0/1 →
  // ± fovH/2 from axis. Yaw in radians; positive = right of heading.
  const yawDeg = (footU - 0.5) * fovHDeg;
  const yawRad = deg2rad(yawDeg);
  // Ground-plane offset relative to camera (camera-local frame).
  // Camera-local: +forward (along heading) = -y_local, +right = +x_local.
  // In meters:
  const right_m = range_m * Math.tan(yawRad);
  const forward_m = range_m; // small-angle simplification; fine for our scale

  // Convert meters → map pixels.
  const m_per_px = scaleMperPx ?? 0.1; // safe default ~10cm/px; tunable via Measure tool
  const px_per_m = m_per_px > 0 ? 1 / m_per_px : 0;
  if (!isFinite(px_per_m) || px_per_m <= 0) return null;
  const dx_local_px = right_m * px_per_m;
  const dy_local_px = -forward_m * px_per_m; // -y = forward on canvas

  // Rotate into map space.
  const rot = rotate2d(dx_local_px, dy_local_px, placement.heading_deg ?? 0);

  // Confidence heuristic. Foot near the top of the frame and ranges
  // beyond ~50m are unreliable; verified static tracks are bumped up
  // by the caller, not here.
  let confidence = 1.0;
  if (footV < 0.5) confidence *= 0.7;
  if (range_m > 30) confidence *= 0.6;
  if (range_m > 50) confidence *= 0.4;
  if (Math.abs(yawDeg) > fovHDeg * 0.4) confidence *= 0.85;
  confidence = clamp(confidence, 0.15, 1);

  return { dx_px: rot.dx, dy_px: rot.dy, range_m, confidence };
}

// ---- entry point ----------------------------------------------------------

/**
 * Project one track into map-pixel space using whichever method is
 * configured on the camera. Returns null when no usable projection is
 * possible (e.g. the foot point is above the horizon and no homography
 * is set).
 */
export function projectTrackToMap(
  placement: CameraPlacement,
  track: TrackInput,
  scaleMperPx: number | null,
): ProjectedDot | null {
  const [bx, by, bw, bh] = track.bbox;
  // Bbox foot point: bottom-center of the bbox. Walking objects'
  // feet are at the bottom of the frame; cars' tyres roughly too.
  const footU = clamp(bx + bw / 2, 0, 1);
  const footV = clamp(by + bh, 0, 1);

  // Try homography first if provided.
  if (placement.homography && placement.homography.length === 9) {
    const m = applyHomography(placement.homography, footU, footV);
    if (m) {
      return {
        cameraName: placement.name,
        trackId: track.id,
        label: track.label,
        motion: track.motion ?? null,
        x_px: m.x,
        y_px: m.y,
        confidence: 0.95,
        source: "homography",
      };
    }
  }

  const pin = projectPinhole(placement, footU, footV, scaleMperPx);
  if (pin) {
    return {
      cameraName: placement.name,
      trackId: track.id,
      label: track.label,
      motion: track.motion ?? null,
      x_px: placement.x_px + pin.dx_px,
      y_px: placement.y_px + pin.dy_px,
      range_m: pin.range_m,
      confidence: pin.confidence,
      source: "pinhole",
    };
  }

  // Fallback: drop the dot at a fixed offset along the camera heading,
  // proportional to FOV cone range. The dot is intentionally not at
  // the camera body so multiple sky-detected tracks don't pile up.
  const rangePx = (placement.range_px || 120) * 0.6;
  const rot = rotate2d(0, -rangePx, placement.heading_deg ?? 0);
  return {
    cameraName: placement.name,
    trackId: track.id,
    label: track.label,
    motion: track.motion ?? null,
    x_px: placement.x_px + rot.dx,
    y_px: placement.y_px + rot.dy,
    confidence: 0.25,
    source: "fallback",
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Helper used by the Measure tool: given two map-image points and a
 *  real-world distance between them in meters, return m_per_px. */
export function computeScaleMperPx(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  realDistanceM: number,
): number | null {
  const dx = bx - ax;
  const dy = by - ay;
  const px = Math.sqrt(dx * dx + dy * dy);
  if (px < 4 || !isFinite(realDistanceM) || realDistanceM <= 0) return null;
  return realDistanceM / px;
}
