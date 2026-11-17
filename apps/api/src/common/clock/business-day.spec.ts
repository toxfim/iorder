import { describe, expect, it } from 'vitest';
import { businessDayOf } from './business-time.js';

describe('businessDayOf', () => {
  it('is the Tashkent day: 19:00 UTC of the previous day up to the next 19:00 UTC', () => {
    const day = businessDayOf(new Date('2026-10-21T08:00:00Z'));
    expect(day.date).toBe('2026-10-21');
    expect(day.start.toISOString()).toBe('2026-10-20T19:00:00.000Z');
    expect(day.end.toISOString()).toBe('2026-10-21T19:00:00.000Z');
  });

  it('starts the new day exactly at 19:00:00.000 UTC; the millisecond before is the old day', () => {
    expect(businessDayOf(new Date('2026-10-20T18:59:59.999Z')).date).toBe('2026-10-20');
    const first = businessDayOf(new Date('2026-10-20T19:00:00.000Z'));
    expect(first.date).toBe('2026-10-21');
    expect(first.start.toISOString()).toBe('2026-10-20T19:00:00.000Z');
  });

  it('puts 23:30 UTC (04:30 local) into the next local date, across a year end', () => {
    const day = businessDayOf(new Date('2026-12-31T23:30:00Z'));
    expect(day.date).toBe('2027-01-01');
    expect(day.end.toISOString()).toBe('2027-01-01T19:00:00.000Z');
  });

  it('crosses month ends and leap days', () => {
    expect(businessDayOf(new Date('2026-12-31T10:00:00Z')).end.toISOString()).toBe(
      '2026-12-31T19:00:00.000Z',
    );
    expect(businessDayOf(new Date('2028-02-28T10:00:00Z')).end.toISOString()).toBe(
      '2028-02-28T19:00:00.000Z',
    );
    expect(businessDayOf(new Date('2028-02-29T10:00:00Z')).date).toBe('2028-02-29');
    expect(businessDayOf(new Date('2026-02-28T10:00:00Z')).end.toISOString()).toBe(
      '2026-02-28T19:00:00.000Z',
    );
  });

  it('a day is always exactly 24 hours (Uzbekistan has no daylight saving time)', () => {
    const day = businessDayOf(new Date('2026-03-29T10:00:00Z'));
    expect(day.end.getTime() - day.start.getTime()).toBe(24 * 3600 * 1000);
  });
});
