import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng } from '../src/png.js';
import { Canvas, gridPicture, pianoRoll, sideBySide, spectrogram, tiled, waveform } from '../src/render.js';

const palette = ['#000000', '#ff0000', ...new Array(14).fill('#00ff00')];

test('pictures are real PNGs that decode to what was drawn', () => {
  const canvas = new Canvas(3, 2, [0, 0, 0, 255]);
  canvas.set(1, 0, [255, 0, 0, 255]);
  canvas.set(2, 1, [0, 0, 255, 128]);
  const image = decodePng(canvas.png());
  assert.equal(image.width, 3);
  assert.equal(image.height, 2);
  assert.deepEqual([...image.data.subarray(4, 8)], [255, 0, 0, 255]);
  assert.deepEqual([...image.data.subarray(20, 24)], [0, 0, 128, 255], 'half-transparent ink blends');
});

test('a sprite is enlarged with its transparency shown as a checkerboard', () => {
  const picture = gridPicture({ width: 2, height: 1, pixels: [0, 1] }, palette, { scale: 8, cell: 0 });
  const image = decodePng(picture.png());
  const pixel = (x: number, y: number) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 3)];
  // Find the red cell: the second pixel of the sprite, 8×8 on screen.
  let red = 0, grey = 0;
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const [r, g, b] = pixel(x, y);
    if (r === 255 && g === 0 && b === 0) red++;
    if ((r === 64 && b === 76) || (r === 84 && b === 98)) grey++;
  }
  assert.equal(red, 64);
  assert.equal(grey, 64, 'the transparent pixel is checkerboard, not black');
});

test('tiling repeats a sprite so seams can be judged', () => {
  const grid = tiled({ width: 2, height: 1, pixels: [1, 2] }, 3);
  assert.equal(grid.width, 6);
  assert.equal(grid.height, 3);
  assert.deepEqual(grid.pixels.slice(0, 6), [1, 2, 1, 2, 1, 2]);
});

test('sound pictures stay a readable size whatever the length', () => {
  const tone = Float32Array.from({ length: 48000 }, (_, i) => Math.sin(i / 10) * 0.5);
  for (const canvas of [
    pianoRoll([{ start: 0, end: 0.5, pitch: 60, volume: 1, lane: 0 }, { start: 0.5, end: 1, pitch: 90, volume: 0.5, lane: 1 }], 1, { lanes: ['lead', 'bass'] }),
    waveform(tone, 48000),
    spectrogram(tone, 48000),
    sideBySide([{ label: 'a', canvas: new Canvas(10, 10) }, { label: 'b', canvas: new Canvas(20, 5) }]),
  ]) {
    assert.ok(canvas.width <= 2048 && canvas.height <= 2048);
    assert.ok(decodePng(canvas.png()).width === canvas.width);
  }
});
