# yaml-minimal-edit

Edits YAML by splicing bytes into the original text, so comments, blank lines, indentation, quote style, flow or block style and key order stay as they were everywhere except the edited value or key.

```ts
import { parse } from 'yaml-minimal-edit';

const doc = parse('# service\nname: api   # public\n\nreplicas: 3\ntags: [web, "edge"]\n');
doc.set('replicas', 4).append('tags', 'beta').insert('', 'port', 8080, { after: 'name' });
console.log(doc.toString());
// # service
// name: api   # public
// port: 8080
//
// replicas: 4
// tags: [web, "edge", beta]
```

## Why

The `yaml` Document API and most other libraries edit by serializing the whole document again. That changes comment spacing (`  #` becomes ` #`), pads or unpads flow collections, drops blank lines and re-indents. Tuning `indent` and `indentSeq` per file helps but does not remove these. The request for source-preserving edits (eemeli/yaml#207, "Allow source modifications with minimal changes") was closed without an API.

An edit is clean when the result re-parses to exactly the expected data (values and key order) and a line diff touches only the intended lines. The corpus is 62 real files pinned to commit SHAs with a sha256 each: GitHub workflows, Kubernetes manifests, Helm values, Compose files, OpenAPI documents, `.gitlab-ci.yml`, dependabot and renovate configs. Each file gets up to three edits of each type, chosen by a seeded shuffle.

Measured: `npm run corpus && npm run bench:setup && npm run bench` (Node 24.20.0, macOS). Clean edits out of 1058:

```
tool                                        set    set (tricky    rename  delete  insert  append  all
                                                   strings)
yaml-minimal-edit                           100%   100%           100%    100%    100%    100%    1058/1058
yaml 2.9.1 Document API, best options       53.0%  53.0%          53.5%   51.6%   53.9%   53.9%   562/1058 (53.1%)
yaml 2.9.1 Document API, defaults           35.7%  35.1%          35.1%   34.6%   35.6%   32.6%   369/1058 (34.9%)
yaml 2.9.1 CST setScalarValue (set only)    100%   60.5%          -       -       -       -       297/1058 (28.1%)
@effected/yaml 0.18.0 modifyToString        96.8%  96.8%          -       14.3%   13.3%   6.4%    417/1058 (39.4%)
@pnpm/yaml.document-sync 1100.0.2           40.0%  40.0%          11.9%   39.0%   40.6%   39.0%   369/1058 (34.9%)
yaml-diff-patch 2.0.0                       33.5%  33.0%          13.0%   32.4%   32.8%   29.8%   307/1058 (29.0%)
yawn-yaml 3.0.0                             35.7%  35.1%          9.2%    34.6%   35.6%   32.6%   321/1058 (30.3%)
yaml-update 0.1.2                           1.1%   2.7%           0.0%    7.1%    12.8%   0.0%    43/1058 (4.1%)
js-yaml 5.4.2 load/dump                     1.6%   1.6%           1.6%    4.9%    1.7%    2.1%    24/1058 (2.3%)
yaml-cfn 0.3.2 (js-yaml based)              1.6%   1.6%           1.6%    4.4%    1.7%    2.1%    23/1058 (2.2%)
yaml-edit 0.1.3 (insert only)               -      -              -       -       0.6%    -       1/1058 (0.1%)
yml-in-place 1.0.2 (append only)            -      -              -       -       -       27.0%   38/1058 (3.6%)
```

`-` means the tool has no API for that edit, and it counts as not clean in the last column. "Tricky strings" sets a string scalar to `1.20`, `yes`, `on`, `0755`, `1_000`, `12:30`, `null` or `~`, which must stay strings. The two tools that splice only the scalar are the closest incumbents. `setScalarValue` returned a result that changed the data for 39.5% of the tricky-string sets. `@effected/yaml` falls back to re-serializing the whole document for delete, insert and append. Full per-tool failure reasons are printed by `npm run bench`.

Packages checked and not measured: `@stoplight/yaml` and `yaml-ast-parser` (parse-only; no editor built on `yaml-ast-parser` turned up in npm searches), `@json-render/yaml` (a streaming wire format for a UI spec, not a document editor), `@crewhaus/spec-patch` (domain patches).

## Installation

```sh
npm install yaml-minimal-edit
```

Node >= 20.6. One runtime dependency, `yaml` (eemeli), used only to parse and to locate source ranges. It never writes output. No other library gives source offsets for every node together with a full YAML 1.2 parser, and writing a second parser would be the larger risk.

## Usage

### Set, delete, rename

```ts
const doc = parse(text);
doc.set('jobs.build.steps[2].name', 'Test');   // string over string keeps the quote style
doc.set('/jobs/build/timeout-minutes', 30);     // JSON Pointer
doc.rename('jobs.build', 'ci');
doc.delete('jobs.ci.env.DEBUG');                // also removes comment lines directly above it
```

### Insert and append

```ts
doc.insert('services.web', 'restart', 'always');                    // after the last sibling
doc.insert('services.web', 'image', 'nginx', { first: true });
doc.insert('services.web', 'ports', ['80:80'], { after: 'image' });
doc.append('services.web.ports', '443:443');
```

New text matches its surroundings: indent step, sequences flush with their key or indented, dash spacing, dominant quote style among siblings, and flow or block style of sibling collections. A new key goes on the line after the last sibling's last line, ahead of any blank line that separates the next group.

### Strings stay strings

```ts
parse('version: "3.10"\n').set('version', '3.11').toString();   // version: "3.11"
parse('mode: strict\n').set('mode', 'yes').toString();          // mode: "yes"
parse('port: 8080\n').set('port', '8080').toString();           // port: "8080"
parse('port: 8080\n').set('port', 9090).toString();             // port: 9090
```

A plain string that would read as another type under YAML 1.2 or 1.1 (`1.20`, `yes`, `on`, `0755`, `1_000`, `12:30`, `null`, dates) is quoted. Numbers, booleans and null are written as typed values. To write exact text such as `1.20` as a number, use `raw('1.20')`.

### Multiple documents

```ts
const doc = parse('a: 1\n---\na: 2\n');
doc.set('a', 3, { document: 1 });
```

### Command line

```sh
yaml-minimal-edit set config.yaml server.port 8080 -i
yaml-minimal-edit insert config.yaml server host localhost --after port
yaml-minimal-edit append .github/dependabot.yml updates '{package-ecosystem: npm, directory: /}' -i
yaml-minimal-edit delete config.yaml -d 1 legacy.flag
```

Without `-i` the edited text goes to stdout.

## Reference

### `parse(src: string): Doc`

Throws `YamlEditError` with code `PARSE` if the text is not valid YAML.

### `Doc`

| Member | Description |
| --- | --- |
| `documents` | Number of documents in the stream. |
| `toString()` | The current text. |
| `get(path, opts?)` | The value at `path` as plain data. Throws `NOT_FOUND`. |
| `has(path, opts?)` | True if `path` exists. |
| `set(path, value, opts?)` | Replace a value. A scalar, alias or collection can be replaced with any value. |
| `delete(path, opts?)` | Remove a mapping entry or sequence item. |
| `rename(path, newKey, opts?)` | Rename a mapping key. |
| `insert(path, key, value, opts?)` | Add `key: value` to the mapping at `path` (`""` is the root). |
| `append(path, value, opts?)` | Add an item to the end of the sequence at `path`. |

Every edit method returns the `Doc`. After an edit the text is re-parsed and compared with the intended data. If they differ, the method throws `VERIFY` and the text is unchanged. Any thrown `YamlEditError` leaves the text unchanged.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `document` | number | `0` | Document of a multi-document stream. |
| `after` | string | | `insert` only: place after this sibling key. |
| `before` | string | | `insert` only: place before this sibling key (above its attached comments). |
| `first` | boolean | `false` | `insert` only: place first. |

### Paths

A path is a string or an array of segments.

| Form | Example |
| --- | --- |
| Dotted | `a.b[2].c` |
| Quoted segments | `a."b.c"`, `a['b c']`, `["x"]["y"]` |
| JSON Pointer (starts with `/`) | `/a/b~1c/2` |
| Array | `['a', 'b.c', 2]` |
| Root | `''` |

A bracketed number is a sequence index (or a numeric key on a mapping). Keys are matched by their string form, so `200.description` finds the key `200`.

### Values

Strings, numbers, booleans, `null`, `bigint`, arrays, plain objects, `Map`, and `raw(text)`. Anything else (`undefined`, `Date`, functions) throws `VALUE`.

### Errors

`YamlEditError` has a `code`:

| Code | Meaning |
| --- | --- |
| `PARSE` | The input is not valid YAML. |
| `PATH_SYNTAX` | The path string is malformed. |
| `NOT_FOUND` | The path, sibling key or document does not exist. |
| `ALIAS` | The path goes through an alias (`*name`). |
| `ANCHOR` | The target is inside, or contains, an anchor that an alias refers to. |
| `EXISTS` | The key already exists (`insert`, `rename`). |
| `TYPE` | The target is not the right kind of node. |
| `VALUE` | The value cannot be written. |
| `UNSUPPORTED` | A layout the splicer does not handle (see Limitations). |
| `VERIFY` | The edited text did not re-parse to the intended data. |

### CLI

```
yaml-minimal-edit <command> [options] FILE ARGS...
  set FILE PATH VALUE          delete FILE PATH
  rename FILE PATH NEWKEY      append FILE PATH VALUE
  insert FILE PATH KEY VALUE
```

| Flag | Description |
| --- | --- |
| `-i`, `--in-place` | Write the file instead of printing. |
| `-d`, `--document N` | Document number, default 0. |
| `-s`, `--string` | VALUE is a string. |
| `-j`, `--json` | VALUE is JSON. |
| `--after KEY`, `--before KEY`, `--first` | Position for `insert`. |
| `-h`, `--help` | Usage. |

Flags may appear anywhere. VALUE is read as a YAML scalar or flow collection; a plain scalar is written as typed (`1.20` stays `1.20`), and a scalar written over an existing string stays a string.

| Exit code | Meaning |
| --- | --- |
| 0 | The edit was made. |
| 1 | The edit was refused (`NOT_FOUND`, `ALIAS`, `ANCHOR`, `EXISTS`, `TYPE`, `VALUE`, `UNSUPPORTED`, `VERIFY`). The file is unchanged. |
| 2 | Usage error, unreadable file, or invalid YAML input. |

## How it works

The `yaml` parser supplies a node tree with source offsets and the CST tokens for sequence dashes. Each edit computes a list of splices (start, end, replacement) against the original text, applies them, and re-parses. The re-parsed data must equal the original data with the intended change applied, including key order. Only then is the new text kept.

Deleting removes whole lines, from the key through its last value line, plus comment-only lines directly above it at the same indent. Blank lines are never removed. Deleting the only child leaves `{}` or `[]`. Deleting the first key of `- key: v` moves the next key up next to the dash.

## Limitations

- Editing through an alias is an error, and so is editing inside an anchor that an alias refers to (the alias sites would change too). Keys inherited through `<<` merge keys are not visible to `set`; `insert` an override instead.
- Explicit (`?`) keys, empty keys and collection keys: `insert`, `append` and `delete` are refused anywhere in a document that has them.
- New composite values are written with a block or flow layout chosen from the siblings. They carry no comments. Multi-line strings that are new to the document are written double-quoted with `\n` escapes. Over an existing block scalar (`|`, `>`) they stay block scalars.
- `set` over a block collection replaces the whole subtree, comments inside it included.
- Comment lines between two keys of a `- key: v` item block deleting the first key on the dash line cleanly: the dash is left bare and the comment stays attached to the next key.
- Comments between flow items block a flow delete (`UNSUPPORTED`).
- `insert` into a `first` position, or `before`, goes above the comment lines directly above that sibling. A file header comment with no blank line after it counts as attached to the first key.
- Bare `\r` line endings are not supported (edits are refused by verification). LF and CRLF are.
- Directives (`%YAML`, `%TAG`) are left as they are; edits are verified against the YAML 1.2 core schema only.
- Empty documents are filled only when they are the last document.

## Compatibility

Run here: Node 24.20.0 on macOS (Darwin 25.5): `npm test`, type check, build, `npm run test:dist`, corpus benchmark and fuzz. `engines` says Node >= 20.6, and the CI workflow runs the built smoke test on Node 20.6, 22 and 24. Node 20 and 22 were not run locally. Only YAML 1.2 core schema behavior is checked.

Also run here:

- Property tests: 5000 generated documents with random layouts (indent 2 to 4, flush or indented sequences, quote styles, flow collections, comments, blank lines, CRLF, missing final newline) gave 36599 random edits, all clean. `npm test` runs 400 of them (`PROP_N` changes this).
- Fuzz (`npm run fuzz`, 60 s, seeds 1 to 20374): 84643 edit steps over generated documents, corpus files and byte-mutated inputs, 17493 sessions. 0 failures, 64 refusals, all `UNSUPPORTED`. Every output was checked against the intended data and for untouched lines outside the edit.

## Development

```sh
npm install
npm run corpus          # fetch the pinned corpus (needs curl, network)
npm run typecheck
npm test
npm run build && npm run test:dist
npm run bench:setup && npm run bench    # incumbent table
npm run fuzz            # FUZZ_SECONDS=60 by default
```

The corpus tests skip with a message when `corpus/files` is absent. Third-party files are never committed; `corpus/manifest.json` lists URLs pinned to commit SHAs with their sha256.

The harness plans edits from single-line plain or quoted scalars and block mappings and sequences outside anchors, so the table above does not measure edits inside anchors, block scalars or multi-line scalars. One delete candidate (first key of a list item with a comment line before the next key) is excluded because it has no single minimal result.

## License

MIT. See [LICENSE](LICENSE).
