// Runs the unit tests. The helper test needs Python, kokoro-onnx and the model files, so it
// only runs with --helper (see CONTRIBUTING.md).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('./unit/', import.meta.url));
const tests = ['segment', 'pua', 'audio-check', 'background', 'engines'];
if (process.argv.includes('--helper')) tests.push('host');

let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [dir + t + '.test.mjs'], { encoding: 'utf8' });
  const ok = r.status === 0 && /ALL OK/.test(r.stdout);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t}`);
  if (!ok) { failed++; console.log(r.stdout.slice(-2000), r.stderr.slice(-2000)); }
}
console.log(failed ? `\n${failed} test file(s) failed` : '\nAll tests passed');
process.exit(failed ? 1 : 0);
