/**
 * Drives a running Backend and MCP service end to end, as an assistant and two editors would.
 *
 *   NAUCTO_BACKEND_URL=http://127.0.0.1:3057 NAUCTO_MCP_URL=http://127.0.0.1:3100/mcp \
 *     npx tsx scripts/live-e2e.ts
 *
 * Needs a disposable database (it registers a user and creates a project) and, for the generation
 * step, the service configured against the stubs (`npm run stub` behind HTTPS, with
 * NAUCTO_MIDI_PROVIDER=space and NAUCTO_SPACE_URL pointing at it). The editors are simulated with Yjs
 * documents speaking the same HTTP protocol the browser bridge does.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as Y from 'yjs';

const backend = process.env.NAUCTO_BACKEND_URL ?? 'http://127.0.0.1:3057';
const mcpUrl = new URL(process.env.NAUCTO_MCP_URL ?? 'http://127.0.0.1:3100/mcp');
const encode = (doc: Y.Doc): string => Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64');

async function api<T>(path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(`${backend}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

const step = (name: string): void => { console.log(`✓ ${name}`); };

// ---- a user and a project ----------------------------------------------------------------
const nonce = randomUUID().slice(0, 8);
const credentials = { email: `ai-${nonce}@example.invalid`, username: `ai${nonce}`, password: `Pw-${randomUUID()}!aA1` };
const registered = await fetch(`${backend}/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) });
const registration = await registered.text();
assert.ok(registered.ok, registration);
const { access_token: jwt } = JSON.parse(registration) as { access_token: string };
const project = await api<{ id: number }>('/projects', jwt, { name: 'AI live test', shortDesc: 'live' });
const base = `/ai/projects/${project.id}`;
step(`registered and created project ${project.id}`);

// ---- two editors on the same document ----------------------------------------------------
const alice = new Y.Doc(), bob = new Y.Doc();
const file = new Y.Map<unknown>();
alice.getMap('code.files').set('main', file);
file.set('name', 'main');
file.set('text', new Y.Text('function _draw()\n  gfx.cls(0)\nend'));
alice.getMap('gfx.sprites').set('8,0', 3);
Y.applyUpdate(bob, Y.encodeStateAsUpdate(alice));
const editors = { alice: randomUUID(), bob: randomUUID() };
const beat = async (): Promise<{ id?: string; status?: string; result?: string | null } | null> => {
  await api(`${base}/editors/heartbeat`, jwt, { editorId: editors.bob });
  return api(`${base}/editors/heartbeat`, jwt, { editorId: editors.alice });
};
await beat();

// ---- the assistant connects through MCP --------------------------------------------------
const { token } = await api<{ token: string }>(`${base}/connection`, jwt, {});
const context = {
  palette: new Array(16).fill('#000000'),
  code: [{ id: 'main', name: 'main', text: (file.get('text') as Y.Text).toString() }],
  sheets: [{ id: '0', name: 'sprites', width: 128, height: 128, base: 0, pixels: '0'.repeat(8) + '3' + '0'.repeat(128 * 128 - 9) }],
  maps: [{ id: '0', name: 'map', width: 128, height: 32, tiles: new Array(128 * 32).fill(0) }],
  catalog: {}, levels: {}, locks: {}, instruments: {}, patterns: {}, songs: {}, sfx: {}, samples: [],
};
await api(`${base}/context`, jwt, { content: context });
const client = new Client({ name: 'live-e2e', version: '1' });
await client.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
const call = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? '';
  if (result.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text) as T;
};
const summary = await call<{ snapshotHash: string; code: { id: string }[] }>('read_project');
assert.equal(summary.code[0]?.id, 'main');
const region = await call<{ contentHash: string }>('read_sheet_region', { sheetId: '0', x: 8, y: 0, width: 8, height: 8 });
const docs = await call<{ name: string }[]>('search_engine_docs', { query: 'map.get' });
assert.ok(docs.length > 0, 'engine docs searchable');
step('MCP: authenticated, read project, sheet region fingerprint, engine docs');

// ---- a proposal: code + a catalogued tile + a new level + a sound effect -----------------
const levelId = randomUUID();
const sfx = await call<{ variations: { instrument: Record<string, unknown>; pattern: Record<string, unknown> }[] }>('design_sfx', { kind: 'coin', id: 'coin' });
const after = 'function _draw()\n  gfx.cls(1)\nend';
const operations = [
  { kind: 'code', fileId: 'main', before: context.code[0]!.text, after },
  { kind: 'catalog', before: null, after: { id: 'grass', name: 'Grass', kind: 'tile', resourceId: '0', x: 8, y: 0, width: 8, height: 8, tags: ['ground'], description: '', contentHash: region.contentHash, semantics: 'unconfirmed' } },
  { kind: 'sound', category: 'SFX', slot: 3, instruments: [sfx.variations[0]!.instrument], patterns: [{ ...sfx.variations[0]!.pattern, slot: 10 }] },
];
const proposal = await call<{ id: string; contentHash: string }>('propose_changes', { title: 'Brighter sky, grass, coin', summary: 'Live test', snapshotHash: summary.snapshotHash, operations });
// A second proposal uses the tile the first one catalogues, so it only applies after it.
const levelProposal = await call<{ id: string; contentHash: string }>('propose_changes', {
  title: 'Second level', summary: 'A small level of grass', snapshotHash: summary.snapshotHash,
  operations: [{ kind: 'create_map', id: levelId, name: 'Level 2', width: 2, height: 1, assets: ['grass', null], description: 'Tiny', profile: 'visual' }],
});
const tools = (await client.listTools()).tools.map(t => t.name);
assert.ok(!tools.some(name => /approve|apply|publish/.test(name)), 'no self-approval tool');
step('MCP: proposals staged; no approval tool exists');

// ---- preview, then apply under the barrier with two editors ------------------------------
const preview = await api<{ result: string }>(`${base}/proposals/${proposal.id}/preview`, jwt, { editorId: editors.alice, snapshot: encode(alice) });
assert.ok(preview.result.length > 0);
const apply = async (id: string, hash: string): Promise<{ id: string }> => {
  await beat();
  return api(`${base}/proposals/${id}/apply`, jwt, { decision: 'APPROVED', contentHash: hash, participants: [editors.alice, editors.bob] });
};
let barrier = await apply(proposal.id, proposal.contentHash);
// Bob typed a line in another file before he froze: his snapshot carries it, Alice's does not.
const notes = new Y.Map<unknown>();
bob.getMap('code.files').set('notes', notes);
notes.set('text', new Y.Text('-- bob was here'));
await api(`${base}/barriers/${barrier.id}/ack`, jwt, { editorId: editors.alice, snapshot: encode(alice) });
await assert.rejects(api(`${base}/barriers/${barrier.id}/finish`, jwt, {}), /Waiting for all editors/);
await api(`${base}/barriers/${barrier.id}/ack`, jwt, { editorId: editors.bob, snapshot: encode(bob) });
// Alice's copy of Bob's line arrives late over WebRTC; her snapshot lacks it, Bob's holds it.
const late = Buffer.from(Y.encodeStateAsUpdate(bob, Y.encodeStateVector(alice))).toString('base64');
await api(`${base}/barriers/${barrier.id}/violation`, jwt, { editorId: editors.alice, reason: 'peer update after pause', update: late });
const applied = await api<{ status: string; result: string }>(`${base}/barriers/${barrier.id}/finish`, jwt, {});
assert.equal(applied.status, 'APPLIED');
for (const doc of [alice, bob]) Y.applyUpdate(doc, Buffer.from(applied.result, 'base64'));
assert.equal((alice.getMap<Y.Map<Y.Text>>('code.files').get('main')!.get('text')!).toString(), after);
assert.equal((alice.getMap<Y.Map<Y.Text>>('code.files').get('notes')!.get('text')!).toString(), '-- bob was here');
assert.equal(bob.getMap('sound.sfx').get('3'), 'coin-pattern');
step('barrier: waited for both editors, accepted a late edit a snapshot held, merged both, applied');

barrier = await apply(levelProposal.id, levelProposal.contentHash);
for (const [name, doc] of [['alice', alice], ['bob', bob]] as const) await api(`${base}/barriers/${barrier.id}/ack`, jwt, { editorId: editors[name], snapshot: encode(doc) });
const levelApplied = await api<{ status: string; result: string }>(`${base}/barriers/${barrier.id}/finish`, jwt, {});
Y.applyUpdate(alice, Buffer.from(levelApplied.result, 'base64'));
assert.ok(alice.getMap('map.maps').has(levelId));
step('a new level made of the catalogued tile applied beside the first map');

// ---- provenance --------------------------------------------------------------------------
const provenance = await api<{ categories: string[] }>(`${base}/provenance`, jwt);
assert.deepEqual([...provenance.categories].sort(), ['CODE', 'MAPS', 'SFX']);
step(`provenance recorded automatically: ${provenance.categories.join(', ')}`);

// ---- a reviewed revert refuses to overwrite later human work -----------------------------
const revert = await api<{ id: string; contentHash: string }>(`${base}/proposals/${proposal.id}/revert`, jwt, {});
(alice.getMap<Y.Map<Y.Text>>('code.files').get('main')!.get('text') as Y.Text).insert(0, '-- human edit\n');
barrier = await apply(revert.id, revert.contentHash);
for (const [name, doc] of [['alice', alice], ['bob', bob]] as const) await api(`${base}/barriers/${barrier.id}/ack`, jwt, { editorId: editors[name], snapshot: encode(doc) });
await assert.rejects(api(`${base}/barriers/${barrier.id}/finish`, jwt, {}), /changed/);
const afterRevert = await api<{ categories: string[] }>(`${base}/provenance`, jwt);
assert.deepEqual([...afterRevert.categories].sort(), ['CODE', 'MAPS', 'SFX'], 'history is kept');
step('revert refused over a later human edit; provenance kept');

// ---- generation through the backend ledger -----------------------------------------------
const job = await call<{ id: string }>('request_generation', { request: { kind: 'midi', prompt: 'a loop', prefix: 'gen', voices: 4 } });
let state = '';
for (let i = 0; i < 50 && !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(state); i++) {
  await new Promise(resolve => setTimeout(resolve, 200));
  state = (await call<{ state: string }>('get_generation', { id: job.id })).state;
}
const finished = await call<{ state: string; model: string; result: { report: { importedNotes: number } } }>('get_generation', { id: job.id });
assert.equal(finished.state, 'SUCCEEDED');
assert.match(finished.model, /stub\/midi@test$/);
assert.equal(finished.result.report.importedNotes, 2);
const listed = await api<{ id: string }[]>(`${base}/jobs`, jwt);
assert.ok(listed.some(j => j.id === job.id), 'editors see the job');
await assert.rejects(fetch(`${backend}/ai/mcp/jobs/${job.id}/complete`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ result: {}, model: 'forged' }) }).then(r => { if (!r.ok) throw new Error(String(r.status)); }), /401|503/);
step('generation: queued in the backend ledger, ran on the endpoint, stored with its model; results cannot be forged with the project token');

await api(`${base}/declarations`, jwt, { categories: ['SPRITES'], note: 'Title art from an external tool' });
assert.ok((await api<{ categories: string[] }>(`${base}/provenance`, jwt)).categories.includes('SPRITES'));
step('manual declaration added SPRITES');

await api(`${base}/connection`, jwt, undefined, 'DELETE');
await assert.rejects(client.listTools());
await client.close().catch(() => undefined);
step('revoking the connection cuts the assistant off');
console.log('\nLive end-to-end: all steps passed.');
