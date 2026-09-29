import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { decodePng } from '../src/png.js';

/**
 * What the first test's stub and server left behind, so a later test can drive the same module
 * instance instead of importing a second one at a second port.
 */
const shared: {
  /** A key reaching one project, so it is never asked to choose anything. */
  singleToken: string;
  multiToken: string;
  victimToken: string;
  scopes: string[];
  url: URL | null;
  /** Flipped by the test that revokes a grant, so the stub behaves like the Backend does. */
  revoked: boolean;
  revoke: () => void;
  unlink: () => void;
} = {
  singleToken: `naucto_ai_${'a'.repeat(64)}`,
  multiToken: '',
  victimToken: '',
  scopes: [],
  url: null,
  revoked: false,
  revoke: () => {
    shared.revoked = true;
  },
  unlink: () => {
    shared.revoked = false;
  },
};
/** Closed once, after every test, so the servers outlive the first one. */
const teardown: (() => Promise<void>)[] = [];

const content = {
  palette: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'], code: [{ id: 'main', name: 'main', text: 'print(1)\nprint(2)' }], samples: [],
  instruments: {}, patterns: {}, songs: {}, sfx: {}, levels: {}, catalog: {}, locks: {},
  sheets: [{ id: '0', name: 'sprites', width: 128, height: 128, base: 0, pixels: '0'.repeat(128 * 128) }],
  maps: [{ id: '0', name: 'map', width: 8, height: 4, tiles: new Array(32).fill(0) }],
};

test('HTTP MCP: authenticated, paginated reads, no self-approval, generation disabled unless configured', async () => {
  const token = `naucto_ai_${'a'.repeat(64)}`;
  const seen: string[] = [];
  // One stub serves both credentials, so the two tests share a single module instance: the host
  // allowlist and the remembered selections are both read when it loads, so a second instance would
  // have to be built from a second port and a second import.
  const MULTI = `naucto_ai_${'b'.repeat(64)}`;
  // A second key reaching the same two projects, so the eviction test has a bystander that has made
  // a choice worth losing.
  const VICTIM = `naucto_ai_${'c'.repeat(64)}`;
  shared.multiToken = MULTI;
  shared.victimToken = VICTIM;
  const TWO_PROJECT_KEYS = new Set([MULTI, VICTIM]);
  const scopes = shared.scopes;
  const backend = createServer((req, res) => {
    assert.match(String(req.headers.authorization), /^Bearer naucto_(ai|k)_/);
    const bearer = String(req.headers.authorization).slice(7);
    const scope = String(req.headers['x-naucto-project'] ?? '');
    seen.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (TWO_PROJECT_KEYS.has(bearer)) {
      // A key reaching two games: the Backend refuses to guess, so a session has to choose. It also
      // narrows its own reachability list to the hinted project, which is what makes a stale or wrong
      // selection visible here — a stub that ignored the header could not tell the difference.
      if (req.url === '/ai/mcp/projects') {
        const all = [
          { projectId: 11, userId: 1, name: 'Moon', contextUpdatedAt: new Date(0).toISOString(), contextAgeMs: 5, pendingProposals: 0 },
          { projectId: 22, userId: 1, name: 'Tower', contextUpdatedAt: null, contextAgeMs: null, pendingProposals: 2 },
        ];
        res.end(JSON.stringify(scope ? all.filter(entry => String(entry.projectId) === scope) : all));
      } else if (req.url === '/ai/mcp/connection') {
        if (!scope) { res.statusCode = 409; res.end(JSON.stringify({ message: 'This key reaches several projects' })); return; }
        if (scope === '22' && shared.revoked) { res.statusCode = 401; res.end(JSON.stringify({ message: 'This key is not linked to that project' })); return; }
        res.end(JSON.stringify({ projectId: Number(scope), userId: 1, name: scope === '11' ? 'Moon' : 'Tower' }));
      } else if (req.url === '/ai/mcp/context') {
        scopes.push(scope);
        res.end(JSON.stringify({ hash: 'b'.repeat(64), content }));
      } else { res.statusCode = 404; res.end('{}'); }
      return;
    }
    assert.equal(bearer, token);
    if (req.url === '/ai/mcp/connection') res.end(JSON.stringify({ projectId: 7, userId: 1 }));
    else if (req.url === '/ai/mcp/projects') {
      // One project, so nothing is asked to choose and no header is ever sent.
      res.end(JSON.stringify([{ projectId: 7, userId: 1, name: 'Solo', contextUpdatedAt: new Date(0).toISOString(), contextAgeMs: 5, pendingProposals: 0 }]));
    }
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
  }
  // The servers stay up: the next test drives this same module instance.
  shared.url = url;

  teardown.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  teardown.push(() => new Promise<void>((resolve, reject) => backend.close(error => error ? reject(error) : resolve())));
});

test.after(async () => {
  for (const close of teardown.splice(0)) await close();
});

test('a refusal arrives as a tool error, not a failed call', async () => {
  // Thrown, a refusal becomes a JSON-RPC error: most clients surface that as a failed tool call or a
  // dropped turn, so the reason is lost and a model retries blindly, or gives up on work it could
  // have done. It has to arrive as the result of a tool that ran and could not finish.
  const url = shared.url;
  assert.ok(url, 'the shared MCP server was not started');
  const open = async (): Promise<Client> => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${shared.multiToken}` } },
    }));
    return client;
  };
  const client = await open();
  const other = await open();
  try {
    // No project chosen yet, so everything but discovery refuses — and says which tool to call.
    const refused = await client.callTool({ name: 'read_project', arguments: {} });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /use_project/);

    // A project this key may not reach, refused for its own reason.
    const wrong = await other.callTool({ name: 'use_project', arguments: { projectId: 99 } });
    assert.equal(wrong.isError, true);
    assert.match(text(wrong), /is not one of the projects this key reaches/);
  } finally {
    await client.close();
    await other.close();
  }
});

test('a key that reaches several games picks one and works there, and refuses until it does', async () => {
  // The stub and the server come from the test above: one module instance, two credentials.
  assert.ok(shared.url, 'the shared MCP server was not started');
  const url = shared.url;
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${shared.multiToken}` } } }));

    // Discovery works with nothing chosen, and says what the session is on.
    const listed = toolJson(await client.callTool({ name: 'list_projects', arguments: {} }));
    assert.deepEqual((listed['projects'] as { projectId: number }[]).map(p => p.projectId), [11, 22]);
    assert.equal(listed['multiProject'], true);
    assert.equal(listed['currentProjectId'], null);

    // Everything else refuses, and names the tool to call rather than failing obscurely.
    const tooEarly = await client.callTool({ name: 'read_project', arguments: {} });
    assert.equal(tooEarly.isError, true);
    assert.match(text(await tooEarly), /use_project/);

    // A project this key cannot reach is refused, not sent on to the Backend.
    const forbidden = await client.callTool({ name: 'use_project', arguments: { projectId: 99 } });
    assert.equal(forbidden.isError, true);
    assert.match(text(await forbidden), /not one of the projects/);

    // Choosing makes the session work there, and the choice outlives the request that made it.
    const chosen = await client.callTool({ name: 'use_project', arguments: { projectId: 22 } });
    assert.equal(chosen.isError, undefined);
    await client.callTool({ name: 'read_project', arguments: {} });
    await client.callTool({ name: 'read_project', arguments: {} });
    assert.deepEqual(shared.scopes, ['22', '22'], 'both reads reached the chosen project, in later requests');

    // And it can move to the other game the key reaches. This is the part a stub that ignored the
    // project header could not check: the Backend narrows its reachability list to whatever is
    // selected, so validating a new choice against that list makes every other project look out of
    // reach and a session that had chosen once could never move again.
    await client.callTool({ name: 'use_project', arguments: { projectId: 11 } });
    await client.callTool({ name: 'read_project', arguments: {} });
    assert.deepEqual(shared.scopes, ['22', '22', '11']);
    const nowOn = toolJson(await client.callTool({ name: 'list_projects', arguments: {} }));
    assert.equal(nowOn['currentProjectId'], 11);
    // Both are still listed, and `multiProject` still says so. Reporting one here would leave a
    // model that wanted to switch with nothing to switch to and no way to learn the others exist.
    assert.equal((nowOn['projects'] as { projectId: number }[]).length, 2);
    assert.equal(nowOn['multiProject'], true);
  } finally {
    await client.close();
  }
});

test('two conversations on one key choose independently', async () => {
  // Keyed by the credential alone, one model's `use_project` silently retargeted another's
  // mid-sentence: the key is the same, so they shared one remembered project.
  const url = shared.url;
  assert.ok(url, 'the shared MCP server was not started');
  // No `mcp-session-id` set by hand: a real client never sends one, because it only echoes an id
  // the server gave it. So both of these are ordinary clients, and the ids have to come from the
  // initialize responses for the two to be told apart at all.
  const connect = async (): Promise<Client> => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${shared.multiToken}` } } }));
    return client;
  };
  const first = await connect();
  const second = await connect();
  try {
    await first.callTool({ name: 'use_project', arguments: { projectId: 11 } });
    // The other conversation never chose, and must not have been moved by the first one.
    const other = toolJson(await second.callTool({ name: 'list_projects', arguments: {} }));
    assert.equal(other['currentProjectId'], null, 'one conversation choosing must not move another');
    // And it can choose for itself.
    await second.callTool({ name: 'use_project', arguments: { projectId: 22 } });
    assert.equal(toolJson(await first.callTool({ name: 'list_projects', arguments: {} }))['currentProjectId'], 11);
    assert.equal(toolJson(await second.callTool({ name: 'list_projects', arguments: {} }))['currentProjectId'], 22);
  } finally {
    await first.close();
    await second.close();
  }
});

test('a choice that stops being reachable is forgotten, not held against the key', async () => {
  // A key reaches two games and picks one. The grant on that one is revoked. Every request naming it
  // would be refused, and because the server is never built, `use_project` — the only way to change
  // it — is unreachable: the session is locked out of a key that still reaches the other game.
  assert.ok(shared.url, 'the shared MCP server was not started');
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(shared.url, { requestInit: { headers: { authorization: `Bearer ${shared.multiToken}` } } }));
    await client.callTool({ name: 'use_project', arguments: { projectId: 22 } });
    shared.revoke();

    // Refused, and saying why it really is: not "this key covers several projects", which is a
    // different situation and sends a model looking for a choice that may no longer exist.
    const refused = await client.callTool({ name: 'read_project', arguments: {} });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /no longer one this key reaches/);
    assert.doesNotMatch(text(refused), /several projects/);
    assert.match(text(await client.callTool({ name: 'list_projects', arguments: {} })), /projects/);

    // With the grant back, the session can choose again rather than being stuck.
    shared.unlink();
    const reachable = toolJson(await client.callTool({ name: 'list_projects', arguments: {} }));
    assert.equal((reachable['projects'] as { projectId: number }[]).length, 2);
    const chosen = await client.callTool({ name: 'use_project', arguments: { projectId: 11 } });
    assert.equal(chosen.isError, undefined);
  } finally {
    shared.unlink();
    await client.close();
  }
});

/** A tool's text payload. The SDK types a result as a union of shapes, so it is read off the object. */
function text(result: unknown): string {
  const entry = (result as { content?: { text: string }[] }).content?.[0];
  assert.ok(entry, 'the tool returned no content');
  return entry.text;
}

/** A tool's JSON payload. */
function toolJson(result: unknown): Record<string, unknown> {
  return JSON.parse(text(result)) as Record<string, unknown>;
}

test('flooding the map with one key does not flush another key\'s choice', async () => {
  // The selection map is bounded. Evicting the globally oldest entry meant anyone holding a key could
  // flush every other holder's choices just by opening conversations with made-up session ids — and
  // a conversation that forgets its project mid-sentence is one that stops working. Eviction takes
  // the flooding credential's own entries first.
  const url = shared.url;
  assert.ok(url, 'the shared MCP server was not started');
  const connect = async (token: string): Promise<Client> => {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    return client;
  };

  // A bystander that has chosen a project, which is what the flooder must not cost it.
  const victim = await connect(shared.victimToken);
  await victim.callTool({ name: 'use_project', arguments: { projectId: 11 } });
  const flooder = await connect(shared.multiToken);
  try {

    // More distinct conversations on the flooder's key than the map holds.
    for (let i = 0; i < 1100; i += 1) {
      const c = await connect(shared.multiToken);
      await c.callTool({ name: 'use_project', arguments: { projectId: i % 2 ? 11 : 22 } });
      await c.close();
    }

    // Still on the project it chose, and still able to read.
    const listed = toolJson(await victim.callTool({ name: 'list_projects', arguments: {} }));
    assert.equal(listed['currentProjectId'], 11);
    // And it can still read, which it could not if the flood had taken its choice: with nothing
    // remembered it is told to choose, and every other tool refuses.
    const read = await victim.callTool({ name: 'read_project', arguments: {} });
    assert.equal(read.isError, undefined);
  } finally {
    await victim.close();
    await flooder.close();
  }
});
