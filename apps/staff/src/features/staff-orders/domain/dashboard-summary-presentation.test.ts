import { describe, expect, it } from 'vitest';
import {
  ageMessage,
  ageParts,
  formatCalendarDate,
  queueLink,
} from './dashboard-summary-presentation';

describe('ageParts', () => {
  it.each([
    [0, { kind: 'underMinute' }],
    [-5, { kind: 'underMinute' }],
    [1, { kind: 'minutes', minutes: 1 }],
    [59, { kind: 'minutes', minutes: 59 }],
    [60, { kind: 'hours', hours: 1, minutes: 0 }],
    [135, { kind: 'hours', hours: 2, minutes: 15 }],
    [24 * 60 - 1, { kind: 'hours', hours: 23, minutes: 59 }],
    [24 * 60, { kind: 'days', days: 1, hours: 0 }],
    [3 * 24 * 60 + 5 * 60 + 40, { kind: 'days', days: 3, hours: 5 }],
  ])('%i minutes', (minutes, expected) => {
    expect(ageParts(minutes)).toEqual(expected);
  });
});

describe('ageMessage', () => {
  it('leaves a zero second unit out of the sentence', () => {
    expect(ageMessage(120)).toEqual({ key: 'hours', params: { hours: 2 } });
    expect(ageMessage(135)).toEqual({ key: 'hoursMinutes', params: { hours: 2, minutes: 15 } });
    expect(ageMessage(48 * 60)).toEqual({ key: 'days', params: { days: 2 } });
    expect(ageMessage(49 * 60)).toEqual({ key: 'daysHours', params: { days: 2, hours: 1 } });
    expect(ageMessage(0)).toEqual({ key: 'underMinute', params: {} });
  });
});

describe('queueLink', () => {
  it('sends the managers to the order list with the matching status', () => {
    expect(queueLink('AWAITING_MANAGER', ['MANAGER'])).toEqual({
      name: 'staff-orders',
      query: { stage: 'SUBMITTED' },
    });
    expect(queueLink('TO_DELIVER', ['ADMIN'])).toEqual({
      name: 'staff-orders',
      query: { stage: 'RELEASED' },
    });
  });

  it('sends every other role to its own queue page, or nowhere', () => {
    expect(queueLink('AWAITING_ACCOUNTING', ['ACCOUNTANT'])).toEqual({ name: 'staff-accounting' });
    expect(queueLink('SKIPPED_ACCOUNTING_TO_REVIEW', ['ACCOUNTANT'])).toEqual({
      name: 'staff-accounting',
    });
    expect(queueLink('TO_RELEASE', ['WAREHOUSE_MANAGER'])).toEqual({ name: 'staff-warehouse' });
    expect(queueLink('TO_DELIVER', ['DRIVER'])).toEqual({ name: 'staff-deliveries' });
    expect(queueLink('TO_DELIVER', ['WAREHOUSE_MANAGER'])).toBeNull();
    expect(queueLink('AWAITING_MANAGER', ['ACCOUNTANT'])).toBeNull();
  });
});

describe('formatCalendarDate', () => {
  it('turns a calendar date into DD.MM.YYYY without a time zone shift', () => {
    expect(formatCalendarDate('2026-10-19')).toBe('19.10.2026');
  });
});
