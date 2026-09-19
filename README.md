# Codex Pilot

Paste a public GitHub issue and receive a focused, reviewable patch proposal. Codex Pilot visibly loads the issue, comments, repository tree, and a small set of relevant source files. It streams observable investigation milestones, asks the locally authenticated Codex CLI for structured edits, then runs a dedicated patch-review pass before building a downloadable unified diff.

## Run locally

```powershell
npm install
Copy-Item .env.example .env.local
codex login
npm run dev
```

Open `http://localhost:3000`. Add `GITHUB_TOKEN` to `.env.local` if GitHub’s unauthenticated API limit becomes restrictive.

## Hosting modes

- **Local live demo:** leave `CODEX_PILOT_LIVE_RUNS` unset (or set it to `true`), run `codex login`, then start the app with `npm run dev`.
- **Hosted sample preview:** set both `CODEX_PILOT_LIVE_RUNS=false` and `NEXT_PUBLIC_CODEX_PILOT_LIVE_RUNS=false` at build time. The page clearly labels its sample run and refuses submissions instead of attempting to access a Codex CLI session that the host does not have.

## Boundaries

- Public GitHub issues only; pull requests and private repositories are rejected for investigation.
- Repositories are read through GitHub’s REST API, capped at 25 MB and 10,000 files.
- The locally authenticated Codex CLI receives only the issue, comments, and selected file contents. It runs in an ephemeral, read-only sandbox with its shell tool disabled.
- The agent may replace content only in a file it inspected. Codex Pilot validates the replacements and generates the diff itself.
- Target repository code is never executed or tested by Codex Pilot.
- Pull requests are opt-in: set `CODEX_PILOT_ALLOW_PR=true` and `GITHUB_PR_TOKEN` (Contents + Pull requests write) on the local demo, tick the approval checkbox, and Codex Pilot shallow-clones the repo, applies the reviewed diff on a `codex-pilot/issue-N-*` feature branch, pushes that branch only, and opens a PR. It never pushes to the base branch. Hosted previews always refuse PRs.

## QA status

Codex Pilot labels generated changes **PATCH PROPOSED — NOT EXECUTED**. It captures the analyzed commit SHA and preserves the canonical diff and review record; download the patch and run repository-defined QA in an approved developer environment, or approve a feature-branch PR and review it on GitHub before merging.

The deterministic regression suite covers explicit requirement-to-plan-to-patch coverage, stable revision pinning, planner repair, patch persistence, bounded revisions, and manual-QA-only verification behavior.

If Codex cannot return a supported, confident edit, the app clearly refuses to offer an empty patch. GitHub rate limits, private or missing repositories, closed issues, unsupported files, and large repositories receive dedicated failure states.
