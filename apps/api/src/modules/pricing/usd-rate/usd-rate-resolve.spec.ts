import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.js';
import { MANUAL_RATE_TTL_MS, resolveUsdRate, type UsdRateInputs } from './usd-rate-resolve.js';

const NOW = new Date('2026-10-31T08:00:00Z'); // 13:00 in Tashkent
const decimal = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

const channel = (rateDate = '2026-10-31'): UsdRateInputs['channel'] => ({
  rate: decimal('11960'),
  rateDate,
  postId: 557,
});
const manual = (setAgoMs = 60_000): UsdRateInputs['manual'] => {
  const setAt = new Date(NOW.getTime() - setAgoMs);
  return {
    rate: decimal('12000'),
    setBy: 'user-1',
    setAt,
    expiresAt: new Date(setAt.getTime() + MANUAL_RATE_TTL_MS),
  };
};
const bank = { rate: decimal('12044.72'), rateDate: '2026-10-31' };

const resolved = (inputs: Partial<UsdRateInputs>, now = NOW) => {
  const result = resolveUsdRate({ channel: null, manual: null, bank: null, ...inputs }, now);
  return result && { rate: result.rate.toFixed(4), source: result.source, date: result.rateDate };
};

describe('the rate in force [C, owner 2026-10-31]', () => {
  it("the channel's post for today is above a manual rate and the bank", () => {
    expect(resolved({ channel: channel(), manual: manual(), bank })).toEqual({
      rate: '11960.0000',
      source: 'CHANNEL',
      date: '2026-10-31',
    });
  });

  it('a manual rate within its 24 hours is above the bank', () => {
    expect(resolved({ manual: manual(), bank })).toEqual({
      rate: '12000.0000',
      source: 'MANUAL',
      date: null,
    });
  });

  it("with neither, the bank's rate + 40 so'm, exact to the decimal", () => {
    expect(resolved({ bank })).toEqual({
      rate: '12084.7200',
      source: 'CBU',
      date: '2026-10-31',
    });
  });

  it("yesterday's channel post is not used", () => {
    expect(resolved({ channel: channel('2026-10-30'), bank })?.source).toBe('CBU');
    expect(resolved({ channel: channel('2026-10-30'), manual: manual(), bank })?.source).toBe(
      'MANUAL',
    );
  });

  it('"today" for the channel is the Tashkent day, which starts at 19:00 UTC', () => {
    const inputs = { channel: channel('2026-10-31'), bank };
    expect(resolved(inputs, new Date('2026-10-31T18:59:59Z'))?.source).toBe('CHANNEL');
    expect(resolved(inputs, new Date('2026-10-31T19:00:00Z'))?.source).toBe('CBU');
    expect(
      resolved({ channel: channel('2026-11-01'), bank }, new Date('2026-10-31T19:00:00Z'))?.source,
    ).toBe('CHANNEL');
  });

  it('a manual rate ends exactly at 24 hours', () => {
    expect(resolved({ manual: manual(MANUAL_RATE_TTL_MS - 1), bank })?.source).toBe('MANUAL');
    expect(resolved({ manual: manual(MANUAL_RATE_TTL_MS), bank })?.source).toBe('CBU');
  });

  it('with no bank rate at all an old value stays rather than no rate, and nothing is invented', () => {
    expect(resolved({ manual: manual(MANUAL_RATE_TTL_MS * 2) })?.source).toBe('MANUAL');
    expect(resolved({ channel: channel('2026-10-30') })?.source).toBe('CHANNEL');
    expect(resolved({})).toBeNull();
  });
});
