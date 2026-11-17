import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { orderablePieces, toPieceCount } from './orderable-stock.js';

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

describe('orderablePieces', () => {
  it('is the free stock in whole pieces', () => {
    expect(orderablePieces(d('45')).toFixed()).toBe('45');
    expect(orderablePieces(d('45.000')).toFixed()).toBe('45');
    // Half a piece cannot be ordered: the figure never rounds up.
    expect(orderablePieces(d('45.999')).toFixed()).toBe('45');
  });

  it('is zero, a figure of its own, when nothing whole is free', () => {
    // A tracked product with nothing left is OUT OF STOCK (it cannot be ordered), not "no figure":
    // a product with 3 pieces is capped at 3, so one with none cannot be unlimited.
    for (const free of ['0', '0.000', '0.999', '-3']) {
      expect(orderablePieces(d(free)).toFixed(), free).toBe('0');
    }
  });
});

describe('toPieceCount', () => {
  it('is a JSON integer, null without a figure', () => {
    expect(toPieceCount(d('45'))).toBe(45);
    // Out of stock stays a number: only "no figure" is null.
    expect(toPieceCount(d('0'))).toBe(0);
    expect(toPieceCount(null)).toBeNull();
    expect(toPieceCount(undefined)).toBeNull();
    expect(Number.isSafeInteger(toPieceCount(d('999999999999999999')))).toBe(true);
  });
});
