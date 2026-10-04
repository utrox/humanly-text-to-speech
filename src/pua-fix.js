// Repairs PDF text whose fonts map letters to Unicode "private use" placeholders
// (U+E000–U+F8FF) instead of real characters. Some PDF producers do this; the page
// looks fine but the text layer reads as "T     ." This learns the mapping from the
// document itself: first constant shifts (a→U+E04B, b→U+E04C, …), then leftover
// symbols such as the "fi" ligature, checked against an English word list.

export const isPUA = (cp) => cp >= 0xe000 && cp <= 0xf8ff;

const LETTER_TARGETS = 'etaoinsrhldcumfpgwybvk';
const EXTRA_CANDIDATES = ['fi', 'fl', 'ff', 'ffi', 'ffl', '', '.', ',', ';', ':', '’', '-', '–', '—', '(', ')', '“', '”', '?', '!'];
const TOKEN_RE = /[\p{L}\p{M}\u{E000}-\u{F8FF}]+/gu;

/** Fraction of letter-like characters that are private-use placeholders. */
export function puaRatio(text) {
  let pua = 0, letters = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (isPUA(cp)) { pua++; letters++; } else if (/\p{L}/u.test(ch)) letters++;
  }
  return letters ? pua / letters : 0;
}

/**
 * Learns a decoder from sample text.
 * @param {string[]} samples  text from the document
 * @param {Set<string>} words lower-case English words
 * @returns {{map: Map<number,string>, decode(s:string):string, stats:object} | null}
 */
export function learnDecoder(samples, words) {
  const tokens = [];
  const freq = new Map();
  for (const s of samples) {
    for (const m of s.matchAll(TOKEN_RE)) {
      const t = m[0];
      let has = false;
      for (const ch of t) {
        const cp = ch.codePointAt(0);
        if (isPUA(cp)) { has = true; freq.set(cp, (freq.get(cp) || 0) + 1); }
      }
      if (has) tokens.push(t);
    }
  }
  if (!tokens.length) return null;
  // Keep the work bounded on huge documents.
  const sample = tokens.length > 20000 ? tokens.filter((_, i) => i % Math.ceil(tokens.length / 20000) === 0) : tokens;

  const map = new Map(); // codepoint -> string
  const decodeWith = (t, extra) => {
    let out = '';
    for (const ch of t) {
      const cp = ch.codePointAt(0);
      if (!isPUA(cp)) { out += ch; continue; }
      const v = extra && extra.has(cp) ? extra.get(cp) : map.get(cp);
      if (v === undefined) return null; // unknown placeholder left
      out += v;
    }
    return out;
  };
  const isWordish = (s) => {
    const parts = s.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
    return parts.length > 0 && parts.every((p) => words.has(p) || (p.length === 1 && /[aiu]/.test(p)));
  };

  // 1. Constant shifts. Try mapping the most common placeholders to common letters.
  const byFreq = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([cp]) => cp);
  for (let round = 0; round < 3; round++) {
    const unmapped = byFreq.filter((cp) => !map.has(cp));
    if (!unmapped.length) break;
    const offsets = new Set();
    for (const cp of unmapped.slice(0, 6)) {
      for (const L of LETTER_TARGETS) {
        offsets.add(cp - L.charCodeAt(0));
        offsets.add(cp - L.toUpperCase().charCodeAt(0));
      }
    }
    let best = null, bestScore = 0;
    for (const d of offsets) {
      const extra = new Map();
      for (const cp of unmapped) {
        const c = cp - d;
        if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57)) extra.set(cp, String.fromCharCode(c));
      }
      if (extra.size < 5) continue; // a real alphabet shift covers many letters
      let score = 0, touched = 0, good = 0;
      for (const t of sample) {
        let hits = false;
        for (const ch of t) if (extra.has(ch.codePointAt(0))) { hits = true; break; }
        if (!hits) continue;
        touched++;
        const s = decodeWith(t, extra);
        if (s && isWordish(s)) { score += s.length; good++; }
      }
      // Most words containing these codes must become real words, or it's a coincidence.
      if (touched && good / touched < 0.5) continue;
      if (score > bestScore) { bestScore = score; best = extra; }
    }
    if (!best || bestScore < 20) break;
    for (const [cp, v] of best) map.set(cp, v);
  }
  if (!map.size) return null;

  // 2. Leftovers (ligatures, punctuation): pick the candidate that turns most tokens into words.
  const leftovers = byFreq.filter((cp) => !map.has(cp));
  for (const cp of leftovers) {
    const ts = sample.filter((t) => t.includes(String.fromCodePoint(cp)));
    let best = '', bestScore = -1;
    for (const cand of EXTRA_CANDIDATES) {
      const extra = new Map([[cp, cand]]);
      for (const other of leftovers) if (other !== cp && !map.has(other)) extra.set(other, '');
      let score = 0;
      for (const t of ts) {
        const s = decodeWith(t, extra);
        if (s && isWordish(s)) score++;
      }
      if (score > bestScore) { bestScore = score; best = cand; }
    }
    map.set(cp, bestScore >= 2 ? best : '');
  }

  // 3. Refine: re-check each code on its own against the alternatives. Fixes cases where a
  //    shift claimed a code that is really a ligature in another font ("Aeld" -> "field").
  for (const cp of byFreq) {
    const ch = String.fromCodePoint(cp);
    const ts = sample.filter((t) => t.includes(ch));
    if (ts.length < 2) continue;
    const scoreOf = (cand) => {
      const extra = new Map([[cp, cand]]);
      let n = 0;
      for (const t of ts) { const s = decodeWith(t, extra); if (s && isWordish(s)) n++; }
      return n;
    };
    const cur = map.get(cp);
    let best = cur, bestScore = scoreOf(cur);
    for (const cand of EXTRA_CANDIDATES) {
      if (cand === cur) continue;
      const sc = scoreOf(cand);
      if (sc > bestScore * 1.5 + 1) { best = cand; bestScore = sc; }
    }
    map.set(cp, best);
  }

  const decode = (s) => {
    let out = '';
    for (const ch of s) {
      const cp = ch.codePointAt(0);
      out += isPUA(cp) ? (map.has(cp) ? map.get(cp) : '') : ch;
    }
    return out;
  };
  let ok = 0;
  for (const t of sample) { const s = decode(t); if (isWordish(s)) ok++; }
  return { map, decode, stats: { tokens: sample.length, wordRate: ok / sample.length } };
}
