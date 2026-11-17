import { describe, expect, it } from 'vitest';
import * as shared from '../index.js';
import * as staffOrders from '../staff-orders.js';
import { STAFF_DASHBOARD_ROUTES, staffDashboardSummarySchema } from '../staff-orders.js';

const minimal = {
  generatedAt: '2026-10-20T08:00:00.000Z',
  businessDate: '2026-10-20',
  ordersByStatus: { SUBMITTED: 2, RELEASED: 0 },
  queues: [
    {
      key: 'AWAITING_MANAGER',
      count: 2,
      oldestWaitingSince: '2026-10-20T07:00:00.000Z',
      oldestAgeMinutes: 60,
    },
  ],
};

describe('staff dashboard contract', () => {
  it('accepts the fulfilment shape: no money, payment, rate or management keys', () => {
    expect(staffDashboardSummarySchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts every optional section when present, with money as decimal strings', () => {
    const full = {
      ...minimal,
      today: { count: 3, totalAmount: '26253.50', currency: 'UZS' },
      unpaidDeliveredCount: 1,
      organizationsAwaitingActivationCount: 0,
      unpricedProductsCount: 4,
      lastSheetSync: null,
      usdRate: { rate: '12650.5000', source: 'CBU', rateDate: '2026-10-20' },
    };
    expect(staffDashboardSummarySchema.safeParse(full).success).toBe(true);
  });

  it('rejects money as a JSON number, unknown keys and unknown statuses', () => {
    const today = { count: 1, totalAmount: 100, currency: 'UZS' };
    expect(staffDashboardSummarySchema.safeParse({ ...minimal, today }).success).toBe(false);
    expect(staffDashboardSummarySchema.safeParse({ ...minimal, margin: '1' }).success).toBe(false);
    expect(
      staffDashboardSummarySchema.safeParse({ ...minimal, ordersByStatus: { IN_DELIVERY: 1 } })
        .success,
    ).toBe(false);
    expect(
      staffDashboardSummarySchema.safeParse({
        ...minimal,
        lastSheetSync: {
          status: 'OK',
          startedAt: minimal.generatedAt,
          finishedAt: minimal.generatedAt,
          rows: [],
        },
      }).success,
    ).toBe(false);
  });

  it('is staff-only: exported by the staff-orders entry, never by the barrel', () => {
    for (const name of ['staffDashboardSummarySchema', 'STAFF_DASHBOARD_ROUTES']) {
      expect(Object.keys(staffOrders), name).toContain(name);
      expect(Object.keys(shared), name).not.toContain(name);
    }
    expect(STAFF_DASHBOARD_ROUTES.summary).toEqual({
      method: 'GET',
      path: '/staff/dashboard/summary',
    });
  });
});
