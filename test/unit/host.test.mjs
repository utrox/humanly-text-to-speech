// Talks to the helper exactly like Firefox does (length-prefixed JSON over stdin/stdout).
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { checkSpeech } from '../../src/audio-check.js';

// Usage: node test/unit/host.test.mjs [path/to/humanly_tts_host.py] [python]
// The model files (kokoro-v1.0.onnx, voices-v1.0.bin) must sit next to the host script.
const hostPath = process.argv[2] || new URL('../../helper/humanly_tts_host.py', import.meta.url).pathname;
const host = spawn(process.argv[3] || (process.platform === 'win32' ? 'python' : 'python3'), [hostPath], { stdio: ['pipe', 'pipe', 'inherit'] });
let buf = Buffer.alloc(0);
const waiters = [];
const inbox = [];
host.stdout.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    const m = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
    buf = buf.subarray(4 + n);
    assert(n < 1024 * 1024, 'message under Firefox 1 MB limit');
    inbox.push(m); waiters.splice(0).forEach((w) => w());
  }
});
const send = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); host.stdin.write(Buffer.concat([h, b])); };
async function next(pred) {
  for (;;) {
    const i = inbox.findIndex(pred);
    if (i >= 0) return inbox.splice(i, 1)[0];
    await new Promise((r) => waiters.push(r));
  }
}

send({ type: 'hello' });
console.log(await next((m) => m.type === 'hello'));
send({ type: 'load' });
console.log(await next((m) => m.type === 'ready'));
const long = 'Photosynthesis is a system of biological processes by which photosynthetic organisms, such as most plants, algae, and cyanobacteria, convert light energy, typically from sunlight, into the chemical energy necessary to fuel their metabolism. '.repeat(2).trim();
for (const [id, text, voice] of [[1, 'Hello from the helper.', 'af_heart'], [2, long, 'bm_george']]) {
  send({ type: 'synth', id, text, voice, speed: 1 });
  const parts = [];
  for (;;) { const m = await next((x) => x.type === 'audio' && x.id === id || x.type === 'error'); assert.equal(m.type, 'audio', m.msg); parts.push(m); if (m.last) break; }
  const pcm = Buffer.concat(parts.map((p) => Buffer.from(p.pcm, 'base64')));
  const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
  const f = Float32Array.from(i16, (v) => v / 32768);
  const c = checkSpeech(f, parts[0].sr);
  console.log(`id ${id}: ${parts.length} part(s), ${(f.length / parts[0].sr).toFixed(1)} s audio in ${(parts[0].ms / 1000).toFixed(2)} s on ${parts[0].device}`, c);
  assert(c.ok, 'speech');
}
send({ type: 'synth', id: 3, text: 'x', voice: 'zz_nobody', speed: 1 });
const err = await next((m) => m.type === 'error' || (m.type === 'audio' && m.id === 3));
console.log('bad voice ->', err.type, err.msg);
assert.equal(err.type, 'error');
host.stdin.end();
console.log('ALL OK');
