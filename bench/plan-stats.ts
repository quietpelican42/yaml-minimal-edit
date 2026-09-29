import { KINDS, plan } from './harness.ts';
import { loadCorpus } from './corpus.ts';
const c = loadCorpus();
if (!c) throw new Error('run npm run corpus');
const n: Record<string, number> = {};
for (const f of c) for (const op of plan(f.name, f.src)) n[op.kind] = (n[op.kind] ?? 0) + 1;
console.log(c.length, 'files', n, KINDS);
