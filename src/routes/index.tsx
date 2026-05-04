import { createFileRoute } from "@tanstack/react-router";
import heroHangar from "@/assets/hero-hangar.jpg";
import industrialImg from "@/assets/expansion-industrial.jpg";
import { SiteHeader } from "@/components/SiteHeader";
import { CCTVPrototype } from "@/components/CCTVPrototype";
import { AccessForm } from "@/components/AccessForm";

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

function Index() {
  return (
    <div id="top" className="min-h-screen bg-background text-foreground">
      <SiteHeader />

      {/* HERO */}
      <section className="relative min-h-[100svh] w-full overflow-hidden">
        <img
          src={heroHangar}
          alt="Aircraft hangar interior at dusk"
          width={1920}
          height={1080}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
        <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-background/40" />

        <div className="relative mx-auto flex min-h-[100svh] max-w-7xl flex-col justify-end px-6 pb-20 pt-32">
          <div className="mb-6 flex items-center gap-3">
            <span className="h-1.5 w-1.5 animate-pulse bg-alert" />
            <span className="label-mono">Edge AI · Real-Time Awareness</span>
          </div>
          <h1 className="max-w-4xl text-5xl font-light leading-[1.05] tracking-tight text-foreground sm:text-6xl md:text-7xl lg:text-8xl">
            Real-Time Intelligence<br />
            for <span className="italic font-serif text-foreground/95">Physical Spaces</span>
          </h1>
          <p className="mt-8 max-w-2xl text-base text-muted-foreground sm:text-lg">
            ODYN turns existing cameras into systems that detect, understand, and alert in real time.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <a href="#access" className="inline-flex items-center gap-3 bg-foreground px-7 py-4 text-xs font-medium uppercase tracking-[0.25em] text-background hover:bg-foreground/90 transition-colors">
              Request Early Access <span aria-hidden>→</span>
            </a>
            <a href="#problem" className="inline-flex items-center gap-2 px-2 py-4 text-xs font-medium uppercase tracking-[0.25em] text-foreground/80 hover:text-foreground transition-colors">
              ↓ Read More
            </a>
          </div>

          {/* footer hud */}
          <div className="mt-20 grid grid-cols-2 gap-6 border-t border-border/60 pt-6 font-mono text-[10px] tracking-widest text-muted-foreground sm:grid-cols-4">
            <div><div className="text-foreground/40">v.</div><div className="mt-1 text-foreground/80">ODN-01</div></div>
            <div><div className="text-foreground/40">RUNTIME</div><div className="mt-1 text-foreground/80">ON-DEVICE</div></div>
            <div><div className="text-foreground/40">LATENCY</div><div className="mt-1 text-foreground/80">&lt; 100 MS</div></div>
            <div><div className="text-foreground/40">STATUS</div><div className="mt-1 text-alert">EARLY ACCESS</div></div>
          </div>
        </div>
      </section>

      {/* PROBLEM */}
      <section id="problem" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="01">The Problem</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <h2 className="md:col-span-5 text-4xl font-light leading-tight tracking-tight sm:text-5xl">
              Most cameras<br />record.<br />
              <span className="text-muted-foreground">None understand.</span>
            </h2>
            <div className="md:col-span-6 md:col-start-7 space-y-6 text-base leading-relaxed text-muted-foreground">
              <p>High-value environments are already covered by cameras. But no one is watching them in real time.</p>
              <p className="text-foreground">Incidents are discovered after the fact. Response is delayed. Loss happens in the gap between detection and action.</p>
              <p>The infrastructure exists. What's missing is awareness.</p>
            </div>
          </div>
        </div>
      </section>

      {/* SOLUTION */}
      <section id="solution" className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="02">The Solution</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <h2 className="md:col-span-5 text-4xl font-light leading-tight tracking-tight sm:text-5xl">
              From footage<br />to <span className="italic font-serif">awareness.</span>
            </h2>
            <div className="md:col-span-6 md:col-start-7 space-y-6 text-base leading-relaxed text-muted-foreground">
              <p>ODYN runs locally on-site and analyzes video in real time.</p>
              <p>It detects people, movement, and events as they happen. It understands context based on the environment. It alerts immediately when something requires attention.</p>
              <ul className="grid grid-cols-3 gap-4 pt-4 font-mono text-[11px] uppercase tracking-widest">
                <li className="border-l-2 border-alert pl-3 text-foreground">No constant<br/>monitoring</li>
                <li className="border-l-2 border-alert pl-3 text-foreground">No cloud<br/>dependency</li>
                <li className="border-l-2 border-alert pl-3 text-foreground">No<br/>delay</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* HOW IT WORKS */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="03">How It Works</SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-3">
            {[
              { n: "01", t: "Detect", d: "Identifies movement, presence, and activity in real time." },
              { n: "02", t: "Understand", d: "Applies environment-specific context to determine what matters." },
              { n: "03", t: "Alert", d: "Notifies instantly when action is required." },
            ].map((s, i) => (
              <div key={s.n} className={`p-8 ${i > 0 ? "md:border-l border-border" : ""} ${i > 0 ? "border-t md:border-t-0" : ""}`}>
                <div className="font-mono text-xs text-alert">{s.n}</div>
                <h3 className="mt-6 text-3xl font-light tracking-tight">{s.t}</h3>
                <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* PROTOTYPE / PRODUCT VIEW */}
      <section id="product" className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="04">Live Detection</SectionLabel>
          <div className="grid gap-12 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Built for real<br />environments.
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                ODYN runs on a local edge device connected to existing cameras.
              </p>
              <ul className="mt-8 divide-y divide-border border-y border-border font-mono text-xs">
                {[
                  ["EDGE", "On-device processing — no cloud latency"],
                  ["INTEGRATION", "Works with standard IP camera systems"],
                  ["RESILIENCE", "Designed for low-light, real-world conditions"],
                  ["DEPLOY", "No infrastructure changes required"],
                ].map(([k, v]) => (
                  <li key={k} className="grid grid-cols-12 gap-4 py-4">
                    <span className="col-span-4 text-alert tracking-widest">{k}</span>
                    <span className="col-span-8 text-foreground/85 normal-case tracking-normal font-sans">{v}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-8 text-sm text-muted-foreground">
                <span className="text-foreground">This is not a dashboard.</span> It is an on-site intelligence system.
              </p>
            </div>
            <div className="lg:col-span-7">
              <CCTVPrototype />
              <div className="mt-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                <span>FIG. 01 — Detection Overlay, Hangar-A / Cam 04</span>
                <span>Simulated view</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* USE CASE — HANGARS */}
      <section className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="05">Initial Deployment</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <h2 className="md:col-span-5 text-4xl font-light leading-tight tracking-tight sm:text-5xl">
              Starting with<br />aircraft hangars.
            </h2>
            <div className="md:col-span-6 md:col-start-7 space-y-6 text-base leading-relaxed text-muted-foreground">
              <p>Aircraft hangars contain high-value assets with minimal daily activity.</p>
              <div className="border-l-2 border-alert pl-5">
                <div className="label-mono mb-3">ODYN Detects</div>
                <ul className="space-y-2 text-foreground">
                  <li>— Entry into the hangar</li>
                  <li>— Movement near aircraft</li>
                  <li>— Unexpected door activity</li>
                </ul>
              </div>
              <p>Owners are notified immediately. No need for continuous monitoring. <span className="text-foreground">Awareness in seconds instead of hours.</span></p>
            </div>
          </div>
        </div>
      </section>

      {/* EXPANSION */}
      <section className="relative overflow-hidden border-t border-border">
        <img src={industrialImg} alt="Industrial facility at night" loading="lazy" width={1600} height={900} className="absolute inset-0 h-full w-full object-cover opacity-30" />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/95 to-background/70" />
        <div className="relative mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="06">Expansion</SectionLabel>
          <h2 className="max-w-3xl text-4xl font-light leading-tight tracking-tight sm:text-5xl md:text-6xl">
            Same problem.<br /><span className="italic font-serif">Larger scale.</span>
          </h2>
          <p className="mt-8 max-w-xl text-muted-foreground">After hangars, ODYN expands to environments where delayed awareness leads to loss.</p>
          <div className="mt-12 grid grid-cols-2 gap-px bg-border md:grid-cols-4">
            {["Industrial yards", "Oil & gas facilities", "Logistics environments", "Private high-value properties"].map((label, i) => (
              <div key={label} className="bg-background p-6">
                <div className="font-mono text-[10px] text-alert">0{i + 1}</div>
                <div className="mt-6 text-lg font-light text-foreground">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ACCESS / CTA */}
      <section id="access" className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-5xl px-6 py-24 sm:py-32">
          <SectionLabel num="07">Early Access</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <div className="md:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Request<br />access.
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                We are deploying initial systems with select customers. Request access to participate in early deployments.
              </p>
              <div className="mt-10 space-y-3 font-mono text-xs text-muted-foreground">
                <div className="flex items-center gap-3"><span className="h-1 w-1 bg-alert" /> Limited cohort</div>
                <div className="flex items-center gap-3"><span className="h-1 w-1 bg-alert" /> Direct deployment support</div>
                <div className="flex items-center gap-3"><span className="h-1 w-1 bg-alert" /> Priority hardware allocation</div>
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
            <span className="font-mono text-sm font-semibold tracking-[0.3em]">ODYN</span>
            <span className="label-mono">Edge Intelligence Systems</span>
          </div>
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            © 2026 ODYN · All Rights Reserved
          </div>
        </div>
      </footer>
    </div>
  );
}
