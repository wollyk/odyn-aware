// Drives an HTMLVideoElement with HLS — native on Safari, hls.js everywhere
// else. Exposes a wall-clock `currentMs` / `seekToMs` API so callers don't
// have to think about the offset between `video.currentTime` (seconds since
// playlist start) and the timeline's absolute ms.

import { useCallback, useEffect, useRef, useState } from "react";
import type Hls from "hls.js";

export type HlsPlayerStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export type UseHlsPlayerResult = {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  status: HlsPlayerStatus;
  error: string | null;
  currentMs: number;
  durationMs: number;
  seekToMs: (ms: number) => void;
  setPlaying: (playing: boolean) => void;
};

type Args = {
  src: string | null;
  /** Absolute wall-clock ms representing `video.currentTime === 0`. */
  windowStartMs: number;
  autoPlay?: boolean;
  /** Test seam — injected so we can swap a fake hls.js in unit tests. */
  hlsModule?: typeof import("hls.js");
};

export function useHlsPlayer(args: Args): UseHlsPlayerResult {
  const { src, windowStartMs, autoPlay = false, hlsModule } = args;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const watchdogRef = useRef<number | null>(null);
  const [status, setStatus] = useState<HlsPlayerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(windowStartMs);
  const [durationMs, setDurationMs] = useState(0);

  // Helper used by the media-event listeners to defuse the manifest
  // watchdog as soon as playback actually starts (timeupdate, play,
  // pause, etc all imply the pipeline is alive).
  const defuseWatchdog = useCallback(() => {
    if (watchdogRef.current != null) {
      window.clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
  }, []);

  // Bind src -> <video>, choosing native vs hls.js. Before handing the
  // URL to either, we HEAD/GET the manifest ourselves so we can fail
  // fast with a meaningful error instead of relying on hls.js's
  // sometimes-silent behavior when the upstream returns an empty or
  // non-200 playlist.
  //
  // We also attach the media-event listeners inside THIS effect so
  // they are always wired to the live <video> element. (A separate
  // listener-effect tied to [windowStartMs] races with the ref
  // assignment in tests and at first mount.)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);

    // ---- media event listeners ----
    // Defuse the watchdog the moment we see any sign of life, and
    // transition loading → paused when metadata or playable data
    // arrives so the UI never sticks on "loading" after a successful
    // load.
    const onTime = () => {
      defuseWatchdog();
      setCurrentMs(windowStartMs + video.currentTime * 1000);
    };
    const onDur = () => setDurationMs(video.duration * 1000);
    const onReady = () => {
      defuseWatchdog();
      setStatus((s) => (s === "loading" ? "paused" : s));
    };
    const onPlay = () => { defuseWatchdog(); setStatus("playing"); };
    const onPause = () => { defuseWatchdog(); setStatus("paused"); };
    const onEnded = () => setStatus("ended");
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("durationchange", onDur);
    video.addEventListener("loadedmetadata", onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);

    // 6s safety net — if we never transition to playing/paused/error
    // we surface a clear error. The previous 20s was just frustrating
    // to wait through during diagnosis.
    watchdogRef.current = window.setTimeout(() => {
      if (cancelled) return;
      setStatus("error");
      setError("manifest_timeout (no media event in 6s)");
    }, 6_000);

    // AbortController so the manifest fetch itself can't outrun the
    // watchdog — without this the fetch could sit waiting for a slow
    // upstream while the UI shows "loading".
    const ac = new AbortController();
    const fetchTimer = window.setTimeout(() => ac.abort(), 6_000);

    // Pre-probe the manifest. If it's not a valid playlist body we
    // bail BEFORE letting hls.js spin indefinitely.
    const probe = fetch(src, { credentials: "include", signal: ac.signal })
      .then(async (r) => {
        if (cancelled) return { ok: false as const, reason: "cancelled" };
        if (!r.ok) {
          // Try to parse a JSON error body for detail; fall back to status.
          let detail: string = `${r.status}`;
          try {
            const body = (await r.json()) as { error?: string; detail?: string };
            if (body.error) detail = body.detail ? `${body.error}: ${body.detail}` : body.error;
          } catch {
            try {
              const txt = (await r.text()).slice(0, 200);
              if (txt) detail = `${r.status}: ${txt}`;
            } catch {
              /* ignore */
            }
          }
          return { ok: false as const, reason: detail };
        }
        const txt = await r.text();
        if (!txt.startsWith("#EXTM3U")) {
          return {
            ok: false as const,
            reason: `bad_manifest (first 80 bytes: ${txt.slice(0, 80).replace(/\n/g, "\\n")})`,
          };
        }
        return { ok: true as const };
      })
      .catch((err) => {
        const reason =
          err?.name === "AbortError"
            ? "fetch_timeout (manifest request did not complete in 6s)"
            : err instanceof Error
              ? err.message
              : "fetch_failed";
        return { ok: false as const, reason };
      });

    probe.then((result) => {
      window.clearTimeout(fetchTimer);
      if (cancelled) return;
      if (!result.ok) {
        defuseWatchdog();
        setStatus("error");
        setError(result.reason);
        return;
      }

      const nativeSupported = video.canPlayType("application/vnd.apple.mpegurl") !== "";
      if (nativeSupported) {
        video.src = src;
        if (autoPlay) void video.play().catch(() => {});
        return;
      }

      // hls.js path. Dynamic-imported so tests can inject a fake.
      const loadHls = hlsModule ? Promise.resolve(hlsModule) : import("hls.js");
      loadHls
        .then((mod) => {
          if (cancelled) return;
          const HlsCtor = (mod as typeof import("hls.js")).default;
          if (!HlsCtor.isSupported()) {
            setStatus("error");
            setError("hls_not_supported");
            return;
          }
          const hls = new HlsCtor();
          hlsRef.current = hls;
          hls.on(HlsCtor.Events.ERROR, (_evt, data) => {
            if (cancelled) return;
            if (data.fatal) {
              setStatus("error");
              setError(String(data.details ?? "hls_error"));
            }
          });
          hls.loadSource(src);
          hls.attachMedia(video);
          if (autoPlay) void video.play().catch(() => {});
        })
        .catch((err) => {
          if (cancelled) return;
          setStatus("error");
          setError(err instanceof Error ? err.message : "hls_load_failed");
        });
    });

    return () => {
      cancelled = true;
      window.clearTimeout(fetchTimer);
      ac.abort();
      defuseWatchdog();
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("durationchange", onDur);
      video.removeEventListener("loadedmetadata", onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
      video.removeAttribute("src");
      try { video.load(); } catch { /* ignore */ }
    };
  }, [src, autoPlay, hlsModule, defuseWatchdog, windowStartMs]);

  // (Listener attach is colocated with the src-bind effect above so
  // that the wiring is always tied to the live <video> element.)

  const seekToMs = useCallback(
    (ms: number) => {
      const video = videoRef.current;
      if (!video) return;
      const t = Math.max(0, (ms - windowStartMs) / 1000);
      video.currentTime = t;
    },
    [windowStartMs],
  );

  const setPlaying = useCallback((playing: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => {});
    else video.pause();
  }, []);

  return { videoRef, status, error, currentMs, durationMs, seekToMs, setPlaying };
}
