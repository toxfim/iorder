import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Hard rule 2 and the module conventions, checked on the source: the status of an order changes
// in exactly one place, and only the orders module touches the order tables.
const SRC = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated') return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const files = sourceFiles(SRC).map((path) => ({
  path: path.slice(SRC.length).replaceAll('\\', '/'),
  text: readFileSync(path, 'utf8'),
}));

const REPOSITORY = 'modules/orders/orders.repository.ts';
const SERVICE = 'modules/orders/orders.service.ts';

const where = (pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(file.text)).map((file) => file.path);
const textOf = (path: string): string => files.find((file) => file.path === path)?.text ?? '';

describe('the order transition is the only place that changes a status', () => {
  it('writes to the orders table only in the orders repository, in any access style', () => {
    // `.order.update(`, `.order?.update(`, `['order'].update(`, `const { order } = tx`, `= tx.order;`
    const access =
      /(\.order\s*\??\.\s*(update|updateMany|upsert|create|createMany|delete|deleteMany)\b|\[\s*['"`]order['"`]\s*\]|\{[^}]*\border\b[^}]*\}\s*=\s*(this\.)?(tx|prisma|client|db)\b|=\s*(this\.)?(tx|prisma|client|db)\.order\b\s*[;,)])/;
    expect(where(access)).toEqual([REPOSITORY]);
  });

  it('never touches the order tables with raw SQL outside the orders module', () => {
    const rawCall = /\$(execute|query)Raw(Unsafe)?\s*[`(]/g;
    const offenders = files
      .filter((file) => !file.path.startsWith('modules/orders/'))
      .filter((file) =>
        [...file.text.matchAll(rawCall)].some((match) =>
          /\b(orders|order_items|order_events)\b/i.test(
            file.text.slice(match.index, match.index + 600),
          ),
        ),
      );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  it('has no raw SQL write on the orders table inside the module either', () => {
    // The module's raw SQL is the order sequence and the cart lock; none may write `orders`.
    expect(
      where(/\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\s+(TABLE\s+)?"?orders\b/i),
    ).toEqual([]);
  });

  it('exposes the status-writing function only to the orders service', () => {
    expect(where(/\btransitionGuarded\b/)).toEqual([REPOSITORY, SERVICE]);
    expect(where(/\bOrderTransitionData\b/)).toEqual([REPOSITORY, SERVICE]);
    expect(textOf(SERVICE).match(/\.transitionGuarded\(/g)).toHaveLength(1);
  });

  it('keeps the other guarded writes free of the status', () => {
    expect(where(/\.updateGuarded\(/)).toEqual([SERVICE]);
    const repository = textOf(REPOSITORY);
    // `status:` is written in exactly one update: inside transitionGuarded.
    expect(repository.match(/\bstatus: data\.status\b/g)).toHaveLength(1);
    const edit = repository.slice(
      repository.indexOf('async updateGuarded('),
      repository.indexOf('async transitionGuarded('),
    );
    expect(edit).not.toMatch(/\bstatus: data\b/);
    const editData = repository.match(/interface OrderEditData \{[^}]*\}/s)?.[0] ?? '';
    expect(editData).not.toBe('');
    expect(editData).not.toMatch(/status/i);
  });

  it('keeps the order tables private to the orders module', () => {
    const outside = files.filter(
      (file) =>
        !file.path.startsWith('modules/orders/') &&
        // Order-less outbox rows (staff notices, group removals, price list posts), see the
        // files' headers.
        file.path !== 'common/outbox/staff-notices.ts' &&
        file.path !== 'common/outbox/kick-member.ts' &&
        file.path !== 'common/outbox/price-list-post.ts' &&
        /\.(order|orderItem|orderEvent|notificationOutbox|cart|cartItem)\.(find|create|update|delete|upsert|count)/.test(
          file.text,
        ),
    );
    expect(outside.map((file) => file.path)).toEqual([]);
  });

  it('never deletes or updates order events from application code', () => {
    expect(where(/\.orderEvent\.(update|updateMany|upsert|delete|deleteMany)\(/)).toEqual([]);
    expect(where(/UPDATE\s+order_events|DELETE\s+FROM\s+order_events/i)).toEqual([]);
  });
});
