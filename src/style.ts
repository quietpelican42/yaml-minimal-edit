import { isAlias, isMap, isScalar, isSeq } from 'yaml';
import type { Scalar, YAMLMap, YAMLSeq } from 'yaml';
import { YamlEditError } from './errors.ts';
import { Raw, entriesOf, isCollection, plainSafe, renderKey, renderString, renderTyped } from './scalar.ts';
import type { QuoteStyle } from './scalar.ts';
import { blockSeqDashes, colOf } from './text.ts';

/** Things observed in the existing document that new text should match. */
export interface Style {
  eol: string;
  step: number;
  /** block sequences under a key are written at the key's column */
  seqFlush: boolean;
  /** dash column minus key column, when not flush */
  seqIndent: number;
  dashSpacing: number;
  flowPad: boolean;
  /** quote style for new string values */
  quote: QuoteStyle;
  /** quote used when plain is preferred but the string needs quoting */
  fallback: 'double' | 'single';
  flowMap: boolean;
  flowSeq: boolean;
}

interface Votes {
  plain: number;
  dq: number;
  sq: number;
}

const newVotes = (): Votes => ({ plain: 0, dq: 0, sq: 0 });

function vote(v: Votes, n: unknown): void {
  if (!isScalar(n) || typeof n.value !== 'string' || !plainSafe(n.value)) return;
  if (n.type === 'PLAIN') v.plain++;
  else if (n.type === 'QUOTE_DOUBLE') v.dq++;
  else if (n.type === 'QUOTE_SINGLE') v.sq++;
}

const decide = (v: Votes): QuoteStyle | null => {
  if (v.plain + v.dq + v.sq === 0) return null;
  if (v.plain >= v.dq + v.sq) return 'plain';
  return v.dq >= v.sq ? 'double' : 'single';
};

function mode(hist: Map<number, number>, dflt: number): number {
  let best = dflt;
  let n = 0;
  for (const [k, c] of hist) if (c > n || (c === n && k < best)) ((best = k), (n = c));
  return best;
}

const bump = (h: Map<number, number>, k: number): void => void h.set(k, (h.get(k) ?? 0) + 1);

interface Stats {
  doc: Votes;
  quotedDq: number;
  quotedSq: number;
  steps: Map<number, number>;
  flush: number;
  indented: number;
  seqIndents: Map<number, number>;
  dashSp: Map<number, number>;
  flowMaps: number;
  blockMaps: number;
  flowSeqs: number;
  blockSeqs: number;
  padded: number;
  unpadded: number;
}

function gather(src: string, root: unknown): Stats {
  const st: Stats = {
    doc: newVotes(), quotedDq: 0, quotedSq: 0, steps: new Map(), flush: 0, indented: 0, seqIndents: new Map(),
    dashSp: new Map(), flowMaps: 0, blockMaps: 0, flowSeqs: 0, blockSeqs: 0, padded: 0, unpadded: 0,
  };
  const visit = (n: unknown, parentCol: number | null, viaPair: boolean, isKey = false): void => {
    if (isScalar(n)) {
      if (!isKey) vote(st.doc, n);
      if (typeof n.value === 'string') {
        if (n.type === 'QUOTE_DOUBLE') st.quotedDq++;
        else if (n.type === 'QUOTE_SINGLE') st.quotedSq++;
      }
      return;
    }
    if (isAlias(n) || !n) return;
    if (isMap(n)) {
      if (n.flow) {
        st.flowMaps++;
        if (n.range && n.items.length) {
          if (src[n.range[0] + 1] === ' ') st.padded++;
          else st.unpadded++;
        }
      } else if (n.items.length) {
        st.blockMaps++;
        const col = colOf(src, (n.items[0]!.key as Scalar).range![0]);
        if (viaPair && parentCol !== null && col > parentCol) bump(st.steps, col - parentCol);
        for (const p of n.items) {
          visit(p.key, null, false, true);
          visit(p.value, col, true);
        }
        return;
      }
      for (const p of n.items) {
        visit(p.key, null, false, true);
        visit(p.value, null, false);
      }
      return;
    }
    if (isSeq(n)) {
      if (n.flow) {
        st.flowSeqs++;
        if (n.range && n.items.length) {
          if (src[n.range[0] + 1] === ' ') st.padded++;
          else st.unpadded++;
        }
      } else if (n.items.length) {
        st.blockSeqs++;
        const dashes = blockSeqDashes(n);
        const d0 = dashes[0];
        if (viaPair && parentCol !== null && d0 !== undefined) {
          const dc = colOf(src, d0);
          if (dc === parentCol) st.flush++;
          else if (dc > parentCol) {
            st.indented++;
            bump(st.seqIndents, dc - parentCol);
          }
        }
        n.items.forEach((it, i) => {
          const d = dashes[i];
          const first = it as { range?: [number, number, number] } | null;
          if (d !== undefined && first?.range && first.range[1] > first.range[0]) {
            const sp = first.range[0] - d - 1;
            if (sp >= 1 && sp <= 8 && src.slice(d + 1, first.range[0]).trim() === '') bump(st.dashSp, sp);
          }
        });
      }
      for (const it of n.items) visit(it, null, false);
    }
  };
  visit(root, null, false);
  return st;
}

/** Quote evidence among the given sibling nodes (values of a map, or items of a sequence). */
function siblingVotes(items: unknown[]): Votes {
  const v = newVotes();
  for (const it of items) vote(v, it);
  return v;
}

export function analyse(src: string, root: unknown, siblingValues: unknown[]): Style {
  const st = gather(src, root);
  const crlf = (src.match(/\r\n/g)?.length ?? 0) > (src.match(/(?<!\r)\n/g)?.length ?? 0);
  const step = mode(st.steps, 0) || mode(st.seqIndents, 2);
  const sv = siblingVotes(siblingValues);
  const quote = (sv.plain + sv.dq + sv.sq >= 2 ? decide(sv) : null) ?? decide(st.doc) ?? 'plain';
  return {
    eol: crlf ? '\r\n' : '\n',
    step,
    seqFlush: st.flush > st.indented,
    seqIndent: mode(st.seqIndents, step),
    dashSpacing: mode(st.dashSp, 1),
    flowPad: st.padded > st.unpadded,
    quote,
    fallback: st.quotedSq > st.quotedDq ? 'single' : 'double',
    flowMap: st.flowMaps > st.blockMaps,
    flowSeq: st.flowSeqs > st.blockSeqs,
  };
}

/** Whether a new collection of the given kind among these siblings should be flow style. */
export function siblingsFlow(siblings: unknown[], kind: 'map' | 'seq', docDefault: boolean): boolean {
  let flow = 0;
  let block = 0;
  let anyFlow = 0;
  let anyBlock = 0;
  for (const s of siblings) {
    if (!(isMap(s) || isSeq(s)) || s.items.length === 0) continue;
    const same = kind === 'map' ? isMap(s) : isSeq(s);
    if (s.flow) (anyFlow++, same && flow++);
    else (anyBlock++, same && block++);
  }
  if (flow + block > 0) return flow > block;
  if (anyFlow + anyBlock > 0) return anyFlow > anyBlock;
  return docDefault;
}

// ---------------------------------------------------------------- rendering

export interface Rendered {
  /** single-line text, when the value can sit after `key: ` or `- ` */
  inline?: string;
  /** block lines, at the requested indent */
  lines?: string[];
  /** true when `lines` is a sequence body (drives flush placement) */
  seq?: boolean;
}

const ind = (n: number): string => ' '.repeat(n);

export function scalarText(v: unknown, st: Style): string {
  if (typeof v === 'string') return renderString(v, st.quote, st.fallback);
  return renderTyped(v);
}

export function keyText(k: string, quote: QuoteStyle, fallback: 'double' | 'single'): string {
  return renderKey(k, quote, fallback);
}

export function flowText(v: unknown, st: Style, seen: Set<unknown> = new Set()): string {
  if (Array.isArray(v)) {
    guard(v, seen);
    const t = v.map((x) => flowText(x, st, seen)).join(', ');
    seen.delete(v);
    return st.flowPad && v.length ? `[ ${t} ]` : `[${t}]`;
  }
  if (isCollection(v)) {
    guard(v, seen);
    const es = entriesOf(v);
    const t = es.map(([k, x]) => `${keyText(k, st.quote, st.fallback)}: ${flowText(x, st, seen)}`).join(', ');
    seen.delete(v);
    return st.flowPad && es.length ? `{ ${t} }` : `{${t}}`;
  }
  return scalarText(v, st);
}

function guard(v: unknown, seen: Set<unknown>): void {
  if (seen.has(v)) throw new YamlEditError('VALUE', 'cannot write a value with a circular reference');
  seen.add(v);
}

const isEmptyColl = (v: unknown): boolean => (Array.isArray(v) ? v.length === 0 : isCollection(v) && entriesOf(v).length === 0);

/** Renders `v` for placement after `key: ` / `- `. Block lines are at `indent` (the child indent). */
export function render(v: unknown, indent: number, st: Style, flow: boolean, seen: Set<unknown> = new Set()): Rendered {
  if (v instanceof Raw) return { inline: renderTyped(v) };
  if (!Array.isArray(v) && !isCollection(v)) return { inline: scalarText(v, st) };
  if (isEmptyColl(v)) return { inline: Array.isArray(v) ? '[]' : '{}' };
  if (flow) return { inline: flowText(v, st) };
  guard(v, seen);
  try {
    if (Array.isArray(v)) return { lines: seqLines(v, indent, st, seen), seq: true };
    return { lines: mapLines(v, indent, st, seen) };
  } finally {
    seen.delete(v);
  }
}

/** Lines of a block mapping at `indent`. */
export function mapLines(v: unknown, indent: number, st: Style, seen: Set<unknown> = new Set()): string[] {
  const out: string[] = [];
  for (const [k, x] of entriesOf(v)) out.push(...pairLines(keyText(k, 'plain', st.fallback), x, indent, st, seen));
  return out;
}

/** Lines of `key: value` at `indent`; `keyTxt` is the already-rendered key. */
export function pairLines(keyTxt: string, x: unknown, indent: number, st: Style, seen: Set<unknown> = new Set()): string[] {
  const head = `${ind(indent)}${keyTxt}:`;
  const isSeq = Array.isArray(x);
  const flow = isSeq ? st.flowSeq : st.flowMap;
  const childIndent = isSeq ? (st.seqFlush ? indent : indent + st.seqIndent) : indent + st.step;
  const r = render(x, childIndent, st, flow, seen);
  if (r.inline !== undefined) return [`${head} ${r.inline}`];
  return [head, ...r.lines!];
}

/** Lines of a block sequence with dashes at `indent`. */
export function seqLines(v: unknown[], indent: number, st: Style, seen: Set<unknown> = new Set()): string[] {
  const out: string[] = [];
  for (const x of v) out.push(...itemLines(x, indent, st.dashSpacing, st, seen));
  return out;
}

export function itemLines(x: unknown, dashIndent: number, spacing: number, st: Style, seen: Set<unknown> = new Set()): string[] {
  const lead = `${ind(dashIndent)}-${ind(spacing)}`;
  const childIndent = dashIndent + 1 + spacing;
  const flow = Array.isArray(x) ? st.flowSeq : st.flowMap;
  const r = render(x, childIndent, st, flow, seen);
  if (r.inline !== undefined) return [`${lead}${r.inline}`];
  const lines = r.lines!;
  return [lead + lines[0]!.slice(childIndent), ...lines.slice(1)];
}

export type { YAMLMap, YAMLSeq };
