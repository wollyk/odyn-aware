// Quota / cost-discipline ledger.
//
// Two independent budgets per the design feedback:
//   1. Per-tenant token budget (controls business cost).
//   2. Per-camera vision-call budget (prevents one noisy camera from
//      consuming everything).
//
// Storage: in-memory rolling window for fast `allow()` checks (sub-ms),
// write-through to SQLite `quota_ledger` for durability across restarts.
// On hydrate, we re-load the last 24h of consumption from the DB so the
// rolling window is accurate after a restart.
//
// Usage:
//   const gate = quotaGate({ db });        // db is optional — without it, in-memory only
//   if (!gate.allow({ tenant, camera, kind: "t3-vision" }).allowed) {
//     return 429 too_many_requests;
//   }
//   gate.record({ tenant, camera, kind: "t3-vision", dollars: 0.0001 });
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

  // Hydrate from the DB if provided. We pull the last 24h since that covers
  // every rolling window we care about (minute / hour / day).
  if (db) {
    try {
      const since_ms = now() - 86_400_000;
      // Lazy import to keep this module dep-free when used without a db.
      const rows = db
        .prepare(`SELECT tenant_id, camera, kind, scope, ts FROM quota_ledger WHERE ts >= ? ORDER BY ts ASC`)
        .all(since_ms);
      for (const r of rows) {
        const key = r.scope === "camera"
          ? `cam:${r.tenant_id}:${r.camera}:${r.kind}-cam`
          : `tenant:${r.tenant_id}:${r.kind}`;
        const arr = ledger.get(key) ?? [];
        arr.push(r.ts);
        ledger.set(key, arr);
      }
      if (rows.length > 0) {
        console.log(`[quota] hydrated ${rows.length} rows from quota_ledger (last 24h)`);
      }
    } catch (err) {
      console.warn("[quota] hydrate failed:", err?.message);
    }
  }

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
    record({ tenant, camera, kind, dollars = null, cost = 1 }) {
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
      // Write-through to SQLite. Failures are logged but never rejected
      // upstream — the in-memory ledger is the source of truth for the
      // current process, persistence is best-effort durability.
      if (db) {
        try {
          const stmt = db.prepare(
            `INSERT INTO quota_ledger (tenant_id, camera, kind, scope, cost, dollars, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          );
          stmt.run(tenant, null, kind, "tenant", cost, dollars, t);
          if (camera) stmt.run(tenant, camera, kind, "camera", cost, dollars, t);
        } catch (err) {
          console.warn("[quota] persist failed:", err?.message);
        }
      }
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
