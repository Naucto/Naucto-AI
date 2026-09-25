// Copies the files this service shares verbatim with the Naucto frontend engine.
// Run from Naucto-AI with the Frontend checkout beside it: `npm run sync:shared`.
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const frontend = resolve(process.env.NAUCTO_FRONTEND ?? '../Frontend');
copyFileSync(resolve(frontend, 'packages/engine/src/sound/midi.ts'), resolve('src/midi.ts'));
console.log('src/midi.ts synchronised from', frontend);
