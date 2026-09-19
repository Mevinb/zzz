import { logError, logInfo, logWarn } from "@/lib/logger";
import { streamPilotRun } from "@/lib/pilot";
import type { RunEvent } from "@/lib/pilot-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let issueUrl = "";
  try {
    const body = await request.json() as { issueUrl?: unknown };
    if (typeof body.issueUrl !== "string" || body.issueUrl.length > 500) throw new Error("Enter a valid GitHub issue URL.");
    issueUrl = body.issueUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Enter a valid GitHub issue URL.";
    logWarn("api/runs", `Rejected run request: ${message}`, { code: "bad_request" });
    return Response.json({ error: message }, { status: 400 });
  }
  const encoder = new TextEncoder();
  if (process.env.CODEX_PILOT_LIVE_RUNS === "false" || process.env.VERCEL === "1") {
    const hostedPreviewError: RunEvent = {
      type: "failed",
      error: {
        code: "hosted_preview",
        title: "Live runs are available in the local demo",
        message: "This hosted preview intentionally shows a sample run. Start Codex Pilot on the Codex-authenticated demo machine to investigate a public GitHub issue.",
      },
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(hostedPreviewError)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" } });
  }
  let disconnected = false;
  logInfo("api/runs", `Investigating issue: ${issueUrl}`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: RunEvent) => {
        if (event.type === "failed") {
          const failedStage = event.run?.stages.find((stage) => stage.status === "failed")?.label;
          logError("api/runs", `Run failed for ${issueUrl}${failedStage ? ` at ${failedStage}` : ""}: ${event.error.title} — ${event.error.message}`, {
            code: event.error.code,
          });
        } else if (event.type === "completed" && event.run.status === "refused") {
          logWarn("api/runs", `Run refused for ${issueUrl}: ${event.run.refusal?.reason || "no reason given"}`, {
            code: event.run.refusal?.kind,
          });
        }
        if (!disconnected) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      void streamPilotRun(issueUrl, emit).finally(() => {
        logInfo("api/runs", `Finished investigating issue: ${issueUrl}`);
        if (!disconnected) controller.close();
      });
    },
    cancel() { disconnected = true; },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" } });
}
