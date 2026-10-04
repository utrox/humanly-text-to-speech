import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export function wordList() {
  const lists = ['english/10', 'english/20', 'english/35', 'english/40', 'english/american/10', 'english/american/20',
    'english/american/35', 'english/american/40', 'english/british/10', 'english/british/20', 'english/british/35', 'english/british/40'];
  const all = require('wordlist-english');
  const set = new Set();
  for (const k of lists) for (const w of all[k]) if (!/[A-Z]/.test(w[0])) set.add(w.toLowerCase());
  return set;
}
