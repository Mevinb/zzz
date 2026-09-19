import { logWarn } from "@/lib/logger";
import { verifyPatch, type VerificationOptions } from "@/lib/verification";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: VerificationOptions;
  try {
    body = (await request.json()) as VerificationOptions;
    if (!body || typeof body.patch !== "string" || !body.patch.trim()) {
      logWarn("api/verify", "Rejected verify request: missing patch", { code: "bad_request" });
      return Response.json({ error: "A valid patch diff is required." }, { status: 400 });
    }
  } catch {
    logWarn("api/verify", "Rejected verify request: invalid body", { code: "bad_request" });
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  // This endpoint intentionally provides QA guidance only. It never invokes a
  // VCS client, shell, package manager, or target repository script.
  return Response.json(await verifyPatch(body));
}
