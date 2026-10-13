import { applyPatches, enablePatches, type Patch } from 'immer';

enablePatches();

/** RFC 6902 JSON Patch operation (the subset Cutline generates). */
export interface JsonPatchOperation {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

function escapeSegment(segment: string | number): string {
  return String(segment).replace(/~/g, '~0').replace(/\//g, '~1');
}

function unescapeSegment(segment: string): string | number {
  if (/^(0|[1-9]\d*)$/.test(segment)) return Number(segment);
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

export function toPointer(path: ReadonlyArray<string | number>): string {
  return path.map((s) => `/${escapeSegment(s)}`).join('');
}

export function fromPointer(pointer: string): Array<string | number> {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON pointer "${pointer}"`);
  return pointer.slice(1).split('/').map(unescapeSegment);
}

/** Converts Immer patches to RFC 6902 JSON Patch. */
export function toJsonPatch(patches: readonly Patch[]): JsonPatchOperation[] {
  return patches.map((p) => {
    const out: JsonPatchOperation = { op: p.op, path: toPointer(p.path) };
    if (p.op !== 'remove') out.value = p.value;
    return out;
  });
}

function toImmerPatches(ops: readonly JsonPatchOperation[]): Patch[] {
  return ops.map((o) => {
    const p: Patch = { op: o.op, path: fromPointer(o.path) };
    if (o.op !== 'remove') p.value = o.value;
    return p;
  });
}

/** Applies a JSON Patch immutably (structural sharing; the input is not modified). */
export function applyJsonPatch<T extends object>(doc: T, ops: readonly JsonPatchOperation[]): T {
  if (ops.length === 0) return doc;
  return applyPatches(doc, toImmerPatches(ops));
}
