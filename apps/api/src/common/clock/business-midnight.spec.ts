import { describe, expect, it } from 'vitest';
import { businessMidnightUtc, businessTimeToUtc, getBusinessTimeParts } from './business-time.js';

describe('businessMidnightUtc', () => {
  it('is local midnight in Tashkent, i.e. 19:00 UTC of the previous day', () => {
    expect(businessMidnightUtc(2026, 9, 1)?.toISOString()).toBe('2026-08-31T19:00:00.000Z');
    expect(businessMidnightUtc(2026, 1, 1)?.toISOString()).toBe('2025-12-31T19:00:00.000Z');
  });

  it('round-trips through getBusinessTimeParts', () => {
    const parts = getBusinessTimeParts(businessMidnightUtc(2026, 10, 20)!);
    expect([parts.year, parts.month, parts.day, parts.hour, parts.minute]).toEqual([
      2026, 10, 20, 0, 0,
    ]);
  });

  it('rejects dates that do not exist', () => {
    expect(businessMidnightUtc(2026, 2, 31)).toBeNull();
    expect(businessMidnightUtc(2026, 13, 1)).toBeNull();
    expect(businessMidnightUtc(2026, 0, 10)).toBeNull();
    expect(businessMidnightUtc(2025, 2, 29)).toBeNull();
    expect(businessMidnightUtc(2024, 2, 29)?.toISOString()).toBe('2024-02-28T19:00:00.000Z');
  });
});

describe('businessTimeToUtc', () => {
  it('converts a Tashkent wall-clock time to the exact instant (seconds included)', () => {
    expect(businessTimeToUtc(2026, 10, 20, 9, 15, 42)?.toISOString()).toBe(
      '2026-10-20T04:15:42.000Z',
    );
    expect(businessTimeToUtc(2026, 8, 31, 23, 59, 59)?.toISOString()).toBe(
      '2026-08-31T18:59:59.000Z',
    );
    expect(businessTimeToUtc(2026, 9, 1)?.toISOString()).toBe('2026-08-31T19:00:00.000Z');
  });

  it('round-trips through getBusinessTimeParts', () => {
    const parts = getBusinessTimeParts(businessTimeToUtc(2026, 3, 4, 23, 30, 5)!);
    expect([parts.year, parts.month, parts.day, parts.hour, parts.minute]).toEqual([
      2026, 3, 4, 23, 30,
    ]);
  });

  it('returns null for times that do not exist', () => {
    expect(businessTimeToUtc(2026, 2, 31, 10)).toBeNull();
    expect(businessTimeToUtc(2026, 10, 20, 24)).toBeNull();
    expect(businessTimeToUtc(2026, 10, 20, 10, 60)).toBeNull();
    expect(businessTimeToUtc(2026, 10, 20, 10, 0, 60)).toBeNull();
    expect(businessTimeToUtc(2026, 10, 20, -1)).toBeNull();
    expect(businessTimeToUtc(2026, 10, 20, 1.5)).toBeNull();
  });
});
