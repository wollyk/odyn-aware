// /api/agent/chat — server-sent-events stream of GPT-4o-mini responses
// with tool calls handled server-side.
//
// The bulk of the chat smarts (tool registry, model loop, vision-on-frame)
// lives in agent.mjs. This route is just the HTTP/SSE shell:
//   - admin auth
//   - tenant quota gate (per-tenant T3 budget)
//   - input validation/scrubbing
//   - SSE plumbing (writeEvent, abort on disconnect)
//   - end-of-stream telemetry + ledger record
//
// Every chat call gets the harness public surface injected so chat tools
// can reach into T2 scene / face DB / router status without agent.mjs
// importing harness/* directly. Keeps the harness extractable.

import { streamChatGpt } from "../agent.mjs";
import { getCamLabel } from "../db.mjs";
import { send, readJson, requireAdmin } from "../http-utils.mjs";

export async function register(req, res, url, ctx) {
  const { db, harness } = ctx;
  if (!(req.method === "POST" && url.pathname === "/api/agent/chat")) return false;

  const me = requireAdmin(db, req, res);
  if (!me) return true;

  let body;
  try { body = await readJson(req); }
  catch { send(res, 400, { error: "invalid_json" }); return true; }

  const messages = Array.isArray(body?.messages) ? body.messages.slice(-20) : [];
  const camera = String(body?.camera ?? "").slice(0, 64) || "Garage";
  const labelRow = getCamLabel(db, camera);
  const cameraLabel = labelRow?.label ?? camera;
  const cleanMessages = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  if (cleanMessages.length === 0 || cleanMessages.at(-1).role !== "user") {
    send(res, 400, { error: "messages must end with a user turn" });
    return true;
  }

  // Quota gate — per-tenant only (camera not gated for chat because it's
  // user-driven, not stream-driven).
  const tenant = "default";
  const gate = harness.checkQuota({ tenant, kind: "t3-chat" });
  if (!gate.allowed) {
    send(res, 429, { error: "quota_exceeded", reason: gate.reason });
    return true;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const writeEvent = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
    catch { /* client disconnected */ }
  };

  const ac = new AbortController();
  req.on("close", () => ac.abort());
  const t0 = Date.now();
  let chatErrored = false;
  try {
    for await (const evt of streamChatGpt({
      messages: cleanMessages,
      camera,
      cameraLabel,
      db,
      user: { id: me.user_id, email: me.email, role: me.role },
      // Inject the harness public surface so chat tools can read T2 scene,
      // router status, etc. without agent.mjs ever importing harness/*.
      harness,
      signal: ac.signal,
    })) {
      writeEvent(evt);
      if (evt.type === "done") break;
      if (evt.type === "error") chatErrored = true;
    }
  } catch (err) {
    chatErrored = true;
    writeEvent({ type: "error", message: err.message });
    writeEvent({ type: "done" });
  } finally {
    harness.observeLatency(chatErrored ? "agent.chat.error" : "agent.chat", Date.now() - t0);
    if (!chatErrored) harness.recordQuota({ tenant, kind: "t3-chat" });
  }
  res.end();
  return true;
}
