// Tier 2 — local Vision-Language Model client (Ollama).
//
// Talks to an Ollama server (default: http://192.168.0.137:11434) via its
// /api/chat endpoint. Designed for vision-capable models like:
//   - llama3.2-vision:11b   (faster, good baseline)
//   - qwen2.5-vl:7b         (slower, higher accuracy)
//
// Cost model: $0 marginal (local hardware). Budget is GPU time, not dollars.
// Latency target: p50 < 2s, p95 < 4s.
//
// Output schema: structured DescribedEvent fields. We deliberately don't
// pattern-match on free-text — the model is asked to return JSON with
// structured fields severity/alert_type/confidence/reason.
//
// Per the design feedback: never trust the model to gate a binary decision
// alone. T2 outputs feed the router (router.mjs), which is the actual
// decision authority.

import { publish, subscribe } from "./eventbus.mjs";
import { TOPIC, SEVERITY } from "./types.mjs";

const OLLAMA_BASE = process.env.OLLAMA_BASE ?? "http://192.168.0.137:11434";
const VLM_MODEL = process.env.OLLAMA_VLM_MODEL ?? "llama3.2-vision:11b";

const SYSTEM_PROMPT = [
  "You are a security camera vision analyst. Examine the supplied image and",
  "respond with a JSON object containing these fields ONLY:",
  '  "scene":        one short sentence (<= 14 words)',
  '  "scene_change": boolean — does the scene look meaningfully different from a typical empty view',
  '  "severity":     one of "normal", "notable", "critical"',
  '  "alert_type":   short tag (e.g. "person_present", "vehicle_arriving", "unknown_face", "loitering") or null',
  '  "confidence":   number 0..1 indicating how confident you are in the call',
  '  "reason":       one short sentence justifying the severity',
  '  "detections":   array of {"label", "confidence", "bbox": [x,y,w,h]} with normalized 0..1 bboxes',
  "",
  "Rules:",
  "  - 'critical' is reserved for visible weapons, fights, or active break-in attempts.",
  "  - 'notable' covers unknown people, after-hours activity, or unattended packages.",
  "  - 'normal' covers known activity, empty scenes, expected vehicles.",
  "  - Never use markdown fences. Output raw JSON only.",
].join(" ");

/**
 * Describe a snapshot. Returns DescribedEvent fields to be merged into the
 * inbound event.
 *
 * @param {{ event: object, image: Buffer, model?: string }} opts
 * @returns {Promise<object>} merged event with tier2 fields appended
 */
export async function describe({ event, image, model = VLM_MODEL }) {
  const t0 = Date.now();
  const dataUrl = `data:image/jpeg;base64,${image.toString("base64")}`;
  // Ollama's /api/chat accepts `images: [base64-no-prefix]` for VLMs.
  const body = {
    model,
    stream: false,
    format: "json",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Camera: ${event.cam}. Analyze this frame.`,
        images: [image.toString("base64")],
      },
    ],
    options: { temperature: 0.1 },
  };

  let parsed = {};
  let status = "ok";
  let errorDetail = null;
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      status = "error";
      errorDetail = `ollama ${res.status}`;
    } else {
      const json = await res.json();
      const content = json?.message?.content ?? "{}";
      try {
        parsed = JSON.parse(content);
      } catch {
        status = "error";
        errorDetail = "non_json_reply";
      }
    }
  } catch (err) {
    status = "error";
    errorDetail = err?.message ?? "fetch_failed";
    // dataUrl unused when fetch fails; reference to keep linters happy
    void dataUrl;
  }

  const tookMs = Date.now() - t0;

  const sev = ["normal", "notable", "critical"].includes(parsed.severity)
    ? parsed.severity
    : "normal";

  return {
    ...event,
    scene: typeof parsed.scene === "string" ? parsed.scene : "",
    scene_change: Boolean(parsed.scene_change),
    severity: sev,
    severity_rank: SEVERITY[sev] ?? 0,
    alert_type: typeof parsed.alert_type === "string" ? parsed.alert_type : null,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    // T2 may also propose detections; we keep them separate from T0/T1 boxes
    // so each stage's contribution is auditable.
    tier2_detections: Array.isArray(parsed.detections) ? parsed.detections : [],
    tier2_meta: { model, tookMs, status, errorDetail },
  };
}

/**
 * Wire T2 into the bus. Subscribes to TOPIC.CLASSIFIED, publishes to
 * TOPIC.DESCRIBED. Skips events the router rejects.
 *
 * Note: this stage requires an `image` lookup function provided by the
 * caller (we pass camera name, the caller resolves to bytes). This avoids
 * the harness needing a hard dependency on frigate.mjs — keeping the
 * decoupling boundary clean.
 */
let started = false;
let unsubscribe = null;

export function start({ fetchSnapshot, router } = {}) {
  if (started) return;
  if (typeof fetchSnapshot !== "function") {
    throw new Error("tier2.start requires { fetchSnapshot } to look up images");
  }
  if (!router?.shouldEscalateT2) {
    throw new Error("tier2.start requires { router: { shouldEscalateT2 } }");
  }
  started = true;
  unsubscribe = subscribe(TOPIC.CLASSIFIED, async (ev) => {
    const decision = router.shouldEscalateT2(ev);
    if (!decision.escalate) return;
    try {
      const image = await fetchSnapshot(ev.cam);
      const out = await describe({ event: ev, image });
      publish(TOPIC.DESCRIBED, out);
    } catch (err) {
      console.error("[tier2] describe failed:", err?.message);
    }
  });
}

export function stop() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  started = false;
}

/**
 * Cheap status reporter — used by /api/agent/status to indicate availability.
 */
export async function ping() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    return { ok: true, models: json?.models?.map((m) => m.name) ?? [] };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}

export const TIER2 = { OLLAMA_BASE, VLM_MODEL };
