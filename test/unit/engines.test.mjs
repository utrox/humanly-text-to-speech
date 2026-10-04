// Engine selection: helper app present / missing / crashing, and the Windows voice.
import assert from 'node:assert';

const L = {};
const ev = (name) => ({ addListener: (f) => (L[name] = f) });
let helperMode = 'ok'; // ok | missing | crash
const spoken = [];
globalThis.window = globalThis;
globalThis.atob = (b) => Buffer.from(b, 'base64').toString('binary');
globalThis.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
globalThis.speechSynthesis = {
  getVoices: () => [{ voiceURI: 'zira', name: 'Microsoft Zira', lang: 'en-US' }, { voiceURI: 'aria', name: 'Microsoft Aria Online (Natural)', lang: 'en-US' }],
  speak(u) { spoken.push([u.text, u.voice && u.voice.voiceURI, u.rate]); setTimeout(() => u.onstart && u.onstart(), 5); setTimeout(() => u.onend && u.onend(), 20); },
  cancel() {}, pause() {}, resume() {},
};
function nativePort() {
  const ml = [], dl = [];
  const emit = (m) => setTimeout(() => ml.forEach((f) => f(m)), 2);
  const port = {
    onMessage: { addListener: (f) => ml.push(f) },
    onDisconnect: { addListener: (f) => dl.push(f) },
    disconnect() {},
    postMessage(m) {
      if (m.type === 'hello') emit({ type: 'hello', version: '1.0' });
      if (m.type === 'load') emit({ type: 'ready', device: 'native-gpu' });
      if (m.type === 'synth') {
        if (helperMode === 'crash') { setTimeout(() => dl.forEach((f) => f({ error: { message: 'exited' } })), 5); return; }
        // 1.5 s of a 220 Hz tone with pauses, sent in two parts like the real helper.
        const n = 36000, pcm = Buffer.alloc(n * 2);
        for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round((i % 12000 < 8000 ? 0.4 : 0.001) * Math.sin(i * 2 * Math.PI * 220 / 24000) * 32767), i * 2);
        emit({ type: 'audio', id: m.id, sr: 24000, seq: 0, last: false, pcm: pcm.subarray(0, n).toString('base64'), ms: 50, device: 'native-gpu' });
        emit({ type: 'audio', id: m.id, sr: 24000, seq: 1, last: true, pcm: pcm.subarray(n).toString('base64'), ms: 50, device: 'native-gpu' });
      }
    },
  };
  if (helperMode === 'missing') setTimeout(() => dl.forEach((f) => f({ error: { message: 'No such native application humanly_tts' } })), 2);
  return port;
}
let stored = { engine: 'auto' };
globalThis.browser = {
  runtime: { getURL: (p) => 'moz-extension://x/' + p, onConnect: ev('connect'), onMessage: { addListener: (f) => (L.msgs = (L.msgs || []).concat(f)) }, connectNative: () => nativePort() },
  storage: { local: { get: async (d) => ({ ...d, ...stored }), set: async (o) => Object.assign(stored, o) }, onChanged: ev('changed') },
  tabs: {}, browserAction: { onClicked: ev('click') }, commands: { onCommand: ev('cmd') },
  contextMenus: { create() {}, onClicked: ev('menu') }, webRequest: { onHeadersReceived: ev('headers') },
};
globalThis.Worker = class { postMessage() {} terminate() {} };
let played = 0;
globalThis.AudioContext = class {
  state = 'running'; resume() {} suspend() {} get destination() { return {}; }
  createBuffer(c, len, sr) { return { copyToChannel(a) { played += a.length; } }; }
  createBufferSource() { const s = { connect() {}, start() { setTimeout(() => s.onended && s.onended(), 10); }, stop() {} }; return s; }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function mkPort() {
  const msgs = [], ls = {};
  L.connect({ name: 'reader', msgs, postMessage: (m) => msgs.push(m), onMessage: { addListener: (f) => (ls.msg = f) }, onDisconnect: { addListener() {} } });
  return { msgs, send: (m) => ls.msg(m), events: () => msgs.filter((m) => m.t !== 'model').map((m) => m.t + (m.id ?? '')), model: () => msgs.filter((m) => m.t === 'model').pop() };
}

// 1. Helper installed: natural voice comes from the helper, audio reassembled from parts.
let n = 0;
async function fresh() { await import('../../src/background.js?' + (++n)); await wait(5); }
await fresh();
let p = mkPort();
p.send({ t: 'play', id: 1, text: 'Hello from the helper.', voice: 'af_heart', speed: 1, ahead: [] });
await wait(150);
console.log('helper:', p.events(), p.model().engine, p.model().device, 'samples played', played);
assert.deepEqual(p.events(), ['waiting1', 'start1', 'end1']);
assert.equal(p.model().engine, 'helper');
assert.equal(p.model().device, 'native-gpu');
assert.equal(played, 36000, 'both parts decoded (2 bytes per sample)');

// 2. Helper missing: Windows voice, prefers a natural/online voice.
helperMode = 'missing'; spoken.length = 0;
await fresh();
p = mkPort();
p.send({ t: 'play', id: 2, text: 'Windows voice here.', voice: 'af_heart', speed: 1.3, ahead: ['Next.'] });
await wait(120);
console.log('missing helper:', p.events(), p.model().engine, p.model().helper, spoken);
assert.deepEqual(p.events(), ['waiting2', 'start2', 'end2']);
assert.equal(p.model().engine, 'system');
assert.equal(p.model().helper, 'missing');
assert.deepEqual(spoken[0], ['Windows voice here.', 'aria', 1.3]);
assert.equal(p.model().voices.length, 2);

// 3. Helper crashes mid-sentence: switch to the Windows voice and ask the page to retry.
helperMode = 'crash'; spoken.length = 0;
await fresh();
p = mkPort();
p.send({ t: 'play', id: 3, text: 'This will crash.', voice: 'af_heart', speed: 1, ahead: [] });
await wait(120);
console.log('crash:', p.events(), p.model().engine, p.model().msg);
assert(p.events().includes('retry'), 'page told to retry');
assert.equal(p.model().engine, 'system');
p.send({ t: 'play', id: 4, text: 'Retried.', voice: 'af_heart', speed: 1, ahead: [] });
await wait(80);
assert(p.events().includes('end4'), 'retry plays with the Windows voice');

// 4. Chosen voice is respected for the Windows engine.
stored = { engine: 'system', systemVoice: 'zira' }; spoken.length = 0;
await fresh();
p = mkPort();
p.send({ t: 'play', id: 5, text: 'Zira please.', voice: 'af_heart', speed: 1, ahead: [] });
await wait(80);
assert.equal(spoken[0][1], 'zira');
console.log('ALL OK');
process.exit(0);
