import { deflateSync } from 'node:zlib';

/*
 * Pictures for the assistant: sprites, sheets, maps and sounds drawn to PNG so a model that sees
 * images can judge them the way a person would, instead of reading hex. No canvas dependency: an
 * RGBA buffer, a 3×5 pixel font and a PNG encoder are all it takes.
 */

export type Rgba = readonly [number, number, number, number];

const BACKGROUND: Rgba = [24, 24, 32, 255];
const INK: Rgba = [220, 220, 230, 255];
const DIM: Rgba = [110, 110, 130, 255];
const CHECKER: [Rgba, Rgba] = [[64, 64, 76, 255], [84, 84, 98, 255]];
/** Largest side of any picture returned, so one answer never carries a huge image. */
export const MAX_SIDE = 2048;

export function hexColour(hex: string): Rgba {
  const value = parseInt(hex.replace('#', ''), 16);
  return Number.isFinite(value) ? [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255] : [255, 0, 255, 255];
}

// Each glyph is five rows of three bits, left pixel high.
const FONT: Record<string, number[]> = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 3, 1, 7], '4': [5, 5, 7, 1, 1],
  '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 1, 2, 2], '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7],
  A: [2, 5, 7, 5, 5], B: [6, 5, 6, 5, 6], C: [3, 4, 4, 4, 3], D: [6, 5, 5, 5, 6], E: [7, 4, 6, 4, 7], F: [7, 4, 6, 4, 4],
  G: [3, 4, 5, 5, 3], H: [5, 5, 7, 5, 5], I: [7, 2, 2, 2, 7], J: [1, 1, 1, 5, 2], K: [5, 5, 6, 5, 5], L: [4, 4, 4, 4, 7],
  M: [5, 7, 7, 5, 5], N: [6, 5, 5, 5, 5], O: [2, 5, 5, 5, 2], P: [6, 5, 6, 4, 4], Q: [2, 5, 5, 6, 3], R: [6, 5, 6, 5, 5],
  S: [3, 4, 2, 1, 6], T: [7, 2, 2, 2, 2], U: [5, 5, 5, 5, 7], V: [5, 5, 5, 5, 2], W: [5, 5, 7, 7, 5], X: [5, 5, 2, 5, 5],
  Y: [5, 5, 2, 2, 2], Z: [7, 1, 2, 4, 7], ' ': [0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 2], ',': [0, 0, 0, 2, 4],
  '-': [0, 0, 7, 0, 0], ':': [0, 2, 0, 2, 0], '/': [1, 1, 2, 4, 4], '%': [5, 1, 2, 4, 5], '#': [5, 7, 5, 7, 5],
  '(': [1, 2, 2, 2, 1], ')': [4, 2, 2, 2, 4], '_': [0, 0, 0, 0, 7], '+': [0, 2, 7, 2, 0], '=': [0, 7, 0, 7, 0],
  '×': [0, 5, 2, 5, 0], '?': [7, 1, 2, 0, 2], '<': [1, 2, 4, 2, 1], '>': [4, 2, 1, 2, 4], "'": [2, 2, 0, 0, 0],
};

export class Canvas {
  readonly data: Uint8Array;

  constructor(readonly width: number, readonly height: number, background: Rgba = BACKGROUND) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE * 2 || height > MAX_SIDE * 2) throw new Error('Picture too large');
    this.data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.data.set(background, i * 4);
  }

  set(x: number, y: number, [r, g, b, a]: Rgba): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a === 0) return;
    const i = (y * this.width + x) * 4;
    if (a === 255) { this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; this.data[i + 3] = 255; return; }
    const k = a / 255;
    this.data[i] = Math.round(r * k + this.data[i]! * (1 - k));
    this.data[i + 1] = Math.round(g * k + this.data[i + 1]! * (1 - k));
    this.data[i + 2] = Math.round(b * k + this.data[i + 2]! * (1 - k));
  }

  rect(x: number, y: number, w: number, h: number, colour: Rgba): void {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w)), y1 = Math.min(this.height, Math.floor(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.set(xx, yy, colour);
  }

  frame(x: number, y: number, w: number, h: number, colour: Rgba): void {
    this.rect(x, y, w, 1, colour); this.rect(x, y + h - 1, w, 1, colour);
    this.rect(x, y, 1, h, colour); this.rect(x + w - 1, y, 1, h, colour);
  }

  /** Width of `text` in pixels at `size`. */
  static measure(text: string, size = 1): number {
    return text.length ? (text.length * 4 - 1) * size : 0;
  }

  text(x: number, y: number, text: string, colour: Rgba = INK, size = 1): void {
    let cx = x;
    for (const ch of text.toUpperCase()) {
      const glyph = FONT[ch] ?? FONT['?']!;
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < 3; gx++) if (row & (4 >> gx)) this.rect(cx + gx * size, y + gy * size, size, size, colour);
      });
      cx += 4 * size;
    }
  }

  blit(source: Canvas, x: number, y: number): void {
    for (let sy = 0; sy < source.height; sy++) for (let sx = 0; sx < source.width; sx++) {
      const i = (sy * source.width + sx) * 4;
      this.set(x + sx, y + sy, [source.data[i]!, source.data[i + 1]!, source.data[i + 2]!, source.data[i + 3]!]);
    }
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An 8-bit RGBA PNG. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  if (rgba.length !== width * height * 4) throw new Error('Pixel buffer does not match the size');
  const chunk = (type: string, data: Uint8Array): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    out.set(data, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

/** An MCP image block. */
export const image = (canvas: Canvas) => ({ type: 'image' as const, data: canvas.png().toString('base64'), mimeType: 'image/png' });

/* ------------------------------------------------------------------ pixel art */

/** Palette indices, row-major; index 0 is transparent, as on the console. */
export interface Grid { width: number; height: number; pixels: number[] }

/** The largest whole scale at which a `width × height` picture stays within `side` pixels. */
export function fitScale(width: number, height: number, wanted: number, side = MAX_SIDE): number {
  return Math.max(1, Math.min(wanted, Math.floor(side / Math.max(width, height))));
}

/** Transparent cells drawn as a checkerboard so they read as empty, not black. */
function checker(canvas: Canvas, x: number, y: number, size: number): void {
  const half = Math.max(1, size >> 1);
  for (let cy = 0; cy < size; cy += half) for (let cx = 0; cx < size; cx += half) {
    canvas.rect(x + cx, y + cy, Math.min(half, size - cx), Math.min(half, size - cy), CHECKER[((cx + cy) / half) % 2]!);
  }
}

export function drawGrid(canvas: Canvas, grid: Grid, palette: string[], x: number, y: number, scale: number): void {
  const colours = palette.map(hexColour);
  for (let py = 0; py < grid.height; py++) for (let px = 0; px < grid.width; px++) {
    const index = grid.pixels[py * grid.width + px] ?? 0;
    if (index === 0) checker(canvas, x + px * scale, y + py * scale, scale);
    else canvas.rect(x + px * scale, y + py * scale, scale, scale, colours[index] ?? [255, 0, 255, 255]);
  }
}

export interface GridView {
  scale?: number;
  /** Cell size in source pixels for grid lines (8 = sprite cells); 0 for none. */
  cell?: number;
  /** Source coordinates of the top-left pixel, for the rulers. */
  origin?: [number, number];
  /** Unit the rulers count in, in source pixels: 1 labels pixels, 8 labels tiles. */
  unit?: number;
  label?: string;
}

/**
 * A grid of palette indices, enlarged, with a checkerboard for transparency, cell lines and rulers
 * whose numbers are the coordinates a tool takes.
 */
export function gridPicture(grid: Grid, palette: string[], view: GridView = {}): Canvas {
  const scale = fitScale(grid.width, grid.height, view.scale ?? 8);
  const cell = view.cell ?? 8;
  const [ox, oy] = view.origin ?? [0, 0];
  const unit = view.unit ?? 1;
  const ruler = Canvas.measure(String(Math.floor((Math.max(ox + grid.width, oy + grid.height)) / unit)), 1) + 4;
  const top = (view.label ? 8 : 0) + 8;
  const canvas = new Canvas(ruler + grid.width * scale + 2, top + grid.height * scale + 2);
  if (view.label) canvas.text(ruler, 1, view.label, INK);
  drawGrid(canvas, grid, palette, ruler, top, scale);
  // Ruler marks where a label fits without touching the next one.
  const every = (span: number): number => {
    const room = (Canvas.measure(String(Math.floor(span / unit)), 1) + 4) / scale;
    const steps = [1, 2, 4, 8, 16, 32, 64, 128, 256].map(s => s * unit);
    return steps.find(s => s >= room && (cell === 0 || s % cell === 0 || cell % s === 0)) ?? 256 * unit;
  };
  const stepX = every(ox + grid.width), stepY = Math.max(unit, Math.ceil(7 / scale / unit) * unit);
  for (let px = 0; px < grid.width; px++) {
    const sx = ox + px;
    if (sx % stepX === 0) { canvas.text(ruler + px * scale, top - 7, String(sx / unit), DIM); canvas.rect(ruler + px * scale, top - 1, 1, 1, DIM); }
  }
  for (let py = 0; py < grid.height; py++) {
    const sy = oy + py;
    if (sy % stepY === 0) canvas.text(1, top + py * scale + Math.max(0, (Math.min(scale, 8) - 5) >> 1), String(sy / unit), DIM);
  }
  if (cell > 0 && scale >= 2) {
    const line: Rgba = [255, 255, 255, 60];
    for (let px = cell - (ox % cell || cell); px < grid.width; px += cell) if (px > 0) canvas.rect(ruler + px * scale, top, 1, grid.height * scale, line);
    for (let py = cell - (oy % cell || cell); py < grid.height; py += cell) if (py > 0) canvas.rect(ruler, top + py * scale, grid.width * scale, 1, line);
  }
  canvas.frame(ruler - 1, top - 1, grid.width * scale + 2, grid.height * scale + 2, DIM);
  return canvas;
}

/** The grid repeated `times × times`, to judge a tile that has to join seamlessly with itself. */
export function tiled(grid: Grid, times = 3): Grid {
  const width = grid.width * times, height = grid.height * times;
  return { width, height, pixels: Array.from({ length: width * height }, (_, i) => grid.pixels[((Math.floor(i / width) % grid.height) * grid.width) + ((i % width) % grid.width)] ?? 0) };
}

/** Pictures side by side, each under its own caption, top-aligned. */
export function sideBySide(panels: { label: string; canvas: Canvas }[], gap = 12): Canvas {
  const height = Math.max(...panels.map(p => p.canvas.height)) + 10;
  const widths = panels.map(p => Math.max(p.canvas.width, Canvas.measure(p.label) + 2));
  const canvas = new Canvas(widths.reduce((a, b) => a + b, 0) + gap * (panels.length + 1), height + gap);
  let x = gap;
  panels.forEach((panel, i) => {
    canvas.text(x, gap / 2, panel.label, INK);
    canvas.blit(panel.canvas, x, gap / 2 + 9);
    x += widths[i]! + gap;
  });
  return canvas;
}

/** Panels stacked top to bottom, left-aligned. */
export function stacked(panels: Canvas[], gap = 8): Canvas {
  const canvas = new Canvas(Math.max(...panels.map(p => p.width)), panels.reduce((a, p) => a + p.height, 0) + gap * (panels.length - 1));
  let y = 0;
  for (const panel of panels) { canvas.blit(panel, 0, y); y += panel.height + gap; }
  return canvas;
}

/* ------------------------------------------------------------------ sound */

/** One colour per instrument, in the order instruments first appear. */
const TRACK_COLOURS: Rgba[] = [
  [255, 119, 168, 255], [41, 173, 255, 255], [0, 228, 54, 255], [255, 163, 0, 255], [255, 236, 39, 255],
  [131, 118, 156, 255], [255, 204, 170, 255], [171, 82, 54, 255], [194, 195, 199, 255], [126, 37, 83, 255],
];

export interface RollNote { start: number; end: number; pitch: number; volume: number; lane: number; drum?: boolean }

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (pitch: number): string => `${NAMES[pitch % 12]!}${Math.floor(pitch / 12) - 1}`;

/**
 * Notes as bars over time and pitch: colour is the instrument, brightness the volume, and dashed
 * lines mark pattern boundaries. `lanes` names the colours.
 */
export function pianoRoll(notes: RollNote[], duration: number, options: { lanes?: string[]; marks?: number[]; width?: number; label?: string } = {}): Canvas {
  const pitches = notes.map(n => n.pitch);
  let low = pitches.length ? Math.min(...pitches) - 2 : 58, high = pitches.length ? Math.max(...pitches) + 2 : 74;
  if (high - low < 24) { const middle = Math.round((low + high) / 2); low = middle - 12; high = middle + 12; }
  const row = Math.max(2, Math.min(8, Math.floor(480 / (high - low + 1))));
  const left = 28, top = options.label ? 12 : 4, width = options.width ?? 960;
  const plot = width - left - 4, rows = high - low + 1;
  const legend = options.lanes?.length ? 12 : 0;
  const canvas = new Canvas(width, top + rows * row + 14 + legend);
  if (options.label) canvas.text(left, 3, options.label);
  const x = (t: number): number => left + Math.round((t / Math.max(duration, 1e-3)) * plot);
  for (let p = low; p <= high; p++) {
    const y = top + (high - p) * row;
    if ([1, 3, 6, 8, 10].includes(p % 12)) canvas.rect(left, y, plot, row, [30, 30, 40, 255]);
    if (p % 12 === 0) { canvas.rect(left, y + row - 1, plot, 1, [60, 60, 76, 255]); canvas.text(1, y + row - 5, noteName(p), DIM); }
  }
  for (const mark of options.marks ?? []) for (let y = top; y < top + rows * row; y += 4) canvas.rect(x(mark), y, 1, 2, [120, 120, 150, 255]);
  const tick = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find(s => duration / s <= 12) ?? 60;
  for (let t = 0; t <= duration + 1e-9; t += tick) {
    canvas.rect(x(t), top + rows * row, 1, 3, DIM);
    canvas.text(x(t) + 2, top + rows * row + 4, `${Number(t.toFixed(2))}S`, DIM);
  }
  for (const note of notes) {
    const [r, g, b] = TRACK_COLOURS[note.lane % TRACK_COLOURS.length]!;
    const k = 0.45 + 0.55 * Math.max(0, Math.min(1, note.volume));
    const colour: Rgba = [Math.round(r * k), Math.round(g * k), Math.round(b * k), 255];
    const y = top + (high - note.pitch) * row;
    const x0 = x(note.start), x1 = Math.max(x0 + 2, x(note.end));
    if (note.drum) { canvas.rect(x0, y - 1, 3, row + 2, colour); continue; }
    canvas.rect(x0, y, x1 - x0, Math.max(1, row - 1), colour);
    canvas.rect(x0, y, 1, Math.max(1, row - 1), [255, 255, 255, 200]);
  }
  canvas.frame(left - 1, top - 1, plot + 2, rows * row + 2, DIM);
  let lx = left;
  (options.lanes ?? []).forEach((name, i) => {
    canvas.rect(lx, canvas.height - 8, 6, 6, TRACK_COLOURS[i % TRACK_COLOURS.length]!);
    canvas.text(lx + 8, canvas.height - 8, name.slice(0, 24), INK);
    lx += Canvas.measure(name.slice(0, 24)) + 16;
  });
  return canvas;
}

/** Peak envelope per column; samples at the edge of full scale are marked red. */
export function waveform(samples: Float32Array, rate: number, options: { width?: number; height?: number; label?: string } = {}): Canvas {
  const width = options.width ?? 960, height = options.height ?? 96, left = 28, top = options.label ? 12 : 4;
  const plot = width - left - 4;
  const canvas = new Canvas(width, top + height + 12);
  if (options.label) canvas.text(left, 3, options.label);
  const middle = top + height / 2;
  canvas.rect(left, Math.round(middle), plot, 1, [60, 60, 76, 255]);
  canvas.text(1, top, '+1', DIM); canvas.text(1, top + height - 5, '-1', DIM);
  const per = samples.length / plot;
  for (let column = 0; column < plot; column++) {
    let lo = 0, hi = 0, hot = false;
    for (let i = Math.floor(column * per); i < Math.min(samples.length, Math.floor((column + 1) * per)); i++) {
      const v = samples[i]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      if (Math.abs(v) > 0.95) hot = true;
    }
    const y0 = Math.round(middle - hi * (height / 2)), y1 = Math.round(middle - lo * (height / 2));
    canvas.rect(left + column, y0, 1, Math.max(1, y1 - y0), hot ? [255, 80, 80, 255] : [41, 173, 255, 255]);
  }
  const duration = samples.length / rate;
  const tick = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60].find(s => duration / s <= 12) ?? 60;
  for (let t = 0; t <= duration + 1e-9; t += tick) {
    const x = left + Math.round((t / Math.max(duration, 1e-3)) * plot);
    canvas.rect(x, top + height, 1, 3, DIM);
    canvas.text(x + 2, top + height + 4, `${Number(t.toFixed(2))}S`, DIM);
  }
  canvas.frame(left - 1, top - 1, plot + 2, height + 2, DIM);
  return canvas;
}

/** In-place radix-2 FFT over `re`/`im` (length a power of two). */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) for (let k = 0; k < size / 2; k++) {
      const wr = Math.cos(step * k), wi = Math.sin(step * k);
      const a = start + k, b = a + size / 2;
      const tr = re[b]! * wr - im[b]! * wi, ti = re[b]! * wi + im[b]! * wr;
      re[b] = re[a]! - tr; im[b] = im[a]! - ti;
      re[a] = re[a]! + tr; im[a] = im[a]! + ti;
    }
  }
}

const heat = (v: number): Rgba => {
  const t = Math.max(0, Math.min(1, v));
  return [Math.round(255 * Math.min(1, t * 2)), Math.round(255 * Math.max(0, t * 2 - 0.6)), Math.round(255 * Math.max(0, 0.5 - Math.abs(t - 0.25)) * 1.4), 255];
};

/** Log-magnitude spectrogram over 0 to `maxHz` (8 kHz by default: the chip's useful range). */
export function spectrogram(samples: Float32Array, rate: number, options: { width?: number; height?: number; maxHz?: number; label?: string } = {}): Canvas {
  const width = options.width ?? 960, height = options.height ?? 128, left = 28, top = options.label ? 12 : 4;
  const plot = width - left - 4, size = 1024, maxHz = Math.min(options.maxHz ?? 8000, rate / 2);
  const canvas = new Canvas(width, top + height + 4);
  if (options.label) canvas.text(left, 3, options.label);
  const window = Float32Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  const bins = Math.floor((maxHz / (rate / 2)) * (size / 2));
  const columns: Float32Array[] = [];
  let loudest = 1e-9;
  for (let column = 0; column < plot; column++) {
    const centre = Math.floor(((column + 0.5) / plot) * samples.length);
    const re = new Float32Array(size), im = new Float32Array(size);
    for (let i = 0; i < size; i++) re[i] = (samples[centre - size / 2 + i] ?? 0) * window[i]!;
    fft(re, im);
    const magnitude = new Float32Array(bins);
    for (let b = 0; b < bins; b++) { magnitude[b] = Math.hypot(re[b]!, im[b]!); if (magnitude[b]! > loudest) loudest = magnitude[b]!; }
    columns.push(magnitude);
  }
  columns.forEach((magnitude, column) => {
    for (let y = 0; y < height; y++) {
      const from = Math.floor(((height - 1 - y) / height) * bins), to = Math.max(from + 1, Math.floor(((height - y) / height) * bins));
      let peak = 0;
      for (let b = from; b < to; b++) peak = Math.max(peak, magnitude[b] ?? 0);
      const db = 20 * Math.log10(peak / loudest + 1e-9);
      canvas.set(left + column, top + y, heat((db + 72) / 72));
    }
  });
  for (let hz = 0; hz <= maxHz; hz += maxHz > 4000 ? 2000 : 1000) {
    const y = top + height - Math.round((hz / maxHz) * height);
    canvas.text(1, Math.min(top + height - 5, Math.max(top, y - 2)), `${hz / 1000}K`, DIM);
  }
  canvas.frame(left - 1, top - 1, plot + 2, height + 2, DIM);
  return canvas;
}
