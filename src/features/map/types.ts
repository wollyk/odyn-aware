// Phase-12 V1 map feature — pure-frontend types.
//
// V1 stores everything in localStorage (one layout per browser). When
// V1.5 ships the persistent backend, this same shape will round-trip
// through /api/agent/map/* — keep it forward-compatible.
//
// Coordinate system:
//   All camera coordinates are in MAP-IMAGE PIXEL SPACE, with the
//   origin at the image's top-left. This is the simplest invariant:
//   one layout = one image = one pixel grid.
//
//   `range_px` (the FOV cone length) is in the same pixel space, so
//   resizing the stage doesn't distort camera footprints. We optionally
//   keep `scale_m_per_px` so V1.5 can convert to real distances when
//   we add object-projection math.

/**
 * A camera placed on the map. `name` is the foreign key into
 * /api/cam/cameras (Frigate name, case-sensitive).
 */
export type CameraPlacement = {
  name: string;
  /** Map-image pixel coordinates of the camera body. */
  x_px: number;
  y_px: number;
  /** Compass-style heading in degrees. 0 = up (north), 90 = right
   *  (east), 180 = down, 270 = left. We use math-y-down convention
   *  internally (canvas y grows down), so degrees → radians flips the
   *  y-axis when drawing. */
  heading_deg: number;
  /** Total horizontal field of view in degrees (e.g. 90 for a typical
   *  surveillance dome). The FOV cone is centered on `heading_deg`
   *  and spans heading±fov/2. */
  fov_deg: number;
  /** Cone length in pixels — visual range, not real-world meters. */
  range_px: number;
  /** Mounting height in meters. Used by 13B auto-projection. */
  height_m: number;
  /** Phase-13B: downward tilt in degrees (0 = perfectly horizontal, 90 =
   *  straight down). Default 15° matches a typical eaves-mounted dome.
   *  Optional so old layouts continue to load; the projection math
   *  falls back to DEFAULT_TILT_DEG when absent. */
  tilt_deg?: number;
  /** Phase-13B.5 escape hatch: 3x3 row-major homography matrix that
   *  overrides the pinhole projection. Populated by the (future)
   *  manual calibration ritual. `null` and missing both mean "use
   *  pinhole". 9 numbers, NOT a fixed-length tuple — `number[]` keeps
   *  serialization simple and old layouts forward-compatible. */
  homography?: number[] | null;
  /** Optional operator note (e.g. "back porch corner, 3m tripod"). */
  notes?: string;
};

/** Default tilt for auto-projection. Most outdoor domes sit at ~10-25°
 *  below horizontal; 15° is a reasonable middle. Operator can override
 *  per-camera with a slider in the inspector. */
export const DEFAULT_TILT_DEG = 15;

/**
 * One map layout. V1 supports a single active layout. `image_data`
 * is a data URL (base64) of the uploaded background image — kept in
 * localStorage; will move to filesystem + URL in V1.5.
 *
 * `version` bumps every time the layout is saved; useful as a sanity
 * check when we add server persistence later (last-write-wins on the
 * higher version).
 */
export type MapLayout = {
  id: string; // uuid-ish
  name: string;
  /** Data URL ("data:image/png;base64,...") or null when no image set. */
  image_data: string | null;
  image_width: number; // px
  image_height: number; // px
  /** Optional real-world scale. Null in V1; populated by the
   *  calibration ritual in V1.5. */
  scale_m_per_px: number | null;
  placements: CameraPlacement[];
  version: number;
  updated_at: number; // epoch ms
};

/** Default placement for a freshly-discovered camera. Operator drags
 *  it from (0, 0) to the right spot before saving. */
export function defaultPlacement(name: string): CameraPlacement {
  return {
    name,
    x_px: 40,
    y_px: 40,
    heading_deg: 0,
    fov_deg: 90,
    range_px: 120,
    height_m: 3.0,
    tilt_deg: DEFAULT_TILT_DEG,
    homography: null,
    notes: undefined,
  };
}

export function emptyLayout(): MapLayout {
  return {
    id: cryptoRandomId(),
    name: "Default",
    image_data: null,
    image_width: 0,
    image_height: 0,
    scale_m_per_px: null,
    placements: [],
    version: 1,
    updated_at: Date.now(),
  };
}

function cryptoRandomId(): string {
  // Avoid pulling in a uuid dep; this is plenty unique for one
  // browser's localStorage.
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
