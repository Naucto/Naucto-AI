/**
 * A stand-in for PixelLab, for local development and tests: it answers with a fixed, valid image.
 * It is not a model and must never be configured in production.
 *
 *   npx tsx scripts/stub-endpoint.ts   # prints its URLs (plain HTTP: tests only)
 */
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';

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

/** Answers PixelLab's `create-image-pixflux`, inline or (with `linked`) as a link to `/image.png`. */
export function startStub(port = 0, options: { linked?: boolean; status?: number } = {}) {
  return createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const url = req.url ?? '';
      if (options.status) { res.statusCode = options.status; res.end('{"detail":"secret pl_token rejected"}'); return; }
      if (url.endsWith('/image.png')) { res.setHeader('content-type', 'image/png'); res.end(stubPng()); return; }
      if (!url.endsWith('/create-image-pixflux')) { res.statusCode = 404; res.end('{}'); return; }
      const host = req.headers.host ?? '';
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(options.linked
        ? { image_url: `https://${host}/image.png`, usage: { usd: 0.01 } }
        : { image: { type: 'base64', base64: stubPng().toString('base64') }, usage: { usd: 0.01 } }));
    });
  }).listen(port, '127.0.0.1');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = startStub(3199);
  server.on('listening', () => console.log('PixelLab stub on http://127.0.0.1:3199/create-image-pixflux'));
}
