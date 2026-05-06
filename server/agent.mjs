// AuroraView agent backend (minimal harness — proper harness comes later).
//
// Two surfaces:
//   1. streamChatGpt({ messages, camera, user, db, signal }) → async generator
//      yielding SSE-shaped objects: { type: "text", delta } | { type: "tool", ... } |
//      { type: "done" } | { type: "error", message }.
//
//   2. analyzeImage({ imageBuffer, camera, user, db }) → resolves to
//      { detections: [{ label, confidence, bbox: [x,y,w,h] }], summary, model, tookMs }
//      where bbox is normalized 0..1.
//
// Both gracefully degrade if OPENAI_API_KEY is missing/placeholder:
//   - chat returns one assistant message explaining how to enable
//   - analyzeImage returns { detections: [], status: "vision_disabled" }
//
// Tools available to the chat:
//   - list_cameras
//   - rename_camera({camera,label})           writes to cam_labels
//   - get_recent_events({camera,limit})       reads Frigate events
//   - propose_alert_rule({camera,description,spec})  writes to alert_rules
//
// We do ONE tool round (model → tool calls → results → model) and stop. No loops.

import * as frigate from "./frigate.mjs";
import { setCamLabel, listCamLabels, insertAlertRule, listAlertRules } from "./db.mjs";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const OPENAI_BASE = process.env.OPENAI_BASE ?? "https://api.openai.com/v1";
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
const VISION_MODEL = process.env.OPENAI_VISION_MODEL ?? "gpt-4o-mini";

function isPlaceholderKey(key) {
  return !key || key === "sk-PLACEHOLDER" || key.startsWith("sk-ant-PLACEHOLDER");
}

export function isChatConfigured() {
  return !isPlaceholderKey(OPENAI_KEY);
}

// ---- Tool definitions (OpenAI function-calling shape) ----------------------

const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_cameras",
      description: "List all cameras on this AuroraView site, including any custom display labels.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_camera",
      description:
        "Set the human-friendly display label for a camera. The wire-name (Frigate name) does not change.",
      parameters: {
        type: "object",
        properties: {
          camera: { type: "string", description: "Frigate camera wire name, e.g. 'Garage'" },
          label: { type: "string", description: "Display label, e.g. 'CAM 01 · GARAGE-A'" },
        },
        required: ["camera", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_recent_events",
      description: "Return the most recent Frigate events for a camera (or all cameras).",
      parameters: {
        type: "object",
        properties: {
          camera: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_alert_rule",
      description:
        "Persist a proposed alert rule (e.g. 'alert me when a person enters Garage outside 7am-7pm'). Saves to the alert_rules table with status='proposed'. Detection wiring is implemented later.",
      parameters: {
        type: "object",
        properties: {
          camera: { type: "string" },
          description: { type: "string", description: "Natural-language description of the rule" },
          spec: {
            type: "object",
            description:
              "Structured rule spec, e.g. { trigger: 'person_detected', conditions: [{kind:'time_window',outside:[\"07:00\",\"19:00\"]}], action:'notify' }",
          },
        },
        required: ["camera", "description"],
      },
    },
  },
];

// ---- Tool execution ---------------------------------------------------------

async function runTool(name, args, ctx) {
  try {
    if (name === "list_cameras") {
      const cams = await frigate.listCameras();
      const labels = listCamLabels(ctx.db);
      const lookup = new Map(labels.map((l) => [l.camera, l.label]));
      return {
        ok: true,
        cameras: cams.map((c) => ({
          name: c.name,
          label: lookup.get(c.name) ?? c.name,
          enabled: c.enabled,
          detect_enabled: c.detect_enabled,
          width: c.width,
          height: c.height,
          fps: c.fps,
          tracks: c.tracks,
        })),
      };
    }
    if (name === "rename_camera") {
      const camera = String(args?.camera ?? "").trim();
      const label = String(args?.label ?? "").trim();
      if (!camera || !label) return { ok: false, error: "camera and label required" };
      // Verify camera exists in Frigate.
      const cams = await frigate.listCameras();
      if (!cams.find((c) => c.name === camera)) {
        return { ok: false, error: `unknown camera '${camera}'`, available: cams.map((c) => c.name) };
      }
      setCamLabel(ctx.db, { camera, label, updated_by: ctx.user?.id ?? null });
      return { ok: true, camera, label };
    }
    if (name === "get_recent_events") {
      const camera = args?.camera || undefined;
      const limit = Math.min(Math.max(Number(args?.limit ?? 10), 1), 50);
      const events = await frigate.getEvents({ camera, limit });
      return {
        ok: true,
        count: events.length,
        events: events.map((e) => ({
          id: e.id,
          camera: e.camera,
          label: e.label,
          start_time: e.start_time,
          end_time: e.end_time,
          score: e.data?.score ?? e.top_score ?? null,
        })),
      };
    }
    if (name === "propose_alert_rule") {
      const camera = String(args?.camera ?? "").trim();
      const description = String(args?.description ?? "").trim();
      if (!camera || !description) return { ok: false, error: "camera and description required" };
      const rec = insertAlertRule(ctx.db, {
        camera,
        description,
        spec: args?.spec ?? {},
        created_by: ctx.user?.id ?? null,
      });
      return { ok: true, rule: rec };
    }
    return { ok: false, error: `unknown tool: ${name}` };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---- System prompt ----------------------------------------------------------

function buildSystemPrompt({ camera, cameraLabel }) {
  return [
    "You are AuroraView, an on-site intelligence agent that operates a small fleet of cameras and runs",
    "policy-driven detection. You speak concisely, like a SOC operator: technical, terse, factual.",
    "Never invent detections. If asked what is happening on camera, prefer to call get_recent_events",
    "or refer to the latest snapshot description supplied in the user message.",
    `Current camera: ${camera}${cameraLabel && cameraLabel !== camera ? ` (display label: "${cameraLabel}")` : ""}.`,
    "If a user wants to rename a camera, call rename_camera(). If they want an alert rule, call propose_alert_rule().",
    "Frigate's built-in detector is currently OFF on these cameras, so events may be empty —",
    "the live overlay is produced by snapshot vision analysis at ~5s cadence.",
  ].join(" ");
}

// ---- Streaming chat (one tool round, then final answer) ---------------------

async function callOpenAI(body, { signal } = {}) {
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`openai ${res.status}: ${text.slice(0, 200)}`);
  }
  return res;
}

async function* streamSseFromOpenAI(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        yield JSON.parse(payload);
      } catch {
        // ignore malformed
      }
    }
  }
}

export async function* streamChatGpt({ messages, camera, cameraLabel, db, user, signal }) {
  if (!isChatConfigured()) {
    yield {
      type: "text",
      delta:
        `Chat is wired but no OpenAI API key is configured yet. ` +
        `Set OPENAI_API_KEY in /etc/odyn-aware/api.env and restart odyn-api to enable. ` +
        `Snapshot polling and camera proxy already work.`,
    };
    yield { type: "done" };
    return;
  }

  const system = { role: "system", content: buildSystemPrompt({ camera, cameraLabel }) };
  const round1Messages = [system, ...messages];

  // ---- Round 1: stream, capture text + any tool calls ----
  let res;
  try {
    res = await callOpenAI(
      {
        model: CHAT_MODEL,
        messages: round1Messages,
        tools: TOOLS,
        stream: true,
        temperature: 0.2,
      },
      { signal },
    );
  } catch (err) {
    yield { type: "error", message: err.message };
    yield { type: "done" };
    return;
  }

  let assistantText = "";
  const toolCallAcc = new Map(); // index → { id, name, argsBuf }
  for await (const chunk of streamSseFromOpenAI(res)) {
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;
    if (delta.content) {
      assistantText += delta.content;
      yield { type: "text", delta: delta.content };
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        let acc = toolCallAcc.get(idx);
        if (!acc) {
          acc = { id: tc.id, name: "", argsBuf: "" };
          toolCallAcc.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.argsBuf += tc.function.arguments;
      }
    }
  }

  if (toolCallAcc.size === 0) {
    yield { type: "done" };
    return;
  }

  // ---- Tool execution ----
  const toolMessages = [];
  const toolCalls = [];
  for (const [, acc] of toolCallAcc) {
    let parsed = {};
    try {
      parsed = JSON.parse(acc.argsBuf || "{}");
    } catch {
      parsed = { _raw: acc.argsBuf };
    }
    yield { type: "tool", name: acc.name, args: parsed };
    const result = await runTool(acc.name, parsed, { db, user });
    yield { type: "tool_result", name: acc.name, result };
    toolCalls.push({
      id: acc.id,
      type: "function",
      function: { name: acc.name, arguments: acc.argsBuf || "{}" },
    });
    toolMessages.push({
      role: "tool",
      tool_call_id: acc.id,
      content: JSON.stringify(result),
    });
  }

  // ---- Round 2: feed tool results back, stream final answer ----
  const round2Messages = [
    system,
    ...messages,
    { role: "assistant", content: assistantText || null, tool_calls: toolCalls },
    ...toolMessages,
  ];

  let res2;
  try {
    res2 = await callOpenAI(
      {
        model: CHAT_MODEL,
        messages: round2Messages,
        stream: true,
        temperature: 0.2,
      },
      { signal },
    );
  } catch (err) {
    yield { type: "error", message: err.message };
    yield { type: "done" };
    return;
  }

  for await (const chunk of streamSseFromOpenAI(res2)) {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.content) yield { type: "text", delta: delta.content };
  }
  yield { type: "done" };
}

// ---- Vision: analyze a snapshot ---------------------------------------------

const VISION_PROMPT = [
  "You are a security camera vision analyst. Given the image from camera \"{CAMERA}\", return a JSON",
  "object with two fields:",
  "  detections: array of { label, confidence (0..1), bbox: [x, y, w, h] } where bbox is NORMALIZED",
  "    to image dimensions (each in 0..1; (x,y) is the top-left corner of the box).",
  "  summary: one short sentence describing the scene (max 12 words).",
  "",
  "Use clear category labels in UPPERCASE: PERSON, VEHICLE, BICYCLE, ANIMAL, PACKAGE, BAG.",
  "Only include high-confidence detections (>= 0.5). Skip if you are unsure of bounds.",
  "If nothing notable is present, return detections: [] and a brief summary like \"Empty scene.\"",
  "Respond with raw JSON only — no markdown fences.",
].join(" ");

export async function analyzeImage({ imageBuffer, camera }) {
  const t0 = Date.now();
  if (!isChatConfigured()) {
    return {
      detections: [],
      summary: "Vision disabled (no API key configured).",
      status: "vision_disabled",
      model: null,
      tookMs: Date.now() - t0,
    };
  }
  const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;
  const body = {
    model: VISION_MODEL,
    response_format: { type: "json_object" },
    temperature: 0.1,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: VISION_PROMPT.replace("{CAMERA}", camera) },
          { type: "image_url", image_url: { url: dataUrl, detail: "low" } },
        ],
      },
    ],
  };
  const res = await fetch(`${OPENAI_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      detections: [],
      summary: `Vision error: ${res.status}`,
      status: "error",
      error: text.slice(0, 200),
      model: VISION_MODEL,
      tookMs: Date.now() - t0,
    };
  }
  const json = await res.json();
  const content = json.choices?.[0]?.message?.content ?? "{}";
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return {
      detections: [],
      summary: "Vision returned malformed JSON",
      status: "error",
      raw: content.slice(0, 300),
      model: VISION_MODEL,
      tookMs: Date.now() - t0,
    };
  }
  const detections = Array.isArray(parsed.detections)
    ? parsed.detections
        .filter(
          (d) =>
            d &&
            typeof d.label === "string" &&
            Array.isArray(d.bbox) &&
            d.bbox.length === 4 &&
            d.bbox.every((n) => Number.isFinite(n)),
        )
        .map((d) => ({
          label: String(d.label).toUpperCase(),
          confidence: Number(d.confidence ?? 0),
          bbox: d.bbox.map((n) => Math.max(0, Math.min(1, Number(n)))),
        }))
    : [];
  return {
    detections,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    status: "ok",
    model: VISION_MODEL,
    tookMs: Date.now() - t0,
  };
}

export const AGENT = { CHAT_MODEL, VISION_MODEL, isChatConfigured };
