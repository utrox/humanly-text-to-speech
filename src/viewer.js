// PDF viewer page: renders a PDF with pdf.js and attaches the read-aloud player.
import './polyfills.js';
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';
import { createReader } from './reader.js';
import { learnDecoder, puaRatio } from './pua-fix.js';

pdfjs.GlobalWorkerOptions.workerSrc = browser.runtime.getURL('pdf.worker.js');

const $ = (id) => document.getElementById(id);
const pagesEl = $('pages');
const params = new URLSearchParams(location.search);
const fileUrl = params.get('file');

let pdf = null;
let pages = []; // {div, page, w, h, canvas, textLayer, rendered, task}
let scale = 1;
let reader = null;
let loadToken = 0;

/* ---------------- loading ---------------- */

function showEmpty(text) {
  $('empty').hidden = false;
  if (text) $('emptyText').textContent = text;
}

function nameFromUrl(u) {
  try { return decodeURIComponent(new URL(u).pathname.split('/').pop()) || u; } catch (_) { return u; }
}

async function loadFromUrl(url) {
  const name = nameFromUrl(url);
  document.title = name;
  $('docTitle').textContent = name;
  if (url.startsWith('file:')) {
    showEmpty(`Firefox doesn't let extensions open files from your disk by address. Choose “${name}” below or drop it here.`);
    return;
  }
  $('originalBtn').hidden = false;
  try {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw new Error(`the server answered ${res.status}`);
    await openData(await res.arrayBuffer(), name);
  } catch (e) {
    showEmpty(`Couldn't download this PDF: ${e.message}. Try “Firefox viewer” above, or save it and choose the file here.`);
  }
}

async function openFile(file) {
  if (!file) return;
  history.replaceState(null, '', location.pathname);
  $('originalBtn').hidden = true;
  $('docTitle').textContent = file.name;
  document.title = file.name;
  await openData(await file.arrayBuffer(), file.name);
}

async function openData(data, name) {
  const token = ++loadToken;
  $('empty').hidden = true;
  if (reader) { const r = reader; reader = null; r.close(); }
  if (pdf) { pdf.destroy(); pdf = null; }
  pagesEl.textContent = '';
  pages = [];

  try {
    pdf = await pdfjs.getDocument({ data, isEvalSupported: false, enableXfa: false }).promise;
  } catch (e) {
    showEmpty(e.name === 'PasswordException'
      ? 'This PDF is password-protected. Open it in Firefox\'s viewer instead.'
      : `This file couldn't be opened as a PDF (${e.message}).`);
    return;
  }
  if (token !== loadToken) return;

  const first = await pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  scale = fitWidthScale(vp1.width);
  $('pageCount').textContent = pdf.numPages;
  document.querySelector('.pager').hidden = false;
  document.querySelector('.zoom').hidden = false;
  updateZoomLabel();

  // Create page placeholders (size estimated from page 1 until each page loads).
  for (let i = 1; i <= pdf.numPages; i++) {
    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.page = i;
    const textDiv = document.createElement('div');
    textDiv.className = 'textLayer';
    div.appendChild(textDiv);
    pagesEl.appendChild(div);
    const p = { div, textDiv, page: null, w: vp1.width, h: vp1.height, canvas: null, textLayer: null, rendered: 0, task: null };
    pages.push(p);
    sizePage(p);
    observer.observe(div);
  }

  await startReader();

  // Some PDFs encode letters as private-use placeholders; learn how to decode them.
  const textCache = new Map();
  edgeCounts.clear();
  const decoder = await learnTextDecoder(textCache);
  if (token !== loadToken) return;

  // Build text layers page by page; feed each to the reader as it's ready.
  let found = 0;
  for (const p of pages) {
    if (token !== loadToken) return;
    const num = +p.div.dataset.page;
    p.page = await pdf.getPage(num);
    const vp = p.page.getViewport({ scale: 1 });
    p.w = vp.width; p.h = vp.height;
    sizePage(p);
    const tc = textCache.get(num) || await p.page.getTextContent({ includeMarkedContent: true });
    textCache.delete(num);
    if (decoder) for (const it of tc.items) if (typeof it.str === 'string') it.str = decoder.decode(it.str);
    p.textLayer = new pdfjs.TextLayer({
      textContentSource: tc,
      container: p.textDiv,
      viewport: p.page.getViewport({ scale }),
    });
    await p.textLayer.render();
    p.textLayer.done = true;
    markRunningHeaders(p.textDiv);
    if (token !== loadToken) return;
    found += (p.textDiv.textContent.trim().length > 0);
    if (reader) reader.append([p.textDiv]);
  }
  if (reader && !found) {
    reader.setEmptyMessage('This PDF has no selectable text (it may be a scanned image).');
  }
}

/** Samples pages spread across the document; returns a decoder if the text is scrambled. */
async function learnTextDecoder(textCache) {
  const n = pdf.numPages;
  const want = Math.min(n, 30);
  const nums = [...new Set(Array.from({ length: want }, (_, i) => 1 + Math.floor((i * n) / want)))];
  const texts = [];
  for (const num of nums) {
    const page = await pdf.getPage(num);
    const tc = await page.getTextContent({ includeMarkedContent: true });
    textCache.set(num, tc);
    // Remember lines near the top/bottom edge; ones that repeat are running headers/footers.
    const h = page.getViewport({ scale: 1 }).height;
    const seen = new Set();
    for (const it of tc.items) {
      if (!it.str || !it.transform) continue;
      const y = it.transform[5] / h;
      if (y > 0.08 && y < 0.92) continue;
      const key = normEdge(it.str);
      if (key.length > 3 && !seen.has(key)) { seen.add(key); edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1); }
    }
    // Join pieces the way the text layer lays them out, so ligatures stay inside their words.
    texts.push(tc.items.map((it) => (it.str || '') + (it.hasEOL ? '\n' : '')).join(''));
  }
  if (puaRatio(texts.join(' ')) < 0.05) return null;
  if (reader) reader.setEmptyMessage('Repairing this PDF\'s text…');
  try {
    const list = await (await fetch(browser.runtime.getURL('words.txt'))).text();
    const dec = learnDecoder(texts, new Set(list.split('\n')));
    if (dec) console.info('Humanly TTS: repaired scrambled PDF text', JSON.stringify(dec.stats), [...dec.map].map(([k, v]) => k.toString(16) + '=' + v).join(' '));
    return dec;
  } catch (e) {
    console.warn('Humanly TTS: could not repair PDF text', e);
    return null;
  } finally {
    if (reader) reader.setEmptyMessage('');
  }
}

async function startReader() {
  $('readBtn').hidden = true;
  reader = await createReader({
    mode: 'pdf',
    getRoots: () => pages.filter((p) => p.textLayer).map((p) => p.textDiv),
    segOpts: {
      pdf: true,
      blockOf: (el) => el.closest('.textLayer'),
      visible: (el) => !el.classList.contains('nr-skip'),
      // A line break with a clear change in font size separates a heading from the text.
      isNewBlock: (a, b) => {
        const fa = parseFloat(a.style.getPropertyValue('--font-height')), fb = parseFloat(b.style.getPropertyValue('--font-height'));
        return fa > 0 && fb > 0 && Math.abs(fa - fb) / Math.min(fa, fb) > 0.15;
      },
    },
    onClose: () => { reader = null; if (pdf) $('readBtn').hidden = false; },
  });
  const ready = pages.filter((p) => p.textLayer && p.textLayer.done).map((p) => p.textDiv);
  if (ready.length) reader.append(ready);
}

/** Skips page numbers and running headers/footers so they aren't read between paragraphs. */
const edgeCounts = new Map();
const normEdge = (t) => t.toLowerCase().replace(/[\d\s]+/g, ' ').trim();
function markRunningHeaders(layer) {
  for (const span of layer.querySelectorAll('span')) {
    const top = parseFloat(span.style.top);
    if (!(top < 8 || top > 91)) continue;
    const text = span.textContent.trim();
    const repeated = (edgeCounts.get(normEdge(text)) || 0) >= 3;
    if (repeated || ((top < 5.5 || top > 93) && text.length < 70)) span.classList.add('nr-skip');
  }
}

/* ---------------- rendering ---------------- */

function fitWidthScale(w) {
  const avail = Math.min(window.innerWidth - 32, 860);
  return Math.max(0.5, Math.min(2, avail / w));
}

function sizePage(p) {
  p.div.style.setProperty('--scale-factor', scale);
  p.div.style.setProperty('--total-scale-factor', scale);
  p.div.style.width = Math.floor(p.w * scale) + 'px';
  p.div.style.height = Math.floor(p.h * scale) + 'px';
}

const visible = new Set();
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const p = pages[+e.target.dataset.page - 1];
    if (!p) continue;
    if (e.isIntersecting) { visible.add(p); renderPage(p); } else visible.delete(p);
  }
  updatePageNumber();
}, { rootMargin: '800px 0px' });

async function renderPage(p) {
  if (p.rendered === scale || p.task) return;
  if (!p.page) p.page = await pdf.getPage(+p.div.dataset.page);
  const dpr = window.devicePixelRatio || 1;
  const vp = p.page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  const want = scale;
  p.task = p.page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport: vp,
    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
  });
  try {
    await p.task.promise;
    if (p.canvas) p.canvas.remove();
    p.div.insertBefore(canvas, p.textDiv);
    p.canvas = canvas;
    p.rendered = want;
  } catch (e) {
    if (e.name !== 'RenderingCancelledException') console.warn(e);
  } finally {
    p.task = null;
  }
  if (p.rendered !== scale && visible.has(p)) renderPage(p);
}

function updatePageNumber() {
  const mid = window.innerHeight * 0.4;
  for (const p of pages) {
    const r = p.div.getBoundingClientRect();
    if (r.bottom >= mid) {
      if (document.activeElement !== $('pageNum')) $('pageNum').value = p.div.dataset.page;
      return;
    }
  }
}

function setScale(next) {
  next = Math.round(Math.max(0.4, Math.min(3, next)) * 100) / 100;
  if (next === scale || !pages.length) return;
  // Keep the same spot in view.
  const anchor = pages.find((p) => p.div.getBoundingClientRect().bottom > 60) || pages[0];
  const r = anchor.div.getBoundingClientRect();
  const frac = (60 - r.top) / r.height;
  scale = next;
  for (const p of pages) {
    sizePage(p);
    if (p.task) p.task.cancel();
    if (p.textLayer && p.page) p.textLayer.update({ viewport: p.page.getViewport({ scale }) });
  }
  const r2 = anchor.div.getBoundingClientRect();
  window.scrollBy(0, r2.top + frac * r2.height - 60);
  for (const p of visible) renderPage(p);
  updateZoomLabel();
}

function updateZoomLabel() { $('zoomLabel').textContent = Math.round(scale * 100) + '%'; }

/* ---------------- controls ---------------- */

$('readBtn').addEventListener('click', () => { if (!reader) startReader(); });
$('zoomIn').addEventListener('click', () => setScale(scale * 1.15));
$('zoomOut').addEventListener('click', () => setScale(scale / 1.15));
$('openBtn').addEventListener('click', () => $('fileInput').click());
$('chooseBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => openFile(e.target.files[0]));
$('originalBtn').addEventListener('click', async () => {
  await browser.runtime.sendMessage({ t: 'bypassPdf', url: fileUrl });
  location.href = fileUrl;
});
$('pageNum').addEventListener('change', (e) => {
  const p = pages[Math.max(1, Math.min(pages.length, +e.target.value)) - 1];
  if (p) p.div.scrollIntoView({ block: 'start' });
});
window.addEventListener('scroll', () => requestAnimationFrame(updatePageNumber), { passive: true });
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setScale(scale * 1.15); }
  if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setScale(scale / 1.15); }
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('drop').hidden = false; });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop').hidden = true; } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  const f = [...e.dataTransfer.files].find((x) => x.type === 'application/pdf' || /\.pdf$/i.test(x.name));
  if (f) openFile(f);
});

if (fileUrl) loadFromUrl(fileUrl);
else showEmpty();
