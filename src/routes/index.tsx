import { createFileRoute } from "@tanstack/react-router";
import liveCroatia from "@/assets/website_images/home_page_upgrade_2.PNG";
import liveGarage from "@/assets/website_images/Image_rec_n.PNG";
import mapShot from "@/assets/website_images/home_page_upgrade_1.PNG";
import { SiteHeader } from "@/components/SiteHeader";
import { AccessForm } from "@/components/AccessForm";

// Customer-facing homepage. Rule of thumb when editing:
//   - one product visual per section, big
//   - one sentence of copy (two max)
//   - zero engineering jargon (YOLO, ByteTrack, VLM, FOV, MSE, kbps...)
//   - zero figure captions, zero "FIG. 0X" labels, zero stat grids
// If a sentence reads like a release-note bullet, delete it.

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return (
    <div id="top" className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* HERO — backdrop is the actual product. One headline, one
          paragraph, two buttons. Nothing else. */}
      <section className="relative min-h-[100svh] w-full overflow-hidden">
        <img
          src={liveCroatia}
          alt=""
          width={1920}
          height={1080}
          className="absolute inset-0 h-full w-full object-cover opacity-55"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-background/70" />

        <div className="relative mx-auto flex min-h-[100svh] max-w-7xl flex-col justify-end px-6 pb-24 pt-32">
          <h1 className="max-w-4xl text-5xl font-light leading-[1.05] tracking-tight text-foreground sm:text-6xl md:text-7xl lg:text-8xl">
            Your cameras can<br />
            finally <span className="italic font-serif text-foreground/95">answer.</span>
          </h1>
          <p className="mt-8 max-w-2xl text-base text-foreground/80 sm:text-lg">
            AuroraView watches your cameras for you — and tells you what it
            saw, in plain English.
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
        </div>
      </section>

      {/* LIVE + AGENT — one exchange, one screenshot. */}
      <section id="live" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <div className="grid gap-12 lg:grid-cols-12 lg:items-center">
            <div className="lg:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Watch it.<br />
                Then <span className="italic font-serif">ask</span> about it.
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                Open any camera. Type a question. Get an answer in seconds.
              </p>
              <div className="mt-8 space-y-3 border-y border-border py-5 font-mono text-xs">
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 text-alert">you</span>
                  <span className="text-foreground/90">what have you seen today</span>
                </div>
                <div className="flex items-baseline gap-3">
                  <span className="shrink-0 text-emerald-400">aurora</span>
                  <span className="text-foreground/80">
                    A person crossed the lot seven times between 12:18 and 6:29.
                    No vehicles. Nothing critical.
                  </span>
                </div>
              </div>
            </div>
            <figure className="lg:col-span-7">
              <div className="overflow-hidden border border-border bg-card/30 shadow-2xl">
                <img
                  src={liveGarage}
                  alt="A live camera view with the assistant answering a question"
                  width={2048}
                  height={1126}
                  className="h-auto w-full"
                />
              </div>
            </figure>
          </div>
        </div>
      </section>

      {/* MAP — image first this time so the page rhythm changes. */}
      <section id="map" className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <div className="grid gap-12 lg:grid-cols-12 lg:items-center">
            <figure className="lg:col-span-7">
              <div className="overflow-hidden border border-border bg-card/30 shadow-2xl">
                <img
                  src={mapShot}
                  alt="A property map with camera coverage shown as cones"
                  width={2048}
                  height={1126}
                  className="h-auto w-full"
                />
              </div>
            </figure>
            <div className="lg:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                See coverage.<br />
                See <span className="italic font-serif">gaps.</span>
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                Drop in your floor plan or a satellite tile. Place your cameras.
                Find the blind spot before someone else does.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* IDENTITY — baked eval 15.mp4 with person + face overlays. */}
      <section id="identity" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <div className="grid gap-12 lg:grid-cols-12 lg:items-center">
            <div className="lg:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Know who belongs<br />
                — and who <span className="italic font-serif">doesn&apos;t.</span>
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                Green boxes follow each person. Cyan boxes lock onto every face.
                Upload a photo and search your footage. Get alerted when someone
                unrecognized shows up where they shouldn&apos;t.
              </p>
              <ul className="mt-8 space-y-4 border-y border-border py-6 font-mono text-xs text-foreground/85">
                <li className="flex gap-3">
                  <span className="shrink-0 text-emerald-400">01</span>
                  <span>
                    <strong className="text-foreground">Search</strong> — find
                    this person across cameras and shifts
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="shrink-0 text-sky-400">02</span>
                  <span>
                    <strong className="text-foreground">Authorize</strong> — enroll
                    staff and contractors who are allowed on site
                  </span>
                </li>
                <li className="flex gap-3">
                  <span className="shrink-0 text-alert">03</span>
                  <span>
                    <strong className="text-foreground">Alert</strong> — flag
                    unrecognized faces in a restricted area
                  </span>
                </li>
              </ul>
            </div>
            <figure className="lg:col-span-7">
              <div className="overflow-hidden border border-border bg-card/30 shadow-2xl">
                {/* Baked once via tools/bake_demo_overlay.py from a real
                    eval run. Lives at /demo/* (nginx alias outside dist/)
                    so it survives rebuilds. */}
                <video
                  src="/demo/aurora-identity.mp4"
                  poster={liveCroatia}
                  autoPlay
                  loop
                  muted
                  playsInline
                  preload="metadata"
                  aria-label="Crowd scene with each person numbered and a box around every face"
                  className="block h-auto w-full"
                />
              </div>
            </figure>
          </div>
        </div>
      </section>

      {/* ON-PREM — one concern, one sentence. */}
      <section className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-5xl px-6 py-24 text-center sm:py-32">
          <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
            Nothing leaves<br />
            your <span className="italic font-serif">site.</span>
          </h2>
          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-muted-foreground">
            AuroraView runs on one box on your network and talks to the cameras
            you already have. No cloud account. No per-camera fee.
          </p>
        </div>
      </section>

      {/* ACCESS — heading, one line, form. */}
      <section id="access" className="relative overflow-hidden border-t border-border">
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
          <div className="grid gap-12 md:grid-cols-12 md:items-start">
            <div className="md:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Tell us about<br />
                your <span className="italic font-serif">site.</span>
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                We'll come back with what you'd need and when you'd be up.
              </p>
            </div>
            <div className="md:col-span-7">
              <AccessForm />
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-6 py-10 sm:flex-row sm:items-center">
          <span className="font-mono text-sm font-semibold tracking-[0.3em]">AURORAVIEW</span>
          <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            <a href="/admin/login" className="hover:text-foreground transition-colors">
              Admin
            </a>
            <span className="text-muted-foreground/50">·</span>
            <span>© 2026 AuroraView</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
