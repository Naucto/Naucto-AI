import { MAX_SAMPLE_BYTES } from './model';

/**
 * PCM samples live in the game document as base64 of signed 8-bit mono at {@link SAMPLE_RATE}.
 *
 * 8-bit is the console's own resolution and keeps a sample inside {@link MAX_SAMPLE_BYTES} without
 * a compressor: at 8 kHz that is a full second of audio, which is what a kick, a coin or a jump
 * actually needs. Yjs stores it as a string, so the encoding has to be text.
 */
export const SAMPLE_RATE = 8000;

/** How many audio seconds fit in the budget. */
export const MAX_SAMPLE_SECONDS = MAX_SAMPLE_BYTES / SAMPLE_RATE;

/**
 * Mono-mix, resample and clamp arbitrary decoded audio down to what a sample may be.
 *
 * Nearest-neighbour resampling on purpose: the target rate is low enough that interpolation
 * mostly smears the aliasing the console is supposed to have.
 */
export function toSampleBytes(
  channels: readonly Float32Array[],
  sourceRate: number,
  maxBytes = MAX_SAMPLE_BYTES,
): Int8Array {
  const first = channels[0];
  if (!first || sourceRate <= 0) return new Int8Array(0);
  const ratio = SAMPLE_RATE / sourceRate;
  const wanted = Math.floor(first.length * ratio);
  const length = Math.min(wanted, maxBytes);
  const out = new Int8Array(length);

  for (let i = 0; i < length; i++) {
    const src = Math.floor(i / ratio);
    let sum = 0;
    for (const channel of channels) sum += channel[src] ?? 0;
    const mixed = sum / channels.length;
    out[i] = Math.max(-127, Math.min(127, Math.round(mixed * 127)));
  }

  return out;
}

/** Base64 of the raw bytes — what goes into `game.samples`. */
export function encodeSample(pcm: Int8Array): string {
  let binary = '';
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on anything sizeable.
  for (let i = 0; i < bytes.length; i += 1024) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 1024));
  }
  return btoa(binary);
}

/** Back to the -1..1 floats the synth renders. Returns an empty buffer for anything unreadable. */
export function decodeSample(base64: string): Float32Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return new Float32Array(0);
  }
  const out = new Float32Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    // charCodeAt gives 0..255; the high half is the negative range of a signed byte.
    const byte = binary.charCodeAt(i);
    out[i] = (byte > 127 ? byte - 256 : byte) / 127;
  }
  return out;
}
