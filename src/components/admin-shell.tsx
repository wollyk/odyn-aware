// Shared admin shell: auth gate hook + header bar.
//
// Pre-refactor: every admin page (index.tsx, live.tsx) duplicated ~80
// lines of auth-check / loading-state / header-and-nav logic. Adding the
// faces page would be a third copy, and the live-detection panel will
// soon want its own page-level extras too. So we extract:
//
//   useAdminAuth()    — auth state machine (loading -> ok | denied),
//                       handles 401 redirect to /admin/login + logout.
//   <AdminHeader>     — header bar with section nav + signout.
//   <AuthLoadingScreen> / <AuthDeniedScreen> — the two non-OK screens.
//
// Each page still owns its own max-width / layout / data; the shell only
// owns auth + chrome.

import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

export type AdminUser = { email: string; role: string };
export type AdminAuthState = "loading" | "ok" | "denied";

export type AdminTab = "submissions" | "live" | "faces";

const TABS: { id: AdminTab; label: string; href: string }[] = [
  { id: "submissions", label: "Submissions", href: "/admin" },
  { id: "live", label: "Live View", href: "/admin/live" },
  { id: "faces", label: "Faces", href: "/admin/faces" },
];

/**
 * Auth state machine for any admin page. Side effects:
 *   - calls /api/auth/me on mount
 *   - redirects to /admin/login on 401
 *   - returns logout() that POSTs /api/auth/logout and redirects.
 *
 * Returns { state, me, logout, error }. Pages should:
 *   if (state === "loading") return <AuthLoadingScreen />;
 *   if (state === "denied")  return <AuthDeniedScreen error={error} />;
 *   // else render the page.
 */
export function useAdminAuth() {
  const navigate = useNavigate();
  const [state, setState] = useState<AdminAuthState>("loading");
  const [me, setMe] = useState<AdminUser | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { credentials: "include" })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 401) {
          navigate({ to: "/admin/login" });
          return;
        }
        if (!r.ok) throw new Error(`auth check failed (${r.status})`);
        const data = await r.json();
        if (data.user?.role !== "admin") {
          setState("denied");
          return;
        }
        setMe(data.user);
        setState("ok");
      })
      .catch((err) => {
        if (cancelled) return;
        setState("denied");
        setError(err instanceof Error ? err.message : "auth check failed");
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    navigate({ to: "/admin/login" });
  }, [navigate]);

  return { state, me, logout, error };
}

export function AuthLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
        Verifying session…
      </span>
    </div>
  );
}

export function AuthDeniedScreen({ error }: { error?: string | null }) {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="max-w-md text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-alert">Access denied</p>
        {error && <p className="mt-3 text-sm text-muted-foreground">{error}</p>}
        <button
          type="button"
          onClick={() => navigate({ to: "/admin/login" })}
          className="mt-6 inline-flex items-center gap-2 border border-foreground/80 px-4 py-2 text-xs font-medium tracking-widest uppercase text-foreground hover:bg-foreground hover:text-background transition-colors"
        >
          Sign in
        </button>
      </div>
    </div>
  );
}

/**
 * Header bar shared by every admin page. The `active` prop drives the
 * underline on the matching tab.
 *
 * The container uses `max-w-7xl` by default; pass `maxWidthClass` for
 * the live view (which uses a wider canvas).
 */
export function AdminHeader({
  active,
  me,
  logout,
  maxWidthClass = "max-w-7xl",
}: {
  active: AdminTab;
  me: AdminUser | null;
  logout: () => void | Promise<void>;
  maxWidthClass?: string;
}) {
  return (
    <header className="border-b border-border/60 bg-background/70 backdrop-blur-md">
      <div className={`mx-auto flex h-14 ${maxWidthClass} items-center justify-between px-6`}>
        <div className="flex items-center gap-3">
          <a href="/" className="font-mono text-sm font-semibold tracking-[0.3em] text-foreground">
            AURORAVIEW
          </a>
          <span className="label-mono">/ Admin</span>
        </div>
        <nav className="flex items-center gap-6">
          {TABS.map((t) =>
            t.id === active ? (
              <span
                key={t.id}
                className="font-mono text-[10px] uppercase tracking-widest text-foreground border-b border-foreground pb-0.5"
              >
                {t.label}
              </span>
            ) : (
              <a
                key={t.id}
                href={t.href}
                className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
              >
                {t.label}
              </a>
            ),
          )}
        </nav>
        <div className="flex items-center gap-4">
          <span className="hidden sm:inline font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            {me?.email}
          </span>
          <button
            onClick={logout}
            className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
          >
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
