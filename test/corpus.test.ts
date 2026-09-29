import assert from 'node:assert/strict';
import test from 'node:test';
import { loadCorpus } from '../bench/corpus.ts';
import { expectedAfter, judge, plan } from '../bench/harness.ts';
import { parse } from '../src/index.ts';

const corpus = loadCorpus();

test('real-world corpus: every planned edit is clean', { skip: corpus ? false : 'corpus not fetched: run `npm run corpus` (needs curl and network)' }, () => {
  assert.ok(corpus && corpus.length >= 40, 'the corpus has at least 40 files');
  const per = Number(process.env.PER_KIND ?? 8);
  const bad: string[] = [];
  let total = 0;
  for (const f of corpus!) {
    for (const op of plan(f.name, f.src, per)) {
      total++;
      try {
        const d = parse(f.src);
        const eop = op.kind === 'setstr' ? 'set' : op.kind;
        if (eop === 'set') d.set(op.path, op.value);
        else if (eop === 'delete') d.delete(op.path);
        else if (eop === 'rename') d.rename(op.path, op.key!);
        else if (eop === 'insert') d.insert(op.path, op.key!, op.value);
        else d.append(op.path, op.value);
        const v = judge(f.src, d.toString(), op, expectedAfter(f.src, op));
        if (!v.ok) bad.push(`${f.name} ${op.kind} ${JSON.stringify(op.path)}: ${v.why}`);
      } catch (e) {
        bad.push(`${f.name} ${op.kind} ${JSON.stringify(op.path)}: threw ${(e as Error).message}`);
      }
    }
  }
  assert.ok(total > 1000, `${total} ops`);
  assert.deepEqual(bad.slice(0, 10), [], `${bad.length} of ${total} edits were not clean`);
});

test('real-world corpus: parse then toString is byte-identical', { skip: corpus ? false : 'corpus not fetched: run `npm run corpus`' }, () => {
  for (const f of corpus!) assert.equal(parse(f.src).toString(), f.src, f.name);
});
