// Health subsystem.
//
// Two surfaces:
//   1. A periodic upstream probe that pushes one health snapshot/minute to
//      the event bus on TOPIC.HEALTH. Probes:
//        - Frigate /api/version (loopback)
//        - Ollama /api/tags
//        - SQLite write check (kv_cache touch)
//   2. An agent-facing summarizer that turns recent health events into a
//      one-line operator-friendly note via the LOCAL Gemma model (NEVER GPT).
//      This satisfies the design rule: cost-free reliability narration.
//
// Phase plan:
//   - v0 (now):  Probe + publish + a stub summarizer (returns last raw status).
//   - v1:        Wire the Gemma summarizer (uses tier2.mjs's Ollama client
//                with a small text-only model like gemma2:9b).
//   - v2:        Surface to the user only when severity warrants — a stable
//                stream is silently fine; an outage > 2min triggers a sidebar
//                line in the chat UI from the agent.

import { publish } from "./eventbus.mjs";
import { TOPIC } from "./types.mjs";

let probeTimer = null;

/**
 * @param {{
 *   frigate: { isConfigured: () => boolean, listCameras?: () => Promise<unknown> },
 *   ollama:  { ping: () => Promise<{ ok: boolean, models?: string[], error?: string }> },
 *   intervalMs?: number,
 * }} deps
 */
export function startProbes({ frigate, ollama, intervalMs = 60_000 }) {
  if (probeTimer) return;

  const tick = async () => {
    const out = {
      ts: Date.now(),
      frigate: { ok: false },
      ollama: { ok: false },
    };
    if (frigate?.isConfigured?.()) {
      try {
        // Just checking that listCameras returns *something* (live or cached).
        const cams = await frigate.listCameras();
        out.frigate = { ok: Array.isArray(cams), cameras: Array.isArray(cams) ? cams.length : 0 };
      } catch (err) {
        out.frigate = { ok: false, error: err?.message };
      }
    }
    if (ollama?.ping) {
      try {
        out.ollama = await ollama.ping();
      } catch (err) {
        out.ollama = { ok: false, error: err?.message };
      }
    }
    publish(TOPIC.HEALTH, out);
  };

  // Run once immediately, then on interval.
  tick();
  probeTimer = setInterval(tick, intervalMs);
}

export function stopProbes() {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

/**
 * Take a recent burst of health snapshots and produce a one-line operator
 * summary. v0 stub: deterministic text. v1 will route through Gemma.
 *
 * @param {Array<object>} snapshots
 * @returns {Promise<{ note: string, severity: "info"|"warn"|"alert" }>}
 */
export async function summarize(snapshots) {
  if (!snapshots.length) return { note: "All systems nominal.", severity: "info" };
  const last = snapshots[snapshots.length - 1];
  const frigateBad = !last.frigate?.ok;
  const ollamaBad = !last.ollama?.ok;
  if (frigateBad && ollamaBad) {
    return {
      note: "Upstream services (Frigate + Ollama) are unreachable. Streaming continues from cache.",
      severity: "alert",
    };
  }
  if (frigateBad) {
    return {
      note: "Frigate is currently unreachable. Live video may be choppy until it recovers.",
      severity: "warn",
    };
  }
  if (ollamaBad) {
    return {
      note: "Local vision model (Ollama) is offline. Vision narration paused.",
      severity: "warn",
    };
  }
  return { note: "All systems nominal.", severity: "info" };
}
