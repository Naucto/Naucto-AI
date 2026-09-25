// Copies the engine files this service shares verbatim with the Naucto frontend: the MIDI importer,
// the audio transcriber, and the chip synth that renders sounds exactly as the console plays them.
// Run from Naucto-AI with the Frontend checkout beside it: `npm run sync:shared`.
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const SHARED = ['midi.ts', 'transcribe.ts', 'model.ts', 'SynthCore.ts', 'Sequencer.ts', 'sample-codec.ts'];
const frontend = resolve(process.env.NAUCTO_FRONTEND ?? '../Frontend');
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  for (const file of SHARED) copyFileSync(resolve(frontend, 'packages/engine/src/sound', file), resolve('src/engine', file));
  console.log(`src/engine synchronised from ${frontend}: ${SHARED.join(', ')}`);
}
