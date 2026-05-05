import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/admin/login")({
  component: AdminLogin,
});

function AdminLogin() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        if (data.user?.role === "admin") navigate({ to: "/admin" });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatus("submitting");
    setErrorMsg(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.status === 401) {
        setStatus("error");
        setErrorMsg("Invalid email or password.");
        return;
      }
      if (!res.ok) {
        setStatus("error");
        setErrorMsg(`Login failed (${res.status}).`);
        return;
      }
      const data = await res.json();
      if (data.user?.role !== "admin") {
        setStatus("error");
        setErrorMsg("This account is not an administrator.");
        return;
      }
      navigate({ to: "/admin" });
    } catch (err) {
      setStatus("error");
      setErrorMsg(err instanceof Error ? err.message : "Network error");
    }
  }

  const inputCls =
    "w-full border border-border bg-background px-3 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none transition-colors";
  const labelCls = "label-mono mb-2 block";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/60 bg-background/70 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-6">
          <a href="/" className="flex items-center gap-2">
            <span className="font-mono text-sm font-semibold tracking-[0.3em] text-foreground">AURORAVIEW</span>
            <span className="hidden sm:inline label-mono">/ Admin</span>
          </a>
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Authorized personnel only
          </span>
        </div>
      </header>

      <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-md items-center px-6 py-16">
        <form onSubmit={onSubmit} className="w-full space-y-6" noValidate>
          <div className="mb-2 flex items-center gap-3">
            <span className="font-mono text-xs text-alert">[AV]</span>
            <span className="label-mono">Sign In</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <h1 className="text-3xl font-light leading-tight tracking-tight">
            Operator <span className="italic font-serif">access.</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in to view deployment requests and system activity.
          </p>

          <div>
            <label htmlFor="email" className={labelCls}>
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              className={inputCls}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="password" className={labelCls}>
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className={inputCls}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {status === "error" && errorMsg && (
            <p className="font-mono text-xs tracking-wider text-alert">● {errorMsg}</p>
          )}

          <button
            type="submit"
            disabled={status === "submitting"}
            className="inline-flex w-full items-center justify-center gap-3 bg-foreground px-6 py-3 text-xs font-medium uppercase tracking-[0.2em] text-background hover:bg-foreground/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {status === "submitting" ? "Signing in…" : "Sign In"}
            <span aria-hidden>→</span>
          </button>
        </form>
      </main>
    </div>
  );
}
