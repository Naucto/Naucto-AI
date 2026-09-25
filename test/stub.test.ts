import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generate, type Providers } from '../src/generation.js';
import { startStub } from '../scripts/stub-endpoint.js';

test('every provider contract converts into Naucto formats end to end', async () => {
  const server = startStub();
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const providers: Providers = { token: 't', sprite: { endpoint: `${base}/sprite`, model: 'stub' }, midi: { endpoint: `${base}/midi`, model: 'stub' }, sample: { endpoint: `${base}/sample`, model: 'stub' } };
  try {
    // The service refuses plain HTTP; the stub proves the contract, so the check is lifted here only.
    await assert.rejects(generate({ kind: 'midi', prompt: 'x', prefix: 'p', voices: 4 }, AbortSignal.timeout(5000), providers), /HTTPS/);
    const secure = (kind: string) => ({ endpoint: `${base}/${kind}`.replace('http://', 'https://'), model: 'stub' });
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: URL | string, init?: RequestInit) => realFetch(String(input).replace('https://', 'http://'), init)) as typeof fetch;
    try {
      const all: Providers = { token: 't', sprite: secure('sprite'), midi: secure('midi'), sample: secure('sample') };
      const sprite = await generate({ kind: 'sprite', prompt: 'x', width: 16, height: 16, palette: new Array(16).fill('#000000') }, AbortSignal.timeout(5000), all);
      assert.equal((sprite.result as { pixels: number[] }).pixels.length, 256);
      const midi = await generate({ kind: 'midi', prompt: 'x', prefix: 'p', voices: 4 }, AbortSignal.timeout(5000), all);
      assert.equal((midi.result as { report: { importedNotes: number } }).report.importedNotes, 2);
      const sample = await generate({ kind: 'sample', prompt: 'x', seconds: 0.1 }, AbortSignal.timeout(5000), all);
      assert.equal((sample.result as { bytes: number }).bytes, 800);
      assert.equal(sample.model, 'stub');
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    server.close();
  }
});
