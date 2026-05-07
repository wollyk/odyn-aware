// Three-tier memory subsystem.
//
//   WORKING MEMORY — in-RAM, per chat session:
//     - last 20 messages verbatim
//     - rolling token estimate
//     - active camera context
//
//   DAILY SUMMARY — per camera per day, regenerated on event activity:
//     - one paragraph "what happened today" written by T2 (local model)
//     - count by category (PERSON, VEHICLE, UNKNOWN_FACE, ...)
//     - persisted to SQLite (table: daily_summaries — not yet created)
//     - per design feedback: regenerate ON EVENT, never on a cron timer
//
//   ARCHIVE — append-only event log, queried only on demand:
//     - per-event JSON in events table (also not yet created)
//     - operator chat transcripts in chat_transcripts
//     - never loaded into context unless a tool requests it
//
// Phase plan:
//   - v0 (now):  Working memory only, in-RAM. SessionId → ring buffer.
//                Daily/Archive surfaces stubbed; future migration.
//   - v1:        Persist daily summaries to a new table.
//   - v2:        Add archive query tool surface for the chat agent.

const WORKING_LIMIT = 20;

class WorkingMemory {
  constructor() {
    /** @type {Map<string, Array<{ role: string, content: string, ts: number }>>} */
    this.sessions = new Map();
  }

  append(sessionId, message) {
    if (!sessionId) return;
    let arr = this.sessions.get(sessionId);
    if (!arr) {
      arr = [];
      this.sessions.set(sessionId, arr);
    }
    arr.push({ ...message, ts: Date.now() });
    if (arr.length > WORKING_LIMIT) arr.splice(0, arr.length - WORKING_LIMIT);
  }

  recent(sessionId, limit = WORKING_LIMIT) {
    const arr = this.sessions.get(sessionId) ?? [];
    return arr.slice(-limit);
  }

  reset(sessionId) {
    this.sessions.delete(sessionId);
  }

  inspect() {
    return [...this.sessions.entries()].map(([id, arr]) => ({ id, len: arr.length }));
  }
}

export const workingMemory = new WorkingMemory();

// ---- Daily summary surface (stubs until SQLite table is added) -------------

/**
 * Get the most recent daily summary for a camera. Returns null until the
 * persistence layer is wired up.
 *
 * @param {{ db: object, camera: string, date?: string }} _opts
 * @returns {Promise<{ summary: string, counts: object, generated_at: string } | null>}
 */
export async function getDailySummary(_opts) {
  return null; // v0
}

/**
 * Mark that this camera saw activity worth summarizing. Debounces — the
 * actual summary regeneration runs at most once per `debounceMs` per camera.
 *
 * @param {{ camera: string, debounceMs?: number, run: () => Promise<void> }} opts
 */
const regenTimers = new Map(); // camera → setTimeout handle

export function noteCameraActivity({ camera, debounceMs = 60_000, run }) {
  if (!camera) return;
  const existing = regenTimers.get(camera);
  if (existing) return; // already scheduled
  const handle = setTimeout(async () => {
    regenTimers.delete(camera);
    try {
      await run();
    } catch (err) {
      console.error(`[memory] summary regen for ${camera} failed:`, err?.message);
    }
  }, debounceMs);
  regenTimers.set(camera, handle);
}

/** Cancel all pending regeneration timers (test-only). */
export function _resetForTests() {
  for (const t of regenTimers.values()) clearTimeout(t);
  regenTimers.clear();
}
