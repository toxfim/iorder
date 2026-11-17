import { describe, expect, it } from 'vitest';
import { getBusinessTimeParts } from './business-time.js';

describe('getBusinessTimeParts', () => {
  it('converts a UTC instant to Asia/Tashkent wall-clock time (UTC+5)', () => {
    // Monday 2026-10-19 05:00 UTC is 10:00 in Tashkent, the start of accounting hours.
    expect(getBusinessTimeParts(new Date('2026-10-19T05:00:00Z'))).toEqual({
      year: 2026,
      month: 10,
      day: 19,
      weekday: 1,
      hour: 10,
      minute: 0,
    });
  });

  it('rolls over to the next local day when UTC is still the previous day', () => {
    // Saturday 20:00 UTC is already Sunday 01:00 in Tashkent.
    const parts = getBusinessTimeParts(new Date('2026-10-17T20:00:00Z'));
    expect(parts.weekday).toBe(7);
    expect(parts.day).toBe(18);
    expect(parts.hour).toBe(1);
  });

  it('reports hour 0, not 24, at local midnight', () => {
    expect(getBusinessTimeParts(new Date('2026-10-16T19:00:00Z')).hour).toBe(0);
  });
});
