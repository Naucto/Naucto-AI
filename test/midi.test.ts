import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertMidi, readMidi } from '@naucto/engine/sound';

function midi(track: number[]): Uint8Array {
  return Uint8Array.from([77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, 77, 84, 114, 107, 0, 0, 0, track.length, ...track]);
}

test('converts a quarter note to four native steps', () => {
  const result = convertMidi(readMidi(midi([0, 0x90, 60, 100, 96, 0x80, 60, 0, 0, 255, 47, 0])), { prefix: 'theme', voices: 4 });
  assert.equal(result.patterns[0]?.notes[0]?.length, 4);
  assert.equal(result.report.droppedNotes, 0);
});
