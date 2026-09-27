import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createWorldMcpHttpServer } from '../scripts/world-mcp-http.mjs';

const manifest = JSON.parse(await readFile(new URL('../../contracts/PANELS.json', import.meta.url)));
const token = 'test-only-world-mcp-token';
const rpc = (method, params) => ({ jsonrpc: '2.0', id: 1, method, params });
async function fixture(t, api = {}) {
  const server = createWorldMcpHttpServer({ api, manifest, token });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const call = (body, options = {}) => fetch(url, {
    method: 'POST', body: JSON.stringify(body), ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...options.headers },
  });
  return { call, url };
}

test('HTTP MCP requires a token at startup', () => {
  for (const bad of [undefined, '', ' ', 'a b'])
    assert.throws(() => createWorldMcpHttpServer({ api: {}, manifest, token: bad }), /WORLD_MCP_TOKEN/);
});

test('QM can discover and invoke tools without initialization', async t => {
  let cursor;
  const { call } = await fixture(t, { panelActions: async after => (cursor = after, { actions: [], cursor: 7 }) });
  const list = await (await call(rpc('tools/list'))).json();
  assert.equal(list.result.tools.length, 8);
  assert.deepEqual(list.result.tools[0].inputSchema, manifest.tool.function.parameters);
  const result = await (await call(rpc('tools/call', { name: 'world_panel_actions', arguments: { after: 5 } }))).json();
  assert.equal(cursor, 5);
  assert.deepEqual(JSON.parse(result.result.content[0].text), { actions: [], cursor: 7 });
  const notice = await call({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notice.status, 202);
  assert.equal(await notice.text(), '');
});

test('unauthorized and browser-origin requests never reach backend', async t => {
  let calls = 0;
  const { call } = await fixture(t, { health: async () => { calls++; return {}; } });
  const request = rpc('tools/call', { name: 'world_status' });
  for (const authorization of ['', 'Bearer incorrect', 'Basic test']) {
    const response = await call(request, { headers: { Authorization: authorization } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  for (const origin of ['https://attacker.example', 'null', 'http://localhost:5175'])
    assert.equal((await call(request, { headers: { Origin: origin } })).status, 403);
  assert.equal(calls, 0);
});

test('HTTP adapter validates path, method, media type and malformed JSON', async t => {
  const { call, url } = await fixture(t);
  assert.equal((await fetch(`${url}/other`)).status, 404);
  const get = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await call(rpc('tools/list'), { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  const broken = await call(null, { body: '{' });
  assert.equal((await broken.json()).error.code, -32700);
  assert.equal(broken.headers.get('cache-control'), 'no-store');
  assert.equal((await (await call([])).json()).error.code, -32600);
});

test('HTTP adapter rejects oversized fixed-length and chunked bodies', async t => {
  const { call, url } = await fixture(t);
  assert.equal((await call(null, { body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(url, { method: 'POST', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked',
    } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.write('x'.repeat(1024 * 1024));
    req.end('x');
  });
  assert.equal(status, 413);
});

test('HTTP MCP preserves backend tool errors and does not retry mutations', async t => {
  let calls = 0;
  const { call } = await fixture(t, { dispatch: async () => { calls++; throw new Error('builder unavailable'); } });
  const result = await (await call(rpc('tools/call', {
    name: 'world_dispatch', arguments: { spec: { feature: 'x', request: 'y' } },
  }))).json();
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /builder unavailable/);
  assert.equal(calls, 1);
});
