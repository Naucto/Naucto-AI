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
  /** The same places in beats (quarter notes) from the start, when the file says them. */
  startBeat?: number;
  endBeat?: number;
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
  /**
   * The one tempo a performance played with a wavering pulse is best taken at, in beats a minute.
   *
   * Set only for a file with many small tempo changes — a recording of somebody playing, not a score
   * with a ritardando — where timing in seconds drifts off the bars and no phrase lands twice in the
   * same place. Notes are then placed by beat, so the music is as steady as it is written.
   */
  steadyBpm?: number;
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
  /** Places in the song's order list: how many sections the music is, repeats included. */
  sections: number;
  /** Sections that replay a pattern already stored instead of holding their notes again. */
  reusedSections: number;
  /** Steps in each pattern, chosen so the fewest notes have to be stored. */
  patternSteps: number;
  /** The finest timing the notes were snapped to, in steps: 1/8 keeps the file's own timing. */
  timingGrid: number;
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
/** Pattern lengths a conversion may use, each a whole number of bars at four steps a beat. */
const PATTERN_SIZES = [32, 16, 64] as const;
/** What one more stored pattern costs, in notes: a pattern is a slot and a name as well as its notes. */
const PATTERN_OVERHEAD = 4;
/** The finest timing a pattern holds, an eighth of a step. */
const EXACT_GRID = 0.125;
/** Coarser timings tried on music played by hand, whole steps first. */
const TIDY_GRIDS = [1, 0.5, 0.25] as const;
/** A coarser timing must store at most this share of what the exact one does... */
const TIDY_GAIN = 0.85;
/** ...and move a note's start by no more than this many steps on average. */
const TIDY_SHIFT = 0.2;
/** Volumes that differ by less than this count as the same note when comparing sections. */
const VOLUME_TOLERANCE = 0.15;
const RELEASE_SECONDS = 0.02;
/** More tempo changes than this, all within this ratio of each other, are a wavering pulse. */
const WAVERING_CHANGES = 8;
const WAVERING_SPREAD = 1.5;

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
        startBeat: note.tick / ppq,
        endBeat: note.end / ppq,
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
  // Many small changes around one tempo are a pulse that wavers, not a tempo that was written.
  const speeds = map.map((entry) => entry.us);
  const wavering =
    map.length > WAVERING_CHANGES && Math.max(...speeds) / Math.min(...speeds) <= WAVERING_SPREAD;
  let steadyBpm: number | undefined;
  if (wavering && duration > 0) {
    const beats = Math.max(...tracks.flatMap((t) => t.notes.map((n) => n.endBeat ?? 0)));
    steadyBpm = (60 * beats) / duration;
    warnings.add(
      `${String(map.length - 1)} small tempo changes were evened out to one steady tempo, so repeated phrases line up.`,
    );
  } else if (map.length > 1)
    warnings.add(
      `${String(map.length - 1)} tempo change(s) were flattened: timing is kept, the song plays at one tempo.`,
    );

  return {
    tracks,
    bpm: 60e6 / (map[0]?.us ?? 500000),
    ...(steadyBpm === undefined ? {} : { steadyBpm }),
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

interface Attempt {
  grid: number;
  accepted: PackedNote[];
  dropped: number;
  peak: number;
  quantized: number;
  meanShift: number;
  packed: Packed;
}

interface Packed {
  steps: number;
  patterns: PackedNote[][];
  order: number[];
  cost: number;
}

interface PackedNote {
  step: number;
  pitch: number;
  length: number;
  instrument: string;
  volume: number;
}

/**
 * Cuts the music into sections and stores each different one once.
 *
 * Music repeats: a theme is its phrase said again, a loop is a bar played over and over. Writing
 * every repeat out in full is what made a short tune cost a hundred patterns, so a section whose
 * notes are the same as an earlier one is not stored again; the song's order list just names that
 * pattern a second time. A note that runs past its section is part of the section that holds it
 * (the sequencer lets it sound into the next one), so two sections with the same notes sound alike
 * wherever they sit.
 *
 * Two sections are the same when they play the same notes at the same places and every volume is
 * within a small tolerance. A recorded performance never repeats a velocity exactly, and an exact
 * comparison would find nothing to reuse in a file played by hand; the first occurrence's volumes
 * are the ones kept.
 *
 * The length is chosen too, because a loop of one bar and a loop of four are both common and no one
 * length suits both: the one that stores the fewest notes wins, a pattern's own cost counted in.
 */
function dedupeSections(sections: readonly (readonly PackedNote[])[], steps: number): Packed {
  // Patterns already stored, by what they play apart from loudness.
  const seen = new Map<string, number[]>();
  const patterns: PackedNote[][] = [];
  const order: number[] = [];
  for (const section of sections) {
    const relative = [...section].sort(
      (a, b) => a.step - b.step || a.pitch - b.pitch || a.instrument.localeCompare(b.instrument),
    );
    const key = relative
      .map((n) => `${String(n.step)}|${String(n.pitch)}|${String(n.length)}|${n.instrument}`)
      .join(';');
    const alike = (seen.get(key) ?? []).find((candidate) =>
      (patterns[candidate] ?? []).every(
        (n, i) => Math.abs(n.volume - (relative[i]?.volume ?? 0)) <= VOLUME_TOLERANCE,
      ),
    );
    let slot = alike;
    if (slot === undefined) {
      slot = patterns.length;
      seen.set(key, [...(seen.get(key) ?? []), slot]);
      patterns.push(relative);
    }
    order.push(slot);
  }
  const cost = patterns.reduce((sum, p) => sum + p.length + PATTERN_OVERHEAD, 0);

  return { steps, patterns, order, cost };
}

export function convertMidi(parsed: ParsedMidi, options: MidiImportOptions): MidiImport {
  const voices = options.voices;
  if (!Number.isInteger(voices) || voices < 1 || voices > 5)
    throw new Error('Voice budget must be 1–5');
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(options.prefix)) throw new Error('Invalid prefix');
  const steady = parsed.steadyBpm !== undefined;
  const bpm = Math.round(options.bpm ?? parsed.steadyBpm ?? parsed.bpm);
  if (bpm < 40 || bpm > 240) throw new Error('Tempo is outside the editor range (40–240 BPM)');
  const chosen = parsed.tracks.filter(
    (t) => t.notes.length && (!options.tracks || options.tracks.includes(t.index)),
  );
  if (!chosen.length) throw new Error('Choose at least one track with notes');

  const stepsPerSecond = (bpm / 60) * 4;
  const release = RELEASE_SECONDS * stepsPerSecond;
  const instruments: MidiInstrument[] = [];
  let percussionNotes = 0;
  interface Candidate {
    step: number;
    length: number;
    pitch: number;
    volume: number;
    instrument: string;
  }
  const sources: {
    start: number;
    end: number;
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
      const drum = note.channel === 9;
      if (drum) percussionNotes++;
      sources.push({
        // By beat for a pulse that wavers, so a bar is the same length every time it comes round.
        start:
          steady && note.startBeat !== undefined ? note.startBeat * 4 : note.start * stepsPerSecond,
        end: steady && note.endBeat !== undefined ? note.endBeat * 4 : note.end * stepsPerSecond,
        pitch: drum ? drumPitch(note.pitch) : note.pitch,
        volume: note.velocity / 127,
        instrument: id,
      });
    }
  }

  /**
   * The whole conversion with onsets and ends snapped to a grid of `grid` steps.
   *
   * Done end to end for each grid rather than snapping afterwards, because the snap changes which
   * notes sound together and so which of them a voice budget has room for.
   */
  const attempt = (grid: number): Attempt => {
    const per = 1 / grid;
    let quantized = 0;
    let shift = 0;
    const candidates: Candidate[] = sources.map((source) => {
      const step = Math.round(source.start * per) / per;
      const end = Math.max(step + grid, Math.round(source.end * per) / per);
      if (Math.abs(step - source.start) > 1e-6 || Math.abs(end - source.end) > 1e-6) quantized++;
      shift += Math.abs(step - source.start);
      return {
        step,
        length: end - step,
        pitch: source.pitch,
        volume: source.volume,
        instrument: source.instrument,
      };
    });

    candidates.sort((a, b) => a.step - b.step || b.pitch - a.pitch);
    if (!candidates.length) throw new Error('No notes fit the voice budget');
    const total = Math.max(...candidates.map((n) => n.step + n.length));

    /** Walks onsets in time order; at each, hands the free voices to the notes that matter most. */
    const allocate = (
      list: readonly Candidate[],
      held: number[],
    ): { accepted: Candidate[]; dropped: number; peak: number; ends: number[] } => {
      const accepted: Candidate[] = [];
      let ends = held;
      let dropped = 0;
      let peak = 0;
      for (let i = 0; i < list.length;) {
        const step = list[i]?.step ?? 0;
        const batch: Candidate[] = [];
        for (let next = list[i]; next?.step === step; next = list[++i]) batch.push(next);
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
            keep = [...new Set(ordered.filter((n): n is Candidate => !!n))].slice(
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

      return { accepted, dropped, peak, ends };
    };

    let best: Attempt | null = null;
    for (const steps of PATTERN_SIZES) {
      const count = Math.ceil(total / steps);
      const sections: Candidate[][] = Array.from({ length: count }, () => []);
      for (const note of candidates) sections[Math.floor(note.step / steps)]?.push(note);
      // What each distinct section turned out to be once the voice budget had its say. A section
      // that comes round again is given the same answer: left to the walk, the notes dropped
      // depend on whatever was still ringing from before, so the same bar lost different notes
      // each time and no two of them matched.
      const heard: { raw: Candidate[]; kept: PackedNote[]; dropped: number }[] = [];
      const seenRaw = new Map<string, number[]>();
      const kept: PackedNote[][] = [];
      const accepted: PackedNote[] = [];
      let ends: number[] = [];
      let dropped = 0;
      let peak = 0;
      for (const [index, section] of sections.entries()) {
        const base = index * steps;
        const raw = section.map((n) => ({ ...n, step: n.step - base }));
        const key = raw
          .map((n) => `${String(n.step)}|${String(n.pitch)}|${String(n.length)}|${n.instrument}`)
          .join(';');
        ends = ends.filter((end) => end > base);
        const known = (seenRaw.get(key) ?? [])
          .map((i) => heard[i])
          .find((h) =>
            h?.raw.every((n, i) => Math.abs(n.volume - (raw[i]?.volume ?? 0)) <= VOLUME_TOLERANCE),
          );
        let result: { kept: PackedNote[]; dropped: number };
        if (known) {
          result = known;
          for (const n of known.kept) ends.push(base + n.step + n.length + release);
          peak = Math.max(peak, ends.length);
        } else {
          const out = allocate(section, ends);
          ends = out.ends;
          peak = Math.max(peak, out.peak);
          result = {
            kept: out.accepted.map((n) => ({ ...n, step: n.step - base })),
            dropped: out.dropped,
          };
          seenRaw.set(key, [...(seenRaw.get(key) ?? []), heard.length]);
          heard.push({ raw, ...result });
        }
        dropped += result.dropped;
        kept.push(result.kept);
        for (const n of result.kept) accepted.push({ ...n, step: n.step + base });
      }
      const packed = dedupeSections(kept, steps);
      // Strictly better only, so a tie keeps the earlier size, which is the usual two bars.
      if (!best || packed.cost < best.packed.cost)
        best = {
          grid,
          accepted,
          dropped,
          peak,
          quantized,
          meanShift: sources.length ? shift / sources.length : 0,
          packed,
        };
    }
    if (!best?.accepted.length) throw new Error('No notes fit the voice budget');

    return best;
  };

  // The file's own timing first. Then, for music played by hand, a coarser grid that makes the
  // repeats line up — taken only when it pays for itself and moves notes by little.
  const exact = attempt(EXACT_GRID);
  let chosenAttempt = exact;
  for (const grid of TIDY_GRIDS) {
    const tidy = attempt(grid);
    const smaller = tidy.packed.cost <= exact.packed.cost * TIDY_GAIN;
    const close = tidy.meanShift <= TIDY_SHIFT;
    const whole = tidy.accepted.length >= exact.accepted.length * 0.98;
    if (smaller && close && whole && tidy.packed.cost < chosenAttempt.packed.cost)
      chosenAttempt = tidy;
  }
  const { accepted, dropped, peak, quantized, packed } = chosenAttempt;
  const first = options.firstSlot ?? 0;
  const patterns = packed.patterns.map((notes, index) => ({
    id: `${options.prefix}-p${String(index)}`,
    slot: first + index,
    name: `${options.prefix} ${String(index + 1)}`,
    bpm,
    stepsPerBeat: 4 as const,
    steps: packed.steps,
    notes,
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
    song: {
      name: options.prefix,
      sequence: packed.order.map((index) => patterns[index]?.id ?? ''),
      loop: true,
      loopStart: 0,
    },
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
      sections: packed.order.length,
      reusedSections: packed.order.length - patterns.length,
      patternSteps: packed.steps,
      timingGrid: chosenAttempt.grid,
      warnings,
    },
  };
}

/**
 * A Standard MIDI File (format 1, 480 ticks a beat) of parsed notes, so a transcription can be
 * taken to another tool. One track per `MidiTrack`, at the opening tempo.
 */
export function writeMidi(parsed: ParsedMidi): Uint8Array {
  const ppq = 480;
  const ticksPerSecond = (parsed.bpm / 60) * ppq;
  const vlq = (value: number): number[] => {
    const out = [value & 127];
    for (let v = value >> 7; v > 0; v >>= 7) out.unshift((v & 127) | 128);
    return out;
  };
  const chunk = (tag: string, body: number[]): number[] => [
    ...Array.from(tag, (c) => c.charCodeAt(0)),
    (body.length >>> 24) & 255,
    (body.length >>> 16) & 255,
    (body.length >>> 8) & 255,
    body.length & 255,
    ...body,
  ];
  const us = Math.round(60e6 / parsed.bpm);
  const tempo = [0, 255, 81, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255, 0, 255, 47, 0];
  const tracks = parsed.tracks.map((track) => {
    const events: { tick: number; order: number; bytes: number[] }[] = [];
    for (const note of track.notes) {
      const channel = note.channel & 15;
      const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
      const velocity = Math.max(1, Math.min(127, Math.round(note.velocity)));
      events.push({
        tick: Math.round(note.start * ticksPerSecond),
        order: 1,
        bytes: [0x90 | channel, pitch, velocity],
      });
      events.push({
        tick: Math.max(
          Math.round(note.start * ticksPerSecond) + 1,
          Math.round(note.end * ticksPerSecond),
        ),
        order: 0,
        bytes: [0x80 | channel, pitch, 0],
      });
    }
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const body: number[] = [];
    const name = Array.from(track.name.slice(0, 40), (c) => c.charCodeAt(0) & 127);
    body.push(0, 255, 3, name.length, ...name);
    if (track.program !== null && track.channels[0] !== undefined)
      body.push(0, 0xc0 | (track.channels[0] & 15), track.program & 127);
    let at = 0;
    for (const event of events) {
      body.push(...vlq(event.tick - at), ...event.bytes);
      at = event.tick;
    }
    body.push(0, 255, 47, 0);
    return chunk('MTrk', body);
  });
  const header = chunk('MThd', [0, 1, 0, tracks.length + 1, ppq >> 8, ppq & 255]);
  return Uint8Array.from([...header, ...chunk('MTrk', tempo), ...tracks.flat()]);
}
