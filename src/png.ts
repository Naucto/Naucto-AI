import { inflateSync } from 'node:zlib';

/** RGBA pixels of a PNG, row-major. Supports 8-bit greyscale, RGB, palette and alpha variants. */
export interface Rgba { width: number; height: number; data: Uint8Array }

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const MAX_SIDE = 1024;

export function decodePng(bytes: Uint8Array): Rgba {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('Not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0, depth = 0, colour = 0, interlace = 0;
  let palette: Uint8Array | null = null, alphas: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) throw new Error('Truncated PNG');
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12);
      depth = data[8]!; colour = data[9]!; interlace = data[12]!;
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') alphas = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) throw new Error('PNG size unsupported');
  if (depth !== 8 || interlace !== 0 || ![0, 2, 3, 4, 6].includes(colour)) throw new Error('Only 8-bit non-interlaced PNGs are supported');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[colour]!;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (width * channels + 1) * height });
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error('Corrupt PNG data');
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? rows[y * stride + x - channels]! : 0;
      const b = y > 0 ? rows[(y - 1) * stride + x]! : 0;
      const c = x >= channels && y > 0 ? rows[(y - 1) * stride + x - channels]! : 0;
      let value = src[x]!;
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('Unknown PNG filter');
      rows[y * stride + x] = value & 255;
    }
  }
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    let r: number, g: number, b: number, alpha = 255;
    if (colour === 3) {
      const index = rows[s]!;
      if (!palette || index * 3 + 2 >= palette.length) throw new Error('PNG palette index out of range');
      r = palette[index * 3]!; g = palette[index * 3 + 1]!; b = palette[index * 3 + 2]!;
      alpha = alphas && index < alphas.length ? alphas[index]! : 255;
    } else if (colour === 0 || colour === 4) {
      r = g = b = rows[s]!;
      if (colour === 4) alpha = rows[s + 1]!;
    } else {
      r = rows[s]!; g = rows[s + 1]!; b = rows[s + 2]!;
      if (colour === 6) alpha = rows[s + 3]!;
    }
    out.set([r, g, b, alpha], i * 4);
  }
  return { width, height, data: out };
}

/**
 * Box-downsample to the sprite's size and map onto the game palette: index 0 is transparent (low alpha, or the corner colour when all four corners
 * agree); opaque pixels take indices 1–15 by perceptually weighted distance.
 */
export function quantize(image: Rgba, width: number, height: number, palette: string[]): number[] {
  if (palette.length !== 16) throw new Error('Naucto palettes have 16 colours');
  const colours = palette.slice(1).map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]);
  const cell = (x: number, y: number): [number, number, number, number] => {
    const x0 = Math.floor((x * image.width) / width), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * image.width) / width));
    const y0 = Math.floor((y * image.height) / height), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * image.height) / height));
    const sum = [0, 0, 0, 0];
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const o = (yy * image.width + xx) * 4;
      for (let k = 0; k < 4; k++) sum[k]! += image.data[o + k]!;
    }
    const n = (x1 - x0) * (y1 - y0);
    return sum.map(v => v / n) as [number, number, number, number];
  };
  const cells = Array.from({ length: width * height }, (_, i) => cell(i % width, Math.floor(i / width)));
  const corners = [cells[0]!, cells[width - 1]!, cells[(height - 1) * width]!, cells[width * height - 1]!];
  const close = (a: number[], b: number[]): boolean => Math.max(...[0, 1, 2].map(k => Math.abs(a[k]! - b[k]!))) < 24;
  const background = corners.every(c => close(c, corners[0]!)) ? corners[0]! : null;
  return cells.map(([r, g, b, alpha]) => {
    if (alpha < 128 || (background && close([r, g, b], background))) return 0;
    let best = 0, bestDistance = Infinity;
    colours.forEach(([pr, pg, pb], i) => {
      const d = 0.3 * (r - pr) ** 2 + 0.59 * (g - pg) ** 2 + 0.11 * (b - pb) ** 2;
      if (d < bestDistance) { bestDistance = d; best = i; }
    });
    return best + 1;
  });
}
