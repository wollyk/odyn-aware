export function SiteHeader() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/60 bg-background/70 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold tracking-[0.3em] text-foreground">AURORAVIEW</span>
          <span className="hidden sm:inline label-mono">/ Real-Time Intelligence Layer</span>
        </a>
        <nav className="hidden items-center gap-8 md:flex">
          <a href="#live" className="label-mono hover:text-foreground transition-colors">Live</a>
          <a href="#map" className="label-mono hover:text-foreground transition-colors">Map</a>
          <a href="#tracking" className="label-mono hover:text-foreground transition-colors">Tracking</a>
          <a href="#access" className="label-mono hover:text-foreground transition-colors">Deploy</a>
        </nav>
        <a href="#access" className="inline-flex items-center gap-2 border border-foreground/80 px-4 py-2 text-xs font-medium tracking-widest uppercase text-foreground hover:bg-foreground hover:text-background transition-colors">
          Book A Deployment
        </a>
      </div>
    </header>
  );
}
