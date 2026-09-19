import { clearLogs, getLogs, log, logWarn } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLIENT_LEVELS = new Set(["info", "warn", "error"]);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const level = url.searchParams.get("level");
  const q = url.searchParams.get("q");
  const rawLimit = Number(url.searchParams.get("limit") ?? 200);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 200;
  return Response.json(getLogs({ level, q, limit }));
}

export async function POST(request: Request) {
  let body: { level?: unknown; message?: unknown; code?: unknown; source?: unknown; detail?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const level = typeof body?.level === "string" && CLIENT_LEVELS.has(body.level) ? body.level : "error";
  if (typeof body?.message !== "string" || !body.message.trim()) {
    return Response.json({ error: "A log message is required." }, { status: 400 });
  }
  const source =
    typeof body?.source === "string" && body.source.trim() ? `client/${body.source.trim().slice(0, 40)}` : "client";
  const entry = log(level as "info" | "warn" | "error", source, body.message, {
    ...(typeof body?.code === "string" && body.code ? { code: body.code.slice(0, 80) } : {}),
    ...(typeof body?.detail === "string" && body.detail ? { detail: body.detail.slice(0, 2000) } : {}),
  });
  return Response.json({ ok: true, id: entry.id });
}

export async function DELETE() {
  clearLogs();
  logWarn("api/logs", "Log buffer cleared from the logs page");
  return Response.json({ ok: true });
}
