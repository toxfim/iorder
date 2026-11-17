import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import {
  allocatePayments,
  balanceOf,
  type ReceivedOrderForAllocation,
} from './payment-allocation.js';

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);
const order = (
  id: string,
  total: string,
  paymentStatus: ReceivedOrderForAllocation['paymentStatus'] = 'UNPAID',
): ReceivedOrderForAllocation => ({ id, totalUsd: d(total), paymentStatus });

describe('balanceOf', () => {
  it("the manager's example: 20 + 30 million received, 27 million paid leaves 23 million due", () => {
    const balance = balanceOf(d('50000000.00'), d('27000000.00'));
    expect(balance.amountDue.toFixed(2)).toBe('23000000.00');
    expect(balance.overpaid.toFixed(2)).toBe('0.00');
  });

  it('an overpayment is kept as overpaid, nothing is due', () => {
    const balance = balanceOf(d('100.00'), d('150.50'));
    expect(balance.amountDue.toFixed(2)).toBe('0.00');
    expect(balance.overpaid.toFixed(2)).toBe('50.50');
  });
});

describe('allocatePayments (oldest received order first)', () => {
  it("the manager's example: the first order is paid, the second keeps the rest unpaid", () => {
    const changes = allocatePayments(
      [order('a', '20000000.00'), order('b', '30000000.00')],
      d('27000000.00'),
    );
    expect(changes).toEqual([{ id: 'a', from: 'UNPAID', to: 'PAID' }]);
  });

  it('a partly covered order stops the cover: a smaller newer order is not paid before it', () => {
    const changes = allocatePayments(
      [order('a', '100.00'), order('b', '50.00'), order('c', '10.00')],
      d('140.00'),
    );
    expect(changes).toEqual([{ id: 'a', from: 'UNPAID', to: 'PAID' }]);
  });

  it('exact cover pays every order; reports only real changes', () => {
    const changes = allocatePayments(
      [order('a', '100.00', 'PAID'), order('b', '50.00')],
      d('150.00'),
    );
    expect(changes).toEqual([{ id: 'b', from: 'UNPAID', to: 'PAID' }]);
  });

  it('a voided or reduced payment turns paid orders back to unpaid', () => {
    const changes = allocatePayments(
      [order('a', '100.00', 'PAID'), order('b', '50.00', 'PAID')],
      d('120.00'),
    );
    expect(changes).toEqual([{ id: 'b', from: 'PAID', to: 'UNPAID' }]);
  });

  it('compares USD figures: a cent short of the sum of the rounded totals is not covered', () => {
    // 60 so'm at 12000 is 0.01 per order; 180 so'm at 12000 is 0.02 in all.
    const changes = allocatePayments(
      [order('a', '0.01', 'PAID'), order('b', '0.01', 'PAID'), order('c', '0.01', 'PAID')],
      d('0.02'),
    );
    expect(changes).toEqual([{ id: 'c', from: 'PAID', to: 'UNPAID' }]);
  });

  it('no payments: every received order is unpaid', () => {
    expect(allocatePayments([order('a', '1.00', 'PAID')], d('0'))).toEqual([
      { id: 'a', from: 'PAID', to: 'UNPAID' },
    ]);
  });

  it('a shortfall under half a cent settles the order', () => {
    expect(allocatePayments([order('a', '1.185771')], d('1.181'))).toEqual([
      { id: 'a', from: 'UNPAID', to: 'PAID' },
    ]);
  });

  it('a shortfall of exactly half a cent does not', () => {
    expect(allocatePayments([order('a', '10.000000')], d('9.995'))).toEqual([]);
  });

  it('the half cent is one for the whole walk, not one per order', () => {
    const changes = allocatePayments(
      [order('a', '1.000000'), order('b', '1.000000'), order('c', '1.000000')],
      d('2.994'),
    );
    expect(changes).toEqual([
      { id: 'a', from: 'UNPAID', to: 'PAID' },
      { id: 'b', from: 'UNPAID', to: 'PAID' },
    ]);
  });

  it('an order worth nothing is not PAID without money, nor ahead of an older unpaid order', () => {
    expect(allocatePayments([order('zero', '0.000000')], d('0'))).toEqual([]);
    expect(allocatePayments([order('tiny', '0.000079')], d('0'))).toEqual([]);
    expect(
      allocatePayments([order('older', '100.000000'), order('zero', '0.000000')], d('50')),
    ).toEqual([]);
    expect(
      allocatePayments([order('older', '100.000000'), order('zero', '0.000000', 'PAID')], d('50')),
    ).toEqual([{ id: 'zero', from: 'PAID', to: 'UNPAID' }]);
  });

  it("exact so'm amounts converted one by one settle every order", () => {
    expect(
      allocatePayments([order('a', '1.185771'), order('b', '1.185771')], d('2.371542')),
    ).toEqual([
      { id: 'a', from: 'UNPAID', to: 'PAID' },
      { id: 'b', from: 'UNPAID', to: 'PAID' },
    ]);
  });
});

describe('balanceOf and the half cent', () => {
  it('a difference under half a cent is zero either way', () => {
    expect(balanceOf(d('2.371542'), d('2.37')).amountDue.isZero()).toBe(true);
    expect(balanceOf(d('2.37'), d('2.371542')).overpaid.isZero()).toBe(true);
  });

  it('half a cent and more is real, and shows as a cent', () => {
    expect(balanceOf(d('10.005'), d('10')).amountDue.toFixed(2)).toBe('0.01');
    expect(balanceOf(d('10'), d('10.005')).overpaid.toFixed(2)).toBe('0.01');
  });
});
