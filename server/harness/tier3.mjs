// Tier 3 — cloud LLM (GPT-4o-mini for chat + vision).
//
// THIS FILE IS THE HARNESS-FACING FACADE. The actual chat/vision implementation
// currently lives in server/agent.mjs (we kept it there to avoid disturbing
// imports during the harness scaffold). Once the harness fully owns chat,
// we'll physically relocate the body into this file.
//
// Hard rule (from cost discipline): T3 is NEVER on a timer. It fires on:
//   1. A direct user prompt (/api/agent/chat)
//   2. An explicit router escalation (router.shouldEscalateT3 returned true)
//   3. A scheduled summary job (rate-limited, see memory.mjs)
//
// Future: when memory.mjs is online, T3's chat path will pre-load the
// per-camera daily summary so the model gets useful context cheaply.

export {
  streamChatGpt,
  analyzeImage,
  isChatConfigured,
  AGENT,
} from "../agent.mjs";

import { isChatConfigured } from "../agent.mjs";

/**
 * Cheap status reporter for /api/agent/status. Distinct from tier2.ping()
 * because we don't want to ping OpenAI on every status call (latency + cost).
 * We just check whether a real key is configured.
 */
export function ping() {
  return { ok: isChatConfigured() };
}
