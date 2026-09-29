import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CORPUS_DIR = join(ROOT, 'corpus', 'files');

export interface Entry {
  category: string;
  repo: string;
  sha: string;
  path: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface CorpusFile {
  name: string;
  category: string;
  src: string;
}

export const localName = (e: Entry, i: number): string =>
  `${String(i).padStart(2, '0')}-${e.repo.replace('/', '_')}-${basename(e.path)}`;

export function readManifest(): Entry[] {
  return JSON.parse(readFileSync(join(ROOT, 'corpus', 'manifest.json'), 'utf8')) as Entry[];
}

/** Returns the corpus, or null when it has not been fetched (callers skip loudly). */
export function loadCorpus(): CorpusFile[] | null {
  const manifest = readManifest();
  const out: CorpusFile[] = [];
  for (const [i, e] of manifest.entries()) {
    const p = join(CORPUS_DIR, localName(e, i));
    if (!existsSync(p)) return null;
    const buf = readFileSync(p);
    const digest = createHash('sha256').update(buf).digest('hex');
    if (digest !== e.sha256) throw new Error(`corpus file ${localName(e, i)} does not match its pinned sha256`);
    out.push({ name: localName(e, i), category: e.category, src: buf.toString('utf8') });
  }
  return out;
}
