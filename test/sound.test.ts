import { test } from 'node:test';
import assert from 'node:assert/strict';
import { designSfx } from '../src/native.js';
import { bake, decodeWav, encodeWav, measure, projectDraft, renderDraft, transcribeRecording } from '../src/sound.js';

const lead = { id: 'lead', osc: 'square', env: { attack: 0.005, decay: 0.05, sustain: 0.7, release: 0.05 } };
const pattern = (id: string, notes: [number, number, number][], steps = 16) =>
  ({ id, bpm: 120, stepsPerBeat: 4, steps, notes: notes.map(([step, pitch, length]) => ({ step, pitch, length, instrument: 'lead', volume: 0.8 })) });

test('a song renders for as long as its patterns last, and what was written is heard', () => {
  const melody = pattern('a', [[0, 60, 4], [4, 64, 4], [8, 67, 4], [12, 72, 4]]);
  const rendered = renderDraft({ instruments: [lead], patterns: [melody, { ...melody, id: 'b' }], song: { name: 's', sequence: ['a', 'b'], loop: true, loopStart: 0 }, samples: [] }, { as: 'MUSIC' });
  assert.ok(rendered.duration >= 4 && rendered.duration < 4.4, `4 s of music plus the release, got ${rendered.duration}`);
  assert.equal(rendered.written.length, 8);
  assert.deepEqual(rendered.marks, [2]);
  const measured = measure(rendered);
  assert.ok(measured.audibleAsWritten && measured.audibleAsWritten.fidelity > 70, JSON.stringify(measured.audibleAsWritten));
  assert.ok(measured.peakDb < 0);
});

test('problems are reported: stolen voices, missing parts, an unstable filter', () => {
  const chord = pattern('c', [0, 1, 2, 3, 4, 5].map(i => [0, 60 + i * 3, 8] as [number, number, number]));
  const crowded = renderDraft({ instruments: [lead], patterns: [chord], samples: [] }, { as: 'MUSIC' });
  assert.ok(crowded.warnings.some(w => /6 notes sound at once/.test(w)));
  const missing = renderDraft({ instruments: [{ ...lead, osc: 'sample', sampleId: 'kick' }], patterns: [chord], samples: [] }, { as: 'SFX' });
  assert.ok(missing.warnings.some(w => /sample kick/.test(w)));
  const bright = { ...lead, osc: 'saw', filter: { type: 'lp', cutoff: 8000, resonance: 0.2, envAmount: 1 } };
  const unstable = renderDraft({ instruments: [bright], patterns: [pattern('p', [[0, 72, 4]])], samples: [] }, { as: 'SFX' });
  assert.ok(unstable.warnings.some(w => /filter became unstable/.test(w)));
  assert.ok(unstable.mono.every(Number.isFinite));
});

test('designed effects bake into samples the console can store', () => {
  const { instrument, pattern: sfx } = designSfx('coin', 'coin', { duration: 1, pitch: 0, brightness: 1, intensity: 0.8, variations: 1 }).variations[0]!;
  const rendered = renderDraft({ instruments: [instrument], patterns: [sfx], samples: [] }, { as: 'SFX' });
  const baked = bake([rendered.mono], rendered.rate, 'coin');
  assert.ok(baked.bytes > 0 && baked.bytes <= 8192);
  assert.ok(Buffer.from(baked.sample.data, 'base64').length === baked.bytes);
  assert.equal(baked.instrument.sampleId, 'coin');
  assert.ok(baked.quality.fidelity > 50);
  // The baked sample plays back through an instrument.
  const replay = renderDraft({ instruments: [baked.instrument], patterns: [{ ...sfx, notes: [{ step: 0, pitch: 60, length: 8, instrument: baked.instrument.id, volume: 1 }] }], samples: [baked.sample] }, { as: 'SFX' });
  assert.equal(replay.warnings.length, 0);
  assert.ok(replay.mono.some(v => Math.abs(v) > 0.05));
});

test('WAV recordings decode, and transcribe into drafts with an estimated loss', () => {
  const rate = 22050;
  const tone = new Float32Array(rate * 2);
  [[60, 0.1], [67, 0.6], [64, 1.1]].forEach(([pitch, start]) => {
    const f = 440 * 2 ** ((pitch! - 69) / 12);
    for (let i = 0; i < rate * 0.4; i++) tone[Math.round(start! * rate) + i] = [1, 2, 3, 4].reduce((sum, h) => sum + (0.4 / h) * Math.sin((2 * Math.PI * f * h * i) / rate), 0);
  });
  const wav = encodeWav(tone, rate);
  const decoded = decodeWav(wav);
  assert.equal(decoded.rate, rate);
  assert.ok(Math.abs(decoded.channels[0]![rate / 5]! - tone[rate / 5]!) < 1e-4);
  const result = transcribeRecording(decoded.channels, decoded.rate, { prefix: 'rec', voices: 4, listen: 2, sensitivity: 0.5, drums: false, target: 'MUSIC' });
  assert.deepEqual(result.conversion.patterns.flatMap(p => p.notes.map(n => n.pitch)), [60, 67, 64]);
  assert.ok(result.quality.fidelity > 60);
  assert.ok(Buffer.from(result.midiBase64, 'base64').subarray(0, 4).toString() === 'MThd');
  assert.throws(() => decodeWav(Buffer.from('ID3 not a wav file')), /Not a WAV/);
});

test('a project slot becomes a draft with everything it uses', () => {
  const a = pattern('a', [[0, 60, 4]]);
  const draft = projectDraft({
    palette: [], code: [], sheets: [], maps: [], catalog: {}, levels: {}, locks: {}, samples: [],
    instruments: { lead: JSON.stringify(lead), other: '{}' }, patterns: { a: JSON.stringify(a) },
    songs: { '0': JSON.stringify({ name: 'theme', sequence: ['a', 'a', null], loop: true, loopStart: 0 }) }, sfx: { '3': 'a' },
  }, 'MUSIC', 0);
  assert.deepEqual(draft.song?.sequence, ['a', 'a']);
  assert.equal(draft.patterns.length, 1);
  assert.deepEqual(draft.instruments.map(i => i.id), ['lead']);
});
