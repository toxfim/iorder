import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  STAFF_ROLES,
  TERMINAL_ORDER_STATUSES,
} from './index.js';
import { ACCOUNTING_MODES } from './staff-orders.js';

describe('shared contract', () => {
  it('has no IN_DELIVERY status: released and picked up are one step', () => {
    expect(ORDER_STATUSES).not.toContain('IN_DELIVERY');
    expect(ORDER_STATUSES).toContain('RELEASED');
  });

  it('uses ACCOUNTING_CLEARED, not the old draft name', () => {
    expect(ORDER_STATUSES).toContain('ACCOUNTING_CLEARED');
    expect(ORDER_STATUSES).not.toContain('ACCOUNTANT_APPROVED');
  });

  it('only lists real statuses as terminal', () => {
    for (const status of TERMINAL_ORDER_STATUSES) {
      expect(ORDER_STATUSES).toContain(status);
    }
  });

  it('keeps payment status separate from fulfillment status', () => {
    for (const status of PAYMENT_STATUSES) {
      expect(ORDER_STATUSES).not.toContain(status);
    }
  });

  it('lists exactly the accounting modes, none of them calendar-based', () => {
    expect(ACCOUNTING_MODES).toEqual(['PENDING', 'APPROVED', 'SKIPPED_BY_MANAGER']);
  });

  it('defaults to Uzbek and does not treat dev as a staff role', () => {
    expect(DEFAULT_LOCALE).toBe('UZ');
    expect(LOCALES).toEqual(['UZ', 'RU', 'EN']);
    expect(STAFF_ROLES).not.toContain('DEV');
  });
});
