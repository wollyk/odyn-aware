// Listens for the SESSION_EXPIRED_EVENT dispatched by `apiFetch` and
// surfaces a top-of-page banner with a clear "Sign in" CTA.
//
// Why a banner instead of an immediate redirect:
//   - The operator may be mid-typing in the agent chat box; yanking
//     them to /admin/login destroys their input.
//   - WebSocket-driven panels (live MSE, tracker) keep working even
//     when HTTP auth has expired, so the rest of the surface is still
//     useful while the user decides to re-auth.
//
// Behavior:
//   - Hidden until the first `auroraview:session-expired` event.
//   - Once shown, stays visible until the user clicks "Sign in" or
//     reloads the page. We don't bother auto-hiding on /api/auth/me
//     success because the banner is dismissed by navigation anyway.

import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SESSION_EXPIRED_EVENT } from "@/lib/apiFetch";

export function SessionExpiredBanner() {
  const navigate = useNavigate();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onExpired = () => setVisible(true);
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  if (!visible) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid="session-expired-banner"
      className="sticky top-0 z-50 border-b border-amber-500/50 bg-amber-950/95 backdrop-blur-sm"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6 py-2">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-widest text-amber-200">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
          Session expired · Live data is paused until you sign in again
        </div>
        <button
          type="button"
          onClick={() => navigate({ to: "/admin/login" })}
          className="border border-amber-400/70 bg-amber-400/10 px-3 py-1 font-mono text-[10px] uppercase tracking-widest text-amber-100 hover:bg-amber-400/20"
        >
          Sign in →
        </button>
      </div>
    </div>
  );
}
