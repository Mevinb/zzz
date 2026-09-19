// Deterministic logger checks: ring buffer, filtering, redaction, clearing.
const assert = require('node:assert/strict');
const load = require('./load-pilot.cjs');
const logger = load('logger');

function silenceConsole(fn) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
}

(async () => {
  logger.clearLogs();

  // 1. Basic append + ordering.
  silenceConsole(() => {
    logger.logInfo('test', 'first message');
    logger.logWarn('test', 'second message', { code: 'W1' });
    logger.logError('test', 'third message', { code: 'E1', detail: 'some detail' });
  });
  let res = logger.getLogs({});
  assert.equal(res.entries.length, 3);
  assert.ok(res.entries[0].id < res.entries[1].id && res.entries[1].id < res.entries[2].id);
  assert.equal(res.entries[2].level, 'error');
  assert.equal(res.entries[2].code, 'E1');
  console.log('PASS log append preserves order and fields');

  // 2. Level filtering.
  res = logger.getLogs({ level: 'error' });
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].message, 'third message');
  res = logger.getLogs({ level: 'warn,error' });
  assert.equal(res.entries.length, 2);
  console.log('PASS level filtering works');

  // 3. Text search.
  res = logger.getLogs({ q: 'SECOND' });
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].level, 'warn');
  console.log('PASS text search works');

  // 4. Ring buffer cap (silenced: 520 console lines otherwise).
  silenceConsole(() => {
    for (let i = 0; i < 520; i += 1) logger.logInfo('flood', `message ${i}`);
  });
  res = logger.getLogs({ limit: 500 });
  assert.equal(res.entries.length, 500);
  assert.ok(res.dropped >= 20, `expected drops, got ${res.dropped}`);
  console.log('PASS ring buffer caps at 500 with drop accounting');

  // 5. Secret redaction.
  logger.clearLogs();
  const prev = process.env.GITHUB_PR_TOKEN;
  process.env.GITHUB_PR_TOKEN = 'sentinel-secret-xyz-123';
  try {
    silenceConsole(() => {
      logger.logError('test', 'failed with sentinel-secret-xyz-123 in output', { detail: 'token sentinel-secret-xyz-123 here' });
    });
  } finally {
    if (prev === undefined) delete process.env.GITHUB_PR_TOKEN;
    else process.env.GITHUB_PR_TOKEN = prev;
  }
  res = logger.getLogs({});
  assert.equal(res.entries.length, 1);
  assert.ok(!res.entries[0].message.includes('sentinel-secret-xyz-123'), 'message redacted');
  assert.ok(!res.entries[0].detail.includes('sentinel-secret-xyz-123'), 'detail redacted');
  console.log('PASS token material is redacted');

  // 6. Truncation + clearing.
  silenceConsole(() => {
    logger.logInfo('test', 'x'.repeat(5000));
  });
  res = logger.getLogs({});
  assert.ok(res.entries[res.entries.length - 1].message.length <= 2001);
  logger.clearLogs();
  res = logger.getLogs({});
  assert.equal(res.entries.length, 0);
  assert.equal(res.dropped, 0);
  console.log('PASS truncation and clearing work');

  console.log('PASS logger is bounded and redacted');
})().catch((error) => { console.error(error); process.exit(1); });
