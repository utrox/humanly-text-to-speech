// Reader controller + floating player. Used by web pages (content script) and the PDF viewer.
import { VOICES, getSettings, setSettings } from './settings.js';
import { segmentRoots, findMainRoots, unwrapAll, sentenceIndexAt } from './segment.js';

const ICONS = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10.5-6.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
  prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM19 5.5v13L9.5 12z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM5 5.5v13L14.5 12z"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"/></svg>',
};

const CSS = `
:host { all: initial; }
[hidden] { display: none !important; }
.dock {
  --ink: #1c2333; --panel: #262f44; --line: #36405a; --paper: #eef0e6; --muted: #9ba4b7; --mark: #d6f050;
  position: fixed; right: 20px; bottom: 20px; z-index: 2147483647;
  font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--paper);
  background: var(--ink); border-radius: 14px; padding: 10px 12px 8px;
  box-shadow: 0 10px 30px rgba(10, 14, 25, .35), 0 0 0 1px rgba(255,255,255,.04);
  width: 330px; max-width: calc(100vw - 32px); box-sizing: border-box; user-select: none;
}
@media (max-width: 420px) { .dock { right: 16px; bottom: 16px; } }
.row { display: flex; align-items: center; gap: 6px; }
button { all: unset; cursor: pointer; display: grid; place-items: center; border-radius: 8px; color: var(--paper); }
button:focus-visible, select:focus-visible, input:focus-visible { outline: 2px solid var(--mark); outline-offset: 2px; }
button svg { width: 18px; height: 18px; fill: currentColor; }
.skip { width: 32px; height: 32px; color: var(--muted); }
.skip:hover, .icon:hover { color: var(--paper); background: var(--panel); }
.play { width: 42px; height: 42px; border-radius: 50%; background: var(--mark); color: var(--ink); }
.play svg { width: 22px; height: 22px; }
.play:hover { filter: brightness(1.07); }
.play.busy { animation: pulse 1.1s ease-in-out infinite; }
@keyframes pulse { 50% { box-shadow: 0 0 0 6px rgba(214,240,80,.18); } }
@media (prefers-reduced-motion: reduce) { .play.busy { animation: none; opacity: .75; } }
.speed { display: flex; align-items: center; margin-left: 8px; background: var(--panel); border-radius: 9px; }
.speed button { width: 26px; height: 30px; font-size: 16px; color: var(--muted); }
.speed button:hover { color: var(--paper); }
.speed output { min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; font-weight: 600; font-size: 14px; }
.spacer { flex: 1; }
.icon { width: 30px; height: 30px; color: var(--muted); }
.track { position: relative; height: 3px; background: var(--line); border-radius: 2px; margin: 10px 2px 6px; cursor: pointer; }
.track i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--mark); border-radius: 2px; width: 0; }
.status { display: flex; justify-content: space-between; gap: 10px; color: var(--muted); font-size: 12px; min-height: 16px; }
.status .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status .msg.err { color: #ffb4a8; white-space: normal; }
.status .pos { font-variant-numeric: tabular-nums; flex: none; }
.menu { display: none; margin-top: 8px; padding-top: 10px; border-top: 1px solid var(--line); gap: 10px; flex-direction: column; }
.menu.open { display: flex; }
.menu label { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--paper); cursor: pointer; }
.menu select { font: inherit; color: var(--paper); background: var(--panel); border: 1px solid var(--line); border-radius: 7px; padding: 5px 6px; max-width: 190px; }
.menu input[type=checkbox] { accent-color: var(--mark); width: 16px; height: 16px; margin: 0; }
.menu .hint { color: var(--muted); font-size: 12px; }
`;

/**
 * opts: {
 *   mode: 'page' | 'pdf',
 *   getRoots(): Element[]          (pdf mode)
 *   segOpts: extra options for segmentRoots
 *   onClose(): void
 * }
 */
export async function createReader(opts) {
  const doc = document;
  const mode = opts.mode || 'page';
  let settings = await getSettings();
  let sentences = [];
  let cur = -1;
  let state = 'idle'; // idle | waiting | playing | paused
  let playId = 0;
  let lastUserScroll = 0;
  let hovered = -1;
  let restartOnResume = false;

  /* ---------- port to the engine ---------- */
  let port = connect();
  function connect() {
    const p = browser.runtime.connect({ name: 'reader' });
    p.onMessage.addListener(onEngine);
    p.onDisconnect.addListener(() => { port = null; });
    return p;
  }
  function send(msg) {
    if (!port) port = connect();
    port.postMessage(msg);
  }
  send({ t: 'warmup' });

  /* ---------- UI ---------- */
  const host = doc.createElement('nr-ui');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `<style>${CSS}</style>
  <div class="dock" role="region" aria-label="Read aloud">
    <div class="row">
      <button class="skip" data-a="prev" title="Previous sentence" aria-label="Previous sentence">${ICONS.prev}</button>
      <button class="play" data-a="play" title="Play" aria-label="Play">${ICONS.play}</button>
      <button class="skip" data-a="next" title="Next sentence" aria-label="Next sentence">${ICONS.next}</button>
      <div class="speed" title="Reading speed">
        <button data-a="slower" aria-label="Slower">−</button>
        <output aria-live="polite"></output>
        <button data-a="faster" aria-label="Faster">+</button>
      </div>
      <div class="spacer"></div>
      <button class="icon" data-a="menu" title="Settings" aria-label="Settings" aria-expanded="false">${ICONS.more}</button>
      <button class="icon" data-a="close" title="Close reader" aria-label="Close reader">${ICONS.close}</button>
    </div>
    <div class="track" title="Position in text"><i></i></div>
    <div class="status"><span class="msg"></span><span class="pos"></span></div>
    <div class="menu">
      <label>Voice engine <select data-s="engine">
        <option value="auto">Automatic</option>
        <option value="helper">Natural voice (helper app)</option>
        <option value="system">Windows voice (instant)</option>
        <option value="browser">Natural voice in Firefox (slow)</option>
      </select></label>
      <label>Voice <select data-s="voice">${VOICES.map((v) => `<option value="${v.id}">${v.name}</option>`).join('')}</select></label>
      ${mode === 'page' ? `<label>Main text only <input type="checkbox" data-s="mainOnly"></label>` : ''}
      <label>Follow along (auto-scroll) <input type="checkbox" data-s="autoScroll"></label>
      <label class="gpu-row" hidden>Use graphics card in Firefox <input type="checkbox" data-s="useGpu"></label>
      <span class="hint engine"></span>
      <span class="hint">Click any sentence to read from there.</span>
    </div>
  </div>`;
  const $ = (s) => shadow.querySelector(s);
  const playBtn = $('.play');
  const speedOut = $('output');
  const msgEl = $('.msg');
  const posEl = $('.pos');
  const bar = $('.track i');
  const menu = $('.menu');
  const engineEl = $('.engine');
  (doc.body || doc.documentElement).appendChild(host);

  shadow.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    switch (b.dataset.a) {
      case 'play': togglePlay(); break;
      case 'prev': jump(-1); break;
      case 'next': jump(1); break;
      case 'slower': changeSpeed(-0.1); break;
      case 'faster': changeSpeed(0.1); break;
      case 'menu': {
        const open = menu.classList.toggle('open');
        b.setAttribute('aria-expanded', String(open));
        break;
      }
      case 'close': close(); break;
    }
  });
  $('.track').addEventListener('click', (e) => {
    if (!sentences.length) return;
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - r.left) / r.width) * sentences.length);
    playFrom(Math.max(0, Math.min(sentences.length - 1, i)));
  });
  shadow.addEventListener('change', async (e) => {
    const key = e.target.dataset.s;
    if (!key) return;
    const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    settings[key] = val;
    await setSettings({ [key]: val });
    if ((key === 'voice' || key === 'systemVoice') && (state === 'playing' || state === 'waiting')) playFrom(cur);
    if (key === 'mainOnly') resegment();
  });

  function renderSettings() {
    speedOut.value = settings.speed.toFixed(1) + '×';
    const vs = shadow.querySelector('select[data-s=voice], select[data-s=systemVoice]');
    if (vs) vs.value = vs.dataset.s === 'voice' ? settings.voice : settings.systemVoice;
    shadow.querySelector('[data-s=engine]').value = settings.engine || 'auto';
    const mo = shadow.querySelector('[data-s=mainOnly]');
    if (mo) mo.checked = settings.mainOnly;
    shadow.querySelector('[data-s=autoScroll]').checked = settings.autoScroll;
    shadow.querySelector('[data-s=useGpu]').checked = settings.useGpu !== false;
  }

  function renderState() {
    const isPlaying = state === 'playing' || state === 'waiting';
    playBtn.innerHTML = isPlaying ? ICONS.pause : ICONS.play;
    playBtn.title = isPlaying ? 'Pause' : 'Play';
    playBtn.setAttribute('aria-label', playBtn.title);
    playBtn.classList.toggle('busy', state === 'waiting');
    const n = sentences.length;
    posEl.textContent = n ? `${Math.max(cur, 0) + 1} / ${n}` : '';
    bar.style.width = n ? `${((Math.max(cur, 0) + (cur >= 0 ? 1 : 0)) / n) * 100}%` : '0';
  }

  let modelMsg = '';
  let emptyMsg = '';
  let noteMsg = '', lastNote = '';
  let shownVoices = 'kokoro';
  function renderSettingsFromEngine(m) {
    // Keep the toggle in sync if the engine switched devices on its own.
    if (m.device === 'wasm' && m.msg && settings.useGpu !== false && /graphics card/.test(m.msg)) {
      settings.useGpu = false;
      shadow.querySelector('[data-s=useGpu]').checked = false;
    }
    shadow.querySelector('.gpu-row').hidden = m.engine !== 'browser';
    // The Windows voice has its own list of voices.
    const sel = shadow.querySelector('select[data-s=voice], select[data-s=systemVoice]');
    const want = m.engine === 'system' ? 'system:' + (m.voices || []).map((v) => v.id).join('|') : 'kokoro';
    if (want !== shownVoices) {
      shownVoices = want;
      const list = m.engine === 'system' ? (m.voices || []) : VOICES;
      sel.dataset.s = m.engine === 'system' ? 'systemVoice' : 'voice';
      sel.innerHTML = '';
      if (m.engine === 'system') sel.append(new Option('Default English voice', ''));
      for (const v of list) sel.append(new Option(v.name, v.id));
      sel.value = m.engine === 'system' ? (settings.systemVoice || '') : settings.voice;
    }
  }
  function engineText(m) {
    if (m.engine === 'helper') {
      return m.device === 'native-gpu' ? 'Natural voice from the helper app, on your graphics card.'
        : m.device === 'native-cpu' ? 'Natural voice from the helper app, on your processor.' : 'Starting the helper app…';
    }
    if (m.engine === 'system') {
      return 'Windows voice.' + (m.helper === 'missing' ? ' For the natural voice, install the helper app (install.bat).' : '');
    }
    if (m.device === 'webgpu') return 'Natural voice in Firefox, on your graphics card.';
    if (m.device === 'wasm') return `Natural voice in Firefox, on your processor (${m.workers} in parallel). This is slow.`;
    return '';
  }
  function setMsg(text, isErr) {
    msgEl.textContent = text || '';
    msgEl.classList.toggle('err', !!isErr);
  }
  function defaultMsg() {
    if (modelMsg) return modelMsg;
    if (noteMsg) return noteMsg;
    if (!sentences.length) return emptyMsg || (mode === 'pdf' ? 'Loading text…' : 'No readable text found on this page.');
    if (state === 'waiting') return 'Preparing voice…';
    if (state === 'idle' && cur < 0) return 'Press play or click a sentence.';
    return '';
  }
  function refreshMsg() { setMsg(defaultMsg()); }

  /* ---------- engine events ---------- */
  function onEngine(m) {
    switch (m.t) {
      case 'model':
        engineEl.textContent = engineText(m);
        if (m.msg && m.state !== 'error') {
          engineEl.textContent += ' ' + m.msg;
          if (m.msg !== lastNote) { lastNote = m.msg; noteMsg = m.msg; setTimeout(() => { noteMsg = ''; refreshMsg(); }, 10000); }
        }
        renderSettingsFromEngine(m);
        if (m.state === 'loading') {
          modelMsg = 'Starting the voice…';
        } else if (m.state === 'downloading') {
          const mb = (x) => Math.round(x / 1e6);
          modelMsg = m.total
            ? `Downloading voice: ${mb(m.loaded)} of ${mb(m.total)} MB (first time only)`
            : 'Loading voice…';
        } else if (m.state === 'error') {
          modelMsg = '';
          setMsg(m.msg, true);
          state = 'idle'; renderState();
          return;
        } else {
          modelMsg = '';
        }
        refreshMsg();
        break;
      case 'waiting':
        if (m.id === playId && state !== 'paused') { state = 'waiting'; renderState(); refreshMsg(); }
        break;
      case 'start':
        if (m.id === playId && state === 'waiting') { state = 'playing'; renderState(); refreshMsg(); }
        break;
      case 'end':
        if (m.id !== playId) return;
        if (state === 'paused') {
          // Finished just as the user paused: move on, but wait for play.
          if (cur + 1 < sentences.length) { setCurrent(cur + 1); restartOnResume = true; renderState(); }
          return;
        }
        if (cur + 1 < sentences.length) playFrom(cur + 1);
        else { state = 'idle'; renderState(); setMsg('Finished.'); }
        break;
      case 'error':
        if (m.id !== playId) return;
        state = 'idle'; renderState();
        setMsg('Could not read this sentence: ' + m.msg, true);
        break;
      case 'retry':
        // The engine changed underneath us (the helper app stopped): read the sentence again.
        if (state === 'playing' || state === 'waiting') playFrom(cur);
        break;
      case 'stopped':
        state = cur >= 0 ? 'paused' : 'idle';
        renderState();
        break;
    }
  }

  /* ---------- playback control ---------- */
  function playFrom(i) {
    if (!sentences.length) return;
    restartOnResume = false;
    i = Math.max(0, Math.min(sentences.length - 1, i));
    setCurrent(i);
    playId++;
    state = 'waiting';
    send({
      t: 'play', id: playId, text: sentences[i].text,
      voice: settings.voice, speed: settings.speed,
      ahead: sentences.slice(i + 1, i + 4).map((s) => s.text),
    });
    renderState();
    refreshMsg();
  }

  function togglePlay() {
    if (state === 'playing' || state === 'waiting') {
      send({ t: 'pause' });
      state = 'paused';
    } else if (state === 'paused' && cur >= 0 && restartOnResume) {
      restartOnResume = false;
      playFrom(cur);
      return;
    } else if (state === 'paused' && cur >= 0) {
      send({ t: 'resume' });
      state = 'playing';
    } else {
      playFrom(cur >= 0 ? cur : firstVisible());
      return;
    }
    renderState();
    refreshMsg();
  }

  function jump(d) {
    if (!sentences.length) return;
    const i = cur < 0 ? firstVisible() : cur + d;
    if (state === 'playing' || state === 'waiting' || state === 'paused') playFrom(i);
    else { setCurrent(Math.max(0, Math.min(sentences.length - 1, i))); renderState(); }
  }

  async function changeSpeed(d) {
    settings.speed = Math.round(Math.max(0.5, Math.min(2.0, settings.speed + d)) * 10) / 10;
    renderSettings();
    await setSettings({ speed: settings.speed });
    if (state === 'playing' || state === 'waiting') playFrom(cur);
  }

  function firstVisible() {
    const vh = window.innerHeight;
    for (let i = 0; i < sentences.length; i++) {
      const r = sentences[i].els[0].getBoundingClientRect();
      if (r.bottom > 0 && r.top < vh && r.width > 0) return i;
    }
    return 0;
  }

  function setCurrent(i) {
    if (cur >= 0 && sentences[cur]) sentences[cur].els.forEach((el) => el.classList.remove('__nr_cur'));
    cur = i;
    const s = sentences[i];
    if (!s) return;
    s.els.forEach((el) => el.classList.add('__nr_cur'));
    if (settings.autoScroll && Date.now() - lastUserScroll > 4000) {
      const r = s.els[0].getBoundingClientRect();
      const vh = window.innerHeight;
      if (r.top < vh * 0.12 || r.bottom > vh * 0.75) {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        s.els[0].scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
      }
    }
  }

  /* ---------- page interaction ---------- */
  function onClick(e) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const t = e.target;
    const s = t && t.closest && t.closest('nr-s');
    if (!s) return;
    if (t.closest('a[href], button, input, select, textarea, label, summary, [contenteditable=""], [contenteditable="true"]')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    playFrom(+s.getAttribute('data-i'));
  }
  function setHover(i) {
    if (hovered === i) return;
    if (hovered >= 0 && sentences[hovered]) sentences[hovered].els.forEach((el) => el.classList.remove('__nr_hov'));
    hovered = i;
    if (i >= 0 && sentences[i]) sentences[i].els.forEach((el) => el.classList.add('__nr_hov'));
  }
  function onOver(e) {
    const s = e.target && e.target.closest && e.target.closest('nr-s');
    setHover(s ? +s.getAttribute('data-i') : -1);
  }
  function onUserScroll() { lastUserScroll = Date.now(); }
  function onKey(e) {
    if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) onUserScroll();
  }
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('mouseover', onOver, true);
  window.addEventListener('wheel', onUserScroll, { passive: true, capture: true });
  window.addEventListener('touchmove', onUserScroll, { passive: true, capture: true });
  window.addEventListener('keydown', onKey, true);

  /* ---------- segmentation ---------- */
  function resegment() {
    const wasPlaying = state === 'playing' || state === 'waiting';
    const keepEl = cur >= 0 && sentences[cur] ? sentences[cur].els[0] : null;
    const keepNode = keepEl && keepEl.firstChild;
    if (wasPlaying) send({ t: 'stop' });
    setHover(-1);
    unwrapAll(doc);
    const roots = mode === 'pdf' ? opts.getRoots() : (settings.mainOnly ? findMainRoots(doc) : [doc.body]);
    sentences = segmentRoots(roots, { mainOnly: mode === 'page' && settings.mainOnly, ...(opts.segOpts || {}) });
    doc.documentElement.classList.add('__nr_on');
    let i = keepNode && keepNode.isConnected ? sentenceIndexAt(doc, keepNode, 0, sentences) : -1;
    cur = -1;
    if (i >= 0) setCurrent(i);
    if (wasPlaying && i >= 0) playFrom(i); else if (wasPlaying) { state = 'idle'; }
    renderState();
    refreshMsg();
  }

  function startAt(node, off) {
    if (!sentences.length || !node || !node.isConnected) return false;
    const i = sentenceIndexAt(doc, node, off, sentences);
    if (i >= 0) { playFrom(i); return true; }
    return false;
  }

  function close() {
    send({ t: 'stop' });
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('mouseover', onOver, true);
    window.removeEventListener('wheel', onUserScroll, true);
    window.removeEventListener('touchmove', onUserScroll, true);
    window.removeEventListener('keydown', onKey, true);
    unwrapAll(doc);
    doc.documentElement.classList.remove('__nr_on');
    host.remove();
    if (port) port.disconnect();
    port = null;
    opts.onClose && opts.onClose();
  }

  renderSettings();
  renderState();
  refreshMsg();
  if (mode === 'page') resegment();

  return {
    resegment,
    close,
    setEmptyMessage(text) { emptyMsg = text; refreshMsg(); },
    /** Adds more text (e.g. PDF pages as they finish loading) without disturbing playback. */
    append(roots) {
      const more = segmentRoots(roots, { ...(opts.segOpts || {}), startIndex: sentences.length });
      sentences.push(...more);
      doc.documentElement.classList.add('__nr_on');
      renderState();
      refreshMsg();
    },
    /** Start at a DOM position captured before the text was wrapped (e.g. the selection). */
    startAt,
    togglePlay,
    firstVisible,
    playFrom,
    get count() { return sentences.length; },
  };
}
