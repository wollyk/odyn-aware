// Tiny fetch mocker — avoids pulling in MSW for this iteration.
//
// Usage:
//   const mock = installFetchMock();
//   mock.on("GET", /\/api\/agent\/timeline\/.+\/matches/, () =>
//     jsonResponse({ matches: [] }),
//   );
//   // ... assertions ...
//   mock.restore();

import { vi } from "vitest";

type Handler = (req: Request) => Response | Promise<Response>;

export type FetchMock = {
  on: (method: string, pattern: RegExp | string, handler: Handler) => void;
  restore: () => void;
  calls: Array<{ url: string; method: string }>;
};

export function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

export function installFetchMock(): FetchMock {
  const routes: Array<{ method: string; pattern: RegExp | string; handler: Handler }> = [];
  const calls: Array<{ url: string; method: string }> = [];
  const original = globalThis.fetch;

  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // jsdom's Request requires absolute URLs; we just want method+url
    // string matching, so we extract those directly without constructing
    // a Request.
    const url =
      input instanceof URL
        ? input.toString()
        : input instanceof Request
          ? input.url
          : String(input);
    const method = (
      input instanceof Request ? input.method : init?.method ?? "GET"
    ).toUpperCase();
    calls.push({ url, method });
    for (const r of routes) {
      const matches = typeof r.pattern === "string"
        ? url.includes(r.pattern)
        : r.pattern.test(url);
      if (matches && r.method.toUpperCase() === method) {
        // Pass a lightweight pseudo-request that's enough for handlers.
        const pseudoReq = {
          url,
          method,
          headers: new Headers(init?.headers ?? {}),
        } as unknown as Request;
        return r.handler(pseudoReq);
      }
    }
    return new Response(
      JSON.stringify({ error: "unhandled", url, method }),
      { status: 599, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  return {
    on(method, pattern, handler) {
      routes.push({ method, pattern, handler });
    },
    restore() {
      globalThis.fetch = original;
    },
    calls,
  };
}
