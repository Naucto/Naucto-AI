import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { generate, type Providers } from '../src/generation.js';
import { startStub } from '../scripts/stub-endpoint.js';

const palette = ['#000000', '#ffffff', '#ff0000', ...new Array(13).fill('#00ff00')];

/** The service only speaks HTTPS to providers; the stub is plain HTTP, so fetch is redirected. */
async function withStub(run: (base: string) => Promise<void>, options: { linked?: boolean; status?: number } = {}): Promise<void> {
  const server = startStub(0, options);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: URL | string, init?: RequestInit) => realFetch(String(input).replace(`https://127.0.0.1:${port}`, `http://127.0.0.1:${port}`), init)) as typeof fetch;
  try { await run(`https://127.0.0.1:${port}`); } finally { globalThis.fetch = realFetch; server.close(); }
}

const providers = (url: string): Providers => ({ pixellabToken: 'pl', pixellabUrl: url, pixellabMinSize: 32 });
const sprite = { kind: 'sprite' as const, prompt: 'x', width: 8, height: 8, palette };

test('PixelLab sprites are decoded and quantized onto the game palette', async () => {
  await withStub(async url => {
    const { result, model } = await generate(sprite, AbortSignal.timeout(5000), providers(url));
    const pixels = (result as { pixels: number[] }).pixels;
    assert.equal(model, 'pixellab:create-image-pixflux');
    assert.equal(pixels[0], 0, 'white background becomes transparent');
    assert.equal(pixels[3 * 8 + 3], 2, 'the red square maps to the red palette entry');
  });
});

test('an image PixelLab links to is downloaded from its own host only', async () => {
  await withStub(async url => {
    const { result } = await generate(sprite, AbortSignal.timeout(5000), providers(url));
    assert.equal((result as { pixels: number[] }).pixels.length, 64);
  }, { linked: true });
});

test('provider errors do not echo the response, and plain HTTP is refused', async () => {
  await withStub(async url => {
    await assert.rejects(generate(sprite, AbortSignal.timeout(5000), providers(url)), (error: Error) => {
      assert.ok(!error.message.includes('pl_token'));
      assert.match(error.message, /HTTP 402/);
      return true;
    });
  }, { status: 402 });
  await assert.rejects(generate(sprite, AbortSignal.timeout(5000), providers('http://127.0.0.1:1')), /HTTPS/);
  await assert.rejects(generate(sprite, AbortSignal.timeout(5000), { pixellabUrl: 'https://x', pixellabMinSize: 32 }), /not configured/);
});
