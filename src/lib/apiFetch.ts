// Tiny wrapper around `fetch` that:
//
//   - Always includes the admin session cookie (credentials: "include").
//   - On a 401 response, dispatches a window-scoped event
//     `auroraview:session-expired`. Any UI surface that wants to react to
//     a silently-expired session (banner, redirect, etc.) just listens
//     for that event — call sites stay simple and never have to
//     special-case auth themselves.
//
// Why an event instead of a hook/context: every long-lived hook
// (useTimelineMatches, useDetections, useHlsPlayer) needs to surface
// 401s, and routing all of them through React context would force them
// to take the context as a prop or read it via useContext — neither
// composes cleanly with hooks that are also used in tests.
//
// The event is plain `Event` (no detail). Multiple listeners are fine;
// listeners are responsible for debouncing if they redirect (we only
// need ONE banner / ONE navigation, not one per concurrent 401 burst).

export const SESSION_EXPIRED_EVENT = "auroraview:session-expired";

let lastDispatch = 0;

function dispatchSessionExpired() {
  // Coalesce bursts — if the page has 5 polling hooks all 401-ing at
  // the same instant, we don't want to fire the event 5× in a row and
  // make banner/redirect logic handle dedupe.
  const now = Date.now();
  if (now - lastDispatch < 1000) return;
  lastDispatch = now;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

export type ApiFetchInit = RequestInit & {
  /** If true, do NOT dispatch session-expired on 401. Use for the login
   *  endpoint itself, where 401 is just "bad password" and must not
   *  trigger the global re-login flow. */
  silent401?: boolean;
};

/**
 * Drop-in replacement for `fetch` for admin-API endpoints.
 *
 * Always sends credentials. On 401 (unless `silent401`), notifies the
 * rest of the app via a window event so a banner can prompt re-login.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init: ApiFetchInit = {},
): Promise<Response> {
  const { silent401, ...rest } = init;
  const res = await fetch(input, {
    credentials: "include",
    ...rest,
  });
  if (res.status === 401 && !silent401) dispatchSessionExpired();
  return res;
}

/** Test seam — clears the coalesce timer so a unit test can verify
 *  multiple sequential 401s each dispatch the event. */
export function _resetApiFetchForTests() {
  lastDispatch = 0;
}
