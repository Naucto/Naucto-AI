export type OscType = 'square' | 'sine' | 'triangle' | 'saw' | 'noise' | 'sample';
export type FilterType = 'off' | 'lp' | 'hp' | 'bp';

export interface Envelope {
  /** seconds */
  attack: number;
  decay: number;
  /** 0..1 */
  sustain: number;
  release: number;
}

export interface Instrument {
  id: string;
  name: string;
  osc: OscType;
  /** Square duty cycle 0..1 (0.5 = square). */
  duty: number;
  /** Constant pitch offset in semitones, -12..12. */
  detune: number;
  /** Portamento in seconds: how long the pitch takes to reach a new note. 0 = off. */
  glide: number;
  sampleId?: string;
  /** MIDI note at which the sample plays at its recorded pitch. */
  sampleRoot?: number;
  env: Envelope;
  vibrato: { rate: number; depth: number; delay: number };
  /**
   * Speed the voice walks a chord at, in cycles a second; zero holds every note of it at once.
   *
   * The shape is the chord itself — the notes written on the same step — rather than a list the
   * instrument carries, so an arpeggio is something you play instead of something you configure.
   */
  arp: { rate: number };
  filter: { type: FilterType; cutoff: number; resonance: number; envAmount: number };
  /** 0..1 */
  volume: number;
  /** -1..1 */
  pan: number;
  /** 0..15, which accent colour the editor shows it with. */
  colour: number;
}

export interface Note {
  /** Step index inside the pattern. */
  step: number;
  /** MIDI pitch 0..127 */
  pitch: number;
  /** Length in steps (may be fractional). */
  length: number;
  instrument: string;
  /** 0..1 */
  volume: number;
}

export interface Pattern {
  id: string;
  /**
   * What a pattern is called, which is a number.
   *
   * A song's order list is a column of these, so it has to be something a reader can see; the id
   * identifies the pattern but says nothing to anybody.
   */
  slot: number;
  name: string;
  bpm: number;
  stepsPerBeat: 1 | 2 | 4 | 8;
  steps: number;
  notes: Note[];
}

export interface Song {
  name: string;
  /**
   * Pattern ids played in order, with `null` for a place nothing has been put in.
   *
   * A place may be empty because a music is written by filling a grid, not by pushing onto a list —
   * and an empty place is where the music ends, never a rest. A pattern carries its own length and
   * an empty place has none, so there is no answer to how long a silence there would last.
   */
  sequence: (string | null)[];
  loop: boolean;
  loopStart: number;
}

/**
 * Positions a step is divided into for playback.
 *
 * A note's `step` is a number, not an index — one may be dropped between two steps. The clock ticks
 * at this resolution, so it is also the finest position anything may write: past it a note has
 * nowhere to sound. Chosen to reach a hundred-and-twenty-eighth note at the default steps per beat.
 */
export const SUBSTEPS = 8;

export const VOICES = 5;
export const SONG_SLOTS = 16;
export const MAX_SAMPLE_BYTES = 8 * 1024;

export const NOTE_NAMES = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
] as const;

export const midiToFrequency = (midi: number): number => 440 * Math.pow(2, (midi - 69) / 12);

/** "C4" → 60, "A#3" → 58. Returns null for unparsable names. */
export const noteNameToMidi = (name: string): number | null => {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[(m[1] ?? 'c').toLowerCase()] ?? 0;
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + acc;
};

export const midiToNoteName = (midi: number): string =>
  `${NOTE_NAMES[((midi % 12) + 12) % 12] ?? 'C'}${String(Math.floor(midi / 12) - 1)}`;

export const defaultInstrument = (id: string, name = 'lead'): Instrument => ({
  id,
  name,
  osc: 'square',
  duty: 0.5,
  detune: 0,
  glide: 0,
  env: { attack: 0.01, decay: 0.1, sustain: 0.6, release: 0.15 },
  vibrato: { rate: 5, depth: 0, delay: 0.2 },
  arp: { rate: 0 },
  filter: { type: 'off', cutoff: 8000, resonance: 0.2, envAmount: 0 },
  volume: 0.8,
  pan: 0,
  colour: 4,
});

export const defaultPattern = (id: string, slot = 0, name = 'pattern 00'): Pattern => ({
  id,
  slot,
  name,
  bpm: 124,
  stepsPerBeat: 4,
  steps: 32,
  notes: [],
});

export const defaultSong = (): Song => ({
  name: '',
  sequence: [],
  loop: true,
  loopStart: 0,
});
