const assert = require('node:assert/strict');
(async () => {
  const base = process.argv[2] || 'http://localhost:3005';
  const page = await fetch(base); assert.equal(page.status, 200);
  const html = await page.text();
  for (const text of ['SAMPLE RUN', 'Repository evidence', 'Evidence gate', 'PATCH PROPOSED', 'Revising patch', 'skipped', 'useTheme.ts']) assert.ok(html.includes(text), `Missing sample UI: ${text}`);
  const run = await fetch(base + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ issueUrl: 'https://github.com/lukeed/clsx/issues/92' }) });
  assert.match(await run.text(), /hosted_preview/);
  const pr = await fetch(base + '/api/pull-requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repositoryUrl: 'https://github.com/fixture/repo', branch: 'main', patch: 'diff --git a', issue: { number: 1, title: 't', repository: 'fixture/repo', url: 'https://github.com/fixture/repo/issues/1' } }) });
  assert.match(await pr.text(), /hosted_preview/);
  const logs = await fetch(base + '/api/logs?limit=5');
  assert.equal(logs.status, 200);
  const logged = await logs.json();
  assert.ok(Array.isArray(logged.entries), 'Logs endpoint returns entries');
  console.log('PASS hosted sample structure and live-execution guard');
})().catch((error) => { console.error(error); process.exitCode = 1; });
