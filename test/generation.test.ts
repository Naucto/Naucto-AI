import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configured, GenerationQueue, type Generation, type Ledger, providersFromEnv } from '../src/generation.js';

const request: Generation = { kind: 'midi', prompt: 'a short loop', prefix: 'test', voices: 4 };

function fakeLedger(overrides: Partial<Ledger> = {}) {
  const log: string[] = [];
  let cancelled = false;
  const ledger: Ledger = {
    create: async () => { log.push('create'); return { id: 'job' }; },
    claim: async () => { log.push('claim'); return true; },
    cancelled: async () => cancelled,
    complete: async (_id, _result, model) => { log.push(`complete:${model}`); },
    fail: async (_id, error) => { log.push(`fail:${error}`); },
    ...overrides,
  };
  return { ledger, log, cancel: () => { cancelled = true; } };
}

test('a completed job reports the model that produced it', async () => {
  const queue = new GenerationQueue(async () => ({ result: { ok: true }, model: 'org/model@rev' }));
  const { ledger, log } = fakeLedger();
  await queue.submit(request, ledger);
  await queue.idle();
  assert.deepEqual(log, ['create', 'claim', 'complete:org/model@rev']);
});

test('a job cancelled before dispatch never reaches the provider', async () => {
  let calls = 0;
  const queue = new GenerationQueue(async () => { calls++; return { result: {}, model: 'm' }; });
  const { ledger } = fakeLedger({ claim: async () => false });
  await queue.submit(request, ledger);
  await queue.idle();
  assert.equal(calls, 0);
});

test('cancelling a running job aborts it and records no result', async () => {
  const queue = new GenerationQueue((_input, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }), 1, 60000, 5);
  const fake = fakeLedger();
  await queue.submit(request, fake.ledger);
  setTimeout(fake.cancel, 20);
  await queue.idle();
  assert.equal(fake.log.at(-1), 'fail:Cancelled or timed out; no automatic paid retry was made');
});

test('provider errors are never copied into the ledger', async () => {
  const queue = new GenerationQueue(async () => { throw new Error('secret token hf_abc in body'); });
  const { ledger, log } = fakeLedger();
  await queue.submit(request, ledger);
  await queue.idle();
  assert.ok(!log.join().includes('hf_abc'));
});

test('a generator is enabled only when its provider has what it needs', () => {
  assert.equal(configured(providersFromEnv({ HF_TOKEN: 't', NAUCTO_SPACE_URL: 'https://s' }), 'midi'), false, 'no provider chosen');
  assert.equal(configured(providersFromEnv({ NAUCTO_MIDI_PROVIDER: 'space', NAUCTO_SPACE_URL: 'https://s' }), 'midi'), false, 'no token');
  assert.equal(configured(providersFromEnv({ NAUCTO_MIDI_PROVIDER: 'space', HF_TOKEN: 't', NAUCTO_SPACE_URL: 'https://s' }), 'midi'), true);
  assert.equal(configured(providersFromEnv({ NAUCTO_MIDI_PROVIDER: 'pixellab', PIXELLAB_TOKEN: 'p' }), 'midi'), false, 'PixelLab draws sprites only');
  assert.equal(configured(providersFromEnv({ NAUCTO_SPRITE_PROVIDER: 'pixellab', PIXELLAB_TOKEN: 'p' }), 'sprite'), true);
  assert.equal(configured(providersFromEnv({ NAUCTO_MIDI_PROVIDER: 'endpoint', HF_TOKEN: 't', HF_MIDI_ENDPOINT: 'https://x' }), 'midi'), false, 'endpoint needs a model id');
});
