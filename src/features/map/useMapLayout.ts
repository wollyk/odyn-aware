// localStorage-backed layout store for the V1 map prototype.
//
// V1 keeps everything client-side so we can iterate on UX without
// touching schema. When V1.5 ships /api/agent/map/*, this hook flips
// to a fetch-and-cache pattern; the public surface stays the same.
//
// Storage shape: a single key `auroraview:mapLayout:v1` holds the
// JSON-serialized MapLayout. Image is embedded as a data URL — fine
// for the 1-2 MB images we're dealing with; localStorage caps at 5-10
// MB per origin so we warn (not block) above 4 MB.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  defaultPlacement,
  emptyLayout,
  type CameraPlacement,
  type MapLayout,
} from "./types";

const STORAGE_KEY = "auroraview:mapLayout:v1";
const SOFT_SIZE_WARN_BYTES = 4 * 1024 * 1024;

function loadFromStorage(): MapLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyLayout();
    const parsed = JSON.parse(raw) as MapLayout;
    // Be resilient to schema drift between localStorage saves.
    return {
      ...emptyLayout(),
      ...parsed,
      placements: Array.isArray(parsed.placements) ? parsed.placements : [],
    };
  } catch {
    return emptyLayout();
  }
}

function saveToStorage(layout: MapLayout) {
  try {
    const serialized = JSON.stringify(layout);
    if (serialized.length > SOFT_SIZE_WARN_BYTES) {
      console.warn(
        `[map] layout size ${(serialized.length / 1024 / 1024).toFixed(2)} MB ` +
          "is approaching the localStorage cap. Consider a smaller image " +
          "until V1.5 moves storage server-side.",
      );
    }
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch (err) {
    console.error("[map] localStorage save failed:", err);
  }
}

export type UseMapLayoutResult = {
  layout: MapLayout;
  /** Replace the background image. Caller passes a File; the hook
   *  reads it as a data URL and stamps the natural width/height once
   *  it loads (so we don't have to thread an Image through every
   *  consumer). */
  setBackground(file: File | null): Promise<void>;
  /** Insert/upsert a placement. Identified by `name`. */
  upsertPlacement(p: CameraPlacement): void;
  /** Remove a placement by camera name. */
  removePlacement(name: string): void;
  /** Reset to a clean empty layout. Confirms via the supplied confirm
   *  function so the hook doesn't hard-couple to window.confirm. */
  resetLayout(confirm?: () => boolean): void;
  /** Convenience: ensure every cam in `cameraNames` has at least a
   *  placement (default at 40,40). Idempotent. */
  ensurePlacementsForCameras(cameraNames: string[]): void;
  /** Phase-13B: patch top-level layout fields (e.g. `scale_m_per_px`).
   *  Placements are untouched unless explicitly included in the patch. */
  updateLayout(patch: Partial<MapLayout>): void;
};

export function useMapLayout(): UseMapLayoutResult {
  const [layout, setLayout] = useState<MapLayout>(() => loadFromStorage());
  // Debounce save — Konva drag emits ~60Hz mousemove; we don't want
  // to hammer localStorage. 250ms is invisible and 240x cheaper.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writeWithDebounce = useCallback((next: MapLayout) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveToStorage(next);
      saveTimer.current = null;
    }, 250);
  }, []);

  // Keep the URL hash + localStorage in sync if anything mutates
  // outside this hook (e.g. another tab). Only listens — never writes
  // from the storage event to avoid loops.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setLayout(loadFromStorage());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Flush pending writes on unmount so the last drag isn't lost.
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveToStorage(layout);
      }
    },
    [layout],
  );

  const mutate = useCallback(
    (fn: (l: MapLayout) => MapLayout) => {
      setLayout((prev) => {
        const next = {
          ...fn(prev),
          version: prev.version + 1,
          updated_at: Date.now(),
        };
        writeWithDebounce(next);
        return next;
      });
    },
    [writeWithDebounce],
  );

  const setBackground = useCallback(
    async (file: File | null) => {
      if (!file) {
        mutate((l) => ({ ...l, image_data: null, image_width: 0, image_height: 0 }));
        return;
      }
      // Read file → data URL.
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      // Decode the image to get natural dimensions before committing.
      const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
        const img = new window.Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => reject(new Error("decode_failed"));
        img.src = dataUrl;
      });
      mutate((l) => ({
        ...l,
        image_data: dataUrl,
        image_width: dims.w,
        image_height: dims.h,
      }));
    },
    [mutate],
  );

  const upsertPlacement = useCallback(
    (p: CameraPlacement) => {
      mutate((l) => {
        const idx = l.placements.findIndex((q) => q.name === p.name);
        const next = [...l.placements];
        if (idx >= 0) next[idx] = p;
        else next.push(p);
        return { ...l, placements: next };
      });
    },
    [mutate],
  );

  const removePlacement = useCallback(
    (name: string) => {
      mutate((l) => ({
        ...l,
        placements: l.placements.filter((p) => p.name !== name),
      }));
    },
    [mutate],
  );

  const resetLayout = useCallback(
    (confirm?: () => boolean) => {
      if (confirm && !confirm()) return;
      const fresh = emptyLayout();
      setLayout(fresh);
      saveToStorage(fresh);
    },
    [],
  );

  const ensurePlacementsForCameras = useCallback(
    (cameraNames: string[]) => {
      mutate((l) => {
        const known = new Set(l.placements.map((p) => p.name));
        const additions: CameraPlacement[] = [];
        cameraNames.forEach((n) => {
          if (!known.has(n)) additions.push(defaultPlacement(n));
        });
        if (additions.length === 0) return l;
        return { ...l, placements: [...l.placements, ...additions] };
      });
    },
    [mutate],
  );

  const updateLayout = useCallback(
    (patch: Partial<MapLayout>) => {
      mutate((l) => ({ ...l, ...patch }));
    },
    [mutate],
  );

  return useMemo(
    () => ({
      layout,
      setBackground,
      upsertPlacement,
      removePlacement,
      resetLayout,
      ensurePlacementsForCameras,
      updateLayout,
    }),
    [
      layout,
      setBackground,
      upsertPlacement,
      removePlacement,
      resetLayout,
      ensurePlacementsForCameras,
      updateLayout,
    ],
  );
}
