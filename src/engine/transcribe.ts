/**
 * Audio → notes: turns a recording (decoded MP3, WAV…) into a `ParsedMidi` the MIDI importer
 * converts like any MIDI file, and estimates how much of the original survives.
 *
 * Self-contained and dependency-free on purpose, like `midi.ts`: the same file runs in the
 * browser for the SOUND tab's import and in the Naucto-AI service, which checks what its own
 * rendered sounds contain. No model is involved: it is spectral analysis (harmonic summation with
 * iterative subtraction for several simultaneous notes, spectral-flux onsets, a tempo estimate),
 * so it is fast and predictable and loses a lot on dense mixes. The quality figure says how much.
 */
import type { MidiImport, MidiNote, MidiTrack, ParsedMidi } from './midi';

/** Everything is analysed at this rate: enough for pitches and drum colour, cheap to process. */
export const ANALYSIS_RATE = 16000;
const FFT_SIZE = 4096;
/** A short window alongside the long one: onsets and drum colour need time, not frequency. */
const SHORT_SIZE = 512;
const HOP = 256;
/** How late the long window's view of a note ends, and how early it starts, on average. */
const LONG_WINDOW_LAG = 0.06;
const SNAP_AFTER = 0.16;
const SNAP_FRAMES = Math.ceil((SNAP_AFTER * ANALYSIS_RATE) / HOP);
/** Notes this short that begin with another note's start or end are clicks, not notes. */
const CLICK_SECONDS = 0.09;
const HARMONICS = 8;
const HARMONIC_DECAY = 0.8;
const BIN_HZ = ANALYSIS_RATE / FFT_SIZE;
const FRAME_SECONDS = HOP / ANALYSIS_RATE;

export interface TranscribeOptions {
  /** Simultaneous notes looked for per moment, 1–6. */
  voices?: number;
  /** Pitch range, MIDI notes. */
  lowest?: number;
  highest?: number;
  /** Look for drum hits (noisy onsets) and put them on their own track. */
  drums?: boolean;
  /** 0–1: higher keeps quieter notes, and more mistakes with them. */
  sensitivity?: number;
  /** Longer recordings are cut here. */
  maxSeconds?: number;
}

/** What the original recording looked like, kept to score any note list against it. */
export interface AudioAnalysis {
  frames: number;
  duration: number;
  /** Pitch-class energy per frame, `frames × 12`. */
  chroma: Float32Array;
  /** Compressed spectral energy per frame, 0–1. */
  energy: Float32Array;
  /** Linear power per frame: all of it, and the part below 4 kHz (what an 8 kHz sample keeps). */
  power: Float32Array;
  lowPower: Float32Array;
  /** Detected onsets, seconds. */
  onsets: number[];
}

export interface Quality {
  /** Estimated share of the original kept, 0–100. */
  fidelity: number;
  /** 100 − fidelity. */
  loss: number;
  /** Pitch-class similarity over time, 0–100. */
  harmony: number;
  /** Onset agreement, 0–100. */
  rhythm: number;
}

export interface Transcription {
  midi: ParsedMidi;
  analysis: AudioAnalysis;
  /** Score of the raw transcription, before any conversion to chip patterns. */
  quality: Quality;
  truncated: boolean;
}

export interface ScoredNote {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
  drum: boolean;
}

// ---------------------------------------------------------------------------------- signal

/** Mono mix, box-filtered down to the analysis rate, normalised to a peak of 1. */
function prepare(
  channels: readonly Float32Array[],
  rate: number,
  maxSeconds: number,
): { signal: Float32Array; truncated: boolean } {
  const first = channels[0];
  if (!first?.length || !(rate > 0)) throw new Error('No audio to analyse');
  const available = first.length;
  const wanted = Math.min(available, Math.floor(maxSeconds * rate));
  const ratio = rate / ANALYSIS_RATE;
  const length = Math.floor(wanted / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const from = i * ratio,
      to = Math.max(from + 1, (i + 1) * ratio);
    let sum = 0,
      count = 0;
    for (let j = Math.floor(from); j < Math.min(Math.ceil(to), wanted); j++) {
      let mixed = 0;
      for (const channel of channels) mixed += channel[j] ?? 0;
      sum += mixed / channels.length;
      count++;
    }
    out[i] = count ? sum / count : 0;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) / peak;
  return { signal: out, truncated: wanted < available };
}

/** In-place iterative radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] ?? 0, re[i] ?? 0];
      [im[i], im[j]] = [im[j] ?? 0, im[i] ?? 0];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    const wr = Math.cos(angle),
      wi = Math.sin(angle);
    for (let start = 0; start < n; start += size) {
      let cr = 1,
        ci = 0;
      for (let k = 0; k < size / 2; k++) {
        const a = start + k,
          b = a + size / 2;
        const tr = (re[b] ?? 0) * cr - (im[b] ?? 0) * ci,
          ti = (re[b] ?? 0) * ci + (im[b] ?? 0) * cr;
        re[b] = (re[a] ?? 0) - tr;
        im[b] = (im[a] ?? 0) - ti;
        re[a] = (re[a] ?? 0) + tr;
        im[a] = (im[a] ?? 0) + ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

const frequencyOf = (pitch: number): number => 440 * Math.pow(2, (pitch - 69) / 12);
const pitchClassOf = (pitch: number): number => ((Math.round(pitch) % 12) + 12) % 12;

// ---------------------------------------------------------------------------------- analysis

interface Candidate {
  pitch: number;
  salience: number;
}

interface Frames {
  analysis: AudioAnalysis;
  candidates: Candidate[][];
  flux: Float32Array;
  flatness: Float32Array;
  lowRatio: Float32Array;
  centroid: Float32Array;
}

function analyse(signal: Float32Array, lowest: number, highest: number, voices: number): Frames {
  const frames = Math.max(1, Math.floor(signal.length / HOP));
  const half = FFT_SIZE / 2;
  const window = Float64Array.from(
    { length: FFT_SIZE },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE),
  );
  const norm = FFT_SIZE / 4;
  const pcOfBin = Int8Array.from({ length: half }, (_, k) => {
    const f = k * BIN_HZ;
    return f < 50 || f > 4000 ? -1 : pitchClassOf(69 + 12 * Math.log2(f / 440));
  });
  // Bins each harmonic of each note may fall in: a quarter-tone either side.
  const bands = Array.from({ length: highest - lowest + 1 }, (_, i) => {
    const f0 = frequencyOf(lowest + i);
    const out: [number, number, number][] = [];
    for (let h = 1; h <= HARMONICS; h++) {
      const f = f0 * h;
      if (f > ANALYSIS_RATE * 0.45) break;
      out.push([
        Math.max(1, Math.floor((f * Math.pow(2, -1 / 24)) / BIN_HZ)),
        Math.min(half - 1, Math.ceil((f * Math.pow(2, 1 / 24)) / BIN_HZ)),
        Math.pow(HARMONIC_DECAY, h - 1),
      ]);
    }
    return out;
  });

  const chroma = new Float32Array(frames * 12);
  const energy = new Float32Array(frames);
  const power = new Float32Array(frames);
  const lowPower = new Float32Array(frames);
  const flux = new Float32Array(frames);
  const flatness = new Float32Array(frames);
  const lowRatio = new Float32Array(frames);
  const centroid = new Float32Array(frames);
  const candidates: Candidate[][] = [];
  const re = new Float64Array(FFT_SIZE),
    im = new Float64Array(FFT_SIZE);
  const compressed = new Float64Array(half),
    work = new Float64Array(half);
  const shortHalf = SHORT_SIZE / 2,
    shortBin = ANALYSIS_RATE / SHORT_SIZE;
  const shortWindow = Float64Array.from(
    { length: SHORT_SIZE },
    (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / SHORT_SIZE),
  );
  const sre = new Float64Array(SHORT_SIZE),
    sim = new Float64Array(SHORT_SIZE),
    shortPrevious = new Float64Array(shortHalf);
  const lowBin = Math.floor(4000 / BIN_HZ);

  for (let f = 0; f < frames; f++) {
    const centre = f * HOP;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = (signal[centre - half + i] ?? 0) * (window[i] ?? 0);
      im[i] = 0;
    }
    fft(re, im);
    let total = 0,
      pw = 0,
      pwLow = 0;
    for (let k = 1; k < half; k++) {
      const magnitude = Math.hypot(re[k] ?? 0, im[k] ?? 0) / norm;
      const c = Math.log1p(100 * magnitude);
      compressed[k] = c;
      total += c;
      const p = magnitude * magnitude;
      pw += p;
      if (k < lowBin) pwLow += p;
      const pc = pcOfBin[k] ?? 0;
      if (pc >= 0) chroma[f * 12 + pc] = (chroma[f * 12 + pc] ?? 0) + c;
    }
    energy[f] = total;
    power[f] = pw;
    lowPower[f] = pwLow;

    // The short window: flux for onsets, and the colour of what starts there.
    for (let i = 0; i < SHORT_SIZE; i++) {
      sre[i] = (signal[centre - shortHalf + i] ?? 0) * (shortWindow[i] ?? 0);
      sim[i] = 0;
    }
    fft(sre, sim);
    let rise = 0,
      logSum = 0,
      linSum = 0,
      weighted = 0,
      low = 0,
      all = 0,
      counted = 0;
    for (let k = 1; k < shortHalf; k++) {
      const magnitude = Math.hypot(sre[k] ?? 0, sim[k] ?? 0) / (SHORT_SIZE / 4);
      const c = Math.log1p(100 * magnitude);
      rise += Math.max(0, c - (shortPrevious[k] ?? 0));
      shortPrevious[k] = c;
      const freq = k * shortBin;
      if (freq >= 100) {
        logSum += Math.log(magnitude + 1e-9);
        linSum += magnitude;
        counted++;
      }
      weighted += freq * magnitude;
      all += magnitude;
      if (freq < 200) low += magnitude;
    }
    flux[f] = rise;
    flatness[f] = linSum > 0 ? Math.exp(logSum / counted) / (linSum / counted) : 0;
    lowRatio[f] = all > 0 ? low / all : 0;
    centroid[f] = all > 0 ? weighted / all : 0;

    // Harmonic summation, then subtract the chosen note's expected harmonics and look again.
    work.set(compressed);
    const found: Candidate[] = [];
    for (let v = 0; v < voices + 1; v++) {
      let best = -1,
        bestSalience = 0;
      for (let n = 0; n < bands.length; n++) {
        let salience = 0;
        for (const [a, b, w] of bands[n] ?? []) {
          let peak = 0;
          for (let k = a; k <= b; k++) peak = Math.max(peak, work[k] ?? 0);
          salience += w * peak;
        }
        if (salience > bestSalience) {
          bestSalience = salience;
          best = n;
        }
      }
      if (best < 0 || bestSalience <= 0) break;
      found.push({ pitch: lowest + best, salience: bestSalience });
      const [fa, fb] = bands[best]?.[0] ?? [0, -1];
      let reference = 0;
      for (let k = fa; k <= fb; k++) reference = Math.max(reference, work[k] ?? 0);
      // Remove what this note is expected to own of each harmonic: its fundamental's level on the
      // usual decay, and at least most of what is there. A note an octave above keeps the excess.
      for (const [a, b, w] of bands[best] ?? []) {
        let present = 0;
        for (let k = a; k <= b; k++) present = Math.max(present, work[k] ?? 0);
        const expected = Math.max(reference * w, 0.6 * present);
        for (let k = Math.max(1, a - 1); k <= Math.min(half - 1, b + 1); k++)
          work[k] = Math.max(0, (work[k] ?? 0) - expected);
      }
    }
    candidates.push(found);
  }

  let maxEnergy = 0;
  for (const e of energy) maxEnergy = Math.max(maxEnergy, e);
  if (maxEnergy > 0) for (let f = 0; f < frames; f++) energy[f] = (energy[f] ?? 0) / maxEnergy;
  return {
    analysis: {
      frames,
      duration: frames * FRAME_SECONDS,
      chroma,
      energy,
      power,
      lowPower,
      onsets: onsetsOf(flux).map((f) => f * FRAME_SECONDS),
    },
    candidates,
    flux,
    flatness,
    lowRatio,
    centroid,
  };
}

/** Peaks of the spectral flux above a moving median: note and drum starts. */
function onsetsOf(flux: Float32Array): number[] {
  let max = 0;
  for (const v of flux) max = Math.max(max, v);
  if (max <= 0) return [];
  const norm = Float32Array.from(flux, (v) => v / max);
  const out: number[] = [];
  for (let f = 1; f < norm.length - 1; f++) {
    const around = Array.from(norm.subarray(Math.max(0, f - 8), f + 9)).sort((a, b) => a - b);
    const median = around[Math.floor(around.length / 2)] ?? 0;
    let peak = true;
    for (let g = Math.max(0, f - 3); g <= Math.min(norm.length - 1, f + 3); g++)
      if ((norm[g] ?? 0) > (norm[f] ?? 0)) peak = false;
    if (
      peak &&
      (norm[f] ?? 0) > median * 1.5 + 0.06 &&
      (!out.length || f - (out[out.length - 1] ?? 0) >= 3)
    )
      out.push(f);
  }
  return out;
}

/** Tempo from the autocorrelation of the onset strength, favouring the 90–150 BPM region. */
function tempoOf(flux: Float32Array): number {
  const framesPerSecond = 1 / FRAME_SECONDS;
  let bestBpm = 120,
    bestScore = 0;
  for (let bpm = 60; bpm <= 200; bpm++) {
    const lag = (60 * framesPerSecond) / bpm;
    let score = 0;
    for (let f = 0; f + 2 * lag + 1 < flux.length; f++) {
      const at = (x: number): number => {
        const i = Math.floor(x);
        return (flux[i] ?? 0) + ((flux[i + 1] ?? 0) - (flux[i] ?? 0)) * (x - i);
      };
      score += (flux[f] ?? 0) * (at(f + lag) + 0.5 * at(f + 2 * lag));
    }
    score *= Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    if (score > bestScore) {
      bestScore = score;
      bestBpm = bpm;
    }
  }
  return bestBpm;
}

// ---------------------------------------------------------------------------------- notes

function trackNotes(frames: Frames, sensitivity: number): { notes: MidiNote[]; peak: number } {
  const { candidates } = frames;
  let peak = 0;
  for (const found of candidates) peak = Math.max(peak, found[0]?.salience ?? 0);
  const absolute = peak * (0.28 - 0.2 * sensitivity);
  const byPitch = new Map<number, Float32Array>();
  candidates.forEach((found, f) => {
    const first = found[0]?.salience ?? 0;
    if ((frames.analysis.energy[f] ?? 0) < 0.02) return;
    for (const { pitch, salience } of found) {
      if (salience < absolute || salience < first * (0.45 - 0.2 * sensitivity)) continue;
      let row = byPitch.get(pitch);
      if (!row) {
        row = new Float32Array(candidates.length);
        byPitch.set(pitch, row);
      }
      row[f] = salience;
    }
  });
  const onsetFrames = new Set(frames.analysis.onsets.map((t) => Math.round(t / FRAME_SECONDS)));
  const notes: MidiNote[] = [];
  const minFrames = 4,
    gap = 2;
  const onsets = frames.analysis.onsets;
  const emit = (pitch: number, row: Float32Array, from: number, to: number): void => {
    if (to - from < minFrames) return;
    let sum = 0;
    for (let f = from; f < to; f++) sum += row[f] ?? 0;
    const strength = sum / (to - from) / (0.7 * peak);
    // The long window hears a note before it starts and after it stops: take the start from the
    // short window's onset nearby when there is one, and pull both ends in by the window's lag.
    const seen = from * FRAME_SECONDS;
    const expected = seen + LONG_WINDOW_LAG;
    const near = onsets.filter((t) => t >= seen - 0.03 && t <= seen + SNAP_AFTER);
    const start = near.length
      ? near.reduce((a, b) => (Math.abs(b - expected) < Math.abs(a - expected) ? b : a))
      : expected;
    const end = Math.max(start + 0.05, to * FRAME_SECONDS - LONG_WINDOW_LAG);
    notes.push({
      start,
      end,
      pitch,
      velocity: Math.max(1, Math.min(127, Math.round(40 + 87 * Math.min(1, strength)))),
      channel: 0,
    });
  };
  for (const [pitch, row] of byPitch) {
    let start = -1,
      last = -1;
    for (let f = 0; f <= row.length; f++) {
      const on = f < row.length && (row[f] ?? 0) > 0;
      // Onsets within the snapping range belong to this note's own start, not a repeat.
      if (on && start >= 0 && onsetFrames.has(f) && f - start > SNAP_FRAMES) {
        // A new attack inside a held pitch is a repeated note, not one long one.
        const before = Math.min(...[1, 2, 3].map((d) => row[f - d] ?? 0).filter((v) => v > 0));
        if ((row[f] ?? 0) > 1.25 * before) {
          emit(pitch, row, start, last + 1);
          start = f;
        }
      }
      if (on) {
        if (start < 0) start = f;
        last = f;
      } else if (start >= 0 && (f - last > gap || f === row.length)) {
        emit(pitch, row, start, last + 1);
        start = -1;
      }
    }
  }
  // An attack smears into its neighbouring semitones for a frame or two: drop such ghosts, short
  // notes a semitone from a longer, stronger note sounding at the same time.
  const length = (n: MidiNote): number => n.end - n.start;
  const kept = notes.filter(
    (n) =>
      !notes.some(
        (m) =>
          m !== n &&
          Math.abs(m.pitch - n.pitch) === 1 &&
          m.velocity >= n.velocity &&
          length(m) >= 2 * length(n) &&
          Math.min(m.end, n.end) - Math.max(m.start, n.start) >= 0.8 * length(n),
      ),
  );
  // A hard start or stop is a click, heard as a burst of short low notes. It is where the note
  // really starts or stops — its broadband energy hides the note from the long window meanwhile —
  // so a note following a click begins there, one stopping just before a click ends there, and the
  // click itself is dropped.
  const short = kept.filter((n) => length(n) <= CLICK_SECONDS);
  const clicks = new Set<MidiNote>();
  for (const m of kept) {
    if (length(m) <= 2 * CLICK_SECONDS) continue;
    const before = short.filter(
      (n) => m.start - n.start >= -0.04 && m.start - n.start <= SNAP_AFTER,
    );
    const after = short.filter((n) => n.start - m.end >= -0.04 && n.start - m.end <= 0.12);
    // The nearest click on each side: the one before is this note's, earlier ones are not.
    const latest = Math.max(...before.map((n) => n.start));
    const earliest = Math.min(...after.map((n) => n.start));
    for (const n of before) if (n.start >= latest - 0.02) clicks.add(n);
    for (const n of after) if (n.start <= earliest + 0.02) clicks.add(n);
    if (before.length) m.start = Math.min(m.start, latest);
    if (after.length) m.end = Math.max(m.end, earliest);
  }
  const clean = kept.filter((n) => !clicks.has(n));
  return { notes: clean.sort((a, b) => a.start - b.start || a.pitch - b.pitch), peak };
}

/** Noisy onsets become kick, snare or hi-hat hits, told apart by where their energy sits. */
function drumHits(frames: Frames, pitched: MidiNote[]): MidiNote[] {
  const out: MidiNote[] = [];
  let maxFlux = 0;
  for (const v of frames.flux) maxFlux = Math.max(maxFlux, v);
  for (const t of frames.analysis.onsets) {
    const f = Math.round(t / FRAME_SECONDS);
    const flat = frames.flatness[f] ?? 0,
      low = frames.lowRatio[f] ?? 0;
    const pitchedStart = pitched.some((n) => Math.abs(n.start - t) < 0.05);
    if (flat < 0.3 && !(low > 0.55 && !pitchedStart)) continue;
    const key = low > 0.45 ? 36 : (frames.centroid[f] ?? 0) > 3500 ? 42 : 38;
    const velocity = Math.max(
      30,
      Math.min(127, Math.round((127 * (frames.flux[f] ?? 0)) / (maxFlux || 1))),
    );
    out.push({ start: t, end: t + 0.1, pitch: key, velocity, channel: 9 });
  }
  return out;
}

// ---------------------------------------------------------------------------------- scoring

/**
 * How much of a recording a list of notes keeps. Harmony compares pitch classes over time (the
 * notes are "rendered" as harmonic series, so octave slips and timbre are not punished); rhythm
 * compares onsets within 70 ms. An estimate for comparing settings, not a listening test.
 */
export function scoreNotes(analysis: AudioAnalysis, notes: readonly ScoredNote[]): Quality {
  const synth = new Float32Array(analysis.frames * 12);
  for (const note of notes) {
    if (note.drum) continue;
    const from = Math.max(0, Math.floor(note.start / FRAME_SECONDS)),
      to = Math.min(analysis.frames, Math.ceil(note.end / FRAME_SECONDS));
    for (let h = 1; h <= HARMONICS; h++) {
      const pc = pitchClassOf(note.pitch + 12 * Math.log2(h));
      const weight = (note.velocity / 127) * Math.pow(HARMONIC_DECAY, h - 1);
      for (let f = from; f < to; f++) synth[f * 12 + pc] = (synth[f * 12 + pc] ?? 0) + weight;
    }
  }
  let similar = 0,
    weights = 0;
  for (let f = 0; f < analysis.frames; f++) {
    let dot = 0,
      a = 0,
      b = 0;
    for (let k = 0; k < 12; k++) {
      const x = analysis.chroma[f * 12 + k] ?? 0,
        y = synth[f * 12 + k] ?? 0;
      dot += x * y;
      a += x * x;
      b += y * y;
    }
    const loud = analysis.energy[f] ?? 0;
    const weight = loud > 0.05 ? loud : b > 0 ? 0.2 : 0;
    if (!weight) continue;
    weights += weight;
    if (a > 0 && b > 0) similar += weight * (dot / Math.sqrt(a * b));
  }
  const harmony = weights ? similar / weights : 1;

  const starts = [...new Set(notes.map((n) => Math.round((n.start * 1000) / 30)))]
    .map((v) => v * 0.03)
    .sort((x, y) => x - y);
  const reference = analysis.onsets;
  let matched = 0;
  const used = new Set<number>();
  for (const t of reference) {
    const hit = starts.findIndex((s, i) => !used.has(i) && Math.abs(s - t) <= 0.07);
    if (hit >= 0) {
      used.add(hit);
      matched++;
    }
  }
  const rhythm =
    !reference.length && !starts.length
      ? 1
      : (2 * matched) / (reference.length + starts.length || 1);
  const fidelity = Math.round(100 * (0.65 * harmony + 0.35 * rhythm));
  return {
    fidelity,
    loss: 100 - fidelity,
    harmony: Math.round(100 * harmony),
    rhythm: Math.round(100 * rhythm),
  };
}

/** The notes a chip conversion actually plays, back in seconds, drums told apart by their voice. */
export function notesOfImport(conversion: MidiImport): ScoredNote[] {
  const drums = new Set(conversion.instruments.filter((i) => i.osc === 'noise').map((i) => i.id));
  const byId = new Map(conversion.patterns.map((p) => [p.id, p]));
  const out: ScoredNote[] = [];
  let offset = 0;
  for (const id of conversion.song.sequence) {
    const pattern = byId.get(id);
    if (!pattern) continue;
    const seconds = 60 / (pattern.bpm * pattern.stepsPerBeat);
    for (const note of pattern.notes) {
      const start = offset + note.step * seconds;
      out.push({
        start,
        end: start + note.length * seconds,
        pitch: note.pitch,
        velocity: Math.round(note.volume * 127),
        drum: drums.has(note.instrument),
      });
    }
    offset += pattern.steps * seconds;
  }
  return out;
}

/** How a recording scores once converted to chip patterns: the number the import dialog shows. */
export function scoreImport(analysis: AudioAnalysis, conversion: MidiImport): Quality {
  return scoreNotes(analysis, notesOfImport(conversion));
}

/**
 * What an 8 kHz, 8-bit, one-second sample keeps of a recording: the energy inside its length and
 * below 4 kHz. The 8-bit quantisation costs little on top at these levels and is not modelled.
 */
export function scoreSample(analysis: AudioAnalysis, seconds: number): Quality {
  let total = 0,
    kept = 0;
  for (let f = 0; f < analysis.frames; f++) {
    total += analysis.power[f] ?? 0;
    if (f * FRAME_SECONDS < seconds) kept += analysis.lowPower[f] ?? 0;
  }
  const fidelity = total > 0 ? Math.round((100 * kept) / total) : 100;
  return { fidelity, loss: 100 - fidelity, harmony: fidelity, rhythm: fidelity };
}

// ---------------------------------------------------------------------------------- entry

/**
 * The analysis alone, to score notes or a sample against a sound without transcribing it: short
 * effects and silence have nothing to transcribe but can still be measured.
 */
export function analyseAudio(
  channels: readonly Float32Array[],
  sampleRate: number,
  maxSeconds = 180,
): AudioAnalysis {
  const { signal } = prepare(channels, sampleRate, maxSeconds);
  return analyse(signal, 36, 96, 1).analysis;
}

export function transcribe(
  channels: readonly Float32Array[],
  sampleRate: number,
  options: TranscribeOptions = {},
): Transcription {
  const voices = Math.max(1, Math.min(6, Math.round(options.voices ?? 4)));
  const lowest = Math.max(24, Math.min(100, options.lowest ?? 36));
  const highest = Math.max(lowest + 12, Math.min(108, options.highest ?? 96));
  const sensitivity = Math.max(0, Math.min(1, options.sensitivity ?? 0.5));
  const { signal, truncated } = prepare(channels, sampleRate, options.maxSeconds ?? 180);
  const frames = analyse(signal, lowest, highest, voices);
  const { notes } = trackNotes(frames, sensitivity);
  const drums = options.drums === false ? [] : drumHits(frames, notes);
  const track = (index: number, name: string, list: MidiNote[], channel: number): MidiTrack => ({
    index,
    name,
    notes: list,
    channels: list.length ? [channel] : [],
    program: null,
    percussion: channel === 9 && list.length > 0,
  });
  const tracks = [track(0, 'melody & harmony', notes, 0), track(1, 'drums', drums, 9)].filter(
    (t) => t.notes.length,
  );
  const warnings = [
    'Transcribed from audio: pitches, timing and drums are estimates; timbre, effects and vocals are not kept.',
  ];
  if (truncated)
    warnings.push(`Only the first ${String(options.maxSeconds ?? 180)} seconds were analysed.`);
  if (!tracks.length) throw new Error('No notes were found in this recording');
  const midi: ParsedMidi = {
    tracks,
    bpm: tempoOf(frames.flux),
    tempoChanges: 0,
    sustained: 0,
    warnings,
    duration: Math.max(...tracks.flatMap((t) => t.notes.map((n) => n.end))),
  };
  const quality = scoreNotes(
    frames.analysis,
    [...notes, ...drums].map((n) => ({ ...n, drum: n.channel === 9 })),
  );
  return { midi, analysis: frames.analysis, quality, truncated };
}
