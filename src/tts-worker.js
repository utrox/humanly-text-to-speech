// Runs the Kokoro neural TTS model off the main thread.
// Messages in:  {type:'load', prefer:'auto'|'cpu'} | {type:'synth', id, text, voice, speed}
// Messages out: {type:'progress', loaded, total} | {type:'ready', device} | {type:'note', msg}
//               {type:'audio', id, audio, sr, ms} | {type:'error', id, msg}
import { KokoroTTS, env } from 'kokoro-js';
import { checkSpeech } from './audio-check.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const BASE = new URL('./', self.location.href).href; // moz-extension://<id>/

// Use the ONNX runtime shipped inside the extension (extension CSP forbids CDN scripts).
env.wasmPaths = { wasm: BASE + 'ort/ort-wasm-simd-threaded.jsep.wasm' };

// Voice style files are bundled too; serve them locally instead of from Hugging Face.
const realFetch = self.fetch.bind(self);
const VOICE_RE = /\/Kokoro-82M-v1\.0-ONNX\/resolve\/main\/voices\/([a-z_]+\.bin)$/;
self.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const m = url && url.match(VOICE_RE);
  if (m) return realFetch(BASE + 'voices/' + m[1]);
  return realFetch(input, init);
};

let tts = null;
let loading = null;
let device = null;

function progressReporter() {
  const files = new Map();
  return (p) => {
    if (p.status !== 'progress' || !p.file) return;
    files.set(p.file, { loaded: p.loaded || 0, total: p.total || 0 });
    let loaded = 0, total = 0;
    for (const f of files.values()) { loaded += f.loaded; total += f.total; }
    self.postMessage({ type: 'progress', loaded, total });
  };
}

async function gpuAvailable() {
  try {
    if (!self.navigator.gpu) return false;
    const adapter = await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    return !!adapter;
  } catch (_) {
    return false;
  }
}

async function loadModel(prefer) {
  if (prefer !== 'cpu' && await gpuAvailable()) {
    try {
      const m = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'fp32', device: 'webgpu', progress_callback: progressReporter() });
      // Firefox's WebGPU can run the model but return garbage, so listen to a test sentence.
      const test = await m.generate('The quick brown fox jumps over the lazy dog.', { voice: 'af_heart' });
      const check = checkSpeech(test.audio, test.sampling_rate);
      if (!check.ok) throw new Error(`it produced ${check.reason} (zcr ${check.zcr}, dynamics ${check.dynamics})`);
      device = 'webgpu';
      return m;
    } catch (e) {
      self.postMessage({ type: 'note', gpuFailed: true, msg: 'The graphics card voice didn\'t work in Firefox (' + (e && e.message || e) + '), so the voice runs on your processor.' });
    }
  }
  const m = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm', progress_callback: progressReporter() });
  await m.generate('Hi.', { voice: 'af_heart' }); // warm up
  device = 'wasm';
  return m;
}

function load(prefer) {
  if (loading) return loading;
  loading = loadModel(prefer).then((m) => {
    tts = m;
    self.postMessage({ type: 'ready', device });
    return m;
  }).catch((e) => {
    loading = null;
    self.postMessage({ type: 'error', id: null, msg: 'Could not load the voice model: ' + (e && e.message || e) });
    throw e;
  });
  return loading;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.type === 'load') {
    load(msg.prefer).catch(() => {});
    return;
  }
  if (msg.type === 'synth') {
    try {
      const model = tts || await load('auto');
      const t0 = performance.now();
      const out = await model.generate(msg.text, { voice: msg.voice, speed: msg.speed });
      const audio = out.audio; // Float32Array
      const check = checkSpeech(audio, out.sampling_rate);
      self.postMessage({ type: 'audio', id: msg.id, audio, sr: out.sampling_rate, ms: performance.now() - t0, check, device }, [audio.buffer]);
    } catch (e) {
      self.postMessage({ type: 'error', id: msg.id, msg: String(e && e.message || e) });
    }
  }
};
