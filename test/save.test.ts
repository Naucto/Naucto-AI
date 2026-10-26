import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type RequestListener } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Game, aiContext, encodeState } from '@naucto/engine/headless';
import * as Y from 'yjs';

test('MCP edits a native AI save through the engine, keeps user saves isolated and passes merge choices', async () => {
  const token = `naucto_k_${'e'.repeat(64)}`;
  let doc = new Y.Doc();
  new Game(doc).addFile('main', 'base', 'main');
  const canonical = encodeState(doc);
  let revision = 1;
  const writes: string[] = [];
  const backend = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const data = () => ({ revision, snapshot: encodeState(doc), hash: 'a'.repeat(64), content: aiContext(new Game(doc)), pendingReviewId: null });
    if (req.url === '/ai/mcp/connection') { res.end(JSON.stringify({ projectId: 1, userId: 1 })); return; }
    if (req.method === 'GET' && req.url?.startsWith('/ai/mcp/workspace')) {
      if (req.url.endsWith('/compare')) res.end(JSON.stringify({ revision, latestHash: 'b'.repeat(64), changes: [{ id: 'sound', conflict: true }] }));
      else if (req.url.includes('source=latest')) {
        const user = new Y.Doc(); Y.applyUpdate(user, Buffer.from(canonical, 'base64'));
        res.end(JSON.stringify({ ...data(), content: aiContext(new Game(user)), snapshot: canonical })); user.destroy();
      } else res.end(JSON.stringify(data()));
      return;
    }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { revision: number; snapshot?: string; resolutions?: unknown; latestHash?: string };
    if (body.revision !== revision) { res.statusCode = 409; res.end(JSON.stringify({ message: 'AI save changed' })); return; }
    if (req.url === '/ai/mcp/workspace/merge') { res.end(JSON.stringify({ merged: true, resolutions: body.resolutions, latestHash: body.latestHash })); return; }
    assert.equal(req.url, '/ai/mcp/workspace');
    assert.equal(typeof body.snapshot, 'string');
    const next = new Y.Doc(); Y.applyUpdate(next, Buffer.from(body.snapshot!, 'base64'));
    doc.destroy(); doc = next; revision++; writes.push(req.url!);
    res.end(JSON.stringify(data()));
  }).listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const upstream = backend.address(); assert.ok(upstream && typeof upstream === 'object');
  process.env.NAUCTO_BACKEND_URL = `http://127.0.0.1:${upstream.port}`;
  let handler: RequestListener;
  const server = createServer((req, res) => handler(req, res)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address(); assert.ok(address && typeof address === 'object');
  process.env.NAUCTO_MCP_HOSTS = `127.0.0.1:${address.port}`;
  const { app } = await import('../src/server.js');
  handler = app;
  const client = new Client({ name: 'save-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert.notEqual(response.isError, true, JSON.stringify(response.content));
      return JSON.parse((response.content as { text: string }[])[0]!.text) as Record<string, unknown>;
    };
    const firstWrite = await call('write_code', { fileId: 'main', text: 'AI code' });
    assert.equal('snapshot' in firstWrite || 'content' in firstWrite, false, 'writes must not flood the model with native sample bytes');
    await call('write_code', { fileId: 'helper', name: 'helper', text: 'return 1' });
    assert.equal((await call('read_code', { fileId: 'main' })).text, 'AI code');
    assert.equal((await call('read_code', { fileId: 'main', source: 'latest' })).text, 'base');
    await call('write_pixels', { sheetId: '0', changes: [{ x: 0, y: 0, colour: 5 }] });
    await call('write_tiles', { mapId: '0', changes: [{ x: 1, y: 0, sprite: 2 }] });
    await call('write_sound', { category: 'SFX', slot: 0, draft: { instruments: [{ id: 'lead' }], patterns: [{ id: 'p', notes: [] }], samples: [{ id: 'pcm', data: 'AQID' }] } });
    const game = new Game(doc);
    assert.equal(game.getPixel(0, 0), 5); assert.equal(game.maps[0]!.getTile(1, 0), 2);
    assert.equal(game.sfx.get('0'), 'p');
    assert.equal(game.samples.get('pcm'), 'AQID', 'samples keep the engine native base64-string format');
    const compared = await call('compare_saves', {});
    const merged = await call('merge_latest_save', { revision, latestHash: compared.latestHash, resolutions: { sound: 'latest' } });
    assert.deepEqual(merged.resolutions, { sound: 'latest' });
    const stale = await client.callTool({ name: 'save_project', arguments: { revision: 1, snapshot: canonical } });
    assert.equal(stale.isError, true);
    assert.equal(writes.length, 5);
    const user = new Y.Doc(); Y.applyUpdate(user, Buffer.from(canonical, 'base64'));
    assert.equal(new Game(user).files[0]!.text.toString(), 'base'); user.destroy();
  } finally {
    await client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => backend.close(() => resolve()));
    doc.destroy();
  }
});
