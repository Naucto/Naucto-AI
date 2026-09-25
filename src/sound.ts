import { z } from 'zod';
import { convertMidi, type MidiImport, writeMidi } from './engine/midi.js';
import { defaultInstrument, type Instrument, type Pattern, type Song, VOICES } from './engine/model.js';
import { decodeSample, encodeSample, MAX_SAMPLE_SECONDS, SAMPLE_RATE, toSampleBytes } from './engine/sample-codec.js';
import { Sequencer } from './engine/Sequencer.js';
import { SynthCore } from './engine/SynthCore.js';
import { analyseAudio, scoreImport, scoreNotes, scoreSample, type ScoredNote, transcribe } from './engine/transcribe.js';
import type { Context } from './native.js';
import { pianoRoll, type RollNote, spectrogram, stacked, waveform } from './render.js';

/*
 * Sound for the assistant, with the console's own synth: the engine files are shared verbatim with
 * the editor, so what is rendered here is what a player would hear. The assistant composes and
 * designs; these tools let it look at the result (piano roll, waveform, spectrogram) and measure it
 * (levels, voices, and how much of what it wrote is actually heard) before proposing it.
 */

/** The rate browsers usually run the synth at, so a render sounds as it will in the editor. */
export const RENDER_RATE = 48000;
const BLOCK = 128;

const draftId = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const soundDraftSchema = z.object({
  instruments: z.array(z.record(z.unknown())).max(16).default([]),
  patterns: z.array(z.record(z.unknown())).min(1).max(32),
  song: z.object({ name: z.string().max(100).default('draft'), sequence: z.array(draftId).min(1).max(128), loop: z.boolean().default(false), loopStart: z.number().int().min(0).default(0) }).optional(),
  samples: z.array(z.object({ id: draftId, data: z.string().max(11000) }).strict()).max(8).default([]),
});
export type SoundDraft = z.infer<typeof soundDraftSchema>;

/** An instrument as the synth needs it: anything the draft leaves out takes the editor's default. */
export function instrumentOf(raw: Record<string, unknown>): Instrument {
  const base = defaultInstrument(String(raw.id ?? 'instrument'));
  const part = <T extends object>(key: string, fallback: T): T => ({ ...fallback, ...((raw[key] ?? {}) as Partial<T>) });
  return {
    ...base, ...(raw as Partial<Instrument>),
    env: part('env', base.env), vibrato: part('vibrato', base.vibrato), arp: part('arp', base.arp), filter: part('filter', base.filter),
  };
}

export function patternOf(raw: Record<string, unknown>): Pattern {
  const pattern = raw as Partial<Pattern>;
  if (typeof pattern.id !== 'string' || !Array.isArray(pattern.notes)) throw new Error('A pattern needs an id and notes');
  return { slot: 0, name: pattern.id, bpm: 120, stepsPerBeat: 4, steps: 32, ...pattern } as Pattern;
}

/** A draft from what is already in the project: a MUSIC or SFX slot and everything it uses. */
export function projectDraft(context: Context, category: 'MUSIC' | 'SFX', slot: number): SoundDraft {
  const stored = (category === 'MUSIC' ? context.songs : context.sfx)[String(slot)];
  if (!stored) throw new Error(`Nothing in ${category} slot ${slot}`);
  const song = category === 'MUSIC' ? JSON.parse(stored) as Song : null;
  const ids = song ? song.sequence.filter((id): id is string => !!id) : [stored];
  const patterns = ids.map(id => {
    const raw = context.patterns[id];
    if (!raw) throw new Error(`Pattern ${id} is missing`);
    return JSON.parse(raw) as Record<string, unknown>;
  });
  const used = new Set(patterns.flatMap(p => (p.notes as { instrument: string }[]).map(n => n.instrument)));
  const instruments = [...used].flatMap(id => (context.instruments[id] ? [JSON.parse(context.instruments[id]) as Record<string, unknown>] : []));
  const unique = [...new Map(patterns.map(p => [String(p.id), p])).values()];
  return {
    instruments,
    patterns: unique,
    song: song ? { name: song.name, sequence: ids, loop: false, loopStart: 0 } : undefined,
    samples: [],
  };
}

export interface Rendered {
  mono: Float32Array;
  rate: number;
  written: RollNote[];
  lanes: string[];
  marks: number[];
  duration: number;
  warnings: string[];
}

/**
 * Plays a draft offline, block by block as the audio worklet does: a song (or its patterns in
 * order) as music, or the first pattern as a sound effect. Loops are played once.
 */
export function renderDraft(draft: SoundDraft, options: { as: 'MUSIC' | 'SFX'; maxSeconds?: number; rate?: number }): Rendered {
  const rate = options.rate ?? RENDER_RATE;
  const maxSeconds = Math.min(options.maxSeconds ?? 30, 120);
  const instruments = new Map(draft.instruments.map(raw => { const i = instrumentOf(raw); return [i.id, i] as const; }));
  const patterns = new Map(draft.patterns.map(raw => { const p = patternOf(raw); return [p.id, p] as const; }));
  const warnings: string[] = [];
  const synth = new SynthCore(rate);
  for (const sample of draft.samples) synth.samples.set(sample.id, decodeSample(sample.data));
  for (const instrument of instruments.values()) {
    if (instrument.osc === 'sample' && instrument.sampleId && !synth.samples.has(instrument.sampleId)) {
      warnings.push(`Instrument ${instrument.id} plays sample ${instrument.sampleId}, which was not given: it is silent here.`);
    }
  }
  const sequencer = new Sequencer(synth, rate);
  sequencer.setLibrary(instruments, patterns);

  const order = options.as === 'SFX' ? [draft.patterns[0]!.id as string] : (draft.song?.sequence ?? [...patterns.keys()]);
  const written: RollNote[] = [];
  const lanes: string[] = [];
  const marks: number[] = [];
  let offset = 0;
  for (const id of order) {
    const pattern = patterns.get(id);
    if (!pattern) { warnings.push(`The song names pattern ${id}, which is not in the draft.`); continue; }
    const step = 60 / pattern.bpm / pattern.stepsPerBeat;
    for (const note of pattern.notes) {
      if (!instruments.has(note.instrument)) warnings.push(`Pattern ${id} uses instrument ${note.instrument}, which is not in the draft: those notes are silent.`);
      let lane = lanes.indexOf(note.instrument);
      if (lane < 0) lane = lanes.push(note.instrument) - 1;
      written.push({ start: offset + note.step * step, end: offset + (note.step + note.length) * step, pitch: note.pitch, volume: note.volume, lane, drum: instruments.get(note.instrument)?.osc === 'noise' });
    }
    offset += pattern.steps * step;
    marks.push(offset);
  }
  marks.pop();
  const writtenSeconds = offset;

  if (options.as === 'SFX') sequencer.playSfx(patterns.get(order[0]!)!, 0, 1);
  else sequencer.playSong({ name: draft.song?.name ?? 'draft', sequence: order, loop: false, loopStart: 0 }, false, 0);
  const tail = Math.max(0.1, ...[...instruments.values()].map(i => i.env.release)) + 0.05;
  const limit = Math.round(Math.min(maxSeconds, writtenSeconds + tail + 0.1) * rate);
  const left = new Float32Array(limit), right = new Float32Array(limit);
  const blockL = new Float32Array(BLOCK), blockR = new Float32Array(BLOCK);
  let at = 0;
  while (at < limit) {
    const frames = Math.min(BLOCK, limit - at);
    sequencer.advance(frames);
    synth.render(blockL, blockR, frames);
    left.set(blockL.subarray(0, frames), at);
    right.set(blockR.subarray(0, frames), at);
    at += frames;
    if (at / rate > writtenSeconds && synth.voices.every(v => !v.active)) break;
  }
  if (writtenSeconds > maxSeconds) warnings.push(`Rendered the first ${maxSeconds} s of ${writtenSeconds.toFixed(1)} s.`);
  const mono = new Float32Array(at);
  let broken = 0;
  for (let i = 0; i < at; i++) {
    const v = ((left[i] ?? 0) + (right[i] ?? 0)) / 2;
    if (Number.isFinite(v)) mono[i] = v; else broken++;
  }
  // The synth keeps its filter stable, so this only catches malformed drafts (e.g. NaN parameters).
  if (broken) warnings.push(`${(broken / rate).toFixed(2)} s rendered as silence: a parameter is not a number.`);

  // More notes at once than the chip has voices means some are cut short or never heard.
  const events = written.flatMap(n => [[n.start, 1], [n.end, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let sounding = 0, peak = 0;
  for (const [, delta] of events) { sounding += delta; peak = Math.max(peak, sounding); }
  if (peak > VOICES) warnings.push(`Up to ${peak} notes sound at once but the chip has ${VOICES} voices: the oldest are stolen.`);
  else if (options.as === 'MUSIC' && peak === VOICES) warnings.push(`The music uses all ${VOICES} voices at times: a sound effect will steal one of them.`);
  return { mono, rate, written, lanes, marks, duration: at / rate, warnings: [...new Set(warnings)] };
}

const db = (v: number): number => Math.round(20 * Math.log10(Math.max(v, 1e-6)) * 10) / 10;

/** Levels, and how much of what was written can actually be heard in the render. */
export function measure(rendered: Rendered) {
  const { mono } = rendered;
  let peak = 0, sum = 0, hot = 0;
  for (const v of mono) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; if (a > 0.95) hot++; }
  const scored: ScoredNote[] = rendered.written.map(n => ({ start: n.start, end: n.end, pitch: n.pitch, velocity: Math.round(n.volume * 127), drum: !!n.drum }));
  const audible = mono.length ? scoreNotes(analyseAudio([mono], rendered.rate), scored) : null;
  return {
    seconds: Math.round(rendered.duration * 100) / 100,
    peakDb: db(peak),
    rmsDb: db(Math.sqrt(sum / Math.max(1, mono.length))),
    saturatedPercent: Math.round((1000 * hot) / Math.max(1, mono.length)) / 10,
    writtenNotes: rendered.written.length,
    /** Agreement between the written notes and what a listener picks out of the render. */
    audibleAsWritten: audible,
    notice: 'audibleAsWritten compares the notes you wrote with what the rendered audio sounds like: low harmony means notes are masked, stolen or out of range; low rhythm means attacks are smeared (slow attack, long release, glide).',
  };
}

export const pianoRollOf = (rendered: Rendered, label: string) =>
  pianoRoll(rendered.written, Math.max(rendered.duration, 0.1), { lanes: rendered.lanes, marks: rendered.marks, label });

export function soundPictures(rendered: Rendered, label: string) {
  return stacked([
    pianoRoll(rendered.written, Math.max(rendered.duration, 0.1), { lanes: rendered.lanes, marks: rendered.marks, label: `${label} - notes as written` }),
    waveform(rendered.mono, rendered.rate, { label: 'waveform (red: at full scale)' }),
    spectrogram(rendered.mono, rendered.rate, { label: 'spectrogram 0-8 kHz' }),
  ]);
}

/* ------------------------------------------------------------------ recordings */

/** A PCM (8/16/24/32-bit) or 32-bit float WAV file, channel by channel. */
export function decodeWav(bytes: Buffer): { channels: Float32Array[]; rate: number } {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Not a WAV file; convert MP3 or OGG to WAV first, or import it in the editor');
  let format = 0, count = 0, rate = 0, bits = 0, data: Buffer | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = bytes.toString('latin1', at, at + 4), size = bytes.readUInt32LE(at + 4);
    const body = bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
    if (id === 'fmt ') {
      format = body.readUInt16LE(0); count = body.readUInt16LE(2); rate = body.readUInt32LE(4); bits = body.readUInt16LE(14);
      if (format === 0xfffe && body.length >= 26) format = body.readUInt16LE(24);
    } else if (id === 'data') data = body;
    at += 8 + size + (size & 1);
  }
  if (!data || !count || !rate) throw new Error('The WAV file has no audio');
  if (!((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && bits === 32))) throw new Error('Unsupported WAV encoding: use PCM or 32-bit float');
  const width = bits / 8, frames = Math.floor(data.length / (width * count));
  const channels = Array.from({ length: count }, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) for (let c = 0; c < count; c++) {
    const at = (f * count + c) * width;
    channels[c]![f] = format === 3 ? data.readFloatLE(at)
      : bits === 8 ? (data[at]! - 128) / 128
      : bits === 16 ? data.readInt16LE(at) / 32768
      : bits === 24 ? data.readIntLE(at, 3) / 8388608
      : data.readInt32LE(at) / 2147483648;
  }
  return { channels, rate };
}

/** Mono 16-bit WAV of rendered audio. */
export function encodeWav(mono: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + mono.length * 2);
  out.write('RIFF', 0); out.writeUInt32LE(36 + mono.length * 2, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write('data', 36); out.writeUInt32LE(mono.length * 2, 40);
  mono.forEach((v, i) => out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, v)) * 32767), 44 + i * 2));
  return out;
}

/**
 * A sample from audio: mono, 8 kHz, signed 8-bit, at most a second, which is what the console
 * stores. The quality is the share of the sound's energy that survives the cut and the 4 kHz limit.
 */
export function bake(channels: Float32Array[], rate: number, id: string, root = 60) {
  const bytes = toSampleBytes(channels, rate);
  const analysis = analyseAudio(channels, rate, 10);
  const seconds = bytes.length / SAMPLE_RATE;
  const decoded = decodeSample(encodeSample(bytes));
  const warnings: string[] = [];
  if ((channels[0]?.length ?? 0) / rate > MAX_SAMPLE_SECONDS) warnings.push(`Cut to ${MAX_SAMPLE_SECONDS} s, the longest a sample may be.`);
  return {
    sample: { id, data: encodeSample(bytes) },
    bytes: bytes.length,
    quality: scoreSample(analysis, seconds),
    instrument: { ...defaultInstrument(`${id}-inst`, id), osc: 'sample' as const, sampleId: id, sampleRoot: root, env: { attack: 0.001, decay: 0.05, sustain: 1, release: 0.05 } },
    picture: waveform(decoded, SAMPLE_RATE, { label: `${id}: ${bytes.length} bytes at 8 kHz, 8-bit` }),
    warnings,
  };
}

export interface TranscribeRequest {
  prefix: string;
  voices: number;
  listen: number;
  sensitivity: number;
  drums: boolean;
  target: 'MUSIC' | 'SFX';
  bpm?: number;
  firstSlot?: number;
}

/** A recording to native drafts, as the editor's import does, with the estimated loss. */
export function transcribeRecording(channels: Float32Array[], rate: number, request: TranscribeRequest) {
  const heard = transcribe(channels, rate, { voices: request.listen, sensitivity: request.sensitivity, drums: request.drums, maxSeconds: 180 });
  let conversion: MidiImport = convertMidi(heard.midi, {
    prefix: request.prefix,
    voices: request.target === 'SFX' ? Math.min(request.voices, 2) : request.voices,
    bpm: request.bpm,
    firstSlot: request.firstSlot,
  });
  const warnings = [...conversion.report.warnings];
  if (heard.truncated) warnings.push('Only the first three minutes were transcribed.');
  if (request.target === 'SFX' && conversion.patterns.length > 1) {
    const first = conversion.patterns[0]!;
    conversion = { ...conversion, patterns: [first], song: { ...conversion.song, sequence: [first.id] } };
    warnings.push('A sound effect is one pattern: only the start was kept.');
  }
  return {
    conversion,
    quality: scoreImport(heard.analysis, conversion),
    tracks: heard.midi.tracks.map(t => ({ name: t.name, notes: t.notes.length })),
    midiBase64: Buffer.from(writeMidi(heard.midi)).toString('base64'),
    warnings,
  };
}
