/**
 * Standard MIDI File import into Naucto's native sound model.
 *
 * Self-contained on purpose: the same file is copied verbatim into the Naucto-AI service, which
 * converts generated MIDI with it, and a drift test there compares the two. Everything a MIDI file
 * can say that the chip cannot play is reported rather than silently approximated.
 */

export interface MidiNote {
  /** Start and end in seconds, after the tempo map. */
  start: number;
  end: number;
  pitch: number;
  velocity: number;
  channel: number;
}

export interface MidiTrack {
  index: number;
  name: string;
  notes: MidiNote[];
  channels: number[];
  program: number | null;
  percussion: boolean;
}

export interface ParsedMidi {
  tracks: MidiTrack[];
  /** Tempo in effect at the start, beats per minute. */
  bpm: number;
  tempoChanges: number;
  /** Notes whose release a sustain pedal held past their note-off. */
  sustained: number;
  warnings: string[];
  duration: number;
}

/** The instrument fields a conversion writes; the shape Naucto's `Instrument` has. */
export interface MidiInstrument {
  id: string;
  name: string;
  osc: 'square' | 'sine' | 'triangle' | 'saw' | 'noise';
  duty: number;
  detune: number;
  glide: number;
  env: { attack: number; decay: number; sustain: number; release: number };
  vibrato: { rate: number; depth: number; delay: number };
  arp: { rate: number };
  filter: {
    type: 'off' | 'lp' | 'hp' | 'bp';
    cutoff: number;
    resonance: number;
    envAmount: number;
  };
  volume: number;
  pan: number;
  colour: number;
}

export interface MidiImportOptions {
  prefix: string;
  /** Voices the music may hold at once; one is usually left free for sound effects. */
  voices: number;
  /** Which tracks to import (all when omitted). */
  tracks?: number[];
  /** Instrument per track index; a default chip voice otherwise. */
  instruments?: Record<number, Omit<MidiInstrument, 'id'>>;
  /** `outer` keeps the highest and lowest notes of a chord (melody and bass) when voices run out. */
  strategy?: 'outer' | 'first';
  /** Tempo of the converted song; the file's opening tempo by default. */
  bpm?: number;
  /** First pattern slot to use; the caller picks free ones. */
  firstSlot?: number;
}

export interface MidiImportReport {
  sourceNotes: number;
  importedNotes: number;
  droppedNotes: number;
  quantizedNotes: number;
  percussionNotes: number;
  tempoChanges: number;
  sustainedNotes: number;
  peakVoices: number;
  voiceBudget: number;
  warnings: string[];
}

export interface MidiImport {
  instruments: MidiInstrument[];
  patterns: {
    id: string;
    slot: number;
    name: string;
    bpm: number;
    stepsPerBeat: 4;
    steps: number;
    notes: { step: number; pitch: number; length: number; instrument: string; volume: number }[];
  }[];
  song: { name: string; sequence: string[]; loop: boolean; loopStart: number };
  report: MidiImportReport;
}

const MAX_BYTES = 262144;
const MAX_EVENTS = 50000;
const MAX_SECONDS = 600;
const PATTERN_STEPS = 32;
const RELEASE_SECONDS = 0.02;

/** General MIDI drum keys, mapped onto noise pitches that read as the same drum on the chip. */
const DRUMS: [number[], number][] = [
  [[35, 36], 28],
  [[37, 38, 39, 40], 52],
  [[41, 43, 45, 47], 44],
  [[48, 50], 56],
  [[42, 44], 84],
  [[46], 80],
  [[49, 51, 52, 55, 57, 59], 96],
];

export function drumPitch(key: number): number {
  return DRUMS.find(([keys]) => keys.includes(key))?.[1] ?? 64;
}

export function readMidi(bytes: Uint8Array): ParsedMidi {
  if (bytes.length > MAX_BYTES) throw new Error('MIDI exceeds 256 KiB');
  let offset = 0;
  const byte = (): number => {
    if (offset >= bytes.length) throw new Error('Truncated MIDI');
    return bytes[offset++] ?? 0;
  };
  const word = (): number => byte() * 256 + byte();
  const dword = (): number => word() * 65536 + word();
  const tag = (): string => String.fromCharCode(byte(), byte(), byte(), byte());
  const vlq = (): number => {
    let result = 0;
    for (let i = 0; i < 4; i++) {
      const b = byte();
      result = result * 128 + (b & 127);
      if (!(b & 128)) return result;
    }
    throw new Error('Invalid MIDI variable-length quantity');
  };
  if (tag() !== 'MThd' || dword() !== 6) throw new Error('Invalid MIDI header');
  const format = word();
  const count = word();
  const ppq = word();
  if (
    format > 1 ||
    count < 1 ||
    count > 64 ||
    !ppq ||
    ppq & 0x8000 ||
    (format === 0 && count !== 1)
  )
    throw new Error('Only format 0/1 files with metrical timing are supported');

  const warnings = new Set<string>();
  const tempos: { tick: number; us: number }[] = [];
  interface RawNote {
    tick: number;
    end: number;
    pitch: number;
    velocity: number;
    channel: number;
    sustained?: boolean;
  }
  const raw: { name: string; notes: RawNote[]; channels: Set<number>; program: number | null }[] =
    [];
  let events = 0;

  for (let track = 0; track < count; track++) {
    if (tag() !== 'MTrk') throw new Error('Expected MIDI track');
    const length = dword();
    const end = offset + length;
    if (end > bytes.length) throw new Error('Truncated MIDI track');
    let tick = 0;
    let running = 0;
    const active = new Map<string, { tick: number; velocity: number }[]>();
    const pedal = new Map<number, boolean>();
    /** Notes released while the pedal was down, waiting for it to lift. */
    const held = new Map<number, RawNote[]>();
    const out = {
      name: '',
      notes: [] as RawNote[],
      channels: new Set<number>(),
      program: null as number | null,
    };
    while (offset < end) {
      if (++events > MAX_EVENTS) throw new Error('Too many MIDI events');
      tick += vlq();
      let status = byte();
      if (status < 128) {
        if (!running) throw new Error('Invalid MIDI running status');
        offset--;
        status = running;
      } else if (status < 240) running = status;
      else running = 0;
      if (status === 255) {
        const type = byte();
        const size = vlq();
        const next = offset + size;
        if (next > end) throw new Error('Truncated MIDI metadata');
        if (type === 81 && size === 3) {
          const us = byte() * 65536 + byte() * 256 + byte();
          if (!us) throw new Error('Invalid tempo');
          tempos.push({ tick, us });
        } else if (type === 3 && !out.name) {
          out.name = String.fromCharCode(...bytes.subarray(offset, Math.min(next, offset + 40)));
        }
        offset = next;
        if (type === 47) {
          offset = end;
          break;
        }
      } else if (status === 240 || status === 247) {
        offset += vlq();
        warnings.add('System-exclusive messages were omitted.');
      } else {
        const kind = status >> 4;
        const channel = status & 15;
        const a = byte();
        const b = kind === 12 || kind === 13 ? 0 : byte();
        if (a > 127 || b > 127) throw new Error('Invalid MIDI data byte');
        const key = `${String(channel)}:${String(a)}`;
        if (kind === 9 && b > 0) {
          const list = active.get(key) ?? [];
          list.push({ tick, velocity: b });
          active.set(key, list);
          out.channels.add(channel);
        } else if (kind === 8 || (kind === 9 && b === 0)) {
          const start = active.get(key)?.shift();
          if (!start) continue;
          const note = { tick: start.tick, end: tick, pitch: a, velocity: start.velocity, channel };
          if (pedal.get(channel) && channel !== 9)
            held.set(channel, [...(held.get(channel) ?? []), note]);
          else out.notes.push(note);
        } else if (kind === 11 && a === 64) {
          const down = b >= 64;
          if (!down && pedal.get(channel)) {
            for (const note of held.get(channel) ?? [])
              out.notes.push({ ...note, end: tick, sustained: true });
            held.delete(channel);
          }
          pedal.set(channel, down);
        } else if (kind === 11) warnings.add('Controllers other than sustain were omitted.');
        else if (kind === 12) out.program ??= a;
        else if (kind === 14) warnings.add('Pitch bends were omitted.');
        else if (kind === 10 || kind === 13) warnings.add('Aftertouch was omitted.');
      }
      if (offset > end) throw new Error('Event crosses its track boundary');
    }
    if ([...active.values()].some((list) => list.length))
      throw new Error('Unterminated MIDI notes');
    // A pedal never lifted holds its notes to the end of the track.
    for (const list of held.values())
      for (const note of list) out.notes.push({ ...note, end: tick, sustained: true });
    raw.push(out);
  }
  if (offset !== bytes.length) throw new Error('Unexpected trailing MIDI data');

  // Tempo map: ticks to seconds, whichever track the tempo events were written in.
  tempos.sort((x, y) => x.tick - y.tick);
  const map: { tick: number; us: number; seconds: number }[] = [
    { tick: 0, us: tempos[0]?.tick === 0 ? tempos[0].us : 500000, seconds: 0 },
  ];
  for (const tempo of tempos) {
    const last = map[map.length - 1];
    if (!last || tempo.tick === 0) continue;
    if (tempo.us === last.us) continue;
    map.push({
      tick: tempo.tick,
      us: tempo.us,
      seconds: last.seconds + ((tempo.tick - last.tick) * last.us) / ppq / 1e6,
    });
  }
  const seconds = (tick: number): number => {
    let at = map[0] ?? { tick: 0, us: 500000, seconds: 0 };
    for (const entry of map) if (entry.tick <= tick) at = entry;
    return at.seconds + ((tick - at.tick) * at.us) / ppq / 1e6;
  };

  let sustained = 0;
  let duration = 0;
  const tracks = raw.map((track, index) => {
    const notes = track.notes.map((note) => {
      if (note.sustained) sustained++;
      const n = {
        start: seconds(note.tick),
        end: seconds(note.end),
        pitch: note.pitch,
        velocity: note.velocity,
        channel: note.channel,
      };
      duration = Math.max(duration, n.end);
      return n;
    });
    return {
      index,
      name: track.name.replace(/[^\x20-\x7e]/g, '').trim() || `track ${String(index + 1)}`,
      notes,
      channels: [...track.channels].sort((x, y) => x - y),
      program: track.program,
      percussion: track.channels.size > 0 && [...track.channels].every((c) => c === 9),
    };
  });
  if (duration > MAX_SECONDS) throw new Error('MIDI is longer than ten minutes');
  if (!tracks.some((t) => t.notes.length)) throw new Error('MIDI contains no completed notes');
  if (map.length > 1)
    warnings.add(
      `${String(map.length - 1)} tempo change(s) were flattened: timing is kept, the song plays at one tempo.`,
    );

  return {
    tracks,
    bpm: 60e6 / (map[0]?.us ?? 500000),
    tempoChanges: map.length - 1,
    sustained,
    warnings: [...warnings],
    duration,
  };
}

export function chipInstrument(name: string, percussion: boolean): Omit<MidiInstrument, 'id'> {
  return {
    name,
    osc: percussion ? 'noise' : 'square',
    duty: 0.5,
    detune: 0,
    glide: 0,
    env: percussion
      ? { attack: 0.001, decay: 0.08, sustain: 0, release: 0.02 }
      : { attack: 0.002, decay: 0.05, sustain: 0.6, release: 0.05 },
    vibrato: { rate: 0, depth: 0, delay: 0 },
    arp: { rate: 0 },
    filter: { type: 'off', cutoff: 8000, resonance: 0, envAmount: 0 },
    volume: percussion ? 0.5 : 0.4,
    pan: 0,
    colour: percussion ? 2 : 4,
  };
}

export function convertMidi(parsed: ParsedMidi, options: MidiImportOptions): MidiImport {
  const voices = options.voices;
  if (!Number.isInteger(voices) || voices < 1 || voices > 5)
    throw new Error('Voice budget must be 1–5');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(options.prefix)) throw new Error('Invalid prefix');
  const bpm = Math.round(options.bpm ?? parsed.bpm);
  if (bpm < 40 || bpm > 240) throw new Error('Tempo is outside the editor range (40–240 BPM)');
  const chosen = parsed.tracks.filter(
    (t) => t.notes.length && (!options.tracks || options.tracks.includes(t.index)),
  );
  if (!chosen.length) throw new Error('Choose at least one track with notes');

  const stepsPerSecond = (bpm / 60) * 4;
  const release = RELEASE_SECONDS * stepsPerSecond;
  const instruments: MidiInstrument[] = [];
  let quantized = 0;
  let percussionNotes = 0;
  const candidates: {
    step: number;
    length: number;
    pitch: number;
    volume: number;
    instrument: string;
  }[] = [];
  for (const track of chosen) {
    const id = `${options.prefix}-t${String(track.index)}`;
    instruments.push({
      ...(options.instruments?.[track.index] ??
        chipInstrument(track.name.slice(0, 40), track.percussion)),
      id,
    });
    for (const note of track.notes) {
      const rawStep = note.start * stepsPerSecond;
      const rawEnd = note.end * stepsPerSecond;
      const step = Math.round(rawStep * 8) / 8;
      const end = Math.max(step + 0.125, Math.round(rawEnd * 8) / 8);
      if (Math.abs(step - rawStep) > 1e-6 || Math.abs(end - rawEnd) > 1e-6) quantized++;
      const drum = note.channel === 9;
      if (drum) percussionNotes++;
      candidates.push({
        step,
        length: end - step,
        pitch: drum ? drumPitch(note.pitch) : note.pitch,
        volume: note.velocity / 127,
        instrument: id,
      });
    }
  }

  // Walk onsets in time order; at each, hand the free voices to the notes that matter most.
  candidates.sort((a, b) => a.step - b.step || b.pitch - a.pitch);
  const accepted: typeof candidates = [];
  let ends: number[] = [];
  let dropped = 0;
  let peak = 0;
  for (let i = 0; i < candidates.length;) {
    const step = candidates[i]?.step ?? 0;
    const batch: typeof candidates = [];
    for (let next = candidates[i]; next?.step === step; next = candidates[++i]) batch.push(next);
    ends = ends.filter((end) => end > step);
    const free = voices - ends.length;
    let keep = batch;
    if (batch.length > free) {
      if (options.strategy === 'first') keep = batch.slice(0, Math.max(0, free));
      else {
        const byPitch = [...batch].sort((a, b) => b.pitch - a.pitch);
        const ordered = [
          byPitch[0],
          byPitch[byPitch.length - 1],
          ...byPitch.slice(1, -1).sort((a, b) => b.volume - a.volume),
        ];
        keep = [...new Set(ordered.filter((n): n is (typeof batch)[number] => !!n))].slice(
          0,
          Math.max(0, free),
        );
      }
      dropped += batch.length - keep.length;
    }
    for (const note of keep) {
      accepted.push(note);
      ends.push(note.step + note.length + release);
    }
    peak = Math.max(peak, ends.length);
  }
  if (!accepted.length) throw new Error('No notes fit the voice budget');

  const total = Math.max(...accepted.map((n) => n.step + n.length));
  const count = Math.ceil(total / PATTERN_STEPS);
  if (count > 128)
    throw new Error('The selection needs more than 128 patterns; import a shorter part');
  const first = options.firstSlot ?? 0;
  const patterns = Array.from({ length: count }, (_, index) => ({
    id: `${options.prefix}-p${String(index)}`,
    slot: first + index,
    name: `${options.prefix} ${String(index + 1)}`,
    bpm,
    stepsPerBeat: 4 as const,
    steps: PATTERN_STEPS,
    // A note may run past its pattern's end; the sequencer lets it sound into the next one.
    notes: accepted
      .filter((n) => n.step >= index * PATTERN_STEPS && n.step < (index + 1) * PATTERN_STEPS)
      .map((n) => ({ ...n, step: n.step - index * PATTERN_STEPS })),
  }));
  const warnings = [...parsed.warnings];
  if (percussionNotes)
    warnings.push('Percussion was mapped onto a noise voice; tune its pitches by ear.');
  if (parsed.sustained)
    warnings.push(`${String(parsed.sustained)} note(s) held by the sustain pedal were lengthened.`);
  if (chosen.some((t) => t.program !== null && !options.instruments?.[t.index]))
    warnings.push(
      'General MIDI programs were replaced by chip voices; choose instruments before importing.',
    );

  return {
    instruments,
    patterns,
    song: { name: options.prefix, sequence: patterns.map((p) => p.id), loop: true, loopStart: 0 },
    report: {
      sourceNotes: chosen.reduce((sum, t) => sum + t.notes.length, 0),
      importedNotes: accepted.length,
      droppedNotes: dropped,
      quantizedNotes: quantized,
      percussionNotes,
      tempoChanges: parsed.tempoChanges,
      sustainedNotes: parsed.sustained,
      peakVoices: peak,
      voiceBudget: voices,
      warnings,
    },
  };
}
