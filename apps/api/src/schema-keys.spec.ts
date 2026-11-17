import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { isForbiddenName } from '../test/support/forbidden-fields.js';
import { collectSchemaKeys } from '../test/support/schema-keys.js';

// The walker is a safety net for hard rule 7: it must see a cost key wherever a schema can
// hide one. Each case below hides `costUsd` in a different construct.
const hidden = z.strictObject({ costUsd: z.string() });

describe('collectSchemaKeys finds a hidden cost key', () => {
  const cases: [string, z.ZodType][] = [
    ['plain object', hidden],
    ['array element', z.array(hidden)],
    ['optional', hidden.optional()],
    ['nullable', hidden.nullable()],
    ['default', hidden.default({ costUsd: '1' })],
    ['intersection (left)', z.intersection(hidden, z.object({ a: z.string() }))],
    ['intersection (right)', z.intersection(z.object({ a: z.string() }), hidden)],
    ['record value', z.record(z.string(), hidden)],
    ['record with enum keys', z.record(z.enum(['costUsd', 'ok']), z.string())],
    ['tuple item', z.tuple([z.string(), hidden])],
    ['tuple rest', z.tuple([z.string()], hidden)],
    ['lazy', z.lazy(() => hidden)],
    ['catchall', z.object({ a: z.string() }).catchall(hidden)],
    ['union option', z.union([z.string(), hidden])],
    [
      'discriminated union',
      z.discriminatedUnion('k', [z.object({ k: z.literal('a'), costUsd: z.string() })]),
    ],
    ['transform (pipe)', hidden.transform((v) => v)],
    ['refine wrapper', hidden.refine(() => true)],
    ['map value', z.map(z.string(), hidden)],
    ['set of objects', z.set(hidden)],
    ['readonly', hidden.readonly()],
    [
      'deeply nested',
      z.object({ a: z.array(z.object({ b: z.lazy(() => z.union([hidden, z.null()])) })) }),
    ],
  ];

  it.each(cases)('%s', (_name, schema) => {
    expect(collectSchemaKeys(schema).filter(isForbiddenName)).toContain('costUsd');
  });
});

describe('collectSchemaKeys on clean schemas', () => {
  it('returns the declared keys and survives recursive schemas', () => {
    interface Node {
      name: string;
      children: Node[];
    }
    const node: z.ZodType<Node> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(node) }),
    );
    expect(collectSchemaKeys(node).sort()).toEqual(['children', 'name']);
    expect(collectSchemaKeys(z.record(z.string(), z.number()))).toEqual([]);
    expect(collectSchemaKeys(z.string())).toEqual([]);
  });
});
