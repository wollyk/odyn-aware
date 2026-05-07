// Chat panel: SSE streaming, tool-call render, scroll-to-bottom on new tokens.
//
// Wire format from /api/agent/chat:
//   data: {"type":"text","delta":"..."}
//   data: {"type":"tool","name":"...","args":{...}}
//   data: {"type":"tool_result","name":"...","result":{...}}
//   data: {"type":"error","message":"..."}
//   data: {"type":"done"}

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentStatus, Camera, ChatMsg, ToolEvent } from "./types";

export function ChatPanel({
  cam,
  agentStatus,
}: {
  cam: Camera | null;
  agentStatus: AgentStatus | null;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      id: "init",
      role: "assistant",
      content:
        "AuroraView agent online. Ask about the current scene, recent events, or set up an alert rule. " +
        "I can also rename a camera (e.g. 'rename Garage to CAM 01 GARAGE-A').",
    },
  ]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const send = useCallback(async () => {
    if (!cam) return;
    const text = input.trim();
    if (!text || sending) return;

    const userMsg: ChatMsg = { id: crypto.randomUUID(), role: "user", content: text };
    const asstMsg: ChatMsg = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      pending: true,
      tools: [],
    };
    setMessages((m) => [...m, userMsg, asstMsg]);
    setInput("");
    setSending(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const wireMessages = [...messages, userMsg]
        .filter((m) => m.role === "user" || (m.role === "assistant" && !m.pending && m.content))
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch("/api/agent/chat", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ camera: cam.name, messages: wireMessages }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`chat http ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          for (const line of block.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            let evt: { type?: string; delta?: string; message?: string; name?: string; args?: unknown; result?: unknown };
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }
            if (evt.type === "text" && typeof evt.delta === "string") {
              const delta = evt.delta;
              setMessages((m) =>
                m.map((x) =>
                  x.id === asstMsg.id ? { ...x, content: x.content + delta } : x,
                ),
              );
            } else if (evt.type === "tool" && typeof evt.name === "string") {
              const name = evt.name;
              const args = evt.args;
              setMessages((m) =>
                m.map((x) => {
                  if (x.id !== asstMsg.id || x.role !== "assistant") return x;
                  return { ...x, tools: [...(x.tools ?? []), { kind: "call", name, args }] };
                }),
              );
            } else if (evt.type === "tool_result" && typeof evt.name === "string") {
              const name = evt.name;
              const result = evt.result;
              setMessages((m) =>
                m.map((x) => {
                  if (x.id !== asstMsg.id || x.role !== "assistant") return x;
                  return { ...x, tools: [...(x.tools ?? []), { kind: "result", name, result }] };
                }),
              );
            } else if (evt.type === "error") {
              const msg = evt.message ?? "unknown";
              setMessages((m) =>
                m.map((x) =>
                  x.id === asstMsg.id
                    ? { ...x, content: x.content + `\n\n[error: ${msg}]` }
                    : x,
                ),
              );
            } else if (evt.type === "done") {
              setMessages((m) =>
                m.map((x) => {
                  if (x.id !== asstMsg.id || x.role !== "assistant") return x;
                  return { ...x, pending: false };
                }),
              );
            }
          }
        }
      }
    } catch (err) {
      setMessages((m) =>
        m.map((x) =>
          x.id === asstMsg.id
            ? {
                ...x,
                pending: false,
                content: x.content + `\n[connection error: ${err instanceof Error ? err.message : "unknown"}]`,
              }
            : x,
        ),
      );
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }, [cam, input, messages, sending]);

  return (
    <aside className="flex h-[70vh] min-h-[480px] flex-col border border-border bg-card/30">
      <div className="flex items-center justify-between border-b border-border bg-background/60 px-3 py-2">
        <span className="font-mono text-[10px] uppercase tracking-widest text-foreground">
          Agent · {cam ? cam.label : "—"}
        </span>
        {!agentStatus?.chat_configured && (
          <span className="font-mono text-[10px] uppercase tracking-widest text-alert">
            placeholder mode
          </span>
        )}
      </div>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto p-3">
        {messages.map((m) => (
          <ChatBubble key={m.id} msg={m} />
        ))}
      </div>

      <form
        className="border-t border-border bg-background/60 p-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
            placeholder="Ask the agent…  (Enter to send, Shift+Enter for newline)"
            className="flex-1 resize-none border border-border bg-background px-3 py-2 font-mono text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-foreground focus:outline-none"
            disabled={sending}
          />
          <button
            type="submit"
            disabled={sending || !input.trim() || !cam}
            className="border border-foreground/80 px-4 py-2 font-mono text-[10px] uppercase tracking-widest text-foreground hover:bg-foreground hover:text-background disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-foreground transition-colors"
          >
            {sending ? "…" : "Send"}
          </button>
        </div>
      </form>
    </aside>
  );
}

function ChatBubble({ msg }: { msg: ChatMsg }) {
  const isUser = msg.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] border px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "border-foreground/40 bg-foreground/5 text-foreground"
            : "border-border bg-background/40 text-foreground/90"
        }`}
      >
        {msg.content}
        {msg.role === "assistant" && msg.pending && (
          <span className="ml-1 inline-block h-2 w-1.5 animate-pulse bg-foreground/60 align-middle" />
        )}
        {msg.role === "assistant" && msg.tools && msg.tools.length > 0 && (
          <div className="mt-2 space-y-1">
            {msg.tools.map((t, i) => (
              <ToolChip key={i} t={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolChip({ t }: { t: ToolEvent }) {
  if (t.kind === "call") {
    return (
      <div className="border-l-2 border-alert pl-2 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        ▸ tool: {t.name}({summarizeArgs(t.args)})
      </div>
    );
  }
  return (
    <div className="border-l-2 border-foreground/30 pl-2 font-mono text-[10px] tracking-wider text-foreground/60">
      ↩ {t.name}: {summarizeResult(t.result)}
    </div>
  );
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const entries = Object.entries(args as Record<string, unknown>).slice(0, 3);
  return entries.map(([k, v]) => `${k}=${truncate(String(v), 24)}`).join(", ");
}

function summarizeResult(r: unknown): string {
  if (!r || typeof r !== "object") return String(r);
  const obj = r as Record<string, unknown>;
  if (obj.ok === false) return `error: ${obj.error}`;
  if (Array.isArray(obj.cameras)) return `${(obj.cameras as unknown[]).length} cameras`;
  if (Array.isArray(obj.events)) return `${(obj.events as unknown[]).length} events`;
  if (obj.label) return `${obj.camera} → ${obj.label}`;
  if (obj.rule) return `rule #${(obj.rule as { id: number }).id} proposed`;
  return "ok";
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
