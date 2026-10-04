import { readFileSync } from 'node:fs';
import assert from 'node:assert';
import { learnDecoder, puaRatio } from '../../src/pua-fix.js';
import { wordList } from '../../tools/words.mjs';
const words = wordList();
console.log('words', words.size);

// Synthetic: shift cipher + fi ligature
const enc = (s) => s.replace(/fi/g, '').replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xdfea));
const text = 'The first field of robotics is a relatively young discipline with highly ambitious goals. We find that the final figure shows the configuration of the robot arm and its joints. ' +
  'Students learn kinematics, dynamics, motion planning and control in this book, which covers many topics in detail.';
const d = learnDecoder([enc(text)], words);
assert(d, 'decoder learned');
console.log(d.decode(enc(text)));
assert.equal(d.decode(enc(text)), text);

// Real PDF text extracted from robotics-and-control.pdf
const p = process.argv[2];
if (p) {
  const pages = JSON.parse(readFileSync(p, 'utf8'));
  console.log('pua ratio', puaRatio(pages.join(' ')).toFixed(2));
  const t0 = Date.now();
  const dec = learnDecoder(pages, words);
  console.log('learned in', Date.now() - t0, 'ms', dec.stats, 'map size', dec.map.size);
  console.log([...dec.map].map(([k, v]) => k.toString(16) + '→' + JSON.stringify(v)).join(' '));
  console.log('\n' + dec.decode(pages[5]).slice(0, 700));
}
console.log('ALL OK');
