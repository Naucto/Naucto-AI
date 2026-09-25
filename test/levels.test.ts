import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftLevel, platformReachable } from '../src/levels.js';
import { reachable } from '../src/native.js';

test('seeded top-down scaffolds are repeatable and their carved cells connected', () => {
  const level = draftLevel(15, 15, 42, 'top-down');
  assert.deepEqual(level, draftLevel(15, 15, 42, 'top-down'));
  const walkable = level.roles.map(row => row.map(cell => cell === 'floor'));
  assert.ok(reachable(walkable, [1,1], [13,13]));
});
test('platform validation requires declared support and respects walls', () => {
  const profile = { speed: 3, jump: 6, gravity: 20, width: 0.75, height: 1 };
  const grid = [[false,false,true,false],[false,false,true,false],[true,true,true,true]];
  assert.equal(platformReachable(grid, [0,1], [3,1], profile).reachable, false);
  assert.equal(platformReachable(grid, [0,0], [0,1], profile).reachable, false);
  assert.equal(platformReachable(grid, [0,1], [0,1], profile).reachable, true);
});
