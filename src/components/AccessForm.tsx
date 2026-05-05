import { useState } from "react";
import { z } from "zod";

const schema = z.object({
  name: z.string().trim().min(1, "Required").max(100),
  email: z.string().trim().email("Invalid email").max(255),
  company: z.string().trim().min(1, "Required").max(150),
  environment: z.enum(["hangar", "industrial", "logistics", "other"]),
  message: z.string().trim().max(1000).optional(),
});

const API_BASE = (import.meta as { env?: { VITE_API_BASE?: string } }).env?.VITE_API_BASE ?? "";

export function AccessForm() {
  const [status, setStatus] = useState<"idle" | "submitting" | "ok" | "error">("idle");
  const [serverError, setServerError] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const fd = new FormData(formEl);
    const result = schema.safeParse({
      name: fd.get("name"),
      email: fd.get("email"),
      company: fd.get("company"),
      environment: fd.get("environment"),
      message: fd.get("message") || undefined,
    });
    if (!result.success) {
      const errs: Record<string, string> = {};
      result.error.issues.forEach((i) => { errs[String(i.path[0])] = i.message; });
      setErrors(errs);
      setStatus("error");
      setServerError(null);
      return;
    }
    setErrors({});
    setServerError(null);
    setStatus("submitting");
    try {
      const res = await fetch(`${API_BASE}/api/early-access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result.data),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `HTTP ${res.status}`);
      }
      setStatus("ok");
      formEl.reset();
    } catch (err) {
      setStatus("error");
      setServerError(err instanceof Error ? err.message : "Submission failed");
    }
  }

  const inputCls = "w-full border border-border bg-background px-3 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none transition-colors";
  const labelCls = "label-mono mb-2 block";

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="name" className={labelCls}>Name</label>
          <input id="name" name="name" required className={inputCls} />
          {errors.name && <p className="mt-1 text-xs text-alert">{errors.name}</p>}
        </div>
        <div>
          <label htmlFor="email" className={labelCls}>Email</label>
          <input id="email" name="email" type="email" required className={inputCls} />
          {errors.email && <p className="mt-1 text-xs text-alert">{errors.email}</p>}
        </div>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        <div>
          <label htmlFor="company" className={labelCls}>Company / Site</label>
          <input id="company" name="company" required className={inputCls} />
          {errors.company && <p className="mt-1 text-xs text-alert">{errors.company}</p>}
        </div>
        <div>
          <label htmlFor="environment" className={labelCls}>Environment</label>
          <select id="environment" name="environment" required defaultValue="hangar" className={inputCls}>
            <option value="hangar">Aircraft hangar</option>
            <option value="industrial">Industrial site</option>
            <option value="logistics">Logistics / warehouse</option>
            <option value="other">Other</option>
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="message" className={labelCls}>Message (optional)</label>
        <textarea id="message" name="message" rows={4} className={inputCls} />
      </div>

      <div className="flex flex-col-reverse items-start gap-4 pt-2 sm:flex-row sm:items-center sm:justify-between">
        {status === "ok" && (
          <p className="font-mono text-xs tracking-wider text-foreground">
            <span className="text-alert">●</span> REQUEST RECEIVED — We'll follow up with deployment details and next steps.
          </p>
        )}
        {status === "error" && serverError && (
          <p className="font-mono text-xs tracking-wider text-alert">
            ● Submission failed — {serverError}
          </p>
        )}
        {status !== "ok" && status !== "error" && <span />}
        <button
          type="submit"
          disabled={status === "submitting"}
          className="inline-flex items-center gap-3 bg-foreground px-6 py-3 text-xs font-medium uppercase tracking-[0.2em] text-background hover:bg-foreground/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {status === "submitting" ? "Submitting…" : "Request Access"}
          <span aria-hidden>→</span>
        </button>
      </div>
    </form>
  );
}
