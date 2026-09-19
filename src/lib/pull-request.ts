import "server-only";

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type PullRequestIssue = {
  number: number;
  title: string;
  repository: string;
  url: string;
};

export type PullRequestInput = {
  repositoryUrl: string;
  /** Base branch to clone and target for the PR (e.g. "main"). */
  branch: string;
  /** Pinned commit SHA the patch was generated against (optional). */
  commit?: string;
  /** Unified diff produced by the pilot run. */
  patch: string;
  issue: PullRequestIssue;
  summary?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
};

export type PullRequestResult = {
  branch: string;
  baseBranch: string;
  prUrl: string;
  prNumber: number | null;
  owner: string;
  repo: string;
  commitSha: string | null;
  forkOwner: string | null;
};

export type PullRequestEvent =
  | { type: "stage"; stage: { id: string; label: string; status: "active" | "complete" | "failed"; detail?: string } }
  | { type: "activity"; activity: { action: string; detail: string } }
  | { type: "completed"; result: PullRequestResult }
  | { type: "failed"; error: { code: string; title: string; message: string; retryable?: boolean } };

export type GitRunResult = { stdout: string; stderr: string };
export type GitRunner = (
  args: string[],
  cwd: string,
  opts?: { timeoutMs?: number; authToken?: string | null }
) => Promise<GitRunResult>;
export type FetchImpl = typeof fetch;

export type PullRequestDeps = {
  git?: GitRunner;
  fetchImpl?: FetchImpl;
  createWorkspace?: () => Promise<string>;
  removeWorkspace?: (workspace: string) => Promise<void>;
  writePatchFile?: (path: string, content: string) => Promise<void>;
  randomSuffix?: () => string;
};

const GITHUB_API = "https://api.github.com";
const MAX_PATCH_BYTES = 1_000_000;
const OWNER_REPO_PART = /^[A-Za-z0-9_.-]+$/;
// Conservative ref rules: no spaces, no shell metachars, no `..`, no `@{`.
const SAFE_BRANCH = /^[A-Za-z0-9_./-]{1,200}$/;
const FORBIDDEN_BRANCH_FRAGMENTS = ["..", "@{", "//", "~", "^", ":", "?", "*", "[", "\\", " "];

export function isHostedPreview(): boolean {
  return process.env.CODEX_PILOT_LIVE_RUNS === "false" || process.env.VERCEL === "1";
}

export function isPrEnabled(): boolean {
  return process.env.CODEX_PILOT_ALLOW_PR === "true";
}

export function getPrMode(): "branch" | "fork" {
  return process.env.CODEX_PILOT_PR_MODE === "fork" ? "fork" : "branch";
}

export function resolvePrToken(): string | null {
  const token = process.env.GITHUB_PR_TOKEN || process.env.GITHUB_TOKEN;
  return token && token.trim().length > 0 ? token.trim() : null;
}

export function parseRepositoryUrl(repositoryUrl: string): { owner: string; repo: string } {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw prError("invalid_target", "Invalid repository URL", "Expected an https://github.com/owner/repo URL.");
  }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname)) {
    throw prError("invalid_target", "Unsupported git host", "Codex Pilot opens PRs on github.com repositories only.");
  }
  const parts = url.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
  if (parts.length !== 2 || !OWNER_REPO_PART.test(parts[0]) || !OWNER_REPO_PART.test(parts[1])) {
    throw prError("invalid_target", "Invalid repository URL", "Expected an https://github.com/owner/repo URL.");
  }
  return { owner: parts[0], repo: parts[1] };
}

export function isSafeBaseBranch(branch: unknown): branch is string {
  if (typeof branch !== "string" || branch.length === 0 || branch.length > 200) return false;
  if (!SAFE_BRANCH.test(branch)) return false;
  if (FORBIDDEN_BRANCH_FRAGMENTS.some((frag) => branch.includes(frag))) return false;
  if (branch.startsWith("/") || branch.startsWith(".") || branch.startsWith("-")) return false;
  if (branch.endsWith("/") || branch.endsWith(".lock") || branch.endsWith(".")) return false;
  return true;
}

function prError(code: string, title: string, message: string, retryable = false) {
  return { code, title, message, retryable };
}

function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

function authHeaderValue(token: string): string {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

export function buildBranchName(issueNumber: number, commit: string | undefined, randomSuffix: string): string {
  const short = commit && /^[0-9a-f]{4,64}$/i.test(commit) ? commit.slice(0, 7).toLowerCase() : "base";
  const rand = (randomSuffix || "0000").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6) || "0000";
  return `codex-pilot/issue-${issueNumber}-${short}-${rand}`;
}

export function buildCommitMessage(issue: PullRequestIssue): string {
  const title = issue.title.length > 120 ? `${issue.title.slice(0, 117)}...` : issue.title;
  return `Fix #${issue.number}: ${title}\n\nCloses ${issue.url}\n\nOpened by Codex Pilot. Please review before merging.`;
}

export function buildPrTitle(issue: PullRequestIssue): string {
  const title = issue.title.length > 150 ? `${issue.title.slice(0, 147)}...` : issue.title;
  return `Fix #${issue.number}: ${title}`;
}

export function buildPrBody(input: PullRequestInput, commitSha: string | null): string {
  const lines = [
    `Fixes ${input.issue.url}`,
    "",
    input.summary ? input.summary : "Automated patch proposal from Codex Pilot.",
    "",
    "---",
    `Base: \`${input.branch}\`${commitSha ? ` @ \`${commitSha.slice(0, 12)}\`` : ""}`,
    typeof input.filesChanged === "number"
      ? `Patch: ${input.filesChanged} file(s) changed${typeof input.additions === "number" ? ` (+${input.additions}/-${input.deletions ?? 0})` : ""}`
      : null,
    "",
    "Reviewer: please review the diff carefully before merging. This PR was generated automatically and was not executed against the target repository unless noted in the run.",
  ].filter((line): line is string => line !== null);
  return lines.join("\n").slice(0, 6000);
}

function defaultGitRunner(): GitRunner {
  return (args, cwd, opts) =>
    new Promise<GitRunResult>((resolve, reject) => {
      const timeoutMs = opts?.timeoutMs ?? 60_000;
      // Auth is passed via -c http.extraHeader so the token never appears in the remote URL.
      const finalArgs =
        opts?.authToken != null
          ? ["-c", `http.extraHeader=${authHeaderValue(opts.authToken)}`, ...args]
          : args;
      const child = spawn("git", finalArgs, { cwd, windowsHide: true, shell: false, timeout: timeoutMs });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout = `${stdout}${String(chunk)}`.slice(-20_000);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = `${stderr}${String(chunk)}`.slice(-20_000);
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(stderr.trim() || stdout.trim() || `git ${args[0] ?? ""} exited with status ${code}`));
      });
    });
}

async function githubApi<T>(
  fetchImpl: FetchImpl,
  path: string,
  token: string,
  init?: { method?: string; body?: unknown }
): Promise<{ status: number; data: T; headers: Headers }> {
  const response = await fetchImpl(`${GITHUB_API}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "codex-pilot",
      Authorization: `Bearer ${token}`,
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  let data: T = {} as T;
  try {
    data = (await response.json()) as T;
  } catch {
    data = {} as T;
  }
  return { status: response.status, data, headers: response.headers };
}

function validateInput(input: PullRequestInput): void {
  if (!input || typeof input !== "object") throw prError("invalid_target", "Invalid PR request", "A valid PR request body is required.");
  parseRepositoryUrl(input.repositoryUrl);
  if (!isSafeBaseBranch(input.branch)) {
    throw prError("invalid_target", "Invalid base branch", "Base branch contains unsupported characters or segments.");
  }
  if (input.commit !== undefined && input.commit !== null && input.commit !== "") {
    if (!/^[0-9a-f]{4,64}$/i.test(input.commit)) {
      throw prError("invalid_target", "Invalid commit SHA", "Commit must be a hex SHA when provided.");
    }
  }
  if (typeof input.patch !== "string" || !input.patch.trim()) {
    throw prError("patch_invalid", "A valid patch diff is required", "Provide the unified diff generated for this issue.");
  }
  if (Buffer.byteLength(input.patch, "utf8") > MAX_PATCH_BYTES) {
    throw prError("patch_invalid", "Patch is too large", "Patches larger than 1 MB cannot be opened as a PR.");
  }
  if (!input.patch.includes("@@") && !input.patch.includes("diff --git")) {
    throw prError("patch_invalid", "Patch does not look like a diff", "Provide a unified diff with hunk headers.");
  }
  if (!input.issue || typeof input.issue.number !== "number" || !Number.isInteger(input.issue.number) || input.issue.number <= 0) {
    throw prError("invalid_target", "Invalid issue", "Issue number must be a positive integer.");
  }
  if (typeof input.issue.url !== "string" || !input.issue.url.includes("/issues/")) {
    throw prError("invalid_target", "Invalid issue URL", "Provide the public GitHub issue URL this PR fixes.");
  }
}

export async function openPullRequest(
  input: PullRequestInput,
  deps: PullRequestDeps = {},
  onEvent?: (event: PullRequestEvent) => void
): Promise<PullRequestResult> {
  validateInput(input);
  const emit = (event: PullRequestEvent) => {
    try {
      onEvent?.(event);
    } catch {
      // Event sinks must never break the PR flow.
    }
  };
  const stage = (id: string, label: string, status: "active" | "complete" | "failed", detail?: string) =>
    emit({ type: "stage", stage: { id, label, status, detail } });
  const activity = (action: string, detail: string) => emit({ type: "activity", activity: { action, detail } });

  const token = resolvePrToken();
  if (!token) {
    throw prError(
      "github_auth_missing",
      "GitHub write token is missing",
      "Set GITHUB_PR_TOKEN (or GITHUB_TOKEN with Contents + Pull requests write) on the server to open PRs.",
      false
    );
  }

  const { owner, repo } = parseRepositoryUrl(input.repositoryUrl);
  const mode = getPrMode();
  const git = deps.git ?? defaultGitRunner();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const createWorkspace = deps.createWorkspace ?? (() => mkdtemp(join(tmpdir(), "codex-pr-")));
  const removeWorkspace = deps.removeWorkspace ?? ((workspace: string) => rm(workspace, { recursive: true, force: true }));
  const writePatchFile = deps.writePatchFile ?? ((path: string, content: string) => writeFile(path, content, "utf8"));
  const suffix = (deps.randomSuffix?.() ?? Math.random().toString(16).slice(2, 6).padEnd(4, "0")).slice(0, 6);
  const branch = buildBranchName(input.issue.number, input.commit, suffix);
  const secrets = [token, Buffer.from(`x-access-token:${token}`).toString("base64")];

  // Confirm the repository actually exists before creating workspaces or forks.
  // A missing repo (e.g. sample data) fails here instead of surfacing as a
  // confusing fork/push error later. Network errors are ignored so a blip
  // never blocks a real PR — the clone step will report them clearly.
  try {
    const seen = await githubApi<{ private?: boolean; archived?: boolean; disabled?: boolean }>(
      fetchImpl,
      `/repos/${owner}/${repo}`,
      token
    );
    if (seen.status === 404) {
      throw prError(
        "invalid_target",
        "Repository not found on GitHub",
        `No repository ${owner}/${repo} exists — this looks like sample data. Run a live investigation on a real public issue first.`,
        false
      );
    }
    if (seen.status === 200 && seen.data) {
      if (seen.data.private) {
        throw prError("invalid_target", "Private repositories are not supported", "Codex Pilot opens PRs on public repositories only.", false);
      }
      if (seen.data.archived || seen.data.disabled) {
        throw prError("invalid_target", "Repository unavailable", "This repository is archived or disabled.", false);
      }
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) throw error;
    // Network blip — continue; clone/push will surface real problems.
  }

  const workspace = await createWorkspace();
  const repoDir = join(workspace, "repo");
  let forkOwner: string | null = null;
  let cloneUrl = `https://github.com/${owner}/${repo}.git`;
  let prHead = branch;

  try {
    if (mode === "fork") {
      stage("fork", "Forking repository", "active");
      const me = await githubApi<{ login?: string }>(fetchImpl, "/user", token);
      const login = me.data?.login;
      if (!login) throw prError("pr_forbidden", "Could not determine fork owner", "GitHub did not return the authenticated user for the fork.", false);
      // Reuse a fork created earlier (e.g. in the browser): creating a fork via
      // the API fails for some token types even when reading works fine.
      const existing = await githubApi<{ full_name?: string; fork?: boolean }>(
        fetchImpl,
        `/repos/${login}/${repo}`,
        token
      );
      if (existing.status === 200 && existing.data?.full_name?.toLowerCase() === `${login.toLowerCase()}/${repo.toLowerCase()}`) {
        forkOwner = login;
        activity("Reusing existing fork", `Found ${forkOwner}/${repo}; skipping fork creation.`);
      } else {
        activity("Creating fork", `Forking ${owner}/${repo} for PR head ${branch}.`);
        const forked = await githubApi<{ full_name?: string; owner?: { login?: string } }>(
          fetchImpl,
          `/repos/${owner}/${repo}/forks`,
          token,
          { method: "POST", body: {} }
        );
        if (forked.status !== 202 && forked.status !== 200 && forked.status !== 201) {
          const message = redactSecrets(JSON.stringify(forked.data).slice(0, 500) || `status ${forked.status}`, secrets);
          throw prError(
            "pr_forbidden",
            "Could not fork repository",
            `GitHub refused to create the fork (status ${forked.status}). ${message} Fine-grained tokens often cannot create forks even when reading works: fork ${owner}/${repo} in your browser (github.com/${owner}/${repo} → Fork) and retry — Codex Pilot will reuse it — or use a classic PAT with the public_repo scope.`,
            forked.status >= 500
          );
        }
        forkOwner = forked.data?.owner?.login ?? login;
      }
      cloneUrl = `https://github.com/${forkOwner}/${repo}.git`;
      prHead = `${forkOwner}:${branch}`;
      // Forks need a moment to become cloneable.
      let ready = false;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await git(["ls-remote", cloneUrl, "HEAD"], workspace, { timeoutMs: 20_000 });
          ready = true;
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
      if (!ready) throw prError("clone_failed", "Fork is not ready yet", "The fork was created but is not cloneable yet. Please retry.", true);
      stage("fork", "Forking repository", "complete", `Fork ready at ${forkOwner}/${repo}.`);
    }

    stage("clone", "Cloning repository", "active", `Shallow clone of ${owner}/${repo}@${input.branch}.`);
    activity("Cloning repository", `Cloning ${owner}/${repo} branch ${input.branch} (depth 1).`);
    try {
      await git(
        ["clone", "--depth", "1", "--single-branch", "--no-tags", "--branch", input.branch, cloneUrl, repoDir],
        workspace,
        { timeoutMs: 120_000 }
      );
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 800);
      throw prError("clone_failed", "Could not clone repository", detail || "git clone failed.", true);
    }
    stage("clone", "Cloning repository", "complete");

    // Best-effort pin to the analyzed commit. Shallow clones may not contain it; fall back to branch tip.
    let commitSha: string | null = null;
    try {
      const tip = await git(["rev-parse", "HEAD"], repoDir, { timeoutMs: 15_000 });
      commitSha = tip.stdout.trim() || null;
    } catch {
      commitSha = null;
    }
    if (input.commit && commitSha?.toLowerCase() !== input.commit.toLowerCase()) {
      activity("Pinning commit", `Attempting to check out ${input.commit.slice(0, 12)}; falling back to branch tip if unavailable.`);
      try {
        await git(["fetch", "origin", input.commit, "--depth", "1"], repoDir, { timeoutMs: 60_000 });
        await git(["checkout", input.commit], repoDir, { timeoutMs: 15_000 });
        commitSha = input.commit;
      } catch {
        activity("Using branch tip", "Pinned commit is unavailable in a shallow clone; continuing from the branch tip.");
        try {
          const tip = await git(["rev-parse", "HEAD"], repoDir, { timeoutMs: 15_000 });
          commitSha = tip.stdout.trim() || commitSha;
        } catch {
          // Keep previous value.
        }
      }
    }

    stage("apply", "Applying patch", "active");
    activity("Applying patch", `Applying the reviewed unified diff on ${branch}.`);
    const patchPath = join(workspace, "pilot.patch");
    await writePatchFile(patchPath, input.patch.endsWith("\n") ? input.patch : `${input.patch}\n`);
    try {
      await git(["checkout", "-b", branch], repoDir, { timeoutMs: 15_000 });
      await git(["apply", "--check", "--whitespace=fix", patchPath], repoDir, { timeoutMs: 15_000 });
      await git(["apply", "--whitespace=fix", "--index", patchPath], repoDir, { timeoutMs: 15_000 });
      await git(["diff", "--cached", "--check", "--whitespace=fix"], repoDir, { timeoutMs: 15_000 });
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 1000);
      stage("apply", "Applying patch", "failed", detail);
      throw prError("patch_apply_failed", "Patch does not apply cleanly", detail || "git apply reported an error. The base branch may have moved.", false);
    }
    const status = await git(["status", "--porcelain"], repoDir, { timeoutMs: 15_000 });
    if (!status.stdout.trim()) {
      throw prError("patch_apply_failed", "Patch produced no changes", "The diff applied but left the working tree clean. Nothing to open a PR for.", false);
    }
    stage("apply", "Applying patch", "complete");

    stage("push", "Pushing branch", "active", `Pushing ${branch} (feature branch only; never ${input.branch}).`);
    activity("Committing changes", `Committing on ${branch}.`);
    try {
      await git(
        [
          "-c",
          "user.name=codex-pilot",
          "-c",
          "user.email=codex-pilot@users.noreply.github.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-m",
          buildCommitMessage(input.issue),
        ],
        repoDir,
        { timeoutMs: 30_000 }
      );
      const head = await git(["rev-parse", "HEAD"], repoDir, { timeoutMs: 15_000 });
      if (head.stdout.trim()) commitSha = head.stdout.trim();
      // Push only the feature branch. Never push the base branch.
      await git(["push", "origin", branch], repoDir, { timeoutMs: 60_000, authToken: token });
    } catch (error) {
      const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets).slice(0, 1000);
      stage("push", "Pushing branch", "failed", detail);
      throw prError("push_failed", "Could not push the PR branch", detail || "git push failed.", true);
    }
    stage("push", "Pushing branch", "complete");

    stage("pr", "Opening pull request", "active", `Opening a PR from ${prHead} into ${input.branch}.`);
    activity("Opening pull request", `Creating a PR from ${prHead} into ${owner}/${repo}@${input.branch}.`);
    const created = await githubApi<{ html_url?: string; number?: number }>(fetchImpl, `/repos/${owner}/${repo}/pulls`, token, {
      method: "POST",
      body: { title: buildPrTitle(input.issue), head: prHead, base: input.branch, body: buildPrBody(input, commitSha), maintainer_can_modify: true, draft: false },
    });
    if (created.status === 201 && created.data?.html_url) {
      const result: PullRequestResult = {
        branch,
        baseBranch: input.branch,
        prUrl: created.data.html_url,
        prNumber: typeof created.data.number === "number" ? created.data.number : null,
        owner,
        repo,
        commitSha,
        forkOwner,
      };
      stage("pr", "Opening pull request", "complete", result.prUrl);
      emit({ type: "completed", result });
      return result;
    }
    if (created.status === 422) {
      // A PR from this head may already exist; surface the open one instead of failing.
      try {
        const existing = await githubApi<{ html_url?: string; number?: number }[]>(
          fetchImpl,
          `/repos/${owner}/${repo}/pulls?state=open&head=${encodeURIComponent(mode === "fork" && forkOwner ? `${forkOwner}:${branch}` : `${owner}:${branch}`)}&per_page=5`,
          token
        );
        const first = Array.isArray(existing.data) ? existing.data[0] : undefined;
        if (first?.html_url) {
          const result: PullRequestResult = {
            branch,
            baseBranch: input.branch,
            prUrl: first.html_url,
            prNumber: typeof first.number === "number" ? first.number : null,
            owner,
            repo,
            commitSha,
            forkOwner,
          };
          stage("pr", "Opening pull request", "complete", `PR already exists: ${result.prUrl}`);
          emit({ type: "completed", result });
          return result;
        }
      } catch {
        // Fall through to the generic 422 error below.
      }
      const detail = redactSecrets(JSON.stringify(created.data).slice(0, 800), secrets);
      throw prError("pr_create_failed", "GitHub refused the PR", detail || "GitHub returned 422 for the pull request.", false);
    }
    if (created.status === 403 || created.status === 404) {
      const detail = redactSecrets(JSON.stringify(created.data).slice(0, 800), secrets);
      throw prError(
        "pr_forbidden",
        "No permission to open this PR",
        mode === "branch"
          ? `GitHub refused (status ${created.status}). The token cannot push/PR to ${owner}/${repo}; set CODEX_PILOT_PR_MODE=fork or use a token with access. ${detail}`
          : `GitHub refused (status ${created.status}). ${detail}`,
        false
      );
    }
    const detail = redactSecrets(JSON.stringify(created.data).slice(0, 800) || `status ${created.status}`, secrets);
    throw prError("pr_create_failed", "Could not open the PR", detail, created.status >= 500);
  } finally {
    try {
      await removeWorkspace(workspace);
    } catch {
      // Cleanup failures must not mask the PR result.
    }
  }
}
