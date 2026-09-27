#!/usr/bin/env node
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createWorldApi } from '../src/world-api.js';
import { createToolServer } from './world-mcp.mjs';

const MAX_BODY_BYTES = 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest();

export function createWorldMcpHttpServer({ api, manifest, token }) {
  if (typeof token !== 'string' || !token.trim() || /\s/.test(token))
    throw new Error('WORLD_MCP_TOKEN must be a nonempty token without whitespace');
  const expected = digest(`Bearer ${token}`);
  const handle = createToolServer(api, manifest);
  return createServer({ requestTimeout: 15000, headersTimeout: 10000 }, async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    if (req.url !== '/mcp') { req.resume(); return send(404, { error: 'not_found' }); }
    if (req.headers.origin !== undefined) { req.resume(); return send(403, { error: 'origin_not_allowed' }); }
    if (!timingSafeEqual(expected, digest(req.headers.authorization || ''))) {
      req.resume();
      res.setHeader('WWW-Authenticate', 'Bearer');
      return send(401, { error: 'unauthorized' });
    }
    if (req.method !== 'POST') {
      req.resume();
      res.setHeader('Allow', 'POST');
      return send(405, { error: 'method_not_allowed' });
    }
    if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      req.resume();
      return send(415, { error: 'unsupported_media_type' });
    }
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      req.resume();
      return send(413, { error: 'payload_too_large' });
    }
    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > MAX_BODY_BYTES) {
          send(413, { error: 'payload_too_large' });
          return;
        }
        chunks.push(chunk);
      }
    } catch {
      if (!res.destroyed) send(400, { error: 'incomplete_request' });
      return;
    }
    let request;
    try { request = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { return send(200, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    try {
      const result = await handle(request);
      send(result === null ? 202 : 200, result === null ? undefined : result);
    } catch {
      send(200, { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32603, message: 'Internal error' } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = new URL(process.env.WORLD_URL || 'http://127.0.0.1:8787');
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
    throw new Error('WORLD_URL must use HTTP(S) without embedded credentials');
  const port = Number(process.env.WORLD_MCP_PORT || 8788);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WORLD_MCP_PORT');
  const host = process.env.WORLD_MCP_HOST || '127.0.0.1';
  const api = createWorldApi({ fetchImpl: (path, options) => fetch(new URL(path, base), { ...options, redirect: 'error' }) });
  const manifest = JSON.parse(await readFile(new URL('../../contracts/PANELS.json', import.meta.url), 'utf8'));
  const server = createWorldMcpHttpServer({ api, manifest, token: process.env.WORLD_MCP_TOKEN });
  server.listen(port, host, () => process.stderr.write(`WORLD MCP listening on ${host}:${port}/mcp\n`));
}
