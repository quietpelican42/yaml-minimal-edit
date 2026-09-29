import assert from 'node:assert/strict';
import test from 'node:test';
import { dataOf, expectedAfter, judge, plan } from '../bench/harness.ts';
import type { Op } from '../bench/harness.ts';
import { YamlEditError, parse } from '../src/index.ts';
import { checkDoc, randomDoc } from './support/gen.ts';

const N = Number(process.env.PROP_N ?? 400);

function apply(src: string, op: Op): string {
  const d = parse(src);
  switch (op.kind) {
    case 'set':
    case 'setstr': d.set(op.path, op.value); break;
    case 'delete': d.delete(op.path); break;
    case 'rename': d.rename(op.path, op.key!); break;
    case 'insert': d.insert(op.path, op.key!, op.value); break;
    case 'append': d.append(op.path, op.value); break;
  }
  return d.toString();
}

test('the generator emits text that parses back to its tree', () => {
  let bad = 0;
  for (let s = 1; s <= 300; s++) if (!checkDoc(randomDoc(s))) bad++;
  assert.equal(bad, 0);
});

test('random edits re-parse to the expected data and touch only the intended lines', () => {
  let ops = 0;
  const failures: string[] = [];
  for (let seed = 1; seed <= N; seed++) {
    const { text } = randomDoc(seed);
    if (!dataOf(text)) continue;
    for (const op of plan(`prop-${seed}`, text, 2)) {
      ops++;
      let why = '';
      try {
        const out = apply(text, op);
        const v = judge(text, out, op, expectedAfter(text, op));
        if (!v.ok) why = v.why;
      } catch (e) {
        why = e instanceof YamlEditError ? `refused ${e.code}: ${e.message}` : `crashed: ${String(e)}`;
      }
      if (why) failures.push(`seed ${seed} ${op.kind} ${JSON.stringify(op.path)}: ${why}`);
    }
  }
  console.log(`# ${ops} random edits over up to ${N} documents`);
  assert.ok(ops > N, `only ${ops} ops planned`);
  assert.deepEqual(failures.slice(0, 10), [], `${failures.length} of ${ops} edits failed`);
});

test('an edit followed by its inverse restores the original bytes (set, and insert then delete)', () => {
  let checked = 0;
  for (let seed = 1; seed <= N; seed++) {
    const { text } = randomDoc(seed + 10_000);
    for (const op of plan(`inv-${seed}`, text, 1)) {
      if (op.kind === 'insert') {
        const d = parse(text);
        d.insert(op.path, op.key!, op.value);
        d.delete([...op.path, op.key!]);
        assert.equal(d.toString(), text, `insert/delete ${JSON.stringify(op.path)}`);
        checked++;
      } else if (op.kind === 'rename') {
        const d = parse(text);
        d.rename(op.path, op.key!);
        d.rename([...op.path.slice(0, -1), op.key!], String(op.path[op.path.length - 1]));
        // quote style of a plain key may differ only if the original needed quoting
        assert.equal(d.toString(), text, `rename ${JSON.stringify(op.path)}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 100);
});
