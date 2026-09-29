/**
 * Downloads the pinned corpus into corpus/files (gitignored) and verifies each sha256.
 *
 *   npm run corpus
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CORPUS_DIR, localName, readManifest } from './corpus.ts';

mkdirSync(CORPUS_DIR, { recursive: true });
let fetched = 0;
let bad = 0;
for (const [i, e] of readManifest().entries()) {
  const dest = join(CORPUS_DIR, localName(e, i));
  if (existsSync(dest)) continue;
  const body = execFileSync('curl', ['-fsSL', '-m', '30', e.url], { timeout: 40_000, maxBuffer: 1 << 26 });
  const digest = createHash('sha256').update(body).digest('hex');
  if (digest !== e.sha256) {
    console.error(`sha256 mismatch for ${e.url}\n  want ${e.sha256}\n  got  ${digest}`);
    bad++;
    continue;
  }
  writeFileSync(dest, body);
  fetched++;
}
console.log(`fetched ${fetched} files, ${bad} mismatched`);
process.exit(bad ? 1 : 0);
