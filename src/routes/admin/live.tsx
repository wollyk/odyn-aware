import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/admin/live")({
  component: AdminLive,
});

// ---------- Types ----------

type Camera = {
  name: string;
  label: string;
  enabled: boolean;
  detect_enabled: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  tracks: string[];
};

type Detection = {
  label: string;
  confidence: number;
  bbox: [number, number, number, number]; // normalized [x,y,w,h]
};

type DetectionResult = {
  camera: string;
  detections: Detection[];
  summary: string;
  status: "ok" | "vision_disabled" | "error" | "frigate_not_configured";
  model: string | null;
  tookMs: number;
};

type ChatMsg =
  | { id: string; role: "user"; content: string }
  | { id: string; role: "assistant"; content: string; pending?: boolean; tools?: ToolEvent[] };

type ToolEvent =
  | { kind: "call"; name: string; args: unknown }
  | { kind: "result"; name: string; result: unknown };

type AgentStatus = { chat_configured: boolean; frigate_configured: boolean };

type StreamMode = "snapshot" | "live";

type LiveStatus =
  | "idle"
  | "connecting"
  | "negotiating"
  | "playing"
  | "stalled"
  | "error"
  | "closed";

// ---------- Component ----------

function AdminLive() {
  const navigate = useNavigate();
  const [authState, setAuthState] = useState<"loading" | "ok" | "denied">("loading");
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);

  const [cameras, setCameras] = useState<Camera[]>([]);
  const [camera, setCamera] = useState<string>("");
  const [mode, setMode] = useState<StreamMode>("snapshot");

  const cam = useMemo(() => cameras.find((c) => c.name === camera) ?? null, [cameras, camera]);

  // Auth check + load cameras + agent status
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const meRes = await fetch("/api/auth/me", { credentials: "include" });
        if (cancelled) return;
        if (meRes.status === 401) return navigate({ to: "/admin/login" });
        const meJson = await meRes.json();
        if (meJson.user?.role !== "admin") {
          setAuthState("denied");
          return;
        }
        setMe(meJson.user);

        const [camRes, statusRes] = await Promise.all([
          fetch("/api/cam/cameras", { credentials: "include" }),
          fetch("/api/agent/status", { credentials: "include" }),
        ]);
        if (cancelled) return;
        if (camRes.ok) {
          const data = await camRes.json();
          setCameras(data.cameras ?? []);
          if (data.cameras?.length && !camera) setCamera(data.cameras[0].name);
        }
        if (statusRes.ok) {
          setAgentStatus(await statusRes.json());
        }
        setAuthState("ok");
      } catch (err) {
        if (cancelled) return;
        setAuthState("denied");
        console.error(err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    navigate({ to: "/admin/login" });
  }

  if (authState === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          Verifying session…
        </span>
      </div>
    );
  }
  if (authState === "denied") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
        <div className="max-w-md text-center">
          <p className="font-mono text-xs uppercase tracking-widest text-alert">Access denied</p>
          <button
            type="button"
            onClick={() => navigate({ to: "/admin/login" })}
            className="mt-6 inline-flex items-center gap-2 border border-foreground/80 px-4 py-2 text-xs font-medium tracking-widest uppercase text-foreground hover:bg-foreground hover:text-background transition-colors"
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/60 bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <a href="/" className="font-mono text-sm font-semibold tracking-[0.3em] text-foreground">
              AURORAVIEW
            </a>
            <span className="label-mono">/ Admin</span>
          </div>
          <nav className="flex items-center gap-6">
            <a
              href="/admin"
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
            >
              Submissions
            </a>
            <span className="font-mono text-[10px] uppercase tracking-widest text-foreground border-b border-foreground pb-0.5">
              Live View
            </span>
          </nav>
          <div className="flex items-center gap-4">
            <span className="hidden sm:inline font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              {me?.email}
            </span>
            <button
              onClick={logout}
              className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] px-6 py-6">
        {/* Camera selector + status row */}
        <div className="mb-4 flex items-center gap-4">
          <span className="font-mono text-xs text-alert">[02]</span>
          <span className="label-mono">Live View</span>
          <span className="h-px flex-1 bg-border" />
          {cameras.length > 1 && (
            <select
              value={camera}
              onChange={(e) => setCamera(e.target.value)}
              className="border border-border bg-background px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest text-foreground focus:border-foreground focus:outline-none"
            >
              {cameras.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
          <ModeToggle mode={mode} setMode={setMode} />
          <StatusPill agentStatus={agentStatus} />
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
          <VideoTile cam={cam} mode={mode} agentStatus={agentStatus} />
          <ChatPanel cam={cam} agentStatus={agentStatus} />
        </div>

        <p className="mt-6 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {mode === "snapshot"
            ? "Snapshot polling 1Hz"
            : "Live MSE stream (go2rtc → Node WS proxy → MediaSource)"}
          {" · "}Vision analysis every 5s · Chat tools: list_cameras, rename_camera,
          get_recent_events, propose_alert_rule
        </p>
      </main>
    </div>
  );
}

// ---------- Mode toggle (Snapshot | Live) ----------

function ModeToggle({ mode, setMode }: { mode: StreamMode; setMode: (m: StreamMode) => void }) {
  const opts: { id: StreamMode; label: string }[] = [
    { id: "snapshot", label: "Snapshot 1Hz" },
    { id: "live", label: "Live MSE" },
  ];
  return (
    <div className="inline-flex border border-border">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => setMode(o.id)}
          className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-widest transition-colors ${
            mode === o.id
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Status pill ----------

function StatusPill({ agentStatus }: { agentStatus: AgentStatus | null }) {
  if (!agentStatus) return null;
  const items = [
    { key: "Frigate", ok: agentStatus.frigate_configured },
    { key: "Vision/Chat", ok: agentStatus.chat_configured },
  ];
  return (
    <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-widest">
      {items.map((it) => (
        <span key={it.key} className="flex items-center gap-1.5">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${it.ok ? "bg-green-400" : "bg-alert"}`}
          />
          <span className={it.ok ? "text-foreground/80" : "text-muted-foreground"}>
            {it.key}: {it.ok ? "ON" : "OFF"}
          </span>
        </span>
      ))}
    </div>
  );
}

// ---------- MSE WebSocket driver ----------
// Connects to /api/cam/stream/<camera>, drives a <video> via MediaSource.
//
// Wire protocol (with our backend proxy):
//   1. WS opens (admin cookie auto-included for same-origin)
//   2. Client → server text: {"type":"mse","value":"<wide codec list>"}
//   3. Server → client text: {"type":"mse","value":"video/mp4; codecs=\"...\""}  (chosen)
//   4. Server → client binary: fMP4 init segment, then media segments

function useMseStream(camera: string | null, enabled: boolean) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [bitrateKbps, setBitrateKbps] = useState<number>(0);

  useEffect(() => {
    if (!enabled || !camera) {
      setStatus("idle");
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    let ws: WebSocket | null = null;
    let mediaSource: MediaSource | null = null;
    let sourceBuffer: SourceBuffer | null = null;
    const queue: ArrayBuffer[] = [];
    let bytesInWindow = 0;
    let cancelled = false;

    const flushQueue = () => {
      if (!sourceBuffer || sourceBuffer.updating) return;
      if (queue.length === 0) return;
      try {
        sourceBuffer.appendBuffer(queue.shift()!);
      } catch (err) {
        if (!cancelled) {
          console.error("[mse] appendBuffer", err);
          setError(err instanceof Error ? err.message : "appendBuffer failed");
          setStatus("error");
        }
      }
    };

    const onSourceOpen = () => {
      if (!mediaSource) return;
      try {
        URL.revokeObjectURL(video.src);
      } catch {
        // ignore
      }

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${window.location.host}/api/cam/stream/${encodeURIComponent(camera)}`;
      ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      setStatus("connecting");

      ws.addEventListener("open", () => {
        if (cancelled || !ws) return;
        setStatus("negotiating");
        // Wide-net codec request — Frigate replies with the actual stream codec.
        const codecs =
          'video/mp4; codecs="avc1.640029,avc1.4D4029,avc1.4D401E,avc1.64001E,avc1.42E01E,mp4a.40.2"';
        ws.send(JSON.stringify({ type: "mse", value: codecs }));
      });

      ws.addEventListener("message", (ev) => {
        if (cancelled || !mediaSource) return;
        if (typeof ev.data === "string") {
          // Server's chosen codec response.
          try {
            const msg = JSON.parse(ev.data);
            if (msg && msg.type === "mse" && typeof msg.value === "string" && !sourceBuffer) {
              if (!MediaSource.isTypeSupported(msg.value)) {
                setError(`Codec not supported: ${msg.value}`);
                setStatus("error");
                ws?.close();
                return;
              }
              sourceBuffer = mediaSource.addSourceBuffer(msg.value);
              sourceBuffer.mode = "segments";
              sourceBuffer.addEventListener("updateend", flushQueue);
            }
          } catch (err) {
            console.error("[mse] bad text msg", err);
          }
        } else {
          const buf = ev.data as ArrayBuffer;
          bytesInWindow += buf.byteLength;
          queue.push(buf);
          flushQueue();
          setStatus((s) => (s === "playing" ? s : "playing"));
        }
      });

      ws.addEventListener("close", () => {
        if (cancelled) return;
        setStatus("closed");
      });
      ws.addEventListener("error", () => {
        if (cancelled) return;
        setError("WebSocket error");
        setStatus("error");
      });
    };

    mediaSource = new MediaSource();
    mediaSource.addEventListener("sourceopen", onSourceOpen);
    video.src = URL.createObjectURL(mediaSource);
    void video.play().catch(() => {
      // autoplay may be blocked; user can click to play
    });

    // Bitrate sampler (every 1s)
    const sampler = setInterval(() => {
      setBitrateKbps(Math.round((bytesInWindow * 8) / 1000));
      bytesInWindow = 0;
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(sampler);
      try {
        ws?.close();
      } catch {
        // ignore
      }
      try {
        if (sourceBuffer && mediaSource && mediaSource.readyState === "open") {
          mediaSource.removeSourceBuffer(sourceBuffer);
        }
      } catch {
        // ignore
      }
      try {
        if (mediaSource && mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      } catch {
        // ignore
      }
      try {
        URL.revokeObjectURL(video.src);
      } catch {
        // ignore
      }
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, enabled]);

  return { videoRef, status, error, bitrateKbps };
}

// ---------- Video tile (snapshot polling OR live MSE + canvas overlay + HUD chrome) ----------

function VideoTile({
  cam,
  mode,
  agentStatus,
}: {
  cam: Camera | null;
  mode: StreamMode;
  agentStatus: AgentStatus | null;
}) {
  const [imgUrl, setImgUrl] = useState<string>("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [detections, setDetections] = useState<Detection[]>([]);
  const [detSummary, setDetSummary] = useState<string>("");
  const [detStatus, setDetStatus] = useState<DetectionResult["status"] | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const live = useMseStream(cam?.name ?? null, mode === "live");

  // Snapshot polling: 1Hz, cache-busted via ?t= (only in snapshot mode)
  useEffect(() => {
    if (!cam || mode !== "snapshot") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      const t0 = performance.now();
      const url = `/api/cam/snapshot/${encodeURIComponent(cam.name)}?h=720&t=${Date.now()}`;
      const probe = new Image();
      probe.onload = () => {
        if (cancelled) return;
        setImgUrl(url);
        setLatencyMs(Math.round(performance.now() - t0));
        setSnapError(null);
        timer = setTimeout(tick, 1000);
      };
      probe.onerror = () => {
        if (cancelled) return;
        setSnapError("snapshot failed");
        timer = setTimeout(tick, 2000);
      };
      probe.src = url;
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cam, mode]);

  // Detection polling: every 5s
  useEffect(() => {
    if (!cam) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await fetch(
          `/api/agent/detections?camera=${encodeURIComponent(cam.name)}`,
          { credentials: "include" },
        );
        if (cancelled) return;
        if (res.ok) {
          const data: DetectionResult = await res.json();
          setDetections(data.detections ?? []);
          setDetSummary(data.summary ?? "");
          setDetStatus(data.status);
        }
      } catch {
        // ignore
      } finally {
        if (!cancelled) timer = setTimeout(tick, 5000);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cam]);

  // Clock for HUD
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Canvas sizing + draw on resize / new detections / new image / new live frame
  useEffect(() => {
    const canvas = canvasRef.current;
    const target: HTMLElement | null = mode === "live" ? live.videoRef.current : imgRef.current;
    if (!canvas || !target) return;
    const draw = () => {
      const w = target.clientWidth;
      const h = target.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // Draw boxes
      ctx.lineWidth = 1.5;
      ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      ctx.textBaseline = "top";
      for (const d of detections) {
        const [x, y, ww, hh] = d.bbox;
        const rx = x * w;
        const ry = y * h;
        const rw = ww * w;
        const rh = hh * h;
        ctx.strokeStyle = "rgba(110, 231, 183, 0.95)"; // green-300
        ctx.fillStyle = "rgba(110, 231, 183, 0.18)";
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeRect(rx, ry, rw, rh);
        // Label chip
        const label = `${d.label} ${d.confidence.toFixed(2)}`;
        const textW = ctx.measureText(label).width + 8;
        const chipH = 16;
        const chipY = Math.max(0, ry - chipH);
        ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
        ctx.fillRect(rx, chipY, textW, chipH);
        ctx.fillStyle = "rgba(110, 231, 183, 1)";
        ctx.fillText(label, rx + 4, chipY + 3);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(target);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detections, imgUrl, mode, live.status]);

  const camLabel = cam ? cam.label : "—";
  const wireName = cam ? cam.name : "";
  const ts = new Date(now).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");

  // HUD top-right: latency in snapshot mode, bitrate in live mode.
  const hudRight =
    mode === "live"
      ? `${ts} · ${live.status === "playing" ? `${live.bitrateKbps}kbps` : live.status}`
      : `${ts} · ${latencyMs != null ? `${latencyMs}ms` : "…"}`;

  return (
    <div className="relative" ref={wrapRef}>
      <div className="relative aspect-video overflow-hidden border border-border bg-black">
        {mode === "live" ? (
          <video
            ref={live.videoRef}
            autoPlay
            muted
            playsInline
            className="h-full w-full object-contain select-none pointer-events-none"
          />
        ) : imgUrl ? (
          <img
            ref={imgRef}
            src={imgUrl}
            alt={`Live snapshot from ${wireName}`}
            className="h-full w-full object-contain select-none pointer-events-none"
            draggable={false}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
            {snapError ?? "Connecting…"}
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 h-full w-full"
        />

        {/* Live-mode overlay for connection states (negotiating/error/closed) */}
        {mode === "live" && live.status !== "playing" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="bg-black/70 px-4 py-2 font-mono text-xs uppercase tracking-widest text-foreground/85">
              {live.status === "error"
                ? `Live: ${live.error ?? "error"}`
                : live.status === "closed"
                  ? "Live: stream closed"
                  : live.status === "connecting"
                    ? "Connecting to camera…"
                    : live.status === "negotiating"
                      ? "Negotiating codecs…"
                      : "Idle"}
            </div>
          </div>
        )}

        {/* HUD chrome */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3">
          <div className="flex items-center gap-2 bg-black/65 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                mode === "live" && live.status !== "playing"
                  ? "bg-amber-400"
                  : "bg-red-500 animate-pulse"
              }`}
            />
            {mode === "live" ? "LIVE-MSE · AURORAVIEW" : "LIVE · AURORAVIEW"}
          </div>
          <div className="bg-black/65 px-2.5 py-1 font-mono text-[10px] tracking-widest text-foreground/85">
            {hudRight}
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between p-3">
          <div className="bg-black/65 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-foreground">
            {camLabel}
            {cam && cam.label !== cam.name && (
              <span className="ml-2 text-muted-foreground">({wireName})</span>
            )}
          </div>
          <div className="bg-black/65 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest text-foreground/85">
            {detStatus === "ok"
              ? `${detections.length} detection${detections.length === 1 ? "" : "s"}`
              : detStatus === "vision_disabled"
                ? "Vision: key not set"
                : detStatus === "error"
                  ? "Vision: error"
                  : "Vision: …"}
          </div>
        </div>
      </div>

      {detSummary && detStatus === "ok" && (
        <p className="mt-2 font-mono text-[11px] tracking-wider text-foreground/80">
          <span className="text-alert">▸</span> {detSummary}
        </p>
      )}
      {!agentStatus?.chat_configured && (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Vision overlay disabled until OPENAI_API_KEY is set on the server.
        </p>
      )}
    </div>
  );
}

// ---------- Chat panel (SSE streaming) ----------

function ChatPanel({ cam, agentStatus }: { cam: Camera | null; agentStatus: AgentStatus | null }) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: "init",
      role: "assistant",
      content:
        "AuroraView agent online. Ask about the current scene, recent events, or set up an alert rule. " +
        "I can also rename a camera (e.g. 'rename Garage to CAM 01 GARAGE-A').",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = useCallback(async () => {
    if (!cam) return;
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMsg = { id: crypto.randomUUID(), role: "user", content: text };
    const asstMsg: ChatMsg = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      pending: true,
      tools: [],
    };
    setMessages((m) => [...m, userMsg, asstMsg]);
    setInput("");
    setSending(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const wireMessages = [...messages, userMsg]
        .filter((m) => m.role === "user" || (m.role === "assistant" && !m.pending && m.content))
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch("/api/agent/chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ camera: cam.name, messages: wireMessages }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`chat http ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let evt: { type?: string; delta?: string; message?: string; name?: string; args?: unknown; result?: unknown };
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }
            if (evt.type === "text" && typeof evt.delta === "string") {
              const delta = evt.delta;
              setMessages((m) =>
                m.map((x) =>
                  x.id === asstMsg.id ? { ...x, content: x.content + delta } : x,
                ),
              );
            } else if (evt.type === "tool" && typeof evt.name === "string") {
              const name = evt.name;
              const args = evt.args;
              setMessages((m) =>
                m.map((x) => {
                  if (x.id !== asstMsg.id || x.role !== "assistant") return x;
                  return { ...x, tools: [...(x.tools ?? []), { kind: "call", name, args }] };
                }),
              );
            } else if (evt.type === "tool_result" && typeof evt.name === "string") {
              const name = evt.name;
              const result = evt.result;
              setMessages((m) =>
                m.map((x) => {
                  if (x.id !== asstMsg.id || x.role !== "assistant") return x;
                  return { ...x, tools: [...(x.tools ?? []), { kind: "result", name, result }] };
                }),
              );
            } else if (evt.type === "error") {
              const msg = evt.message ?? "unknown";
              setMessages((m) =>
                m.map((x) =>
                  x.id === asstMsg.id
                    ? { ...x, content: x.content + `\n\n[error: ${msg}]` }
                    : x,
                ),
              );
            } else if (evt.type === "done") {
              setMessages((m) =>
                m.map((x) => {
                  if (x.id !== asstMsg.id || x.role !== "assistant") return x;
                  return { ...x, pending: false };
                }),
              );
            }
          }
        }
      }
    } catch (err) {
      setMessages((m) =>
        m.map((x) =>
          x.id === asstMsg.id
            ? {
                ...x,
                pending: false,
                content: x.content + `\n[connection error: ${err instanceof Error ? err.message : "unknown"}]`,
              }
            : x,
        ),
      );
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [cam, input, messages, sending]);

  return (
    <aside className="flex h-[70vh] min-h-[480px] flex-col border border-border bg-card/30">
      <div className="flex items-center justify-between border-b border-border bg-background/60 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground">
          Agent · {cam ? cam.label : "—"}
        </span>
        {!agentStatus?.chat_configured && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-alert">
            placeholder mode
          </span>
        )}
      </div>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.map((m) => (
          <ChatBubble key={m.id} msg={m} />
        ))}
      </div>

      <form
        className="border-t border-border bg-background/60 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Ask the agent…  (Enter to send, Shift+Enter for newline)"
            className="flex-1 resize-none border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || !input.trim() || !cam}
            className="border border-foreground/80 px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-foreground hover:bg-foreground hover:text-background disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-foreground transition-colors"
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </form>
    </aside>
  );
}

function ChatBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] border px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap ${
          isUser ? "border-foreground/40 bg-foreground/5 text-foreground" : "border-border bg-background/40 text-foreground/90"
        }`}
      >
        {msg.content}
        {msg.role === "assistant" && msg.pending && (
          <span className="ml-1 inline-block h-2 w-1.5 animate-pulse bg-foreground/60 align-middle" />
        )}
        {msg.role === "assistant" && msg.tools && msg.tools.length > 0 && (
          <div className="mt-2 space-y-1">
            {msg.tools.map((t, i) => (
              <ToolChip key={i} t={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolChip({ t }: { t: ToolEvent }) {
  if (t.kind === "call") {
    return (
      <div className="border-l-2 border-alert pl-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        ▸ tool: {t.name}({summarizeArgs(t.args)})
      </div>
    );
  }
  return (
    <div className="border-l-2 border-foreground/30 pl-2 font-mono text-[10px] tracking-wider text-foreground/60">
      ↩ {t.name}: {summarizeResult(t.result)}
    </div>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 3);
  return entries.map(([k, v]) => `${k}=${truncate(String(v), 24)}`).join(", ");
}

function summarizeResult(r: unknown): string {
  if (!r || typeof r !== "object") return String(r);
  const obj = r as Record<string, unknown>;
  if (obj.ok === false) return `error: ${obj.error}`;
  if (Array.isArray(obj.cameras)) return `${(obj.cameras as unknown[]).length} cameras`;
  if (Array.isArray(obj.events)) return `${(obj.events as unknown[]).length} events`;
  if (obj.label) return `${obj.camera} → ${obj.label}`;
  if (obj.rule) return `rule #${(obj.rule as { id: number }).id} proposed`;
  return "ok";
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
