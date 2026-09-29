import { parse } from '../src/index.ts';
import type { Op } from './harness.ts';

export function mine(src: string, op: Op): string {
  const d = parse(src);
  switch (op.kind) {
    case 'set': d.set(op.path, op.value); break;
    case 'delete': d.delete(op.path); break;
    case 'rename': d.rename(op.path, op.key!); break;
    case 'insert': d.insert(op.path, op.key!, op.value); break;
    case 'append': d.append(op.path, op.value); break;
  }
  return d.toString();
}
