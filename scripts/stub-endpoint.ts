/**
 * Stand-ins for the providers, for local development and tests: they answer each contract with
 * fixed, valid assets. They are not models and must never be configured in production.
 *
 *   npx tsx scripts/stub-endpoint.ts   # prints its URLs (plain HTTP: tests only)
 */
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

/** The provider-contract answer for one kind, with the `model` a Space reports. */
export function stubResponse(kind: string, parameters: Record<string, unknown> = {}): Record<string, unknown> {
  if (kind === 'sprite') {
    const width = Number(parameters.width ?? 16), height = Number(parameters.height ?? 16);
    return { width, height, pixels: Array.from({ length: width * height }, (_, i) => ((i % width) + Math.floor(i / width)) % 4 === 0 ? 3 : 0), model: 'stub/sprite@test' };
  }
  if (kind === 'midi') {
    const track = [0, 0x90, 60, 100, 96, 0x80, 60, 0, 0, 0x90, 64, 100, 96, 0x80, 64, 0, 0, 255, 47, 0];
    const bytes = Uint8Array.from([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 77, 84, 114, 107, 0, 0, 0, track.length, ...track]);
    return { midiBase64: Buffer.from(bytes).toString('base64'), model: 'stub/midi@test' };
  }
  const pcm = Int8Array.from({ length: 800 }, (_, i) => Math.round(Math.sin(i / 3) * 100 * (1 - i / 800)));
  return { pcm8Base64: Buffer.from(pcm.buffer).toString('base64'), sampleRate: 8000, model: 'stub/sample@test' };
}

/** An RGBA PNG: a red square on a white background, as a pixel-art API would draw one. */
export function stubPng(size = 32): Buffer {
  const crc = (buf: Buffer): number => {
    let c = ~0;
    for (const byte of buf) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length); head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const inside = x >= size / 4 && x < (size * 3) / 4 && y >= size / 4 && y < (size * 3) / 4;
    raw.set(inside ? [250, 20, 20, 255] : [255, 255, 255, 255], y * (size * 4 + 1) + 1 + x * 4);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/**
 * Speaks the Gradio call protocol (`/gradio_api/call/<kind>` then an event stream), the endpoint
 * contract (`/<kind>`), and PixelLab's `create-image-pixflux`.
 */
export function startStub(port = 0, options: { spaceError?: boolean } = {}) {
  const events = new Map<string, Record<string, unknown>>();
  return createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const url = req.url ?? '';
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const json = (value: unknown): void => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
      const call = /^\/gradio_api\/call\/(\w+)$/.exec(url);
      const stream = /^\/gradio_api\/call\/(\w+)\/(\w+)$/.exec(url);
      if (call) {
        const [, parameters] = body.data as [string, string];
        const id = `event${events.size}`;
        events.set(id, stubResponse(call[1]!, JSON.parse(parameters) as Record<string, unknown>));
        json({ event_id: id });
      } else if (stream) {
        res.setHeader('content-type', 'text/event-stream');
        res.write('event: generating\ndata: null\n\n');
        res.end(options.spaceError ? 'event: error\ndata: "ZeroGPU quota exceeded for hf_secret_token"\n\n' : `event: complete\ndata: ${JSON.stringify([events.get(stream[2]!)])}\n\n`);
      } else if (url.endsWith('/create-image-pixflux')) {
        json({ image: { type: 'base64', base64: stubPng().toString('base64') }, usage: { usd: 0.01 } });
      } else {
        const { model: _model, ...contract } = stubResponse(url.slice(1), (body.parameters ?? {}) as Record<string, unknown>);
        json(contract);
      }
    });
  }).listen(port, '127.0.0.1');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = startStub(3199);
  server.on('listening', () => console.log('stubs on http://127.0.0.1:3199 — Space: /gradio_api/call/<kind>, endpoints: /<kind>, PixelLab: /create-image-pixflux'));
}
