import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';

const out = 'dist';
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const shim = './src/shims/empty.js';
const common = { bundle: true, platform: 'browser', target: ['firefox140'], minify: true, legalComments: 'none', logLevel: 'warning' };

await Promise.all([
  esbuild.build({ ...common, entryPoints: ['src/background.js'], outfile: `${out}/background.js`, format: 'iife' }),
  esbuild.build({ ...common, entryPoints: ['src/content.js'], outfile: `${out}/content.js`, format: 'iife' }),
  esbuild.build({ ...common, entryPoints: ['src/options.js'], outfile: `${out}/options.js`, format: 'iife' }),
  esbuild.build({ ...common, entryPoints: ['src/viewer.js'], outfile: `${out}/viewer.js`, format: 'esm' }),
  esbuild.build({ ...common, entryPoints: ['src/pdf-worker.js'], outfile: `${out}/pdf.worker.js`, format: 'esm' }),
  esbuild.build({
    ...common, entryPoints: ['src/tts-worker.js'], outfile: `${out}/tts-worker.js`, format: 'esm',
    alias: { 'fs/promises': shim, fs: shim, path: shim, sharp: shim, 'onnxruntime-node': shim },
  }),
]);

cpSync('static', out, { recursive: true });
copyFileSync('src/page.css', `${out}/page.css`);

// ONNX runtime (must match the version transformers.js was built against).
mkdirSync(`${out}/ort`, { recursive: true });
copyFileSync('node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm', `${out}/ort/ort-wasm-simd-threaded.jsep.wasm`);

// English voice styles used by the player.
const { VOICES } = await import('./src/settings.js');
mkdirSync(`${out}/voices`, { recursive: true });
const available = new Set(readdirSync('node_modules/kokoro-js/voices'));
for (const v of VOICES) {
  if (!available.has(v.id + '.bin')) throw new Error('missing voice ' + v.id);
  copyFileSync(`node_modules/kokoro-js/voices/${v.id}.bin`, `${out}/voices/${v.id}.bin`);
}
// English word list used to repair PDFs with scrambled text.
const { wordList } = await import('./tools/words.mjs');
writeFileSync(`${out}/words.txt`, [...wordList()].join('\n'));

// License notices travel with the add-on.
copyFileSync('LICENSE', `${out}/LICENSE`);
copyFileSync('THIRD_PARTY_NOTICES.md', `${out}/THIRD_PARTY_NOTICES.md`);

console.log('built ->', out);
