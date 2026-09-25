import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePng, quantize } from '../src/png.js';
import { stubPng } from '../scripts/stub-endpoint.js';

test('decodes an RGBA PNG and quantizes it like the Space does', () => {
  const image = decodePng(stubPng(32));
  assert.equal(image.width, 32);
  assert.deepEqual([...image.data.subarray(0, 4)], [255, 255, 255, 255]);
  const palette = ['#000000', '#ffffff', '#ff0000', ...new Array(13).fill('#0000ff')];
  const pixels = quantize(image, 8, 8, palette);
  assert.equal(pixels.filter(p => p === 2).length, 16, 'the centre 4×4 is red');
  assert.equal(pixels.filter(p => p === 0).length, 48, 'the background is transparent, not white');
});

test('refuses what is not a supported PNG', () => {
  assert.throws(() => decodePng(Buffer.from('GIF89a')), /Not a PNG/);
  const png = stubPng(8);
  png[24] = 16; // bit depth
  assert.throws(() => decodePng(png), /8-bit/);
});
