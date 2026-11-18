import { z } from 'zod';
import type { AnyOp } from '../registry/types';

export type JsonSchema = Record<string, unknown>;

const cache = new Map<string, { input: JsonSchema; output: JsonSchema }>();

function clean(s: JsonSchema): JsonSchema {
  const { $schema: _drop, ...rest } = s;
  return rest;
}

export function opSchemas(op: AnyOp): { input: JsonSchema; output: JsonSchema } {
  let hit = cache.get(op.name);
  if (!hit) {
    hit = {
      input: clean(z.toJSONSchema(op.input, { io: 'input', unrepresentable: 'any' }) as JsonSchema),
      output: clean(z.toJSONSchema(op.output, { io: 'output', unrepresentable: 'any' }) as JsonSchema),
    };
    cache.set(op.name, hit);
  }
  return hit;
}

export function pathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
}

function acceptsType(s: unknown, t: string): boolean {
  if (!s || typeof s !== 'object') return false;
  const o = s as JsonSchema;
  const type = o['type'];
  if (type === t || (Array.isArray(type) && type.includes(t))) return true;
  for (const k of ['anyOf', 'oneOf']) {
    const list = o[k];
    if (Array.isArray(list) && list.some((x) => acceptsType(x, t))) return true;
  }
  return false;
}

/** Turns query-string values into the types the op's input schema expects. */
export function coerceQuery(op: AnyOp, q: Record<string, string>): Record<string, unknown> {
  const props = (opSchemas(op).input['properties'] ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    const s = props[k];
    if ((acceptsType(s, 'integer') || acceptsType(s, 'number')) && /^-?\d+(\.\d+)?$/.test(v)) out[k] = Number(v);
    else if (acceptsType(s, 'boolean') && (v === 'true' || v === 'false')) out[k] = v === 'true';
    else out[k] = v;
  }
  return out;
}
