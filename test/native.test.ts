import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjacency, catalogStatus, type Context, designSfx, placeSection, proposalSchema, reachable,
  resolveRoles, sha, tileHash, varyPattern,
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
