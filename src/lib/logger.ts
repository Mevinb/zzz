import "server-only";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  id: number;
  ts: string;
  level: LogLevel;
  source: string;
  message: string;
  code?: string;
  detail?: string;
};

export type LogQuery = {
  level?: string | null;
  q?: string | null;
  limit?: number | null;
};

const MAX_ENTRIES = 500;
const MAX_MESSAGE_CHARS = 2000;
const MAX_DETAIL_CHARS = 4000;

const entries: LogEntry[] = [];
let nextId = 1;
let dropped = 0;

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function secretValues(): string[] {
  const values: string[] = [];
  for (const key of ["GITHUB_PR_TOKEN", "GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY"]) {
    const value = process.env[key];
    if (value && value.trim().length >= 4) values.push(value.trim());
  }
  return values;
}

/** Redact tokens and token-like material so logs are safe to read/share. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const secret of secretValues()) {
    out = out.split(secret).join("***");
    try {
      const b64 = Buffer.from(`x-access-token:${secret}`).toString("base64");
      if (b64.length >= 8) out = out.split(b64).join("***");
    } catch {
      // Buffer is always available on the server; ignore otherwise.
    }
  }
  out = out
    .replace(/x-access-token:[^\s"'`]+/g, "x-access-token:***")
    .replace(/gh[pousr]_[A-Za-z0-9]+/g, "***")
    .replace(/github_pat_[A-Za-z0-9_]+/g, "***")
    .replace(/sk-[A-Za-z0-9-_]{10,}/g, "***")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/g, "Bearer ***");
  return out;
}

function mirrorToConsole(entry: LogEntry): void {
  const line = `[Codex Pilot] [${entry.level}] [${entry.source}] ${entry.message}${
    entry.code ? ` (code=${entry.code})` : ""
  }`;
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
}

export function log(
  level: LogLevel,
  source: string,
  message: string,
  opts?: { code?: string; detail?: string }
): LogEntry {
  const entry: LogEntry = {
    id: nextId++,
    ts: new Date().toISOString(),
    level,
    source: truncate(redactSecrets(source || "server"), 80),
    message: truncate(redactSecrets(message || ""), MAX_MESSAGE_CHARS),
    ...(opts?.code ? { code: truncate(redactSecrets(opts.code), 80) } : {}),
    ...(opts?.detail ? { detail: truncate(redactSecrets(opts.detail), MAX_DETAIL_CHARS) } : {}),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES);
    dropped += 1;
  }
  mirrorToConsole(entry);
  return entry;
}

export function logInfo(source: string, message: string, opts?: { code?: string; detail?: string }): LogEntry {
  return log("info", source, message, opts);
}

export function logWarn(source: string, message: string, opts?: { code?: string; detail?: string }): LogEntry {
  return log("warn", source, message, opts);
}

export function logError(source: string, message: string, opts?: { code?: string; detail?: string }): LogEntry {
  return log("error", source, message, opts);
}

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function getLogs(query: LogQuery = {}): { entries: LogEntry[]; total: number; dropped: number } {
  const wanted = new Set<LogLevel>();
  if (query.level) {
    for (const part of String(query.level).split(",")) {
      const level = part.trim().toLowerCase() as LogLevel;
      if ((LEVELS as string[]).includes(level)) wanted.add(level);
    }
  }
  const needle = (query.q || "").trim().toLowerCase();
  const filtered = entries.filter((entry) => {
    if (wanted.size > 0 && !wanted.has(entry.level)) return false;
    if (needle) {
      const haystack = `${entry.message} ${entry.source} ${entry.code ?? ""} ${entry.detail ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
  const limit = Math.min(Math.max(query.limit ?? 200, 1), MAX_ENTRIES);
  return { entries: filtered.slice(-limit), total: filtered.length, dropped };
}

export function clearLogs(): void {
  entries.length = 0;
  dropped = 0;
}

export function logStats(): { total: number; dropped: number; errors: number; warns: number } {
  return {
    total: entries.length,
    dropped,
    errors: entries.filter((entry) => entry.level === "error").length,
    warns: entries.filter((entry) => entry.level === "warn").length,
  };
}
