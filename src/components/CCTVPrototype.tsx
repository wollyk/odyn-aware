import heroHangar from "@/assets/hero-hangar.jpg";

export function CCTVPrototype() {
  return (
    <div className="relative w-full overflow-hidden border border-border bg-black">
      {/* Camera feed */}
      <div className="relative aspect-[16/9] w-full">
        <img
          src={heroHangar}
          alt="CCTV feed inside aircraft hangar"
          loading="lazy"
          width={1920}
          height={1080}
          className="absolute inset-0 h-full w-full object-cover grayscale contrast-110 brightness-75"
        />
        <div className="absolute inset-0 scanline" />

        {/* Top status bar */}
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between bg-black/60 px-4 py-2 font-mono text-[10px] tracking-widest text-white/80">
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-[oklch(0.7_0.18_142)]" /> LIVE
            </span>
            <span>CAM 04 · HANGAR-A</span>
            <span className="hidden sm:inline">1920×1080 · 30FPS</span>
          </div>
          <div className="flex items-center gap-4">
            <span>2026-05-04</span>
            <span>02:47:13 UTC</span>
          </div>
        </div>

        {/* Bounding box */}
        <div
          className="absolute border border-alert"
          style={{ left: "38%", top: "52%", width: "9%", height: "30%" }}
        >
          <div className="absolute -top-5 left-0 bg-alert px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-background">
            Person · 0.97
          </div>
          {/* corner ticks */}
          <span className="absolute -left-px -top-px h-2 w-2 border-l border-t border-alert" />
          <span className="absolute -right-px -top-px h-2 w-2 border-r border-t border-alert" />
          <span className="absolute -left-px -bottom-px h-2 w-2 border-l border-b border-alert" />
          <span className="absolute -right-px -bottom-px h-2 w-2 border-r border-b border-alert" />
        </div>

        {/* Crosshair reticle */}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-4 top-1/2 h-px w-3 bg-white/40" />
          <div className="absolute right-4 top-1/2 h-px w-3 bg-white/40" />
        </div>

        {/* Alert panel */}
        <div className="absolute bottom-4 right-4 w-[280px] border border-alert/70 bg-black/85 p-3 font-mono text-[11px] text-white">
          <div className="flex items-center gap-2 border-b border-alert/40 pb-2">
            <span className="h-2 w-2 animate-pulse bg-alert" />
            <span className="text-alert tracking-widest">ALERT — PRIORITY HIGH</span>
          </div>
          <div className="mt-2 space-y-1 text-white/85">
            <div className="flex justify-between"><span className="text-white/50">EVENT</span><span>UNAUTH_MOVEMENT</span></div>
            <div className="flex justify-between"><span className="text-white/50">ZONE</span><span>HANGAR-A / NORTH</span></div>
            <div className="flex justify-between"><span className="text-white/50">TIME</span><span>02:47:13</span></div>
            <div className="flex justify-between"><span className="text-white/50">CONF</span><span>0.97</span></div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="absolute bottom-0 left-0 flex items-center gap-3 bg-black/60 px-4 py-1.5 font-mono text-[10px] tracking-widest text-white/70">
          <span>EDGE NODE · ODN-01</span>
          <span className="text-white/30">|</span>
          <span>LATENCY 41 ms</span>
        </div>
      </div>
    </div>
  );
}
