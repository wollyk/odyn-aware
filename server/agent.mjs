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
//   - rename_camera({camera,label})            writes to cam_labels
//   - get_recent_events({camera,limit,source}) — reads our harness events
//                                                table by default, opt into Frigate
//   - propose_alert_rule({camera,description,spec})  writes to alert_rules
//   - get_current_scene({camera})              T2 local VLM scene-now
//   - get_router_status()                      router mode + recent tier breakdown
//
// We do ONE tool round (model → tool calls → results → model) and stop. No loops.

import * as frigate from "./frigate.mjs";
import {
  setCamLabel,
  listCamLabels,
  insertAlertRule,
  listEvents as listHarnessEvents,
  listPeople,
  listRecentFaceMatches,
  dayKeyUtc,
  getDailySummary,
  listDailySummaries,
} from "./db.mjs";

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
      description:
        "Return the most recent events from the AuroraView agent harness. " +
        "By default reads from our internal event log (covers status changes, " +
        "T2/T3 vision calls, motion summaries). Pass source='frigate' to read " +
        "Frigate's own event store instead (object detections — empty when " +
        "Frigate's detector is off). Supports optional severity / origin filters.",
      parameters: {
        type: "object",
        properties: {
          camera: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
          source: {
            type: "string",
            enum: ["harness", "frigate"],
            default: "harness",
            description: "Which event store to read from",
          },
          severity: { type: "string", enum: ["normal", "notable", "critical"] },
          origin: { type: "string", description: "e.g. 'motion', 'status_online', 'manual_query'" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_scene",
      description:
        "Get the local vision agent's (T2 / Ollama) most recent free-text " +
        "description of what it sees on a camera. Cheap call, no cloud cost. " +
        "Use this when the user asks 'what do you see right now', 'is anything " +
        "happening', or wants a fast read on scene state before paying for T3.",
      parameters: {
        type: "object",
        properties: {
          camera: { type: "string", description: "Frigate camera wire name" },
        },
        required: ["camera"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_router_status",
      description:
        "Inspect the cost-control router: current mode, T2/T3 ratios, recent " +
        "telemetry latencies, and the Tier-0 ingestor's view of Frigate. Useful " +
        "for answering 'how expensive is this running' and 'is the system healthy'.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_known_people",
      description:
        "List the people who have been enrolled in the face DB for this " +
        "tenant. Returns names, embedding counts, and last-enrolled times. " +
        "Does NOT include photos or embeddings (PII-safe). Read-only.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["active", "archived"], default: "active" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_face_matches_recent",
      description:
        "Return recent face-match log entries (every face the recognizer " +
        "has scored over the last polling window). Filters by camera and " +
        "by person; pass person_id='unknown' to find only unrecognized " +
        "faces. Useful for 'has anyone been at the front door today' / " +
        "'show me unknown people seen this morning'. Read-only.",
      parameters: {
        type: "object",
        properties: {
          camera: { type: "string" },
          person_id: {
            description: "Numeric id of a known person, OR the literal string 'unknown'",
            oneOf: [{ type: "integer" }, { type: "string", enum: ["unknown"] }],
          },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_person_sightings",
      description:
        "Search when a known enrolled person appeared on camera. Returns timestamps, cameras, and optional Frigate clip ids. Use for 'did Kamal show up yesterday' or 'when was this person last seen'.",
      parameters: {
        type: "object",
        properties: {
          person_id: { type: "integer", description: "people.id from list_known_people" },
          camera: { type: "string" },
          since: { type: "string", description: "ISO8601 start time" },
          until: { type: "string", description: "ISO8601 end time" },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
        required: ["person_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_recurring_strangers",
      description:
        "List clustered unknown faces (recurring visitors not in the people DB). Shows how many times each stranger cluster was seen and on which cameras.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["unreviewed", "ignored", "promoted"], default: "unreviewed" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_daily_summary",
      description:
        "Return today's (or a specified day's) summary of camera activity. " +
        "Pre-aggregated by the harness and narrated by a local Gemma model — " +
        "FREE to call. Use this for 'what happened today?', 'how was last " +
        "night?', or 'recap this week'. If `regenerate` is true, force a " +
        "fresh summary now (ignores cooldown). Use sparingly.",
      parameters: {
        type: "object",
        properties: {
          day: {
            type: "string",
            description: "YYYY-MM-DD (UTC). Defaults to today.",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
          },
          scope: {
            type: "string",
            description: "'tenant' (all cameras) or 'camera:<name>'. Defaults to 'tenant'.",
            default: "tenant",
          },
          regenerate: {
            type: "boolean",
            description: "Force regen now. Defaults to false.",
            default: false,
          },
          recent_days: {
            type: "integer",
            description: "If set, return summaries for the last N days instead of one. Max 14.",
            minimum: 1, maximum: 14,
          },
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

// Pull the most operator-relevant fields out of an event row's JSON payload.
// The full payload is heavy (full T3 detections, etc.) — we don't want to
// stuff that into the LLM's context for every event.
function summarizeEventPayload(row) {
  // listEvents already parses payload — but be defensive in case the caller
  // passes a raw string.
  let p = row.payload;
  if (typeof p === "string") {
    try { p = JSON.parse(p); } catch { p = {}; }
  }
  if (!p || typeof p !== "object") p = {};
  const out = {};
  if (p.scene) out.scene = String(p.scene).slice(0, 120);
  if (p.alert_type) out.alert_type = p.alert_type;
  if (p.severity) out.severity = p.severity;
  if (p.confidence != null) out.confidence = p.confidence;
  if (p.tier0_meta?.channel) out.channel = p.tier0_meta.channel;
  if (p.tier0_meta?.next) out.status_next = p.tier0_meta.next;
  if (Array.isArray(p.objects) && p.objects.length) {
    out.objects = p.objects.slice(0, 5).map((o) => o.label ?? "?");
  }
  return out;
}

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
      const source = args?.source === "frigate" ? "frigate" : "harness";
      if (source === "frigate") {
        const events = await frigate.getEvents({ camera, limit });
        return {
          ok: true,
          source: "frigate",
          count: events.length,
          note:
            events.length === 0
              ? "Frigate's detector is currently disabled, so its event store is empty. Try source='harness' for our own ingest."
              : undefined,
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
      // source === "harness" — read our own event log.
      const rows = listHarnessEvents(ctx.db, {
        camera,
        limit,
        severity: typeof args?.severity === "string" ? args.severity : undefined,
        origin: typeof args?.origin === "string" ? args.origin : undefined,
      });
      return {
        ok: true,
        source: "harness",
        count: rows.length,
        events: rows.map((r) => ({
          event_id: r.event_id,
          stage: r.stage,
          camera: r.camera,
          origin: r.origin,
          severity: r.severity,
          created_at: r.created_at,
          // Trim payload — full record is available via /api/agent/events/:event_id
          payload_summary: summarizeEventPayload(r),
        })),
      };
    }
    if (name === "get_current_scene") {
      if (!ctx?.harness?.analyzeImageLocal) {
        return { ok: false, error: "harness_not_available" };
      }
      const camera = String(args?.camera ?? "").trim();
      if (!camera) return { ok: false, error: "camera required" };
      const cams = await frigate.listCameras();
      if (!cams.find((c) => c.name === camera)) {
        return {
          ok: false,
          error: `unknown camera '${camera}'`,
          available: cams.map((c) => c.name),
        };
      }
      try {
        const snap = await frigate.getSnapshot(camera, { height: 480 });
        const result = await ctx.harness.analyzeImageLocal({
          imageBuffer: snap.body,
          camera,
        });
        return {
          ok: true,
          camera,
          tier: "T2",
          model: result.tier2_meta?.model ?? null,
          tookMs: result.tier2_meta?.tookMs ?? null,
          scene: result.scene ?? "",
          severity: result.severity ?? "normal",
          alert_type: result.alert_type ?? null,
          confidence: result.confidence ?? 0,
          status: result.ok ? "ok" : "error",
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    if (name === "get_router_status") {
      if (!ctx?.harness?.status) {
        return { ok: false, error: "harness_not_available" };
      }
      const s = ctx.harness.status();
      // Slim it down to the operator-relevant pieces; full status is at /api/agent/status.
      const cameraQuotas = {};
      for (const [key, counts] of Object.entries(s.quota ?? {})) {
        if (!key.startsWith("cam:")) continue;
        cameraQuotas[key] = counts;
      }
      return {
        ok: true,
        router_mode: process.env.DETECTION_ROUTER_MODE ?? "t2-gates-t3 (default)",
        t3_refresh_ms: Number(process.env.DETECTION_T3_REFRESH_MS ?? 15_000),
        t3_cache_ttl_ms: Number(process.env.DETECTION_T3_CACHE_TTL_MS ?? 30_000),
        tier3: s.tier3,
        tier0: s.tier0,
        quota_cameras: cameraQuotas,
        latencies: s.telemetry?.latencies ?? {},
      };
    }
    if (name === "list_known_people") {
      const status = args?.status === "archived" ? "archived" : "active";
      const rows = listPeople(ctx.db, { status });
      return {
        ok: true,
        count: rows.length,
        people: rows.map((r) => ({
          id: r.id,
          name: r.name,
          notes: r.notes,
          embedding_count: r.embedding_count,
          last_embedded_at: r.last_embedded_at,
          status: r.status,
          created_at: r.created_at,
        })),
      };
    }
    if (name === "get_face_matches_recent") {
      const camera = args?.camera || null;
      const personRaw = args?.person_id;
      const person_id =
        personRaw === "unknown" ? "unknown" :
        Number.isInteger(personRaw) ? personRaw :
        null;
      const limit = Math.min(Math.max(Number(args?.limit ?? 25), 1), 100);
      const rows = listRecentFaceMatches(ctx.db, { camera, person_id, limit });
      return {
        ok: true,
        count: rows.length,
        // Trim heavy fields (bbox JSON) — chat doesn't usually need pixel coords.
        matches: rows.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          camera: r.camera,
          person_id: r.person_id,
          person_name: r.person_name ?? "(unknown)",
          similarity: Number(r.similarity?.toFixed?.(3) ?? r.similarity),
          quality: r.quality,
          model: r.model,
          event_id: r.event_id,
          track_session_id: r.track_session_id ?? null,
          frigate_event_id: r.frigate_event_id ?? null,
          cluster_id: r.cluster_id ?? null,
        })),
      };
    }
    if (name === "find_person_sightings") {
      const person_id = Number(args?.person_id);
      if (!Number.isInteger(person_id) || person_id <= 0) {
        return { ok: false, error: "person_id_required" };
      }
      const since_ms = args?.since ? Date.parse(args.since) : Date.now() - 7 * 86400000;
      const until_ms = args?.until ? Date.parse(args.until) : null;
      const rows = ctx.harness?.findPersonSightingsFromDb?.({
        person_id,
        camera: args?.camera || null,
        since_ms: Number.isFinite(since_ms) ? since_ms : null,
        until_ms: until_ms && Number.isFinite(until_ms) ? until_ms : null,
        limit: Math.min(Math.max(Number(args?.limit ?? 50), 1), 100),
      }) ?? [];
      return {
        ok: true,
        count: rows.length,
        sightings: rows.map((r) => ({
          at: r.created_at,
          camera: r.camera,
          similarity: r.similarity,
          frigate_event_id: r.frigate_event_id,
          track_session_id: r.track_session_id,
        })),
      };
    }
    if (name === "list_recurring_strangers") {
      const status = args?.status === "ignored" || args?.status === "promoted"
        ? args.status
        : "unreviewed";
      const rows = ctx.harness?.listFaceClustersFromDb?.({
        status,
        limit: Math.min(Math.max(Number(args?.limit ?? 20), 1), 50),
      }) ?? [];
      return {
        ok: true,
        count: rows.length,
        clusters: rows.map((r) => ({
          id: r.id,
          member_count: r.member_count,
          cameras: (() => { try { return JSON.parse(r.cameras_json); } catch { return []; } })(),
          first_seen_at: r.first_seen_at,
          last_seen_at: r.last_seen_at,
          status: r.status,
        })),
      };
    }
    if (name === "get_daily_summary") {
      const scope = String(args?.scope ?? "tenant").trim();
      if (scope !== "tenant" && !scope.startsWith("camera:")) {
        return { ok: false, error: "invalid_scope", detail: "scope must be 'tenant' or 'camera:<name>'" };
      }
      const day = (args?.day && /^\d{4}-\d{2}-\d{2}$/.test(args.day)) ? args.day : dayKeyUtc();

      // Multi-day list mode
      if (Number.isInteger(args?.recent_days)) {
        const limit = Math.min(Math.max(Number(args.recent_days), 1), 14);
        const since = new Date(Date.now() - limit * 24 * 3600 * 1000).toISOString().slice(0, 10);
        const rows = listDailySummaries(ctx.db, { since_day: since, scope, limit });
        return { ok: true, count: rows.length, rows };
      }

      // Force a regen if asked
      if (args?.regenerate && ctx.harness?.regenerateSummary) {
        try {
          const out = await ctx.harness.regenerateSummary({ db: ctx.db, day, scope, force: true });
          return {
            ok: true,
            day,
            scope,
            regenerated: !out.regen_skipped,
            llm_ok: out.llm_ok ?? null,
            llm_error: out.llm_error ?? null,
            event_count: out.event_count,
            model: out.model,
            summary: out.summary,
            generated_at: out.generated_at,
            generated_in_ms: out.generated_in_ms,
            version: out.version,
          };
        } catch (err) {
          return { ok: false, error: "regen_failed", detail: err.message };
        }
      }

      // Cached read
      const row = getDailySummary(ctx.db, { day, scope });
      if (!row) {
        return { ok: true, day, scope, found: false, note: "No summary yet for this day/scope. Pass regenerate=true to build one now." };
      }
      return {
        ok: true,
        day: row.day,
        scope: row.scope,
        found: true,
        event_count: row.event_count,
        model: row.model,
        summary: row.summary,
        generated_at: row.generated_at,
        version: row.version,
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

export async function* streamChatGpt({ messages, camera, cameraLabel, db, user, harness, signal }) {
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
    const result = await runTool(acc.name, parsed, { db, user, harness });
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
