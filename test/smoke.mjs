/**
 * Plain-JS checks against the built package, so they run on every Node version
 * in `engines`. The TypeScript suite needs type stripping and only runs on 24+.
 *
 *   npm run build && node --test test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const { parse, raw, YamlEditError } = await import('../dist/index.js');
const cli = new URL('../dist/cli.js', import.meta.url).pathname;

const SRC = '# deploy\nname: app   # keep\nport: 8080\n\nimage: "nginx:1.25"\ntags: [a, b]\nenv:\n  - A=1\n';

test('set keeps comments, blank lines and quote style', () => {
  const d = parse(SRC);
  d.set('image', 'nginx:1.26').set('port', 9090).set('name', 'yes');
  assert.equal(d.toString(), SRC.replace('nginx:1.25', 'nginx:1.26').replace('8080', '9090').replace('name: app', 'name: "yes"'));
});

test('delete, rename, insert and append touch only their own lines', () => {
  const d = parse(SRC);
  d.rename('port', 'listen').delete('tags').insert('', 'replicas', 3, { after: 'listen' }).append('env', 'B=2');
  assert.equal(d.toString(), '# deploy\nname: app   # keep\nlisten: 8080\nreplicas: 3\n\nimage: "nginx:1.25"\nenv:\n  - A=1\n  - B=2\n');
});

test('raw text, paths and errors', () => {
  assert.equal(parse('v: 1.10\n').set('v', raw('1.20')).toString(), 'v: 1.20\n');
  assert.equal(parse('a:\n  b: [1, 2]\n').set('/a/b/1', 5).toString(), 'a:\n  b: [1, 5]\n');
  const d = parse('a: 1\n');
  assert.throws(() => d.set('nope', 1), (e) => e instanceof YamlEditError && e.code === 'NOT_FOUND');
  assert.equal(d.toString(), 'a: 1\n');
});

test('cli edits in place and reports exit codes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yme-'));
  const file = join(dir, 'a.yaml');
  writeFileSync(file, SRC);
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  let r = run('set', file, 'port', '1', '-i');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(file, 'utf8'), SRC.replace('8080', '1'));
  r = run('--in-place', 'append', file, 'env', 'C=3');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(file, 'utf8'), /- C=3\n$/);
  assert.equal(run('delete', file, 'missing').status, 1);
  assert.equal(run('bogus', file).status, 2);
  assert.equal(run('set', join(dir, 'none.yaml'), 'a', '1').status, 2);
});
