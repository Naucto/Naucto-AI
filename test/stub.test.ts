import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { generate, type Providers } from '../src/generation.js';
import { startStub } from '../scripts/stub-endpoint.js';

const palette = ['#000000', '#ffffff', '#ff0000', ...new Array(13).fill('#00ff00')];

/** The service only speaks HTTPS to providers; the stub is plain HTTP, so fetch is redirected. */
async function withStub(run: (base: string) => Promise<void>, options: { spaceError?: boolean } = {}): Promise<void> {
  const server = startStub(0, options);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: URL | string, init?: RequestInit) => realFetch(String(input).replace(`https://127.0.0.1:${port}`, `http://127.0.0.1:${port}`), init)) as typeof fetch;
  try { await run(`https://127.0.0.1:${port}`); } finally { globalThis.fetch = realFetch; server.close(); }
}

const base = (overrides: Partial<Providers>): Providers => ({ hfToken: 'hf_x', pixellabUrl: '', pixellabMinSize: 32, kinds: {}, ...overrides });

test('the ZeroGPU Space answers every kind through the Gradio call protocol', async () => {
  await withStub(async url => {
    const providers = base({ spaceUrl: url, kinds: { sprite: { provider: 'space' }, midi: { provider: 'space' }, sample: { provider: 'space' } } });
    const sprite = await generate({ kind: 'sprite', prompt: 'x', width: 16, height: 16, palette }, AbortSignal.timeout(5000), providers);
    assert.equal((sprite.result as { pixels: number[] }).pixels.length, 256);
    assert.equal(sprite.model, 'space:stub/sprite@test');
    const midi = await generate({ kind: 'midi', prompt: 'x', prefix: 'p', voices: 4 }, AbortSignal.timeout(5000), providers);
    assert.equal((midi.result as { report: { importedNotes: number } }).report.importedNotes, 2);
    const sample = await generate({ kind: 'sample', prompt: 'x', seconds: 0.1 }, AbortSignal.timeout(5000), providers);
    assert.equal((sample.result as { bytes: number }).bytes, 800);
  });
});

test('a Space error surfaces as a fixed message, never the provider text', async () => {
  await withStub(async url => {
    const providers = base({ spaceUrl: url, kinds: { midi: { provider: 'space' } } });
    await assert.rejects(generate({ kind: 'midi', prompt: 'x', prefix: 'p', voices: 4 }, AbortSignal.timeout(5000), providers), (error: Error) => {
      assert.ok(!error.message.includes('hf_secret_token'));
      assert.match(error.message, /quota/);
      return true;
    });
  }, { spaceError: true });
});

test('PixelLab sprites are decoded and quantized onto the game palette', async () => {
  await withStub(async url => {
    const providers = base({ pixellabToken: 'pl', pixellabUrl: url, kinds: { sprite: { provider: 'pixellab' } } });
    const { result, model } = await generate({ kind: 'sprite', prompt: 'x', width: 8, height: 8, palette }, AbortSignal.timeout(5000), providers);
    const pixels = (result as { pixels: number[] }).pixels;
    assert.equal(model, 'pixellab:create-image-pixflux');
    assert.equal(pixels[0], 0, 'white background becomes transparent');
    assert.equal(pixels[3 * 8 + 3], 2, 'the red square maps to the red palette entry');
  });
});

test('a paid endpoint still works through the same contract, and plain HTTP is refused', async () => {
  await withStub(async url => {
    const providers = base({ kinds: { midi: { provider: 'endpoint', endpoint: `${url}/midi`, model: 'org/model@rev' } } });
    assert.equal((await generate({ kind: 'midi', prompt: 'x', prefix: 'p', voices: 4 }, AbortSignal.timeout(5000), providers)).model, 'org/model@rev');
  });
  const insecure = base({ kinds: { midi: { provider: 'endpoint', endpoint: 'http://127.0.0.1:1/midi', model: 'm' } } });
  await assert.rejects(generate({ kind: 'midi', prompt: 'x', prefix: 'p', voices: 4 }, AbortSignal.timeout(5000), insecure), /HTTPS/);
});
