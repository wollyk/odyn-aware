// /admin/faces — operator UI for the Phase-4 face DB.
//
// Three vertical sections, mirroring the existing admin pages:
//
//   [01] Enroll a person
//        - name + optional notes
//        - photo source: upload, or capture from a live camera snapshot
//        - submits as image_base64 to POST /api/agent/faces/enroll
//        - surfaces 4xx errors verbatim (no_face_detected, face_too_low_quality)
//
//   [02] Known people
//        - GET /api/agent/faces/people, table with archive (DELETE) action
//        - shows embedding_count + last_embedded_at so the operator can tell
//          whether enrollment actually wrote a vector.
//
//   [03] Recent face matches
//        - GET /api/agent/faces/matches?limit=50
//        - the observability surface for the recognition pipeline
//          (camera, person/unknown, similarity, time)
//
// Decoupled from the live-detection page on purpose: face enrollment is a
// rare, deliberate action; we don't want it sharing state with the always-on
// live-view pipeline.

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AdminHeader,
  AuthDeniedScreen,
  AuthLoadingScreen,
  useAdminAuth,
} from "@/components/admin-shell";
import { useCameras } from "@/features/live/useCameras";

export const Route = createFileRoute("/admin/faces")({
  component: AdminFaces,
});

type Person = {
  id: number;
  name: string;
  notes: string | null;
  status: "active" | "archived";
  embedding_count: number;
  last_embedded_at: string | null;
  created_at: string;
};

type FaceMatch = {
  id: number;
  created_at: string;
  camera: string;
  event_id: string | null;
  person_id: number | null;
  person_name: string | null;
  similarity: number;
  quality: number;
  bbox_json: string | null;
  model: string;
  thumb_path?: string | null;
};

type SearchHit = {
  match_id: number;
  created_at: string;
  camera: string;
  person_name?: string;
  similarity: number;
  has_thumb?: boolean;
};

type EnrollState =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok"; message: string }
  | { kind: "error"; message: string };

function AdminFaces() {
  const navigate = useNavigate();
  const { state: authState, me, logout, error: authError } = useAdminAuth();
  const camList = useCameras();

  const [people, setPeople] = useState<Person[]>([]);
  const [matches, setMatches] = useState<FaceMatch[]>([]);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [matchesLoading, setMatchesLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const refreshPeople = useCallback(async () => {
    setPeopleLoading(true);
    setListError(null);
    try {
      const res = await fetch("/api/agent/faces/people", { credentials: "include" });
      if (res.status === 401) return navigate({ to: "/admin/login" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPeople(data.rows ?? []);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "people load failed");
    } finally {
      setPeopleLoading(false);
    }
  }, [navigate]);

  const refreshMatches = useCallback(async () => {
    setMatchesLoading(true);
    try {
      const res = await fetch("/api/agent/faces/matches?limit=50", { credentials: "include" });
      if (res.status === 401) return navigate({ to: "/admin/login" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setMatches(data.rows ?? []);
    } catch {
      // Swallow: matches are observability, not blocking. Header section
      // continues to work without a recent-matches log.
    } finally {
      setMatchesLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (authState !== "ok") return;
    refreshPeople();
    refreshMatches();
  }, [authState, refreshPeople, refreshMatches]);

  if (authState === "loading") return <AuthLoadingScreen />;
  if (authState === "denied") return <AuthDeniedScreen error={authError} />;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <AdminHeader active="faces" me={me} logout={logout} />

      <main className="mx-auto max-w-7xl px-6 py-10 space-y-12">
        <IdentitySettingsSection />

        <EnrollSection
          cameras={camList.cameras.map((c) => ({ name: c.name, label: c.label }))}
          onEnrolled={() => {
            refreshPeople();
            refreshMatches();
          }}
        />

        <PeopleSection
          rows={people}
          loading={peopleLoading}
          error={listError}
          onRefresh={refreshPeople}
          onArchived={() => {
            refreshPeople();
          }}
        />

        <StrangerClustersSection onPromoted={refreshPeople} />

        <SearchHistorySection />

        <MatchesSection
          rows={matches}
          loading={matchesLoading}
          onRefresh={refreshMatches}
        />

        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Embeddings stored as 512-d vectors. Optional small face crops (admin-only) when thumbnails are enabled in [00].
          Full passport uploads are not kept — only the crop + vector. Archive does not delete match history.
        </p>
      </main>
    </div>
  );
}

type FaceIdentitySettings = {
  store_match_vectors: boolean;
  cluster_unknown_faces: boolean;
  cluster_merge_threshold: number;
  cluster_alert_min_sightings: number;
  link_tracks: boolean;
  link_frigate_clips: boolean;
  search_similarity_threshold: number;
  store_match_thumbnails: boolean;
  thumbnail_max_px: number;
  store_enroll_thumbnails: boolean;
};

// ---- Section: admin identity settings ------------------------------------

function IdentitySettingsSection() {
  const [settings, setSettings] = useState<FaceIdentitySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/agent/faces/settings", { credentials: "include" });
    if (!res.ok) return;
    const data = await res.json();
    setSettings(data.settings);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch("/api/agent/faces/settings", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setSettings(data.settings);
      setMsg("Saved.");
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!settings) {
    return (
      <section>
        <p className="font-mono text-xs text-muted-foreground">Loading identity settings…</p>
      </section>
    );
  }

  return (
    <section>
      <motionSectionLabel num="00">Identity Pipeline · Admin</motionSectionLabel>
      <p className="mb-6 text-sm text-muted-foreground max-w-3xl">
        Controls how live recognition stores searchable data. All features below require admin login;
        nothing runs for public visitors.
      </p>
      <div className="grid gap-4 md:grid-cols-2 border border-border p-6 bg-card/20">
        <ToggleRow
          label="Store face vectors on each match"
          hint="Required for footage search and stranger clustering."
          checked={settings.store_match_vectors}
          onChange={(v) => setSettings({ ...settings, store_match_vectors: v })}
        />
        <ToggleRow
          label="Cluster unknown faces"
          hint="Group recurring strangers automatically."
          checked={settings.cluster_unknown_faces}
          onChange={(v) => setSettings({ ...settings, cluster_unknown_faces: v })}
        />
        <ToggleRow
          label="Link faces to live tracks"
          checked={settings.link_tracks}
          onChange={(v) => setSettings({ ...settings, link_tracks: v })}
        />
        <ToggleRow
          label="Attach Frigate clip ids"
          hint="Extra API call per frame when enabled."
          checked={settings.link_frigate_clips}
          onChange={(v) => setSettings({ ...settings, link_frigate_clips: v })}
        />
        <NumberRow
          label="Cluster merge threshold"
          value={settings.cluster_merge_threshold}
          min={0.3}
          max={0.95}
          step={0.01}
          onChange={(v) => setSettings({ ...settings, cluster_merge_threshold: v })}
        />
        <NumberRow
          label="Alert after N stranger sightings"
          hint="0 = off"
          value={settings.cluster_alert_min_sightings}
          min={0}
          max={50}
          step={1}
          onChange={(v) => setSettings({ ...settings, cluster_alert_min_sightings: v })}
        />
        <NumberRow
          label="Search similarity threshold"
          value={settings.search_similarity_threshold}
          min={0.3}
          max={0.95}
          step={0.01}
          onChange={(v) => setSettings({ ...settings, search_similarity_threshold: v })}
        />
        <ToggleRow
          label="Store face thumbnails on each match"
          hint="Small JPEG crops for search results and match history."
          checked={settings.store_match_thumbnails}
          onChange={(v) => setSettings({ ...settings, store_match_thumbnails: v })}
        />
        <ToggleRow
          label="Store enroll photo thumbnails"
          hint="Passport-style crop kept for known people (admin-only URLs)."
          checked={settings.store_enroll_thumbnails}
          onChange={(v) => setSettings({ ...settings, store_enroll_thumbnails: v })}
        />
        <NumberRow
          label="Thumbnail max edge (px)"
          value={settings.thumbnail_max_px}
          min={64}
          max={512}
          step={32}
          onChange={(v) => setSettings({ ...settings, thumbnail_max_px: v })}
        />
      </div>
      <div className="mt-4 flex items-center gap-4">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="bg-foreground px-6 py-3 text-xs font-medium uppercase tracking-[0.2em] text-background hover:bg-foreground/90 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save settings"}
        </button>
        {msg && <span className="font-mono text-xs text-muted-foreground">{msg}</span>}
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1"
      />
      <span>
        <span className="text-sm text-foreground">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground mt-0.5">{hint}</span>}
      </span>
    </label>
  );
}

function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block">
      <span className="text-sm text-foreground">{label}</span>
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full border border-border bg-background px-3 py-2 text-sm"
      />
    </label>
  );
}

function motionSectionLabel({ num, children }: { num: string; children: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-center gap-3">
      <span className="font-mono text-xs text-alert">[{num}]</span>
      <span className="label-mono">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// ---- Section: recurring strangers ----------------------------------------

type ClusterRow = {
  id: number;
  member_count: number;
  cameras: string[];
  first_seen_at: string;
  last_seen_at: string;
  status: string;
};

function StrangerClustersSection({ onPromoted }: { onPromoted: () => void }) {
  const [rows, setRows] = useState<ClusterRow[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/agent/faces/clusters?status=unreviewed&limit=50", {
        credentials: "include",
      });
      if (!res.ok) return;
      const data = await res.json();
      setRows(data.rows ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function promote(id: number) {
    const name = window.prompt("Name this person:");
    if (!name?.trim()) return;
    const res = await fetch(`/api/agent/faces/clusters/${id}/promote`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (res.ok) {
      refresh();
      onPromoted();
    }
  }

  async function ignore(id: number) {
    await fetch(`/api/agent/faces/clusters/${id}/ignore`, {
      method: "POST",
      credentials: "include",
    });
    refresh();
  }

  return (
    <section>
      <motionSectionLabel num="03">Recurring Strangers</motionSectionLabel>
      <p className="mb-4 text-sm text-muted-foreground">
        Unknown faces grouped by similarity. Promote to add them to Known People.
      </p>
      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-card/40 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="px-3 py-3 text-left">Cluster</th>
              <th className="px-3 py-3 text-left">Sightings</th>
              <th className="px-3 py-3 text-left">Cameras</th>
              <th className="px-3 py-3 text-left">Last seen</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-3 py-10 text-center text-muted-foreground font-mono text-xs">
                  No unreviewed stranger clusters yet.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-border/60">
                <td className="px-3 py-3 font-mono">#{r.id}</td>
                <td className="px-3 py-3">{r.member_count}</td>
                <td className="px-3 py-3 font-mono text-xs">{r.cameras.join(", ") || "—"}</td>
                <td className="px-3 py-3 font-mono text-xs">{formatDate(r.last_seen_at)}</td>
                <td className="px-3 py-3 text-right space-x-2">
                  <button type="button" onClick={() => promote(r.id)} className="font-mono text-[10px] uppercase text-emerald-400">
                    Promote
                  </button>
                  <button type="button" onClick={() => ignore(r.id)} className="font-mono text-[10px] uppercase text-muted-foreground">
                    Ignore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={refresh} className="mt-3 font-mono text-[10px] uppercase text-muted-foreground hover:text-foreground">
        Refresh
      </button>
    </section>
  );
}

function SearchHistorySection() {
  const [preview, setPreview] = useState<string | null>(null);
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const dataUrl = await readAsDataUrl(f);
    setPreview(dataUrl);
    setImageBase64(dataUrl);
    setHits([]);
    setErr(null);
  }

  async function search() {
    if (!imageBase64) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/agent/faces/search", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_base64: imageBase64, limit: 30 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? data?.detail ?? `HTTP ${res.status}`);
      setHits(data.hits ?? []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "search failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <motionSectionLabel num="04">Search Footage by Face</motionSectionLabel>
      <p className="mb-4 text-sm text-muted-foreground">
        Upload a photo to find similar faces in stored match history (requires vectors enabled).
      </p>
      <div className="flex flex-wrap gap-3 items-center">
        <input type="file" accept="image/*" onChange={onFile} className="text-sm" />
        <button
          type="button"
          onClick={search}
          disabled={!imageBase64 || busy}
          className="border border-border px-4 py-2 font-mono text-[10px] uppercase disabled:opacity-40"
        >
          {busy ? "Searching…" : "Search history"}
        </button>
      </div>
      {preview && (
        <img src={preview} alt="" className="mt-4 max-h-40 border border-border object-contain" />
      )}
      {err && <p className="mt-2 text-xs text-alert">{err}</p>}
      {hits.length > 0 && (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {hits.map((h) => (
            <button
              key={h.match_id}
              type="button"
              className="border border-border text-left hover:border-foreground/40 transition-colors"
              onClick={() => {
                if (h.has_thumb) {
                  setLightbox({
                    src: matchThumbUrl(h.match_id),
                    label: `${h.camera} · ${(h.similarity * 100).toFixed(0)}%`,
                  });
                }
              }}
            >
              {h.has_thumb ? (
                <img
                  src={matchThumbUrl(h.match_id)}
                  alt=""
                  className="w-full aspect-square object-cover bg-card"
                />
              ) : (
                <div className="aspect-square flex items-center justify-center font-mono text-[10px] uppercase text-muted-foreground bg-card/40">
                  No thumb
                </div>
              )}
              <div className="p-3 font-mono text-[10px] space-y-1">
                <div className="text-foreground/90">{formatDate(h.created_at)}</div>
                <div>
                  {h.camera} · sim {(h.similarity * 100).toFixed(0)}%
                  {h.person_name ? ` · ${h.person_name}` : " · unknown"}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
      {lightbox && (
        <FaceThumbLightbox
          src={lightbox.src}
          label={lightbox.label}
          onClose={() => setLightbox(null)}
        />
      )}
    </section>
  );
}

// ---- Section: enroll -----------------------------------------------------

function EnrollSection({
  cameras,
  onEnrolled,
}: {
  cameras: { name: string; label: string }[];
  onEnrolled: () => void;
}) {
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [camera, setCamera] = useState<string>("");
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  // The base64 we'll actually POST. Includes the data: URI prefix; the
  // server tolerates both stripped and unstripped forms.
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [state, setState] = useState<EnrollState>({ kind: "idle" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const previewSize = useMemo(() => {
    if (!imageBase64) return null;
    // Base64 inflates by ~4/3; this is approximate but fine for "is it big?"
    const bytes = Math.floor((imageBase64.length * 3) / 4);
    if (bytes > 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }, [imageBase64]);

  function clearImage() {
    setPreviewUrl(null);
    setImageBase64(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      setState({ kind: "error", message: "Pick an image file (JPEG or PNG)." });
      return;
    }
    if (f.size > 9 * 1024 * 1024) {
      setState({ kind: "error", message: "Image too large (max ~9 MB)." });
      return;
    }
    const dataUrl = await readAsDataUrl(f);
    setPreviewUrl(dataUrl);
    setImageBase64(dataUrl);
    setState({ kind: "idle" });
  }

  async function captureSnapshot() {
    if (!camera) {
      setState({ kind: "error", message: "Pick a camera before capturing." });
      return;
    }
    setState({ kind: "submitting" });
    try {
      const res = await fetch(`/api/cam/snapshot/${encodeURIComponent(camera)}?h=720`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
      const blob = await res.blob();
      const dataUrl = await readAsDataUrl(new File([blob], "snapshot.jpg", { type: blob.type || "image/jpeg" }));
      setPreviewUrl(dataUrl);
      setImageBase64(dataUrl);
      setState({ kind: "idle" });
    } catch (err) {
      setState({
        kind: "error",
        message: `Snapshot failed: ${err instanceof Error ? err.message : "unknown"}`,
      });
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setState({ kind: "error", message: "Name is required." });
      return;
    }
    if (!imageBase64) {
      setState({ kind: "error", message: "Add a photo (upload or capture)." });
      return;
    }
    setState({ kind: "submitting" });
    try {
      const res = await fetch("/api/agent/faces/enroll", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          notes: notes.trim() || undefined,
          image_base64: imageBase64,
          source_camera: camera || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState({ kind: "error", message: prettyEnrollError(res.status, data) });
        return;
      }
      const q = data?.embedding?.quality;
      const dim = data?.embedding?.vec_dim;
      setState({
        kind: "ok",
        message: `Enrolled ${data?.person?.name ?? name} — quality ${q?.toFixed?.(2) ?? "?"}, ${dim ?? "?"}-d vector stored.`,
      });
      setName("");
      setNotes("");
      clearImage();
      onEnrolled();
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "submit failed",
      });
    }
  }

  return (
    <section>
      <div className="mb-6 flex items-center gap-3">
        <span className="font-mono text-xs text-alert">[01]</span>
        <span className="label-mono">Enroll a Person</span>
        <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-4">
          <Field label="Name" required>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Kamal"
              maxLength={100}
              className="w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none transition-colors"
            />
          </Field>
          <Field label="Notes (optional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Role, relationship, etc."
              maxLength={500}
              rows={3}
              className="w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none transition-colors resize-none"
            />
          </Field>
          <Field label="Source camera (optional)">
            <select
              value={camera}
              onChange={(e) => setCamera(e.target.value)}
              className="w-full border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-foreground focus:outline-none"
            >
              <option value="">— none —</option>
              {cameras.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="border border-border px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-foreground hover:bg-card/40 transition-colors"
            >
              Upload Photo
            </button>
            <button
              type="button"
              onClick={captureSnapshot}
              disabled={!camera || state.kind === "submitting"}
              className="border border-border px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-foreground hover:bg-card/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Capture from camera
            </button>
            {previewUrl && (
              <button
                type="button"
                onClick={clearImage}
                className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
              >
                Clear
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onFile}
            />
          </div>

          <div className="flex items-center gap-4 pt-3">
            <button
              type="submit"
              disabled={state.kind === "submitting"}
              className="bg-foreground px-6 py-3 text-xs font-medium uppercase tracking-[0.2em] text-background hover:bg-foreground/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {state.kind === "submitting" ? "Enrolling…" : "Enroll →"}
            </button>
            {state.kind === "ok" && (
              <p className="font-mono text-xs tracking-wider text-emerald-400">● {state.message}</p>
            )}
            {state.kind === "error" && (
              <p className="font-mono text-xs tracking-wider text-alert">● {state.message}</p>
            )}
          </div>
        </div>

        <div className="border border-border bg-card/20 aspect-[4/3] flex items-center justify-center overflow-hidden">
          {previewUrl ? (
            <div className="relative w-full h-full">
              <img
                src={previewUrl}
                alt="enrollment preview"
                className="w-full h-full object-contain"
              />
              <span className="absolute top-2 right-2 font-mono text-[10px] uppercase tracking-widest bg-background/80 px-2 py-1 text-foreground/80">
                {previewSize}
              </span>
            </div>
          ) : (
            <div className="text-center px-4">
              <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
                No image
              </p>
              <p className="mt-2 text-xs text-muted-foreground/70">
                Upload a clear photo or capture from a live camera.
                <br />
                One face, ~1m, looking forward.
              </p>
            </div>
          )}
        </div>
      </form>
    </section>
  );
}

// ---- Section: known people ----------------------------------------------

function PeopleSection({
  rows,
  loading,
  error,
  onRefresh,
  onArchived,
}: {
  rows: Person[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onArchived: () => void;
}) {
  const [archiving, setArchiving] = useState<number | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  async function archive(p: Person) {
    if (!window.confirm(`Archive ${p.name}? Recognition will stop matching this person.`)) return;
    setArchiving(p.id);
    setArchiveError(null);
    try {
      const res = await fetch(`/api/agent/faces/people/${p.id}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      onArchived();
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : "archive failed");
    } finally {
      setArchiving(null);
    }
  }

  return (
    <section>
      <div className="mb-6 flex items-center gap-3">
        <span className="font-mono text-xs text-alert">[02]</span>
        <span className="label-mono">Known People</span>
        <span className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={onRefresh}
          className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
        >
          Refresh
        </button>
      </div>

      {error && <p className="mb-4 font-mono text-xs tracking-wider text-alert">● {error}</p>}
      {archiveError && <p className="mb-4 font-mono text-xs tracking-wider text-alert">● {archiveError}</p>}

      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-card/40 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="px-3 py-3 text-left">Name</th>
              <th className="px-3 py-3 text-left">Embeddings</th>
              <th className="px-3 py-3 text-left">Last Updated</th>
              <th className="px-3 py-3 text-left">Notes</th>
              <th className="px-3 py-3 text-left">Created</th>
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={6} className="px-3 py-12 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  No enrolled faces yet. Use [01] above to add one.
                </td>
              </tr>
            )}
            {rows.map((p) => (
              <tr key={p.id} className="border-b border-border/60 hover:bg-card/40 transition-colors">
                <td className="px-3 py-3 text-foreground">{p.name}</td>
                <td className="px-3 py-3 font-mono text-xs text-foreground/85">{p.embedding_count}</td>
                <td className="px-3 py-3 font-mono text-xs text-foreground/80">
                  {p.last_embedded_at ? formatDate(p.last_embedded_at) : <span className="text-muted-foreground/50">—</span>}
                </td>
                <td className="px-3 py-3 max-w-[24rem] truncate text-muted-foreground">
                  {p.notes || <span className="text-muted-foreground/50">—</span>}
                </td>
                <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{formatDate(p.created_at)}</td>
                <td className="px-3 py-3 text-right">
                  <button
                    type="button"
                    onClick={() => archive(p)}
                    disabled={archiving === p.id}
                    className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-alert disabled:opacity-50 transition-colors"
                  >
                    {archiving === p.id ? "Archiving…" : "Archive"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {loading ? "Loading…" : `${rows.length} active`}
      </p>
    </section>
  );
}

// ---- Section: recent matches --------------------------------------------

function MatchesSection({
  rows,
  loading,
  onRefresh,
}: {
  rows: FaceMatch[];
  loading: boolean;
  onRefresh: () => void;
}) {
  const [lightbox, setLightbox] = useState<{ src: string; label: string } | null>(null);

  return (
    <section>
      <div className="mb-6 flex items-center gap-3">
        <span className="font-mono text-xs text-alert">[03]</span>
        <span className="label-mono">Recent Matches</span>
        <span className="h-px flex-1 bg-border" />
        <button
          type="button"
          onClick={onRefresh}
          className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
        >
          Refresh
        </button>
      </div>

      <div className="overflow-x-auto border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-card/40 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              <th className="px-3 py-3 text-left w-16">Face</th>
              <th className="px-3 py-3 text-left">Time</th>
              <th className="px-3 py-3 text-left">Camera</th>
              <th className="px-3 py-3 text-left">Person</th>
              <th className="px-3 py-3 text-left">Similarity</th>
              <th className="px-3 py-3 text-left">Quality</th>
              <th className="px-3 py-3 text-left">Event</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-3 py-12 text-center font-mono text-xs uppercase tracking-widest text-muted-foreground">
                  No matches recorded yet. Live recognition writes here as faces appear.
                </td>
              </tr>
            )}
            {rows.map((m) => {
              const isUnknown = !m.person_id;
              const sim = m.similarity ?? 0;
              return (
                <tr key={m.id} className="border-b border-border/60 hover:bg-card/40 transition-colors">
                  <td className="px-3 py-3">
                    {m.thumb_path ? (
                      <button
                        type="button"
                        className="block"
                        onClick={() =>
                          setLightbox({
                            src: matchThumbUrl(m.id),
                            label: m.person_name ?? "unknown",
                          })
                        }
                      >
                        <img
                          src={matchThumbUrl(m.id)}
                          alt=""
                          className="h-12 w-12 object-cover border border-border"
                        />
                      </button>
                    ) : (
                      <span className="font-mono text-[10px] text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-foreground/80">{formatDate(m.created_at)}</td>
                  <td className="px-3 py-3 font-mono text-xs text-foreground/85">{m.camera}</td>
                  <td className="px-3 py-3">
                    {isUnknown ? (
                      <span className="font-mono text-xs uppercase tracking-widest text-alert">Unknown</span>
                    ) : (
                      <span className="text-foreground">{m.person_name}</span>
                    )}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs">
                    <SimilarityBar value={sim} />
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-foreground/70">
                    {m.quality?.toFixed?.(2) ?? "—"}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">
                    {m.event_id || <span className="text-muted-foreground/50">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {loading ? "Loading…" : `${rows.length} most recent`}
      </p>
      {lightbox && (
        <FaceThumbLightbox
          src={lightbox.src}
          label={lightbox.label}
          onClose={() => setLightbox(null)}
        />
      )}
    </section>
  );
}

// ---- helpers -------------------------------------------------------------

function matchThumbUrl(matchId: number) {
  return `/api/agent/faces/matches/${matchId}/thumb`;
}

function FaceThumbLightbox({
  src,
  label,
  onClose,
}: {
  src: string;
  label: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="max-w-3xl w-full border border-border bg-card p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{label}</span>
          <button
            type="button"
            onClick={onClose}
            className="font-mono text-[10px] uppercase text-foreground hover:text-alert"
          >
            Close
          </button>
        </div>
        <img src={src} alt="" className="mx-auto max-h-[75vh] w-auto object-contain" />
      </div>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
        {label}
        {required && <span className="ml-1 text-alert">*</span>}
      </span>
      {children}
    </label>
  );
}

function SimilarityBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  // Same color bands the harness uses for routing decisions.
  const color =
    value >= 0.55 ? "bg-emerald-400" : value >= 0.4 ? "bg-amber-400" : "bg-alert";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 bg-card overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-foreground/80">{value.toFixed(3)}</span>
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

// Map server error shapes to operator-facing copy. The server intentionally
// returns specific 4xx codes for "your image is bad" (no_face_detected,
// face_too_low_quality, etc.) and 502s for "the embedder service is down."
// We surface both clearly so the operator can act.
function prettyEnrollError(status: number, body: { error?: string; detail?: unknown; quality?: number; hint?: string }): string {
  const e = body?.error ?? "unknown_error";
  if (e === "no_face_detected") return "No face detected in that image. Try a clearer, better-lit photo.";
  if (e === "face_too_low_quality") {
    const hint = body?.hint ?? "Re-shoot with better light, ~1m from camera, looking forward.";
    return `Face quality too low (${body?.quality?.toFixed?.(2) ?? "?"}). ${hint}`;
  }
  if (e === "embedder_rejected_image" || e === "embedder_rejected_image_on_store") {
    return "Embedder rejected the image. Use a JPEG/PNG, ≥200px on the short side.";
  }
  if (e === "embedder_unreachable") return "Face embedder service is offline. Check the sidecar.";
  if (e === "bad_image") return "Could not decode that image. Try uploading again.";
  if (e === "invalid_input") return "Form data invalid. Check the name and image.";
  if (status >= 500) return `Server error (${status}). ${e}`;
  return `Enrollment failed: ${e}`;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}
