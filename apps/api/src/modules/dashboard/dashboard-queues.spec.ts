import { ORDER_STATUSES, STAFF_ROLES, type OrderStatus, type StaffRole } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import type { OrderStats, StatusStat } from '../orders/index.js';
import { buildQueues } from './dashboard-queues.js';

const NOW = new Date('2026-10-20T08:00:00Z');
const EMPTY: StatusStat = { count: 0, oldestWaitingSince: null };

function stats(
  counts: Partial<Record<OrderStatus, StatusStat>>,
  full: OrderStats['full'] = null,
): OrderStats {
  return {
    byStatus: Object.fromEntries(ORDER_STATUSES.map((s) => [s, counts[s] ?? EMPTY])) as Record<
      OrderStatus,
      StatusStat
    >,
    goodsToReturn: EMPTY,
    full,
  };
}

const keys = (roles: StaffRole[], s: OrderStats): string[] =>
  buildQueues(roles, s, NOW).map((q) => q.key);

describe('buildQueues', () => {
  const sample = stats(
    {
      SUBMITTED: { count: 2, oldestWaitingSince: new Date('2026-10-20T07:30:00Z') },
      MANAGER_APPROVED: { count: 1, oldestWaitingSince: new Date('2026-10-20T07:59:59Z') },
    },
    {
      skippedAccountingToReview: { count: 3, oldestWaitingSince: new Date('2026-10-19T08:00:00Z') },
      unpaidDeliveredCount: 0,
      today: { count: 0, totalAmount: '0.00' },
    },
  );

  it('gives each role its own queues, in the order an order travels', () => {
    expect(keys(['MANAGER'], sample)).toEqual([
      'AWAITING_MANAGER',
      'AWAITING_ACCOUNTING',
      'TO_RELEASE',
      'TO_DELIVER',
    ]);
    expect(keys(['ACCOUNTANT'], sample)).toEqual([
      'AWAITING_ACCOUNTING',
      'SKIPPED_ACCOUNTING_TO_REVIEW',
    ]);
    expect(keys(['WAREHOUSE_MANAGER'], sample)).toEqual([
      'TO_PREPARE',
      'TO_RELEASE',
      'TO_DELIVER',
      'TO_RETURN',
    ]);
    expect(keys(['DRIVER'], sample)).toEqual(['TO_DELIVER']);
    expect(keys(['ADMIN'], sample)).toEqual(keys(['MANAGER'], sample));
  });

  it('the warehouse counts what it prepares and what has to come back', () => {
    const since = new Date('2026-10-20T07:00:00Z');
    const queues = buildQueues(
      ['WAREHOUSE_MANAGER'],
      { ...sample, goodsToReturn: { count: 4, oldestWaitingSince: since } },
      NOW,
    );
    expect(queues.find((q) => q.key === 'TO_PREPARE')?.count).toBe(1);
    expect(queues.find((q) => q.key === 'TO_RETURN')).toMatchObject({
      count: 4,
      oldestAgeMinutes: 60,
    });
  });

  it('the union of roles gets the union of queues, each once', () => {
    expect(keys(['ACCOUNTANT', 'DRIVER'], sample)).toEqual([
      'AWAITING_ACCOUNTING',
      'SKIPPED_ACCOUNTING_TO_REVIEW',
      'TO_DELIVER',
    ]);
  });

  it('measures the oldest waiting order in whole minutes and floors the seconds', () => {
    const [first, second] = buildQueues(['MANAGER'], sample, NOW);
    expect(first).toEqual({
      key: 'AWAITING_MANAGER',
      count: 2,
      oldestWaitingSince: '2026-10-20T07:30:00.000Z',
      oldestAgeMinutes: 30,
    });
    expect(second?.oldestAgeMinutes).toBe(0);
  });

  it('an empty queue has no oldest order and no age', () => {
    const [, , release] = buildQueues(['MANAGER'], sample, NOW);
    expect(release).toEqual({
      key: 'TO_RELEASE',
      count: 0,
      oldestWaitingSince: null,
      oldestAgeMinutes: null,
    });
  });

  it('never reports a negative age for a timestamp in the future', () => {
    const future = stats({
      SUBMITTED: { count: 1, oldestWaitingSince: new Date('2026-10-20T09:00:00Z') },
    });
    expect(buildQueues(['MANAGER'], future, NOW)[0]?.oldestAgeMinutes).toBe(0);
  });

  it('leaves the skipped-accounting queue out when the caller has no accounting facts', () => {
    expect(keys(['ACCOUNTANT'], stats({}))).toEqual(['AWAITING_ACCOUNTING']);
  });

  it('every staff role has at least one queue', () => {
    for (const role of STAFF_ROLES) {
      expect(buildQueues([role], sample, NOW).length, role).toBeGreaterThan(0);
    }
  });
});
