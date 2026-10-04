import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { checkSpeech } from '../../src/audio-check.js';

// Real speech clips (espeak-ng), stored as base64 int16 to keep the repo small.
const fixture = new URL('../fixtures/speech-clips.json', import.meta.url);
const { sr, clips: raw } = JSON.parse(readFileSync(fixture, 'utf8'));
const clips = Object.fromEntries(Object.entries(raw).map(([k, b64]) => {
  const b = Buffer.from(b64, 'base64');
  const i16 = new Int16Array(b.buffer, b.byteOffset, b.length / 2);
  return [k, Float32Array.from(i16, (v) => v / 32768)];
}));
for (const [name, a] of Object.entries(clips)) {
  // Pad with the short silences Kokoro adds at the ends.
  const x = new Float32Array(a.length + sr * 0.2); x.set(a, sr * 0.1);
  const r = checkSpeech(x, sr);
  console.log('speech', name, r);
  assert(r.ok, 'real speech accepted: ' + name);
}
const len = sr * 2;
const white = Float32Array.from({ length: len }, () => (Math.random() * 2 - 1) * 0.5);
const clipped = Float32Array.from({ length: len }, () => (Math.random() < 0.5 ? -1 : 1));
const crackle = Float32Array.from({ length: len }, (_, i) => (Math.random() * 2 - 1) * (0.6 + 0.4 * Math.sin(i / 300)));
const hum = Float32Array.from({ length: len }, (_, i) => 0.5 * Math.sin(i * 2 * Math.PI * 3000 / sr) + 0.3 * (Math.random() - 0.5));
for (const [name, x] of Object.entries({ white, clipped, crackle, hum })) {
  const r = checkSpeech(x, sr);
  console.log('noise', name, r);
  assert(!r.ok, 'noise rejected: ' + name);
}
assert(!checkSpeech(new Float32Array(len), sr).ok, 'silence rejected');
console.log('ALL OK');
