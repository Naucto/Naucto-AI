import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '../src/native.js';
import { gridOfRows, mapGrid, paint, pixelOperation, sheetGrid, spriteCell, spriteStats, toRows, transform } from '../src/sprites.js';

function project(): Context {
  const pixels = new Array(16 * 16).fill('0');
  pixels[8] = '3'; // sprite 1, top-left pixel
  return {
    palette: [], code: [], catalog: {}, levels: {}, instruments: {}, patterns: {}, songs: {}, sfx: {}, samples: [],
    sheets: [{ id: 's', name: 'sprites', width: 16, height: 16, base: 0, pixels: pixels.join('') }],
    maps: [{ id: 'm', name: 'map', width: 2, height: 1, tiles: [0, 1] }],
    locks: { l: { target: 'sheet', resourceId: 's', x: 1, y: 0, width: 1, height: 1 } },
  };
}

test('rows read and write palette indices, "." is transparent and "_" keeps', () => {
  const grid = gridOfRows(['.1', 'f.']);
  assert.deepEqual(grid.pixels, [0, 1, 15, 0]);
  assert.deepEqual(toRows(grid), ['.1', 'f.']);
  assert.deepEqual(paint(grid, ['_2'], 0, 1).pixels, [0, 1, 15, 2]);
  assert.throws(() => gridOfRows(['12', '1']), /same number/);
});

test('transforms turn, flip, shift, outline and mirror', () => {
  const l = gridOfRows(['1.', '1.', '11']);
  assert.deepEqual(toRows(transform(l, { op: 'rotate', quarterTurns: 1 })), ['111', '1..']);
  assert.deepEqual(toRows(transform(l, { op: 'rotate', quarterTurns: 3 })), ['..1', '111']);
  assert.deepEqual(toRows(transform(l, { op: 'flip', axis: 'horizontal' })), ['.1', '.1', '11']);
  assert.deepEqual(toRows(transform(l, { op: 'shift', dx: 1, dy: 0, wrap: true })), ['.1', '.1', '11']);
  assert.deepEqual(toRows(transform(gridOfRows(['...', '.1.', '...']), { op: 'outline', colour: 2, diagonal: false })), ['.2.', '212', '.2.']);
  assert.deepEqual(toRows(transform(gridOfRows(['12..']), { op: 'mirror', half: 'left' })), ['1221']);
  assert.deepEqual(toRows(transform(l, { op: 'recolor', map: { '1': 5 } })), ['5.', '5.', '55']);
});

test('drawing on the sheet becomes a pixels operation that leaves locked pixels alone', () => {
  const context = project();
  const sheet = context.sheets[0]!;
  const result = pixelOperation(context, sheet, 0, 0, gridOfRows(['77']));
  assert.deepEqual(result.operation?.changes, [{ x: 0, y: 0, before: 0, after: 7 }]);
  assert.deepEqual(result.skippedLockedPixels, [[1, 0]]);
  assert.deepEqual(toRows(result.after), ['7.']);
  assert.equal(pixelOperation(context, sheet, 0, 0, sheetGrid(sheet, 0, 0, 2, 2)).operation, null, 'no change, no operation');
});

test('maps are drawn from the sheet their sprite numbers point at', () => {
  const context = project();
  assert.deepEqual(spriteCell(context, 1), { sheet: context.sheets[0], x: 8, y: 0 });
  const grid = mapGrid(context, context.maps[0]!, 0, 0, 2, 1);
  assert.equal(grid.width, 16);
  assert.equal(grid.pixels[8], 3);
  assert.equal(grid.pixels[0], 0, 'the empty cell stays transparent');
});

test('sprite numbers compare drafts beyond looking', () => {
  const stats = spriteStats(gridOfRows(['1..1', '....', '.11.']), gridOfRows(['1..1', '....', '....']));
  assert.equal(stats.opaquePercent, 33);
  assert.equal(stats.strayPixels, 2);
  assert.equal(stats.horizontalSymmetryPercent, 100);
  assert.equal(stats.samePixelsAsFirstPercent, 83);
});
