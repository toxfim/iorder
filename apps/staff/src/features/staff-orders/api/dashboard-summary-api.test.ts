import type { StaffRole } from '@iorder/shared';
import { ORDER_STATUSES } from '@iorder/shared';
import {
  staffDashboardSummarySchema,
  type StaffDashboardSummary,
} from '@iorder/shared/staff-orders';
import { describe, expect, it, vi } from 'vitest';
import { InvalidResponseError, PermissionDeniedError } from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import { createHttpDashboardSummaryApi } from './dashboard-summary-api';
import { createFakeDashboardSummaryApi } from './fake-dashboard-summary-api';
import { createFakeStaffOrders } from './fake-staff-orders-backend';

// CONTRACT test of the HTTP adapter, plus the fake's per-role rules (it must answer what the
// server answers: absent sections, no money for the warehouse and the driver, zero-filled
// statuses). The fake's payloads are parsed with the same strict shared schema as the client's.

const NOW = new Date('2026-10-19T04:30:00.000Z');
const clock = { now: () => NOW };

const WHO: Record<string, { name: string; roles: StaffRole[] }> = {
  manager: { name: 'Aziza Yusupova', roles: ['MANAGER'] },
  admin: { name: 'Sanjar Toshev', roles: ['ADMIN'] },
  accountant: { name: 'Nodira Xasanova', roles: ['ACCOUNTANT'] },
  warehouse: { name: 'Rustam Qodirov', roles: ['WAREHOUSE_MANAGER'] },
  driver: { name: 'Bekzod Tursunov', roles: ['DRIVER'] },
};

async function summaryFor(role: keyof typeof WHO): Promise<StaffDashboardSummary> {
  const who = WHO[role]!;
  const orders = createFakeStaffOrders({ clock, actor: () => who });
  const api = createFakeDashboardSummaryApi({
    readOrders: orders.visibleSummaries,
    roles: () => who.roles,
    clock,
  });
  return api.getSummary();
}

const queueKeys = (summary: StaffDashboardSummary): string[] => summary.queues.map((q) => q.key);
const MONEY_KEYS = ['today', 'unpaidDeliveredCount', 'usdRate'] as const;
const MANAGEMENT_KEYS = [
  'organizationsAwaitingActivationCount',
  'unpricedProductsCount',
  'lastSheetSync',
] as const;

describe('createHttpDashboardSummaryApi', () => {
  function setup(status: number, body: unknown) {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
    return { fetchImpl, api: createHttpDashboardSummaryApi(http) };
  }

  it('GETs /staff/dashboard/summary and returns the parsed summary', async () => {
    const payload = await summaryFor('manager');
    const { api, fetchImpl } = setup(200, payload);
    const result = await api.getSummary();
    expect(result).toEqual(payload);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/staff/dashboard/summary');
    expect(init.method).toBe('GET');
  });

  it('keeps an absent section absent (the warehouse answer has no money key)', async () => {
    const payload = await summaryFor('warehouse');
    const result = await setup(200, payload).api.getSummary();
    for (const key of [...MONEY_KEYS, ...MANAGEMENT_KEYS]) expect(key in result).toBe(false);
  });

  it('rejects a key the contract does not know instead of showing it', async () => {
    const payload = { ...(await summaryFor('warehouse')), today: { count: 1 } };
    await expect(setup(200, payload).api.getSummary()).rejects.toBeInstanceOf(InvalidResponseError);
    const extra = { ...(await summaryFor('driver')), margin: '1.00' };
    await expect(setup(200, extra).api.getSummary()).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('rejects a malformed queue', async () => {
    const payload = await summaryFor('manager');
    const broken = { ...payload, queues: [{ key: 'AWAITING_MANAGER', count: -1 }] };
    await expect(setup(200, broken).api.getSummary()).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it('maps 403 to a permission error', async () => {
    const { api } = setup(403, { error: { code: 'FORBIDDEN', message: 'no' } });
    await expect(api.getSummary()).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('fake dashboard summary per role', () => {
  it.each(Object.keys(WHO))('%s: the payload satisfies the strict shared schema', async (role) => {
    const summary = await summaryFor(role);
    expect(staffDashboardSummarySchema.safeParse(summary).success).toBe(true);
    expect(summary.businessDate).toBe('2026-10-19');
    expect(summary.generatedAt).toBe(NOW.toISOString());
  });

  it('manager: queues, today, unpaid, management counts and the rate are all present', async () => {
    const summary = await summaryFor('manager');
    expect(queueKeys(summary)).toEqual([
      'AWAITING_MANAGER',
      'AWAITING_ACCOUNTING',
      'TO_RELEASE',
      'TO_DELIVER',
    ]);
    for (const key of [...MONEY_KEYS, ...MANAGEMENT_KEYS]) expect(key in summary).toBe(true);
    expect(summary.today?.currency).toBe('UZS');
  });

  it('admin: same sections as the manager', async () => {
    const summary = await summaryFor('admin');
    for (const key of [...MONEY_KEYS, ...MANAGEMENT_KEYS]) expect(key in summary).toBe(true);
  });

  it('accountant: accounting queues, today, unpaid and the rate, but no management counts', async () => {
    const summary = await summaryFor('accountant');
    expect(queueKeys(summary)).toEqual(['AWAITING_ACCOUNTING', 'SKIPPED_ACCOUNTING_TO_REVIEW']);
    for (const key of MONEY_KEYS) expect(key in summary).toBe(true);
    for (const key of MANAGEMENT_KEYS) expect(key in summary).toBe(false);
  });

  it('warehouse: only its own queues and no money, rate or management key', async () => {
    const summary = await summaryFor('warehouse');
    expect(queueKeys(summary)).toEqual(['TO_PREPARE', 'TO_RELEASE', 'TO_DELIVER', 'TO_RETURN']);
    expect(Object.keys(summary).sort()).toEqual(
      ['businessDate', 'generatedAt', 'ordersByStatus', 'queues'].sort(),
    );
  });

  it('driver: only the delivery queue, scoped to their own deliveries, and no money', async () => {
    const summary = await summaryFor('driver');
    expect(queueKeys(summary)).toEqual(['TO_DELIVER']);
    expect(Object.keys(summary).sort()).toEqual(
      ['businessDate', 'generatedAt', 'ordersByStatus', 'queues'].sort(),
    );
    const manager = await summaryFor('manager');
    const own = summary.queues[0]!.count;
    const all = manager.queues.find((q) => q.key === 'TO_DELIVER')!.count;
    expect(own).toBeLessThanOrEqual(all);
  });

  it('zero-fills every status, also for a role that sees few orders', async () => {
    for (const role of Object.keys(WHO)) {
      const summary = await summaryFor(role);
      expect(Object.keys(summary.ordersByStatus).sort()).toEqual([...ORDER_STATUSES].sort());
    }
    const driver = await summaryFor('driver');
    expect(driver.ordersByStatus.SUBMITTED).toBe(0);
  });

  it('counts the submitted queue and measures its age in whole minutes, never negative', async () => {
    const manager = await summaryFor('manager');
    const queue = manager.queues.find((q) => q.key === 'AWAITING_MANAGER')!;
    expect(queue.count).toBe(3);
    expect(queue.oldestAgeMinutes).toBe(14 * 60);
    expect(Date.parse(queue.oldestWaitingSince!)).toBe(NOW.getTime() - 14 * 60 * 60_000);
    for (const q of manager.queues) {
      if (q.count === 0) expect(q.oldestAgeMinutes).toBeNull();
      else expect(q.oldestAgeMinutes).toBeGreaterThanOrEqual(0);
    }
  });

  it('answers the dev scenarios like the server: denied, error, empty', async () => {
    const make = (scenario: 'denied' | 'error' | 'empty') => {
      const orders = createFakeStaffOrders({ clock, actor: () => WHO.manager! });
      return createFakeDashboardSummaryApi({
        readOrders: orders.visibleSummaries,
        roles: () => ['MANAGER'],
        clock,
        scenario: () => scenario,
      });
    };
    await expect(make('denied').getSummary()).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(make('error').getSummary()).rejects.toThrow();
    const empty = await make('empty').getSummary();
    expect(empty.queues.every((q) => q.count === 0 && q.oldestAgeMinutes === null)).toBe(true);
    expect(empty.today?.count).toBe(0);
  });
});
