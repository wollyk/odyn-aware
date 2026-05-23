// Search a completed eval run for faces similar to a probe photo (passport / screenshot).
// Uses the same InsightFace embedder + cosine path as /admin/faces search, but the
// gallery is every face vector stored in that run's JSONL (vec_b64 per face).

import { useEffect, useState } from "react";
import { compressProbeImage } from "@/lib/probe-image";

export type EvalSearchHit = {
  frame: number;
  ts_s: number;
  face_index: number;
  similarity: number;
  quality?: number;
  bbox?: [number, number, number, number];
};

export function EvalFaceSearch({
  runId,
  runLabel,
  onSeek,
  onProbeChange,
}: {
  runId: string;
  runLabel: string;
  onSeek: (hit: EvalSearchHit) => void;
  onProbeChange?: (dataUrl: string | null) => void;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(0.45);
  const [hits, setHits] = useState<EvalSearchHit[]>([]);
  const [galleryFaces, setGalleryFaces] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setImageBase64(null);
    setHits([]);
    setGalleryFaces(null);
    setErr(null);
    setMsg(null);
    onProbeChange?.(null);
  }, [runId, onProbeChange]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const raw = await readAsDataUrl(f);
    const dataUrl = await compressProbeImage(raw);
    setPreview(dataUrl);
    setImageBase64(dataUrl);
    onProbeChange?.(dataUrl);
    setHits([]);
    setErr(null);
    setMsg(null);
  }

  async function search() {
    if (!imageBase64) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const res = await fetch(`/api/agent/evals/${encodeURIComponent(runId)}/search`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: imageBase64, threshold, limit: 40 }),
      });
      const ct = res.headers.get("content-type") ?? "";
      const text = await res.text();
      if (!ct.includes("application/json")) {
        throw new Error(
          res.status === 413
            ? "Probe image too large for the server proxy (try a smaller crop)."
            : `Server returned non-JSON (${res.status}). ${text.slice(0, 120)}`,
        );
      }
      const data = JSON.parse(text) as Record<string, unknown>;
      if (!res.ok) {
        const hint = data?.detail?.hint ?? data?.hint ?? data?.detail ?? data?.error;
        throw new Error(typeof hint === "string" ? hint : JSON.stringify(hint ?? data));
      }
      setHits(data.hits ?? []);
      setGalleryFaces(data.gallery_faces ?? null);
      setMsg(
        data.count > 0
          ? `${data.count} match(es) above ${(data.threshold * 100).toFixed(0)}% in ${runLabel}`
          : `No matches above ${(data.threshold * 100).toFixed(0)}%. Try lowering the threshold.`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "search failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 border border-sky-500/25 bg-sky-500/5 p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-widest text-sky-300/90">
        [02c] · identity search · this clip
      </h3>
      <p className="mt-2 text-xs text-muted-foreground max-w-2xl">
        Upload the passport or face screenshot (your probe). We embed it with the same
        InsightFace model used during the eval, then cosine-match against every face
        vector stored in this run. Hits are scored against <strong>your probe</strong> —
        not enrolled names (use <span className="font-mono">/admin/faces</span> for that).
        Click <span className="font-mono">Jump →</span> to seek the player and highlight
        the matching face box in pink. Your probe appears inset on the video for comparison.
      </p>
      <p className="mt-1 font-mono text-[10px] text-foreground/50">
        Runs completed before vector indexing was enabled must be re-run once.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <input type="file" accept="image/*" onChange={onFile} className="text-sm" />
        <label className="flex items-center gap-2 font-mono text-[10px] text-foreground/70">
          threshold
          <input
            type="number"
            min={0.3}
            max={0.95}
            step={0.01}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="w-16 border border-border bg-background px-1 py-0.5"
          />
        </label>
        <button
          type="button"
          onClick={search}
          disabled={!imageBase64 || busy}
          className="border border-sky-500/50 bg-sky-500/15 px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-sky-200 disabled:opacity-40"
        >
          {busy ? "Searching…" : "Search this video"}
        </button>
      </div>

      {preview && (
        <p className="mt-3 font-mono text-[10px] text-foreground/55">
          Probe loaded — shown bottom-left on the player above.
        </p>
      )}
      {galleryFaces != null && (
        <p className="mt-2 font-mono text-[10px] text-foreground/55">
          Indexed {galleryFaces} face vectors in this run
        </p>
      )}
      {err && <p className="mt-2 text-xs text-alert">{err}</p>}
      {msg && !err && <p className="mt-2 text-xs text-foreground/75">{msg}</p>}

      {hits.length > 0 && (
        <div className="mt-4 max-h-48 overflow-y-auto border border-border">
          <table className="w-full border-collapse font-mono text-[10px]">
            <thead>
              <tr className="border-b border-border bg-card/40 text-left text-foreground/55 uppercase tracking-widest">
                <th className="px-2 py-2">Time</th>
                <th className="px-2 py-2">Frame</th>
                <th className="px-2 py-2">Face</th>
                <th className="px-2 py-2">Sim</th>
                <th className="px-2 py-2">Quality</th>
                <th className="px-2 py-2" />
              </tr>
            </thead>
            <tbody>
              {hits.map((h, i) => (
                <tr
                  key={`${h.frame}-${h.face_index}-${i}`}
                  className="border-b border-border/40 hover:bg-card/50"
                >
                  <td className="px-2 py-2 text-foreground/85">{h.ts_s.toFixed(2)}s</td>
                  <td className="px-2 py-2 text-foreground/85">{h.frame}</td>
                  <td className="px-2 py-2 text-foreground/70">#{h.face_index + 1}</td>
                  <td className="px-2 py-2 text-sky-300">
                    {(h.similarity * 100).toFixed(0)}%
                  </td>
                  <td className="px-2 py-2 text-foreground/60">
                    {h.quality != null ? h.quality.toFixed(2) : "—"}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onSeek(h)}
                      className="uppercase tracking-widest text-emerald-400 hover:text-emerald-300"
                    >
                      Jump →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result ?? ""));
    r.onerror = () => reject(new Error("file read failed"));
    r.readAsDataURL(file);
  });
}
