import { z } from 'zod';
import { type Context, type GameMap, lockedCells, type Sheet, sheetRegion } from './native.js';
import type { Grid } from './render.js';

/*
 * Sprite editing for the assistant. Pixels travel as rows of characters, one per pixel: `0`–`f`
 * are palette indices, `.` is index 0 (transparent), and in drawings `_` keeps what is already
 * there. Everything here builds drafts and `pixels` operations; nothing writes to the project.
 */

export const rowsSchema = z.array(z.string().regex(/^[0-9a-fA-F._]{1,64}$/)).min(1).max(64);

export function toRows(grid: Grid): string[] {
  return Array.from({ length: grid.height }, (_, y) => grid.pixels.slice(y * grid.width, (y + 1) * grid.width).map(p => (p === 0 ? '.' : p.toString(16))).join(''));
}

/** Rows to cells, `null` where a drawing keeps the pixel underneath. All rows must be as wide. */
export function parseRows(rows: string[]): { width: number; height: number; cells: (number | null)[] } {
  const width = rows[0]?.length ?? 0;
  if (!width || rows.some(r => r.length !== width)) throw new Error('Every row must have the same number of pixels');
  const cells = rows.flatMap(row => [...row].map(ch => (ch === '_' ? null : ch === '.' ? 0 : parseInt(ch, 16))));
  return { width, height: rows.length, cells };
}

export function gridOfRows(rows: string[]): Grid {
  const { width, height, cells } = parseRows(rows);
  return { width, height, pixels: cells.map(c => c ?? 0) };
}

export function sheetGrid(sheet: Sheet, x: number, y: number, width: number, height: number): Grid {
  return { width, height, pixels: sheetRegion(sheet, x, y, width, height) };
}

export function findSheet(context: Context, sheetId: string): Sheet {
  const sheet = context.sheets.find(s => s.id === sheetId);
  if (!sheet) throw new Error('No such sheet');
  return sheet;
}

/** The sheet and pixel position a sprite number stands for, as `spr(n)` would draw it. */
export function spriteCell(context: Context, sprite: number): { sheet: Sheet; x: number; y: number } | null {
  for (const sheet of context.sheets) {
    const columns = sheet.width / 8, count = columns * (sheet.height / 8);
    if (sprite >= sheet.base && sprite < sheet.base + count) {
      const local = sprite - sheet.base;
      return { sheet, x: (local % columns) * 8, y: Math.floor(local / columns) * 8 };
    }
  }
  return null;
}

/** A map region as pixels: every tile drawn from the sheet its sprite number belongs to. */
export function mapGrid(context: Context, map: GameMap, x: number, y: number, width: number, height: number): Grid {
  if (x < 0 || y < 0 || x + width > map.width || y + height > map.height) throw new Error('Region outside the map');
  const pixels = new Array<number>(width * 8 * height * 8).fill(0);
  for (let ty = 0; ty < height; ty++) for (let tx = 0; tx < width; tx++) {
    const sprite = map.tiles[(y + ty) * map.width + x + tx] ?? 0;
    const cell = sprite ? spriteCell(context, sprite) : null;
    if (!cell) continue;
    const tile = sheetRegion(cell.sheet, cell.x, cell.y, 8, 8);
    tile.forEach((p, i) => { pixels[(ty * 8 + Math.floor(i / 8)) * width * 8 + tx * 8 + (i % 8)] = p; });
  }
  return { width: width * 8, height: height * 8, pixels };
}

/** `rows` painted over `base` at (x, y); `_` keeps the pixel under it. */
export function paint(base: Grid, rows: string[], x = 0, y = 0): Grid {
  const { width, height, cells } = parseRows(rows);
  if (x + width > base.width || y + height > base.height) throw new Error('The drawing does not fit inside the region');
  const pixels = [...base.pixels];
  cells.forEach((c, i) => { if (c !== null) pixels[(y + Math.floor(i / width)) * base.width + x + (i % width)] = c; });
  return { ...base, pixels };
}

export const transformSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('flip'), axis: z.enum(['horizontal', 'vertical']) }).strict(),
  z.object({ op: z.literal('rotate'), quarterTurns: z.number().int().min(1).max(3) }).strict(),
  z.object({ op: z.literal('shift'), dx: z.number().int().min(-64).max(64), dy: z.number().int().min(-64).max(64), wrap: z.boolean().default(true) }).strict(),
  z.object({ op: z.literal('outline'), colour: z.number().int().min(1).max(15), diagonal: z.boolean().default(false) }).strict(),
  z.object({ op: z.literal('recolor'), map: z.record(z.string().regex(/^([0-9]|1[0-5])$/), z.number().int().min(0).max(15)) }).strict(),
  z.object({ op: z.literal('mirror'), half: z.enum(['left', 'right', 'top', 'bottom']) }).strict(),
]);
export type Transform = z.infer<typeof transformSchema>;

export function transform(grid: Grid, step: Transform): Grid {
  const { width: w, height: h, pixels } = grid;
  const at = (x: number, y: number): number => pixels[y * w + x] ?? 0;
  const build = (width: number, height: number, f: (x: number, y: number) => number): Grid =>
    ({ width, height, pixels: Array.from({ length: width * height }, (_, i) => f(i % width, Math.floor(i / width))) });
  switch (step.op) {
    case 'flip':
      return build(w, h, (x, y) => (step.axis === 'horizontal' ? at(w - 1 - x, y) : at(x, h - 1 - y)));
    case 'rotate':
      // Clockwise quarter turns.
      if (step.quarterTurns === 2) return build(w, h, (x, y) => at(w - 1 - x, h - 1 - y));
      return step.quarterTurns === 1 ? build(h, w, (x, y) => at(y, h - 1 - x)) : build(h, w, (x, y) => at(w - 1 - y, x));
    case 'shift':
      return build(w, h, (x, y) => {
        const sx = x - step.dx, sy = y - step.dy;
        if (step.wrap) return at(((sx % w) + w) % w, ((sy % h) + h) % h);
        return sx >= 0 && sy >= 0 && sx < w && sy < h ? at(sx, sy) : 0;
      });
    case 'outline': {
      const around = step.diagonal ? [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]] : [[0, -1], [-1, 0], [1, 0], [0, 1]];
      return build(w, h, (x, y) => {
        if (at(x, y) !== 0) return at(x, y);
        return around.some(([dx, dy]) => { const nx = x + dx!, ny = y + dy!; return nx >= 0 && ny >= 0 && nx < w && ny < h && at(nx, ny) !== 0 && at(nx, ny) !== step.colour; }) ? step.colour : 0;
      });
    }
    case 'recolor':
      return { ...grid, pixels: pixels.map(p => step.map[String(p)] ?? p) };
    case 'mirror':
      return build(w, h, (x, y) => {
        if (step.half === 'left') return x < w / 2 ? at(x, y) : at(w - 1 - x, y);
        if (step.half === 'right') return x >= w / 2 ? at(x, y) : at(w - 1 - x, y);
        if (step.half === 'top') return y < h / 2 ? at(x, y) : at(x, h - 1 - y);
        return y >= h / 2 ? at(x, y) : at(x, h - 1 - y);
      });
  }
}

/**
 * The `pixels` operation that turns the sheet region at (x, y) into `after`. Locked pixels are left
 * as they are and listed, so the proposal can still be applied.
 */
export function pixelOperation(context: Context, sheet: Sheet, x: number, y: number, after: Grid) {
  if (x + after.width > sheet.width || y + after.height > sheet.height) throw new Error('The result does not fit on the sheet there');
  const locked = lockedCells(context, 'sheet', sheet.id);
  const before = sheetGrid(sheet, x, y, after.width, after.height);
  const changes: { x: number; y: number; before: number; after: number }[] = [];
  const skipped: [number, number][] = [];
  const result = [...before.pixels];
  after.pixels.forEach((value, i) => {
    const px = x + (i % after.width), py = y + Math.floor(i / after.width);
    if (value === before.pixels[i]) return;
    if (locked(px, py)) { skipped.push([px, py]); return; }
    changes.push({ x: px, y: py, before: before.pixels[i] ?? 0, after: value });
    result[i] = value;
  });
  return {
    before,
    after: { ...after, pixels: result },
    operation: changes.length ? { kind: 'pixels' as const, sheetId: sheet.id, changes } : null,
    skippedLockedPixels: skipped,
  };
}

/** Plain numbers about a sprite, for comparing drafts beyond looking at them. */
export function spriteStats(grid: Grid, reference?: Grid) {
  const opaque = grid.pixels.filter(p => p !== 0).length;
  const colours = [...new Set(grid.pixels.filter(p => p !== 0))].sort((a, b) => a - b);
  let mirrored = 0;
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) if (grid.pixels[y * grid.width + x] === grid.pixels[y * grid.width + grid.width - 1 - x]) mirrored++;
  // Pixels that touch no other opaque pixel read as noise at the console's size.
  let stray = 0;
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    if (!grid.pixels[y * grid.width + x]) continue;
    const alone = [[0, -1], [-1, 0], [1, 0], [0, 1]].every(([dx, dy]) => {
      const nx = x + dx!, ny = y + dy!;
      return nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height || !grid.pixels[ny * grid.width + nx];
    });
    if (alone) stray++;
  }
  const same = reference && reference.width === grid.width && reference.height === grid.height
    ? grid.pixels.filter((p, i) => p === reference.pixels[i]).length : null;
  return {
    size: `${grid.width}×${grid.height}`,
    opaquePercent: Math.round((100 * opaque) / grid.pixels.length),
    colours,
    horizontalSymmetryPercent: Math.round((100 * mirrored) / grid.pixels.length),
    strayPixels: stray,
    ...(same === null ? {} : { samePixelsAsFirstPercent: Math.round((100 * same) / grid.pixels.length) }),
  };
}
