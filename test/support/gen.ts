/** Random YAML documents in random layouts, for property tests and the fuzz run. */
import { parse as yamlParse } from 'yaml';
import { plainSafe } from '../../src/scalar.ts';

export type Rnd = () => number;

export function makeRng(seed: number): Rnd {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

const pick = <T>(r: Rnd, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const chance = (r: Rnd, p: number): boolean => r() < p;

export type Tree = string | number | boolean | null | Tree[] | { [k: string]: Tree };

const WORDS = ['alpha', 'beta', 'gamma', 'delta', 'name', 'image', 'run', 'uses', 'with', 'env', 'ports', 'steps', 'jobs', 'on', 'x', 'y', 'z', 'a-b', 'a_b', 'v1.2', 'ok'];
const TRICKY = ['1.20', 'yes', 'no', 'on', 'off', '0755', '1_000', '12:30', 'null', '~', 'true', '1e3', '2001-01-01', '', ' lead', 'trail ', 'a: b', 'a #b', '#x', '- x', '[x]', '{x}', "it's", 'say "hi"', 'tab\tx', 'unié中', '*star', '&amp', '!bang', '%pct', '@at', '`tick', '|pipe', '>gt', '?q', 'x,y', 'back\\slash'];

export interface Layout {
  indent: number;
  seqFlush: boolean;
  quote: number; // probability a plain-safe string is quoted
  singleQ: number; // probability a quoted string is single-quoted
  flow: number;
  comments: number;
  blanks: number;
  crlf: boolean;
  finalNewline: boolean;
  dashSpace: number;
  flowPad: boolean;
}

export function randomLayout(r: Rnd): Layout {
  return {
    indent: pick(r, [2, 2, 2, 3, 4]),
    seqFlush: chance(r, 0.4),
    quote: pick(r, [0, 0, 0.3, 1]),
    singleQ: pick(r, [0, 0.5, 1]),
    flow: pick(r, [0, 0, 0.2, 0.6]),
    comments: pick(r, [0, 0.15, 0.4]),
    blanks: pick(r, [0, 0.1, 0.3]),
    crlf: chance(r, 0.1),
    finalNewline: chance(r, 0.85),
    dashSpace: pick(r, [1, 1, 1, 2]),
    flowPad: chance(r, 0.3),
  };
}

function scalarValue(r: Rnd): string | number | boolean | null {
  const k = r();
  if (k < 0.45) return chance(r, 0.25) ? pick(r, TRICKY) : pick(r, WORDS) + (chance(r, 0.3) ? ` ${pick(r, WORDS)}` : '');
  if (k < 0.7) return Math.floor(r() * 2000) - 100;
  if (k < 0.8) return chance(r, 0.5);
  if (k < 0.85) return null;
  return Math.round(r() * 1000) / 10;
}

export function randomTree(r: Rnd, depth = 0): Tree {
  const k = r();
  if (depth >= 4 || k < 0.35) return scalarValue(r);
  const n = 1 + Math.floor(r() * 4);
  if (k < 0.65) {
    const o: { [k: string]: Tree } = {};
    for (let i = 0; i < n; i++) o[pick(r, WORDS) + (chance(r, 0.5) ? String(i) : '')] = randomTree(r, depth + 1);
    return o;
  }
  return Array.from({ length: n }, () => randomTree(r, depth + 1));
}

class Emitter {
  r: Rnd;
  l: Layout;
  constructor(r: Rnd, l: Layout) {
    this.r = r;
    this.l = l;
  }

  str(s: string, key = false): string {
    const { r, l } = this;
    const safe = plainSafe(s) && !(key && /^(y|n)$/i.test(s));
    if (safe && !chance(r, l.quote)) return s;
    const single = chance(r, l.singleQ) && !/[\u0000-\u001f]/.test(s);
    return single ? `'${s.replace(/'/g, "''")}'` : JSON.stringify(s);
  }

  scalar(v: string | number | boolean | null): string {
    if (v === null) return chance(this.r, 0.5) ? 'null' : '~';
    if (typeof v === 'string') return this.str(v);
    return String(v);
  }

  flowOk(t: Tree): boolean {
    if (Array.isArray(t)) return t.every((x) => typeof x !== 'object' || x === null || this.flowOk(x));
    if (t !== null && typeof t === 'object') return Object.values(t).every((x) => typeof x !== 'object' || x === null || this.flowOk(x));
    return true;
  }

  flow(t: Tree): string {
    const pad = this.l.flowPad;
    if (Array.isArray(t)) {
      const b = t.map((x) => this.flow(x)).join(', ');
      return t.length === 0 ? '[]' : pad ? `[ ${b} ]` : `[${b}]`;
    }
    if (t !== null && typeof t === 'object') {
      const es = Object.entries(t);
      const b = es.map(([k, v]) => `${this.str(k, true)}: ${this.flow(v)}`).join(', ');
      return es.length === 0 ? '{}' : pad ? `{ ${b} }` : `{${b}}`;
    }
    return this.scalar(t);
  }

  isColl = (t: Tree): boolean => t !== null && typeof t === 'object';
  empty = (t: Tree): boolean => (Array.isArray(t) ? t.length === 0 : this.isColl(t) && Object.keys(t as object).length === 0);

  pre(ind: number, out: string[]): void {
    const { r, l } = this;
    if (chance(r, l.blanks)) out.push('');
    if (chance(r, l.comments)) out.push(`${' '.repeat(ind)}# ${pick(r, WORDS)} ${pick(r, WORDS)}`);
  }

  trailing(): string {
    return chance(this.r, this.l.comments) ? `${' '.repeat(1 + Math.floor(this.r() * 3))}# ${pick(this.r, WORDS)}` : '';
  }

  map(o: { [k: string]: Tree }, ind: number, out: string[], inlineFirst?: string): void {
    const { r, l } = this;
    let first = true;
    for (const [k, v] of Object.entries(o)) {
      if (!(first && inlineFirst !== undefined)) this.pre(ind, out);
      const lead = first && inlineFirst !== undefined ? inlineFirst : ' '.repeat(ind);
      first = false;
      const kt = this.str(k, true);
      if (!this.isColl(v) || this.empty(v)) {
        const vt = this.isColl(v) ? (Array.isArray(v) ? '[]' : '{}') : v === null && chance(r, 0.4) ? '' : this.scalar(v as string);
        out.push(`${lead}${kt}:${vt === '' ? '' : ' ' + vt}${this.trailing()}`);
      } else if (this.flowOk(v) && chance(r, l.flow)) {
        out.push(`${lead}${kt}: ${this.flow(v)}${this.trailing()}`);
      } else if (Array.isArray(v)) {
        out.push(`${lead}${kt}:${this.trailing()}`);
        this.seq(v, l.seqFlush ? ind : ind + l.indent, out);
      } else {
        out.push(`${lead}${kt}:${this.trailing()}`);
        this.map(v as { [k: string]: Tree }, ind + l.indent, out);
      }
    }
  }

  seq(a: Tree[], ind: number, out: string[]): void {
    const { r, l } = this;
    for (const v of a) {
      this.pre(ind, out);
      const dash = `${' '.repeat(ind)}-${' '.repeat(l.dashSpace)}`;
      if (!this.isColl(v) || this.empty(v)) {
        const vt = this.isColl(v) ? (Array.isArray(v) ? '[]' : '{}') : this.scalar(v as string);
        out.push(`${dash}${vt}${this.trailing()}`);
      } else if (this.flowOk(v) && chance(r, l.flow)) {
        out.push(`${dash}${this.flow(v)}${this.trailing()}`);
      } else if (Array.isArray(v)) {
        const sub: string[] = [];
        this.seq(v, ind + 1 + l.dashSpace, sub);
        sub[0] = dash + sub[0]!.slice(ind + 1 + l.dashSpace);
        out.push(...sub);
      } else {
        const sub: string[] = [];
        this.map(v as { [k: string]: Tree }, ind + 1 + l.dashSpace, sub, dash);
        out.push(...sub);
      }
    }
  }
}

/** A document (tree + text) whose text parses back to the tree. */
export function randomDoc(seed: number): { text: string; tree: Tree } {
  const r = makeRng(seed);
  const l = randomLayout(r);
  let tree: Tree = randomTree(r);
  if (tree === null || typeof tree !== 'object') tree = { [pick(r, WORDS)]: tree };
  const e = new Emitter(r, l);
  const out: string[] = [];
  if (chance(r, l.comments)) out.push('# header comment');
  if (Array.isArray(tree)) e.seq(tree, 0, out);
  else e.map(tree as { [k: string]: Tree }, 0, out);
  const eol = l.crlf ? '\r\n' : '\n';
  let text = out.join(eol);
  if (l.finalNewline) text += eol;
  return { text, tree };
}

/** Throws if the generator produced text that does not read back as its tree. */
export function checkDoc(d: { text: string; tree: Tree }): boolean {
  try {
    return JSON.stringify(yamlParse(d.text)) === JSON.stringify(d.tree);
  } catch {
    return false;
  }
}
