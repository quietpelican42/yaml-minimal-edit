import { loadCorpus } from './corpus.ts';
import { KINDS, expectedAfter, judge, plan } from './harness.ts';
import { mine } from './mine.ts';

const corpus = loadCorpus();
if (!corpus) throw new Error('run npm run corpus');
const tally: Record<string, [number, number]> = {};
const fails: string[] = [];
for (const f of corpus) {
  for (const op of plan(f.name, f.src)) {
    const t = (tally[op.kind] ??= [0, 0]);
    t[1]++;
    let why = '';
    try {
      const out = mine(f.src, op.kind === 'setstr' ? { ...op, kind: 'set' } : op);
      const v = judge(f.src, out, op, expectedAfter(f.src, op));
      if (v.ok) t[0]++;
      else why = v.why;
    } catch (e) {
      why = `threw ${(e as Error).message}`;
    }
    if (why) fails.push(`${f.name} ${op.kind} ${JSON.stringify(op.path)}: ${why}`);
  }
}
for (const k of KINDS) console.log(k, tally[k]);
console.log(fails.slice(0, Number(process.env.SHOW ?? 40)).join('\n'));
console.log('fails', fails.length);
