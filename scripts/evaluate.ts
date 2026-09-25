/**
 * Benchmarks the configured specialist endpoints on Naucto's own acceptance criteria.
 *
 *   NAUCTO_MIDI_PROVIDER=space NAUCTO_SPACE_URL=… HF_TOKEN=… npx tsx scripts/evaluate.ts midi 5
 *
 * Every call uses ZeroGPU quota or a paid provider's credits. The script prints, per prompt, whether the output survived
 * conversion into Naucto's formats and what was lost, so models are compared on usable assets
 * rather than on how their raw output looks.
 */
import { generate, providersFromEnv, configured, type Generation } from '../src/generation.js';

const PALETTE = ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'];
const PROMPTS: Record<Generation['kind'], string[]> = {
  sprite: ['a green slime enemy', 'a wooden treasure chest', 'a knight facing right', 'a grass ground tile', 'a red potion'],
  midi: ['an eight-bar cheerful chiptune exploration loop in C major', 'a tense boss battle theme, fast', 'a calm village theme in A minor', 'a short victory fanfare', 'a spooky cave ambience'],
  sample: ['a coin pickup', 'an 8-bit explosion', 'a door creaking open', 'a laser shot', 'footsteps on grass'],
};

const kind = (process.argv[2] ?? 'midi') as Generation['kind'];
const count = Math.min(Number(process.argv[3] ?? 3), PROMPTS[kind].length);
const providers = providersFromEnv(process.env);
if (!configured(providers, kind)) {
  console.error(`Configure NAUCTO_${kind.toUpperCase()}_PROVIDER and its credentials first (see .env.example).`);
  process.exit(1);
}

const rows: Record<string, unknown>[] = [];
for (const prompt of PROMPTS[kind].slice(0, count)) {
  const request: Generation = kind === 'sprite'
    ? { kind, prompt, width: 16, height: 16, palette: PALETTE }
    : kind === 'midi' ? { kind, prompt, prefix: 'eval', voices: 4 } : { kind, prompt, seconds: 1 };
  const started = Date.now();
  try {
    const { result } = await generate(request, AbortSignal.timeout(300000), providers);
    const r = result as { pixels: number[]; report: { importedNotes: number; sourceNotes: number; droppedNotes: number; peakVoices: number }; patterns: unknown[]; bytes: number };
    const metrics = kind === 'sprite'
      ? { opaque: r.pixels.filter((p: number) => p).length, colours: new Set(r.pixels).size }
      : kind === 'midi'
        ? { imported: r.report.importedNotes, source: r.report.sourceNotes, dropped: r.report.droppedNotes, patterns: r.patterns.length, peakVoices: r.report.peakVoices }
        : { bytes: r.bytes };
    rows.push({ prompt, ok: true, seconds: (Date.now() - started) / 1000, ...metrics });
  } catch (error) {
    rows.push({ prompt, ok: false, seconds: (Date.now() - started) / 1000, error: error instanceof Error ? error.message : String(error) });
  }
}
console.table(rows);
console.log(`${providers.kinds[kind]?.provider}: ${rows.filter(r => r.ok).length}/${rows.length} usable after conversion.`);
