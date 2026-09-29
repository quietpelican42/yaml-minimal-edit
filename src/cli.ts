#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parse as yamlParse } from 'yaml';
import { parse } from './doc.ts';
import { YamlEditError } from './errors.ts';
import { Raw, raw } from './scalar.ts';

const USAGE = `usage: yaml-minimal-edit <command> [options] FILE ARGS...

commands
  set FILE PATH VALUE             replace the value at PATH
  delete FILE PATH                remove the key or item at PATH (and comment lines directly above it)
  rename FILE PATH NEWKEY         rename the key at PATH
  append FILE PATH VALUE          add an item to the sequence at PATH
  insert FILE PATH KEY VALUE      add KEY: VALUE to the mapping at PATH ("" is the root)

options
  -i, --in-place        write the file instead of printing the result
  -d, --document N      edit document N of a multi-document stream (default 0)
  -s, --string          VALUE is a string, whatever it looks like
  -j, --json            VALUE is JSON
      --after KEY       insert after this sibling
      --before KEY      insert before this sibling
      --first           insert as the first key
  -h, --help            show this help

PATH is a.b[2].c (quote segments with dots: a."b.c") or a JSON Pointer (/a/b/2/c).
VALUE is read as a YAML scalar or flow collection. A scalar written over an existing string
stays a string; use --json for exact typing.

exit codes: 0 edited, 1 the edit was refused, 2 usage error or unreadable/invalid input
`;

class UsageError extends Error {}

/** The text as a string; a quoted YAML scalar is unquoted first. */
function yamlScalarString(text: string): string {
  if (/^\s*["']/.test(text)) {
    try {
      const v = yamlParse(text);
      if (typeof v === 'string') return v;
    } catch {
      // fall through: use the text as typed
    }
  }
  return text;
}

function valueFrom(text: string, o: { string?: boolean; json?: boolean }): unknown {
  if (o.string) return text;
  if (o.json) {
    try {
      return JSON.parse(text);
    } catch {
      throw new UsageError(`VALUE is not valid JSON: ${text}`);
    }
  }
  let v: unknown;
  try {
    v = yamlParse(text);
  } catch {
    throw new UsageError(`VALUE is not valid YAML: ${text}`);
  }
  // A plain scalar is written exactly as typed (so 1.20 stays 1.20); collections and quoted text are re-rendered.
  if (v !== null && typeof v === 'object') return v;
  if (typeof v === 'string' || /^\s*["']/.test(text)) return v;
  return raw(text.trim());
}

function main(argv: string[]): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'in-place': { type: 'boolean', short: 'i' },
        document: { type: 'string', short: 'd' },
        string: { type: 'boolean', short: 's' },
        json: { type: 'boolean', short: 'j' },
        after: { type: 'string' },
        before: { type: 'string' },
        first: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [cmd, file, ...rest] = positionals;
  const arity: Record<string, number> = { set: 2, delete: 1, rename: 2, append: 2, insert: 3 };
  try {
    if (!cmd || !(cmd in arity) || !file || rest.length !== arity[cmd]) {
      throw new UsageError(cmd && !(cmd in arity) ? `unknown command: ${cmd}` : `wrong arguments for ${cmd ?? 'command'}`);
    }
    if ((values.after !== undefined || values.before !== undefined || values.first) && cmd !== 'insert') {
      throw new UsageError('--after, --before and --first only apply to insert');
    }
    const document = values.document === undefined ? 0 : Number(values.document);
    if (!Number.isInteger(document) || document < 0) throw new UsageError('--document needs a non-negative integer');
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch (e) {
      throw new UsageError(`cannot read ${file}: ${(e as Error).message}`);
    }
    let doc;
    try {
      doc = parse(src);
    } catch (e) {
      if (e instanceof YamlEditError) throw new UsageError(`${file}: ${e.message}`);
      throw e;
    }
    const vopts = { string: values.string, json: values.json };
    const eo = { document };
    const [path = '', a = '', b = ''] = rest;
    try {
      if (cmd === 'set') {
        // An existing string stays a string unless the value is a collection or is given with -j.
        let v: unknown;
        if (!values.json && !values.string && doc.has(path, eo) && typeof doc.get(path, eo) === 'string') {
          const parsed = valueFrom(a, vopts);
          v = parsed !== null && typeof parsed === 'object' && !(parsed instanceof Raw) ? parsed : yamlScalarString(a);
        } else v = valueFrom(a, vopts);
        doc.set(path, v, eo);
      }
      else if (cmd === 'delete') doc.delete(path, eo);
      else if (cmd === 'rename') doc.rename(path, a, eo);
      else if (cmd === 'append') doc.append(path, valueFrom(a, vopts), eo);
      else doc.insert(path, a, valueFrom(b, vopts), { ...eo, after: values.after, before: values.before, first: values.first });
    } catch (e) {
      if (e instanceof YamlEditError) {
        process.stderr.write(`yaml-minimal-edit: ${e.code}: ${e.message}\n`);
        return 1;
      }
      throw e;
    }
    if (values['in-place']) {
      try {
        writeFileSync(file, doc.toString());
      } catch (e) {
        throw new UsageError(`cannot write ${file}: ${(e as Error).message}`);
      }
    } else process.stdout.write(doc.toString());
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`yaml-minimal-edit: ${e.message}\n${e.message.startsWith('cannot') || e.message.includes(': ') ? '' : USAGE}`);
      return 2;
    }
    process.stderr.write(`yaml-minimal-edit: internal error: ${(e as Error).stack}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
