// Injected into web pages on demand (toolbar button, shortcut or context menu).
import { createReader } from './reader.js';

if (!window.__humanlyTtsLoaded) {
  window.__humanlyTtsLoaded = true;
  let reader = null;
  let opening = null;

  async function open() {
    if (reader) return reader;
    if (!opening) {
      opening = createReader({ mode: 'page', onClose: () => { reader = null; } })
        .then((r) => { reader = r; opening = null; return r; });
    }
    return opening;
  }

  browser.runtime.onMessage.addListener(async (msg) => {
    if (msg.t === 'toggle') {
      if (reader) reader.close();
      else await open();
    } else if (msg.t === 'readSelection') {
      // Capture the selection before the reader wraps (and splits) the text nodes.
      const sel = window.getSelection();
      const range = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0) : null;
      const node = range && range.startContainer, off = range && range.startOffset;
      const r = await open();
      if (sel) sel.removeAllRanges();
      if (!(node && r.startAt(node, off))) r.playFrom(r.firstVisible());
    }
  });
}
