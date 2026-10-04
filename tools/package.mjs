// Packages a release into out/: the Firefox add-on (.xpi) and the Windows helper (.zip).
// Run `npm run package` (it builds first).
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zipSync } from 'fflate';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const { version } = JSON.parse(readFileSync(join(root, 'static/manifest.json'), 'utf8'));
const out = join(root, 'out');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

function collect(dir, prefix = '') {
  const files = {};
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) Object.assign(files, collect(p, prefix + name + '/'));
    else files[prefix + name] = readFileSync(p);
  }
  return files;
}

// Add-on: the contents of dist/ at the root of the archive.
const xpi = zipSync(collect(join(root, 'dist')), { level: 9 });
writeFileSync(join(out, `humanly-tts-${version}.xpi`), xpi);

// Helper: everything in helper/ inside a humanly-tts-helper/ folder.
const helperFiles = {};
for (const [name, data] of Object.entries(collect(join(root, 'helper')))) {
  if (/(^|\/)(venv|__pycache__)\/|\.(onnx|bin|wav)$/.test(name)) continue;
  helperFiles['humanly-tts-helper/' + name] = data;
}
helperFiles['humanly-tts-helper/LICENSE.txt'] = readFileSync(join(root, 'LICENSE'));
writeFileSync(join(out, 'humanly-tts-helper.zip'), zipSync(helperFiles, { level: 9 }));

for (const f of readdirSync(out)) console.log(relative(root, join(out, f)), (statSync(join(out, f)).size / 1e6).toFixed(1), 'MB');
