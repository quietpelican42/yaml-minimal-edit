/**
 * Corpus harness. Plans edits from the source, computes the expected data, and
 * decides whether an edited text is "clean": it re-parses to exactly the
 * expected data (values and key order) AND a line diff touches only the
 * intended lines.
 */
import { LineCounter, isAlias, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml';
import type { Document, Node } from 'yaml';

export type Seg = string | number;
/** `setstr` is `set` on a string scalar with a value that would change type if written plain. */
export type Kind = 'set' | 'setstr' | 'rename' | 'delete' | 'insert' | 'append';
export const KINDS: Kind[] = ['set', 'setstr', 'rename', 'delete', 'insert', 'append'];
export const TRICKY = ['1.20', 'yes', 'on', '0755', '1_000', '12:30', 'null', '~'];

export interface Op {
  kind: Kind;
  /** set/delete: path to the value; rename: path to the value (last seg is the old key); insert: parent map; append: the sequence */
  path: Seg[];
  value?: unknown;
  /** rename: the new key; insert: the new key */
  key?: string;
  /** 0-based first and last line of the target (delete: key line to last value line) */
  first: number;
  last: number;
  /** delete: comment-only lines directly above the key (allowed to disappear) */
  commentsAbove: number;
  /**
   * delete of the first key on a `- key: v` line. The minimal result removes the bytes
   * [start, end) so the next key moves up next to the dash, so a line diff would see two lines change.
   */
  inline?: { start: number; end: number };
}

export const NEW_KEY = 'renamed_key';
export const ADD_KEY = 'added_key';

function rng(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

function parseAll(src: string): { docs: Document.Parsed[]; lc: LineCounter } {
  const lc = new LineCounter();
  return { docs: parseAllDocuments(src, { lineCounter: lc }) as Document.Parsed[], lc };
}

function hasAnchor(n: unknown): boolean {
  if (isScalar(n)) return !!n.anchor;
  if (isAlias(n)) return true;
  if (isMap(n) || isSeq(n)) {
    if (n.anchor) return true;
    for (const it of n.items as unknown[]) {
      if (isSeq(n)) {
        if (hasAnchor(it)) return true;
      } else {
        const p = it as { key: unknown; value: unknown };
        if (hasAnchor(p.key) || hasAnchor(p.value)) return true;
      }
    }
  }
  return false;
}

function maxEnd(n: unknown): number {
  if (isScalar(n) || isAlias(n)) return (n as Node).range?.[1] ?? 0;
  if (isMap(n) || isSeq(n)) {
    // a block collection's own range runs on over trailing comments and blank lines
    let m = n.flow ? ((n as Node).range?.[1] ?? 0) : 0;
    for (const it of n.items as unknown[]) {
      if (isSeq(n)) m = Math.max(m, maxEnd(it));
      else {
        const p = it as { key: unknown; value: unknown };
        m = Math.max(m, maxEnd(p.key), maxEnd(p.value));
      }
    }
    return m;
  }
  return 0;
}

const SIMPLE_STYLES = new Set(['PLAIN', 'QUOTE_DOUBLE', 'QUOTE_SINGLE']);

export function plan(name: string, src: string, perKind = 3): Op[] {
  const { docs, lc } = parseAll(src);
  const doc = docs[0];
  if (!doc || docs.some((d) => d.errors.length)) return [];
  const lineOf = (off: number): number => lc.linePos(off).line - 1;
  const lines = src.split('\n');
  const lastLine = (end: number): number => {
    let e = end;
    while (e > 0 && /\s/.test(src[e - 1] ?? '')) e--;
    return lineOf(Math.max(0, e - 1));
  };
  const cands: Record<Kind, Op[]> = { set: [], setstr: [], rename: [], delete: [], insert: [], append: [] };
  const simpleScalar = (n: unknown): n is import('yaml').Scalar =>
    isScalar(n) && !n.anchor && !n.tag && SIMPLE_STYLES.has(String(n.type ?? 'PLAIN')) &&
    n.range != null && lineOf(n.range[0]) === lineOf(Math.max(n.range[0], n.range[1] - 1)) &&
    (typeof n.value === 'string' || typeof n.value === 'number' || typeof n.value === 'boolean');
  const setValue = (v: unknown): unknown => (typeof v === 'string' ? 'edited-value' : typeof v === 'number' ? 4242 : !v);

  const walk = (node: unknown, path: Seg[], inAnchor: boolean): void => {
    if (isAlias(node) || !node) return;
    const anchored = inAnchor || (isMap(node) || isSeq(node) || isScalar(node) ? !!node.anchor : false);
    if (isMap(node)) {
      const flow = !!node.flow;
      const keys = new Set(node.items.map((p) => (isScalar(p.key) ? String(p.key.value) : '\0')));
      if (!flow && !anchored && node.items.length >= 1 && !keys.has(ADD_KEY) && node.range) {
        const lastPair = node.items[node.items.length - 1]!;
        const ends = maxEnd(lastPair.value ?? lastPair.key);
        cands.insert.push({ kind: 'insert', path, key: ADD_KEY, value: 'added-value', first: lastLine(ends), last: lastLine(ends), commentsAbove: 0 });
      }
      for (const p of node.items) {
        const k = p.key;
        if (!isScalar(k) || typeof k.value !== 'string' || !k.range) continue;
        const kl = lineOf(k.range[0]);
        const plainKey = simpleScalar(k) && !k.anchor;
        const explicit = (lines[kl] ?? '').trimStart().startsWith('?');
        const seg = k.value;
        if (p.value == null) continue;
        const v = p.value as unknown;
        if (plainKey && !explicit && !anchored && seg !== '<<') {
          if (!keys.has(NEW_KEY)) cands.rename.push({ kind: 'rename', path: [...path, seg], key: NEW_KEY, first: kl, last: kl, commentsAbove: 0 });
          if (!flow && node.items.length >= 2 && !hasAnchor(v) && !hasAnchor(k)) {
            const end = lastLine(maxEnd(v));
            let c = 0;
            while (kl - c - 1 >= 0 && (lines[kl - c - 1] ?? '').trim().startsWith('#')) c++;
            let skipDelete = false;
            const op: Op = { kind: 'delete', path: [...path, seg], first: kl, last: end, commentsAbove: c };
            const lsOff = lc.lineStarts[kl] ?? 0;
            const next = node.items[1]?.key;
            if (src.slice(lsOff, k.range[0]).trim() !== '' && node.items[0] === p && isScalar(next) && next.range) {
              const gap = src.slice(maxEnd(p.value), next.range[0]);
              // Comment lines between the two keys have no single minimal result; those candidates are skipped.
              if (gap.slice(gap.indexOf('\n') + 1).includes('#')) skipDelete = true;
              else op.inline = { start: k.range[0], end: next.range[0] };
            }
            if (!skipDelete) cands.delete.push(op);
          }
          if (simpleScalar(v) && !anchored) {
            const sv = (v as { value: unknown }).value;
            const vl = lineOf((v as Node).range![0]);
            cands.set.push({ kind: 'set', path: [...path, seg], value: setValue(sv), first: vl, last: vl, commentsAbove: 0 });
            if (typeof sv === 'string') cands.setstr.push({ kind: 'setstr', path: [...path, seg], value: TRICKY[cands.setstr.length % TRICKY.length], first: vl, last: vl, commentsAbove: 0 });
          }
        }
        if (plainKey) walk(v, [...path, seg], anchored);
      }
    } else if (isSeq(node)) {
      if (!node.flow && !anchored && node.items.length >= 1) {
        const last = node.items[node.items.length - 1];
        const scalarLast = isScalar(last) && !last.anchor;
        const mapLast = isMap(last) && !last.flow;
        if (scalarLast || mapLast) {
          const l = lastLine(maxEnd(last));
          cands.append.push({ kind: 'append', path, value: scalarLast ? 'appended-item' : { appended: 'item' }, first: l, last: l, commentsAbove: 0 });
        }
      }
      node.items.forEach((it, i) => {
        if (simpleScalar(it) && !anchored) {
          cands.set.push({ kind: 'set', path: [...path, i], value: setValue(it.value), first: lineOf(it.range![0]), last: lineOf(it.range![0]), commentsAbove: 0 });
          if (typeof it.value === 'string') cands.setstr.push({ kind: 'setstr', path: [...path, i], value: TRICKY[cands.setstr.length % TRICKY.length], first: lineOf(it.range![0]), last: lineOf(it.range![0]), commentsAbove: 0 });
        }
        walk(it, [...path, i], anchored);
      });
    }
  };
  walk(doc.contents, [], false);

  const r = rng(name);
  const out: Op[] = [];
  for (const kind of KINDS) {
    const c = cands[kind].slice();
    for (let i = c.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [c[i], c[j]] = [c[j]!, c[i]!];
    }
    out.push(...c.slice(0, perKind));
  }
  return out;
}

/** Applies the op to plain data. */
export function applyToData(data: unknown, op: Op): unknown {
  const root = structuredClone(data) as Record<string, unknown>;
  let cur: unknown = root;
  const segs = op.path;
  const upto = op.kind === 'insert' || op.kind === 'append' ? segs.length : segs.length - 1;
  for (let i = 0; i < upto; i++) cur = (cur as Record<Seg, unknown>)[segs[i]!];
  const leaf = segs[segs.length - 1] as Seg;
  switch (op.kind) {
    case 'set':
    case 'setstr':
      (cur as Record<Seg, unknown>)[leaf] = op.value;
      break;
    case 'delete':
      delete (cur as Record<string, unknown>)[leaf as string];
      break;
    case 'insert':
      (cur as Record<string, unknown>)[op.key!] = op.value;
      break;
    case 'append':
      (cur as unknown[]).push(op.value);
      break;
    case 'rename': {
      const m = cur as Record<string, unknown>;
      const entries = Object.entries(m).map(([k, v]) => (k === leaf ? [op.key!, v] : [k, v]) as [string, unknown]);
      for (const k of Object.keys(m)) delete m[k];
      for (const [k, v] of entries) m[k] = v;
      break;
    }
  }
  return root;
}

export function dataOf(src: string): unknown[] | null {
  const { docs } = parseAll(src);
  if (docs.some((d) => d.errors.length)) return null;
  try {
    return docs.map((d) => d.toJS());
  } catch {
    return null;
  }
}

/** Expected documents after `op`: only the first document changes. */
export function expectedAfter(src: string, op: Op): unknown[] {
  const docs = dataOf(src)!;
  return [applyToData(docs[0], op), ...docs.slice(1)];
}

export interface Verdict {
  ok: boolean;
  why: string;
}

const commonPrefix = (a: string[], b: string[]): number => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};

export function judge(src: string, out: string, op: Op, expected: unknown[]): Verdict {
  const got = dataOf(out);
  if (!got) return { ok: false, why: 'output does not parse' };
  if (JSON.stringify(got) !== JSON.stringify(expected)) return { ok: false, why: 'data differs from expected' };
  // A last line without a terminator gains or loses its \r with the newline next to it; compare without \r.
  const A = src.split('\n').map((l) => l.replace(/\r$/, ''));
  const B = out.split('\n').map((l) => l.replace(/\r$/, ''));
  switch (op.kind) {
    case 'set':
    case 'setstr':
    case 'rename': {
      const A0 = src.split('\n');
      const B0 = out.split('\n');
      if (A0.length !== B0.length) return { ok: false, why: 'line count changed' };
      for (let i = 0; i < A0.length; i++) if (A0[i] !== B0[i] && i !== op.first) return { ok: false, why: `line ${i + 1} changed outside the target` };
      return { ok: true, why: '' };
    }
    case 'delete': {
      if (op.inline) return out === src.slice(0, op.inline.start) + src.slice(op.inline.end) ? { ok: true, why: '' } : { ok: false, why: 'not the minimal removal of the first key on a dash line' };
      const span = op.last - op.first + 1;
      for (let c = 0; c <= op.commentsAbove; c++) {
        const s = op.first - c;
        const n = span + c;
        if (A.length - n !== B.length) continue;
        const cand = A.slice(0, s).concat(A.slice(s + n));
        if (cand.every((l, i) => l === B[i])) return { ok: true, why: '' };
      }
      return { ok: false, why: 'lines other than the deleted key changed' };
    }
    case 'insert':
    case 'append': {
      if (B.length !== A.length + 1) return { ok: false, why: `expected exactly one added line, got ${B.length - A.length}` };
      const p = commonPrefix(A, B);
      const restA = A.slice(p);
      const restB = B.slice(p + 1);
      if (restA.length !== restB.length || !restA.every((l, i) => l === restB[i])) return { ok: false, why: 'existing lines changed' };
      return { ok: true, why: '' };
    }
  }
}
