// Event-bus → SQLite event log adapter.
//
// One subscriber per topic (DETECTION, CLASSIFIED, DESCRIBED, ALERT). Each
// subscriber writes a row to the `events` table tagged with its stage. This
// module is the ONLY harness component that knows about a database — the
// other tiers stay db-agnostic so they can run anywhere.
//
// Persistence policy: append-only. We never UPDATE earlier rows; the full
// history of one event is reconstructed by grouping rows on `event_id`.
//
// Backpressure: the underlying eventbus is synchronous, so writes happen
// inline. SQLite WAL mode + a prepared statement keep this fast (<1ms per
// row on the VPS). If we ever need async write-behind, swap the helper
// for a small ring buffer + flush timer — the subscribe contract stays the
// same.

import { subscribe } from "./eventbus.mjs";
import { appendEvent, pruneEvents } from "../db.mjs";
import { TOPIC, STAGE } from "./types.mjs";
import { increment } from "./telemetry.mjs";

// Stage label for each topic — wire format the rest of the app reads.
const TOPIC_TO_STAGE = {
  [TOPIC.DETECTION]: "detection",
  [TOPIC.CLASSIFIED]: "classified",
  [TOPIC.DESCRIBED]: "described",
  [TOPIC.ALERT]: "alert",
};

let subs = [];
let pruneTimer = null;
let initialPruneTimer = null;

/**
 * Start the event log writer.
 *
 * @param {{ db: object, retentionDays?: number, pruneIntervalMs?: number }} opts
 *   retentionDays defaults to 30 — events older than that are pruned.
 *   pruneIntervalMs defaults to 60 minutes.
 */
export function start({ db, retentionDays = 30, pruneIntervalMs = 60 * 60 * 1000 } = {}) {
  if (!db) throw new Error("eventlog.start requires { db }");
  if (subs.length > 0) return; // already running

  for (const [topic, stage] of Object.entries(TOPIC_TO_STAGE)) {
    const off = subscribe(topic, (ev) => {
      try {
        appendEvent(db, {
          event_id: ev.id,
          stage,
          tenant_id: ev.tenant_id ?? "default",
          camera: ev.cam ?? "",
          origin: ev.origin ?? null,
          severity: ev.severity ?? null,
          payload: ev,
        });
        increment(`eventlog.append.${stage}`);
      } catch (err) {
        increment("eventlog.write_errors");
        console.error(`[eventlog] write failed (stage=${stage}):`, err?.message);
      }
    });
    subs.push(off);
  }

  // Background pruner. Run once shortly after boot, then on the interval.
  const runPrune = () => {
    try {
      const cutoff = Date.now() - retentionDays * 86_400_000;
      const r = pruneEvents(db, cutoff);
      if (r.changes > 0) {
        increment("eventlog.pruned", r.changes);
        console.log(`[eventlog] pruned ${r.changes} rows older than ${retentionDays}d`);
      }
    } catch (err) {
      console.error("[eventlog] prune failed:", err?.message);
    }
  };
  // Track both timers so stop() can cancel them and the process can exit
  // promptly during tests / clean shutdown.
  initialPruneTimer = setTimeout(runPrune, 30_000);
  pruneTimer = setInterval(runPrune, pruneIntervalMs);
}

export function stop() {
  for (const off of subs) {
    try { off(); } catch { /* ignore */ }
  }
  subs = [];
  if (initialPruneTimer) {
    clearTimeout(initialPruneTimer);
    initialPruneTimer = null;
  }
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
}

export const EVENTLOG = { TOPIC_TO_STAGE, STAGE };
