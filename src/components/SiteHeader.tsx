export function SiteHeader() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/60 bg-background/70 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-6">
        <a href="#top" className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold tracking-[0.3em] text-foreground">AURORAVIEW</span>
          <span className="hidden sm:inline label-mono">/ Real-Time Intelligence Layer</span>
        </a>
        <nav className="hidden items-center gap-8 md:flex">
          <a href="#problem" className="label-mono hover:text-foreground transition-colors">Problem</a>
          <a href="#solution" className="label-mono hover:text-foreground transition-colors">Solution</a>
          <a href="#policy" className="label-mono hover:text-foreground transition-colors">Policy</a>
          <a href="#product" className="label-mono hover:text-foreground transition-colors">Product</a>
          <a href="#access" className="label-mono hover:text-foreground transition-colors">Access</a>
        </nav>
        <a href="#access" className="inline-flex items-center gap-2 border border-foreground/80 px-4 py-2 text-xs font-medium tracking-widest uppercase text-foreground hover:bg-foreground hover:text-background transition-colors">
          Request Access
        </a>
      </div>
    </header>
  );
}
