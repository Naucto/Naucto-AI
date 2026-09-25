import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decodePng } from '../src/png.js';

const content = {
  palette: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'], code: [{ id: 'main', name: 'main', text: 'print(1)\nprint(2)' }], samples: [],
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
  delete process.env.PIXELLAB_TOKEN;
  const { app } = await import('../src/server.js');
  handler = app;
  const url = new URL(`http://127.0.0.1:${local.port}/mcp`);
  const client = new Client({ name: 'test', version: '1' });
  try {
    assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'https://evil.invalid', authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' })).status, 403);
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const { tools } = await client.listTools();
    for (const name of ['read_project', 'read_code', 'read_catalog', 'propose_changes', 'place_section', 'design_sfx', 'convert_midi', 'request_generation', 'render_sheet', 'render_map', 'read_sprite', 'draw_sprite', 'transform_sprite', 'compare_sprites', 'render_sound', 'bake_sample', 'transcribe_audio']) {
      assert.ok(tools.some(tool => tool.name === name), name);
    }
    assert.ok(!tools.some(tool => /approve|apply|publish|delete/.test(tool.name)));
    const summary = await client.callTool({ name: 'read_project', arguments: {} });
    const parsed = JSON.parse((summary.content as { text: string }[])[0]!.text) as { snapshotHash: string; sheets: unknown[] };
    assert.equal(parsed.snapshotHash, 'a'.repeat(64));
    assert.equal(JSON.stringify(parsed).includes('0000000000'), false, 'the summary does not carry pixel data');
    const code = await client.callTool({ name: 'read_code', arguments: { fileId: 'main', fromLine: 2 } });
    assert.match((code.content as { text: string }[])[0]!.text, /"text":"print\(2\)"/);
    const generation = await client.callTool({ name: 'request_generation', arguments: { request: { kind: 'sprite', prompt: 'knight', width: 16, height: 16, palette: new Array(16).fill('#000000') } } });
    assert.equal(generation.isError, true);
    assert.ok(!seen.some(entry => entry.includes('/jobs')), 'nothing was queued without a configured provider');

    type Block = { type: string; text?: string; data?: string; mimeType?: string };
    const blocks = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`);
      const content = result.content as Block[];
      const picture = content.find(b => b.type === 'image');
      assert.equal(picture?.mimeType, 'image/png', `${name} returns a picture`);
      assert.ok(decodePng(Buffer.from(picture!.data!, 'base64')).width > 0);
      return JSON.parse(content.find(b => b.type === 'text')!.text!) as Record<string, unknown>;
    };
    assert.equal((await blocks('render_sheet', { sheetId: '0', width: 32, height: 16 })).spritesPerRow, 16);
    await blocks('render_map', { mapId: '0' });
    assert.deepEqual((await blocks('read_sprite', { sheetId: '0', x: 0, y: 0, width: 2, height: 1 })).rows, ['..']);
    const drawn = await blocks('draw_sprite', { sheetId: '0', x: 4, y: 4, rows: ['8_', '_8'] }) as { operation: { changes: unknown[] } };
    assert.deepEqual(drawn.operation.changes, [{ x: 4, y: 4, before: 0, after: 8 }, { x: 5, y: 5, before: 0, after: 8 }]);
    const turned = await blocks('transform_sprite', { source: { rows: ['1.', '1.'] }, steps: [{ op: 'rotate', quarterTurns: 1 }] });
    assert.deepEqual(turned.rows, ['11', '..']);
    const compared = await blocks('compare_sprites', { candidates: [{ label: 'mine', source: { rows: ['88', '88'] } }, { label: 'sheet', source: { sheetId: '0', x: 0, y: 0, width: 2, height: 2 } }], tiled: true }) as unknown as { opaquePercent: number }[];
    assert.deepEqual(compared.map(c => c.opaquePercent), [100, 0]);
    const draft = { instruments: [{ id: 'lead', osc: 'square' }], patterns: [{ id: 'p', bpm: 120, stepsPerBeat: 4, steps: 8, notes: [{ step: 0, pitch: 60, length: 4, instrument: 'lead', volume: 1 }] }] };
    const sound = await blocks('render_sound', { source: { as: 'SFX', draft } });
    assert.ok(Number(sound.seconds) > 0.9);
    const baked = await blocks('bake_sample', { id: 'blip', from: { instrument: { osc: 'triangle' }, pitch: 72, seconds: 0.25 } }) as { bytes: number; sample: { id: string } };
    assert.ok(baked.bytes > 1000 && baked.sample.id === 'blip');
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve()));
  }
});
