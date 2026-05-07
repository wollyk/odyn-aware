// Quota / cost-discipline ledger.
//
// Two independent budgets per the design feedback:
//   1. Per-tenant token budget (controls business cost).
//   2. Per-camera vision-call budget (prevents one noisy camera from
//      consuming everything).
//
// Storage: in-memory rolling window (1 minute, 1 hour, 1 day buckets).
// Persisted to SQLite (kv_cache or a dedicated table later) so restarts
// don't reset the budget.
//
// Usage:
//   const gate = quotaGate({ db });
//   if (!gate.allow({ tenant, camera, kind: "t3-vision", cost: 1 })) {
//     return 429 too_many_requests;
//   }
//   gate.record({ tenant, camera, kind: "t3-vision", cost: 1, dollars: 0.0001 });
//
// Independent test surface: pass an injected clock for deterministic windowing.

const DEFAULT_LIMITS = Object.freeze({
  // Per-tenant
  "t3-chat":      { perMinute: 30, perHour: 300, perDay: 2000 },
  "t3-vision":    { perMinute: 12, perHour: 200, perDay: 1500 },
  "t2-vision":    { perMinute: 60, perHour: 2000, perDay: 30000 }, // local, generous
  // Per-camera (applied additively with per-tenant)
  "t2-vision-cam": { perMinute: 6, perHour: 240, perDay: 4800 },
  "t3-vision-cam": { perMinute: 2, perHour: 30, perDay: 200 },
});

/**
 * @param {{ db?: object, now?: () => number, limits?: object }} opts
 */
export function quotaGate({ db = null, now = () => Date.now(), limits = DEFAULT_LIMITS } = {}) {
  // Map<key, number[]> — sorted ascending list of timestamp ms.
  const ledger = new Map();

  function pruneAndCount(key, windowMs) {
    const arr = ledger.get(key);
    if (!arr || arr.length === 0) return 0;
    const cutoff = now() - windowMs;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    if (i > 0) arr.splice(0, i);
    return arr.length;
  }

  function check(key, lim) {
    if (pruneAndCount(key, 60_000) >= lim.perMinute) return "rate_minute";
    if (pruneAndCount(key, 3_600_000) >= lim.perHour) return "rate_hour";
    if (pruneAndCount(key, 86_400_000) >= lim.perDay) return "rate_day";
    return null;
  }

  return {
    /**
     * Returns { allowed: boolean, reason?: string }. Idempotent — no record
     * is made on either path. Call record() to consume budget.
     */
    allow({ tenant, camera, kind }) {
      const tenantLim = limits[kind];
      if (tenantLim) {
        const reason = check(`tenant:${tenant}:${kind}`, tenantLim);
        if (reason) return { allowed: false, reason: `tenant_${reason}` };
      }
      if (camera) {
        const camKey = `${kind}-cam`;
        const camLim = limits[camKey];
        if (camLim) {
          const reason = check(`cam:${tenant}:${camera}:${camKey}`, camLim);
          if (reason) return { allowed: false, reason: `camera_${reason}` };
        }
      }
      return { allowed: true };
    },

    /**
     * Record a consumption against tenant + camera. Should be called only
     * after the upstream call succeeded (or unconditionally if you want a
     * "tried" budget rather than a "succeeded" budget — pick one and stick).
     */
    record({ tenant, camera, kind /* dollars */ }) {
      const t = now();
      const tk = `tenant:${tenant}:${kind}`;
      const arr1 = ledger.get(tk) ?? [];
      arr1.push(t);
      ledger.set(tk, arr1);
      if (camera) {
        const ck = `cam:${tenant}:${camera}:${kind}-cam`;
        const arr2 = ledger.get(ck) ?? [];
        arr2.push(t);
        ledger.set(ck, arr2);
      }
      // TODO(phase-1.5): persist to SQLite quota_ledger table for cross-restart durability.
      void db;
    },

    /** Diagnostic snapshot for /api/agent/status. */
    snapshot() {
      const out = {};
      for (const [key, arr] of ledger.entries()) {
        out[key] = {
          minute: pruneAndCount(key, 60_000),
          hour: pruneAndCount(key, 3_600_000),
          day: pruneAndCount(key, 86_400_000),
        };
      }
      return out;
    },

    _resetForTests() {
      ledger.clear();
    },
  };
}

export const QUOTA_LIMITS = DEFAULT_LIMITS;
