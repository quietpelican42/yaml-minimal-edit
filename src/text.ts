import type { YAMLSeq } from 'yaml';

export const lineStart = (s: string, o: number): number => (o <= 0 ? 0 : s.lastIndexOf('\n', o - 1) + 1);
/** Index of the `\n` ending the line containing `o` (or the text length). */
export const lineEnd = (s: string, o: number): number => {
  const i = s.indexOf('\n', o);
  return i < 0 ? s.length : i;
};
/** Start of the line after the one containing `o` (or the text length). */
export const nextLine = (s: string, o: number): number => {
  const i = s.indexOf('\n', o);
  return i < 0 ? s.length : i + 1;
};
export const colOf = (s: string, o: number): number => o - lineStart(s, o);
export const trimBack = (s: string, o: number): number => {
  while (o > 0 && /\s/.test(s[o - 1]!)) o--;
  return o;
};
/** End of the line's content, excluding a trailing `\r`. */
export const contentLineEnd = (s: string, o: number): number => {
  const e = lineEnd(s, o);
  return e > 0 && s[e - 1] === '\r' && e - 1 >= o ? e - 1 : e;
};

/** Offsets of the `-` indicators of a block sequence. */
export function blockSeqDashes(seq: YAMLSeq): number[] {
  const tok = seq.srcToken as unknown as { items?: Array<{ start: Array<{ type: string; offset: number }> }> } | undefined;
  if (!tok?.items) return [];
  return tok.items.map((it) => it.start.find((t) => t.type === 'seq-item-ind')?.offset ?? -1).filter((o) => o >= 0);
}

export interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Applies non-overlapping splices to the original text. */
export function applySplices(s: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = '';
  let pos = 0;
  for (const sp of sorted) {
    if (sp.start < pos) throw new Error('overlapping splices');
    out += s.slice(pos, sp.start) + sp.text;
    pos = sp.end;
  }
  return out + s.slice(pos);
}
