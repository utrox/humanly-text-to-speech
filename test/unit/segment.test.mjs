import { JSDOM } from 'jsdom';
import { segmentRoots, findMainRoots, unwrapAll, sentenceIndexAt } from '../../src/segment.js';
import assert from 'node:assert';

const html = `<!doctype html><html><body>
<header class="site-header"><nav><a href="/">Home</a> <a href="/about">About us</a></nav></header>
<main><article>
<h1>The Quiet Ocean</h1>
<p>Dr. Smith studied whales for 20 years. She found that they sing at night, e.g. near reefs.<sup><a href="#cite1">[1]</a></sup> Remarkable!</p>
<p>The <a href="/x">first study</a> was published in <em>Nature</em> in 1998. It changed the field.</p>
<ul><li>Whales are mammals.</li><li>They breathe air</li></ul>
<div class="share-buttons">Share this on Twitter. Share on Facebook.</div>
<p>Final thoughts: oceans are getting louder, and that matters a lot to whales, which rely on sound.</p>
<p>Line one<br>continues here.</p>
</article></main>
<aside class="sidebar"><p>Subscribe to our newsletter for more great stories, every single week, for free.</p></aside>
<footer>© 2026 Ocean News. All rights reserved.</footer>
</body></html>`;

const dom = new JSDOM(html);
const doc = dom.window.document;
global.Node = dom.window.Node;
const visible = () => true;

const roots = findMainRoots(doc);
console.log('roots:', roots.map(r => r.tagName));
const s = segmentRoots(roots, { mainOnly: true, visible });
s.forEach((x, i) => console.log(i, JSON.stringify(x.text), x.els.length));
const texts = s.map(x => x.text);
assert(texts.includes('The Quiet Ocean'));
assert(texts.includes('Dr. Smith studied whales for 20 years.'));
assert(!texts.some(t => /Subscribe|Share|rights|Home/.test(t)), 'noise leaked');
assert(!texts.some(t => /\[1\]/.test(t)), 'citation leaked');
assert(texts.includes('The first study was published in Nature in 1998.'));
assert(texts.includes('Line one continues here.'));
// highlight elements form the sentence text
assert.equal(s[1].els.map(e => e.textContent).join(''), 'Dr. Smith studied whales for 20 years.');
// link still contains its text
assert.equal(doc.querySelector('a[href="/x"]').textContent, 'first study');
// selection mapping: offset inside 2nd paragraph's "It changed"
const p2 = doc.querySelectorAll('article p')[1];
const before = p2.textContent;
const idx = sentenceIndexAt(doc, p2.querySelector('nr-s[data-i]').firstChild, 0, s);
console.log('sentence at p2 start:', idx, s[idx].text);
unwrapAll(doc);
assert.equal(doc.querySelectorAll('nr-s').length, 0);
assert.equal(doc.querySelectorAll('article p')[1].textContent, before);
assert.equal(doc.querySelectorAll('article p')[1].childNodes.length, 5, 'text nodes merged back');

// PDF mode: hyphen join across <br>, whole layer as one block
const pdom = new JSDOM(`<div class="textLayer"><span>The experi-</span><br><span>ment worked well. A</span><br><span>second sentence.</span></div>`);
const layer = pdom.window.document.querySelector('.textLayer');
const ps = segmentRoots([layer], { pdf: true, visible, blockOf: () => layer });
console.log(ps.map(x => x.text));
assert.deepEqual(ps.map(x => x.text), ['The experiment worked well.', 'A second sentence.']);
console.log('ALL OK');
