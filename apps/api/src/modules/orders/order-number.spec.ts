import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatOrderNumber, ORDER_NUMBER_PREFIX, ORDER_NUMBER_START } from './order-number.js';

describe('order number', () => {
  it('is IO- followed by the sequence value, starting at 10001', () => {
    expect(ORDER_NUMBER_PREFIX).toBe('IO-');
    expect(ORDER_NUMBER_START).toBe(10001);
    expect(formatOrderNumber(10001)).toBe('IO-10001');
    expect(formatOrderNumber(10002n)).toBe('IO-10002');
    expect(formatOrderNumber(123456789012n)).toBe('IO-123456789012');
  });

  it('refuses a value below the start (a wrongly configured sequence)', () => {
    expect(() => formatOrderNumber(1)).toThrow(RangeError);
  });

  it('is the same start the migration gives the database sequence', () => {
    const migration = readFileSync(
      new URL(
        '../../../prisma/migrations/20261028090000_orders_core/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    expect(migration).toContain(
      `CREATE SEQUENCE "order_number_seq" START WITH ${ORDER_NUMBER_START} MINVALUE ${ORDER_NUMBER_START}`,
    );
  });
});
