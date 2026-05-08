// Agent status + camera-health SSE channel.
//
// /api/agent/status   one-shot snapshot. ?probe=async also pings Ollama.
// /api/health/cameras SSE — proxies harness.subscribeHealth(). Cost: 0.

import { isChatConfigured } from "../agent.mjs";
import { send, requireAdmin } from "../http-utils.mjs";

export async function register(req, res, url, ctx) {
  const { db, harness, frigate } = ctx;

  if (req.method === "GET" && url.pathname === "/api/agent/status") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    // Augment with harness diagnostics: bus subscribers, telemetry, quotas,
    // tier3 readiness, AND optionally a live Ollama probe (?probe=async).
    // Default is sync to avoid making page-load /status depend on the
    // Ollama box being online.
    const wantAsync = url.searchParams.get("probe") === "async";
    let harness_status = null;
    try {
      harness_status = wantAsync ? await harness.statusAsync() : harness.status();
    } catch { /* harness optional */ }
    send(res, 200, {
      chat_configured: isChatConfigured(),
      frigate_configured: frigate.isConfigured(),
      harness: harness_status,
    });
    return true;
  }

  // SSE health channel. Wire format: each `data: {...}` line is a JSON
  // snapshot from the harness probes (Frigate reachability, Ollama
  // reachability). The frontend uses this to softly indicate stream-source
  // health without needing a "reconnect now" button.
  if (req.method === "GET" && url.pathname === "/api/health/cameras") {
    const me = requireAdmin(db, req, res);
    if (!me) return true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // disable nginx buffering for SSE
    });
    res.write(`: ok\n\n`); // keep-alive comment so the connection opens immediately
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    (async () => {
      try {
        for await (const ev of harness.subscribeHealth(ac.signal)) {
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      } catch {
        // swallow — connection close is normal
      } finally {
        try { res.end(); } catch { /* ignore */ }
      }
    })();
    return true;
  }

  return false;
}
