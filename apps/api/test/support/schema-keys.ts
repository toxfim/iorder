import type { z } from 'zod';

interface ZodDefLike {
  type?: string;
  shape?: Record<string, z.ZodType>;
  catchall?: z.ZodType;
  element?: z.ZodType;
  innerType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  options?: z.ZodType[];
  left?: z.ZodType;
  right?: z.ZodType;
  keyType?: z.ZodType;
  valueType?: z.ZodType;
  items?: z.ZodType[];
  rest?: z.ZodType | null;
  getter?: () => z.ZodType;
  entries?: Record<string, unknown>;
  values?: unknown[];
}

const defOf = (schema: z.ZodType): ZodDefLike =>
  (schema as unknown as { _zod: { def: ZodDefLike } })._zod.def;

/**
 * Every object key a zod schema declares, at any depth: objects (including `catchall`), arrays,
 * tuples, records, maps, sets, optional/nullable/default/catch wrappers, pipes/transforms,
 * unions, intersections (left and right) and lazy schemas. A record whose KEY type is an enum
 * or literal contributes those names too, because they become property names at runtime.
 * Used to scan the shared contracts for cost-like field names (hard rule 7).
 */
export function collectSchemaKeys(schema: z.ZodType, seen = new Set<z.ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = defOf(schema);
  const keys: string[] = [];
  const children: z.ZodType[] = [];

  if (def.shape) {
    keys.push(...Object.keys(def.shape));
    children.push(...Object.values(def.shape));
  }
  if (def.type === 'record' && def.keyType) {
    const keyDef = defOf(def.keyType);
    if (keyDef.entries) keys.push(...Object.keys(keyDef.entries));
    if (keyDef.values) keys.push(...keyDef.values.map(String));
  }
  if (def.getter) children.push(def.getter());
  if (def.items) children.push(...def.items);
  if (def.options) children.push(...def.options);
  for (const child of [
    def.catchall,
    def.element,
    def.innerType,
    def.in,
    def.out,
    def.left,
    def.right,
    def.keyType,
    def.valueType,
    def.rest ?? undefined,
  ]) {
    if (child) children.push(child);
  }
  return [...keys, ...children.flatMap((child) => collectSchemaKeys(child, seen))];
}

export function isZodSchema(value: unknown): value is z.ZodType {
  return typeof value === 'object' && value !== null && '_zod' in value;
}
