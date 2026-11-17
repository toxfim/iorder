import type { MarkedOrderNotification } from '@iorder/shared/staff-auth';
import { describe, expect, it } from 'vitest';
import { hasUnread } from './marked-orders-seen';

const item = (createdAt: string): MarkedOrderNotification => ({
  id: '01900000-0000-7000-8000-00000000f001',
  type: 'ORDER_SUBMITTED',
  orderId: '01900000-0000-7000-8000-000000000001',
  orderNumber: '1',
  createdAt,
  lines: [],
});

describe('hasUnread', () => {
  it('an empty list has nothing unread', () => {
    expect(hasUnread([], null)).toBe(false);
  });
  it('anything is unread when nothing was seen', () => {
    expect(hasUnread([item('2026-10-31T10:00:00.000Z')], null)).toBe(true);
  });
  it('compares the newest item with what was seen', () => {
    const items = [item('2026-10-31T10:00:00.000Z')];
    expect(hasUnread(items, '2026-10-31T10:00:00.000Z')).toBe(false);
    expect(hasUnread(items, '2026-10-31T09:59:59.000Z')).toBe(true);
  });
});
