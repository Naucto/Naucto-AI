import { type Instrument, midiToFrequency, VOICES } from './model';

/** One playing voice. All times are in samples. */
interface Voice {
  active: boolean;
  instrument: Instrument | null;
  pitch: number;
  /** Target frequency of the note being played. */
  freq: number;
  /** Frequency actually sounding; slides towards `freq` when the instrument glides. */
  curFreq: number;
  phase: number;
  age: number;
  /** 0 attack, 1 decay, 2 sustain, 3 release, 4 done */
  stage: number;
  env: number;
  releaseAt: number; // samples until release (-1 = until stopNote)
  releaseFrom: number;
  velocity: number;
  noiseSeed: number;
  lastNoise: number;
  // state variable filter
  low: number;
  band: number;
  sample: Float32Array | null;
  samplePos: number;
  priority: number;
  /** Semitones above this voice's own note that it cycles through, empty when it holds one note. */
  arp: readonly number[];
}

const newVoice = (): Voice => ({
  active: false,
  instrument: null,
  pitch: 60,
  freq: 261.63,
  curFreq: 261.63,
  phase: 0,
  age: 0,
  stage: 4,
  env: 0,
  releaseAt: -1,
  releaseFrom: 0,
  velocity: 1,
  noiseSeed: 0x1234,
  lastNoise: 0,
  low: 0,
  band: 0,
  sample: null,
  samplePos: 0,
  priority: 0,
  arp: [],
});

/**
 * Pure-TS chip synthesiser: 5 voices, 6 oscillators, ADSR, SVF filter, vibrato,
 * arpeggio, pan. No Web Audio dependency so it renders offline in tests and
 * inside the AudioWorklet identically.
 */
export class SynthCore {
  readonly voices: Voice[] = Array.from({ length: VOICES }, newVoice);
  readonly samples = new Map<string, Float32Array>();
  master = 1;
  /** The song's fade; `musicLevel` is the volume the game asks for. Both scale the music. */
  musicGain = 1;
  musicLevel = 1;
  sfxGain = 1;

  constructor(readonly sampleRate: number) {}

  /** Start a note; returns the voice index used. `channel` forces a voice. */
  noteOn(
    instrument: Instrument,
    pitch: number,
    velocity: number,
    lengthSeconds: number,
    channel?: number,
    priority = 0,
    arp: readonly number[] = [],
  ): number {
    const idx =
      channel !== undefined ? Math.max(0, Math.min(VOICES - 1, channel)) : this.allocate(priority);
    const v = this.voices[idx];
    if (!v) return idx;
    // Glide slides from whatever this voice was already sounding, so retriggering the same voice
    // bends into the new note; a fresh voice starts on pitch.
    const wasSounding = v.active && v.stage !== 4;
    v.active = true;
    v.instrument = instrument;
    v.pitch = pitch;
    v.freq = midiToFrequency(pitch);
    v.curFreq = instrument.glide > 0 && wasSounding ? v.curFreq : v.freq;
    v.phase = 0;
    v.age = 0;
    v.stage = 0;
    v.env = 0;
    v.velocity = Math.max(0, Math.min(1, velocity));
    v.releaseAt = lengthSeconds > 0 ? Math.round(lengthSeconds * this.sampleRate) : -1;
    v.low = 0;
    v.band = 0;
    v.priority = priority;
    v.arp = arp;
    v.sample =
      instrument.osc === 'sample' && instrument.sampleId
        ? (this.samples.get(instrument.sampleId) ?? null)
        : null;
    v.samplePos = 0;
    return idx;
  }

  noteOff(channel: number): void {
    const v = this.voices[channel];
    if (v?.active && v.stage < 3) this.release(v);
  }

  stopAll(): void {
    for (const v of this.voices) {
      v.active = false;
      v.stage = 4;
    }
  }

  isPlaying(channel: number): boolean {
    return this.voices[channel]?.active ?? false;
  }

  /** Render `frames` stereo samples into out[0] (left) and out[1] (right). */
  render(outL: Float32Array, outR: Float32Array, frames: number): void {
    outL.fill(0, 0, frames);
    outR.fill(0, 0, frames);
    for (const v of this.voices) {
      if (!v.active || !v.instrument) continue;
      this.renderVoice(v, outL, outR, frames);
    }
    for (let i = 0; i < frames; i++) {
      outL[i] = softClip((outL[i] ?? 0) * this.master);
      outR[i] = softClip((outR[i] ?? 0) * this.master);
    }
  }

  private allocate(priority: number): number {
    let free = this.voices.findIndex((v) => !v.active);
    if (free !== -1) return free;
    // Steal: never a voice of higher priority than the incoming note when one of equal/lower exists.
    void priority;
    // steal: lowest priority, then oldest
    free = 0;
    let best = Infinity;
    this.voices.forEach((v, i) => {
      const score = v.priority * 1e9 - v.age;
      if (score < best) {
        best = score;
        free = i;
      }
    });
    return free;
  }

  private release(v: Voice): void {
    v.stage = 3;
    v.releaseFrom = v.env;
    v.age = 0;
  }

  private renderVoice(v: Voice, outL: Float32Array, outR: Float32Array, frames: number): void {
    const ins = v.instrument;
    if (!ins) return;
    const sr = this.sampleRate;
    const env = ins.env;
    const attackS = Math.max(1, env.attack * sr);
    const decayS = Math.max(1, env.decay * sr);
    const releaseS = Math.max(1, env.release * sr);
    const gain =
      ins.volume * v.velocity * (v.priority > 0 ? this.sfxGain : this.musicGain * this.musicLevel);
    const panL = Math.cos(((ins.pan + 1) / 2) * (Math.PI / 2));
    const panR = Math.sin(((ins.pan + 1) / 2) * (Math.PI / 2));
    const arpSteps = v.arp;
    const arpLen = arpSteps.length;
    const arpSamples = arpLen ? Math.max(1, Math.round(sr / Math.max(1, ins.arp.rate))) : 0;
    const vib = ins.vibrato;
    const vibDelay = vib.delay * sr;
    const glideStep = ins.glide > 0 ? 1 / Math.max(1, ins.glide * sr) : 0;
    const filterOn = ins.filter.type !== 'off';
    const q = 1 - Math.min(0.98, Math.max(0, ins.filter.resonance));
    // The Chamberlin filter's update is stable only while f² + 2fq < 4, i.e. f < √(q² + 4) − q.
    // Near Nyquist with little resonance a bright cutoff crosses that and the voice blows up into
    // silence or clicks, so the coefficient stops just short of the bound: below it nothing changes.
    const maxF = 0.98 * (Math.sqrt(q * q + 4) - q);

    for (let i = 0; i < frames; i++) {
      // envelope
      if (v.stage === 0) {
        v.env = Math.min(1, v.env + 1 / attackS);
        if (v.env >= 1) v.stage = 1;
      } else if (v.stage === 1) {
        v.env = Math.max(env.sustain, v.env - (1 - env.sustain) / decayS);
        if (v.env <= env.sustain) v.stage = 2;
      } else if (v.stage === 3) {
        v.env = Math.max(0, v.env - v.releaseFrom / releaseS);
        if (v.env <= 0.0005) {
          v.active = false;
          v.stage = 4;
          return;
        }
      }
      if (v.releaseAt >= 0 && v.stage < 3 && v.age >= v.releaseAt) this.release(v);

      // pitch: glide towards the note, then detune + arpeggio + vibrato on top
      if (glideStep > 0 && v.curFreq !== v.freq) {
        const delta = v.freq - v.curFreq;
        v.curFreq = Math.abs(delta) < 0.01 ? v.freq : v.curFreq + delta * glideStep;
      } else {
        v.curFreq = v.freq;
      }
      let semis = ins.detune;
      if (arpLen) semis += arpSteps[Math.floor(v.age / arpSamples) % arpLen] ?? 0;
      if (vib.depth > 0 && v.age > vibDelay)
        semis += Math.sin((v.age / sr) * vib.rate * Math.PI * 2) * vib.depth;
      const freq = semis === 0 ? v.curFreq : v.curFreq * Math.pow(2, semis / 12);

      // oscillator
      let s: number;
      switch (ins.osc) {
        case 'square':
          s = v.phase < ins.duty ? 1 : -1;
          break;
        case 'sine':
          s = Math.sin(v.phase * Math.PI * 2);
          break;
        case 'triangle':
          s = 1 - 4 * Math.abs(v.phase - 0.5);
          break;
        case 'saw':
          s = v.phase * 2 - 1;
          break;
        case 'noise': {
          // update the LFSR at the note frequency (pitched noise, chip style)
          if (v.phase < v.lastNoise) {
            v.noiseSeed ^= v.noiseSeed << 13;
            v.noiseSeed ^= v.noiseSeed >>> 17;
            v.noiseSeed ^= v.noiseSeed << 5;
          }
          v.lastNoise = v.phase;
          s = ((v.noiseSeed & 0xffff) / 0x8000 - 1) * 0.8;
          break;
        }
        case 'sample': {
          if (!v.sample) {
            s = 0;
            break;
          }
          const root = midiToFrequency(ins.sampleRoot ?? 60);
          const idx = Math.floor(v.samplePos);
          s = idx < v.sample.length ? (v.sample[idx] ?? 0) : 0;
          v.samplePos += freq / root;
          if (idx >= v.sample.length) {
            this.release(v);
          }
          break;
        }
      }
      v.phase += freq / sr;
      if (v.phase >= 1) v.phase -= Math.floor(v.phase);

      // filter (Chamberlin SVF)
      if (filterOn) {
        const cutoff = Math.min(sr * 0.45, ins.filter.cutoff * (1 + ins.filter.envAmount * v.env));
        const f = Math.min(maxF, 2 * Math.sin((Math.PI * cutoff) / sr));
        v.low += f * v.band;
        const high = s - v.low - q * v.band;
        v.band += f * high;
        s = ins.filter.type === 'lp' ? v.low : ins.filter.type === 'hp' ? high : v.band;
      }

      const out = s * v.env * gain;
      outL[i] = (outL[i] ?? 0) + out * panL;
      outR[i] = (outR[i] ?? 0) + out * panR;
      v.age++;
    }
  }
}

const softClip = (x: number): number => (x > 1 ? 1 : x < -1 ? -1 : x - (x * x * x) / 3);
