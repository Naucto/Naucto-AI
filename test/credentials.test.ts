import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * The endpoint lends the server's own key to a request that carried no credential. That is only
 * defensible on a loopback bind, where the caller is the owner anyway; these pin both halves of
 * that, and that a client's own key is used in preference to the server's.
 */
const KEY = `naucto_k_${'b'.repeat(64)}`;
const content = {
  palette: ['#000000'], code: [], samples: [], instruments: {}, patterns: {}, songs: {}, sfx: {},
  levels: {}, catalog: {}, locks: {}, sheets: [], maps: [],
};

test('credentials: a client key is used, a stranger gets nothing, and the key is loopback-only', async () => {
  const borrows: string[] = [];
  const backend = createServer((req, res) => {
    borrows.push(String(req.headers.authorization));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ai/mcp/connection') res.end(JSON.stringify({ projectId: 7, userId: 1 }));
    else if (req.url === '/ai/mcp/context') res.end(JSON.stringify({ hash: 'a'.repeat(64), content }));
    else { res.statusCode = 404; res.end('{}'); }
  }).listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const backendPort = (backend.address() as { port: number }).port;
  let handler: RequestListener;
  const server = createServer((req, res) => handler(req, res)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  process.env.NAUCTO_BACKEND_URL = `http://127.0.0.1:${backendPort}`;
  process.env.NAUCTO_MCP_HOSTS = `127.0.0.1:${port}`;
  process.env.NAUCTO_KEY = KEY;
  process.env.NAUCTO_PROJECT = '9';
  process.env.HOST = '127.0.0.1';
  const { app } = await import('../src/server.js');
  handler = app;
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  const client = new Client({ name: 'test', version: '1' });
  const post = (headers: Record<string, string>) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });
  try {
    // The client's own key reaches the backend as itself, with the project it asked for.
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${KEY}`, 'x-naucto-project': '4' } } }));
    const read = await client.callTool({ name: 'read_project', arguments: {} });
    assert.equal(read.isError, undefined);
    assert.ok(borrows.length > 0, 'the request reached the backend');
    assert.ok(
      borrows.every(value => value === `Bearer ${KEY}`),
      'every call carried the client key, never the server one',
    );
    assert.ok(
      !borrows.some(value => value.includes(String(process.env.NAUCTO_PROJECT))),
      'no project id was smuggled into the credential',
    );

    // A credential we do not recognise is refused, not quietly served as the server's key: that
    // would answer one client's identity with another's.
    const before = borrows.length;
    assert.equal((await post({ authorization: 'Bearer nonsense' })).status, 401);
    assert.equal((await post({ authorization: 'Bearer naucto_k_short' })).status, 401);
    assert.equal(borrows.length, before, 'no unrecognised credential reached the backend');
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    await new Promise<void>((resolve, reject) => backend.close(e => e ? reject(e) : resolve()));
  }
});

test('credentials: NAUCTO_KEY refuses to start on a non-loopback bind', async () => {
  // A fresh module registry, because the check runs once at import.
  process.env.NAUCTO_KEY = KEY;
  process.env.HOST = '0.0.0.0';
  process.env.NAUCTO_BACKEND_URL = 'http://127.0.0.1:1';
  await assert.rejects(
    async () => {
      const specifier = new URL('../src/server.js', import.meta.url).href;
      await import(`${specifier}?public=${Date.now()}`);
    },
    /loopback/,
  );
});
