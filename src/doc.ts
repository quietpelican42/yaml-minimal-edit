import { isAlias, isMap, isScalar, isSeq, parseAllDocuments, parseDocument } from 'yaml';
import type { Document, Pair, Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { YamlEditError } from './errors.ts';
import { appendAt, deleteAt, insertAt, normalise, renameAt, same, seqIndex, setAt } from './expect.ts';
import { parsePath, showPath } from './path.ts';
import type { Path, Seg } from './path.ts';
import { doubleQuote, isCollection, plainSafe, renderKey, renderString, renderTyped, singleQuote, singleQuoteOk } from './scalar.ts';
import { analyse, flowText, itemLines, pairLines, render, siblingsFlow } from './style.ts';
import type { Style } from './style.ts';
import { applySplices, blockSeqDashes, colOf, contentLineEnd, lineEnd, lineStart, nextLine, trimBack } from './text.ts';
import type { Splice } from './text.ts';

export interface EditOptions {
  /** Which document of a multi-document stream to edit (0-based). Default 0. */
  document?: number;
}

export interface InsertOptions extends EditOptions {
  /** Insert after this sibling key. */
  after?: string;
  /** Insert before this sibling key. */
  before?: string;
  /** Insert as the first key. */
  first?: boolean;
}

type Parsed = Document.Parsed;
type Coll = YAMLMap | YAMLSeq;

interface Loc {
  node: unknown;
  parent: Coll | null;
  pair: Pair | null;
  index: number;
}

interface Plan {
  splices: Splice[];
  /** Applies the intended change to plain data and returns the new root. */
  expect: (root: unknown) => unknown;
}

function parseAll(src: string): Parsed[] {
  const opts = { keepSourceTokens: true, prettyErrors: false };
  const docs = parseAllDocuments(src, opts) as Parsed[];
  return docs.length ? docs : [parseDocument(src, opts) as Parsed];
}

function firstError(docs: Parsed[], src: string): string | null {
  for (const d of docs) {
    const e = d.errors[0];
    if (e) {
      const line = src.slice(0, e.pos[0]).split('\n').length;
      return `${e.message.split('\n')[0]} (line ${line})`;
    }
  }
  return null;
}

const keyMatches = (k: unknown, seg: Seg): boolean => isScalar(k) && String(k.value) === String(seg);

const isEmptyScalar = (n: unknown): boolean => isScalar(n) && n.range != null && n.range[0] === n.range[1];

/** Start of a key or value including any `&anchor` / `!tag` props before it. */
function withProps(s: string, off: number): number {
  const ls = lineStart(s, off);
  const m = /(?:[&!][^\s,[\]{}]*[ \t]+)+$/.exec(s.slice(ls, off));
  return m ? ls + m.index : off;
}

function keyStart(s: string, p: Pair): number {
  return withProps(s, (p.key as Scalar).range![0]);
}

function findColon(s: string, p: Pair): number {
  const k = p.key as Scalar;
  let o = k.range![1];
  while (o < s.length && (s[o] === ' ' || s[o] === '\t')) o++;
  return s[o] === ':' ? o : -1;
}

/** End offset of the last content character of an entry / node. */
function nodeEnd(s: string, n: unknown, dashOf?: (i: number) => number): number {
  if (isScalar(n) || isAlias(n)) return n.range![1];
  if (isMap(n)) {
    if (n.flow) return n.range![1];
    return pairEnd(s, n.items[n.items.length - 1]!);
  }
  if (isSeq(n)) {
    if (n.flow) return n.range![1];
    return itemEnd(s, n, n.items.length - 1, dashOf);
  }
  return 0;
}

function pairEnd(s: string, p: Pair): number {
  const k = p.key as Scalar;
  const v = p.value;
  if (v == null || isEmptyScalar(v)) {
    const c = findColon(s, p);
    return c >= 0 ? c + 1 : k.range![1];
  }
  return Math.max(k.range![1], trimBack(s, nodeEnd(s, v)));
}

function itemEnd(s: string, seq: YAMLSeq, i: number, dashOf?: (i: number) => number): number {
  const it = seq.items[i];
  if (it == null || isEmptyScalar(it)) return (dashOf ?? ((j) => blockSeqDashes(seq)[j]!))(i) + 1;
  return trimBack(s, nodeEnd(s, it));
}

/** Explicit (`?`) keys and collection keys: structural edits near them are refused. */
function hasComplexKeys(src: string, root: unknown): boolean {
  let found = false;
  const visit = (n: unknown): void => {
    if (found || !n) return;
    if (isMap(n)) {
      for (const p of n.items) {
        const k = p.key as { range?: [number, number, number] } | null;
        if (!isScalar(p.key) || !k?.range || k.range[0] === k.range[1] || /\?[ \t]*$/.test(src.slice(lineStart(src, k.range[0]), k.range[0]))) {
          found = true;
          return;
        }
        visit(p.value);
      }
    } else if (isSeq(n)) n.items.forEach(visit);
  };
  visit(root);
  return found;
}

function referencedAnchors(root: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (n: unknown): void => {
    if (isAlias(n)) out.add(n.source);
    else if (isMap(n)) for (const p of n.items) (visit(p.key), visit(p.value));
    else if (isSeq(n)) n.items.forEach(visit);
  };
  visit(root);
  return out;
}

function subtreeAnchors(n: unknown, refs: Set<string>): string | null {
  let hit: string | null = null;
  const visit = (x: unknown): void => {
    if (hit || !x) return;
    if ((isScalar(x) || isMap(x) || isSeq(x)) && x.anchor && refs.has(x.anchor)) hit = x.anchor;
    if (isMap(x)) for (const p of x.items) (visit(p.key), visit(p.value));
    else if (isSeq(x)) x.items.forEach(visit);
  };
  visit(n);
  return hit;
}

export class Doc {
  #src: string;
  #docs: Parsed[];

  constructor(src: string) {
    const docs = parseAll(src);
    const err = firstError(docs, src);
    if (err) throw new YamlEditError('PARSE', `invalid YAML: ${err}`);
    try {
      for (const d of docs) d.toJS();
    } catch (e) {
      throw new YamlEditError('PARSE', `invalid YAML: ${(e as Error).message}`);
    }
    this.#src = src;
    this.#docs = docs;
  }

  /** Number of documents in the stream. */
  get documents(): number {
    return this.#docs.length;
  }

  toString(): string {
    return this.#src;
  }

  /** The value at `path` as plain data. */
  get(path: Path, opts: EditOptions = {}): unknown {
    const segs = parsePath(path);
    const d = this.#doc(opts);
    let cur: unknown = d.toJS();
    for (const s of segs) {
      if (cur === null || typeof cur !== 'object') throw new YamlEditError('NOT_FOUND', `no value at ${showPath(segs)}`);
      const k = Array.isArray(cur) ? seqIndex(s) : String(s);
      if (!Object.hasOwn(cur, k)) throw new YamlEditError('NOT_FOUND', `no value at ${showPath(segs)}`);
      cur = (cur as Record<string | number, unknown>)[k];
    }
    return cur;
  }

  has(path: Path, opts: EditOptions = {}): boolean {
    try {
      this.get(path, opts);
      return true;
    } catch (e) {
      if (e instanceof YamlEditError && e.code === 'NOT_FOUND') return false;
      throw e;
    }
  }

  /** Replaces the value at `path`. A string over a string keeps its quote style. */
  set(path: Path, value: unknown, opts: EditOptions = {}): this {
    const segs = parsePath(path);
    return this.#run(opts, (d, di) => this.#planSet(d, segs, value, di));
  }

  /** Removes the key or sequence item at `path`, with the comment lines directly above it. */
  delete(path: Path, opts: EditOptions = {}): this {
    const segs = parsePath(path);
    return this.#run(opts, (d) => this.#planDelete(d, segs));
  }

  /** Renames the key at `path`; the value, its position and the surrounding bytes stay. */
  rename(path: Path, newKey: string, opts: EditOptions = {}): this {
    const segs = parsePath(path);
    return this.#run(opts, (d) => this.#planRename(d, segs, newKey));
  }

  /** Adds `key: value` to the mapping at `path` (last by default). */
  insert(path: Path, key: string, value: unknown, opts: InsertOptions = {}): this {
    const segs = parsePath(path);
    return this.#run(opts, (d) => this.#planInsert(d, segs, key, value, opts));
  }

  /** Adds an item to the end of the sequence at `path`. */
  append(path: Path, value: unknown, opts: EditOptions = {}): this {
    const segs = parsePath(path);
    return this.#run(opts, (d) => this.#planAppend(d, segs, value));
  }

  // ------------------------------------------------------------------ plumbing

  #doc(opts: EditOptions): Parsed {
    const i = opts.document ?? 0;
    const d = this.#docs[i];
    if (!d) throw new YamlEditError('NOT_FOUND', `document ${i} does not exist (the stream has ${this.#docs.length})`);
    return d;
  }

  #run(opts: EditOptions, plan: (d: Parsed, di: number) => Plan): this {
    const di = opts.document ?? 0;
    const d = this.#doc(opts);
    const { splices, expect } = plan(d, di);
    const next = applySplices(this.#src, splices);
    const nd = parseAll(next);
    const err = firstError(nd, next);
    if (err) throw new YamlEditError('VERIFY', `the edit produced invalid YAML, so nothing was changed: ${err}`);
    const want = this.#docs.map((x) => x.toJS());
    want[di] = expect(want[di]);
    let got: unknown[];
    try {
      got = nd.map((x) => x.toJS());
    } catch (e) {
      throw new YamlEditError('VERIFY', `the edit produced invalid YAML, so nothing was changed: ${(e as Error).message}`);
    }
    if (got.length !== want.length || !same(got, want)) {
      throw new YamlEditError('VERIFY', 'the edited text does not re-parse to the intended data, so nothing was changed');
    }
    this.#src = next;
    this.#docs = nd;
    return this;
  }

  #locate(d: Parsed, segs: Seg[]): Loc[] {
    const root = d.contents as unknown;
    const chain: Loc[] = [{ node: root, parent: null, pair: null, index: -1 }];
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]!;
      const here = showPath(segs.slice(0, i + 1));
      if (isAlias(node)) {
        throw new YamlEditError('ALIAS', `${showPath(segs.slice(0, i))} is the alias *${node.source}; editing through an alias is not supported (edit the anchor's own path instead)`);
      }
      if (isMap(node)) {
        const idx = node.items.findIndex((p) => keyMatches(p.key, seg));
        if (idx < 0) throw new YamlEditError('NOT_FOUND', `no key at ${here}`);
        const pair = node.items[idx]!;
        chain.push({ node: pair.value, parent: node, pair, index: idx });
        node = pair.value;
      } else if (isSeq(node)) {
        const idx = seqIndex(seg);
        if (idx < 0 || idx >= node.items.length) throw new YamlEditError('NOT_FOUND', `no item at ${here}`);
        chain.push({ node: node.items[idx], parent: node, pair: null, index: idx });
        node = node.items[idx];
      } else {
        throw new YamlEditError('NOT_FOUND', `${showPath(segs.slice(0, i))} is not a collection, so ${here} does not exist`);
      }
    }
    return chain;
  }

  #guardAnchors(d: Parsed, chain: Loc[], subtree: unknown): void {
    const refs = referencedAnchors(d.contents);
    if (refs.size === 0) return;
    for (const l of chain) {
      const n = l.node;
      if ((isScalar(n) || isMap(n) || isSeq(n)) && n.anchor && refs.has(n.anchor)) {
        throw new YamlEditError('ANCHOR', `the target is, or is inside, the anchor &${n.anchor}, which is referenced by an alias; the edit would also change the alias sites`);
      }
    }
    const inner = subtreeAnchors(subtree, refs);
    if (inner) throw new YamlEditError('ANCHOR', `the target contains the anchor &${inner}, which is referenced by an alias`);
  }

  #styleFor(d: Parsed, siblings: unknown[]): Style {
    return analyse(this.#src, d.contents, siblings);
  }

  // ------------------------------------------------------------------ set

  #planSet(d: Parsed, segs: Seg[], value: unknown, di: number): Plan {
    void di;
    if (value === undefined) throw new YamlEditError('VALUE', 'cannot set a value to undefined; use delete()');
    const s = this.#src;
    const chain = this.#locate(d, segs);
    const loc = chain[chain.length - 1]!;
    this.#guardAnchors(d, chain, loc.node);
    const expected = normalise(value);
    const expect = (root: unknown): unknown => setAt(root, segs, expected);
    const target = loc.node;
    const siblings = loc.parent ? (isMap(loc.parent) ? loc.parent.items.map((p) => p.value) : loc.parent.items) : [];
    const st = this.#styleFor(d, siblings as unknown[]);

    if (d.contents == null) return { splices: this.#fillEmptyDoc(value, st, d), expect };
    if (isScalar(target) && !Array.isArray(value) && !isCollection(value)) {
      return { splices: [this.#scalarSplice(target, loc, value, st)], expect };
    }
    if (isAlias(target) && !Array.isArray(value) && !isCollection(value)) {
      const r = render(value, 0, st, true);
      return { splices: [{ start: target.range![0], end: target.range![1], text: r.inline! }], expect };
    }
    return { splices: [this.#replaceValue(loc, value, st, chain)], expect };
  }

  #scalarSplice(t: Scalar, loc: Loc, value: unknown, st: Style): Splice {
    const s = this.#src;
    const [a, b] = t.range as [number, number, number];
    const isBlock = t.type === 'BLOCK_LITERAL' || t.type === 'BLOCK_FOLDED';
    let text: string;
    if (typeof value === 'string') {
      if (t.type === 'QUOTE_DOUBLE') text = doubleQuote(value);
      else if (t.type === 'QUOTE_SINGLE') text = singleQuoteOk(value) ? singleQuote(value) : doubleQuote(value);
      else if (isBlock && typeof t.value === 'string') {
        return this.#blockScalarSplice(t, loc, value, st);
      } else if (typeof t.value === 'string') text = renderString(value, 'plain', st.fallback);
      else text = renderString(value, st.quote, st.fallback);
    } else text = renderTyped(value);
    if (a === b) {
      // empty value: `key:` or `-`
      if (loc.pair) {
        const c = findColon(s, loc.pair);
        return { start: c + 1, end: c + 1, text: ` ${text}` };
      }
      const dash = blockSeqDashes(loc.parent as YAMLSeq)[loc.index]!;
      return { start: dash + 1, end: dash + 1, text: ` ${text}` };
    }
    const end = isBlock ? trimBack(s, b) : b;
    return { start: a, end, text };
  }

  #blockScalarSplice(t: Scalar, loc: Loc, value: string, st: Style): Splice {
    const s = this.#src;
    const [a, b] = t.range as [number, number, number];
    const end = trimBack(s, b);
    const headEnd = lineEnd(s, a);
    const header = s.slice(a, contentLineEnd(s, a));
    const m = /^([|>])([1-9]?)([+-]?)([1-9]?)(.*)$/.exec(header);
    const body = value.replace(/\n+$/, '');
    const trailing = value.length - body.length;
    const bad = body === '' || /^[ \t]/.test(body) || /[\r\u0000-\u0008\u000b-\u001f\u007f]/.test(body) || /[ \t]\n/.test(body + '\n') || body.startsWith('\n');
    if (!m || bad || headEnd >= s.length) {
      return { start: a, end, text: doubleQuote(value) };
    }
    let indentN = 0;
    for (let o = nextLine(s, a); o < end; o = nextLine(s, o)) {
      const ln = s.slice(o, lineEnd(s, o));
      if (ln.trim() !== '') {
        indentN = ln.length - ln.trimStart().length;
        break;
      }
    }
    if (indentN === 0) indentN = (loc.pair ? colOf(s, keyStart(s, loc.pair)) : 0) + st.step;
    const folded = m[1] === '>' && !body.includes('\n');
    const chomp = trailing === 0 ? '-' : trailing === 1 ? '' : '+';
    const head = `${folded ? '>' : '|'}${chomp}${m[5] ?? ''}`;
    const lines = body.split('\n').map((l) => (l === '' ? '' : ' '.repeat(indentN) + l));
    const extra = trailing > 1 ? Array<string>(trailing - 1).fill('') : [];
    const text = [head, ...lines, ...extra].join(st.eol);
    // Extra blank lines for keep-chomping sit inside the value; the text after `end` keeps its own newline.
    return { start: a, end, text: extra.length ? text + st.eol : text };
  }

  /** Replaces a whole value node (scalar or collection) with any value. */
  #replaceValue(loc: Loc, value: unknown, st: Style, chain: Loc[]): Splice {
    const s = this.#src;
    const node = loc.node as { range?: [number, number, number]; flow?: boolean } | null;
    const parent = loc.parent;
    const isColl = Array.isArray(value) || isCollection(value);
    const oldFlow = (isMap(node) || isSeq(node)) && node.flow === true;
    const inFlow = parent?.flow === true;
    const st2: Style = { ...st };
    const wantFlow = inFlow || oldFlow || (isColl && (Array.isArray(value) ? st.flowSeq : st.flowMap));
    void chain;

    if (!parent) {
      const start = node?.range ? node.range[0] : 0;
      const end = node?.range ? trimBack(s, nodeEnd(s, node)) : 0;
      const r = render(value, 0, st2, wantFlow);
      return { start, end, text: r.inline ?? r.lines!.join(st.eol) };
    }

    if (isMap(parent) && loc.pair) {
      const p = loc.pair;
      const colon = findColon(s, p);
      if (colon < 0) throw new YamlEditError('UNSUPPORTED', 'complex (explicit) mapping keys are not supported');
      const kcol = colOf(s, keyStart(s, p));
      const empty = node == null || isEmptyScalar(node);
      const vStart = empty ? colon + 1 : node.range![0];
      const vEnd = empty ? colon + 1 : trimBack(s, nodeEnd(s, node));
      const startsLater = !empty && lineStart(s, vStart) !== lineStart(s, colon);
      const seqVal = Array.isArray(value);
      const child = seqVal ? (st.seqFlush ? kcol : kcol + st.seqIndent) : kcol + st.step;
      const r = render(value, child, st2, wantFlow);
      const restOfLine = s.slice(colon + 1, contentLineEnd(s, colon));
      const cm = /^([ \t]*)(#.*)$/.exec(restOfLine);
      if (r.inline !== undefined) {
        if (startsLater) {
          const tail = cm ? `${cm[1]}${cm[2]}` : '';
          return { start: colon + 1, end: vEnd, text: ` ${r.inline}${tail}` };
        }
        return empty ? { start: colon + 1, end: colon + 1, text: ` ${r.inline}` } : { start: vStart, end: vEnd, text: r.inline };
      }
      // block replacement
      if (startsLater) return { start: contentLineEnd(s, colon), end: vEnd, text: st.eol + r.lines!.join(st.eol) };
      const after = s.slice(vEnd, contentLineEnd(s, vEnd));
      const tm = /^([ \t]*)(#.*)$/.exec(after);
      const end = tm ? contentLineEnd(s, vEnd) : vEnd;
      const tail = tm ? `${tm[1]}${tm[2]}` : '';
      return { start: colon + 1, end, text: tail + st.eol + r.lines!.join(st.eol) };
    }

    if (isSeq(parent)) {
      if (parent.flow) {
        const r = render(value, 0, st2, true);
        return { start: node!.range![0], end: node!.range![1], text: r.inline! };
      }
      const dash = blockSeqDashes(parent)[loc.index]!;
      const empty = node == null || isEmptyScalar(node);
      const gap = empty ? '' : s.slice(dash + 1, node.range![0]);
      const odd = /[\t\n]/.test(gap);
      const spacing = empty || odd ? st.dashSpacing : Math.max(1, node.range![0] - dash - 1);
      const r = render(value, colOf(s, dash) + 1 + spacing, st2, wantFlow);
      const end = empty ? dash + 1 : trimBack(s, nodeEnd(s, node));
      if (r.inline !== undefined) {
        if (empty) return { start: dash + 1, end, text: ` ${r.inline}` };
        return { start: node.range![0], end, text: r.inline };
      }
      const lead = colOf(s, dash) + 1 + spacing;
      const body = r.lines!.join(st.eol).slice(lead);
      if (empty || odd) return { start: dash + 1, end, text: ' '.repeat(spacing) + body };
      return { start: node.range![0], end, text: body };
    }

    // value inside a flow map
    if (isMap(parent) && parent.flow && loc.pair) {
      const r = render(value, 0, st2, true);
      const p = loc.pair;
      const colon = findColon(s, p);
      const empty = node == null || isEmptyScalar(node);
      if (empty) return { start: colon + 1, end: colon + 1, text: ` ${r.inline}` };
      return { start: node.range![0], end: node.range![1], text: r.inline! };
    }
    throw new YamlEditError('UNSUPPORTED', 'cannot replace this value');
  }

  #fillEmptyDoc(value: unknown, st: Style, d: Parsed): Splice[] {
    const s = this.#src;
    const isColl = Array.isArray(value) || isCollection(value);
    const r = render(value, 0, st, isColl && (Array.isArray(value) ? st.flowSeq : st.flowMap) && false);
    const body = r.inline ?? r.lines!.join(st.eol);
    if (d !== this.#docs[this.#docs.length - 1]) throw new YamlEditError('UNSUPPORTED', 'cannot fill an empty document that is followed by another document');
    const lead = s.length > 0 && !s.endsWith('\n') ? st.eol : '';
    return [{ start: s.length, end: s.length, text: lead + body + st.eol }];
  }

  // ------------------------------------------------------------------ delete

  #planDelete(d: Parsed, segs: Seg[]): Plan {
    if (segs.length === 0) throw new YamlEditError('PATH_SYNTAX', 'cannot delete the document root');
    const s = this.#src;
    const chain = this.#locate(d, segs);
    const loc = chain[chain.length - 1]!;
    this.#guardAnchors(d, chain, loc.node);
    if (hasComplexKeys(s, d.contents)) throw new YamlEditError('UNSUPPORTED', 'the document has explicit (?) or empty keys');
    const parent = loc.parent!;
    const expect = (root: unknown): unknown => deleteAt(root, segs);
    const st = this.#styleFor(d, []);

    if (parent.items.length === 1) {
      // Removing the only child leaves an empty collection.
      const up = chain[chain.length - 2]!;
      const empty = isMap(parent) ? {} : [];
      const st2: Style = { ...st, flowMap: parent.flow === true, flowSeq: parent.flow === true };
      return { splices: [this.#replaceValue(up, empty, st2, chain)], expect };
    }

    const i = loc.index;
    if (parent.flow) {
      const starts = parent.items.map((it) => (isMap(parent) ? keyStart(s, it as Pair) : withProps(s, (it as { range: [number, number] }).range[0])));
      const ends = parent.items.map((it) => (isMap(parent) ? pairEnd(s, it as Pair) : (it as { range: [number, number] }).range[1]));
      if (i < parent.items.length - 1) {
        const gap = s.slice(ends[i]!, starts[i + 1]!);
        if (gap.includes('#')) throw new YamlEditError('UNSUPPORTED', 'a comment sits between flow items; delete that item by hand');
        return { splices: [{ start: starts[i]!, end: starts[i + 1]!, text: '' }], expect };
      }
      const gap = s.slice(ends[i - 1]!, starts[i]!);
      if (gap.includes('#')) throw new YamlEditError('UNSUPPORTED', 'a comment sits between flow items; delete that item by hand');
      return { splices: [{ start: ends[i - 1]!, end: ends[i]!, text: '' }], expect };
    }

    const dashes = isSeq(parent) ? blockSeqDashes(parent) : [];
    const start = isMap(parent) ? keyStart(s, loc.pair!) : dashes[i]!;
    const end = isMap(parent) ? pairEnd(s, loc.pair!) : itemEnd(s, parent as YAMLSeq, i);
    const ls = lineStart(s, start);
    const prefix = s.slice(ls, start);
    if (prefix.trim() !== '') {
      if (isMap(parent) && i === 0) {
        const nextStart = keyStart(s, parent.items[1]!);
        const gap = s.slice(end, nextStart);
        if (gap.slice(gap.indexOf('\n') + 1).includes('#')) {
          // Comment lines belong to the next key. Leave a bare dash so they stay attached to it.
          if (!/^[ \t]*-[ \t]+$/.test(prefix)) throw new YamlEditError('UNSUPPORTED', 'this entry shares its line with another indicator');
          return { splices: [{ start: ls + prefix.trimEnd().length, end: contentLineEnd(s, end), text: '' }], expect };
        }
        return { splices: [{ start, end: nextStart, text: '' }], expect };
      }
      throw new YamlEditError('UNSUPPORTED', 'this entry shares its line with another indicator');
    }
    let from = ls;
    const col = start - ls;
    for (;;) {
      if (from === 0) break;
      const pl = lineStart(s, from - 1);
      const line = s.slice(pl, from).replace(/\r?\n$/, '');
      if (line.trim().startsWith('#') && line.length - line.trimStart().length === col) from = pl;
      else break;
    }
    let to = nextLine(s, end);
    if (to === s.length && !s.endsWith('\n') && from > 0) {
      from -= 1;
      if (s[from - 1] === '\r') from -= 1;
    }
    return { splices: [{ start: from, end: to, text: '' }], expect };
  }

  // ------------------------------------------------------------------ rename

  #planRename(d: Parsed, segs: Seg[], newKey: string): Plan {
    if (typeof newKey !== 'string') throw new YamlEditError('VALUE', 'the new key must be a string');
    const s = this.#src;
    const chain = this.#locate(d, segs);
    const loc = chain[chain.length - 1]!;
    if (!loc.pair || !isMap(loc.parent)) throw new YamlEditError('TYPE', `${showPath(segs)} is not a mapping key`);
    this.#guardAnchors(d, chain.slice(0, -1), null);
    const key = loc.pair.key;
    if (!isScalar(key) || key.range == null) throw new YamlEditError('UNSUPPORTED', 'this key is not a plain or quoted scalar');
    if (loc.parent.items.some((p, i) => i !== loc.index && keyMatches(p.key, newKey))) {
      throw new YamlEditError('EXISTS', `the mapping already has the key ${JSON.stringify(newKey)}`);
    }
    const [a, b] = key.range;
    let text: string;
    if (key.type === 'QUOTE_DOUBLE') text = doubleQuote(newKey);
    else if (key.type === 'QUOTE_SINGLE') text = singleQuoteOk(newKey) ? singleQuote(newKey) : doubleQuote(newKey);
    else {
      const st = this.#styleFor(d, []);
      text = plainSafe(newKey, false) ? newKey : renderString(newKey, 'double', st.fallback);
    }
    if (b === a) throw new YamlEditError('UNSUPPORTED', 'empty keys are not supported');
    return { splices: [{ start: a, end: b, text }], expect: (root) => renameAt(root, segs, newKey) };
  }

  // ------------------------------------------------------------------ insert

  #planInsert(d: Parsed, segs: Seg[], key: string, value: unknown, o: InsertOptions): Plan {
    if (typeof key !== 'string') throw new YamlEditError('VALUE', 'the key must be a string');
    if (value === undefined) throw new YamlEditError('VALUE', 'cannot insert undefined');
    if ([o.after !== undefined, o.before !== undefined, o.first === true].filter(Boolean).length > 1) {
      throw new YamlEditError('VALUE', 'use only one of after, before and first');
    }
    const s = this.#src;
    const chain = this.#locate(d, segs);
    const loc = chain[chain.length - 1]!;
    this.#guardAnchors(d, chain, null);
    if (hasComplexKeys(s, d.contents)) throw new YamlEditError('UNSUPPORTED', 'the document has explicit (?) or empty keys');
    const parent = loc.node;
    const expected = normalise(value);
    const where = { after: o.after, before: o.before, first: o.first };
    const expect = (root: unknown): unknown => insertAt(root, segs, key, expected, where);
    const parentSiblings = loc.parent ? (isMap(loc.parent) ? loc.parent.items.map((p) => p.value) : loc.parent.items) : [];

    if (d.contents == null) {
      const st = this.#styleFor(d, []);
      if (segs.length) throw new YamlEditError('NOT_FOUND', 'the document is empty');
      return { splices: this.#fillEmptyDoc({ [key]: value }, st, d), expect: () => ({ [key]: expected }) };
    }
    if (parent == null || isEmptyScalar(parent) || (isMap(parent) && parent.items.length === 0)) {
      const st = this.#styleFor(d, parentSiblings as unknown[]);
      const st2: Style = { ...st, flowMap: isMap(parent) && parent.flow === true };
      const expectNew = isMap(parent) ? expect : (root: unknown): unknown => setAt(root, segs, { [key]: expected });
      return { splices: [this.#replaceValue(loc, { [key]: value }, st2, chain)], expect: expectNew };
    }
    if (!isMap(parent)) throw new YamlEditError('TYPE', `${showPath(segs)} is not a mapping`);
    if (parent.items.some((p) => keyMatches(p.key, key))) throw new YamlEditError('EXISTS', `the mapping already has the key ${JSON.stringify(key)}`);
    if (parent.items.some((p) => !isScalar(p.key) || p.key.range == null || p.key.range[0] === p.key.range[1])) throw new YamlEditError('UNSUPPORTED', 'the mapping has complex or empty keys');
    const refIdx = (name: string): number => {
      const i = parent.items.findIndex((p) => keyMatches(p.key, name));
      if (i < 0) throw new YamlEditError('NOT_FOUND', `no sibling key ${JSON.stringify(name)}`);
      return i;
    };
    let at = parent.items.length; // insert before this index
    if (o.first) at = 0;
    else if (o.before !== undefined) at = refIdx(o.before);
    else if (o.after !== undefined) at = refIdx(o.after) + 1;

    const st = this.#styleFor(d, parent.items.map((p) => p.value));
    const isColl = Array.isArray(value) || isCollection(value);
    const kind = Array.isArray(value) ? 'seq' : 'map';
    const flowV = isColl ? siblingsFlow(parent.items.map((p) => p.value), kind, kind === 'seq' ? st.flowSeq : st.flowMap) : false;
    const st2: Style = { ...st, flowMap: flowV, flowSeq: flowV };
    const keyVotes = parent.items.map((p) => (p.key as Scalar).type);
    const quotedKeys = keyVotes.filter((t) => t === 'QUOTE_DOUBLE').length * 2 > keyVotes.length ? 'double' : keyVotes.filter((t) => t === 'QUOTE_SINGLE').length * 2 > keyVotes.length ? 'single' : 'plain';
    const keyTxt = renderKey(key, quotedKeys, st.fallback);

    if (parent.flow) {
      return { splices: this.#flowInsert(parent, at, `${keyTxt}: ${flowText(value, st2)}`, st), expect };
    }

    const kcol = colOf(s, keyStart(s, parent.items[0]!));
    const lines = pairLines(keyTxt, value, kcol, st2, new Set());
    return { splices: this.#blockInsert(parent, at, lines, kcol, st, o.after !== undefined), expect };
  }

  #blockInsert(parent: YAMLMap | YAMLSeq, at: number, lines: string[], col: number, st: Style, afterPrev = false): Splice[] {
    const s = this.#src;
    const seq = isSeq(parent);
    const startOf = (i: number): number => (seq ? blockSeqDashes(parent)[i]! : keyStart(s, parent.items[i] as Pair));
    if (at >= parent.items.length || (afterPrev && at > 0)) {
      const last = at - 1;
      const end = seq ? itemEnd(s, parent, last) : pairEnd(s, parent.items[last] as Pair);
      const pos = nextLine(s, end);
      if (pos === s.length && !s.endsWith('\n')) return [{ start: s.length, end: s.length, text: st.eol + lines.join(st.eol) }];
      return [{ start: pos, end: pos, text: lines.join(st.eol) + st.eol }];
    }
    const start = startOf(at);
    const ls = lineStart(s, start);
    if (s.slice(ls, start).trim() !== '') {
      const first = lines.map((l, i) => (i === 0 ? l.slice(col) : l)).join(st.eol);
      return [{ start, end: start, text: first + st.eol + ' '.repeat(col) }];
    }
    let from = ls;
    for (;;) {
      if (from === 0) break;
      const pl = lineStart(s, from - 1);
      const line = s.slice(pl, from).replace(/\r?\n$/, '');
      if (line.trim().startsWith('#') && line.length - line.trimStart().length === col) from = pl;
      else break;
    }
    return [{ start: from, end: from, text: lines.join(st.eol) + st.eol }];
  }

  #flowInsert(parent: YAMLMap | YAMLSeq, at: number, text: string, st: Style): Splice[] {
    const s = this.#src;
    const [open, close] = [parent.range![0], parent.range![1] - 1];
    const n = parent.items.length;
    if (n === 0) {
      return [{ start: open + 1, end: close, text: st.flowPad ? ` ${text} ` : text }];
    }
    const startOf = (i: number): number => {
      const it = parent.items[i]!;
      return isMap(parent) ? keyStart(s, it as Pair) : withProps(s, (it as { range: [number, number] }).range[0]);
    };
    const endOf = (i: number): number => {
      const it = parent.items[i]!;
      return isMap(parent) ? pairEnd(s, it as Pair) : (it as { range: [number, number] }).range[1];
    };
    // Layout: one item per line, or inline.
    const multiline = n >= 2 ? lineStart(s, startOf(n - 1)) !== lineStart(s, startOf(n - 2)) : lineStart(s, startOf(0)) !== lineStart(s, open);
    const indentTxt = multiline ? ' '.repeat(colOf(s, startOf(n >= 2 ? n - 1 : 0))) : '';
    if (at >= n) {
      const e = endOf(n - 1);
      if (!multiline) return [{ start: e, end: e, text: `, ${text}` }];
      const after = s.slice(e, contentLineEnd(s, e));
      const hasComma = /^[ \t]*,/.test(after);
      const le = contentLineEnd(s, e);
      if (hasComma) return [{ start: le, end: le, text: `${st.eol}${indentTxt}${text},` }];
      return [
        { start: e, end: e, text: ',' },
        { start: le, end: le, text: `${st.eol}${indentTxt}${text}` },
      ];
    }
    const b = startOf(at);
    if (!multiline) return [{ start: b, end: b, text: `${text}, ` }];
    return [{ start: b, end: b, text: `${text},${st.eol}${indentTxt}` }];
  }

  // ------------------------------------------------------------------ append

  #planAppend(d: Parsed, segs: Seg[], value: unknown): Plan {
    if (value === undefined) throw new YamlEditError('VALUE', 'cannot append undefined');
    const s = this.#src;
    const chain = this.#locate(d, segs);
    const loc = chain[chain.length - 1]!;
    this.#guardAnchors(d, chain, null);
    if (hasComplexKeys(s, d.contents)) throw new YamlEditError('UNSUPPORTED', 'the document has explicit (?) or empty keys');
    const parent = loc.node;
    const expected = normalise(value);
    const expect = (root: unknown): unknown => appendAt(root, segs, expected);
    const parentSiblings = loc.parent ? (isMap(loc.parent) ? loc.parent.items.map((p) => p.value) : loc.parent.items) : [];
    if (d.contents == null) {
      const st = this.#styleFor(d, []);
      if (segs.length) throw new YamlEditError('NOT_FOUND', 'the document is empty');
      return { splices: this.#fillEmptyDoc([value], st, d), expect: () => [expected] };
    }
    if (parent == null || isEmptyScalar(parent) || (isSeq(parent) && parent.items.length === 0)) {
      const st = this.#styleFor(d, parentSiblings as unknown[]);
      const st2: Style = { ...st, flowSeq: isSeq(parent) && parent.flow === true };
      const expectNew = isSeq(parent) ? expect : (root: unknown): unknown => setAt(root, segs, [expected]);
      return { splices: [this.#replaceValue(loc, [value], st2, chain)], expect: expectNew };
    }
    if (!isSeq(parent)) throw new YamlEditError('TYPE', `${showPath(segs)} is not a sequence`);
    const st = this.#styleFor(d, parent.items);
    const isColl = Array.isArray(value) || isCollection(value);
    const kind = Array.isArray(value) ? 'seq' : 'map';
    const flowV = isColl ? siblingsFlow(parent.items, kind, kind === 'seq' ? st.flowSeq : st.flowMap) : false;
    const st2: Style = { ...st, flowMap: flowV, flowSeq: flowV };
    if (parent.flow) {
      return { splices: this.#flowInsert(parent, parent.items.length, flowText(value, st2), st), expect };
    }
    const dashes = blockSeqDashes(parent);
    const lastDash = dashes[dashes.length - 1]!;
    const lastItem = parent.items[parent.items.length - 1] as { range?: [number, number, number] } | null;
    const spacing = lastItem?.range && lastItem.range[1] > lastItem.range[0] ? Math.max(1, lastItem.range[0] - lastDash - 1) : st.dashSpacing;
    const lines = itemLines(value, colOf(s, lastDash), spacing, st2, new Set());
    return { splices: this.#blockInsert(parent, parent.items.length, lines, colOf(s, lastDash), st), expect };
  }
}

/** Parses a YAML stream for editing. Throws `YamlEditError` (code `PARSE`) on invalid YAML. */
export function parse(src: string): Doc {
  return new Doc(src);
}
