// MSE-driven WebSocket stream hook.
//
// Wire protocol (with the Node proxy in server/api.mjs):
//   1. WS opens (admin cookie auto-included for same-origin)
//   2. Client → server text: {"type":"mse","value":"<wide codec list>"}
//   3. Server → client text: {"type":"mse","value":"video/mp4; codecs=\"...\""}
//   4. Server → client binary: fMP4 init segment, then media segments
//
// Resilience:
//   - Auto-reconnect with exponential backoff (1s,2s,4s,8s, capped at 10s).
//   - Stall watchdog: forces reconnect if no frame for >8s after first frame.
//   - Reset backoff on first frame after a reconnect.
//
// Boundary guarantee: every internal state value besides "playing" and
// "error" should be treated by the UI as a single "Connecting…" indicator.
// Don't surface "idle", "negotiating", "reconnecting" etc as raw labels.

import { useEffect, useRef, useState } from "react";
import type { LiveStatus } from "./types";

export type UseMseStreamResult = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: LiveStatus;
  error: string | null;
  bitrateKbps: number;
  retryAttempt: number;
  nextRetryMs: number;
};

export function useMseStream(camera: string | null, enabled: boolean): UseMseStreamResult {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [status, setStatus] = useState<LiveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [bitrateKbps, setBitrateKbps] = useState<number>(0);
  const [retryAttempt, setRetryAttempt] = useState<number>(0);
  const [nextRetryMs, setNextRetryMs] = useState<number>(0);

  useEffect(() => {
    if (!enabled || !camera) {
      setStatus("idle");
      setRetryAttempt(0);
      setNextRetryMs(0);
      return;
    }
    const video = videoRef.current;
    if (!video) return;

    // -------- Per-effect lifecycle state --------
    let cancelled = false;
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let bytesInWindow = 0;
    let lastFrameAt = 0;

    const conn: {
      ws: WebSocket | null;
      mediaSource: MediaSource | null;
      sourceBuffer: SourceBuffer | null;
      queue: ArrayBuffer[];
    } = { ws: null, mediaSource: null, sourceBuffer: null, queue: [] };

    const flushQueue = () => {
      const sb = conn.sourceBuffer;
      if (!sb || sb.updating) return;
      if (conn.queue.length === 0) return;
      try {
        sb.appendBuffer(conn.queue.shift()!);
      } catch (err) {
        if (cancelled) return;
        console.error("[mse] appendBuffer", err);
        setError(err instanceof Error ? err.message : "appendBuffer failed");
        scheduleReconnect("append-error");
      }
    };

    const teardownConn = () => {
      const { ws, mediaSource, sourceBuffer } = conn;
      try { ws?.close(); } catch { /* ignore */ }
      try {
        if (sourceBuffer && mediaSource && mediaSource.readyState === "open") {
          mediaSource.removeSourceBuffer(sourceBuffer);
        }
      } catch { /* ignore */ }
      try {
        if (mediaSource && mediaSource.readyState === "open") {
          mediaSource.endOfStream();
        }
      } catch { /* ignore */ }
      try { URL.revokeObjectURL(video.src); } catch { /* ignore */ }
      conn.ws = null;
      conn.mediaSource = null;
      conn.sourceBuffer = null;
      conn.queue = [];
    };

    const scheduleReconnect = (reason: string) => {
      if (cancelled) return;
      if (reconnectTimer) return;
      teardownConn();
      attempts += 1;
      setRetryAttempt(attempts);
      const delay = Math.min(10_000, 1000 * 2 ** Math.max(0, attempts - 1));
      setNextRetryMs(delay);
      setStatus("reconnecting");
      console.log(`[mse] reconnect in ${delay}ms (attempt #${attempts}, reason=${reason})`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (cancelled) return;
        connectOnce();
      }, delay);
    };

    const connectOnce = () => {
      if (cancelled) return;
      const ms = new MediaSource();
      conn.mediaSource = ms;
      conn.sourceBuffer = null;
      conn.queue = [];

      ms.addEventListener("sourceopen", () => {
        if (cancelled || conn.mediaSource !== ms) return;

        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const wsUrl = `${proto}//${window.location.host}/api/cam/stream/${encodeURIComponent(camera)}`;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";
        conn.ws = ws;
        setStatus("connecting");

        ws.addEventListener("open", () => {
          if (cancelled || conn.ws !== ws) return;
          setStatus("negotiating");
          const codecs =
            'video/mp4; codecs="avc1.640029,avc1.4D4029,avc1.4D401E,avc1.64001E,avc1.42E01E,mp4a.40.2"';
          ws.send(JSON.stringify({ type: "mse", value: codecs }));
        });

        ws.addEventListener("message", (ev) => {
          if (cancelled || conn.ws !== ws) return;
          if (typeof ev.data === "string") {
            try {
              const msg = JSON.parse(ev.data);
              if (msg && msg.type === "mse" && typeof msg.value === "string" && !conn.sourceBuffer) {
                if (!MediaSource.isTypeSupported(msg.value)) {
                  setError(`Codec not supported: ${msg.value}`);
                  setStatus("error");
                  try { ws.close(); } catch { /* ignore */ }
                  return;
                }
                const sb = ms.addSourceBuffer(msg.value);
                sb.mode = "segments";
                sb.addEventListener("updateend", flushQueue);
                conn.sourceBuffer = sb;
              }
            } catch (err) {
              console.error("[mse] bad text msg", err);
            }
          } else {
            const buf = ev.data as ArrayBuffer;
            bytesInWindow += buf.byteLength;
            lastFrameAt = Date.now();
            conn.queue.push(buf);
            flushQueue();
            if (attempts !== 0) {
              attempts = 0;
              setRetryAttempt(0);
              setNextRetryMs(0);
              setError(null);
            }
            setStatus((s) => (s === "playing" ? s : "playing"));
          }
        });

        ws.addEventListener("close", () => {
          if (cancelled || conn.ws !== ws) return;
          scheduleReconnect("ws-close");
        });
        ws.addEventListener("error", () => {
          if (cancelled || conn.ws !== ws) return;
          setError("WebSocket error");
          scheduleReconnect("ws-error");
        });
      });

      try {
        video.src = URL.createObjectURL(ms);
      } catch (err) {
        console.error("[mse] createObjectURL", err);
        scheduleReconnect("createobjecturl-error");
        return;
      }
      void video.play().catch(() => {
        // autoplay may be blocked on first interaction; harmless after a click.
      });
    };

    connectOnce();

    const sampler = setInterval(() => {
      setBitrateKbps(Math.round((bytesInWindow * 8) / 1000));
      bytesInWindow = 0;
      if (lastFrameAt && Date.now() - lastFrameAt > 8000 && !reconnectTimer) {
        console.log("[mse] no frames for >8s, reconnecting");
        lastFrameAt = 0;
        scheduleReconnect("stall-watchdog");
      }
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(sampler);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      teardownConn();
      video.removeAttribute("src");
      try { video.load(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [camera, enabled]);

  return { videoRef, status, error, bitrateKbps, retryAttempt, nextRetryMs };
}
