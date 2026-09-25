import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const content = {
  palette: [], code: [{ id: 'main', name: 'main', text: 'print(1)\nprint(2)' }], samples: [],
  instruments: {}, patterns: {}, songs: {}, sfx: {}, levels: {}, catalog: {}, locks: {},
  sheets: [{ id: '0', name: 'sprites', width: 128, height: 128, base: 0, pixels: '0'.repeat(128 * 128) }],
  maps: [{ id: '0', name: 'map', width: 8, height: 4, tiles: new Array(32).fill(0) }],
};

test('HTTP MCP: authenticated, paginated reads, no self-approval, generation disabled unless configured', async () => {
  const token = `naucto_ai_${'a'.repeat(64)}`;
  const seen: string[] = [];
  const backend = createServer((req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/ai/mcp/connection') res.end(JSON.stringify({ projectId: 7, userId: 1 }));
    else if (req.url === '/ai/mcp/context') res.end(JSON.stringify({ hash: 'a'.repeat(64), content }));
    else { res.statusCode = 404; res.end('{}'); }
  }).listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const address = backend.address();
  assert.ok(address && typeof address === 'object');
  let handler: RequestListener;
  const server = createServer((req, res) => handler(req, res)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const local = server.address();
  assert.ok(local && typeof local === 'object');
  process.env.NAUCTO_BACKEND_URL = `http://127.0.0.1:${address.port}`;
  process.env.NAUCTO_MCP_HOSTS = `127.0.0.1:${local.port}`;
  delete process.env.HF_TOKEN;
  const { app } = await import('../src/server.js');
  handler = app;
  const url = new URL(`http://127.0.0.1:${local.port}/mcp`);
  const client = new Client({ name: 'test', version: '1' });
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://evil.invalid', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const { tools } = await client.listTools();
    for (const name of ['read_project', 'read_code', 'read_catalog', 'propose_changes', 'place_section', 'design_sfx', 'convert_midi', 'request_generation']) {
      assert.ok(tools.some(tool => tool.name === name), name);
    }
    assert.ok(!tools.some(tool => /approve|apply|publish|delete/.test(tool.name)));
    const summary = await client.callTool({ name: 'read_project', arguments: {} });
    const parsed = JSON.parse((summary.content as { text: string }[])[0]!.text) as { snapshotHash: string; sheets: unknown[] };
    assert.equal(parsed.snapshotHash, 'a'.repeat(64));
    assert.equal(JSON.stringify(parsed).includes('0000000000'), false, 'the summary does not carry pixel data');
    const code = await client.callTool({ name: 'read_code', arguments: { fileId: 'main', fromLine: 2 } });
    assert.match((code.content as { text: string }[])[0]!.text, /"text":"print\(2\)"/);
    const generation = await client.callTool({ name: 'request_generation', arguments: { request: { kind: 'midi', prompt: 'loop', prefix: 'x', voices: 4 } } });
    assert.equal(generation.isError, true);
    assert.ok(!seen.some(entry => entry.includes('/jobs')), 'nothing was queued without a configured provider');
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
  }
});
