import { getPrMode, isHostedPreview, isPrEnabled, openPullRequest, type PullRequestEvent, type PullRequestInput } from "@/lib/pull-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  };
}

export async function POST(request: Request) {
  let input: PullRequestInput;
  try {
    input = (await request.json()) as PullRequestInput;
    if (!input || typeof input.patch !== "string" || !input.patch.trim()) {
      return Response.json({ error: "A valid patch diff is required to open a PR." }, { status: 400 });
    }
    if (!input.repositoryUrl || !input.branch || !input.issue) {
      return Response.json({ error: "repositoryUrl, branch, issue, and patch are required." }, { status: 400 });
    }
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const refused = (code: string, title: string, message: string): Response => {
    const event: PullRequestEvent = { type: "failed", error: { code, title, message } };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { headers: sseHeaders() });
  };

  if (isHostedPreview()) {
    return refused(
      "hosted_preview",
      "PRs are available in the local demo",
      "This hosted preview cannot clone repositories or open pull requests. Run Codex Pilot locally with CODEX_PILOT_ALLOW_PR=true to open a PR."
    );
  }

  if (!isPrEnabled()) {
    return refused(
      "pr_not_allowed",
      "PR creation is disabled",
      "Set CODEX_PILOT_ALLOW_PR=true on the server to allow Codex Pilot to open pull requests. No branch was pushed."
    );
  }

  let disconnected = false;
  console.log(`[Codex Pilot] Opening PR for issue #${input.issue?.number} in ${input.repositoryUrl} (mode=${getPrMode()})`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: PullRequestEvent) => {
        if (!disconnected) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      // Never push to the base branch; the library pushes a feature branch only.
      void openPullRequest(input, undefined, emit)
        .catch((error: unknown) => {
          const err = error as { code?: string; title?: string; message?: string; retryable?: boolean };
          emit({
            type: "failed",
            error: {
              code: typeof err?.code === "string" ? err.code : "pr_failed",
              title: typeof err?.title === "string" ? err.title : "Could not open the PR",
              message: typeof err?.message === "string" ? err.message : "The PR flow failed before a pull request was created.",
              retryable: Boolean(err?.retryable),
            },
          });
        })
        .finally(() => {
          console.log(`[Codex Pilot] Finished PR flow for issue #${input.issue?.number}`);
          if (!disconnected) controller.close();
        });
    },
    cancel() {
      disconnected = true;
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}
