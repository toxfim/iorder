import { stockLimitExceededDetailsSchema } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { exceedsStock, linesOverStock, stockLimitExceeded, stockLimitOf } from './stock-limit.js';

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);
const stock = new Map([
  ['capped', d('10')],
  ['plenty', d('500')],
  ['gone', d('0')],
]);

describe('the customer stock cap', () => {
  it('a product without a figure has no cap, whatever the quantity', () => {
    expect(stockLimitOf(stock, 'no-figure')).toBeNull();
    expect(exceedsStock(d('999999'), null)).toBe(false);
  });

  it('a quantity up to the figure passes, one more does not', () => {
    const limit = stockLimitOf(stock, 'capped');
    expect(exceedsStock(d('9'), limit)).toBe(false);
    expect(exceedsStock(d('10'), limit)).toBe(false);
    expect(exceedsStock(d('10.000'), limit)).toBe(false);
    expect(exceedsStock(d('11'), limit)).toBe(true);
    // A legacy fractional quantity is compared exactly, not rounded down into the cap.
    expect(exceedsStock(d('10.001'), limit)).toBe(true);
  });

  it('a figure of zero (out of stock) refuses every quantity', () => {
    const limit = stockLimitOf(stock, 'gone');
    expect(limit?.toFixed()).toBe('0');
    expect(exceedsStock(d('1'), limit)).toBe(true);
    expect(
      linesOverStock([{ productId: 'gone', quantity: d('1') }], stock).map((line) => [
        line.productId,
        line.orderableStock.toFixed(),
      ]),
    ).toEqual([['gone', '0']]);
    const details = stockLimitExceededDetailsSchema.parse(
      stockLimitExceeded([{ productId: crypto.randomUUID(), orderableStock: d('0') }]).details,
    );
    expect(details.lines.map((line) => line.orderableStock)).toEqual([0]);
  });

  it('names only the lines above their figure, with the figure', () => {
    const over = linesOverStock(
      [
        { productId: 'plenty', quantity: d('500') },
        { productId: 'capped', quantity: d('50') },
        { productId: 'no-figure', quantity: d('999999') },
      ],
      stock,
    );
    expect(over.map((line) => [line.productId, line.orderableStock.toFixed()])).toEqual([
      ['capped', '10'],
    ]);
    expect(linesOverStock([{ productId: 'capped', quantity: d('10') }], stock)).toEqual([]);
  });

  it('the refusal is a typed conflict whose details match the shared contract', () => {
    const error = stockLimitExceeded([{ productId: crypto.randomUUID(), orderableStock: d('10') }]);
    expect([error.code, error.reason]).toEqual(['CONFLICT', 'STOCK_LIMIT_EXCEEDED']);
    const details = stockLimitExceededDetailsSchema.parse(error.details);
    expect(details.lines.map((line) => line.orderableStock)).toEqual([10]);
    // A product and a count: nothing else travels in the refusal.
    expect(Object.keys((error.details as { lines: object[] }).lines[0] ?? {}).sort()).toEqual([
      'orderableStock',
      'productId',
    ]);
  });
});
