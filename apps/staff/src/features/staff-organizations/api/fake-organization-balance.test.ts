import { describe, expect, it } from 'vitest';
import type { OrderStatus, PaymentStatus, StaffRole } from '@iorder/shared';
import { organizationBalanceResponseSchema } from '@iorder/shared/staff-orders';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import { createFakeOrganizationBalance, type FakeBalanceOrder } from './fake-organization-balance';

// 19 Oct 2026, 09:30 in Tashkent.
const NOW = new Date('2026-10-19T04:30:00.000Z');
const ORG = fakeUuid('org:a');
const OTHER = fakeUuid('org:b');

interface Row {
  organizationId: string;
  status: OrderStatus;
  submittedAt: string;
  totalUsd: string;
  paymentStatus: PaymentStatus;
}

function setup(rows: Row[], role: StaffRole = 'MANAGER') {
  let roles: StaffRole[] = [role];
  const api = createFakeOrganizationBalance({
    now: () => NOW,
    actor: () => ({ name: 'Test Person', roles }),
    orders: () =>
      rows.map((row): FakeBalanceOrder => ({
        ...row,
        setPaymentStatus: (status) => {
          row.paymentStatus = status;
        },
      })),
  });
  const as = async <T>(next: StaffRole, run: () => Promise<T>): Promise<T> => {
    const before = roles;
    roles = [next];
    try {
      return await run();
    } finally {
      roles = before;
    }
  };
  return { api, rows, as };
}

const order = (
  submittedAt: string,
  totalUsd: string,
  status: OrderStatus = 'RECEIVED',
  organizationId = ORG,
): Row => ({ organizationId, status, submittedAt, totalUsd, paymentStatus: 'UNPAID' });

describe('fake organization balance', () => {
  it('counts only RECEIVED orders of the organization, and answers the contract', async () => {
    const { api } = setup([
      order('2026-10-10T05:00:00.000Z', '100000.00'),
      order('2026-10-11T05:00:00.000Z', '50000.00', 'DELIVERED'),
      order('2026-10-12T05:00:00.000Z', '70000.00', 'RECEIVED', OTHER),
    ]);
    const balance = await api.getBalance(ORG);
    expect(organizationBalanceResponseSchema.safeParse(balance).success).toBe(true);
    expect(balance).toMatchObject({
      receivedTotal: '100000.00',
      paidTotal: '0.00',
      amountDue: '100000.00',
      overpaid: '0.00',
      payments: [],
    });
  });

  it('derives PAID oldest received order first; a partly covered order and the rest stay UNPAID', async () => {
    const { api, rows } = setup([
      order('2026-10-12T05:00:00.000Z', '30000.00'),
      order('2026-10-10T05:00:00.000Z', '100000.00'),
      order('2026-10-11T05:00:00.000Z', '50000.00'),
    ]);
    const balance = await api.recordPayment(ORG, {
      amount: '120000',
      currency: 'USD',
      paidOn: '2026-10-19',
    });
    expect(balance.amountDue).toBe('60000.00');
    // oldest (100 000) is covered; the next (50 000) only partly, so it and the newest stay UNPAID
    expect(rows.map((r) => r.paymentStatus)).toEqual(['UNPAID', 'PAID', 'UNPAID']);
    await api.recordPayment(ORG, { amount: '60000', currency: 'USD', paidOn: '2026-10-19' });
    expect(rows.map((r) => r.paymentStatus)).toEqual(['PAID', 'PAID', 'PAID']);
  });

  it('keeps an overpayment and shows it as overpaid with nothing due', async () => {
    const { api } = setup([order('2026-10-10T05:00:00.000Z', '100000.00')]);
    const balance = await api.recordPayment(ORG, {
      amount: '150000.50',
      currency: 'USD',
      paidOn: '2026-10-01',
      comment: 'Naqd',
    });
    expect(balance).toMatchObject({
      amountDue: '0.00',
      overpaid: '50000.50',
      paidTotal: '150000.50',
    });
    expect(balance.payments[0]).toMatchObject({
      amount: '150000.50',
      currency: 'USD',
      paidOn: '2026-10-01',
      comment: 'Naqd',
      recordedByName: 'Test Person',
      voidedAt: null,
    });
  });

  it('refuses a day in the future (Asia/Tashkent) and a non-positive amount with 422', async () => {
    const { api } = setup([]);
    const future = await api
      .recordPayment(ORG, { amount: '1', currency: 'USD', paidOn: '2026-10-20' })
      .catch((e: unknown) => e);
    expect(future).toBeInstanceOf(ApiValidationError);
    expect((future as ApiValidationError).issues[0]?.path).toBe('paidOn');
    const zero = await api
      .recordPayment(ORG, { amount: '0', currency: 'USD', paidOn: '2026-10-19' })
      .catch((e: unknown) => e);
    expect((zero as ApiValidationError).issues[0]?.path).toBe('amount');
  });

  it('lets only the manager record, only the admin correct and void, and the accountant read', async () => {
    const { api, as } = setup([order('2026-10-10T05:00:00.000Z', '100000.00')]);
    const recorded = await api.recordPayment(ORG, {
      amount: '10000',
      currency: 'USD',
      paidOn: '2026-10-19',
    });
    const id = recorded.payments[0]?.id ?? '';
    for (const role of ['ADMIN', 'ACCOUNTANT', 'WAREHOUSE_MANAGER', 'DRIVER'] as const) {
      await expect(
        as(role, () =>
          api.recordPayment(ORG, { amount: '1', currency: 'USD', paidOn: '2026-10-19' }),
        ),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    for (const role of ['MANAGER', 'ACCOUNTANT'] as const) {
      await expect(as(role, () => api.voidPayment(id, { reason: 'x' }))).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
      await expect(
        as(role, () => api.correctPayment(id, { amount: '2', reason: 'x' })),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
    }
    expect((await as('ACCOUNTANT', () => api.getBalance(ORG))).paidTotal).toBe('10000.00');
    for (const role of ['WAREHOUSE_MANAGER', 'DRIVER'] as const) {
      await expect(as(role, () => api.getBalance(ORG))).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    }
  });

  it('corrects with a reason and re-derives; a voided payment is final (409 PAYMENT_VOIDED)', async () => {
    const { api, as, rows } = setup([order('2026-10-10T05:00:00.000Z', '100000.00')]);
    const id = (
      await api.recordPayment(ORG, { amount: '100000', currency: 'USD', paidOn: '2026-10-19' })
    ).payments[0]?.id;
    if (!id) throw new Error('payment expected');
    expect(rows[0]?.paymentStatus).toBe('PAID');
    const corrected = await as('ADMIN', () =>
      api.correctPayment(id, { amount: '40000', comment: null, reason: 'Xato summa' }),
    );
    expect(corrected.amountDue).toBe('60000.00');
    expect(rows[0]?.paymentStatus).toBe('UNPAID');
    const voided = await as('ADMIN', () => api.voidPayment(id, { reason: 'Ikki marta' }));
    expect(voided.payments[0]).toMatchObject({ voidReason: 'Ikki marta' });
    expect(voided.payments[0]?.voidedAt).not.toBeNull();
    expect(voided.paidTotal).toBe('0.00');
    for (const again of [
      () => api.voidPayment(id, { reason: 'x' }),
      () => api.correctPayment(id, { amount: '1', reason: 'x' }),
    ]) {
      const error = await as('ADMIN', again).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ApiConflictError);
      expect((error as ApiConflictError).reason).toBe('PAYMENT_VOIDED');
    }
    await expect(
      as('ADMIN', () => api.voidPayment(fakeUuid('nope'), { reason: 'x' })),
    ).rejects.toBeInstanceOf(ApiNotFoundError);
  });

  it('a so\u2019m payment needs its rate and counts at its USD value; the rate cannot sneak onto USD', async () => {
    const { api, as } = setup([order('2026-10-10T05:00:00.000Z', '100.00')]);
    const missing = await api
      .recordPayment(ORG, { amount: '120000', currency: 'UZS', paidOn: '2026-10-19' } as never)
      .catch((e: unknown) => e);
    expect((missing as ApiValidationError).issues[0]?.path).toBe('rate');
    const tiny = await api
      .recordPayment(ORG, { amount: '1', currency: 'UZS', rate: '12000', paidOn: '2026-10-19' })
      .catch((e: unknown) => e);
    expect((tiny as ApiValidationError).issues[0]?.path).toBe('amount');

    const balance = await api.recordPayment(ORG, {
      amount: '120000',
      currency: 'UZS',
      rate: '12000',
      paidOn: '2026-10-19',
    });
    expect(balance).toMatchObject({
      paidTotal: '10.00',
      amountDue: '90.00',
      usdRate: '12650.0000',
    });
    expect(balance.uzsEquivalent?.amountDue).toBe('1138500.00');
    expect(balance.payments[0]).toMatchObject({
      amount: '120000.00',
      currency: 'UZS',
      rate: '12000',
      amountUsd: '10.00',
      amountUzs: '120000.00',
    });

    const id = balance.payments[0]?.id ?? '';
    const corrected = await as('ADMIN', () =>
      api.correctPayment(id, { rate: '10000', reason: 'x' }),
    );
    expect(corrected.payments[0]?.amountUsd).toBe('12.00');
    const usd = await as('ADMIN', () =>
      api.correctPayment(id, { currency: 'USD', amount: '5', reason: 'x' }),
    );
    expect(usd.payments[0]).toMatchObject({ currency: 'USD', rate: null, amountUsd: '5.00' });
    await expect(
      as('ADMIN', () => api.correctPayment(id, { rate: '10000', reason: 'x' })),
    ).rejects.toBeInstanceOf(ApiValidationError);
  });

  it('shows no so\u2019m equivalents without a current rate', async () => {
    const api = createFakeOrganizationBalance({
      now: () => NOW,
      actor: () => ({ name: 'Test Person', roles: ['MANAGER'] }),
      orders: () => [],
      currentRate: () => null,
    });
    const balance = await api.recordPayment(ORG, {
      amount: '5',
      currency: 'USD',
      paidOn: '2026-10-19',
    });
    expect(balance).toMatchObject({ usdRate: null, uzsEquivalent: null });
    expect(balance.payments[0]?.amountUzs).toBeNull();
  });

  it('requires a reason and at least one change to correct', async () => {
    const { api, as } = setup([]);
    const id = (
      await api.recordPayment(ORG, { amount: '1', currency: 'USD', paidOn: '2026-10-19' })
    ).payments[0]?.id;
    if (!id) throw new Error('payment expected');
    await expect(
      as('ADMIN', () => api.correctPayment(id, { amount: '2', reason: ' ' })),
    ).rejects.toBeInstanceOf(ApiValidationError);
    await expect(
      as('ADMIN', () => api.correctPayment(id, { reason: 'x' } as never)),
    ).rejects.toBeInstanceOf(ApiValidationError);
  });

  it('answers like the server for exact so\u2019m payments: six decimals and the half cent', async () => {
    const { api, rows } = setup([
      order('2026-10-01T00:00:00Z', '1.185771'),
      order('2026-10-02T00:00:00Z', '1.185771'),
    ]);
    const balance = await api.recordPayment(ORG, {
      amount: '30000',
      currency: 'UZS',
      rate: '12650',
      paidOn: '2026-10-19',
    });
    expect(balance.amountDue).toBe('0.00');
    expect(balance.overpaid).toBe('0.00');
    expect(rows.map((order) => order.paymentStatus)).toEqual(['PAID', 'PAID']);
  });

  it('an order worth nothing is not paid without money, nor ahead of an older one', async () => {
    const { api, rows } = setup([
      order('2026-10-01T00:00:00Z', '100.00'),
      order('2026-10-02T00:00:00Z', '0.000079'),
    ]);
    await api.recordPayment(ORG, { amount: '50', currency: 'USD', paidOn: '2026-10-19' });
    expect(rows.map((order) => order.paymentStatus)).toEqual(['UNPAID', 'UNPAID']);
  });
});
