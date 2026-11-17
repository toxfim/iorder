import type { CustomerHomeRecommendationsResponse, CustomerMatchingItem } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  addableQuantity,
  daysSince,
  heroOf,
  isFirstVisit,
  matchingCardsOf,
  stockBadgeOf,
} from './home-blocks';

const item = (code: string): CustomerMatchingItem => ({
  productId: code,
  productCode: code,
  unit: 'PIECE',
  name: code,
  price: '1.00',
  deferredPrice: null,
  rrp: null,
  orderableStock: null,
  currency: 'UZS',
  imageUrl: null,
  imageLargeUrl: null,
  boughtProductName: 'bought',
});
const recs = (
  partial: Partial<CustomerHomeRecommendationsResponse>,
): CustomerHomeRecommendationsResponse => ({
  reorder: [],
  matching: [],
  newerModel: null,
  ...partial,
});

describe('the hero and the cards under it', () => {
  it('a confirmed newer model is the hero and every matching product stays a card', () => {
    const newer = { ...item('new'), replacesProductName: 'old', replacesTimesOrdered: 2 };
    const r = recs({ newerModel: newer, matching: [item('a'), item('b')] });
    expect(heroOf(r)).toEqual({ kind: 'newer', item: newer });
    expect(matchingCardsOf(r).map((c) => c.productId)).toEqual(['a', 'b']);
  });

  it('without one, the first matching product moves up as a neutral pick and leaves the cards', () => {
    const r = recs({ matching: [item('a'), item('b')] });
    expect(heroOf(r)).toEqual({ kind: 'pick', item: item('a') });
    expect(matchingCardsOf(r).map((c) => c.productId)).toEqual(['b']);
  });

  it('nothing at all means the first visit', () => {
    expect(heroOf(recs({}))).toBeNull();
    expect(isFirstVisit(recs({}))).toBe(true);
    expect(isFirstVisit(recs({ matching: [item('a')] }))).toBe(false);
  });
});

describe('stock and quantities', () => {
  it('calls out an empty or a low figure only', () => {
    expect(stockBadgeOf(null)).toBeNull();
    expect(stockBadgeOf(0)).toBe('out');
    expect(stockBadgeOf(5)).toBe('low');
    expect(stockBadgeOf(6)).toBeNull();
  });

  it('caps the one-tap quantity at the figure and leaves a product without one alone', () => {
    expect(addableQuantity(20, null)).toBe(20);
    expect(addableQuantity(20, 45)).toBe(20);
    expect(addableQuantity(20, 7)).toBe(7);
    expect(addableQuantity(20, 0)).toBe(0);
  });

  it('counts whole days since the receipt, never negative', () => {
    const now = new Date('2026-11-10T10:00:00Z');
    expect(daysSince('2026-11-10T08:00:00Z', now)).toBe(0);
    expect(daysSince('2026-10-26T12:00:00Z', now)).toBe(14);
    expect(daysSince('2026-11-11T00:00:00Z', now)).toBe(0);
  });
});
