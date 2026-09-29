import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from '../src/index.ts';

const SRC = `env:
  GO_VERSION: '1.26'   # keep
  PORT: "8080"
  TAG: latest
  IMG: v1.3-ish plain
  N: 3
`;
const cli = new URL('../src/cli.ts', import.meta.url).pathname;

function viaCli(path: string, value: string, ...flags: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'yme-cli-'));
  const f = join(dir, 'a.yaml');
  writeFileSync(f, SRC);
  const r = spawnSync(process.execPath, [cli, 'set', '-i', ...flags, f, path, value], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(f, 'utf8');
}

test('cli: a number-looking value over a quoted string keeps the string and its quotes', () => {
  assert.equal(viaCli('env.GO_VERSION', '1.27'), SRC.replace("'1.26'", "'1.27'"));
  assert.equal(viaCli('env.PORT', '9090'), SRC.replace('"8080"', '"9090"'));
});

test('cli: a number-looking value over a plain string is quoted', () => {
  const out = viaCli('env.TAG', '1.20');
  assert.equal(out, SRC.replace('TAG: latest', 'TAG: "1.20"'));
  assert.equal(parse(out).get('env.TAG'), '1.20');
});

test('cli: numbers stay typed, and -s forces a string', () => {
  assert.equal(viaCli('env.N', '4'), SRC.replace('N: 3', 'N: 4'));
  assert.equal(viaCli('env.N', '4', '-s'), SRC.replace('N: 3', 'N: "4"'));
  assert.equal(viaCli('env.PORT', '9090', '-j'), SRC.replace('"8080"', '9090'));
});

test('api: strings over strings stay strings, numbers over numbers stay numbers', () => {
  const d = parse(SRC);
  d.set('env.GO_VERSION', '1.27').set('env.PORT', '9090').set('env.TAG', '1.20').set('env.N', 4);
  assert.equal(d.toString(), SRC.replace("'1.26'", "'1.27'").replace('"8080"', '"9090"').replace('TAG: latest', 'TAG: "1.20"').replace('N: 3', 'N: 4'));
  assert.equal(d.get('env.TAG'), '1.20');
  assert.equal(d.get('env.N'), 4);
});
