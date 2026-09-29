import assert from 'node:assert/strict';
import test from 'node:test';
import { YamlEditError, parse, parsePath, raw } from '../src/index.ts';

const edit = (src: string, f: (d: ReturnType<typeof parse>) => unknown): string => {
  const d = parse(src);
  f(d);
  return d.toString();
};

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof YamlEditError) return e.code;
    throw e;
  }
  return 'none';
};

test('paths: dotted, bracket, quoted and JSON Pointer forms agree', () => {
  assert.deepEqual(parsePath('a.b[2].c'), ['a', 'b', 2, 'c']);
  assert.deepEqual(parsePath('a."b.c"[0]'), ['a', 'b.c', 0]);
  assert.deepEqual(parsePath("a['x y'].z"), ['a', 'x y', 'z']);
  assert.deepEqual(parsePath('["a"]["b"]'), ['a', 'b']);
  assert.deepEqual(parsePath('/a/b~1c/0/~0'), ['a', 'b/c', '0', '~']);
  assert.deepEqual(parsePath(''), []);
  assert.deepEqual(parsePath(['x', 1]), ['x', 1]);
  for (const bad of ['a..b', 'a.', 'a[x]', 'a[1', '"unterminated', 'a[1]b']) assert.equal(code(() => parsePath(bad)), 'PATH_SYNTAX', bad);
  assert.equal(code(() => parsePath('/a~2')), 'PATH_SYNTAX');
});

test('set keeps every other byte and the quote style of a string', () => {
  const src = `# top\n\nname:   "old"   # why\nother: 'single'\nplain: word\n\n\nlast: 1\n`;
  assert.equal(edit(src, (d) => d.set('name', 'new')), src.replace('"old"', '"new"'));
  assert.equal(edit(src, (d) => d.set('other', "it's")), src.replace("'single'", "'it''s'"));
  assert.equal(edit(src, (d) => d.set('plain', 'other')), src.replace('word', 'other'));
});

test('set never changes a string into another type', () => {
  for (const s of ['1.20', 'yes', 'on', '0755', '1_000', '12:30', 'null', '~', 'true', '1e3', '0x1F', '2001-01-01', '']) {
    const out = edit('v: word\n', (d) => d.set('v', s));
    const d = parse(out);
    assert.equal(d.get('v'), s, `${s} -> ${JSON.stringify(out)}`);
    assert.match(out, /^v: ["']/, `${s} must be quoted: ${out}`);
  }
  assert.equal(edit('v: word\n', (d) => d.set('v', 'plain text')), 'v: plain text\n');
  assert.equal(edit("v: 'word'\n", (d) => d.set('v', 'yes')), "v: 'yes'\n");
  assert.equal(edit('v: "word"\n', (d) => d.set('v', 'a "quoted" b')), 'v: "a \\"quoted\\" b"\n');
});

test('set writes numbers, booleans and null as typed values', () => {
  assert.equal(edit('v: "8080"\n', (d) => d.set('v', 8080)), 'v: 8080\n');
  assert.equal(edit("v: 'x'\n", (d) => d.set('v', true)), 'v: true\n');
  assert.equal(edit('v: 1\n', (d) => d.set('v', null)), 'v: null\n');
  assert.equal(edit('v: 1\n', (d) => d.set('v', 1.5)), 'v: 1.5\n');
  assert.equal(edit('v: 1\n', (d) => d.set('v', Number.NaN)), 'v: .nan\n');
  assert.equal(edit('v: 1\n', (d) => d.set('v', 10n ** 20n)), 'v: 100000000000000000000\n');
});

test('a string over a number is quoted only when it would change type', () => {
  assert.equal(edit('port: 8080\n', (d) => d.set('port', '8080')), 'port: "8080"\n');
  assert.equal(edit('port: 8080\n', (d) => d.set('port', 'http')), 'port: http\n');
});

test('raw() writes the text as given', () => {
  assert.equal(edit('v: 1.10  # keep\n', (d) => d.set('v', raw('1.20'))), 'v: 1.20  # keep\n');
  assert.equal(code(() => parse('v: 1\n').set('v', raw('a\nb'))), 'VALUE');
});

test('set on null values and empty items', () => {
  assert.equal(edit('a:\nb: 2\n', (d) => d.set('a', 'x')), 'a: x\nb: 2\n');
  assert.equal(edit('a: # note\nb: 2\n', (d) => d.set('a', 1)), 'a: 1 # note\nb: 2\n');
  assert.equal(edit('- a\n-\n- c\n', (d) => d.set('[1]', 'b')), '- a\n- b\n- c\n');
});

test('set replaces scalars with collections and back, keeping the key line comment', () => {
  assert.equal(edit('a: 1 # c\nb: 2\n', (d) => d.set('a', { x: 1, y: [1, 2] })), 'a: # c\n  x: 1\n  y:\n    - 1\n    - 2\nb: 2\n');
  assert.equal(edit('a: # c\n  x: 1\n  y: 2\nb: 2\n', (d) => d.set('a', 'v')), 'a: v # c\nb: 2\n');
  assert.equal(edit('a: [1, 2]\n', (d) => d.set('a', [3])), 'a: [3]\n');
  assert.equal(edit('a: {x: 1}\n', (d) => d.set('a.x', 'q')), 'a: {x: q}\n');
});

test('set on block scalars keeps the block form', () => {
  const src = 'run: |\n  echo a\n  echo b\nnext: 1\n';
  assert.equal(edit(src, (d) => d.set('run', 'echo c\necho d\n')), 'run: |\n  echo c\n  echo d\nnext: 1\n');
  assert.equal(edit(src, (d) => d.set('run', 'single')), 'run: |-\n  single\nnext: 1\n');
  assert.equal(edit(src, (d) => d.set('run', 7)), 'run: 7\nnext: 1\n');
});

test('set on a multi-line plain scalar collapses it to one line', () => {
  assert.equal(edit('a: one\n  two\nb: 1\n', (d) => d.set('a', 'x')), 'a: x\nb: 1\n');
});

test('set replaces an alias and refuses to edit through one or inside a referenced anchor', () => {
  const src = 'base: &b\n  x: 1\nuse: *b\nv: &s one\nw: *s\n';
  assert.equal(edit(src, (d) => d.set('use', 'plain')), src.replace('*b', 'plain'));
  assert.equal(code(() => parse(src).set('use.x', 2)), 'ALIAS');
  assert.equal(code(() => parse(src).set('base.x', 2)), 'ANCHOR');
  assert.equal(code(() => parse(src).set('v', 'two')), 'ANCHOR');
  assert.equal(code(() => parse(src).delete('base')), 'ANCHOR');
  assert.equal(edit('a: &u one\nb: 2\n', (d) => d.set('a', 'two')), 'a: &u two\nb: 2\n');
});

test('a refused edit leaves the text unchanged', () => {
  const d = parse('a: !!str 5\n');
  assert.equal(code(() => d.set('a', 6)), 'VERIFY');
  assert.equal(d.toString(), 'a: !!str 5\n');
  assert.equal(code(() => d.set('nope', 1)), 'NOT_FOUND');
  assert.equal(code(() => d.set('a.b', 1)), 'NOT_FOUND');
  assert.equal(code(() => d.set('a', undefined)), 'VALUE');
  assert.equal(code(() => d.set('a', new Date())), 'VALUE');
  assert.equal(d.toString(), 'a: !!str 5\n');
  assert.equal(code(() => parse('a: [')), 'PARSE');
});

test('delete removes the entry and the comment lines directly above it', () => {
  const src = '# keep me\n\n# gone\n# also gone\na: 1 # trailing\n\n# stays: blank line above\nb: 2\n\n# other\nc: 3\n';
  assert.equal(edit(src, (d) => d.delete('a')), '# keep me\n\n\n# stays: blank line above\nb: 2\n\n# other\nc: 3\n');
  assert.equal(edit(src, (d) => d.delete('c')), src.replace('# other\nc: 3\n', ''));
  // a comment separated by a blank line stays
  assert.equal(edit('x: 1\n# lone\n\ny: 2\n', (d) => d.delete('y')), 'x: 1\n# lone\n\n');
});

test('delete handles nested values, sequence items and the last line without a newline', () => {
  const src = 'a:\n  b:\n    - 1\n    - 2\n  c: 3\nd: 4';
  assert.equal(edit(src, (d) => d.delete('a.b')), 'a:\n  c: 3\nd: 4');
  assert.equal(edit(src, (d) => d.delete('d')), 'a:\n  b:\n    - 1\n    - 2\n  c: 3');
  assert.equal(edit(src, (d) => d.delete('a.b[0]')), 'a:\n  b:\n    - 2\n  c: 3\nd: 4');
});

test('delete of the only child leaves an empty collection', () => {
  assert.equal(edit('a:\n  b: 1\nc: 2\n', (d) => d.delete('a.b')), 'a: {}\nc: 2\n');
  assert.equal(edit('a:\n  - 1\nc: 2\n', (d) => d.delete('a[0]')), 'a: []\nc: 2\n');
  assert.equal(edit('[1]\n', (d) => d.delete('[0]')), '[]\n');
});

test('delete in flow collections takes the comma with it', () => {
  assert.equal(edit('a: {x: 1, y: 2, z: 3}\n', (d) => d.delete('a.y')), 'a: {x: 1, z: 3}\n');
  assert.equal(edit('a: {x: 1, y: 2}\n', (d) => d.delete('a.y')), 'a: {x: 1}\n');
  assert.equal(edit('a: [1, 2, 3]\n', (d) => d.delete('a[0]')), 'a: [2, 3]\n');
  assert.equal(edit('a: [\n  1,\n  2,\n]\n', (d) => d.delete('a[1]')), 'a: [\n  1,\n]\n');
});

test('delete of the first key on a dash line moves the next key up', () => {
  assert.equal(edit('- name: a\n  run: b\n- name: c\n', (d) => d.delete('[0].name')), '- run: b\n- name: c\n');
});

test('delete with a comment line under a dash-line key keeps it attached to the next key', () => {
  assert.equal(
    edit('- uses: a # x\n  # about with\n  with: b\n', (d) => d.delete('[0].uses')),
    '-\n  # about with\n  with: b\n',
  );
});

test('rename replaces only the key text and keeps its quote style', () => {
  assert.equal(edit('# c\nold: 1 # v\nz: 2\n', (d) => d.rename('old', 'new')), '# c\nnew: 1 # v\nz: 2\n');
  assert.equal(edit('"old": 1\n', (d) => d.rename('old', 'new key')), '"new key": 1\n');
  assert.equal(edit("'old': 1\n", (d) => d.rename('old', "it's")), "'it''s': 1\n");
  assert.equal(edit('old: 1\n', (d) => d.rename('old', 'has: colon')), 'old: 1\n'.replace('old', '"has: colon"'));
  assert.equal(edit('a: {x: 1, y: 2}\n', (d) => d.rename('a.x', 'q')), 'a: {q: 1, y: 2}\n');
  assert.equal(edit('a: 1\n', (d) => d.rename('a', 'on')), 'on: 1\n');
  assert.equal(code(() => parse('a: 1\nb: 2\n').rename('a', 'b')), 'EXISTS');
  assert.equal(code(() => parse('- a\n').rename('[0]', 'b')), 'TYPE');
});

test('insert goes after the last sibling and before the blank line that follows it', () => {
  const src = 'a: 1\nb: 2\n\n# section\nc: 3\n';
  assert.equal(edit(src, (d) => d.insert('', 'z', 'x')), src + 'z: x\n');
  const nested = 'top:\n  a: 1\n  b: 2\n\nnext: 1\n';
  assert.equal(edit(nested, (d) => d.insert('top', 'c', 3)), 'top:\n  a: 1\n  b: 2\n  c: 3\n\nnext: 1\n');
});

test('insert after a sibling goes right below it, ahead of the blank line that follows', () => {
  assert.equal(edit('a: 1\n\n# about b\nb: 2\n', (d) => d.insert('', 'x', 0, { after: 'a' })), 'a: 1\nx: 0\n\n# about b\nb: 2\n');
  assert.equal(edit('a: 1\n\n# about b\nb: 2\n', (d) => d.insert('', 'x', 0, { before: 'b' })), 'a: 1\n\nx: 0\n# about b\nb: 2\n');
});

test('insert honours after, before and first, and keeps comments attached to the sibling', () => {
  const src = '# doc\n\n# about a\na: 1\nb: 2\n';
  assert.equal(edit(src, (d) => d.insert('', 'x', 0, { after: 'a' })), '# doc\n\n# about a\na: 1\nx: 0\nb: 2\n');
  assert.equal(edit(src, (d) => d.insert('', 'x', 0, { before: 'a' })), '# doc\n\nx: 0\n# about a\na: 1\nb: 2\n');
  assert.equal(edit(src, (d) => d.insert('', 'x', 0, { first: true })), '# doc\n\nx: 0\n# about a\na: 1\nb: 2\n');
  assert.equal(code(() => parse(src).insert('', 'a', 1)), 'EXISTS');
  assert.equal(code(() => parse(src).insert('', 'x', 1, { after: 'nope' })), 'NOT_FOUND');
  assert.equal(code(() => parse(src).insert('', 'x', 1, { after: 'a', first: true })), 'VALUE');
});

test('insert matches indent step, quote style and sequence style of the document', () => {
  const src = 'svc:\n    name: "a"\n    ports:\n    - "80"\n    - "81"\n';
  const out = edit(src, (d) => d.insert('svc', 'image', 'nginx').insert('svc', 'cmd', ['run', '-x']).insert('svc', 'env', { A: 'b', C: { D: 1 } }));
  assert.equal(
    out,
    src + '    image: "nginx"\n    cmd:\n    - "run"\n    - "-x"\n    env:\n        A: "b"\n        C:\n            D: 1\n',
  );
});

test('insert matches flow style of sibling collections', () => {
  assert.equal(edit('a: [1]\nb: [2]\n', (d) => d.insert('', 'c', [3, 4])), 'a: [1]\nb: [2]\nc: [3, 4]\n');
  assert.equal(edit('a: {x: 1}\n', (d) => d.insert('', 'c', { y: 2 })), 'a: {x: 1}\nc: {y: 2}\n');
  assert.equal(edit('a:\n  - 1\n', (d) => d.insert('', 'c', [3])), 'a:\n  - 1\nc:\n  - 3\n');
});

test('insert into flow maps, empty maps and null values', () => {
  assert.equal(edit('a: {x: 1, y: 2}\n', (d) => d.insert('a', 'z', 3)), 'a: {x: 1, y: 2, z: 3}\n');
  assert.equal(edit('a: {x: 1, y: 2}\n', (d) => d.insert('a', 'z', 3, { first: true })), 'a: {z: 3, x: 1, y: 2}\n');
  assert.equal(edit('a: {}\nb: 1\n', (d) => d.insert('a', 'z', 3)), 'a: {z: 3}\nb: 1\n');
  assert.equal(edit('a:\nb: 1\n', (d) => d.insert('a', 'z', 3)), 'a:\n  z: 3\nb: 1\n');
  assert.equal(edit('a: {\n  x: 1,\n  y: 2\n}\n', (d) => d.insert('a', 'z', 3)), 'a: {\n  x: 1,\n  y: 2,\n  z: 3\n}\n');
});

test('insert into a sequence item mapping and at the start of a dash line', () => {
  const src = '- name: a\n  run: b\n- name: c\n';
  assert.equal(edit(src, (d) => d.insert('[0]', 'id', 'x')), '- name: a\n  run: b\n  id: x\n- name: c\n');
  assert.equal(edit(src, (d) => d.insert('[0]', 'id', 'x', { first: true })), '- id: x\n  name: a\n  run: b\n- name: c\n');
});

test('insert into an empty document', () => {
  assert.equal(edit('', (d) => d.insert('', 'a', 1)), 'a: 1\n');
  assert.equal(edit('# just a comment\n', (d) => d.insert('', 'a', 1)), '# just a comment\na: 1\n');
});

test('append follows the sequence layout', () => {
  assert.equal(edit('a:\n- 1\n- 2\nb: 1\n', (d) => d.append('a', 3)), 'a:\n- 1\n- 2\n- 3\nb: 1\n');
  assert.equal(edit('a:\n    -   x\n    -   y\n', (d) => d.append('a', 'z')), 'a:\n    -   x\n    -   y\n    -   z\n');
  assert.equal(edit('- a: 1\n  b: 2\n', (d) => d.append('', { a: 3, b: 4 })), '- a: 1\n  b: 2\n- a: 3\n  b: 4\n');
  assert.equal(edit('a: [1, 2]\n', (d) => d.append('a', 3)), 'a: [1, 2, 3]\n');
  assert.equal(edit('a: []\n', (d) => d.append('a', 3)), 'a: [3]\n');
  assert.equal(edit('a:\nb: 1\n', (d) => d.append('a', 3)), 'a:\n  - 3\nb: 1\n');
  assert.equal(edit('a: [\n  1,\n  2,\n]\n', (d) => d.append('a', 3)), 'a: [\n  1,\n  2,\n  3,\n]\n');
  assert.equal(edit('a:\n  - x # c\n\nb: 1\n', (d) => d.append('a', 'z')), 'a:\n  - x # c\n  - z\n\nb: 1\n');
  assert.equal(edit('a:\n  - x\n', (d) => d.append('a', 'yes')), 'a:\n  - x\n  - "yes"\n');
  assert.equal(code(() => parse('a: 1\n').append('a', 1)), 'TYPE');
});

test('new strings follow the dominant quote style among siblings', () => {
  assert.equal(edit('a: "x"\nb: "y"\n', (d) => d.insert('', 'c', 'z')), 'a: "x"\nb: "y"\nc: "z"\n');
  assert.equal(edit("a: 'x'\nb: 'y'\n", (d) => d.insert('', 'c', 'z')), "a: 'x'\nb: 'y'\nc: 'z'\n");
  assert.equal(edit('a: x\nb: y\nc: "quoted"\n', (d) => d.insert('', 'd', 'z')), 'a: x\nb: y\nc: "quoted"\nd: z\n');
  assert.equal(edit('a: x\nb: y\n', (d) => d.insert('', 'c', '1.0')), 'a: x\nb: y\nc: "1.0"\n');
});

test('line endings and a missing final newline are respected', () => {
  assert.equal(edit('a: 1\r\nb: 2\r\n', (d) => d.insert('', 'c', 3)), 'a: 1\r\nb: 2\r\nc: 3\r\n');
  assert.equal(edit('a: 1\r\nb: 2\r\n', (d) => d.delete('a')), 'b: 2\r\n');
  assert.equal(edit('a:\r\n  - 1\r\n', (d) => d.append('a', 2)), 'a:\r\n  - 1\r\n  - 2\r\n');
  assert.equal(edit('a: 1\nb: 2', (d) => d.insert('', 'c', 3)), 'a: 1\nb: 2\nc: 3');
});

test('multi-document streams edit one document and leave the rest alone', () => {
  const src = '# first\na: 1\n---\n# second\na: 2\n...\n---\na: 3\n';
  const d = parse(src);
  assert.equal(d.documents, 3);
  d.set('a', 20, { document: 1 });
  assert.equal(d.toString(), src.replace('a: 2', 'a: 20'));
  d.insert('', 'b', 'x', { document: 2 });
  assert.equal(d.get('b', { document: 2 }), 'x');
  assert.equal(d.get('a', { document: 0 }), 1);
  assert.equal(code(() => d.set('a', 1, { document: 5 })), 'NOT_FOUND');
});

test('numeric and odd keys resolve', () => {
  const src = '200:\n  desc: ok\n"a b": 1\n? c\n: 2\n';
  assert.equal(edit(src, (d) => d.set('200.desc', 'fine')), src.replace('ok', 'fine'));
  assert.equal(edit(src, (d) => d.set('["a b"]', 2)), src.replace('"a b": 1', '"a b": 2'));
  assert.equal(edit(src, (d) => d.set('/200/desc', 'fine')), src.replace('ok', 'fine'));
});

test('get and has read plain data', () => {
  const d = parse('a: {b: [1, {c: x}]}\n');
  assert.equal(d.get('a.b[1].c'), 'x');
  assert.equal(d.has('a.b[2]'), false);
  assert.equal(d.has('a.b[0]'), true);
});
