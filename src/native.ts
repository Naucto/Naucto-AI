import { createHash } from 'node:crypto';
import { z } from 'zod';

/*
 * Input shapes for proposals. The backend is the one validator that decides what may be written
 * (it re-checks every field against the merged editor state); these schemas only let the assistant
 * fail fast with a readable error instead of a refused request.
 */

export const coordinate = z.number().int().min(0).max(4095);
const id = z.string().min(1).max(100);
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const assetSchema = z.object({
  id,
  name: z.string().min(1).max(100),
  kind: z.enum(['sprite', 'tile', 'animation', 'section', 'music', 'sfx']),
  resourceId: z.string().max(100),
  x: coordinate.optional(),
  y: coordinate.optional(),
  width: z.number().int().min(1).max(64).optional(),
  height: z.number().int().min(1).max(64).optional(),
  frames: z.array(id).max(64).optional(),
  fps: z.number().positive().max(60).optional(),
  connects: z.record(z.enum(['n', 'e', 's', 'w']), z.array(z.string().max(40)).max(16)).optional(),
  tags: z.array(z.string().max(60)).max(30),
  description: z.string().max(2000),
  contentHash: z.string().max(64),
  semantics: z.enum(['unconfirmed', 'walkable', 'solid', 'hazard']),
}).strict();

const instrument = z.record(z.unknown());
const pattern = z.record(z.unknown());

export const operationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('code'), fileId: id, before: z.string().max(100000), after: z.string().max(100000) }).strict(),
  z.object({
    kind: z.literal('pixels'), sheetId: id,
    changes: z.array(z.object({ x: coordinate, y: coordinate, before: z.number().int().min(0).max(15), after: z.number().int().min(0).max(15) }).strict()).min(1).max(65536),
  }).strict(),
  z.object({
    kind: z.literal('tiles'), mapId: id,
    changes: z.array(z.union([
      z.object({ x: coordinate, y: coordinate, before: z.number().int().min(0).max(65535), assetId: id }).strict(),
      z.object({ x: coordinate, y: coordinate, before: z.number().int().min(0).max(65535), sprite: z.number().int().min(0).max(65535) }).strict(),
    ])).min(1).max(65536),
  }).strict(),
  z.object({ kind: z.literal('catalog'), before: assetSchema.nullable(), after: assetSchema.nullable() }).strict(),
  z.object({
    kind: z.literal('sound'), category: z.enum(['MUSIC', 'SFX']), slot: z.number().int().min(0).max(255),
    samples: z.array(z.object({ id, data: z.string().max(11000) }).strict()).max(8).optional(),
    instruments: z.array(instrument).max(16), patterns: z.array(pattern).min(1).max(32), song: z.record(z.unknown()).optional(),
  }).strict(),
  z.object({
    kind: z.literal('create_map'), id: z.string().uuid(), name: z.string().min(1).max(100),
    width: z.number().int().min(1).max(256), height: z.number().int().min(1).max(256),
    assets: z.array(id.nullable()).max(65536), description: z.string().max(4000), profile: z.enum(['top-down', 'platformer', 'visual']),
  }).strict(),
  z.object({
    kind: z.literal('resize_map'), mapId: id, beforeWidth: z.number().int().min(1).max(256), beforeHeight: z.number().int().min(1).max(256),
    width: z.number().int().min(1).max(256), height: z.number().int().min(1).max(256),
  }).strict(),
]);

export const proposalSchema = z.object({
  title: z.string().min(1).max(160),
  summary: z.string().min(1).max(4000),
  snapshotHash: hash,
  operations: z.array(operationSchema).min(1).max(100),
}).strict();

export type Proposal = z.infer<typeof proposalSchema>;

/* ---------------------------------------------------------------- context */

export interface Sheet { id: string; name: string; width: number; height: number; base: number; pixels: string }
export interface GameMap { id: string; name: string; width: number; height: number; tiles: number[] }
export interface Context {
  palette: string[];
  code: { id: string; name: string; text: string }[];
  sheets: Sheet[];
  maps: GameMap[];
  catalog: Record<string, Record<string, unknown>>;
  levels: Record<string, unknown>;
  locks: Record<string, Record<string, unknown>>;
  instruments: Record<string, string>;
  patterns: Record<string, string>;
  songs: Record<string, string>;
  sfx: Record<string, string>;
  samples: string[];
}

export const pixelAt = (sheet: Sheet, x: number, y: number): number => parseInt(sheet.pixels[y * sheet.width + x] ?? '0', 16);

export const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function sheetRegion(sheet: Sheet, x: number, y: number, width: number, height: number): number[] {
  if (x < 0 || y < 0 || x + width > sheet.width || y + height > sheet.height) throw new Error('Region outside the sheet');
  return Array.from({ length: width * height }, (_, i) => pixelAt(sheet, x + (i % width), y + Math.floor(i / width)));
}

export function mapRegion(map: GameMap, x: number, y: number, width: number, height: number): number[] {
  if (x < 0 || y < 0 || x + width > map.width || y + height > map.height) throw new Error('Region outside the map');
  return Array.from({ length: width * height }, (_, i) => map.tiles[(y + Math.floor(i / width)) * map.width + x + (i % width)] ?? 0);
}

export function tileHash(tiles: number[]): string {
  const bytes = new Uint8Array(tiles.length * 2);
  tiles.forEach((value, i) => { bytes[i * 2] = value & 255; bytes[i * 2 + 1] = value >> 8; });
  return sha(bytes);
}

/** The catalog, each entry marked stale when the artwork under it no longer matches its fingerprint. */
export function catalogStatus(context: Context): Record<string, unknown>[] {
  return Object.entries(context.catalog).map(([key, entry]) => {
    let stale: boolean | null = null;
    const x = Number(entry.x), y = Number(entry.y), w = Number(entry.width), h = Number(entry.height);
    try {
      if (entry.kind === 'tile' || entry.kind === 'sprite') {
        const sheet = context.sheets.find(s => s.id === entry.resourceId);
        stale = !sheet || sha(Uint8Array.from(sheetRegion(sheet, x, y, w, h))) !== entry.contentHash;
      } else if (entry.kind === 'section') {
        const map = context.maps.find(m => m.id === entry.resourceId);
        stale = !map || tileHash(mapRegion(map, x, y, w, h)) !== entry.contentHash;
      }
    } catch { stale = true; }
    return { ...entry, id: key, stale };
  });
}

/** The sprite number a catalogued 8×8 tile stands for, as the map editor would place it. */
export function tileNumber(context: Context, assetId: string): number {
  const entry = context.catalog[assetId];
  if (!entry || entry.kind !== 'tile') throw new Error(`${assetId} is not a catalogued tile`);
  const sheet = context.sheets.find(s => s.id === entry.resourceId);
  if (!sheet) throw new Error('Catalogued sheet missing');
  return sheet.base + (Number(entry.y) / 8) * (sheet.width / 8) + Number(entry.x) / 8;
}

/** Places a catalogued map section as a tiles operation; locked cells are reported, not written. */
export function placeSection(context: Context, sectionId: string, mapId: string, x: number, y: number) {
  const section = context.catalog[sectionId];
  if (!section || section.kind !== 'section') throw new Error(`${sectionId} is not a catalogued map section`);
  const source = context.maps.find(m => m.id === section.resourceId);
  const target = context.maps.find(m => m.id === mapId);
  if (!source || !target) throw new Error('Map missing');
  const w = Number(section.width), h = Number(section.height);
  const tiles = mapRegion(source, Number(section.x), Number(section.y), w, h);
  if (tileHash(tiles) !== section.contentHash) throw new Error('The section changed since it was catalogued; ask for it to be registered again');
  if (x + w > target.width || y + h > target.height) throw new Error('The section does not fit there; propose a resize_map first');
  const locked = lockedCells(context, 'map', mapId);
  const changes: { x: number; y: number; before: number; sprite: number }[] = [];
  const skipped: [number, number][] = [];
  tiles.forEach((sprite, i) => {
    const tx = x + (i % w), ty = y + Math.floor(i / w);
    const before = target.tiles[ty * target.width + tx] ?? 0;
    if (locked(tx, ty)) { skipped.push([tx, ty]); return; }
    if (before !== sprite) changes.push({ x: tx, y: ty, before, sprite });
  });
  return { operation: { kind: 'tiles', mapId, changes }, skippedLockedCells: skipped, notice: 'Submit the operation through propose_changes; nothing is written yet.' };
}

export function lockedCells(context: Context, target: 'sheet' | 'map', resourceId: string): (x: number, y: number) => boolean {
  const locks = Object.values(context.locks).filter(l => l.target === target && l.resourceId === resourceId);
  return (x, y) => locks.some(l => x >= Number(l.x) && y >= Number(l.y) && x < Number(l.x) + Number(l.width) && y < Number(l.y) + Number(l.height));
}

/**
 * Resolves a scaffold's semantic roles to catalogued tiles and checks declared adjacency: a tile's
 * `connects.e` must share a terrain tag with its east neighbour's `connects.w`, and so on.
 */
export function resolveRoles(context: Context, roles: string[][], mapping: Record<string, string | null>) {
  const height = roles.length, width = roles[0]?.length ?? 0;
  if (!height || !width || roles.some(row => row.length !== width)) throw new Error('Roles must be a rectangular grid');
  const assets = roles.flat().map(role => {
    if (!(role in mapping)) throw new Error(`No catalog tile chosen for role "${role}"`);
    const asset = mapping[role] ?? null;
    if (asset !== null) tileNumber(context, asset);
    return asset;
  });
  return { width, height, assets, adjacency: adjacency(context, assets, width, height) };
}

export function adjacency(context: Context, assets: (string | null)[], width: number, height: number) {
  const issues: { x: number; y: number; side: string }[] = [];
  const connects = (asset: string | null, side: string): string[] | null => {
    if (!asset) return null;
    const rules = context.catalog[asset]?.connects as Record<string, string[]> | undefined;
    return rules?.[side] ?? null;
  };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const here = assets[y * width + x] ?? null;
    for (const [dx, dy, side, facing] of [[1, 0, 'e', 'w'], [0, 1, 's', 'n']] as const) {
      if (x + dx >= width || y + dy >= height) continue;
      const there = assets[(y + dy) * width + x + dx] ?? null;
      const a = connects(here, side), b = connects(there, facing);
      if (a && b && !a.some(tag => b.includes(tag))) issues.push({ x, y, side });
    }
  }
  const declared = new Set(assets.filter(a => a && context.catalog[a]?.connects)).size;
  return { issues: issues.slice(0, 200), issueCount: issues.length, checkedTiles: declared, note: declared ? 'Only tiles with declared `connects` rules are checked.' : 'No catalogued tile declares adjacency rules; nothing was checked.' };
}

/** Unweighted flood fill for a declared top-down movement profile; not arbitrary Lua. */
export function reachable(grid: boolean[][], start: [number, number], end: [number, number]): boolean {
  const walkable = (x: number, y: number): boolean => grid[y]?.[x] === true;
  if (!walkable(...start) || !walkable(...end)) return false;
  const queue: [number, number][] = [start];
  const seen = new Set([start.join(',')]);
  for (let i = 0; i < queue.length; i++) {
    const [x, y] = queue[i]!;
    if (x === end[0] && y === end[1]) return true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx, ny = y + dy, key = `${nx},${ny}`;
      if (walkable(nx, ny) && !seen.has(key)) { seen.add(key); queue.push([nx, ny]); }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ sound */

export const SFX_KINDS = ['coin', 'jump', 'damage', 'explosion', 'laser', 'powerup', 'select', 'door'] as const;
export type SfxKind = (typeof SFX_KINDS)[number];

const SHAPES: Record<SfxKind, { osc: string; pitches: number[]; sweep: number }> = {
  coin: { osc: 'square', pitches: [84, 91], sweep: 0 },
  jump: { osc: 'square', pitches: [48, 55, 62, 69], sweep: 0 },
  damage: { osc: 'noise', pitches: [48, 40, 32], sweep: 0 },
  explosion: { osc: 'noise', pitches: [36, 30, 26, 22, 20], sweep: 0 },
  laser: { osc: 'saw', pitches: [96, 88, 80, 72], sweep: 0 },
  powerup: { osc: 'triangle', pitches: [60, 64, 67, 72, 76, 79, 84], sweep: 0 },
  select: { osc: 'square', pitches: [72, 79], sweep: 0 },
  door: { osc: 'noise', pitches: [40, 44], sweep: 0 },
};

export interface SfxControls {
  /** 0.25–4: stretches the effect in time. */
  duration: number;
  /** -24…24 semitones. */
  pitch: number;
  /** 0–1: filter opening. */
  brightness: number;
  /** 0–1: loudness. */
  intensity: number;
  /** Deterministic alternatives, 1–4. */
  variations: number;
}

/** Editable effects built from Naucto's own synth parameters; one instrument and pattern each. */
export function designSfx(kind: SfxKind, id: string, controls: SfxControls) {
  const shape = SHAPES[kind];
  const out = [];
  for (let v = 0; v < controls.variations; v++) {
    const vid = controls.variations > 1 ? `${id}-${v + 1}` : id;
    const spread = v === 0 ? 0 : (v % 2 ? 1 : -1) * Math.ceil(v / 2) * 2;
    const length = Math.max(0.125, Math.round(controls.duration * 8) / 8);
    const notes = shape.pitches.map((p, i) => ({
      pitch: Math.max(0, Math.min(127, p + controls.pitch + spread)),
      step: Math.round(i * length * 8) / 8,
      length,
      volume: Math.max(0.05, Math.min(1, controls.intensity * (1 - i * 0.08))),
      instrument: vid,
    }));
    const steps = Math.min(64, Math.max(16, Math.ceil((notes.at(-1)!.step + length) / 16) * 16));
    out.push({
      instrument: {
        id: vid, name: `${kind} ${v + 1}`, osc: shape.osc, duty: 0.5, detune: 0, glide: kind === 'laser' ? 0.02 : 0,
        env: { attack: 0.001, decay: 0.04 * controls.duration, sustain: kind === 'explosion' ? 0.2 : 0.3, release: 0.03 * controls.duration },
        vibrato: { rate: 0, depth: 0, delay: 0 }, arp: { rate: 0 },
        filter: controls.brightness >= 0.95 ? { type: 'off', cutoff: 8000, resonance: 0, envAmount: 0 } : { type: 'lp', cutoff: Math.round(400 + controls.brightness * 7600), resonance: 0.2, envAmount: 0.5 },
        volume: Math.max(0.05, Math.min(1, 0.3 + controls.intensity * 0.5)), pan: 0, colour: 4,
      },
      pattern: { id: `${vid}-pattern`, slot: 0, name: `${kind} ${v + 1}`, bpm: 180, stepsPerBeat: 8, steps, notes },
    });
  }
  return { variations: out, notice: 'Drafts: choose unused pattern and SFX slots, submit one as a `sound` operation with category SFX, and audition it in Naucto.' };
}

interface PatternNote { step: number; pitch: number; length: number; instrument: string; volume: number }

/**
 * Deterministic variations of an existing pattern: the assistant composes, these keep the result on
 * the grid and inside the voice budget. They are not a learned continuation.
 */
export function varyPattern(source: { notes: PatternNote[]; steps: number }, how: 'transpose' | 'invert' | 'retrograde' | 'rhythm' | 'thin', amount: number, newId: string) {
  const notes = source.notes.map(n => ({ ...n }));
  const pitches = notes.map(n => n.pitch);
  const axis = pitches.length ? (Math.max(...pitches) + Math.min(...pitches)) / 2 : 60;
  let out: PatternNote[];
  switch (how) {
    case 'transpose': out = notes.map(n => ({ ...n, pitch: n.pitch + amount })); break;
    case 'invert': out = notes.map(n => ({ ...n, pitch: Math.round(2 * axis - n.pitch) })); break;
    case 'retrograde': out = notes.map(n => ({ ...n, step: Math.max(0, source.steps - n.step - n.length) })); break;
    case 'rhythm': out = notes.map((n, i) => ({ ...n, step: Math.min(source.steps - 0.125, i % 2 ? n.step + Math.max(0.125, amount / 8) : n.step) })); break;
    case 'thin': out = notes.filter((_, i) => i % Math.max(2, amount) === 0); break;
  }
  out = out.filter(n => n.pitch >= 0 && n.pitch <= 127).map(n => ({ ...n, step: Math.round(n.step * 8) / 8 }));
  return { pattern: { ...source, id: newId, notes: out }, notice: 'Draft: give it an unused slot and include it in a sound proposal.' };
}
