import { parse as yamlParse } from 'yaml';
import { YamlEditError } from './errors.ts';

/** A scalar or flow value written to the document exactly as given (for example `1.20`). */
export class Raw {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** Wraps text that is written verbatim. It must be a single-line scalar or flow collection. */
export const raw = (text: string): Raw => new Raw(text);

const Y11_BOOL = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/;
const Y11_NULL = /^(~|null|Null|NULL)$/;
const Y11_INT = /^[-+]?(0b[0-1_]+|0[0-7_]+|0x[0-9a-fA-F_]+|(0|[1-9][0-9_,]*)|[1-9][0-9_]*(:[0-5]?[0-9])+)$/;
const Y11_FLOAT = /^[-+]?(([0-9][0-9_]*)?\.[0-9_]*([eE][-+]?[0-9]+)?|[0-9][0-9_]*(:[0-5]?[0-9])+\.[0-9_]*)$/;
const Y11_SPECIAL = /^(=|<<|\.(inf|Inf|INF)|-\.(inf|Inf|INF)|\.(nan|NaN|NAN))$/;
const TIMESTAMP = /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}([Tt ][0-9:.]+.*)?$/;
const INDICATOR_START = /^[-?:,[\]{}#&*!|>'"%@`]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;

/**
 * True when `s` written as a plain scalar reads back as the string `s` under YAML 1.2 (core)
 * and does not change type under YAML 1.1 either.
 */
export function plainSafe(s: string, yaml11 = true): boolean {
  if (s === '' || s !== s.trim() || CONTROL.test(s)) return false;
  if (INDICATOR_START.test(s)) {
    // "-x", "?x", ":x" are legal plain scalars, but not worth the risk.
    return false;
  }
  if (/[,[\]{}]/.test(s)) return false; // unsafe inside flow collections
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':') || s.includes('\t')) return false;
  if (s === '---' || s === '...' || s.startsWith('--- ') || s.startsWith('... ')) return false;
  if (yaml11 && (Y11_BOOL.test(s) || Y11_NULL.test(s) || Y11_INT.test(s) || Y11_FLOAT.test(s) || Y11_SPECIAL.test(s) || TIMESTAMP.test(s))) {
    return false;
  }
  try {
    return yamlParse(s) === s;
  } catch {
    return false;
  }
}

export function doubleQuote(s: string): string {
  let out = JSON.stringify(s);
  out = out.replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return out;
}

export function singleQuoteOk(s: string): boolean {
  return !CONTROL.test(s) && !s.includes('\n');
}

export function singleQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export type QuoteStyle = 'plain' | 'double' | 'single';

/** Renders a string with the requested style, falling back to a style that is valid for it. */
export function renderString(s: string, style: QuoteStyle, fallback: 'double' | 'single' = 'double', yaml11 = true): string {
  if (style === 'plain') {
    if (plainSafe(s, yaml11)) return s;
    style = fallback;
  }
  if (style === 'single' && singleQuoteOk(s)) return singleQuote(s);
  return doubleQuote(s);
}

export function renderNumber(n: number): string {
  if (Number.isNaN(n)) return '.nan';
  if (n === Infinity) return '.inf';
  if (n === -Infinity) return '-.inf';
  if (Object.is(n, -0)) return '-0';
  return String(n);
}

/** Text for a non-string, non-collection value. */
export function renderTyped(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return renderNumber(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Raw) {
    if (/[\n\r]/.test(v.text) || v.text.trim() === '') throw new YamlEditError('VALUE', 'raw() text must be a single non-empty line');
    return v.text;
  }
  throw new YamlEditError('VALUE', `cannot write a value of type ${v === undefined ? 'undefined' : typeof v}`);
}

export const isCollection = (v: unknown): boolean =>
  Array.isArray(v) || v instanceof Map || (typeof v === 'object' && v !== null && !(v instanceof Raw) && Object.getPrototypeOf(v) === Object.prototype) || (typeof v === 'object' && v !== null && !(v instanceof Raw) && Object.getPrototypeOf(v) === null);

export function entriesOf(v: unknown): Array<[string, unknown]> {
  if (v instanceof Map) return [...v.entries()].map(([k, x]) => [String(k), x] as [string, unknown]);
  return Object.entries(v as Record<string, unknown>);
}

/** Keys are quoted only when YAML 1.2 would read them as another type (so `on:` and `n:` stay plain). */
export function renderKey(k: string, style: QuoteStyle, fallback: 'double' | 'single' = 'double'): string {
  return renderString(k, style, fallback, false);
}
