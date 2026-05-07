// Tier 2 — local Vision-Language Model client (Ollama).
//
// Talks to an Ollama server (default: http://192.168.0.137:11434) via its
// /api/chat endpoint. Designed for vision-capable models. Empirical findings
// (verified against the actual deployment, May 2026):
//
//   - moondream:latest        ~500ms per call, basic but reliable. DEFAULT.
//   - llama3.2-vision:latest  ~2-4s, better object naming, no JSON-mode safe.
//   - qwen3-vl:8b             ~10s, strong but uses thinking-mode tokens that
//                             eat through num_predict before producing output.
//
// IMPORTANT: do NOT use Ollama's `format: "json"` with small models — the
// grammar-constrained sampling can spin >90s producing nothing. We use
// free-text generation and parse heuristically. The router (router.mjs) is
// the binary decision authority anyway, so we just need cheap structured
// hints from T2.
//
// Cost model: $0 marginal (local hardware). Budget is GPU time, not dollars.
// Latency target: p50 < 1s, p95 < 2s on warm moondream.
//
// Per the design feedback: never trust the model to gate a binary decision
// alone. T2 outputs feed the router (router.mjs), which is the actual
// decision authority.

import { publish, subscribe } from "./eventbus.mjs";
import { TOPIC, SEVERITY } from "./types.mjs";

const OLLAMA_BASE = process.env.OLLAMA_BASE ?? "http://192.168.0.137:11434";
const VLM_MODEL = process.env.OLLAMA_VLM_MODEL ?? "moondream:latest";
const VLM_TIMEOUT_MS = Number(process.env.OLLAMA_VLM_TIMEOUT_MS ?? 8000);
const VLM_KEEP_ALIVE = process.env.OLLAMA_VLM_KEEP_ALIVE ?? "10m";

// Free-text prompt — small VL models like moondream are exquisitely
// sensitive to prompt complexity. Empirically, ANY mention of safety nouns
// ("weapons"), compound directives, or word-count ceilings triggers an
// immediate EOS token (eval_count=1, content=""). The single-sentence
// "Describe this" prompt is the only stable shape we've found that gets
// reliable output.
//
// We rely on the downstream parseFreeTextScene heuristic to scan whatever
// nouns the model produces (person, truck, knife, package, etc.) — we do
// not steer the model toward any particular vocabulary.
const FREE_TEXT_PROMPT = "Describe this in one sentence.";

// Vocabulary buckets used by the heuristic severity parser. Order matters —
// `weaponWords` is checked first because it dominates everything else.
const VOCAB = Object.freeze({
  weapon: ["gun", "pistol", "rifle", "knife", "weapon", "firearm", "blade", "machete"],
  person: ["person", "people", "man", "woman", "child", "individual", "human", "figure", "intruder", "stranger"],
  vehicle: ["car", "truck", "vehicle", "van", "suv", "motorcycle", "bike", "bicycle"],
  package: ["package", "box", "parcel", "bag", "container", "crate"],
  tool: ["tool", "ladder", "crowbar", "hammer", "wrench"],
});

// Phrase-level negative patterns. If any of these match we treat the scene
// as empty, EVEN IF a noun like "people" appears in the negation ("no people
// visible"). Weapon detection still wins over this — a weapon mention
// always escalates regardless of negation context, because false negatives
// on weapons are catastrophic.
const EMPTY_PHRASES = [
  /\bno\s+(?:people|one|person|persons|individuals|humans|activity|movement)\b/,
  /\bempty\s+(?:scene|frame|view|driveway|garage|lot)\b/,
  /\bnothing\s+(?:visible|happening|notable|in\s+view)\b/,
  /\bvacant\b/,
  /\bunoccupied\b/,
];

/** Lower-cased, whitespace-collapsed copy of `text`. */
function norm(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Heuristic parse of free-text into the same structured fields the rest of
 * the harness expects. Pure (no I/O); cheap; deterministic.
 */
export function parseFreeTextScene(text) {
  const t = norm(text);
  const has = (words) => words.some((w) => t.includes(w));

  const hits = {
    weapon: has(VOCAB.weapon),
    person: has(VOCAB.person),
    vehicle: has(VOCAB.vehicle),
    package: has(VOCAB.package),
    tool: has(VOCAB.tool),
    empty: EMPTY_PHRASES.some((re) => re.test(t)),
  };

  let severity = "normal";
  let alert_type = null;
  let confidence = 0.55; // baseline confidence for moondream-class output
  let reason = "no triggers";

  if (hits.weapon) {
    // Weapons override everything — including negation. False negatives
    // on weapons are far worse than false positives.
    severity = "critical";
    alert_type = "weapon_visible";
    confidence = 0.7;
    reason = "weapon noun in scene description";
  } else if (hits.empty) {
    // Explicit negation phrase wins over noun matches like "no people".
    severity = "normal";
    alert_type = null;
    confidence = 0.7;
    reason = "explicit empty scene";
  } else if (hits.person && hits.tool) {
    severity = "notable";
    alert_type = "person_with_tool";
    confidence = 0.6;
    reason = "person + tool noun in scene description";
  } else if (hits.person) {
    severity = "notable";
    alert_type = "person_present";
    confidence = 0.6;
    reason = "person noun in scene description";
  } else if (hits.package) {
    severity = "notable";
    alert_type = "unattended_package";
    confidence = 0.55;
    reason = "package noun in scene description";
  } else if (hits.vehicle) {
    severity = "notable";
    alert_type = "vehicle_present";
    confidence = 0.55;
    reason = "vehicle noun in scene description";
  }

  return {
    scene: t.slice(0, 240),
    severity,
    severity_rank: SEVERITY[severity] ?? 0,
    alert_type,
    confidence,
    reason,
    hits,
  };
}

/**
 * Low-level Ollama chat call. Returns the raw text response and timing info.
 * Throws on transport error, returns `{ ok:false, error }` on protocol error.
 *
 * @param {{ image: Buffer, prompt?: string, model?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} opts
 */
export async function callOllamaVision({
  image,
  prompt = FREE_TEXT_PROMPT,
  model = VLM_MODEL,
  timeoutMs = VLM_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!image || !Buffer.isBuffer(image)) {
    return { ok: false, error: "missing_image", text: "", tookMs: 0 };
  }
  const body = {
    model,
    stream: false,
    keep_alive: VLM_KEEP_ALIVE,
    messages: [
      { role: "user", content: prompt, images: [image.toString("base64")] },
    ],
    options: { temperature: 0.1, num_predict: 80 },
  };
  const t0 = Date.now();
  try {
    const res = await fetchImpl(`${OLLAMA_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const tookMs = Date.now() - t0;
    if (!res.ok) {
      return { ok: false, error: `ollama_${res.status}`, text: "", tookMs, model };
    }
    const json = await res.json();
    const text = json?.message?.content ?? "";
    return {
      ok: true,
      text,
      tookMs,
      model,
      eval_count: json?.eval_count ?? null,
      eval_duration_ms: json?.eval_duration ? Math.round(json.eval_duration / 1e6) : null,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.name === "TimeoutError" ? "timeout" : err?.message ?? "fetch_failed",
      text: "",
      tookMs: Date.now() - t0,
      model,
    };
  }
}

/**
 * Public T2 entry point — describe a single image. Combines `callOllamaVision`
 * with `parseFreeTextScene` to return DescribedEvent-shaped fields.
 *
 * @param {{ image: Buffer, camera?: string, model?: string, fetchImpl?: typeof fetch }} opts
 * @returns {Promise<{ ok:boolean, scene:string, severity:string, severity_rank:number, alert_type:string|null, confidence:number, reason:string, hits:object, raw:string, tier2_meta:object }>}
 */
export async function analyzeFreeText({ image, camera = "", model = VLM_MODEL, fetchImpl } = {}) {
  const call = await callOllamaVision({ image, model, fetchImpl });
  const tier2_meta = {
    model: call.model,
    tookMs: call.tookMs,
    status: call.ok ? "ok" : "error",
    errorDetail: call.ok ? null : call.error,
    eval_count: call.eval_count ?? null,
    eval_duration_ms: call.eval_duration_ms ?? null,
    camera: camera || null,
  };
  if (!call.ok) {
    return {
      ok: false,
      scene: "",
      severity: "normal",
      severity_rank: 0,
      alert_type: null,
      confidence: 0,
      reason: call.error,
      hits: {},
      raw: "",
      tier2_meta,
    };
  }
  const parsed = parseFreeTextScene(call.text);
  return {
    ok: true,
    ...parsed,
    raw: call.text,
    tier2_meta,
  };
}

/**
 * Pipeline `describe()` — used by the bus subscriber. Merges into an existing
 * event. Kept for the harness-internal pipeline path; the API layer now uses
 * `analyzeFreeText` directly.
 *
 * @param {{ event: object, image: Buffer, model?: string }} opts
 */
export async function describe({ event, image, model = VLM_MODEL, fetchImpl } = {}) {
  const out = await analyzeFreeText({ image, camera: event?.cam ?? "", model, fetchImpl });
  return {
    ...event,
    scene: out.scene,
    scene_change: false, // future: compare against per-camera baseline
    severity: out.severity,
    severity_rank: out.severity_rank,
    alert_type: out.alert_type,
    confidence: out.confidence,
    reason: out.reason,
    tier2_detections: [], // moondream doesn't produce bboxes; leave to T3
    tier2_meta: out.tier2_meta,
  };
}

let started = false;
let unsubscribe = null;

/**
 * Wire T2 into the bus. Subscribes to TOPIC.CLASSIFIED, publishes to
 * TOPIC.DESCRIBED. Skips events the router rejects.
 */
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
 * Returns whether Ollama is reachable and which models are loaded.
 */
export async function ping() {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false, status: res.status, model: VLM_MODEL };
    const json = await res.json();
    const models = json?.models?.map((m) => m.name) ?? [];
    return {
      ok: true,
      base: OLLAMA_BASE,
      model: VLM_MODEL,
      model_available: models.includes(VLM_MODEL),
      models,
    };
  } catch (err) {
    return { ok: false, error: err?.message, model: VLM_MODEL };
  }
}

export const TIER2 = { OLLAMA_BASE, VLM_MODEL, VLM_TIMEOUT_MS };
