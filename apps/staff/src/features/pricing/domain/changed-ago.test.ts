import { describe, expect, it } from 'vitest';
import { changedAgo } from './changed-ago';

// 2026-11-20 10:00 in Tashkent (UTC+5).
const NOW = new Date('2026-11-20T05:00:00Z');

describe('changedAgo', () => {
  it('says the Tashkent time for a change of today, also just after local midnight', () => {
    expect(changedAgo('2026-11-20T04:41:00Z', NOW)).toEqual({ kind: 'today', time: '09:41' });
    // 00:10 on the 20th in Tashkent is still the 19th in UTC.
    expect(changedAgo('2026-11-19T19:10:00Z', NOW)).toEqual({ kind: 'today', time: '00:10' });
  });

  it('says yesterday for the day before by the Tashkent calendar', () => {
    // 23:50 on the 19th in Tashkent.
    expect(changedAgo('2026-11-19T18:50:00Z', NOW)).toEqual({ kind: 'yesterday' });
  });

  it('counts days for two weeks, then weeks, then months', () => {
    expect(changedAgo('2026-11-15T05:00:00Z', NOW)).toEqual({ kind: 'days', count: 5 });
    expect(changedAgo('2026-11-07T05:00:00Z', NOW)).toEqual({ kind: 'days', count: 13 });
    expect(changedAgo('2026-11-06T05:00:00Z', NOW)).toEqual({ kind: 'weeks', count: 2 });
    expect(changedAgo('2026-10-22T05:00:00Z', NOW)).toEqual({ kind: 'weeks', count: 4 });
    expect(changedAgo('2026-10-21T05:00:00Z', NOW)).toEqual({ kind: 'months', count: 1 });
    expect(changedAgo('2026-08-20T05:00:00Z', NOW)).toEqual({ kind: 'months', count: 3 });
  });

  it('reads a change ahead of the clock as today and refuses a malformed instant', () => {
    expect(changedAgo('2026-11-20T06:00:00Z', NOW)).toEqual({ kind: 'today', time: '11:00' });
    expect(changedAgo('not a date', NOW)).toBeNull();
  });
});
