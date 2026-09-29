import { YamlEditError } from './errors.ts';

export type Seg = string | number;
export type Path = string | ReadonlyArray<Seg>;

const INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Parses `a.b[2].c`, quoted segments (`a."b.c"`, `a['b c']`, `["x"]`), or a JSON Pointer
 * (a string starting with `/`). An array is used as given. The empty string is the root.
 */
export function parsePath(input: Path): Seg[] {
  if (typeof input !== 'string') return [...input];
  if (input === '') return [];
  if (input.startsWith('/')) return parsePointer(input);
  return parseDotted(input);
}

function parsePointer(p: string): Seg[] {
  return p
    .slice(1)
    .split('/')
    .map((raw) => {
      if (/~[^01]|~$/.test(raw)) throw new YamlEditError('PATH_SYNTAX', `invalid JSON Pointer escape in "${raw}"`);
      return raw.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

function parseDotted(p: string): Seg[] {
  const out: Seg[] = [];
  let i = 0;
  const fail = (msg: string): never => {
    throw new YamlEditError('PATH_SYNTAX', `${msg} at position ${i} in path ${JSON.stringify(p)}`);
  };
  const quoted = (): string => {
    const q = p[i++]!;
    let s = '';
    for (;;) {
      if (i >= p.length) return fail('unterminated quoted segment');
      const c = p[i++]!;
      if (c === q) return s;
      if (c === '\\') {
        if (i >= p.length) return fail('dangling backslash');
        s += p[i++]!;
      } else s += c;
    }
  };
  let first = true;
  while (i < p.length) {
    const c = p[i]!;
    if (c === '[') {
      i++;
      if (p[i] === '"' || p[i] === "'") {
        out.push(quoted());
      } else {
        const j = p.indexOf(']', i);
        if (j < 0) fail('missing ]');
        const inner = p.slice(i, j).trim();
        if (!INDEX.test(inner)) fail('expected an index or a quoted key in []');
        out.push(Number(inner));
        i = j;
      }
      if (p[i] !== ']') fail('missing ]');
      i++;
    } else {
      if (c === '.') {
        if (first && i === 0) {
          i++;
          continue;
        }
        i++;
        if (i >= p.length || p[i] === '.' || p[i] === '[') fail('empty segment');
      } else if (!first && out.length > 0) {
        fail('expected . or [');
      }
      if (p[i] === '"' || p[i] === "'") out.push(quoted());
      else {
        let j = i;
        while (j < p.length && !'.[]"\''.includes(p[j]!)) j++;
        if (j === i) fail('empty segment');
        out.push(p.slice(i, j));
        i = j;
      }
    }
    first = false;
  }
  return out;
}

/** `a.b[2]`-style rendering for messages. */
export function showPath(segs: readonly Seg[]): string {
  if (segs.length === 0) return '(root)';
  return segs.map((s, i) => (typeof s === 'number' ? `[${s}]` : (i ? '.' : '') + (/^[^.[\]"']+$/.test(s) ? s : JSON.stringify(s)))).join('');
}

export const isIndex = (s: Seg): boolean => typeof s === 'number' || INDEX.test(s);
