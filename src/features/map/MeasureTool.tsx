// Phase-13B: lightweight Measure tool for setting `scale_m_per_px`.
//
// Workflow:
//   1. Operator clicks the toolbar "Measure" button.
//   2. Tool enters "pick-first-point" mode.
//   3. Operator clicks point A on the map.
//   4. Operator clicks point B on the map.
//   5. A prompt appears asking the real distance in meters.
//   6. m_per_px = meters / pixel_distance is committed to the layout.
//
// This component renders ONLY the toolbar button and the prompt; the
// actual click capture lives in MapCanvas because it owns the stage
// event handlers. We expose a small controller hook so MapCanvas can
// hand off two points.
//
// We deliberately do not render any visual overlay inside the canvas
// during pick-mode — Konva-side reactivity would require yet another
// state hoist. Instead, the toolbar shows a status line ("click point
// A…"), which is enough for V1.

import { useCallback, useState } from "react";

export type MeasureState =
  | { phase: "idle" }
  | { phase: "pick-a" }
  | { phase: "pick-b"; a: { x: number; y: number } }
  | {
      phase: "ask-distance";
      a: { x: number; y: number };
      b: { x: number; y: number };
    };

export type MeasureController = {
  state: MeasureState;
  start: () => void;
  cancel: () => void;
  /** Called by MapCanvas when the user clicks a map-pixel point. */
  pickPoint: (x: number, y: number) => void;
  /** Resolves the prompt by submitting a real-world distance. */
  submitDistance: (
    meters: number,
    apply: (mPerPx: number) => void,
  ) => boolean;
};

export function useMeasureController(): MeasureController {
  const [state, setState] = useState<MeasureState>({ phase: "idle" });

  const start = useCallback(() => setState({ phase: "pick-a" }), []);
  const cancel = useCallback(() => setState({ phase: "idle" }), []);

  const pickPoint = useCallback((x: number, y: number) => {
    setState((s) => {
      if (s.phase === "pick-a") return { phase: "pick-b", a: { x, y } };
      if (s.phase === "pick-b") return { phase: "ask-distance", a: s.a, b: { x, y } };
      return s;
    });
  }, []);

  const submitDistance = useCallback(
    (meters: number, apply: (mPerPx: number) => void) => {
      if (state.phase !== "ask-distance") return false;
      if (!isFinite(meters) || meters <= 0) return false;
      const dx = state.b.x - state.a.x;
      const dy = state.b.y - state.a.y;
      const px = Math.sqrt(dx * dx + dy * dy);
      if (px < 4) return false;
      apply(meters / px);
      setState({ phase: "idle" });
      return true;
    },
    [state],
  );

  return { state, start, cancel, pickPoint, submitDistance };
}

// ---- toolbar button + prompt UI ------------------------------------------

export function MeasureToolbar({
  controller,
  currentMPerPx,
  onApply,
}: {
  controller: MeasureController;
  currentMPerPx: number | null;
  onApply: (mPerPx: number) => void;
}) {
  const { state, start, cancel, submitDistance } = controller;
  const [meters, setMeters] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2 font-mono text-xs text-foreground/70">
      {state.phase === "idle" && (
        <button
          type="button"
          onClick={start}
          className="border border-foreground/30 bg-foreground/5 px-2 py-1 text-[10px] uppercase tracking-widest text-foreground/85 hover:bg-foreground/10"
          title="Click two points on the map, then enter the real-world distance to calibrate the map scale."
        >
          ▱ measure
        </button>
      )}
      {state.phase === "pick-a" && (
        <span className="text-amber-300">
          click point A on the map…{" "}
          <button
            type="button"
            onClick={cancel}
            className="ml-2 underline opacity-70 hover:opacity-100"
          >
            cancel
          </button>
        </span>
      )}
      {state.phase === "pick-b" && (
        <span className="text-amber-300">
          click point B on the map…{" "}
          <button
            type="button"
            onClick={cancel}
            className="ml-2 underline opacity-70 hover:opacity-100"
          >
            cancel
          </button>
        </span>
      )}
      {state.phase === "ask-distance" && (
        <span className="flex items-center gap-2">
          distance A→B:
          <input
            type="number"
            step="0.1"
            min="0.1"
            value={meters}
            onChange={(e) => setMeters(e.target.value)}
            className="w-20 border border-foreground/20 bg-background px-2 py-1 text-xs"
            placeholder="meters"
            autoFocus
          />
          <button
            type="button"
            onClick={() => {
              const n = Number(meters);
              if (!submitDistance(n, onApply)) {
                setError("invalid distance or points too close");
                return;
              }
              setMeters("");
              setError(null);
            }}
            className="border border-foreground/30 bg-foreground/5 px-2 py-1 text-[10px] uppercase tracking-widest text-foreground/85 hover:bg-foreground/10"
          >
            apply
          </button>
          <button
            type="button"
            onClick={cancel}
            className="text-[10px] uppercase tracking-widest underline opacity-70 hover:opacity-100"
          >
            cancel
          </button>
          {error && (
            <span className="text-[10px] uppercase tracking-widest text-red-400">
              {error}
            </span>
          )}
        </span>
      )}
      {currentMPerPx && state.phase === "idle" && (
        <span className="text-foreground/55">
          {(currentMPerPx * 100).toFixed(1)} cm/px
        </span>
      )}
    </div>
  );
}
