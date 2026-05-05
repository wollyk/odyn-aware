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
            <span className="label-mono">Real-Time Intelligence Layer · On-Site</span>
          </div>
          <h1 className="max-w-4xl text-5xl font-light leading-[1.05] tracking-tight text-foreground sm:text-6xl md:text-7xl lg:text-8xl">
            Awareness<br />
            for <span className="italic font-serif text-foreground/95">Physical Spaces</span>
          </h1>
          <p className="mt-8 max-w-2xl text-base text-muted-foreground sm:text-lg">
            AuroraView is an on-site intelligence layer. Policy-driven detection, natural language interaction, and behavior analysis — running locally beside your existing cameras.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <a href="#access" className="inline-flex items-center gap-3 bg-foreground px-7 py-4 text-xs font-medium uppercase tracking-[0.25em] text-background hover:bg-foreground/90 transition-colors">
              Request Deployment <span aria-hidden>→</span>
            </a>
            <a href="#problem" className="inline-flex items-center gap-2 px-2 py-4 text-xs font-medium uppercase tracking-[0.25em] text-foreground/80 hover:text-foreground transition-colors">
              ↓ Read More
            </a>
          </div>

          {/* footer hud */}
          <div className="mt-20 grid grid-cols-2 gap-6 border-t border-border/60 pt-6 font-mono text-[10px] tracking-widest text-muted-foreground sm:grid-cols-4">
            <div><div className="text-foreground/40">v.</div><div className="mt-1 text-foreground/80">AV-01</div></div>
            <div><div className="text-foreground/40">RUNTIME</div><div className="mt-1 text-foreground/80">ON-DEVICE</div></div>
            <div><div className="text-foreground/40">LATENCY</div><div className="mt-1 text-foreground/80">&lt; 2 S</div></div>
            <div><div className="text-foreground/40">STATUS</div><div className="mt-1 text-alert">DEPLOYING</div></div>
          </div>
        </div>
      </section>

      {/* PROBLEM */}
      <section id="problem" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="01">The Problem</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <h2 className="md:col-span-5 text-4xl font-light leading-tight tracking-tight sm:text-5xl">
              Cameras capture<br />everything.<br />
              <span className="text-muted-foreground">They understand nothing.</span>
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
              <p>AuroraView runs locally on-site and analyzes video in real time.</p>
              <p>It detects people, movement, and activity as it happens. It applies environment-specific rules to determine what matters. It alerts immediately when something requires attention.</p>
              <ul className="grid grid-cols-3 gap-4 pt-4 font-mono text-[11px] uppercase tracking-widest">
                <li className="border-l-2 border-alert pl-3 text-foreground">No constant<br/>monitoring</li>
                <li className="border-l-2 border-alert pl-3 text-foreground">No cloud<br/>dependency</li>
                <li className="border-l-2 border-alert pl-3 text-foreground">No<br/>delay</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* POLICY */}
      <section id="policy" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="03">Policy-Driven</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <h2 className="md:col-span-5 text-4xl font-light leading-tight tracking-tight sm:text-5xl">
              Define what<br />matters.<br />
              <span className="text-muted-foreground">From presence to behavior.</span>
            </h2>
            <div className="md:col-span-6 md:col-start-7 space-y-6 text-base leading-relaxed text-muted-foreground">
              <p>AuroraView detects patterns, not just movement.</p>
              <ul className="border-y border-border divide-y divide-border font-mono text-xs">
                <li className="py-4">— Loitering in restricted areas</li>
                <li className="py-4">— Unauthorized access during closed hours</li>
                <li className="py-4">— Abnormal or aggressive activity</li>
                <li className="py-4">— Policy violations specific to the environment</li>
              </ul>
              <p className="text-foreground">Each deployment is tuned to what matters in that space.</p>
            </div>
          </div>
        </div>
      </section>

      {/* INTERACTION */}
      <section className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="04">Interaction</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <h2 className="md:col-span-5 text-4xl font-light leading-tight tracking-tight sm:text-5xl">
              Speak to<br />the system.
            </h2>
            <div className="md:col-span-6 md:col-start-7 space-y-6 text-base leading-relaxed text-muted-foreground">
              <p>Natural language interaction. No dashboards, no consoles to learn.</p>
              <p className="text-foreground">Ask in plain language: <span className="italic">"Was the hangar entered after 10 PM last night?"</span> The system answers from on-device context.</p>
              <p>Define policies the same way. The system understands the environment and adapts.</p>
            </div>
          </div>
        </div>
      </section>

      {/* PROTOTYPE / PRODUCT VIEW */}
      <section id="product" className="border-t border-border">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="05">Live Detection</SectionLabel>
          <div className="grid gap-12 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Built for real<br />environments.
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                AuroraView runs on a local edge device connected to existing camera systems.
              </p>
              <ul className="mt-8 divide-y divide-border border-y border-border font-mono text-xs">
                {[
                  ["EDGE", "On-device processing"],
                  ["LATENCY", "Real-time detection (< 2s)"],
                  ["INTEGRATION", "Works with standard IP cameras"],
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
      <section className="border-t border-border bg-card/40">
        <div className="mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="06">Initial Deployment</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <h2 className="md:col-span-5 text-4xl font-light leading-tight tracking-tight sm:text-5xl">
              Starting with<br />aircraft hangars.
            </h2>
            <div className="md:col-span-6 md:col-start-7 space-y-6 text-base leading-relaxed text-muted-foreground">
              <p>High-value environments with minimal daily activity.</p>
              <div className="border-l-2 border-alert pl-5">
                <div className="label-mono mb-3">AuroraView Detects</div>
                <ul className="space-y-2 text-foreground">
                  <li>— Entry into the hangar</li>
                  <li>— Movement near aircraft</li>
                  <li>— Unexpected door activity</li>
                </ul>
              </div>
              <p>Configured to alert only when it matters. <span className="text-foreground">Awareness in seconds instead of hours.</span></p>
            </div>
          </div>
        </div>
      </section>

      {/* EXPANSION */}
      <section className="relative overflow-hidden border-t border-border">
        <img src={industrialImg} alt="Industrial facility at night" loading="lazy" width={1600} height={900} className="absolute inset-0 h-full w-full object-cover opacity-30" />
        <div className="absolute inset-0 bg-gradient-to-r from-background via-background/95 to-background/70" />
        <div className="relative mx-auto max-w-7xl px-6 py-24 sm:py-32">
          <SectionLabel num="07">Expansion</SectionLabel>
          <h2 className="max-w-3xl text-4xl font-light leading-tight tracking-tight sm:text-5xl md:text-6xl">
            Same problem.<br /><span className="italic font-serif">Different scale.</span>
          </h2>
          <p className="mt-8 max-w-xl text-muted-foreground">After hangars, AuroraView expands to environments where delayed awareness leads to loss.</p>
          <div className="mt-12 grid grid-cols-2 gap-px bg-border md:grid-cols-4">
            {["Industrial sites", "Oil & gas facilities", "Logistics environments", "Private high-value properties"].map((label, i) => (
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
          <SectionLabel num="08">Deployment Access</SectionLabel>
          <div className="grid gap-12 md:grid-cols-12">
            <div className="md:col-span-5">
              <h2 className="text-4xl font-light leading-tight tracking-tight sm:text-5xl">
                Request<br />deployment.
              </h2>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground">
                Initial systems are being deployed with select operators. Request access to participate in the next deployment cohort.
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
            <span className="font-mono text-sm font-semibold tracking-[0.3em]">AURORAVIEW</span>
            <span className="label-mono">Real-Time Intelligence Layer</span>
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
