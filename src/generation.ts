import { z } from 'zod';
import { convertMidi, readMidi } from './midi.js';
import { decodePng, quantize } from './png.js';

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
export type Kind = Generation['kind'];

/**
 * Where each asset kind is generated.
 *
 * - `space`: Naucto's own ZeroGPU Space (providers/space). Free to host; GPU time comes out of the
 *   daily ZeroGPU quota of the account owning HF_TOKEN, then $1 per 10 GPU-minutes of credits.
 * - `pixellab`: PixelLab's pixel-art API, sprites only, billed by their plan.
 * - `endpoint`: any HTTPS service speaking the provider contract (e.g. a paid Inference Endpoint).
 */
export type ProviderKind = 'space' | 'pixellab' | 'endpoint';
export interface Providers {
  hfToken?: string;
  spaceUrl?: string;
  pixellabToken?: string;
  pixellabUrl: string;
  pixellabMinSize: number;
  kinds: Partial<Record<Kind, { provider: ProviderKind; endpoint?: string; model?: string }>>;
}

export function providersFromEnv(env: NodeJS.ProcessEnv): Providers {
  const kinds: Providers['kinds'] = {};
  for (const kind of ['sprite', 'midi', 'sample'] as const) {
    const provider = env[`NAUCTO_${kind.toUpperCase()}_PROVIDER`];
    if (provider === 'space' || provider === 'pixellab' || provider === 'endpoint') {
      kinds[kind] = { provider, endpoint: env[`HF_${kind.toUpperCase()}_ENDPOINT`], model: env[`HF_${kind.toUpperCase()}_MODEL`] };
    }
  }
  return {
    hfToken: env.HF_TOKEN, spaceUrl: env.NAUCTO_SPACE_URL, pixellabToken: env.PIXELLAB_TOKEN,
    pixellabUrl: env.PIXELLAB_API_URL ?? 'https://api.pixellab.ai/v2', pixellabMinSize: Number(env.PIXELLAB_MIN_SIZE ?? 32), kinds,
  };
}

export function configured(providers: Providers, kind: Kind): boolean {
  const choice = providers.kinds[kind];
  if (!choice) return false;
  switch (choice.provider) {
    case 'space': return !!providers.hfToken && !!providers.spaceUrl;
    case 'pixellab': return kind === 'sprite' && !!providers.pixellabToken;
    case 'endpoint': return !!providers.hfToken && !!choice.endpoint && !!choice.model;
  }
}

const MAX_BYTES = 2 * 1024 * 1024;

function httpsUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Providers must use HTTPS without URL credentials');
  return url;
}

async function readBounded(response: Response): Promise<Buffer> {
  if (!response.body) throw new Error('Empty provider response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.length;
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Provider response exceeds 2 MiB'); }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks);
}

async function postJson(url: URL, token: string, body: unknown, signal: AbortSignal): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal, redirect: 'error',
  });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
  return response;
}

/** The contract parameters sent to a `space` or `endpoint` provider. */
function parameters(input: Generation): Record<string, unknown> {
  return input.kind === 'sprite'
    ? { width: input.width, height: input.height, palette: input.palette }
    : input.kind === 'midi' ? { max_beats: 256 } : { seconds: input.seconds, sample_rate: 8000 };
}

/**
 * One call to a Gradio app (the Naucto Space). Gradio answers with an event id, then streams the
 * result as server-sent events on a second request; `event: complete` carries `[result]`.
 */
export async function callSpace(spaceUrl: string, token: string, route: string, data: unknown[], signal: AbortSignal): Promise<unknown> {
  const base = httpsUrl(spaceUrl);
  const root = base.href.endsWith('/') ? base.href : `${base.href}/`;
  const started = await postJson(new URL(`gradio_api/call/${route}`, root), token, { data }, signal);
  const { event_id: eventId } = z.object({ event_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).parse(JSON.parse((await readBounded(started)).toString('utf8')));
  const stream = await fetch(new URL(`gradio_api/call/${route}/${eventId}`, root), {
    headers: { authorization: `Bearer ${token}` }, signal, redirect: 'error',
  });
  if (!stream.ok) throw new Error(`Space returned HTTP ${stream.status}`);
  let event = '';
  for (const line of (await readBounded(stream)).toString('utf8').split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:') && event === 'complete') {
      const result = JSON.parse(line.slice(5)) as unknown;
      if (!Array.isArray(result) || result.length !== 1) throw new Error('Unexpected Space result');
      return result[0];
    } else if (line.startsWith('data:') && event === 'error') {
      // Gradio's error text can include model internals; the ledger keeps a fixed message only.
      throw new Error('The Space reported an error (quota exhausted, queue full or generation failed)');
    }
  }
  throw new Error('The Space closed the stream without a result');
}

/** PixelLab's documented responses carry the PNG inline or as a URL on their own domain. */
async function pixellabSprite(input: Extract<Generation, { kind: 'sprite' }>, providers: Providers, signal: AbortSignal): Promise<number[]> {
  const size = (n: number): number => Math.max(n, providers.pixellabMinSize);
  const base = httpsUrl(providers.pixellabUrl);
  const response = await postJson(new URL(`${base.pathname.replace(/\/$/, '')}/create-image-pixflux`, base), providers.pixellabToken!, {
    description: input.prompt, image_size: { width: size(input.width), height: size(input.height) }, no_background: true,
  }, signal);
  const body = z.object({
    image: z.object({ base64: z.string() }).optional(),
    image_url: z.string().optional(),
  }).passthrough().parse(JSON.parse((await readBounded(response)).toString('utf8')));
  let png: Buffer;
  if (body.image?.base64) {
    png = Buffer.from(body.image.base64.replace(/^data:image\/png;base64,/, ''), 'base64');
  } else if (body.image_url) {
    const url = httpsUrl(body.image_url);
    // Only follow links to PixelLab itself: a response must not steer this service elsewhere.
    if (url.hostname !== 'pixellab.ai' && !url.hostname.endsWith('.pixellab.ai') && url.hostname !== base.hostname) throw new Error('Unexpected image host');
    const image = await fetch(url, { signal, redirect: 'error' });
    if (!image.ok) throw new Error(`Image download returned HTTP ${image.status}`);
    png = await readBounded(image);
  } else throw new Error('PixelLab returned no image');
  return quantize(decodePng(png), input.width, input.height, input.palette);
}

const withModel = z.object({ model: z.string().min(1).max(200) }).passthrough();

/** The raw contract answer of a `space` or `endpoint` provider, and the model that produced it. */
async function contractCall(input: Generation, providers: Providers, signal: AbortSignal): Promise<{ body: unknown; model: string }> {
  const choice = providers.kinds[input.kind]!;
  if (choice.provider === 'space') {
    const body = withModel.parse(await callSpace(providers.spaceUrl!, providers.hfToken!, input.kind, [input.prompt, JSON.stringify(parameters(input))], signal));
    return { body, model: `space:${body.model}` };
  }
  const response = await postJson(httpsUrl(choice.endpoint!), providers.hfToken!, { inputs: input.prompt, parameters: parameters(input) }, signal);
  return { body: JSON.parse((await readBounded(response)).toString('utf8')), model: choice.model! };
}

const pixelsSchema = z.object({ width: z.number().int(), height: z.number().int(), pixels: z.array(z.number().int().min(0).max(15)).max(4096) });

/**
 * One generation. Only the prompt and the asset's constraints leave the service; Naucto
 * credentials never do, and every result is validated into Naucto's own formats.
 */
export async function generate(input: Generation, signal: AbortSignal, providers: Providers): Promise<{ result: unknown; model: string }> {
  if (!configured(providers, input.kind)) throw new Error('This generation provider is not configured');
  if (input.kind === 'sprite' && providers.kinds.sprite!.provider === 'pixellab') {
    const pixels = await pixellabSprite(input, providers, signal);
    return { model: 'pixellab:create-image-pixflux', result: { width: input.width, height: input.height, pixels, palette: input.palette, notice: 'Draft: insert it with a pixels proposal after inspecting it.' } };
  }
  const { body, model } = await contractCall(input, providers, signal);
  if (input.kind === 'sprite') {
    const image = pixelsSchema.parse(body);
    if (image.width !== input.width || image.height !== input.height || image.pixels.length !== input.width * input.height) {
      throw new Error('Provider returned incompatible sprite dimensions');
    }
    return { model, result: { width: image.width, height: image.height, pixels: image.pixels, palette: input.palette, notice: 'Draft: insert it with a pixels proposal after inspecting it.' } };
  }
  if (input.kind === 'midi') {
    const midi = z.object({ midiBase64: z.string().max(349528).regex(/^[A-Za-z0-9+/]+={0,2}$/) }).passthrough().parse(body);
    const conversion = convertMidi(readMidi(Buffer.from(midi.midiBase64, 'base64')), { prefix: input.prefix, voices: input.voices });
    return { model, result: { ...conversion, sourceMidiBase64: midi.midiBase64, notice: 'Draft: remap slots, then submit a MUSIC sound proposal.' } };
  }
  const sample = z.object({ pcm8Base64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/), sampleRate: z.literal(8000) }).passthrough().parse(body);
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
