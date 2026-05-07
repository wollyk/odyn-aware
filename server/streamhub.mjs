// Per-camera stream multiplexer.
//
// GOAL: maintain ONE upstream WebSocket per camera that fans out to N browser
// clients AND the harness vision pipeline. This means:
//   - One reconnect job per camera, not per browser tab.
//   - Persistent buffering of init segments, so a new client joining mid-flight
//     gets the codec immediately and doesn't have to wait for the next IDR.
//   - Frame-level fanout to the harness so vision calls and the user share
//     the same underlying stream — no duplicate Frigate connections.
//
// SCOPE OF v0 (this file):
//   The integration point exists, but the implementation is a pass-through:
//   each browser request still opens its own upstream. This lets us deploy
//   the API change once and flip to real multiplexing in a focused PR
//   without touching api.mjs again.
//
// PHASE PLAN (when reliability is good enough that this becomes the
// bottleneck):
//   v1 — Real multiplexer: subscribe(camera) returns a Readable stream of
//        WS messages. Single upstream socket per camera. Init segment
//        replayed to each new subscriber. Auto-reconnect with exponential
//        backoff, capped at 30s.
//   v2 — Convergence with vision pipeline: tier0 calls subscribe() too, so
//        T2's "describe this frame" reads from the same shared source as
//        the browser. Eliminates the second Frigate connection per camera.
//   v3 — Last-frame cache: streamhub remembers the most recent IDR so it
//        can serve a "thumbnail" without waiting for the next keyframe.
//
// Test surface (when implemented): tmp-test/test-streamhub.mjs simulates
// upstream flap by stubbing the WS factory; asserts that 50 subscribers
// see exactly 0 reconnects across upstream restarts.

import WebSocket from "ws";

const FRIGATE_BASE = process.env.FRIGATE_BASE ?? "https://127.0.0.1:3000";

/**
 * Open an upstream MSE WebSocket for a single camera. v0: returns a fresh
 * per-call WebSocket — same behavior the API has today.
 *
 * Future signature is unchanged: callers will get back something with the
 * `WebSocket` interface (`on`, `send`, `close`, `binaryType`). At v1 the
 * returned object will be a thin per-subscriber adapter over a shared
 * upstream.
 *
 * @param {string} camera
 * @param {string} authToken Frigate JWT
 * @returns {WebSocket}
 */
export function subscribe(camera, authToken) {
  const base = new URL(FRIGATE_BASE);
  const wsScheme = base.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsScheme}//${base.host}/live/mse/api/ws?src=${encodeURIComponent(camera)}`;
  return new WebSocket(url, {
    headers: { Cookie: `frigate_token=${authToken}` },
    rejectUnauthorized: false,
    perMessageDeflate: false,
    handshakeTimeout: 8000,
    maxPayload: 16 * 1024 * 1024,
  });
}

/**
 * Diagnostic snapshot — returns the multiplexer's current state. v0:
 * always returns "passthrough mode" because there's no shared state yet.
 *
 * @returns {{ mode: "passthrough"|"multiplexed", cameras: object[] }}
 */
export function inspect() {
  return { mode: "passthrough", cameras: [] };
}

export const STREAMHUB = { FRIGATE_BASE };
