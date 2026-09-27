import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorldApi, WorldApiError } from '../src/world-api.js';

test('HTTP client covers backend routes and preserves JSON bodies and responses', async () => {
  const calls = [];
  const api = createWorldApi({ fetchImpl: async (path, init) => {
    calls.push({ path, ...init });
    return new Response(JSON.stringify({ result: calls.length }));
  } });
  const body = { spec: { feature: 'show my notes' }, nested: ['unchanged'] };
  const cases = [
    ['qmRuns', [], 'GET', '/qm/runs'],
    ['qmWatches', [], 'GET', '/qm/watches'],
    ['qmEntities', [], 'GET', '/qm/entities'],
    ['qmWatch', [body], 'POST', '/qm/watches'],
    ['qmAdopt', [body], 'POST', '/qm/entities/adopt'],
    ['qmDeleteWatch', ['watch-one'], 'DELETE', '/qm/watches/watch-one'],
    ['health', [], 'GET', '/health'],
    ['people', [], 'GET', '/people'],
    ['jobs', [], 'GET', '/builder/jobs'],
    ['job', ['job/a?b'], 'GET', '/builder/jobs/job%2Fa%3Fb'],
    ['tools', [], 'GET', '/tools'],
    ['panels', [], 'GET', '/panels'],
    ['panelActions', [12], 'GET', '/panel-actions?after=12'],
    ['panel', [body], 'POST', '/tools/world-panel'],
    ['dispatch', [body], 'POST', '/builder/dispatch'],
    ['event', [body], 'POST', '/events'],
    ['hud', [body], 'POST', '/hud'],
    ['procedure', [body], 'POST', '/procedures'],
    ['utterance', [body], 'POST', '/debug/utterance'],
    ['endConversation', [], 'POST', '/debug/end-conversation'],
  ];
  for (const [method, args, verb, path] of cases) {
    const result = await api[method](...args);
    const call = calls.at(-1);
    assert.deepEqual(result, { result: calls.length });
    assert.equal(call.path, path);
    assert.equal(call.method, verb);
    assert.equal(call.cache, 'no-store');
    assert.equal(call.credentials, 'same-origin');
    if (args[0] === body) {
      assert.deepEqual(JSON.parse(call.body), body);
      assert.equal(call.headers['Content-Type'], 'application/json');
    } else assert.equal(call.body, undefined);
  }
});

test('FastAPI validation errors are readable and mutations are not retried', async () => {
  let count = 0;
  const detail = [{ loc: ['body', 'spec'], msg: 'Field required', type: 'missing' }];
  const api = createWorldApi({ fetchImpl: async () => {
    count++;
    return new Response(JSON.stringify({ detail }), { status: 422 });
  } });
  await assert.rejects(api.dispatch({}), (error) => {
    assert.ok(error instanceof WorldApiError);
    assert.equal(error.message, 'body.spec: Field required');
    assert.equal(error.status, 422);
    assert.equal(error.path, '/builder/dispatch');
    assert.deepEqual(error.detail, detail);
    return true;
  });
  assert.equal(count, 1);
});

test('string errors, HTML proxy errors, and network failures have useful messages', async () => {
  for (const [fetchImpl, message, code] of [
    [async () => new Response('{"detail":"no such job"}', { status: 404 }), 'no such job', 'HTTP_ERROR'],
    [async () => new Response('<html>proxy failed</html>', { status: 502 }), 'WORLD request failed (502)', 'INVALID_RESPONSE'],
    [async () => new Response('<html>vite fallback</html>'), 'WORLD returned an invalid JSON response', 'INVALID_RESPONSE'],
    [async () => { throw new TypeError('Failed to fetch'); }, 'could not reach WORLD backend', 'NETWORK_ERROR'],
  ]) {
    await assert.rejects(createWorldApi({ fetchImpl }).health(), (error) => {
      assert.equal(error.message, message);
      assert.equal(error.code, code);
      return true;
    });
  }
});

const abortableFetch = (_path, { signal }) => new Promise((_resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
});

test('request timeout aborts fetch, reports timeout, and never retries', async () => {
  let calls = 0;
  const api = createWorldApi({ timeoutMs: 5, fetchImpl: (...args) => {
    calls++;
    return abortableFetch(...args);
  } });
  await assert.rejects(api.panel({ op: 'show' }), { name: 'WorldApiError', code: 'TIMEOUT' });
  assert.equal(calls, 1);
});

test('caller cancellation is preserved rather than reported as backend failure', async () => {
  const controller = new AbortController();
  const api = createWorldApi({ fetchImpl: abortableFetch });
  const pending = api.jobs({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(api.jobs({ signal: controller.signal }), { name: 'AbortError' });
});

test('empty successful responses are supported', async () => {
  const api = createWorldApi({ fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(await api.endConversation(), null);
});
