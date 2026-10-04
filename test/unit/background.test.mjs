import assert from 'node:assert';

// ---- fakes for the Firefox background environment ----
const L = {};
const ev = (name) => ({ addListener: (f) => (L[name] = f) });
globalThis.browser = {
  runtime: { getURL: (p) => 'moz-extension://x/' + p, onConnect: ev('connect'), onMessage: ev('message') },
  storage: { local: { get: async (d) => ({ ...d, engine: 'browser' }) }, onChanged: ev('changed') },
  tabs: {}, browserAction: { onClicked: ev('click') }, commands: { onCommand: ev('cmd') },
  contextMenus: { create() {}, onClicked: ev('menu') },
  webRequest: { onHeadersReceived: ev('headers') },
};
const synthLog = [];
let workerCount = 0;
let concurrent = 0, maxConcurrent = 0;
globalThis.Worker = class {
  constructor() { workerCount++; }
  postMessage(m) {
    if (m.type === 'load') {
      this.device = globalThis.__gpu && m.prefer !== 'cpu' ? 'webgpu' : 'wasm';
      globalThis.__loads = (globalThis.__loads || []).concat(m.prefer + '->' + this.device);
      setTimeout(() => this.onmessage({ data: { type: 'ready', device: this.device } }), 5);
      return;
    }
    if (m.type !== 'synth') return;
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    setTimeout(() => concurrent--, 20);
    synthLog.push(m.text);
    const noisy = this.device === 'webgpu';
    setTimeout(() => this.onmessage({ data: { type: 'audio', id: m.id, audio: new Float32Array(10), sr: 24000, device: this.device, check: { ok: !noisy, reason: noisy ? 'sounds like noise' : '' } } }), 20);
  }
  terminate() {}
};
globalThis.AudioContext = class {
  state = 'running';
  resume() { this.state = 'running'; } suspend() { this.state = 'suspended'; }
  get destination() { return {}; }
  createBuffer() { return { copyToChannel() {} }; }
  createBufferSource() {
    const s = { connect() {}, start() { s.t = setTimeout(() => s.onended && s.onended(), 30); }, stop() { clearTimeout(s.t); } };
    return s;
  }
};

Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 2 }, configurable: true });
globalThis.window = globalThis;
const { splitLong } = await import('../../src/background.js');
await new Promise((r) => setTimeout(r, 5));

// ---- splitLong ----
const long = 'This is a very long sentence, ' .repeat(20) + 'and it ends here.';
const parts = splitLong(long);
console.log(parts);
assert(parts.length > 1 && parts.every((p) => p.length <= 150), 'split into clause-sized chunks');
assert.equal(parts.join(' ').replace(/\s+/g, ' '), long.replace(/\s+/g, ' '), 'no text lost');
assert.deepEqual(splitLong('Short.'), ['Short.']);

// ---- port protocol ----
function mkPort() {
  const msgs = [];
  const ls = {};
  const port = {
    name: 'reader', msgs,
    postMessage: (m) => msgs.push(m),
    onMessage: { addListener: (f) => (ls.msg = f) },
    onDisconnect: { addListener: (f) => (ls.disc = f) },
    send: (m) => ls.msg(m),
  };
  L.connect(port);
  return port;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const a = mkPort();
a.send({ t: 'play', id: 1, text: 'One.', voice: 'af_heart', speed: 1, ahead: ['Two.', 'Three.'] });
await wait(200);
const seq = a.msgs.filter((m) => m.t !== 'model').map((m) => m.t + m.id);
console.log('sequence:', seq, 'synth order:', synthLog);
assert.deepEqual(seq, ['waiting1', 'start1', 'end1']);
assert.deepEqual(synthLog, ['One.', 'Two.', 'Three.'], 'prefetched ahead in order');

// Next sentence is already cached -> no waiting, starts immediately.
a.msgs.length = 0;
a.send({ t: 'play', id: 2, text: 'Two.', voice: 'af_heart', speed: 1, ahead: ['Three.'] });
await wait(80);
assert.deepEqual(a.msgs.map((m) => m.t + m.id), ['start2', 'end2'], 'cached sentence plays without waiting');

// Jumping elsewhere cancels the previous sentence (no stale "end").
a.msgs.length = 0; synthLog.length = 0;
a.send({ t: 'play', id: 3, text: 'Far away one.', voice: 'af_heart', speed: 1, ahead: ['Far two.', 'Far three.', 'Far four.'] });
await wait(5);
a.send({ t: 'play', id: 4, text: 'Elsewhere.', voice: 'af_heart', speed: 1, ahead: [] });
await wait(150);
const ids = a.msgs.filter((m) => m.t === 'end').map((m) => m.id);
console.log('after jump:', a.msgs.map((m) => m.t + m.id), 'synth:', synthLog);
assert.deepEqual(ids, [4], 'only the new sentence ends');
assert(!synthLog.includes('Far four.'), 'stale prefetch was dropped');

// A second tab taking over tells the first one it stopped.
const b = mkPort();
a.msgs.length = 0;
b.send({ t: 'play', id: 1, text: 'Other tab.', voice: 'af_heart', speed: 1, ahead: [] });
await wait(10);
assert(a.msgs.some((m) => m.t === 'stopped'), 'first tab notified');

// PDF interception
const r = L.headers({ method: 'GET', statusCode: 200, url: 'https://x.org/a.pdf', responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }] });
assert(r.redirectUrl.startsWith('moz-extension://x/viewer.html?file=https%3A'), 'pdf redirected');
const r2 = L.headers({ method: 'GET', statusCode: 200, url: 'https://x.org/a.pdf', responseHeaders: [{ name: 'Content-Type', value: 'application/pdf' }, { name: 'Content-Disposition', value: 'attachment; filename=a.pdf' }] });
assert.equal(r2, undefined, 'downloads left alone');
// Processor pool: with 8 cores, 4 workers synthesize side by side.
Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 8 }, configurable: true });
workerCount = 0; maxConcurrent = 0;
await import('../../src/background.js?pool');
await new Promise((r) => setTimeout(r, 5));
const c = mkPort();
c.send({ t: 'play', id: 1, text: 'Alpha one.', voice: 'af_heart', speed: 1, ahead: ['Beta two.', 'Gamma three.', 'Delta four.'] });
await wait(250);
console.log('workers:', workerCount, 'max parallel jobs:', maxConcurrent, c.msgs.filter((m) => m.t !== 'model').map((m) => m.t + m.id));
assert.equal(workerCount, 4, 'pool of 4 workers');
assert(maxConcurrent >= 3, 'sentences synthesized in parallel');
assert.deepEqual(c.msgs.filter((m) => m.t !== 'model').map((m) => m.t + m.id), ['waiting1', 'start1', 'end1']);
const modelMsg = c.msgs.filter((m) => m.t === 'model').pop();
assert.equal(modelMsg.device, 'wasm');
assert.equal(modelMsg.workers, 4);
// Graphics card returns static -> engine moves to the processor and playback continues.
Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 2 }, configurable: true });
globalThis.__gpu = true; globalThis.__loads = [];
const stored = {};
globalThis.browser.storage.local.set = async (o) => Object.assign(stored, o);
await import('../../src/background.js?gpu');
await new Promise((r) => setTimeout(r, 5));
const g = mkPort();
g.send({ t: 'play', id: 7, text: 'Static test.', voice: 'af_heart', speed: 1, ahead: ['Next one.'] });
await wait(300);
const evs = g.msgs.filter((m) => m.t !== 'model').map((m) => m.t + m.id);
console.log('gpu fallback:', globalThis.__loads, evs, 'stored', stored, 'note:', g.msgs.filter((m) => m.t === 'model').pop().msg);
assert.deepEqual(globalThis.__loads, ['auto->webgpu', 'cpu->wasm']);
assert.deepEqual(evs, ['waiting7', 'start7', 'end7'], 'sentence still plays after the switch');
assert.equal(stored.useGpu, false, 'choice remembered');
console.log('ALL OK');
process.exit(0);
