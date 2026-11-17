import { describe, expect, it } from 'vitest';
import type { CustomerTimelineEvent } from '@iorder/shared';
import { orderMilestones } from './milestones';
const event = (
  toStatus: CustomerTimelineEvent['toStatus'],
  occurredAt: string,
): CustomerTimelineEvent => ({
  id: occurredAt,
  type: 'STATUS_CHANGED',
  occurredAt,
  fromStatus: null,
  toStatus,
  actor: null,
  comment: null,
  customerNotified: false,
  itemsChange: null,
  paymentChange: null,
  paymentPlanChange: null,
});
describe('customer milestone projection', () => {
  it('keeps the first confirmation and actual delivery, excluding warehouse/accounting and receipt times', () => {
    const events = [
      event('RECEIVED', '2026-10-25T10:00:00Z'),
      event('RELEASED', '2026-10-24T10:00:00Z'),
      event('DELIVERED', '2026-10-24T12:00:00Z'),
      event('MANAGER_APPROVED', '2026-10-23T11:00:00Z'),
      event('ACCOUNTING_CLEARED', '2026-10-23T12:00:00Z'),
      event('MANAGER_APPROVED', '2026-10-23T10:00:00Z'),
    ];
    expect(orderMilestones(events, '2026-10-23T09:00:00Z')).toEqual({
      orderedAt: '2026-10-23T09:00:00Z',
      confirmedAt: '2026-10-23T10:00:00Z',
      deliveredAt: '2026-10-24T12:00:00Z',
    });
  });
  it('leaves unknown dates null instead of inventing them from updatedAt', () => {
    expect(orderMilestones([], '2026-10-23T09:00:00Z')).toEqual({
      orderedAt: '2026-10-23T09:00:00Z',
      confirmedAt: null,
      deliveredAt: null,
    });
  });
});
