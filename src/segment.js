// Finds readable text, splits it into sentences and wraps each sentence's text in
// <nr-s data-i="N"> elements so it can be highlighted and clicked.

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON',
  'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'TEMPLATE', 'NR-UI', 'KBD',
]);
const MAIN_SKIP_TAGS = new Set(['NAV', 'ASIDE', 'FOOTER', 'FORM', 'DIALOG', 'MENU']);
const MAIN_SKIP_ROLES = /^(navigation|complementary|banner|contentinfo|search|menu|menubar|toolbar|dialog|alertdialog|tablist)$/;
const NOISE_RE = /(^|[\s_-])(comments?|share|sharing|social|related|recommended|promo|newsletter|subscribe|advert|advertisement|ads?|sponsored|sidebar|cookies?|consent|popup|modal|breadcrumbs?|pagination|toolbar|navbar|footer)([\s_-]|$)/i;
const NO_WRAP_WS_PARENTS = new Set(['TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL', 'OL', 'DL', 'COLGROUP']);
const CITATION_RE = /^\s*\[?\s*(\d+|[a-z])([,–\-]\s*\d+)*\s*\]?\s*$/i;
const HAS_WORD = /[\p{L}\p{N}]/u;
// Sentence "ends" that are really abbreviations: "Dr.", "e.g.", "U.S.", "J."
const ABBREV_END = /(?:^|[\s(\[\"'“‘])(?:mr|mrs|ms|dr|prof|sr|jr|st|mt|ft|vs|etc|e\.g|i\.e|cf|al|fig|figs|no|nos|vol|pp|p|ch|sec|eq|eqs|approx|inc|ltd|co|corp|dept|gen|gov|lt|col|sgt|rev|hon|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|[a-z]|(?:[a-z]\.){1,3}[a-z])\.$/i;

function defaultVisible(el) {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false;
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  }
  const cs = el.ownerDocument.defaultView.getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}

function makeBlockOf(doc) {
  const cache = new WeakMap();
  const view = doc.defaultView;
  return function blockOf(el) {
    const chain = [];
    let e = el;
    while (e && e !== doc.body && e !== doc.documentElement) {
      if (cache.has(e)) { const b = cache.get(e); chain.forEach((c) => cache.set(c, b)); return b; }
      const d = view.getComputedStyle(e).display;
      if (d !== 'inline' && d !== 'contents' && d !== '') { chain.forEach((c) => cache.set(c, e)); cache.set(e, e); return e; }
      chain.push(e);
      e = e.parentElement;
    }
    const b = e || el;
    chain.forEach((c) => cache.set(c, b));
    return b;
  };
}

function isNoise(el) {
  const tag = el.tagName;
  if (MAIN_SKIP_TAGS.has(tag)) return true;
  if (tag === 'HEADER' && !el.closest('article, main, [role="main"]')) return true;
  const role = el.getAttribute('role');
  if (role && MAIN_SKIP_ROLES.test(role)) return true;
  const cls = (typeof el.className === 'string' ? el.className : '') + ' ' + (el.id || '');
  if (cls.length > 1 && NOISE_RE.test(cls)) return true;
  return false;
}

function isCitation(el) {
  if (el.tagName !== 'SUP') return false;
  return CITATION_RE.test(el.textContent || '') || !!el.querySelector('a[href^="#cite"], a[href^="#fn"], a[href^="#ref"]');
}

function textLen(el) {
  return (el.textContent || '').replace(/\s+/g, ' ').trim().length;
}

/** Picks the element(s) that hold the main article text (a light Readability-style heuristic). */
export function findMainRoots(doc) {
  const body = doc.body;
  const scores = new Map();
  let total = 0;
  for (const p of doc.querySelectorAll('p, pre')) {
    if (p.closest('nav, aside, footer, form, [role="navigation"], [role="complementary"]')) continue;
    const len = textLen(p);
    if (len < 25) continue;
    total += len;
    const score = 1 + (p.textContent.match(/,/g) || []).length + Math.min(len / 100, 3);
    let anc = p.parentElement;
    for (let lvl = 0; anc && anc !== doc.documentElement && lvl < 3; lvl++, anc = anc.parentElement) {
      scores.set(anc, (scores.get(anc) || 0) + score / (lvl + 1));
    }
  }
  let best = null, bestScore = 0;
  for (const [el, s] of scores) if (s > bestScore) { best = el; bestScore = s; }
  if (!best || total < 200 || best === body) return [body];

  let root = best;
  const len = textLen(best);
  for (let k = 0; k < 4; k++) {
    const par = root.parentElement;
    if (!par || par === body || par === doc.documentElement) break;
    const plen = textLen(par);
    if (plen <= len * 1.35 || (/^(ARTICLE|MAIN)$/.test(par.tagName) && plen <= len * 2)) root = par;
    else break;
  }
  const roots = [root];
  const h1 = doc.querySelector('h1');
  if (h1 && !root.contains(h1) && !h1.contains(root) &&
      (h1.compareDocumentPosition(root) & 4 /* FOLLOWING */) && textLen(h1) > 0) {
    roots.unshift(h1);
  }
  return roots;
}

/**
 * Segments text under `roots` into sentences and wraps them.
 * opts: { mainOnly, pdf, visible(el), blockOf(el), lang }
 * Returns [{ text, els: [nr-s...] }]
 */
export function segmentRoots(roots, opts = {}) {
  if (!roots.length) return [];
  const doc = roots[0].ownerDocument;
  const visible = opts.visible || defaultVisible;
  const blockOf = opts.blockOf || makeBlockOf(doc);
  const mainOnly = !!opts.mainOnly;
  const pdf = !!opts.pdf;
  const base = opts.startIndex || 0; // global index of the first sentence (for appending)

  // 1. Collect runs of text nodes that share a block ancestor.
  const runs = [];
  for (const root of roots) {
    let run = null;
    let pendingBreak = false;
    const walker = doc.createTreeWalker(root, 1 | 4 /* ELEMENT | TEXT */, {
      acceptNode(n) {
        if (n.nodeType === 1) {
          const tag = n.tagName.toUpperCase();
          if (SKIP_TAGS.has(tag)) return 2; // REJECT subtree
          if (tag === 'NR-S') return 3;
          if (n !== root) {
            if (mainOnly && isNoise(n)) return 2;
            if (isCitation(n)) return 2;
            if (!visible(n)) return 2;
          }
          return tag === 'BR' ? 1 : 3; // ACCEPT br, SKIP others (but visit children)
        }
        return 1;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) { pendingBreak = true; continue; }
      if (!n.data) continue;
      const block = blockOf(n.parentElement);
      if (!run || run.block !== block) {
        run = { block, nodes: [], text: '', drops: [] };
        runs.push(run);
        pendingBreak = false;
      }
      const prevEl = run.lastEl;
      run.lastEl = n.parentElement;
      if (pendingBreak && run.text && opts.isNewBlock && prevEl && opts.isNewBlock(prevEl, n.parentElement)) {
        run.text += '\n'; // e.g. a heading followed by body text: force a sentence break
      } else if (pendingBreak && run.text && !/\s$/.test(run.text) && !/^\s/.test(n.data)) {
        if (pdf && /\p{L}-$/u.test(run.text) && /^\p{Ll}/u.test(n.data)) {
          run.drops.push(run.text.length - 1); // join "exam-" + "ple"
        } else {
          run.text += ' ';
        }
      }
      pendingBreak = false;
      run.nodes.push({ node: n, start: run.text.length });
      run.text += n.data;
    }
  }

  // 2. Split runs into sentences.
  const segmenter = new Intl.Segmenter(opts.lang || 'en', { granularity: 'sentence' });
  const sentences = [];
  for (const run of runs) {
    run.pieces = [];
    const t = run.text;
    if (!HAS_WORD.test(t)) continue;
    for (const s of segmenter.segment(t)) {
      let a = s.index, b = s.index + s.segment.length;
      while (a < b && /\s/.test(t[a])) a++;
      while (b > a && /\s/.test(t[b - 1])) b--;
      if (a >= b) continue;
      const prev = run.pieces[run.pieces.length - 1];
      if (prev && (prev.merge || !HAS_WORD.test(t.slice(a, b)))) {
        prev.b = b; // continue the previous sentence
      } else if (HAS_WORD.test(t.slice(a, b))) {
        run.pieces.push({ a, b });
      } else continue;
      const last = run.pieces[run.pieces.length - 1];
      last.merge = ABBREV_END.test(t.slice(last.a, last.b)) && /^\s+\S/.test(t.slice(b, b + 2)) && b < t.length;
    }
    for (const p of run.pieces) {
      p.idx = base + sentences.length;
      sentences.push({ text: speakable(t, p.a, p.b, run.drops), els: [] });
    }
  }

  // 3. Wrap: split text nodes at sentence boundaries and wrap each part in <nr-s>.
  for (const run of runs) {
    if (!run.pieces.length) continue;
    const bounds = [];
    for (const p of run.pieces) bounds.push(p.a, p.b);
    for (const { node, start } of run.nodes) {
      const end = start + node.data.length;
      const cuts = [...new Set(bounds.filter((x) => x > start && x < end))].sort((x, y) => x - y);
      const parts = [];
      let cur = node, off = start;
      for (const c of cuts) {
        const rest = cur.splitText(c - off);
        parts.push({ node: cur, start: off });
        cur = rest; off = c;
      }
      parts.push({ node: cur, start: off });
      for (const part of parts) {
        const piece = run.pieces.find((p) => part.start >= p.a && part.start < p.b);
        if (!piece) continue;
        const parent = part.node.parentNode;
        if (!parent) continue;
        if (!/\S/.test(part.node.data) && NO_WRAP_WS_PARENTS.has(parent.nodeName)) continue;
        const el = doc.createElement('nr-s');
        el.setAttribute('data-i', String(piece.idx));
        parent.insertBefore(el, part.node);
        el.appendChild(part.node);
        sentences[piece.idx - base].els.push(el);
      }
    }
  }
  return reindex(sentences, base);
}

function reindex(sentences, base) {
  if (sentences.every((s) => s.els.length)) return sentences;
  const out = sentences.filter((s) => s.els.length);
  out.forEach((s, i) => s.els.forEach((el) => el.setAttribute('data-i', String(base + i))));
  return out;
}

function speakable(text, a, b, drops) {
  let s = '';
  for (let i = a; i < b; i++) if (!drops.includes(i)) s += text[i];
  return s
    .replace(/\[\s*\d+(?:\s*[,–-]\s*\d+)*\s*\]/g, '') // [12], [3–5]
    .replace(/\s+/g, ' ')
    .trim();
}

/** Removes all <nr-s> wrappers, restoring the original text nodes. */
export function unwrapAll(doc) {
  const parents = new Set();
  for (const el of doc.querySelectorAll('nr-s')) {
    const p = el.parentNode;
    if (!p) continue;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
    parents.add(p);
  }
  for (const p of parents) p.normalize();
}

/** Index of the sentence at or after a DOM position (used for "read from selection"). */
export function sentenceIndexAt(doc, node, offset, sentences) {
  if (!node) return -1;
  // The original text node may have been split; follow the pieces.
  if (node.nodeType === 3) {
    let t = node, off = offset;
    while (t && off > t.data.length) {
      off -= t.data.length;
      let next = t.parentNode && t.parentNode.nodeName === 'NR-S'
        ? (t.parentNode.nextSibling && t.parentNode.nextSibling.firstChild) || t.nextSibling
        : t.nextSibling;
      if (next && next.nodeName === 'NR-S') next = next.firstChild;
      if (!next || next.nodeType !== 3) break;
      t = next;
    }
    node = t;
  }
  const el = (node.nodeType === 1 ? node : node.parentElement);
  const hit = el && el.closest && el.closest('nr-s');
  if (hit) return +hit.getAttribute('data-i');
  for (let i = 0; i < sentences.length; i++) {
    const first = sentences[i].els[0];
    if (node.compareDocumentPosition(first) & 4) return i;
  }
  return -1;
}
