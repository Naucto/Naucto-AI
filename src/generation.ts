import { z } from 'zod';
import { decodePng, quantize } from './png.js';

/**
 * Specialist generation: sprites from PixelLab's pixel-art model, to set beside what the assistant
 * draws itself (`compare_sprites`). Music and sounds have no external model: the assistant composes
 * them with Naucto's own synth (`render_sound`), and people bring recordings through the editor.
 */
export const generationSchema = z.object({
  kind: z.literal('sprite'),
  prompt: z.string().min(1).max(2000),
  width: z.number().int().min(8).max(64),
  height: z.number().int().min(8).max(64),
  palette: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).length(16),
}).strict();
export type Generation = z.infer<typeof generationSchema>;

export interface Providers {
  pixellabToken?: string;
  pixellabUrl: string;
  /** PixelLab draws better at a larger size; the result is downsampled to the sprite's own. */
  pixellabMinSize: number;
}

export function providersFromEnv(env: NodeJS.ProcessEnv): Providers {
  return {
    pixellabToken: env.PIXELLAB_TOKEN || undefined,
    pixellabUrl: env.PIXELLAB_API_URL ?? 'https://api.pixellab.ai/v2',
    pixellabMinSize: Number(env.PIXELLAB_MIN_SIZE ?? 32),
  };
}

export const configured = (providers: Providers): boolean => !!providers.pixellabToken;

const MAX_BYTES = 4 * 1024 * 1024;

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
    if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Provider response too large'); }
    chunks.push(item.value);
  }
  return Buffer.concat(chunks);
}

/**
 * One PixelLab image, decoded and put on the game's palette (index 0 transparent). Only the prompt
 * and size leave the service. The image may come inline or as a link on PixelLab's own domain.
 */
export async function generate(input: Generation, signal: AbortSignal, providers: Providers): Promise<{ result: unknown; model: string }> {
  if (!configured(providers)) throw new Error('PixelLab is not configured');
  const size = (n: number): number => Math.max(n, providers.pixellabMinSize);
  const base = httpsUrl(providers.pixellabUrl);
  const response = await fetch(new URL(`${base.pathname.replace(/\/$/, '')}/create-image-pixflux`, base), {
    method: 'POST',
    headers: { authorization: `Bearer ${providers.pixellabToken!}`, 'content-type': 'application/json' },
    body: JSON.stringify({ description: input.prompt, image_size: { width: size(input.width), height: size(input.height) }, no_background: true }),
    signal,
    redirect: 'error',
  });
  if (!response.ok) throw new Error(`PixelLab returned HTTP ${response.status}`);
  const body = z.object({ image: z.object({ base64: z.string() }).optional(), image_url: z.string().optional() }).passthrough()
    .parse(JSON.parse((await readBounded(response)).toString('utf8')));
  let png: Buffer;
  if (body.image?.base64) png = Buffer.from(body.image.base64.replace(/^data:image\/png;base64,/, ''), 'base64');
  else if (body.image_url) {
    const url = httpsUrl(body.image_url);
    if (url.hostname !== 'pixellab.ai' && !url.hostname.endsWith('.pixellab.ai') && url.hostname !== base.hostname) throw new Error('Unexpected image host');
    const image = await fetch(url, { signal, redirect: 'error' });
    if (!image.ok) throw new Error(`Image download returned HTTP ${image.status}`);
    png = await readBounded(image);
  } else throw new Error('PixelLab returned no image');
  const pixels = quantize(decodePng(png), input.width, input.height, input.palette);
  return {
    model: 'pixellab:create-image-pixflux',
    result: { width: input.width, height: input.height, pixels, palette: input.palette, notice: 'Draft: compare it with compare_sprites, edit it with draw_sprite, then propose it.' },
  };
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
