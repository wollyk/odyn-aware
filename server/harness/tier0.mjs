// Tier 0 — frame-level event ingestor.
//
// Responsibilities:
//   1. Subscribe to Frigate's general WebSocket (/ws) and translate
//      camera-level state changes into DetectionEvents.
//   2. Periodically poll Frigate's /api/<cam>/recordings/summary so the
//      event log captures per-hour motion totals (Phase 5 daily-summary fuel).
//   3. Provide synchronous injection (`injectManual`) for the API layer.
//
// What this DOES capture today:
//   - status_online / status_offline transitions per camera (record/detect/audio)
//   - hourly motion totals (a coarse "things were happening" count)
//
// What this DOES NOT capture (requires MQTT broker in Frigate config — future):
//   - real-time motion start/end events
//   - frame-level object detections
//
// IMPORTANT: this tier never calls an LLM. T0 only emits structured data
// that downstream tiers can reason over.

import { publish } from "./eventbus.mjs";
import { newDetectionEvent, TOPIC } from "./types.mjs";

let ws = null;
let wsReconnectTimer = null;
let wsClosing = false;
let summaryTimer = null;
let frigateClient = null;

// Track per-camera last known status. We only emit a DetectionEvent when
// status TRANSITIONS — heartbeats every 10s would otherwise flood the bus.
const cameraStatus = new Map(); // camera -> { detect: "online"|"offline", record: ..., ts }

// Per-camera+channel debounce. Some sources flap every ~10s (public webcams,
// flaky RTSP) and would otherwise produce hundreds of meaningless rows per
// hour. We require the new state to STAY for at least DEBOUNCE_MS before we
// publish, and we drop any transition that's already noisy enough that the
// flap rate is under FLAP_FLOOR_MS apart.
const STATUS_DEBOUNCE_MS = 30_000;
const FLAP_FLOOR_MS = 20_000;
const pendingStatus = new Map(); // "<cam>|<channel>" -> { value, scheduledAt, timer }

// Track per-camera last summary digest so we only emit on real hourly change.
const lastSummaryDigest = new Map(); // camera -> "<json digest>"

/**
 * Synchronously inject a manual event (used by the API layer when the user
 * triggers an "analyze now" from the UI). Returns the event so the caller
 * can pass it directly into the rest of the pipeline if needed.
 *
 * @param {{ cam: string, tenant_id?: string, snapshot_url?: string, objects?: object[], motion?: boolean }} fields
 */
export function injectManual(fields) {
  const ev = newDetectionEvent({
    origin: "manual_query",
    motion: fields.motion ?? true,
    cam: fields.cam,
    tenant_id: fields.tenant_id,
    snapshot_url: fields.snapshot_url,
    objects: fields.objects,
  });
  publish(TOPIC.DETECTION, ev);
  return ev;
}

/**
 * Start the Frigate ingestor. Idempotent — calling start twice is a no-op.
 *
 * @param {{
 *   frigate: { openEventsWs: () => Promise<object>, getRecordingsSummary: (cam: string) => Promise<object[]>, listCameras: () => Promise<object[]>, isConfigured: () => boolean },
 *   summaryIntervalMs?: number,
 * }} deps
 * @returns {{ close: () => void }}
 */
export function startFrigateIngestor({ frigate, summaryIntervalMs = 5 * 60 * 1000 } = {}) {
  if (ws || summaryTimer) {
    return { close: stop };
  }
  if (!frigate?.isConfigured?.()) {
    console.log("[tier0] frigate not configured — ingestor disabled");
    return { close: () => {} };
  }
  frigateClient = frigate;
  wsClosing = false;
  connectWs();
  // First summary tick on a delay so we don't pile onto boot.
  summaryTimer = setInterval(pollSummaries, summaryIntervalMs);
  setTimeout(pollSummaries, 30_000);
  return { close: stop };
}

export function stop() {
  wsClosing = true;
  if (wsReconnectTimer) clearTimeout(wsReconnectTimer);
  wsReconnectTimer = null;
  if (ws) {
    try { ws.close(); } catch { /* ignore */ }
    ws = null;
  }
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
  for (const { timer } of pendingStatus.values()) clearTimeout(timer);
  pendingStatus.clear();
  cameraStatus.clear();
  lastSummaryDigest.clear();
}

// ---- WS subscriber ---------------------------------------------------------

async function connectWs() {
  if (wsClosing) return;
  try {
    ws = await frigateClient.openEventsWs();
  } catch (err) {
    console.error("[tier0] ws connect failed:", err?.message);
    scheduleReconnect();
    return;
  }
  ws.on("open", () => {
    console.log("[tier0] frigate ws connected");
  });
  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      handleWsMessage(msg);
    } catch {
      // ignore malformed
    }
  });
  ws.on("close", () => {
    if (!wsClosing) console.log("[tier0] frigate ws closed");
    ws = null;
    if (!wsClosing) scheduleReconnect();
  });
  ws.on("error", (err) => {
    console.error("[tier0] frigate ws error:", err?.message);
    try { ws?.close(); } catch { /* ignore */ }
  });
}

function scheduleReconnect() {
  if (wsClosing || wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectWs();
  }, 5_000);
}

// Topic shapes we expect:
//   "<camera>/status/<channel>"  -> "online" | "offline"
//   "stats"                      -> { cameras: { <cam>: {...} }, ... }
function handleWsMessage(msg) {
  if (typeof msg?.topic !== "string") return;

  const parts = msg.topic.split("/");
  if (parts.length === 3 && parts[1] === "status") {
    const cam = parts[0];
    const channel = parts[2]; // detect | audio | record
    const value = String(msg.payload ?? "").toLowerCase(); // online | offline
    onStatusObservation(cam, channel, value);
    return;
  }

  // Future: "stats" topic could feed a system-health event here. Skipping
  // for now — health.mjs already polls /api/version and Ollama on a 60s tick.
}

// Debounced status emitter.
//
// Behavior:
//   - First observation per boot: silent (we don't pretend a transition
//     happened just because the WS reconnected).
//   - Different value: stash with a STATUS_DEBOUNCE_MS timer. If the value
//     hasn't been re-flipped during that window, publish.
//   - If a flap re-flips before the timer expires, cancel the timer; the
//     current published state is still the previous one, so this counts
//     as "no real change happened".
//   - If the previous publish-or-observation was less than FLAP_FLOOR_MS
//     ago, we treat the source as flapping and drop the new value entirely
//     (its corresponding return-to-prior would also be dropped).
function onStatusObservation(cam, channel, value) {
  const slot = cameraStatus.get(cam) ?? {};
  const prev = slot[channel];
  // First observation: just remember it. No publish.
  if (typeof prev !== "string") {
    slot[channel] = value;
    slot.ts = Date.now();
    cameraStatus.set(cam, slot);
    return;
  }
  // No change vs published value → cancel any pending revert and bail.
  if (prev === value) {
    const key = `${cam}|${channel}`;
    const pending = pendingStatus.get(key);
    if (pending && pending.value !== value) {
      clearTimeout(pending.timer);
      pendingStatus.delete(key);
    }
    return;
  }
  // Flap floor — if the last publish for this channel was very recent,
  // assume the source is flapping and silently drop. The pendingStatus
  // timer will eventually catch a stable value.
  const sinceLast = Date.now() - (slot.ts ?? 0);
  if (sinceLast < FLAP_FLOOR_MS) {
    // Still arm a debounce so a "long stable" value can take effect.
    schedulePendingStatus(cam, channel, value);
    return;
  }
  schedulePendingStatus(cam, channel, value);
}

function schedulePendingStatus(cam, channel, value) {
  const key = `${cam}|${channel}`;
  const existing = pendingStatus.get(key);
  if (existing) {
    if (existing.value === value) return; // already armed for this value
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => commitPendingStatus(cam, channel, value), STATUS_DEBOUNCE_MS);
  // Allow node to exit cleanly during shutdown.
  if (typeof timer.unref === "function") timer.unref();
  pendingStatus.set(key, { value, scheduledAt: Date.now(), timer });
}

function commitPendingStatus(cam, channel, value) {
  const key = `${cam}|${channel}`;
  pendingStatus.delete(key);
  const slot = cameraStatus.get(cam) ?? {};
  const prev = slot[channel];
  if (prev === value) return; // pre-empted by something
  slot[channel] = value;
  slot.ts = Date.now();
  cameraStatus.set(cam, slot);
  publish(
    TOPIC.DETECTION,
    newDetectionEvent({
      origin: value === "online" ? "status_online" : "status_offline",
      cam,
      motion: false,
      objects: [],
      tier0_meta: { source: "frigate-ws", channel, prev, next: value, debounced: true },
    }),
  );
}

// ---- Recordings summary poller --------------------------------------------

async function pollSummaries() {
  if (wsClosing) return;
  let cams;
  try {
    cams = await frigateClient.listCameras();
  } catch (err) {
    console.error("[tier0] listCameras failed during summary poll:", err?.message);
    return;
  }
  for (const c of cams ?? []) {
    if (!c.enabled) continue;
    try {
      const summary = await frigateClient.getRecordingsSummary(c.name);
      const today = summary?.[0];
      if (!today?.hours?.length) continue;
      // Digest: just the per-hour motion vector. Won't change unless an
      // hour rolls over or motion totals shift.
      const digest = today.hours.map((h) => `${h.hour}:${h.motion}`).join(",");
      if (lastSummaryDigest.get(c.name) === digest) continue;
      lastSummaryDigest.set(c.name, digest);
      publish(
        TOPIC.DETECTION,
        newDetectionEvent({
          origin: "motion_summary",
          cam: c.name,
          motion: today.hours.some((h) => h.motion > 0),
          objects: [],
          tier0_meta: {
            source: "frigate-recordings-summary",
            day: today.day ?? null,
            hours: today.hours.slice(0, 24),
          },
        }),
      );
    } catch (err) {
      // Per-camera failure is non-fatal — keep going for other cameras.
      console.warn(`[tier0] summary poll failed for ${c.name}:`, err?.message);
    }
  }
}

// ---- Diagnostics -----------------------------------------------------------

export function inspect() {
  return {
    ws_connected: Boolean(ws && ws.readyState === 1 /* OPEN */),
    cameras_tracked: cameraStatus.size,
    summary_cache_keys: lastSummaryDigest.size,
    pending_status_count: pendingStatus.size,
    debounce_ms: STATUS_DEBOUNCE_MS,
    status_by_cam: Object.fromEntries(
      [...cameraStatus.entries()].map(([k, v]) => [k, { ...v }]),
    ),
  };
}
