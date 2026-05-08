// Adaptive motion gate.
//
// PROBLEM: /api/agent/detections is polled every 5s by the live UI, and
// each tick costs us a Frigate snapshot fetch + T2 (Ollama VLM ~500ms) +
// face sidecar (~150ms) + weapon sidecar (~80ms). On a quiet scene
// that's 17,280 paid inferences per camera per day, 99% of which find
// nothing.
//
// IDEAL FIX: gate on real motion events from Frigate. But this deployment
// has detect.enabled=false and no MQTT broker, so the WS doesn't publish
// motion (see frigate.mjs::openEventsWs comment). Building a frame-diff
// motion detector would require JPEG decoding on every tick — non-trivial
// and ironically might cost as much as it saves.
//
// SHIP-NOW FIX: use the agent's OWN previous verdict as the motion signal.
//
// State machine (per camera):
//   ACTIVE  — last result had any signal (severity≠normal, unknown faces,
//             weapon=suspicious, or any tracked object). Next call: run
//             full pipeline. Latency-sensitive.
//   IDLE    — last result had no signals. Next call within
//             IDLE_RECHECK_MS: gated (replay last result, took_ms=0).
//             After IDLE_RECHECK_MS: run a confirmation tick. If still
//             empty, stay IDLE; if anything changed, transition to ACTIVE.
//
// Steady-state cost on a quiet camera: 1 paid call per IDLE_RECHECK_MS
// instead of 1 per UI poll period. With UI poll = 5s and IDLE_RECHECK_MS
// = 30s, that's a 6x reduction on idle cameras.
//
// Override: callers can pass { force: true } to bypass the gate (used by
// the admin "force run" UI hint and any /score-now style debug routes).
//
// Failure modes considered:
//   - First call ever on a camera: lastResult is null → never gated.
//   - Recovery from a long IDLE: confirmation tick runs, possibly
//     transitions to ACTIVE.
//   - Transition flapping: cheap to handle because we don't persist state
//     across restarts; on boot every camera starts ACTIVE-by-default
//     (no lastResult), so the first tick after a restart pays full.

import { increment } from "./telemetry.mjs";

/** Default 30-second idle recheck. Overridable via env. */
const IDLE_RECHECK_MS_DEFAULT = 30_000;

const IDLE_RECHECK_MS = (() => {
  const raw = Number(process.env.MOTION_GATE_IDLE_RECHECK_MS ?? IDLE_RECHECK_MS_DEFAULT);
  return Number.isFinite(raw) && raw >= 1000 ? raw : IDLE_RECHECK_MS_DEFAULT;
})();

const ENABLED = (process.env.MOTION_GATE_ENABLED ?? "true").toLowerCase() !== "false";

/**
 * Per-camera state.
 *   lastResult     — full analyzeImageRouted result (used for gated replay)
 *   lastFullRunTs  — when we last ran the pipeline for real (not gated)
 *   state          — "active" | "idle"
 *   gateCount      — total gated returns since the last ACTIVE → IDLE transition
 */
const _byCamera = new Map();

/**
 * Decide whether the gate should short-circuit this call.
 *
 * Returns:
 *   { gate: false }              → caller should run the full pipeline
 *   { gate: true, reason, took } → caller should return the cached result
 *
 * Pure-ish: reads/writes _byCamera but no I/O. `now` is injected so tests
 * can drive the clock.
 *
 * @param {{ camera: string, force?: boolean, now?: number }} args
 */
export function decideGate({ camera, force = false, now = Date.now() } = {}) {
  if (!ENABLED) return { gate: false, reason: "disabled" };
  if (force) {
    increment("motion_gate.force");
    return { gate: false, reason: "force" };
  }
  const slot = _byCamera.get(camera);
  if (!slot || !slot.lastResult) {
    return { gate: false, reason: "no_prior" };
  }
  if (slot.state !== "idle") {
    return { gate: false, reason: "active" };
  }
  // Idle. Has the recheck window elapsed?
  const elapsed = now - (slot.lastFullRunTs ?? 0);
  if (elapsed >= IDLE_RECHECK_MS) {
    return { gate: false, reason: "idle_recheck" };
  }
  slot.gateCount = (slot.gateCount ?? 0) + 1;
  increment("motion_gate.skipped");
  return {
    gate: true,
    reason: `idle_cooldown:${Math.round((IDLE_RECHECK_MS - elapsed) / 1000)}s_remaining`,
    cached_age_ms: elapsed,
  };
}

/**
 * Record a real (non-gated) pipeline run for `camera`. Updates the
 * state machine and stores the result for future gated replays.
 */
export function recordResult({ camera, result, now = Date.now() }) {
  if (!camera || !result) return;
  const hasSignals = resultHasSignals(result);
  const prev = _byCamera.get(camera);
  const prevState = prev?.state ?? "active";
  const nextState = hasSignals ? "active" : "idle";
  if (prevState !== nextState) {
    increment(`motion_gate.transition.${prevState}_to_${nextState}`);
  }
  _byCamera.set(camera, {
    state: nextState,
    lastResult: result,
    lastFullRunTs: now,
    gateCount: nextState === "idle" ? 0 : (prev?.gateCount ?? 0),
  });
}

/**
 * Return the cached previous result for `camera` decorated for gated
 * replay. Caller is `analyzeImageRouted` short-circuit path.
 *
 * @returns {object|null} same shape as analyzeImageRouted, with
 *   `gated:true`, `gate_reason`, `tier:"none"`, `tookMs:0`.
 */
export function gatedReplay({ camera, gateReason, now = Date.now() }) {
  const slot = _byCamera.get(camera);
  if (!slot?.lastResult) return null;
  const ageMs = now - (slot.lastFullRunTs ?? 0);
  return {
    ...slot.lastResult,
    // Override only the fields that are misleading when stale.
    tier: "none",
    tookMs: 0,
    escalation: { ran: false, reason: gateReason, source: "none" },
    gated: true,
    gate_reason: gateReason,
    cached_age_ms: ageMs,
  };
}

/** Diagnostic snapshot — used by /api/agent/status. */
export function inspect() {
  return {
    enabled: ENABLED,
    idle_recheck_ms: IDLE_RECHECK_MS,
    cameras: Object.fromEntries(
      [...byCameraEntries()].map(([cam, s]) => [
        cam,
        {
          state: s.state,
          last_full_run_ts: s.lastFullRunTs,
          last_full_run_iso: new Date(s.lastFullRunTs).toISOString(),
          gates_since_idle: s.gateCount ?? 0,
          last_severity: s.lastResult?.severity ?? null,
          last_alert_type: s.lastResult?.alert_type ?? null,
        },
      ]),
    ),
  };
}

function* byCameraEntries() {
  for (const [k, v] of _byCamera.entries()) yield [k, v];
}

/** Test-only: clear all state. */
export function _resetForTests() {
  _byCamera.clear();
}

/**
 * Decide whether a result indicates "something is going on" worth keeping
 * the camera in ACTIVE polling. Conservative: any of the four signal
 * channels firing keeps us active.
 */
function resultHasSignals(r) {
  if (!r) return false;
  if (r.severity && r.severity !== "normal") return true;
  if (Array.isArray(r.detections) && r.detections.length > 0) return true;
  if ((r.unknown_face_count ?? 0) > 0) return true;
  if (r.weapon?.decision === "suspicious") return true;
  // Optional: a meaningful local_scene with content also counts. We DON'T
  // count it because T2's prose is non-empty even on idle scenes
  // ("an empty driveway, no people present"). Severity is the load-bearing
  // signal here.
  return false;
}
