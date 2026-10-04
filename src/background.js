// Background page: hosts the TTS engine (in a worker), plays audio, opens PDFs in the
// reader's viewer, and injects the reader into pages.
import { DEFAULTS, getSettings } from './settings.js';
import { checkSpeech } from './audio-check.js';

const VIEWER = browser.runtime.getURL('viewer.html');
const IDLE_UNLOAD_MS = 15 * 60 * 1000;
const MAX_CHUNK = 280;   // graphics card: whole sentences
const CPU_CHUNK = 110;   // in-browser processor voice: clause-sized pieces
const HELPER_CHUNK = 160; // helper app on the processor

let settings = { ...DEFAULTS };
getSettings().then((s) => { settings = s; });
browser.storage.onChanged.addListener((changes) => {
  for (const [k, v] of Object.entries(changes)) settings[k] = v.newValue;
  if ((('useGpu' in changes && !switchingDevice) || 'engine' in changes) && (primary || engine)) {
    // Restart on the newly chosen engine or hardware, then re-read the current sentence.
    const port = activePort, wasPlaying = playing;
    stop(activePort);
    shutdownEngine();
    if ('engine' in changes) helperState = 'unknown';
    setModel({ state: 'idle', loaded: 0, total: 0, msg: '' });
    ensureEngine().then(() => { if (port && wasPlaying) port.postMessage({ t: 'retry' }); });
  }
});

/* ------------------------------------------------------------------ */
/* Engine: worker pool + synthesis queue + audio cache                 */
/* ------------------------------------------------------------------ */
// Firefox doesn't let extensions use multi-threaded WebAssembly, so on the processor we
// run several single-threaded workers side by side. On a graphics card one is enough.

const CPU_POOL = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
let workers = [];          // {w, state:'loading'|'ready'|'busy', key, id}
let primary = null;
let device = null;         // 'webgpu' | 'wasm' once known
let engine = null;         // 'helper' | 'system' | 'browser' once chosen
let engineStarting = null;
let helperState = 'unknown'; // unknown | installed | missing
let model = { state: 'idle', loaded: 0, total: 0, msg: '', device: null, workers: 0 };
const cache = new Map();   // key -> entry {key,text,voice,speed,promise,resolve,reject,status,result}
let queue = [];            // keys waiting to be synthesized, in order
let reqId = 0;
let idleTimer = null;

function keyOf(text, voice, speed) { return voice + '|' + speed + '|' + text; }

function setModel(patch) {
  model = {
    ...model, ...patch, device, engine, helper: helperState,
    workers: workers.filter((x) => x.state !== 'loading').length,
    voices: engine === 'system' ? systemVoiceList() : null,
  };
  for (const p of ports) p.postMessage({ t: 'model', ...model });
}

function spawn(prefer) {
  const wk = { w: new Worker(browser.runtime.getURL('tts-worker.js'), { type: 'module' }), state: 'loading', key: null, id: 0 };
  wk.w.onmessage = (ev) => onWorkerMessage(wk, ev.data);
  wk.w.onerror = (e) => onWorkerMessage(wk, { type: 'error', id: null, msg: 'The voice engine crashed: ' + (e.message || 'unknown error') });
  wk.w.postMessage({ type: 'load', prefer });
  workers.push(wk);
  return wk;
}

/* ---- Helper app (native messaging): same interface as a Worker ---- */
const HELPER = 'humanly_tts';
class HelperWorker {
  constructor() {
    this.onmessage = null;
    this.parts = new Map();
    this.helloWaiters = [];
    this.alive = true;
    this.port = browser.runtime.connectNative(HELPER);
    this.port.onMessage.addListener((m) => this.receive(m));
    this.port.onDisconnect.addListener((p) => {
      this.alive = false;
      const why = (p && p.error && p.error.message) || 'the helper app closed';
      this.helloWaiters.splice(0).forEach((f) => f(false));
      if (this.onmessage) this.onmessage({ data: { type: 'error', id: null, msg: 'The helper app stopped: ' + why } });
    });
  }
  hello(timeoutMs) {
    return new Promise((resolve) => {
      if (!this.alive) return resolve(false);
      this.helloWaiters.push(resolve);
      setTimeout(() => resolve(false), timeoutMs);
      try { this.port.postMessage({ type: 'hello' }); } catch (_) { resolve(false); }
    });
  }
  postMessage(m) {
    if (!this.alive) return;
    if (m.type === 'load') this.port.postMessage({ type: 'load' });
    else if (m.type === 'synth') this.port.postMessage({ type: 'synth', id: m.id, text: m.text, voice: m.voice, speed: m.speed });
  }
  terminate() { this.alive = false; try { this.port.disconnect(); } catch (_) {} }
  receive(m) {
    if (m.type === 'hello') { this.helloWaiters.splice(0).forEach((f) => f(true)); return; }
    if (m.type === 'audio') {
      const list = this.parts.get(m.id) || [];
      list.push(m.pcm);
      if (!m.last) { this.parts.set(m.id, list); return; }
      this.parts.delete(m.id);
      const bytes = list.map((b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      const total = bytes.reduce((n, b) => n + b.length, 0);
      const all = new Uint8Array(total);
      let off = 0;
      for (const b of bytes) { all.set(b, off); off += b.length; }
      const i16 = new Int16Array(all.buffer, 0, total >> 1);
      const audio = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) audio[i] = i16[i] / 32768;
      m = { type: 'audio', id: m.id, audio, sr: m.sr, ms: m.ms, device: m.device, check: checkSpeech(audio, m.sr) };
    }
    if (this.onmessage) this.onmessage({ data: m });
  }
}

/** Starts the helper if it's installed; resolves to a connected HelperWorker or null. */
async function probeHelper() {
  if (helperState === 'missing') return null;
  let hw;
  try { hw = new HelperWorker(); } catch (_) { helperState = 'missing'; return null; }
  // First start can be slow (Python loading its libraries), so allow some time.
  const ok = await hw.hello(30000);
  if (!ok) { hw.terminate(); helperState = 'missing'; return null; }
  helperState = 'installed';
  return hw;
}

function attach(w) {
  const wk = { w, state: 'loading', key: null, id: 0 };
  w.onmessage = (ev) => onWorkerMessage(wk, ev.data);
  workers.push(wk);
  return wk;
}

function ensureEngine() {
  touch();
  if (primary || engine === 'system') return Promise.resolve();
  if (engineStarting) return engineStarting;
  engineStarting = (async () => {
    const pref = settings.engine || 'auto';
    let helper = null;
    if (pref === 'auto' || pref === 'helper') {
      setModel({ state: 'loading', loaded: 0, total: 0, msg: '' });
      helper = await probeHelper();
    }
    if (helper) {
      engine = 'helper';
      primary = attach(helper);
      helper.postMessage({ type: 'load' });
      setModel({ state: 'loading', msg: '' });
    } else if (pref === 'browser') {
      engine = 'browser';
      primary = spawn(settings.useGpu === false ? 'cpu' : 'auto');
      setModel({ state: 'downloading', loaded: 0, total: 0, msg: '' });
    } else {
      engine = 'system';
      device = 'system';
      const note = pref === 'helper' ? 'The helper app isn\'t installed, so the Windows voice is used. Run install.bat from the helper folder.' : '';
      setModel({ state: 'ready', loaded: 0, total: 0, msg: note });
    }
  })().finally(() => { engineStarting = null; });
  return engineStarting;
}

function shutdownEngine(reason) {
  for (const wk of workers) wk.w.terminate();
  workers = [];
  primary = null;
  device = null;
  engine = null;
  if (window.speechSynthesis) speechSynthesis.cancel();
  for (const [k, e] of cache) if (e.status !== 'done') { cache.delete(k); e.reject(new Error(reason || 'cancelled')); }
  queue = [];
}

let switchingDevice = false;
/** Restarts the engine on the processor, keeping all unfinished work queued in order. */
function switchToCpu(note) {
  const pending = [...cache.values()].filter((e) => e.status !== 'done');
  pending.sort((a, b) => (b.status === 'running') - (a.status === 'running'));
  for (const wk of workers) wk.w.terminate();
  workers = [];
  device = null;
  for (const e of pending) e.status = 'queued';
  const keep = new Set(queue);
  queue = [...pending.filter((e) => e.status === 'queued' && !keep.has(e.key)).map((e) => e.key), ...queue];
  primary = spawn('cpu');
  setModel({ state: 'downloading', loaded: 0, total: 0, msg: note });
  // Remember the choice; the user can turn the graphics card back on in the menu.
  switchingDevice = true;
  settings.useGpu = false;
  browser.storage.local.set({ useGpu: false }).finally(() => { switchingDevice = false; });
}

function failAll(msg) {
  shutdownEngine(msg);
  setModel({ state: 'error', loaded: 0, total: 0, msg });
}

function finishJob(wk, m) {
  const key = wk.key;
  wk.key = null;
  if (wk.state === 'busy') wk.state = 'ready';
  const e = key && cache.get(key);
  if (!e || m.id !== wk.id) return;
  if (m.type === 'audio') {
    e.status = 'done';
    e.result = { audio: m.audio, sr: m.sr };
    e.resolve(e.result);
    const secs = m.audio.length / m.sr;
    console.debug(`Humanly TTS: ${secs.toFixed(1)} s of speech in ${(m.ms / 1000).toFixed(1)} s on ${device} (${e.text.length} chars)`);
  } else {
    cache.delete(key);
    e.reject(new Error(m.msg));
  }
}

function onWorkerMessage(wk, m) {
  if (m.type === 'progress') {
    if (wk === primary) setModel({ state: 'downloading', loaded: m.loaded, total: m.total });
  } else if (m.type === 'note') {
    console.warn('Humanly TTS:', m.msg);
    setModel({ msg: m.msg });
    if (m.gpuFailed) {
      switchingDevice = true;
      settings.useGpu = false;
      browser.storage.local.set({ useGpu: false }).finally(() => { switchingDevice = false; });
    }
  } else if (m.type === 'ready') {
    wk.state = 'ready';
    if (wk === primary) {
      device = m.device;
      // On the processor, add more workers (they load the cached model, no new download).
      if (device === 'wasm') for (let i = 1; i < CPU_POOL; i++) spawn('cpu');
    }
    setModel({ state: 'ready', loaded: 0, total: 0 });
    pump();
  } else if (m.type === 'audio' && m.check && !m.check.ok && m.device === 'webgpu') {
    // The graphics card is returning noise instead of speech: move to the processor.
    console.warn('Humanly TTS: graphics card output rejected', m.check);
    switchToCpu('Your graphics card produced noise instead of speech in Firefox, so the voice now runs on your processor.');
  } else if (m.type === 'audio' || (m.type === 'error' && m.id != null)) {
    if (m.type === 'audio' && m.check && !m.check.ok) console.warn('Humanly TTS: audio sounds unusual', m.check);
    finishJob(wk, m);
    trimCache();
    pump();
  } else if (m.type === 'error') {
    if (engine === 'helper') {
      // Keep reading with the Windows voice rather than stopping.
      console.warn('Humanly TTS:', m.msg);
      const port = activePort;
      shutdownEngine(); // pending work is cancelled quietly; the page re-requests it
      engine = 'system';
      device = 'system';
      setModel({ state: 'ready', msg: m.msg + ' Switched to the Windows voice.' });
      if (port) port.postMessage({ t: 'retry' });
      return;
    }
    if (wk === primary || workers.length <= 1) { failAll(m.msg); return; }
    // An extra worker failed (for example, out of memory): carry on without it.
    wk.w.terminate();
    workers = workers.filter((x) => x !== wk);
    if (wk.key) {
      const e = cache.get(wk.key);
      if (e) { e.status = 'queued'; queue.unshift(wk.key); }
    }
    setModel({});
    pump();
  }
}

function makeEntry(text, voice, speed) {
  const key = keyOf(text, voice, speed);
  let e = cache.get(key);
  if (e) { cache.delete(key); cache.set(key, e); return e; } // refresh LRU position
  e = { key, text, voice, speed, status: 'queued' };
  e.promise = new Promise((res, rej) => { e.resolve = res; e.reject = rej; });
  e.promise.catch(() => {});
  cache.set(key, e);
  return e;
}

/** Replaces the synthesis queue with `items` (in priority order). Returns their entries. */
function schedule(items) {
  ensureEngine();
  const entries = items.map((it) => makeEntry(it.text, it.voice, it.speed));
  const wanted = new Set(entries.map((e) => e.key));
  for (const k of queue) {
    if (!wanted.has(k)) {
      const e = cache.get(k);
      if (e && e.status === 'queued') { cache.delete(k); e.reject(new Error('cancelled')); }
    }
  }
  queue = entries.filter((e) => e.status === 'queued').map((e) => e.key);
  pump();
  return entries;
}

function pump() {
  for (const wk of workers) {
    if (wk.state !== 'ready') continue;
    let e = null;
    while (queue.length && !e) {
      const k = queue.shift();
      const c = cache.get(k);
      if (c && c.status === 'queued') e = c;
    }
    if (!e) return;
    e.status = 'running';
    wk.state = 'busy';
    wk.key = e.key;
    wk.id = ++reqId;
    wk.w.postMessage({ type: 'synth', id: wk.id, text: e.text, voice: e.voice, speed: e.speed });
  }
}

function trimCache() {
  const MAX = 80;
  if (cache.size <= MAX) return;
  for (const [k, e] of cache) {
    if (cache.size <= MAX) break;
    if (e.status === 'done') cache.delete(k);
  }
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (primary && !queue.length && !playing && workers.every((w) => w.state !== 'busy')) {
      shutdownEngine();
      setModel({ state: 'idle', loaded: 0, total: 0, msg: '' });
    }
  }, IDLE_UNLOAD_MS);
}

/**
 * Splits text into pieces the voice can render quickly. On the processor, pieces are
 * clause-sized so the first audio arrives sooner and workers can share a long sentence.
 */
function chunkMax() {
  if (device === 'webgpu' || device === 'native-gpu') return MAX_CHUNK;
  if (engine === 'helper') return HELPER_CHUNK;
  return CPU_CHUNK;
}

export function splitLong(text, max = chunkMax()) {
  if (text.length <= max) return [text];
  const min = Math.min(40, Math.floor(max / 3));
  const out = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = -1;
    for (const sep of [', ', '; ', ': ', ' – ', ' — ', ' (', ') ']) {
      const i = window.lastIndexOf(sep);
      if (i >= min && i > cut) cut = sep.startsWith(' ') ? i : i + 1;
    }
    if (cut < min) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    // Don't leave a tiny tail on its own.
    const last = out[out.length - 1];
    if (rest.length < 20 && last && last.length + rest.length < max + 20) out[out.length - 1] += ' ' + rest; else out.push(rest);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

let ctx = null;
let activePort = null;
let playSeq = 0;
let current = null; // {src, done}
let playing = false;

function audioCtx() {
  if (!ctx) ctx = new AudioContext();
  return ctx;
}

function stopAudio() {
  if (current) {
    current.src.onended = null;
    try { current.src.stop(); } catch (_) {}
    current.done();
    current = null;
  }
}

function playBuffer({ audio, sr }) {
  const c = audioCtx();
  const buf = c.createBuffer(1, audio.length, sr);
  buf.copyToChannel(audio, 0);
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  return new Promise((resolve) => {
    current = { src, done: resolve };
    src.onended = () => { if (current && current.src === src) current = null; resolve(); };
    src.start();
  });
}

async function play(port, msg) {
  if (activePort && activePort !== port) {
    try { activePort.postMessage({ t: 'stopped' }); } catch (_) {}
  }
  activePort = port;
  const seq = ++playSeq;
  stopAudio();
  playing = true;
  touch();
  if (window.speechSynthesis) speechSynthesis.cancel();

  await ensureEngine();
  if (seq !== playSeq) return;
  if (engine === 'system') return playSystem(port, msg, seq);

  const voice = msg.voice || settings.voice;
  const speed = msg.speed || settings.speed;
  const chunks = splitLong(msg.text);
  const ahead = (msg.ahead || []).flatMap((t) => splitLong(t));
  const items = [...chunks, ...ahead].map((text) => ({ text, voice, speed }));
  const entries = schedule(items).slice(0, chunks.length);

  const c = audioCtx();
  if (c.state === 'suspended') c.resume();

  let started = false;
  for (const e of entries) {
    if (e.status !== 'done') port.postMessage({ t: 'waiting', id: msg.id });
    let res;
    try {
      res = await e.promise;
    } catch (err) {
      if (seq !== playSeq) return;
      playing = false;
      if (err.message !== 'cancelled') port.postMessage({ t: 'error', id: msg.id, msg: err.message });
      return;
    }
    if (seq !== playSeq) return;
    if (!started) { started = true; port.postMessage({ t: 'start', id: msg.id }); }
    await playBuffer(res);
    if (seq !== playSeq) return;
  }
  playing = false;
  port.postMessage({ t: 'end', id: msg.id });
}

/* ---- Windows (system) voices through the Web Speech API ---- */
function systemVoiceList() {
  if (!window.speechSynthesis) return [];
  return speechSynthesis.getVoices()
    .filter((v) => /^en/i.test(v.lang))
    .map((v) => ({ id: v.voiceURI, name: v.name.replace(/^Microsoft /, '') + ' (' + v.lang + ')' }));
}
function pickSystemVoice() {
  const vs = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  const en = vs.filter((v) => /^en/i.test(v.lang));
  return vs.find((v) => v.voiceURI === settings.systemVoice) ||
    en.find((v) => /natural|online|neural/i.test(v.name)) ||
    en.find((v) => /^en-US/i.test(v.lang)) || en[0] || vs[0] || null;
}
if (window.speechSynthesis) {
  speechSynthesis.onvoiceschanged = () => { if (engine === 'system') setModel({}); };
}

function playSystem(port, msg, seq) {
  if (!window.speechSynthesis) {
    playing = false;
    port.postMessage({ t: 'error', id: msg.id, msg: 'This copy of Firefox has no system voices.' });
    return;
  }
  const u = new SpeechSynthesisUtterance(msg.text);
  const v = pickSystemVoice();
  if (v) { u.voice = v; u.lang = v.lang; }
  u.rate = Math.max(0.5, Math.min(2, msg.speed || settings.speed || 1));
  u.onstart = () => { if (seq === playSeq) port.postMessage({ t: 'start', id: msg.id }); };
  u.onend = () => { if (seq !== playSeq) return; playing = false; port.postMessage({ t: 'end', id: msg.id }); };
  u.onerror = (e) => {
    if (seq !== playSeq || e.error === 'interrupted' || e.error === 'canceled') return;
    playing = false;
    port.postMessage({ t: 'error', id: msg.id, msg: 'The Windows voice failed (' + e.error + ').' });
  };
  port.postMessage({ t: 'waiting', id: msg.id });
  speechSynthesis.speak(u);
}

function stop(port) {
  if (port && port !== activePort) return;
  ++playSeq;
  if (window.speechSynthesis) speechSynthesis.cancel();
  stopAudio();
  playing = false;
  for (const k of queue) { const e = cache.get(k); if (e && e.status === 'queued') { cache.delete(k); e.reject(new Error('cancelled')); } }
  queue = [];
  if (ctx && ctx.state === 'suspended') ctx.resume();
}

/* ------------------------------------------------------------------ */
/* Ports from pages / the PDF viewer                                   */
/* ------------------------------------------------------------------ */

const ports = new Set();

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== 'reader') return;
  ports.add(port);
  port.postMessage({ t: 'model', ...model });
  port.onMessage.addListener((msg) => {
    switch (msg.t) {
      case 'warmup': ensureEngine(); break;
      case 'play': play(port, msg); break;
      case 'pause':
        if (port !== activePort) break;
        if (engine === 'system' && window.speechSynthesis) speechSynthesis.pause();
        else if (ctx) ctx.suspend();
        break;
      case 'resume':
        if (port !== activePort) break;
        if (engine === 'system' && window.speechSynthesis) speechSynthesis.resume();
        else if (ctx) ctx.resume();
        break;
      case 'stop': stop(port); break;
    }
  });
  port.onDisconnect.addListener(() => {
    ports.delete(port);
    if (port === activePort) { stop(port); activePort = null; }
  });
});

/* ------------------------------------------------------------------ */
/* Toolbar button, context menu, PDF interception                      */
/* ------------------------------------------------------------------ */

const isPdfUrl = (u) => /^(https?|file):.*\.pdf([?#].*)?$/i.test(u || '');
const viewerFor = (url) => VIEWER + (url ? '?file=' + encodeURIComponent(url) : '');

async function injectReader(tabId) {
  await browser.tabs.insertCSS(tabId, { file: 'page.css' });
  await browser.tabs.executeScript(tabId, { file: 'content.js' });
}

async function toggleIn(tab, extra) {
  if (tab.url && tab.url.startsWith(VIEWER)) return; // the viewer has its own player
  if (isPdfUrl(tab.url)) {
    browser.tabs.update(tab.id, { url: viewerFor(tab.url) });
    return;
  }
  try {
    await injectReader(tab.id);
    await browser.tabs.sendMessage(tab.id, { t: extra || 'toggle' });
  } catch (e) {
    // Privileged pages (about:, addons.mozilla.org, Firefox's own PDF viewer) can't be scripted.
    console.warn('Humanly TTS: cannot read this page', e);
    browser.browserAction.setBadgeText({ tabId: tab.id, text: '✕' });
    browser.browserAction.setBadgeBackgroundColor({ tabId: tab.id, color: '#a33' });
    browser.browserAction.setTitle({ tabId: tab.id, title: 'Firefox does not allow reading this page' });
  }
}

browser.browserAction.onClicked.addListener((tab) => toggleIn(tab));

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-reader') return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) toggleIn(tab);
});

browser.contextMenus.create({ id: 'read-from-here', title: 'Read aloud from here', contexts: ['selection', 'page'] });
browser.contextMenus.create({ id: 'open-pdf', title: 'Open a PDF file in the reader…', contexts: ['browser_action'] });
browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'read-from-here') toggleIn(tab, 'readSelection');
  if (info.menuItemId === 'open-pdf') browser.tabs.create({ url: VIEWER });
});

const bypass = new Set(); // PDFs the user chose to open in Firefox's own viewer
// Status for the options page.
browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.t === 'engineStatus') {
    if (msg.recheck) {
      stop(activePort);
      shutdownEngine();
      helperState = 'unknown';
    }
    return ensureEngine().then(() => ({ ...model }));
  }
});

browser.runtime.onMessage.addListener((msg) => {
  if (msg && msg.t === 'bypassPdf' && msg.url) { bypass.add(msg.url); setTimeout(() => bypass.delete(msg.url), 30000); }
});

browser.webRequest.onHeadersReceived.addListener((d) => {
  if (!settings.interceptPdf || d.method !== 'GET' || d.statusCode >= 300) return;
  if (bypass.has(d.url)) { bypass.delete(d.url); return; }
  const h = (name) => (d.responseHeaders.find((x) => x.name.toLowerCase() === name) || {}).value || '';
  const type = h('content-type').toLowerCase();
  const isPdf = type.includes('application/pdf') || type.includes('application/x-pdf') ||
    (type.includes('octet-stream') && isPdfUrl(d.url));
  if (!isPdf) return;
  if (/^\s*attachment/i.test(h('content-disposition'))) return; // site wants a download
  return { redirectUrl: viewerFor(d.url) };
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }, ['blocking', 'responseHeaders']);
