import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjacency, catalogStatus, type Context, designSfx, netPermissionExpectation, netPermissionRows, operationSchema, netReferencedPaths, netUndeclaredUsages, placeSection,
  proposalSchema, reachable, resolveFlags, resolveRoles, sha, tileHash, varyPattern,
} from '../src/native.js';

function context(): Context {
  const pixels = '0'.repeat(128 * 128).split('');
  pixels[8] = '3';
  return {
    palette: [], code: [], samples: [], instruments: {}, patterns: {}, songs: {}, sfx: {}, levels: {},
    sheets: [{ id: '0', name: 'sprites', width: 128, height: 128, base: 0, pixels: pixels.join('') }],
    maps: [{ id: '0', name: 'map', width: 8, height: 4, tiles: [1, 2, 0, 0, 0, 0, 0, 0, ...new Array(24).fill(0)] }],
    catalog: {},
    locks: { spawn: { target: 'map', resourceId: '0', x: 4, y: 0, width: 1, height: 1 } },
  };
}

test('connectivity cannot cross walls or start outside the map', () => {
  assert.equal(reachable([[true, false, true]], [0, 0], [2, 0]), false);
  assert.equal(reachable([[true, true], [false, true]], [0, 0], [1, 1]), true);
});

test('proposals cannot smuggle approval or opaque updates', () => {
  const base = { title: 'edit', summary: 'edit main', snapshotHash: 'a'.repeat(64), operations: [{ kind: 'code', fileId: 'main', before: '', after: 'print(1)' }] };
  assert.equal(proposalSchema.safeParse(base).success, true);
  assert.equal(proposalSchema.safeParse({ ...base, approved: true }).success, false);
  assert.equal(proposalSchema.safeParse({ ...base, operations: [{ kind: 'applyYjsUpdate', data: 'x' }] }).success, false);
});

test('catalog entries go stale when their artwork changes', () => {
  const c = context();
  const tile = new Uint8Array(64); tile[0] = 3;
  c.catalog.grass = { kind: 'tile', resourceId: '0', x: 8, y: 0, width: 8, height: 8, contentHash: sha(tile) };
  assert.equal(catalogStatus(c)[0]?.stale, false);
  c.sheets[0]!.pixels = '0'.repeat(128 * 128);
  assert.equal(catalogStatus(c)[0]?.stale, true);
});

test('a placed section skips locked cells and cites current tiles', () => {
  const c = context();
  c.catalog.pair = { kind: 'section', resourceId: '0', x: 0, y: 0, width: 2, height: 1, contentHash: tileHash([1, 2]) };
  const placed = placeSection(c, 'pair', '0', 3, 0);
  assert.deepEqual(placed.skippedLockedCells, [[4, 0]]);
  assert.deepEqual(placed.operation.changes, [{ x: 3, y: 0, before: 0, sprite: 1 }]);
  assert.throws(() => placeSection(c, 'pair', '0', 7, 0), /fit/);
});

test('role resolution requires a catalogued tile per role and reports adjacency', () => {
  const c = context();
  const tile = new Uint8Array(64); tile[0] = 3;
  c.catalog.water = { kind: 'tile', resourceId: '0', x: 8, y: 0, connects: { e: ['water'], w: ['water'] } };
  c.catalog.grass = { kind: 'tile', resourceId: '0', x: 0, y: 0, connects: { e: ['grass'], w: ['grass'] } };
  assert.throws(() => resolveRoles(c, [['floor']], {}), /No catalog tile/);
  const resolved = resolveRoles(c, [['floor', 'wall']], { floor: 'water', wall: 'grass' });
  assert.equal(resolved.adjacency.issueCount, 1);
  assert.equal(adjacency(c, ['water', 'water'], 2, 1).issueCount, 0);
});

test('SFX designs stay in range and give distinct variations', () => {
  const { variations } = designSfx('laser', 'zap', { duration: 1, pitch: 30 - 30, brightness: 0.4, intensity: 1, variations: 3 });
  assert.equal(variations.length, 3);
  assert.ok(variations.every(v => v.pattern.notes.every(n => n.pitch >= 0 && n.pitch <= 127 && n.step + n.length <= v.pattern.steps)));
  assert.notDeepEqual(variations[0]!.pattern.notes.map(n => n.pitch), variations[1]!.pattern.notes.map(n => n.pitch));
  assert.equal(variations[0]!.instrument.filter.type, 'lp');
});

test('pattern variations keep notes on the grid', () => {
  const source = { steps: 16, notes: [{ step: 0, pitch: 60, length: 1, instrument: 'i', volume: 1 }, { step: 4, pitch: 67, length: 2, instrument: 'i', volume: 1 }] };
  assert.deepEqual(varyPattern(source, 'invert', 0, 'v').pattern.notes.map(n => n.pitch), [67, 60]);
  assert.deepEqual(varyPattern(source, 'retrograde', 0, 'v').pattern.notes.map(n => n.step), [15, 10]);
  assert.equal(varyPattern(source, 'transpose', 100, 'v').pattern.notes.length, 0);
});

test('a path takes the permissions of the nearest ancestor that declares any', () => {
  const declared = new Map([['players', 0], ['players.score', 1]]);
  assert.equal(resolveFlags(declared, 'players.score'), 1, 'its own declaration wins');
  assert.equal(resolveFlags(declared, 'players.name'), 0, 'the ancestor closes the rest');
  assert.equal(resolveFlags(new Map(), 'anything'), null, 'unconfigured is open, not denied');
  // A root entry of 0 closes the whole table; reading it as "unset" would open it instead.
  assert.equal(resolveFlags(new Map([['', 0]]), 'deep.down.here'), 0);
});

test('the declared table says who may reach a path, and what a session starts it at', () => {
  const rows = netPermissionRows({
    ...context(),
    netPermissions: {
      'players.score': { flags: 1, default: 0 },
      'secrets': { flags: 0 },
    },
  });
  const byPath = Object.fromEntries(rows.map(row => [row['path'], row]));
  assert.deepEqual(
    { read: byPath['players.score']!['clientRead'], write: byPath['players.score']!['clientWrite'] },
    { read: true, write: false },
  );
  assert.equal(byPath['players.score']!['default'], 0);
  assert.equal(byPath['secrets']!['clientRead'], false);
  assert.equal(byPath['secrets']!['clientWrite'], false);
});

test('a declaration nothing in the code mentions is worth pointing out', () => {
  const c: Context = {
    ...context(),
    code: [{ id: 'main', name: 'main', text: 'net.state.players.score = 1\nnet.on("players.score", go)' }],
    netPermissions: { 'players.score': { flags: 3 }, 'room.theme': { flags: 3 } },
  };
  assert.deepEqual([...netReferencedPaths(c)].sort(), ['players', 'players.score']);
  const rows = netPermissionRows(c);
  assert.equal(rows.find(r => r['path'] === 'players.score')!['referencedInCode'], true);
  assert.equal(rows.find(r => r['path'] === 'room.theme')!['referencedInCode'], false);
});

test('a declaration the host would ignore is reported as malformed, not as private', () => {
  // `netPermissionsOf` stores whatever `flags` is and the resolver skips anything that is not a
  // number, so a malformed entry resolves as unconfigured — which is open. Reporting "private"
  // here would be a confident answer about a boundary that is not in force.
  const rows = netPermissionRows({ ...context(), netPermissions: { secrets: { default: 1 } as never } });
  assert.equal(rows[0]!['invalid'], true);
  assert.equal(rows[0]!['ownFlags'], null);
  assert.equal(rows[0]!['clientRead'], true, 'unconfigured is open, which is what the host does');
  assert.equal(rows[0]!['clientWrite'], true);
});

test('a declaration inside the lock/queue branch is not reported at all', () => {
  const rows = netPermissionRows({
    ...context(),
    netPermissions: { 'room.__netobj__.q': { flags: 0 }, 'room': { flags: 3 } },
  });
  assert.deepEqual(rows.map(r => r['path']), ['room']);
});

test('a nested declaration does not leave its parents looking undeclared', () => {
  const rows = netPermissionRows({
    ...context(),
    code: [{ id: 'main', name: 'main', text: 'net.state.players.score = 1' }],
    netPermissions: { 'players.score': { flags: 1 } },
  });
  assert.deepEqual(rows.map((row) => row['path']), ['players.score']);
  assert.deepEqual(netUndeclaredUsages({
    ...context(),
    code: [{ id: 'main', name: 'main', text: 'net.state.players.score = 1' }],
    netPermissions: { 'players.score': { flags: 1 } },
  }), [], 'players is implied by players.score, so it is not undeclared');
  // A path with nothing above it really is undeclared.
  assert.deepEqual(netUndeclaredUsages({
    ...context(),
    code: [{ id: 'main', name: 'main', text: 'net.state.room.theme = 1' }],
    netPermissions: { 'players.score': { flags: 1 } },
  }), ['room', 'room.theme']);
});

test('a row says which ancestor is closing it', () => {
  const rows = netPermissionRows({ ...context(), netPermissions: { players: { flags: 0 }, 'players.score': { flags: 3 } } });
  const score = rows.find(r => r['path'] === 'players.score')!;
  assert.equal(score['inheritedFrom'], null, 'it declares its own');
  const name = netPermissionRows({ ...context(), netPermissions: { players: { flags: 0 } } })[0]!;
  assert.equal(name['clientRead'], false);
});

test('a declaration carries what it expects to find, so a change to it is a conflict and not an overwrite', () => {
  // The Backend refuses a net_permissions operation with no expectation. Filling it in from the
  // state the proposal was written against is what makes that safe rather than merely strict: a
  // colleague who changes the declaration in the meantime is a conflict, not a silent overwrite.
  const c: Context = { ...context(), netPermissions: { 'players.score': { flags: 3, default: 1 } } };
  assert.deepEqual(netPermissionExpectation(c, 'players.score'), { flags: 3, default: 1 });

  // A path that declares nothing expects nothing.
  assert.equal(netPermissionExpectation(c, 'players.other'), null);
  // A malformed entry stores no flags, so the host resolves it as unconfigured; expecting a
  // declaration there would be believing one the engine does not read.
  assert.equal(netPermissionExpectation({ ...c, netPermissions: { bad: { default: 1 } as never } }, 'bad'), null);

  // And the model can still state its own, which is what a revert does.
  const parsed = operationSchema.parse({ kind: 'net_permissions', path: 'players.score', remove: true, expect: { flags: 3 } });
  assert.equal(parsed.kind, 'net_permissions');
  assert.deepEqual(parsed.kind === 'net_permissions' ? parsed.expect : undefined, { flags: 3 });
});
