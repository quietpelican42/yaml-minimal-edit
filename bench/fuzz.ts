/**
 * Fuzz run. Random documents (generated and corpus files), sequences of random edits with random
 * values, and byte-mutated inputs. Every result is checked independently of the library:
 * the output must parse, equal the intended data, and leave the lines around the edit alone.
 * A refusal (YamlEditError) is allowed but counted; any other exception, wrong data or
 * a changed text after a refusal fails the run.
 *
 *   FUZZ_SECONDS=60 npm run fuzz
 */
import { loadCorpus } from './corpus.ts';
import { applyToData, dataOf } from './harness.ts';
import type { Op } from './harness.ts';
import { plan } from './harness.ts';
import { YamlEditError, parse } from '../src/index.ts';
import { makeRng, randomDoc, randomTree } from '../test/support/gen.ts';
import type { Rnd, Tree } from '../test/support/gen.ts';

const seconds = Number(process.env.FUZZ_SECONDS ?? 60);
const deadline = Date.now() + seconds * 1000;
const seed0 = Number(process.env.FUZZ_SEED ?? 1);

const counts = { docs: 0, ops: 0, ok: 0, hostileParsed: 0, hostileRejected: 0 };
const refusals = new Map<string, number>();
const failures: string[] = [];
const fail = (m: string): void => void (failures.length < 20 && failures.push(m));

const WEIRD = ['', ' ', 'a b', "it's", 'q"uote', 'a: b', '#c', '- d', '1.20', 'yes', '~', 'é中', 'x\ty', '\\', '*a', '&a', '!t', '%', '@', '|', '>', '{', '[', ',', '?', ':', '---', '...', 'multi\nline', '  lead', 'trail  '];

function randomValue(r: Rnd): unknown {
  const k = r();
  if (k < 0.4) return WEIRD[Math.floor(r() * WEIRD.length)];
  if (k < 0.5) return Math.floor(r() * 1e6) / (r() < 0.5 ? 1 : 100);
  if (k < 0.55) return r() < 0.5;
  if (k < 0.6) return null;
  return randomTree(r, 2 + Math.floor(r() * 2)) as unknown;
}

const stripCr = (l: string): string => l.replace(/\r$/, '');

/** The lines outside the edited region must be untouched. */
function outsideOk(src: string, out: string, op: Op): string {
  const A = src.split('\n').map(stripCr);
  const B = out.split('\n').map(stripCr);
  if (op.kind === 'insert' || op.kind === 'append') {
    let p = 0;
    while (p < A.length && p < B.length && A[p] === B[p]) p++;
    const rest = A.slice(p);
    const tail = B.slice(B.length - rest.length);
    return rest.length <= B.length && rest.every((l, i) => l === tail[i]) ? '' : 'existing lines changed';
  }
  if (op.kind === 'delete' && op.inline) {
    return out === src.slice(0, op.inline.start) + src.slice(op.inline.end) ? '' : 'not the minimal removal of a first key on a dash line';
  }
  const lo = Math.max(0, op.first - (op.kind === 'delete' ? op.commentsAbove : op.kind === 'set' || op.kind === 'setstr' ? 1 : 0));
  const head = A.slice(0, lo);
  const after = A.slice(op.last + 1);
  if (!head.every((l, i) => l === B[i])) return 'lines before the edit changed';
  if (op.kind === 'delete' || op.kind === 'rename') {
    // a dash-line delete rewrites the target line; everything else is exact
  }
  const tail = after.length ? B.slice(B.length - after.length) : [];
  if (!after.every((l, i) => l === tail[i])) return 'lines after the edit changed';
  return '';
}

function runOp(src: string, op: Op, value: unknown, label: string): string | null {
  const d = parse(src);
  counts.ops++;
  let out: string;
  try {
    if (op.kind === 'set' || op.kind === 'setstr') d.set(op.path, value);
    else if (op.kind === 'delete') d.delete(op.path);
    else if (op.kind === 'rename') d.rename(op.path, op.key!);
    else if (op.kind === 'insert') d.insert(op.path, op.key!, value);
    else d.append(op.path, value);
    out = d.toString();
  } catch (e) {
    if (e instanceof YamlEditError) {
      refusals.set(e.code, (refusals.get(e.code) ?? 0) + 1);
      if (e.code === 'VERIFY') fail(`${label} ${op.kind} ${JSON.stringify(op.path)}: VERIFY refusal (planner bug): ${e.message} ${process.env.FUZZ_DUMP ? JSON.stringify(src.slice(0, 600)) + ' value=' + JSON.stringify(value) + ' key=' + op.key : ''}`);
      if (d.toString() !== src) fail(`${label}: text changed after a refusal`);
      return null;
    }
    fail(`${label} ${op.kind} ${JSON.stringify(op.path)}: crashed: ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
    return null;
  }
  const got = dataOf(out);
  const docs = dataOf(src)!;
  const norm = (v: unknown): unknown => (typeof v === 'bigint' ? Number(v) : v);
  const exp = applyToData(docs[0], { ...op, value: norm(value) } as Op);
  if (!got) {
    fail(`${label} ${op.kind} ${JSON.stringify(op.path)}: output does not parse`);
    return null;
  }
  if (JSON.stringify([exp, ...docs.slice(1)]) !== JSON.stringify(got)) {
    fail(`${label} ${op.kind} ${JSON.stringify(op.path)}: data differs from expected`);
    return null;
  }
  const why = outsideOk(src, out, op);
  if (why) {
    fail(`${label} ${op.kind} ${JSON.stringify(op.path)}: ${why}`);
    return null;
  }
  counts.ok++;
  return out;
}

function session(name: string, src0: string, r: Rnd, steps: number): void {
  let src = src0;
  counts.docs++;
  for (let i = 0; i < steps; i++) {
    const ops = plan(`${name}-${i}-${Math.floor(r() * 1e9)}`, src, 1);
    if (ops.length === 0) return;
    const op = ops[Math.floor(r() * ops.length)]!;
    const value = op.kind === 'delete' || op.kind === 'rename' ? undefined : r() < 0.5 ? op.value : randomValue(r);
    const next = runOp(src, op, value, `${name}#${i}`);
    if (next !== null) src = next;
  }
}

function mutate(text: string, r: Rnd): string {
  const n = 1 + Math.floor(r() * 3);
  let s = text;
  const junk = [':', '- ', '#', '\n', ' ', '"', "'", '&a ', '*a', '{', '}', '[', ']', '|\n', '\t', ',', '? ', '---\n', '!!str '];
  for (let i = 0; i < n; i++) {
    const at = Math.floor(r() * (s.length + 1));
    const k = r();
    if (k < 0.4) s = s.slice(0, at) + junk[Math.floor(r() * junk.length)] + s.slice(at);
    else if (k < 0.7) s = s.slice(0, at) + s.slice(at + 1 + Math.floor(r() * 3));
    else s = s.slice(0, at) + s.slice(Math.max(0, at - 1 - Math.floor(r() * 6)), at) + s.slice(at);
  }
  return s;
}

const corpus = loadCorpus() ?? [];
if (corpus.length === 0) console.error('corpus not fetched (npm run corpus); fuzzing generated documents only');
let n = 0;
while (Date.now() < deadline) {
  const seed = seed0 + n++;
  const r = makeRng(seed * 7919);
  const roll = r();
  if (roll < 0.45 || corpus.length === 0) {
    session(`gen${seed}`, randomDoc(seed).text, r, 6);
  } else if (roll < 0.7) {
    const f = corpus[Math.floor(r() * corpus.length)]!;
    session(f.name, f.src, r, 4);
  } else {
    const base = roll < 0.85 || corpus.length === 0 ? randomDoc(seed).text : corpus[Math.floor(r() * corpus.length)]!.src;
    const m = mutate(base, r);
    let parsed = true;
    try {
      parse(m);
    } catch (e) {
      parsed = false;
      counts.hostileRejected++;
      if (!(e instanceof YamlEditError && e.code === 'PARSE')) fail(`mutated input threw a non-PARSE error: ${String(e).slice(0, 120)}`);
    }
    if (parsed && dataOf(m) && !/\r(?!\n)/.test(m)) {
      counts.hostileParsed++;
      session(`mut${seed}`, m, r, 3);
    }
  }
}

console.log(`fuzz ${seconds}s seed ${seed0}..${seed0 + n - 1}`);
console.log(JSON.stringify(counts));
console.log('refusals by code:', JSON.stringify(Object.fromEntries(refusals)));
console.log(`failures: ${failures.length}`);
for (const f of failures) console.log('  ' + f);
process.exit(failures.length ? 1 : 0);
void (undefined as unknown as Tree);
