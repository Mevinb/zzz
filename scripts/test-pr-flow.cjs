// Deterministic PR-flow checks: mocked git + GitHub API, never touches the network or disk.
const assert = require('node:assert/strict');
const load = require('./load-pilot.cjs');
const pr = load('pull-request');

const ISSUE = { number: 42, title: 'Fix the thing', repository: 'acme/repo', url: 'https://github.com/acme/repo/issues/42' };
const PATCH = 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n';

function baseInput(overrides = {}) {
  return {
    repositoryUrl: 'https://github.com/acme/repo',
    branch: 'main',
    commit: 'abcdef1234567890abcdef1234567890abcdef12',
    patch: PATCH,
    issue: { ...ISSUE },
    summary: 'Test summary',
    filesChanged: 1,
    additions: 1,
    deletions: 1,
    ...overrides,
  };
}

// Minimal Headers stub for the module's githubApi return shape.
function headers() {
  return { get: () => null };
}

// Mock git runner driven by a handler: (args, cwd) => {stdout} or throw.
function mockGit(handler) {
  const calls = [];
  const run = async (args, cwd, opts) => {
    calls.push({ args, cwd, hasAuth: Boolean(opts && opts.authToken) });
    return handler(args, cwd, opts);
  };
  run.calls = calls;
  return run;
}

function happyGit() {
  return mockGit((args) => {
    const cmd = args.filter((a) => !a.startsWith('-c') && a !== 'http.extraHeader=AUTHORIZATION: basic xxx')[0];
    // Note: default runner prefixes -c http.extraHeader for authed calls; mocks ignore it.
    const verb = args.includes('clone') ? 'clone' : args.includes('checkout') && args.includes('-b') ? 'checkout-b'
      : args[0] === 'checkout' ? 'checkout'
      : args[0] === 'fetch' ? 'fetch'
      : args[0] === 'rev-parse' ? 'rev-parse'
      : args[0] === 'apply' ? 'apply'
      : args[0] === 'diff' ? 'diff'
      : args[0] === 'status' ? 'status'
      : args[0] === 'push' ? 'push'
      : args[0] === 'commit' ? 'commit'
      : args[0] === 'ls-remote' ? 'ls-remote'
      : cmd;
    switch (verb) {
      case 'clone': return { stdout: '', stderr: '' };
      case 'rev-parse': return { stdout: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n', stderr: '' };
      case 'checkout-b':
      case 'checkout':
      case 'fetch':
      case 'apply':
      case 'diff':
      case 'commit':
      case 'ls-remote': return { stdout: '', stderr: '' };
      case 'status': return { stdout: ' M a.txt\n', stderr: '' };
      case 'push': return { stdout: '', stderr: '' };
      default: return { stdout: '', stderr: '' };
    }
  });
}

function mockFetch(routes) {
  return async (url, init) => {
    const method = (init && init.method) || 'GET';
    const key = `${method} ${url}`;
    for (const [match, response] of routes) {
      if (key.startsWith(match)) {
        return { status: response.status, headers: headers(), json: async () => response.body };
      }
    }
    throw new Error(`unexpected fetch: ${key}`);
  };
}

function withPrEnv(vars, fn) {
  const prev = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

(async () => {
  // 1. Repository URL validation.
  assert.deepEqual(pr.parseRepositoryUrl('https://github.com/acme/repo'), { owner: 'acme', repo: 'repo' });
  assert.deepEqual(pr.parseRepositoryUrl('https://github.com/acme/repo.git'), { owner: 'acme', repo: 'repo' });
  for (const bad of ['https://evil.com/acme/repo', 'https://github.com/acme', 'not a url']) {
    let code = null;
    try {
      pr.parseRepositoryUrl(bad);
    } catch (err) {
      code = err && err.code;
    }
    assert.equal(code, 'invalid_target', `rejects ${bad}`);
  }
  console.log('PASS repository URL validation');

  // 2. Branch validation blocks injection.
  assert.equal(pr.isSafeBaseBranch('main'), true);
  assert.equal(pr.isSafeBaseBranch('release/1.x'), true);
  assert.equal(pr.isSafeBaseBranch('main; rm -rf /'), false);
  assert.equal(pr.isSafeBaseBranch('../escape'), false);
  assert.equal(pr.isSafeBaseBranch('-evil'), false);
  assert.equal(pr.isSafeBaseBranch('a@{b'), false);
  console.log('PASS base branch validation');

  // 3. Branch/commit/PR message builders.
  const branch = pr.buildBranchName(42, 'ABCDEF123456', 'a1b2');
  assert.match(branch, /^codex-pilot\/issue-42-abcdef1-a1b2$/);
  assert.match(pr.buildCommitMessage(ISSUE), /Closes https:\/\/github\.com\/acme\/repo\/issues\/42/);
  assert.match(pr.buildPrTitle(ISSUE), /Fix #42/);
  const body = pr.buildPrBody(baseInput(), 'deadbeef1234');
  assert.match(body, /Fixes https:\/\/github\.com\/acme\/repo\/issues\/42/);
  console.log('PASS branch and message builders');

  // 4. Happy path (branch mode): clone -> apply -> push -> PR 201.
  await withPrEnv({ GITHUB_PR_TOKEN: 'test-token-123', CODEX_PILOT_PR_MODE: 'branch' }, async () => {
    const git = happyGit();
    let cleaned = false;
    const events = [];
    const fetchImpl = mockFetch([
      ['POST https://api.github.com/repos/acme/repo/pulls', { status: 201, body: { html_url: 'https://github.com/acme/repo/pull/7', number: 7 } }],
    ]);
    const result = await pr.openPullRequest(baseInput(), {
      git,
      fetchImpl,
      createWorkspace: async () => '/tmp/ws-test',
      removeWorkspace: async () => { cleaned = true; },
      writePatchFile: async () => {},
      randomSuffix: () => 'a1b2',
    }, (e) => events.push(e));
    assert.equal(result.prUrl, 'https://github.com/acme/repo/pull/7');
    assert.equal(result.prNumber, 7);
    assert.match(result.branch, /^codex-pilot\/issue-42-/);
    assert.equal(result.owner, 'acme');
    assert.equal(cleaned, true);
    assert.ok(events.some((e) => e.type === 'completed'), 'emits completed');
    // Push must carry auth; clone must not need it (public clone URL).
    const pushCall = git.calls.find((c) => c.args.includes('push'));
    assert.ok(pushCall && pushCall.hasAuth, 'push uses auth header, not URL token');
    const cloneCall = git.calls.find((c) => c.args.includes('clone'));
    assert.ok(cloneCall && cloneCall.args.join(' ').includes('https://github.com/acme/repo.git'), 'clones public URL without token');
    assert.ok(!git.calls.join(' ').includes('test-token-123'), 'token never appears in git args');
  });
  console.log('PASS happy path opens a PR without leaking the token');

  // 5. Patch that does not apply cleanly fails with a typed error and still cleans up.
  await withPrEnv({ GITHUB_PR_TOKEN: 'tok', CODEX_PILOT_PR_MODE: 'branch' }, async () => {
    const git = mockGit((args) => {
      if (args[0] === 'clone') return { stdout: '', stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: 'deadbeef\n', stderr: '' };
      if (args[0] === 'checkout') return { stdout: '', stderr: '' };
      if (args[0] === 'apply') throw new Error('error: patch failed: a.txt:1');
      return { stdout: '', stderr: '' };
    });
    let cleaned = false;
    await assert.rejects(
      () => pr.openPullRequest(baseInput(), {
        git,
        fetchImpl: mockFetch([]),
        createWorkspace: async () => '/tmp/ws-fail',
        removeWorkspace: async () => { cleaned = true; },
        writePatchFile: async () => {},
      randomSuffix: () => 'zzzz',
      }),
      (err) => err && err.code === 'patch_apply_failed'
    );
    assert.equal(cleaned, true);
  });
  console.log('PASS unappliable patch fails closed with cleanup');

  // 6. GitHub 403 on PR creation surfaces pr_forbidden (branch mode hint).
  await withPrEnv({ GITHUB_PR_TOKEN: 'tok', CODEX_PILOT_PR_MODE: 'branch' }, async () => {
    const fetchImpl = mockFetch([
      ['POST https://api.github.com/repos/acme/repo/pulls', { status: 403, body: { message: 'Resource not accessible by personal access token' } }],
    ]);
    await assert.rejects(
      () => pr.openPullRequest(baseInput(), {
        git: happyGit(),
        fetchImpl,
        createWorkspace: async () => '/tmp/ws-403',
        removeWorkspace: async () => {},
        writePatchFile: async () => {},
      randomSuffix: () => 'qwer',
      }),
      (err) => err && err.code === 'pr_forbidden'
    );
  });
  console.log('PASS PR permission errors are typed');

  // 7. Evil repository URLs never reach git or the network.
  await withPrEnv({ GITHUB_PR_TOKEN: 'tok' }, async () => {
    let touched = false;
    const git = mockGit(() => { touched = true; return { stdout: '', stderr: '' }; });
    const fetchImpl = async () => { touched = true; throw new Error('must not fetch'); };
    await assert.rejects(
      () => pr.openPullRequest(baseInput({ repositoryUrl: 'https://evil.com/acme/repo' }), {
        git, fetchImpl, createWorkspace: async () => '/tmp/ws-evil', removeWorkspace: async () => {}, randomSuffix: () => 'evil',
      }),
      (err) => err && err.code === 'invalid_target'
    );
    assert.equal(touched, false);
  });
  console.log('PASS untrusted repository URLs are rejected before clone');

  // 8. Token material is redacted from surfaced errors.
  await withPrEnv({ GITHUB_PR_TOKEN: 'super-secret-token-xyz' }, async () => {
    const git = mockGit((args) => {
      if (args[0] === 'clone') throw new Error('clone failed with super-secret-token-xyz in output');
      return { stdout: '', stderr: '' };
    });
    await assert.rejects(
      () => pr.openPullRequest(baseInput(), {
        git,
        fetchImpl: mockFetch([]),
        createWorkspace: async () => '/tmp/ws-redact',
        removeWorkspace: async () => {},
        writePatchFile: async () => {},
      randomSuffix: () => 'red1',
      }),
      (err) => err && typeof err.message === 'string' && !err.message.includes('super-secret-token-xyz')
    );
  });
  console.log('PASS token material is redacted from errors');

  // 9. Missing token fails before any workspace work.
  await withPrEnv({ GITHUB_PR_TOKEN: undefined, GITHUB_TOKEN: undefined }, async () => {
    let workspaces = 0;
    await assert.rejects(
      () => pr.openPullRequest(baseInput(), {
        git: happyGit(),
        fetchImpl: mockFetch([]),
        createWorkspace: async () => { workspaces += 1; return '/tmp/ws-notoken'; },
        removeWorkspace: async () => {},
        writePatchFile: async () => {},
      randomSuffix: () => 'ntok',
      }),
      (err) => err && err.code === 'github_auth_missing'
    );
    assert.equal(workspaces, 0);
  });
  console.log('PASS missing token fails before cloning');

  console.log('PASS pr flow is mocked end-to-end');
})().catch((error) => { console.error(error); process.exit(1); });
