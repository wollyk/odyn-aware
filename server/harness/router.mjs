// Rule-based escalation engine.
//
// This is the only place where the policy "should we escalate?" lives. Every
// rule here MUST be:
//   - Pure (no I/O, no side effects, no LLM calls).
//   - Auditable: any "yes" decision is paired with a string `reason`.
//   - Cheap: the call must be O(1) on event size for backpressure safety.
//
// The router is invoked at two points in the pipeline:
//   - shouldEscalateT2(classifiedEvent)  → wake local VLM?
//   - shouldEscalateT3(describedEvent)   → wake cloud LLM and/or alert?
//
// If you find yourself wanting to put pattern-matching on free-text fields
// in here, STOP and add a structured field to DescribedEvent instead. The
// previous draft used `scene.includes("[critical]")` and we explicitly
// rejected that.
//
// Independent test surface: the module exports pure decision functions plus
// the policy table they consult. Tests can override the policy.

const DEFAULT_POLICY = Object.freeze({
  // Tier 1 → Tier 2 escalation
  t1_to_t2: {
    require_motion: true,
    object_classes: ["PERSON", "VEHICLE"],   // any of these triggers a T2 wake
    min_confidence: 0.4,                     // ignore low-confidence T0 calls
    weapon_score_threshold: 0.05,            // never miss a weapon hint
    anomaly_score_threshold: 0.5,
    unknown_face_always_t2: true,            // a stranger's face always wakes T2
    // Per-camera hard cap, enforced by quota.mjs separately. Listed here as
    // a hint so test fixtures can simulate it.
    max_t2_per_min_per_cam: 6,
  },
  // Tier 2 → Tier 3 / alert escalation
  t2_to_t3: {
    severity_threshold: "notable",            // alert on >= notable
    weapon_score_alert: 0.4,                  // any high weapon score → alert
    unknown_face_with_change: true,           // stranger + scene change → alert
    require_t2_confidence: 0.5,               // don't alert on low-confidence T2
  },
});

const SEVERITY_ORDER = { normal: 0, notable: 1, critical: 2 };

/**
 * Decide whether a classified event should be sent to T2 (local VLM).
 *
 * @param {object} ev classified event (DetectionEvent + tier1 fields)
 * @param {object} [policy] override the default policy (test injection)
 * @returns {{ escalate: boolean, reason: string }}
 */
export function shouldEscalateT2(ev, policy = DEFAULT_POLICY) {
  const p = policy.t1_to_t2;

  // High-signal triggers BYPASS the motion gate. A weapon visible in a still
  // frame is not "no event"; same for an unknown face.
  if (typeof ev.weapon_score === "number" && ev.weapon_score >= p.weapon_score_threshold) {
    return { escalate: true, reason: `weapon_score=${ev.weapon_score.toFixed(2)}` };
  }
  if (p.unknown_face_always_t2 && Array.isArray(ev.faces) && ev.faces.some((f) => !f.known)) {
    return { escalate: true, reason: "unknown_face" };
  }

  // Lower-signal triggers gate on motion to control cost.
  if (p.require_motion && !ev.motion) {
    return { escalate: false, reason: "no_motion" };
  }

  // Anomaly-detector has noticed something off.
  if (typeof ev.anomaly_score === "number" && ev.anomaly_score >= p.anomaly_score_threshold) {
    return { escalate: true, reason: `anomaly_score=${ev.anomaly_score.toFixed(2)}` };
  }

  // Default object-class gate.
  const matches = (ev.objects || []).filter(
    (o) => p.object_classes.includes(String(o.label).toUpperCase()) && o.score >= p.min_confidence,
  );
  if (matches.length > 0) {
    const top = matches[0];
    return { escalate: true, reason: `object=${top.label}@${top.score.toFixed(2)}` };
  }

  return { escalate: false, reason: "no_trigger" };
}

/**
 * Decide whether a described event should fire an alert (and possibly wake T3).
 *
 * @param {object} ev described event (DescribedEvent shape)
 * @param {object} [policy]
 * @returns {{ escalate: boolean, alert: boolean, reason: string }}
 */
export function shouldEscalateT3(ev, policy = DEFAULT_POLICY) {
  const p = policy.t2_to_t3;

  if (typeof ev.weapon_score === "number" && ev.weapon_score >= p.weapon_score_alert) {
    return { escalate: true, alert: true, reason: `weapon_score=${ev.weapon_score.toFixed(2)}` };
  }

  if (
    p.unknown_face_with_change &&
    Array.isArray(ev.faces) &&
    ev.faces.some((f) => !f.known) &&
    ev.scene_change
  ) {
    return { escalate: true, alert: true, reason: "unknown_face_scene_change" };
  }

  const sevRank = SEVERITY_ORDER[ev.severity ?? "normal"] ?? 0;
  const threshold = SEVERITY_ORDER[p.severity_threshold] ?? 1;
  if (sevRank >= threshold) {
    if (typeof ev.confidence === "number" && ev.confidence < p.require_t2_confidence) {
      return { escalate: false, alert: false, reason: "low_confidence" };
    }
    return { escalate: true, alert: true, reason: `severity=${ev.severity}` };
  }

  return { escalate: false, alert: false, reason: "below_threshold" };
}

/**
 * For a user-typed chat prompt, classify which tier we should call.
 * Used by /api/agent/chat to keep cheap lookups off T3.
 *
 * @param {string} prompt
 * @returns {{ tier: "T2-only" | "T3-tools-only" | "T2-vision-then-T3" | "T3-default", reason: string }}
 */
export function routeChat(prompt) {
  const p = (prompt || "").toLowerCase();

  if (/^(rename|set label|alert me|disable|enable)\b/.test(p)) {
    return { tier: "T3-tools-only", reason: "configuration verb" };
  }
  if (/(what.*see|describe.*now|what.*happening|right now|currently)/.test(p)) {
    return { tier: "T2-vision-then-T3", reason: "eyes-on-glass" };
  }
  if (/(recent events|how many|count|last hour|today|history)/.test(p)) {
    return { tier: "T2-only", reason: "lookup query" };
  }

  return { tier: "T3-default", reason: "general" };
}

export const POLICY = DEFAULT_POLICY;
