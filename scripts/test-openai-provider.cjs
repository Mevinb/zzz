// Deterministic OpenAI-provider checks: mocked fetch, never touches the network.
const assert = require('node:assert/strict');
const load = require('./load-pilot.cjs');
const provider = load('openai-provider');
const pilot = load('pilot');

const KEY = 'sk-test-secret-xyz-999';

function mockFetch(status, body, capture) {
  return async (url, init) => {
    capture.url = url;
    capture.init = init;
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
}

function okResponse(text) {
  return { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] };
}

function assertNoLeak(value) {
  assert.ok(!JSON.stringify(value).includes(KEY), 'API key never appears in errors or payloads echoed back');
}

(async () => {
  // 1. Sanitizer strips strict-forbidden bounds but keeps the contract.
  const dirty = {
    type: 'object', additionalProperties: false, required: ['name', 'tags', 'n'],
    properties: {
      name: { type: 'string', minLength: 1, maxLength: 50 },
      tags: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
      n: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
  const clean = provider.sanitizeSchemaForStrict(dirty);
  assert.deepEqual(clean, {
    type: 'object', additionalProperties: false, required: ['name', 'tags', 'n'],
    properties: { name: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, n: { type: 'number' } },
  });
  // Input object is not mutated.
  assert.equal(dirty.properties.name.minLength, 1);
  console.log('PASS strict sanitizer strips bounds and preserves the contract');

  // 2. Every shipped agent schema stays strict-clean after sanitizing.
  for (const [name, schema] of [['coder', pilot.coderSchema], ['reviewer', pilot.reviewSchema], ['planner', pilot.plannerSchema], ['explorer', pilot.explorerSchema]]) {
    const cleaned = provider.sanitizeSchemaForStrict(schema);
    const top = cleaned;
    for (const key of Object.keys(top.properties || {})) {
      assert.ok((top.required || []).includes(key), `${name}: ${key} still required after sanitize`);
    }
  }
  console.log('PASS shipped schemas stay strict-clean after sanitizing');

  // 3. Happy path posts strict JSON-schema output and returns the text.
  {
    const capture = {};
    const run = provider.createOpenAIRunner({
      apiKey: KEY,
      model: 'gpt-5',
      fetchImpl: mockFetch(200, okResponse('{"changes":[]}'), capture),
    });
    const text = await run('do it', { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'string', minLength: 2 } } });
    assert.equal(text, '{"changes":[]}');
    assert.equal(capture.url, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(capture.init.body);
    assert.equal(body.model, 'gpt-5');
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.ok(!('minLength' in body.text.format.schema.properties.a), 'bounds stripped on the wire');
    assert.equal(capture.init.headers.Authorization, `Bearer ${KEY}`);
  }
  console.log('PASS runner posts strict output and returns text');

  // 4. Model refusal surfaces as a typed non-retryable error.
  {
    const run = provider.createOpenAIRunner({
      apiKey: KEY,
      fetchImpl: mockFetch(200, { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'nope' }] }] }, {}),
    });
    await assert.rejects(() => run('x'), (err) => err && err.code === 'OPENAI_REFUSED' && err.retryable === false);
  }
  console.log('PASS model refusals are typed');

  // 5. Auth, rate-limit, and request failures are typed; key never leaks.
  {
    const cases = [
      [401, {}, 'OPENAI_AUTH', false],
      [429, {}, 'OPENAI_RATE_LIMITED', true],
      [400, { error: { message: 'bad model (key sk-test-secret-xyz-999 ignored)' } }, 'OPENAI_REQUEST_FAILED', false],
      [500, {}, 'OPENAI_REQUEST_FAILED', true],
    ];
    for (const [status, body, code, retryable] of cases) {
      const run = provider.createOpenAIRunner({ apiKey: KEY, fetchImpl: mockFetch(status, body, {}) });
      await assert.rejects(
        () => run('x'),
        (err) => {
          assertNoLeak(err);
          return err && err.code === code && err.retryable === retryable;
        }
      );
    }
    // Transport failure.
    const down = provider.createOpenAIRunner({ apiKey: KEY, fetchImpl: async () => { throw new Error('down'); } });
    await assert.rejects(() => down('x'), (err) => err && err.code === 'OPENAI_NETWORK_ERROR');
    // Timeout.
    const slow = provider.createOpenAIRunner({ apiKey: KEY, fetchImpl: async () => { const e = new Error('aborted'); e.name = 'TimeoutError'; throw e; } });
    await assert.rejects(() => slow('x'), (err) => err && err.code === 'OPENAI_TIMEOUT');
  }
  console.log('PASS failures are typed and never leak the key');

  // 6. Missing key fails before any fetch.
  {
    let fetched = false;
    assert.throws(
      () => provider.createOpenAIRunner({ apiKey: '  ', fetchImpl: async () => { fetched = true; } }),
      (err) => err && err.code === 'OPENAI_AUTH_MISSING'
    );
    assert.equal(fetched, false);
  }
  console.log('PASS missing key fails before fetching');

  // 7. Allowed models check: exactly the 17 specified models
  {
    const expected = [
      'gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5-mini', 'gpt-5-nano',
      'gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-mini', 'o3-mini', 'o4-mini',
      'gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5', 'gpt-4.1', 'gpt-4o', 'o1', 'o3'
    ];
    assert.equal(provider.ALLOWED_OPENAI_MODELS.length, 17);
    for (const m of expected) {
      assert.ok(provider.isAllowedOpenAIModel(m), `model ${m} must be allowed`);
      assert.equal(provider.resolveAllowedModel(m), m);
    }
    assert.equal(provider.isAllowedOpenAIModel('gpt-3.5-turbo'), false);
    assert.equal(provider.resolveAllowedModel('invalid-model'), provider.OPENAI_DEFAULT_MODEL);
  }
  console.log('PASS allowed models strictly constrained to user list');

  // 8. Robust JSON extraction and schema repair
  {
    const investigation = load('investigation');
    // Markdown code block extraction
    const fenced = '```json\n{"test": true}\n```';
    assert.equal(investigation.cleanAndExtractJson(fenced), '{"test": true}');
    // Preamble extraction
    const preamble = 'Here is your output:\n{"test": true}\nDone!';
    assert.equal(investigation.cleanAndExtractJson(preamble), '{"test": true}');
    // Array clamping and object cleanup
    const testSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'name', 'count'],
      properties: {
        items: { type: 'array', maxItems: 2, items: { type: 'string' } },
        name: { type: 'string' },
        count: { type: 'number', minimum: 0, maximum: 1 },
      },
    };
    const dirty = {
      items: ['a', 'b', 'c', 'd'],
      name: 123,
      count: 75,
      extraKey: 'forbidden',
    };
    const repaired = investigation.repairAgainstSchema(dirty, testSchema);
    assert.deepEqual(repaired.items, ['a', 'b']);
    assert.equal(repaired.name, '123');
    assert.equal(repaired.count, 0.75);
    assert.equal('extraKey' in repaired, false);
    // Trailing commas and comments extraction
    const jsonWithComments = '{\n  // Single line comment\n  /* Block comment */\n  "items": ["x", "y",],\n  "name": "valid",\n  "count": 0.5,\n}';
    const cleaned = investigation.cleanAndExtractJson(jsonWithComments);
    assert.doesNotThrow(() => JSON.parse(cleaned));
    const parsedObj = JSON.parse(cleaned);
    assert.equal(parsedObj.name, 'valid');
    assert.deepEqual(parsedObj.items, ['x', 'y']);

    // Enum repair fallback
    const enumSchema = { type: 'object', additionalProperties: false, required: ['role'], properties: { role: { type: 'string', enum: ['source', 'test', 'docs'] } } };
    const invalidEnum = { role: 'unrecognized_role' };
    const repairedEnum = investigation.repairAgainstSchema(invalidEnum, enumSchema);
    assert.equal(repairedEnum.role, 'source');
    assert.ok(investigation.conforms(repairedEnum, enumSchema));
  }
  console.log('PASS robust JSON extraction and schema repair succeed');

  // 9. Retry backoff for 429 and 5xx transient errors
  {
    let attempts = 0;
    const retryFetch = async (url, init) => {
      attempts++;
      if (attempts === 1) {
        return {
          status: 429,
          ok: false,
          headers: new Headers({ 'Retry-After': '0' }),
          json: async () => ({ error: { message: 'rate limit' } }),
        };
      }
      return {
        status: 200,
        ok: true,
        headers: new Headers(),
        json: async () => okResponse('{"recovered": true}'),
      };
    };
    const run = provider.createOpenAIRunner({ apiKey: KEY, fetchImpl: retryFetch });
    const text = await run('ping');
    assert.equal(text, '{"recovered": true}');
    assert.equal(attempts, 2);
  }
  console.log('PASS retry backoff recovers from transient 429/5xx errors');

  console.log('PASS openai provider is strict-safe and redacted');
})().catch((error) => { console.error(error); process.exit(1); });


