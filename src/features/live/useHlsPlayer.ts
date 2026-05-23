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
  const [status, setStatus] = useState<HlsPlayerStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [currentMs, setCurrentMs] = useState(windowStartMs);
  const [durationMs, setDurationMs] = useState(0);

  // Bind src -> <video>, choosing native vs hls.js.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) {
      setStatus("idle");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);

    const nativeSupported = video.canPlayType("application/vnd.apple.mpegurl") !== "";
    if (nativeSupported) {
      video.src = src;
      if (autoPlay) void video.play().catch(() => {});
      return () => {
        cancelled = true;
        video.removeAttribute("src");
        try { video.load(); } catch { /* ignore */ }
      };
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

    return () => {
      cancelled = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.removeAttribute("src");
      try { video.load(); } catch { /* ignore */ }
    };
  }, [src, autoPlay, hlsModule]);

  // Wall-clock cursor + status from media events.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTime = () => setCurrentMs(windowStartMs + video.currentTime * 1000);
    const onDur = () => setDurationMs(video.duration * 1000);
    const onPlay = () => setStatus("playing");
    const onPause = () => setStatus("paused");
    const onEnded = () => setStatus("ended");
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("durationchange", onDur);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onEnded);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("durationchange", onDur);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onEnded);
    };
  }, [windowStartMs]);

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
