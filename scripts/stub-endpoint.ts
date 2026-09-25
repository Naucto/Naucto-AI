/**
 * A stand-in for the specialist endpoints, for local development and CI: it answers the provider
 * contract with fixed, valid assets. It is not a model and must never be configured in production.
 *
 *   npx tsx scripts/stub-endpoint.ts   # prints its URLs
 */
import { createServer as createHttp } from 'node:http';

export function stubResponse(path: string, body: { parameters?: Record<string, unknown> }): unknown {
  const params = body.parameters ?? {};
  if (path.endsWith('/sprite')) {
    const width = Number(params.width ?? 16), height = Number(params.height ?? 16);
    return { width, height, pixels: Array.from({ length: width * height }, (_, i) => ((i % width) + Math.floor(i / width)) % 4 === 0 ? 3 : 0) };
  }
  if (path.endsWith('/midi')) {
    const track = [0, 0x90, 60, 100, 96, 0x80, 60, 0, 0, 0x90, 64, 100, 96, 0x80, 64, 0, 0, 255, 47, 0];
    const bytes = Uint8Array.from([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 77, 84, 114, 107, 0, 0, 0, track.length, ...track]);
    return { midiBase64: Buffer.from(bytes).toString('base64') };
  }
  const pcm = Int8Array.from({ length: 800 }, (_, i) => Math.round(Math.sin(i / 3) * 100 * (1 - i / 800)));
  return { pcm8Base64: Buffer.from(pcm.buffer).toString('base64'), sampleRate: 8000 };
}

/** Plain HTTP for tests; the service itself only accepts HTTPS endpoints. */
export function startStub(port = 0) {
  return createHttp((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(stubResponse(req.url ?? '', JSON.parse(raw || '{}'))));
    });
  }).listen(port, '127.0.0.1');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = startStub(3199);
  server.on('listening', () => console.log('stub endpoints on http://127.0.0.1:3199/{sprite,midi,sample} (HTTP: tests only)'));
}
