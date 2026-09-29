/**
 * Measures editing tools on the pinned corpus, with the harness in harness.ts.
 *
 *   npm run corpus && (cd bench/incumbents && npm ci) && npm run bench
 */
import { createRequire } from 'node:module';
import { Composer, CST, Parser, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml';
import type { Document, Pair } from 'yaml';
import { loadCorpus } from './corpus.ts';
import { KINDS, applyToData, dataOf, expectedAfter, judge, plan } from './harness.ts';
import type { Kind, Op, Seg } from './harness.ts';
import { mine } from './mine.ts';

const req = createRequire(new URL('./incumbents/package.json', import.meta.url));
const tryReq = (name: string): any => {
  try {
    return req(name);
  } catch (e) {
    console.error(`skipping ${name}: ${(e as Error).message.split('\n')[0]}`);
    return null;
  }
};
const tryImport = async (name: string): Promise<any> => {
  try {
    return await import(req.resolve(name));
  } catch (e) {
    console.error(`skipping ${name}: ${(e as Error).message.split('\n')[0]}`);
    return null;
  }
};

interface Tool {
  name: string;
  note: string;
  /** which op kinds the tool has any API for */
  kinds: Kind[];
  run: (src: string, op: Op) => string;
}

const ALL: Kind[] = ['set', 'rename', 'delete', 'insert', 'append'];

// ---- shared helpers
function detectIndent(src: string): { indent: number; indentSeq: boolean } {
  const hist = new Map<number, number>();
  let flush = 0;
  let indented = 0;
  const lines = src.split('\n').filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!;
    const b = lines[i]!;
    const ia = a.length - a.trimStart().length;
    const ib = b.length - b.trimStart().length;
    if (/:\s*(#.*)?$/.test(a) && b.trimStart().startsWith('- ')) {
      if (ib === ia) flush++;
      else if (ib > ia) indented++;
    } else if (ib > ia && /:\s*(#.*)?$/.test(a)) hist.set(ib - ia, (hist.get(ib - ia) ?? 0) + 1);
  }
  let best = 2;
  let n = 0;
  for (const [k, c] of hist) if (c > n) ((best = k), (n = c));
  return { indent: best, indentSeq: indented >= flush };
}

const ptr = (segs: readonly Seg[]): string => segs.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

function modifiedDocs(src: string, op: Op): unknown[] {
  return expectedAfter(src, op);
}

// ---- eemeli yaml Document API
function eemeli(tuned: boolean): Tool['run'] {
  return (src, op) => {
    const docs = parseAllDocuments(src) as Document.Parsed[];
    const doc = docs[0]!;
    const walk = (path: readonly Seg[]): any => (path.length ? doc.getIn(path, true) : doc.contents);
    switch (op.kind) {
      case 'set': {
        const n = doc.getIn(op.path, true);
        if (isScalar(n)) n.value = op.value;
        else doc.setIn(op.path, op.value);
        break;
      }
      case 'delete':
        doc.deleteIn(op.path);
        break;
      case 'rename': {
        const parent = walk(op.path.slice(0, -1));
        const old = op.path[op.path.length - 1];
        const pair = (parent.items as Pair[]).find((p) => isScalar(p.key) && p.key.value === old)!;
        (pair.key as any).value = op.key;
        break;
      }
      case 'insert':
        walk(op.path).set(op.key, op.value);
        break;
      case 'append':
        walk(op.path).add(op.value);
        break;
    }
    const o = tuned ? { ...detectIndent(src), lineWidth: 0, minContentWidth: 0, flowCollectionPadding: false } : {};
    return docs.map((d) => d.toString(o)).join('');
  };
}

// ---- eemeli yaml CST setScalarValue (set only)
const cstSet: Tool['run'] = (src, op) => {
  const tokens = [...new Parser().parse(src)];
  const docs = [...new Composer({ keepSourceTokens: true }).compose(tokens)] as Document.Parsed[];
  const n = docs[0]!.getIn(op.path, true) as any;
  if (!isScalar(n) || !n.srcToken) throw new Error('no scalar token');
  CST.setScalarValue(n.srcToken, op.value as string, { type: n.type });
  return tokens.map((t) => CST.stringify(t)).join('');
};

// ---- js-yaml family
function jsYamlTool(lib: any, load: string, dump: string, docsAll: boolean): Tool['run'] {
  return (src, op) => {
    const o = detectIndent(src);
    const docs: unknown[] = docsAll ? lib.loadAll(src) : [lib.load(src)];
    const first = applyToData(docs[0], op);
    const all = [first, ...docs.slice(1)];
    void load;
    void dump;
    return all.map((d) => lib.dump(d, { lineWidth: -1, indent: o.indent, noArrayIndent: !o.indentSeq })).join('---\n');
  };
}

async function main(): Promise<void> {
  const corpus = loadCorpus();
  if (!corpus) throw new Error('corpus missing: run `npm run corpus`');

  const tools: Tool[] = [];
  tools.push({ name: 'yaml-minimal-edit (this package)', note: 'byte splice', kinds: ALL, run: mine });
  tools.push({ name: 'yaml 2.9.1 Document API, best options', note: 'per-file indent/indentSeq, lineWidth 0, flowCollectionPadding off', kinds: ALL, run: eemeli(true) });
  tools.push({ name: 'yaml 2.9.1 Document API, defaults', note: 'toString() defaults', kinds: ALL, run: eemeli(false) });
  tools.push({ name: 'yaml 2.9.1 CST setScalarValue', note: 'set only', kinds: ['set'], run: cstSet });

  const jsy = tryReq('js-yaml') ?? (await tryImport('js-yaml'));
  if (jsy) tools.push({ name: 'js-yaml 5.4.2 load/dump', note: 'no preservation; indent detected', kinds: ALL, run: jsYamlTool(jsy, 'load', 'dump', true) });

  const cfn = tryReq('yaml-cfn');
  if (cfn) {
    tools.push({
      name: 'yaml-cfn 0.3.2 yamlParse/yamlDump',
      note: 'js-yaml with CloudFormation tags; no preservation',
      kinds: ALL,
      run: (src, op) => {
        const d = applyToData(cfn.yamlParse(src), op);
        return cfn.yamlDump(d);
      },
    });
  }

  const ydp = tryReq('yaml-diff-patch');
  if (ydp) {
    tools.push({
      name: 'yaml-diff-patch 2.0.0 yamlPatch',
      note: 'RFC 6902 ops applied to the yaml Document; rename is a move',
      kinds: ALL,
      run: (src, op) => {
        const pathOf = (s: readonly Seg[]): string => ptr(s);
        const ops: unknown[] = [];
        if (op.kind === 'set') ops.push({ op: 'replace', path: pathOf(op.path), value: op.value });
        else if (op.kind === 'delete') ops.push({ op: 'remove', path: pathOf(op.path) });
        else if (op.kind === 'insert') ops.push({ op: 'add', path: pathOf([...op.path, op.key!]), value: op.value });
        else if (op.kind === 'append') ops.push({ op: 'add', path: pathOf([...op.path, '-']), value: op.value });
        else ops.push({ op: 'move', from: pathOf(op.path), path: pathOf([...op.path.slice(0, -1), op.key!]) });
        return ydp.yamlPatch(src, ops);
      },
    });
  }

  const yawn = tryReq('yawn-yaml');
  if (yawn) {
    const YAWN = yawn.default ?? yawn;
    tools.push({
      name: 'yawn-yaml 3.0.0',
      note: 'assign the whole modified JSON; first document only',
      kinds: ALL,
      run: (src, op) => {
        const y = new YAWN(src);
        y.json = applyToData(y.json, op);
        return y.yaml;
      },
    });
  }

  const sync = await tryImport('@pnpm/yaml.document-sync');
  if (sync) {
    tools.push({
      name: '@pnpm/yaml.document-sync 1100.0.2 patchDocument',
      note: 'Document patched to match a modified object; preserveKeyOrder',
      kinds: ALL,
      run: (src, op) => {
        const docs = parseAllDocuments(src) as Document.Parsed[];
        const target = applyToData(docs[0]!.toJS(), op);
        sync.patchDocument(docs[0]!, target, { preserveKeyOrder: true, preserveScalarAliases: true, pruneEmptyValues: false });
        return docs.map((d) => d.toString({ lineWidth: 0 })).join('');
      },
    });
  }

  const eff = await tryImport('@effected/yaml');
  const eft = await tryImport('effect');
  if (eff && eft) {
    const { YamlFormat } = eff;
    const { Effect } = eft;
    tools.push({
      name: '@effected/yaml 0.18.0 YamlFormat.modifyToString',
      note: 'path-based modify; single-document; no rename API',
      kinds: ['set', 'delete', 'insert', 'append'],
      run: (src, op) => {
        const data = dataOf(src)!;
        let path: Seg[];
        let value: unknown = op.value;
        if (op.kind === 'insert') path = [...op.path, op.key!];
        else if (op.kind === 'append') {
          let cur: any = data[0];
          for (const s of op.path) cur = cur[s];
          path = [...op.path, (cur as unknown[]).length];
        } else if (op.kind === 'delete') {
          path = op.path;
          value = undefined;
        } else if (op.kind === 'set') path = op.path;
        else throw new Error('rename is not offered');
        return Effect.runSync(YamlFormat.modifyToString(src, path, value));
      },
    });
  }

  const yu = createRequire(new URL('./incumbents/legacy/package.json', import.meta.url))('yaml-update');
  if (yu) {
    tools.push({
      name: 'yaml-update 0.1.2 edit',
      note: 'edit(src, wholeNewData) with js-yaml 3; rewrites the top-level key it changes',
      kinds: ALL,
      run: (src, op) => yu.edit(src, JSON.stringify(applyToData(dataOf(src)![0], op))),
    });
  }

  const ye = tryReq('yaml-edit');
  if (ye) {
    tools.push({
      name: 'yaml-edit 0.1.3 insertChild',
      note: 'insert only, dotted mapping paths, 2-space indent assumed',
      kinds: ['insert'],
      run: (src, op) => {
        if (op.path.some((s) => typeof s === 'number') || op.path.length === 0) throw new Error('unsupported path');
        const e = ye(src);
        const r = e.insertChild(op.path.join('.'), { [op.key!]: op.value });
        if (r instanceof Error) throw r;
        return e.dump();
      },
    });
  }

  const yip = tryReq('yml-in-place');
  if (yip) {
    tools.push({
      name: 'yml-in-place 1.0.2 addToSequence',
      note: 'append a string to a sequence under a mapping path',
      kinds: ['append'],
      run: (src, op) => {
        if (op.path.some((s) => typeof s === 'number') || op.path.length === 0 || typeof op.value !== 'string') throw new Error('unsupported');
        const out = yip.addToSequence(src, op.path.join('.'), op.value);
        if (out === undefined) throw new Error('returned undefined');
        return out;
      },
    });
  }

  const only = process.env.TOOLS?.split(',');
  const selected = only ? tools.filter((t) => only.some((o) => t.name.includes(o))) : tools;

  const rows: Array<{ tool: Tool; tally: Record<string, [number, number]>; why: Map<string, number> }> = [];
  for (const tool of selected) {
    const tally: Record<string, [number, number]> = {};
    const why = new Map<string, number>();
    for (const f of corpus) {
      for (const op of plan(f.name, f.src)) {
        const t = (tally[op.kind] ??= [0, 0]);
        t[1]++;
        const eop: Op = op.kind === 'setstr' ? { ...op, kind: 'set' } : op;
        if (!tool.kinds.includes(eop.kind)) {
          why.set('no API for this edit', (why.get('no API for this edit') ?? 0) + 1);
          continue;
        }
        let reason = '';
        try {
          const out = tool.run(f.src, eop);
          const v = judge(f.src, out, op, modifiedDocs(f.src, op));
          if (v.ok) t[0]++;
          else reason = v.why.replace(/line \d+/, 'a line');
        } catch (e) {
          reason = `threw: ${(e as Error).message.split('\n')[0]!.slice(0, 70)}`;
        }
        if (reason) why.set(reason, (why.get(reason) ?? 0) + 1);
      }
    }
    rows.push({ tool, tally, why });
  }

  const pct = (t?: [number, number]): string => (t && t[1] ? `${((100 * t[0]) / t[1]).toFixed(1)}%` : 'n/a');
  const cell = (t?: [number, number]): string => (t ? `${t[0]}/${t[1]} ${pct(t)}` : 'n/a');
  console.log(`corpus: ${corpus.length} files, ${KINDS.map((k) => `${k} ${rows[0]?.tally[k]?.[1]}`).join(', ')}\n`);
  console.log(['tool', ...KINDS, 'all'].join(' | '));
  console.log(['---', ...KINDS.map(() => '---'), '---'].join(' | '));
  for (const r of rows) {
    const tot: [number, number] = [0, 0];
    for (const k of KINDS) {
      tot[0] += r.tally[k]?.[0] ?? 0;
      tot[1] += r.tally[k]?.[1] ?? 0;
    }
    console.log([r.tool.name, ...KINDS.map((k) => cell(r.tally[k])), cell(tot)].join(' | '));
  }
  console.log('');
  for (const r of rows) {
    const top = [...r.why.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w, n]) => `${w} (${n})`);
    console.log(`${r.tool.name}: ${top.join('; ') || 'no failures'}`);
  }
}

await main();
void isMap;
void isSeq;
