import { parse as yamlParse } from 'yaml';
import { isIndex } from './path.ts';
import type { Seg } from './path.ts';
import { Raw, entriesOf, isCollection } from './scalar.ts';

/** The value as the parser will read it back. */
export function normalise(v: unknown): unknown {
  if (v instanceof Raw) return yamlParse(v.text);
  if (typeof v === 'bigint') return Number(v);
  if (Array.isArray(v)) return v.map(normalise);
  if (isCollection(v)) return Object.fromEntries(entriesOf(v).map(([k, x]) => [k, normalise(x)]));
  return v;
}

export function same(a: unknown, b: unknown, seen: WeakMap<object, object> = new WeakMap()): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Object.is(a, b);
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i], seen));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], seen));
}

type Box = Record<string, unknown> | unknown[];

const child = (c: unknown, s: Seg): unknown => (c as Record<string, unknown>)[String(s)];

function container(root: unknown, segs: readonly Seg[]): Box {
  let cur = root;
  for (const s of segs) cur = child(cur, s);
  return cur as Box;
}

export function setAt(root: unknown, segs: readonly Seg[], v: unknown): unknown {
  if (segs.length === 0) return v;
  const c = container(root, segs.slice(0, -1));
  (c as Record<string, unknown>)[String(segs[segs.length - 1])] = v;
  return root;
}

export function deleteAt(root: unknown, segs: readonly Seg[]): unknown {
  const c = container(root, segs.slice(0, -1));
  const last = segs[segs.length - 1]!;
  if (Array.isArray(c)) c.splice(Number(last), 1);
  else delete (c as Record<string, unknown>)[String(last)];
  return root;
}

function rebuild(m: Record<string, unknown>, entries: Array<[string, unknown]>): void {
  for (const k of Object.keys(m)) delete m[k];
  for (const [k, v] of entries) m[k] = v;
}

export function renameAt(root: unknown, segs: readonly Seg[], newKey: string): unknown {
  const m = container(root, segs.slice(0, -1)) as Record<string, unknown>;
  const old = String(segs[segs.length - 1]);
  rebuild(m, Object.entries(m).map(([k, v]) => [k === old ? newKey : k, v] as [string, unknown]));
  return root;
}

export function insertAt(root: unknown, segs: readonly Seg[], key: string, v: unknown, where: { after?: string; before?: string; first?: boolean }): unknown {
  const m = container(root, segs) as Record<string, unknown>;
  const es = Object.entries(m);
  let at = es.length;
  if (where.first) at = 0;
  else if (where.before !== undefined) at = es.findIndex(([k]) => k === where.before);
  else if (where.after !== undefined) at = es.findIndex(([k]) => k === where.after) + 1;
  es.splice(at, 0, [key, v]);
  rebuild(m, es);
  return root;
}

export function appendAt(root: unknown, segs: readonly Seg[], v: unknown): unknown {
  (container(root, segs) as unknown[]).push(v);
  return root;
}

export const seqIndex = (s: Seg): number => (isIndex(s) ? Number(s) : -1);
