import { z } from 'zod';
import { convertMidi, readMidi } from './midi.js';

export const generationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('sprite'), prompt: z.string().min(1).max(2000),
    width: z.number().int().min(8).max(64), height: z.number().int().min(8).max(64),
    palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).length(16),
  }).strict(),
  z.object({
    kind: z.literal('midi'), prompt: z.string().min(1).max(2000),
    prefix: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), voices: z.number().int().min(1).max(5).default(4),
  }).strict(),
  z.object({ kind: z.literal('sample'), prompt: z.string().min(1).max(2000), seconds: z.number().min(0.05).max(1) }).strict(),
]);
export type Generation = z.infer<typeof generationSchema>;

export interface Provider { endpoint?: string; model?: string }
export interface Providers { token?: string; sprite: Provider; midi: Provider; sample: Provider }

export function providersFromEnv(env: NodeJS.ProcessEnv): Providers {
  return {
    token: env.HF_TOKEN,
    sprite: { endpoint: env.HF_SPRITE_ENDPOINT, model: env.HF_SPRITE_MODEL },
    midi: { endpoint: env.HF_MIDI_ENDPOINT, model: env.HF_MIDI_MODEL },
    sample: { endpoint: env.HF_SAMPLE_ENDPOINT, model: env.HF_SAMPLE_MODEL },
  };
}

export function configured(providers: Providers, kind: Generation['kind']): boolean {
  return !!providers.token && !!providers[kind].endpoint && !!providers[kind].model;
}

const pixels = z.object({ width: z.number().int(), height: z.number().int(), pixels: z.array(z.number().int().min(0).max(15)).max(4096) });

async function readBounded(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Empty generation response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Generation response exceeds 2 MiB'); }
    chunks.push(item.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * One call to a team-configured endpoint. Only the prompt and the asset's constraints leave the
 * service; Naucto credentials never do, and the result is validated into Naucto's own formats.
 */
export async function generate(input: Generation, signal: AbortSignal, providers: Providers): Promise<{ result: unknown; model: string }> {
  const provider = providers[input.kind];
  if (!configured(providers, input.kind)) throw new Error('This generation provider is not configured');
  const url = new URL(provider.endpoint!);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Generation endpoints must use HTTPS without URL credentials');
  const parameters = input.kind === 'sprite'
    ? { width: input.width, height: input.height, palette: input.palette }
    : input.kind === 'midi' ? { max_beats: 256 } : { seconds: input.seconds, sample_rate: 8000 };
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${providers.token!}`, 'content-type': 'application/json' },
    body: JSON.stringify({ inputs: input.prompt, parameters }),
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`Generation endpoint returned HTTP ${response.status}`);
  const body = await readBounded(response);
  const model = provider.model!;
  if (input.kind === 'sprite') {
    const image = pixels.parse(body);
    if (image.width !== input.width || image.height !== input.height || image.pixels.length !== input.width * input.height) {
      throw new Error('Provider returned incompatible sprite dimensions');
    }
    return { model, result: { ...image, palette: input.palette, notice: 'Draft: insert it with a pixels proposal after inspecting it.' } };
  }
  if (input.kind === 'midi') {
    const midi = z.object({ midiBase64: z.string().max(349528).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).parse(body);
    const conversion = convertMidi(readMidi(Buffer.from(midi.midiBase64, 'base64')), { prefix: input.prefix, voices: input.voices });
    return { model, result: { ...conversion, sourceMidiBase64: midi.midiBase64, notice: 'Draft: remap slots, then submit a MUSIC sound proposal.' } };
  }
  const sample = z.object({ pcm8Base64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/), sampleRate: z.literal(8000) }).parse(body);
  const bytes = Buffer.from(sample.pcm8Base64, 'base64');
  if (!bytes.length || bytes.length > 8192) throw new Error('Samples must be 1–8192 bytes of signed 8-bit mono at 8 kHz');
  return { model, result: { data: sample.pcm8Base64, bytes: bytes.length, notice: 'Draft: include it in an SFX sound proposal under `samples` with a sample instrument.' } };
}

/** What the queue needs from the backend, all through the project token of whoever started it. */
export interface Ledger {
  create(kind: string, request: unknown): Promise<{ id: string }>;
  claim(id: string): Promise<boolean>;
  cancelled(id: string): Promise<boolean>;
  complete(id: string, result: unknown, model: string): Promise<void>;
  fail(id: string, error: string): Promise<void>;
}

/**
 * Runs jobs whose state lives in the backend. A job lost with this process is expired by the
 * backend rather than resubmitted, so a restart never pays for the same generation twice.
 */
export class GenerationQueue {
  private readonly pending: { id: string; input: Generation; ledger: Ledger }[] = [];
  private running = 0;

  constructor(
    private readonly worker: (input: Generation, signal: AbortSignal) => Promise<{ result: unknown; model: string }>,
    private readonly concurrency = 2,
    private readonly timeoutMs = 300000,
    private readonly pollMs = 3000,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid generation concurrency');
  }

  async submit(input: Generation, ledger: Ledger): Promise<{ id: string }> {
    if (this.pending.length >= 100) throw new Error('Generation queue is full');
    const job = await ledger.create(input.kind, input);
    this.pending.push({ id: job.id, input, ledger });
    this.pump();
    return job;
  }

  /** Resolves when nothing is queued or running; for tests and graceful shutdown. */
  async idle(): Promise<void> {
    while (this.running || this.pending.length) await new Promise(resolve => setTimeout(resolve, 5));
  }

  private pump(): void {
    while (this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      this.running++;
      void this.run(job).finally(() => { this.running--; this.pump(); });
    }
  }

  private async run({ id, input, ledger }: { id: string; input: Generation; ledger: Ledger }): Promise<void> {
    if (!(await ledger.claim(id).catch(() => false))) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const watch = setInterval(() => {
      void ledger.cancelled(id).then(cancelled => { if (cancelled) controller.abort(); }).catch(() => undefined);
    }, this.pollMs);
    try {
      const { result, model } = await this.worker(input, controller.signal);
      // The backend discards the result itself if the job was cancelled meanwhile.
      await ledger.complete(id, result, model);
    } catch {
      // Provider errors can echo prompts or credentials: record a fixed message only.
      await ledger.fail(id, controller.signal.aborted ? 'Cancelled or timed out; no automatic paid retry was made' : 'Generation failed; no automatic paid retry was made').catch(() => undefined);
    } finally {
      clearTimeout(timer);
      clearInterval(watch);
    }
  }
}
