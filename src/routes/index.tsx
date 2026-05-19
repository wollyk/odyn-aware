import { createFileRoute } from "@tanstack/react-router";
import liveCroatia from "@/assets/website_images/home_page_upgrade_2.PNG";
import liveGarage from "@/assets/website_images/Image_rec_n.PNG";
import mapShot from "@/assets/website_images/home_page_upgrade_1.PNG";
import { SiteHeader } from "@/components/SiteHeader";
import { AccessForm } from "@/components/AccessForm";

// The home page is feature-led, not pitch-deck-led. Each section shows
// the *actual* admin UI and pairs it with copy that mirrors what an
// operator would do (ask a question, see coverage, watch tracks).
//
// Structure:
//   00 hero        — product screenshot as backdrop, customer headline
//   01 live + ask  — VLM answering "what do you see"
//   02 map         — multi-camera spatial layout with FOV cones
//   03 tracking    — persistent multi-camera object tracks
//   04 how it runs — compact 4-stat tech bar (edge / latency / no cloud)
//   05 access      — request a deployment (form unchanged)

export const Route = createFileRoute("/")({
  component: Index,
});

function SectionLabel({ num, children }: { num: string; children: React.ReactNode }) {
  return (
    <div className="mb-8 flex items-center gap-3">
      <span className="font-mono text-xs text-alert">[{num}]</span>
      <span className="label-mono">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// Compact pill showing live system state. Repeated in the hero + section
// captions so the page feels alive.
function StatusPill({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "good" | "alert" }) {
  const valueColor =
    tone === "good" ? "text-emerald-400" : tone === "alert" ? "text-alert" : "text-foreground/90";
  return (
    <span className="inline-flex items-center gap-2 border border-border/60 bg-background/40 px-2.5 py-1 font-mono text-[10px] uppercase tracking-widest backdrop-blur-sm">
      <span className="text-foreground/40">{label}</span>
      <span className={valueColor}>{value}</span>
    </span>
  );
}

function Index() {
  return (
    <div id="top" className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* 00 — HERO ----------------------------------------------------------
          Product-led: the backdrop IS the product, dimmed enough that the
          headline reads. No more stock-photo hangar. */}
      <section className="relative min-h-[100svh] w-full overflow-hidden">
        <img
          src={liveCroatia}
          alt="AuroraView admin live view"
          width={1920}
          height={1080}
          className="absolute inset-0 h-full w-full object-cover opacity-55"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-background/70" />

        <div className="relative mx-auto flex min-h-[100svh] max-w-7xl flex-col justify-end px-6 pb-20 pt-32">
          <div className="mb-6 flex flex-wrap items-center gap-2">
            <StatusPill label="LIVE" value="ON-SITE" tone="good" />
            <StatusPill label="LATENCY" value="< 2 S" />
            <StatusPill label="CLOUD" value="NONE" tone="alert" />
          </div>
          <h1 className="max-w-4xl text-5xl font-light leading-[1.05] tracking-tight text-foreground sm:text-6xl md:text-7xl lg:text-8xl">
            Your cameras can<br />
            finally <span className="italic font-serif text-foreground/95">answer.</span>
          </h1>
          <p className="mt-8 max-w-2xl text-base text-foreground/80 sm:text-lg">
            AuroraView is an AI layer that runs next to your existing CCTV.
            It watches in real time, tracks people and objects across cameras,
            and answers questions in plain English — all on-site, with no
            cloud round-trip.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <a
              href="#live"
              className="inline-flex items-center gap-3 bg-foreground px-7 py-4 text-xs font-medium uppercase tracking-[0.25em] text-background hover:bg-foreground/90 transition-colors"
            >
              See It Working <span aria-hidden>↓</span>
            </a>
            <a
              href="#access"
              className="inline-flex items-center gap-3 border border-foreground/40 px-7 py-4 text-xs font-medium uppercase tracking-[0.25em] text-foreground hover:bg-foreground hover:text-background transition-colors"
            >
              Book A Deployment <span aria-hidden>→</span>
            </a>
          </div>

          {/* HUD: same shape as the admin shell footer so the page feels
              continuous with the product. */}
          <div className="mt-20 grid grid-cols-2 gap-6 border-t border-border/60 pt-6 font-mono text-[10px] tracking-widest text-muted-foreground sm:grid-cols-4">
            <div><div className="text-foreground/40">RUNTIME</div><div className="mt-1 text-foreground/85">ON-DEVICE</div></div>
            <div><div className="text-foreground/40">CAMERAS</div><div className="mt-1 text-foreground/85">EXISTING IP</div></div>
            <div><div className="text-foreground/40">AGENT</div><div className="mt-1 text-foreground/85">NATURAL LANGUAGE</div></div>
            <div><div className="text-foreground/40">DEPLOY</div><div className="mt-1 text-alert">2 WEEKS</div></div>
          </div>
        </div>
      </section>

      {/* 01 — LIVE + AGENT --------------------------------------------------
          The big sell. The agent literally answers what's in the scene. */}
      <section id="live" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="01">Live View · Ask Anything</SectionLabel>
          <div className="grid gap-12 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Watch it.<br />
                Then <span className="italic font-serif">ask</span> about it.
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                Click any camera. The video plays in real time. On the right, the
                agent is sitting there, ready. Type a question.
              </p>
              <div className="mt-8 space-y-3 border-y border-border py-5 font-mono text-xs">
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 text-alert">you →</span>
                  <span className="text-foreground/90">what do you see</span>
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 text-emerald-400">agent →</span>
                  <span className="text-foreground/80">
                    urns of different sizes are scattered throughout a backyard,
                    with trees and a building in the background.
                    <span className="text-foreground/50"> · severity normal · confidence 55%</span>
                  </span>
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 text-alert">you →</span>
                  <span className="text-foreground/90">what have you seen today</span>
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 text-emerald-400">agent →</span>
                  <span className="text-foreground/80">
                    734 normal events, 0 critical. Garage camera was busiest. A
                    person was seen 7 times between 00:12 and 06:29.
                  </span>
                </div>
              </div>
              <ul className="mt-6 grid grid-cols-2 gap-3 font-mono text-[10px] uppercase tracking-widest text-foreground/70">
                <li className="border-l-2 border-alert pl-3">Local VLM<br/>no cloud</li>
                <li className="border-l-2 border-alert pl-3">Tool calls<br/>rename, alert, summarize</li>
                <li className="border-l-2 border-alert pl-3">Per-camera<br/>context window</li>
                <li className="border-l-2 border-alert pl-3">Vision tick<br/>every 5 s</li>
              </ul>
            </div>
            <figure className="lg:col-span-7">
              <div className="overflow-hidden border border-border bg-card/30 shadow-2xl">
                <img
                  src={liveGarage}
                  alt="Live view of the Garage camera with the agent answering questions"
                  width={2048}
                  height={1126}
                  className="h-auto w-full"
                />
              </div>
              <figcaption className="mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <span>FIG. 01 — Live MSE stream · Garage · agent answering</span>
                <span>real screenshot · not mocked</span>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/* 02 — MAP -----------------------------------------------------------
          Spatial awareness across the whole site. */}
      <section id="map" className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="02">Map · Every Camera On One Plan</SectionLabel>
          <div className="grid gap-12 lg:grid-cols-12">
            <figure className="lg:col-span-7">
              <div className="overflow-hidden border border-border bg-card/30 shadow-2xl">
                <img
                  src={mapShot}
                  alt="Property map with two camera FOV cones overlaid"
                  width={2048}
                  height={1126}
                  className="h-auto w-full"
                />
              </div>
              <figcaption className="mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <span>FIG. 02 — Property map · 2 cameras · FOV cones</span>
                <span>drag dots to move · drag handle to rotate</span>
              </figcaption>
            </figure>
            <div className="lg:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                See coverage.<br />
                See <span className="italic font-serif">gaps.</span>
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                Drop a satellite tile or a floor plan. Place each camera. Drag the
                handle to set its field of view. Find blind spots before someone
                else does.
              </p>
              <ul className="mt-8 divide-y divide-border border-y border-border font-mono text-xs">
                {[
                  ["BG", "Replace with any image — satellite, floor plan, hand-drawn"],
                  ["CAMERAS", "Click a dot to edit. Rotate, widen, narrow."],
                  ["MEASURE", "Two-click distance · pixel-accurate"],
                  ["AGENT", "Ask: \u201Cwhich cameras cover the workshop?\u201D"],
                ].map(([k, v]) => (
                  <li key={k} className="grid grid-cols-12 gap-4 py-4">
                    <span className="col-span-3 text-alert tracking-widest">{k}</span>
                    <span className="col-span-9 normal-case tracking-normal font-sans text-foreground/85">
                      {v}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* 03 — TRACKING -------------------------------------------------------
          Persistent tracks across cameras. Showcase using the Croatia
          marina shot — it's a busy scene that makes the point. */}
      <section id="tracking" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="03">Tracking · People &amp; Objects</SectionLabel>
          <div className="grid gap-12 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Follow every<br />
                <span className="italic font-serif">moving thing.</span>
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                A person walks across the lot, into the garage, then over to the
                workshop. AuroraView keeps the same ID on them the entire time —
                even as they cross camera boundaries.
              </p>
              <div className="mt-8 grid grid-cols-3 gap-3 border-y border-border py-6 text-center">
                <div>
                  <div className="font-mono text-3xl text-foreground">734</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">events / day</div>
                </div>
                <div className="border-x border-border">
                  <div className="font-mono text-3xl text-foreground">7</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">person sightings</div>
                </div>
                <div>
                  <div className="font-mono text-3xl text-alert">0</div>
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">missed today</div>
                </div>
              </div>
              <ul className="mt-6 space-y-3 font-mono text-xs text-muted-foreground">
                <li>— YOLOv8 detector + ByteTrack persistent IDs</li>
                <li>— Cross-camera re-ID via embedding similarity</li>
                <li>— Static vs. moving auto-tagged · de-duped against props</li>
                <li>— Tagged events streamed to alerts &amp; the agent</li>
              </ul>
            </div>
            <figure className="lg:col-span-7">
              <div className="relative overflow-hidden border border-border bg-card/30 shadow-2xl">
                {/* Real eval-run output, baked once via tools/bake_demo_overlay.py.
                    Plays from /demo/ which is an nginx alias to a directory that
                    sits outside dist/ so npm run build can't blow it away. The
                    <img> stays as a poster so users on browsers that block
                    autoplay still see something tracking-ish. */}
                <video
                  src="/demo/aurora-tracking.mp4"
                  poster={liveCroatia}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  aria-label="People being tracked in real time on a street with persistent IDs"
                  className="block h-auto w-full"
                />
                <span className="pointer-events-none absolute left-3 top-3 inline-flex items-center gap-2 bg-background/70 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-emerald-400 backdrop-blur-sm">
                  <span className="h-1.5 w-1.5 bg-emerald-400" /> LIVE TRACKS · 40 IDs
                </span>
              </div>
              <figcaption className="mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <span>FIG. 03 — Street scene · 40 persistent person tracks · 248 frames</span>
                <span>real eval output · not mocked</span>
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      {/* 04 — HOW IT RUNS ----------------------------------------------------
          Less philosophy, more deployment specifics. */}
      <section className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="04">How It Runs</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <div className="md:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                One box.<br />
                <span className="italic font-serif">Your network.</span>
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                AuroraView ships as a single appliance you plug into your camera
                VLAN. It speaks RTSP to your existing IP cameras, runs detection
                and the language model locally, and exposes a web UI on your LAN.
              </p>
              <p className="mt-4 text-base leading-relaxed text-foreground">
                Nothing leaves your site unless you say so.
              </p>
            </div>
            <div className="md:col-span-7 grid grid-cols-2 gap-px border border-border bg-border">
              {[
                ["EDGE", "GPU-accelerated · runs on-site"],
                ["LATENCY", "< 2 s detection to alert"],
                ["CAMERAS", "Any RTSP / ONVIF feed"],
                ["MODELS", "YOLOv8 + Moondream + ByteTrack"],
                ["INTEGRATION", "Webhooks · Slack · email"],
                ["DATA", "Stays on your LAN by default"],
              ].map(([k, v]) => (
                <div key={k} className="bg-background p-6">
                  <div className="font-mono text-[10px] uppercase tracking-widest text-alert">{k}</div>
                  <div className="mt-3 text-sm leading-snug text-foreground/85">{v}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* 05 — ACCESS / CTA --------------------------------------------------- */}
      <section id="access" className="relative overflow-hidden border-t border-border">
        {/* Subtle scan-line atmosphere via CSS only — no big PNG payload. */}
        <div
          aria-hidden
          className="absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage:
              "repeating-linear-gradient(0deg, currentColor 0 1px, transparent 1px 4px)",
            color: "var(--foreground)",
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-background" />
        <div className="relative mx-auto max-w-5xl px-6 py-24 sm:py-32">
          <SectionLabel num="05">Get It Running On Your Site</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <div className="md:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Tell us about<br />
                your <span className="italic font-serif">site.</span>
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                Drop your details below. We'll come back with a sizing estimate,
                what cameras you'd need, and a deployment timeline.
              </p>
              <div className="mt-10 space-y-3 font-mono text-xs text-muted-foreground">
                <div className="flex items-center gap-3"><span className="h-1 w-1 bg-alert" /> Typical site online in 2 weeks</div>
                <div className="flex items-center gap-3"><span className="h-1 w-1 bg-alert" /> Works with cameras you already own</div>
                <div className="flex items-center gap-3"><span className="h-1 w-1 bg-alert" /> No per-camera cloud fees</div>
                <div className="flex items-center gap-3"><span className="h-1 w-1 bg-alert" /> Direct line to the engineers building it</div>
              </div>
            </div>
            <div className="md:col-span-7">
              <AccessForm />
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-6 py-10 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <span className="font-mono text-sm font-semibold tracking-[0.3em]">AURORAVIEW</span>
            <span className="label-mono">Awareness for physical sites</span>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-widest">
              <a href="https://auroraview.tech" className="text-foreground/80 hover:text-foreground transition-colors">
                auroraview.tech
              </a>
              <span className="text-muted-foreground/50">·</span>
              <a href="/admin/login" className="text-muted-foreground hover:text-foreground transition-colors">
                Admin
              </a>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              © 2026 AuroraView · All Rights Reserved
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
