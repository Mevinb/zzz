import { expect, test } from "@playwright/test";

const context = {
  type: "context",
  issue: { number: 1, title: "Add a focused validator", repository: "fixture/repo", url: "https://github.com/fixture/repo/issues/1" },
  repository: { branch: "main", commit: "0123456789abcdef", language: "TypeScript", public: true, url: "https://github.com/fixture/repo" },
};

function stages() {
  return ["understanding", "exploring", "evidence", "planning", "writing", "reviewing", "revising", "verifying"].map((id) => ({ id, label: id, status: "complete" }));
}

const createdFile = {
  path: "src/new-validator.ts", operation: "create", role: "source", requirementsCovered: ["R1"], additions: 1, deletions: 0,
  reason: "Adds the requested API.", originalContent: null, updatedContent: "export const validateName = (name: string) => name.length > 0;\n",
  diff: "diff --git a/src/new-validator.ts b/src/new-validator.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/new-validator.ts\n@@ -0,0 +1,1 @@\n+export const validateName = (name: string) => name.length > 0;\n",
};

function completedRun(status: "completed" | "refused" = "completed") {
  const patch = createdFile.diff;
  return {
    issue: context.issue, repository: context.repository, source: "live", status,
    summary: "A grounded patch proposal.", stages: stages(), activity: [], searches: [], inspectedFiles: [],
    plan: [{ id: "1", title: "Create validator", detail: "Add the requested API.", paths: [createdFile.path], operation: "create", status: "completed", requirementsCovered: ["R1"] }],
    files: [createdFile], explanations: [{ path: createdFile.path, explanation: createdFile.reason, coverage: ["R1"] }],
    review: { status: status === "completed" ? "passed" : "warning", verdict: status === "completed" ? "approved" : "refused", checks: [] }, confidence: "high", limitations: [],
    metrics: { elapsedMs: 10, filesIndexed: 1, filesInspected: 1, searches: 1, explorationRounds: 1, revisions: 1, filesChanged: 1, additions: 1, deletions: 0 },
    patch, originalPatch: patch, revisedPatch: patch, finalPatch: status === "completed" ? patch : undefined,
    patchVersions: [
      { version: 1, label: "Patch v1", patch, files: [createdFile], explanations: [], createdMs: 1, reviewerFeedback: ["Use the focused API."] },
      { version: 2, label: "Patch v2 (Revised)", patch, files: [createdFile], explanations: [], createdMs: 2 },
    ],
    requirements: [{ id: "R1", type: "mustImplement", text: "Add validateName", status: "implemented", coveredByFiles: [createdFile.path], reviewVerdict: "pass" }],
    ...(status === "refused" ? { refusal: { kind: "patch_generation_failed", title: "Patch not approved", reason: "Reviewer concerns remain.", suggestedNextStep: "Review Patch v2.", code: "PATCH_REVIEW_FAILED" } } : {}),
  };
}

async function streamRun(page: import("@playwright/test").Page, run: ReturnType<typeof completedRun>) {
  await page.route("**/api/runs**", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: [`data: ${JSON.stringify(context)}`, `data: ${JSON.stringify({ type: "stage", stage: { id: "writing", label: "Generating patch", status: "active" } })}`, `data: ${JSON.stringify({ type: "completed", run })}`].join("\n\n") + "\n\n",
  }));
}

test("paste URL starts a streamed run and keeps proposed revisions, code, diff, copy, and download inspectable", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-write"], { origin: "http://localhost:3100" });
  await streamRun(page, completedRun());
  await page.goto("/");
  await page.getByLabel("GitHub issue URL").fill("https://github.com/fixture/repo/issues/1");
  const request = page.waitForRequest("**/api/runs**");
  await page.getByRole("button", { name: "Run investigation" }).click();
  await request;
  await expect(page.getByText("fixture/repo")).toBeVisible();
  await expect(page.getByRole("button", { name: "Patch v1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Patch v2 (Revised)" })).toBeVisible();
  await expect(page.getByText("New file proposal: src/new-validator.ts")).toBeVisible();
  await expect(page.getByText("export const validateName = (name: string) => name.length > 0;", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Patch v1" }).click();
  await expect(page.getByText("new file mode 100644")).toBeVisible();
  await page.getByRole("button", { name: "Copy code for src/new-validator.ts" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download", exact: true }).first().click();
  expect((await download).suggestedFilename()).toBe("issue-1-proposal.diff");
});

function failedRun() {
  const base = completedRun("refused");
  return {
    ...base,
    files: [], patch: "", originalPatch: undefined, revisedPatch: undefined, finalPatch: undefined, patchVersions: [],
    stages: [
      { id: "understanding", label: "Understanding issue", status: "complete", elapsedMs: 5 },
      { id: "exploring", label: "Exploring repository", status: "complete", elapsedMs: 8 },
      { id: "evidence", label: "Evidence gate", status: "complete", elapsedMs: 9 },
      { id: "planning", label: "Planning", status: "complete", elapsedMs: 10 },
      { id: "writing", label: "Generating patch", status: "failed", elapsedMs: 12 },
      { id: "reviewing", label: "Reviewing patch", status: "skipped" },
      { id: "revising", label: "Revising patch", status: "skipped" },
      { id: "verifying", label: "Verifying patch", status: "skipped" },
    ],
    refusal: { kind: "insufficient_evidence", title: "Codex step timed out (patch writing)", reason: "One Codex step exceeded the limit.", suggestedNextStep: "Retry from scratch.", code: "CODEX_TIMEOUT" },
  };
}

test("a reviewer refusal renders without hiding the preserved patch versions", async ({ page }) => {
  await streamRun(page, completedRun("refused"));
  await page.goto("/");
  await page.getByLabel("GitHub issue URL").fill("https://github.com/fixture/repo/issues/1");
  const request = page.waitForRequest("**/api/runs**");
  await page.getByRole("button", { name: "Run investigation" }).click();
  await request;
  await expect(page.getByText("Patch Not Approved — Unresolved Concerns", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Patch v1" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Patch v2 (Revised)" })).toBeVisible();
  await expect(page.getByText("new file mode 100644")).toBeVisible();
});

test("a codex failure names the stage, shows the code, and links to logs", async ({ page }) => {
  const failed = {
    type: "failed",
    error: {
      code: "CODEX_TIMEOUT",
      title: "Codex step timed out (patch writing)",
      message: "One Codex step exceeded the 180s limit during patch writing.",
      retryable: true,
    },
    run: failedRun(),
  };
  await page.route("**/api/runs**", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: [`data: ${JSON.stringify(context)}`, `data: ${JSON.stringify(failed)}`].join("\n\n") + "\n\n",
  }));
  await page.goto("/");
  await page.getByLabel("GitHub issue URL").fill("https://github.com/fixture/repo/issues/1");
  const request = page.waitForRequest("**/api/runs**");
  await page.getByRole("button", { name: "Run investigation" }).click();
  await request;
  await expect(page.getByText("Failed at: Generating patch — Codex step timed out (patch writing)")).toBeVisible();
  await expect(page.getByText("code: CODEX_TIMEOUT", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "View logs" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry from scratch" })).toBeVisible();
  await expect(page.getByText("No patch yet — the PR button appears here once a patch is proposed.")).toBeVisible();
});
