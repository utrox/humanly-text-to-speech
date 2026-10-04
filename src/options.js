import { getSettings, setSettings } from './settings.js';

const ids = ['interceptPdf', 'mainOnly', 'autoScroll'];
getSettings().then((s) => {
  for (const id of ids) {
    const el = document.getElementById(id);
    el.checked = !!s[id];
    el.addEventListener('change', () => setSettings({ [id]: el.checked }));
  }
});
document.getElementById('openPdf').addEventListener('click', () => {
  browser.tabs.create({ url: browser.runtime.getURL('viewer.html') });
});
document.getElementById('clearCache').addEventListener('click', async () => {
  const names = await caches.keys();
  await Promise.all(names.map((n) => caches.delete(n)));
  document.getElementById('status').textContent = 'Deleted. It downloads again the next time you press play.';
});

async function showStatus(recheck) {
  const el = document.getElementById('helper');
  el.textContent = 'Checking the voice engine…';
  try {
    const m = await browser.runtime.sendMessage({ t: 'engineStatus', recheck });
    el.textContent = m.helper === 'installed'
      ? 'Helper app: installed. The natural voice runs outside Firefox at full speed.'
      : m.helper === 'missing'
        ? 'Helper app: not found. Run install.bat from the helper folder, then click Check again.'
        : 'Voice engine: ' + (m.engine || 'not started');
  } catch (e) {
    el.textContent = 'Could not check the voice engine: ' + e.message;
  }
}
document.getElementById('recheck').addEventListener('click', () => showStatus(true));
showStatus(false);
