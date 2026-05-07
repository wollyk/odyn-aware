// Shared types for the /admin/live feature.
//
// Kept separate so hooks, components, and tests can each pick the parts
// they need without pulling JSX dependencies.

export type Camera = {
  name: string;
  label: string;
  enabled: boolean;
  detect_enabled: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  tracks: string[];
};

export type Detection = {
  label: string;
  confidence: number;
  /** Normalized [x, y, w, h], each value in 0..1, (x,y) is top-left of the box. */
  bbox: [number, number, number, number];
};

export type DetectionResult = {
  camera: string;
  detections: Detection[];
  summary: string;
  status: "ok" | "vision_disabled" | "error" | "frigate_not_configured";
  model: string | null;
  tookMs: number;
};

export type AgentStatus = {
  chat_configured: boolean;
  frigate_configured: boolean;
};

export type StreamMode = "snapshot" | "live";

/**
 * Internal state machine of the MSE driver. Note: only "playing" and "error"
 * should ever reach a user-facing label. Everything else collapses into a
 * single "Connecting…" indicator at the UI layer.
 */
export type LiveStatus =
  | "idle"
  | "connecting"
  | "negotiating"
  | "playing"
  | "stalled"
  | "reconnecting"
  | "error"
  | "closed";

/**
 * Resilience metadata returned by /api/cam/cameras. The dropdown should never
 * be empty as long as we've ever seen a value once — even if the upstream
 * (Frigate) is currently down.
 */
export type CameraListResponse = {
  configured: boolean;
  cameras: Camera[];
  freshness: "fresh" | "stale-mem" | "stale-from-disk" | "n/a";
  fetched_at?: string;
  age_ms?: number;
};

export type ToolEvent =
  | { kind: "call"; name: string; args: unknown }
  | { kind: "result"; name: string; result: unknown };

export type ChatMsg =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; pending?: boolean; tools?: ToolEvent[] };
