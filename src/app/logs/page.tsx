"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

type LogLevel = "debug" | "info" | "warn" | "error";
type LogEntry = {
  id: number;
  ts: string;
  level: LogLevel;
  source: string;
  message: string;
  code?: string;
  detail?: string;
};

const LEVELS: { id: "all" | LogLevel; label: string }[] = [
  { id: "all", label: "All" },
  { id: "info", label: "Info" },
  { id: "warn", label: "Warnings" },
  { id: "error", label: "Errors" },
];

function levelStyle(level: LogLevel): string {
  if (level === "error") return "border-[#f85149]/40 bg-[#f85149]/10 text-[#ff7b72]";
  if (level === "warn") return "border-[#d29922]/40 bg-[#d29922]/10 text-[#e3b341]";
  if (level === "debug") return "border-[#a371f7]/40 bg-[#a371f7]/10 text-[#bc8cff]";
  return "border-[#1f6feb]/40 bg-[#1f6feb]/10 text-[#79c0ff]";
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

export default function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [dropped, setDropped] = useState(0);
  const [level, setLevel] = useState<"all" | LogLevel>("all");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/logs?limit=300", { cache: "no-store" });
      if (!response.ok) throw new Error(`Logs request failed (${response.status}).`);
      const data = (await response.json()) as { entries: LogEntry[]; dropped: number };
      setEntries(Array.isArray(data.entries) ? data.entries : []);
      setDropped(typeof data.dropped === "number" ? data.dropped : 0);
      setFetchError(null);
    } catch (caught) {
      setFetchError(caught instanceof Error ? caught.message : "Could not load logs.");
    }
  }, []);

  // Polling subscription: initial fetch + interval refresh of an external log buffer.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch for the polling subscription
    void load();
    if (paused) return;
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [load, paused]);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [entries, autoScroll]);

  async function clear() {
    if (clearing) return;
    setClearing(true);
    try {
      await fetch("/api/logs", { method: "DELETE" });
      await load();
    } catch {
      setFetchError("Could not clear logs.");
    } finally {
      setClearing(false);
    }
  }

  const needle = query.trim().toLowerCase();
  const visible = entries.filter((entry) => {
    if (level !== "all" && entry.level !== level) return false;
    if (needle) {
      const haystack = `${entry.message} ${entry.source} ${entry.code ?? ""} ${entry.detail ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  const errors = entries.filter((entry) => entry.level === "error").length;
  const warns = entries.filter((entry) => entry.level === "warn").length;

  return (
    <main className="min-h-screen bg-[#0d1117] text-[#c9d1d9]">
      <header className="border-b border-[#30363d] bg-[#161b22]">
        <div className="mx-auto flex h-14 max-w-[1440px] items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/" className="font-semibold text-white hover:underline">
              ← Codex Pilot
            </Link>
            <span className="hidden border-l border-[#30363d] pl-3 text-xs font-normal text-[#8b949e] sm:block">
              Server logs — runs, PR flow & errors
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-[#8b949e]">
            <Link href="/settings" className="rounded-md border border-[#30363d] px-2.5 py-1.5 text-[#c9d1d9] hover:bg-[#21262d]">
              Settings
            </Link>
            <span className="font-mono">
              {entries.length} entries · {errors} errors · {warns} warnings{dropped > 0 ? ` · ${dropped} dropped` : ""}
            </span>
            <span className={(paused ? "bg-[#484f58]" : "animate-pulse bg-[#3fb950]") + " h-2 w-2 rounded-full"} />
            {paused ? "Paused" : "Live"}
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-[1440px] px-4 py-5 sm:px-6">
        {fetchError && (
          <div role="alert" className="mb-4 rounded-md border border-[#f85149]/40 bg-[#f85149]/[.08] p-4 text-sm text-[#ff7b72]">
            {fetchError}{" "}
            <button onClick={() => void load()} className="ml-2 text-[#58a6ff] hover:underline">
              Retry
            </button>
          </div>
        )}

        <div className="flex flex-col gap-3 rounded-md border border-[#30363d] bg-[#161b22] p-4 lg:flex-row lg:items-center">
          <div className="flex flex-wrap gap-2">
            {LEVELS.map((item) => (
              <button
                key={item.id}
                onClick={() => setLevel(item.id)}
                aria-pressed={level === item.id}
                className={
                  (level === item.id ? "bg-[#1f6feb] text-white" : "bg-[#0d1117] text-[#8b949e] hover:text-white") +
                  " rounded-md border border-[#30363d] px-3 py-1.5 font-mono text-xs"
                }
              >
                {item.label}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by text, source, or code…"
            aria-label="Filter logs"
            className="h-9 min-w-0 flex-1 rounded-md border border-[#30363d] bg-[#0d1117] px-3 text-sm outline-none placeholder:text-[#484f58] focus:border-[#58a6ff]"
          />
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex cursor-pointer items-center gap-1.5 text-[#8b949e]">
              <input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} className="h-3.5 w-3.5 accent-[#1f6feb]" />
              Auto-scroll
            </label>
            <button
              onClick={() => setPaused((value) => !value)}
              className="rounded-md border border-[#30363d] px-3 py-1.5 text-[#c9d1d9] hover:bg-[#21262d]"
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button
              onClick={() => void load()}
              className="rounded-md border border-[#30363d] px-3 py-1.5 text-[#c9d1d9] hover:bg-[#21262d]"
            >
              Refresh
            </button>
            <button
              onClick={() => void clear()}
              disabled={clearing}
              className="rounded-md border border-[#f85149]/40 px-3 py-1.5 text-[#ff7b72] hover:bg-[#f85149]/10 disabled:opacity-50"
            >
              {clearing ? "Clearing…" : "Clear"}
            </button>
          </div>
        </div>

        <div ref={listRef} className="mt-4 max-h-[70vh] space-y-2 overflow-auto rounded-md border border-[#30363d] bg-[#161b22] p-3">
          {visible.length === 0 ? (
            <p className="p-6 text-center text-sm text-[#8b949e]">
              No log entries match. Run an investigation or open a PR — failures and warnings will show up here.
            </p>
          ) : (
            visible.map((entry) => (
              <div key={entry.id} className="rounded border border-[#30363d] bg-[#0d1117] px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase ${levelStyle(entry.level)}`}>
                    {entry.level}
                  </span>
                  <span className="font-mono text-[11px] text-[#6e7681]">{formatTime(entry.ts)}</span>
                  <span className="font-mono text-[11px] text-[#58a6ff]">{entry.source}</span>
                  {entry.code && <span className="font-mono text-[11px] text-[#8b949e]">code: {entry.code}</span>}
                </div>
                <p className="mt-1 leading-5 text-[#c9d1d9]">{entry.message}</p>
                {entry.detail && (
                  <details className="mt-1">
                    <summary className="cursor-pointer font-mono text-[11px] text-[#58a6ff]">Details</summary>
                    <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[#161b22] p-2 font-mono text-[11px] text-[#8b949e]">
                      {entry.detail}
                    </pre>
                  </details>
                )}
              </div>
            ))
          )}
        </div>
        <p className="mt-3 text-xs text-[#6e7681]">
          Server-side ring buffer keeps the last 500 entries (in-memory per server instance){dropped > 0 ? ` — ${dropped} older entries were dropped` : ""}. Secrets are redacted before storing.
        </p>
      </section>
    </main>
  );
}
