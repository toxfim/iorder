import { describe, expect, it } from 'vitest';
import { linePrices, namesWithoutDeferredPrice, planTotal } from './payment-plan';

const line = {
  name: 'Kabel',
  problem: null,
  unitPrice: '10.00',
  lineTotal: '20.00',
  deferredUnitPrice: '12.00',
  deferredLineTotal: '24.00',
};

describe('payment plan display', () => {
  it('takes the total of the chosen plan from the server answer', () => {
    const cart = { totalAmount: '20.00', deferredTotalAmount: '24.00' };
    expect(planTotal(cart, 'FULL')).toBe('20.00');
    expect(planTotal(cart, 'DEFERRED')).toBe('24.00');
    expect(planTotal({ ...cart, deferredTotalAmount: null }, 'DEFERRED')).toBeNull();
  });

  it('takes the line amounts of the chosen plan', () => {
    expect(linePrices(line, 'FULL')).toEqual({ unitPrice: '10.00', lineTotal: '20.00' });
    expect(linePrices(line, 'DEFERRED')).toEqual({ unitPrice: '12.00', lineTotal: '24.00' });
  });

  it('has no amounts while no plan is chosen', () => {
    expect(planTotal({ totalAmount: '20.00', deferredTotalAmount: '24.00' }, null)).toBeNull();
    expect(linePrices(line, null)).toEqual({ unitPrice: null, lineTotal: null });
  });

  it('names only orderable lines without a deferred price', () => {
    expect(
      namesWithoutDeferredPrice([
        line,
        { name: 'Oyna', problem: null, deferredUnitPrice: null },
        { name: 'Eski', problem: 'INACTIVE', deferredUnitPrice: null },
      ]),
    ).toEqual(['Oyna']);
  });
});
