import { describe, expect, it } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { inTier, offeredInTier, tierPrices } from './price-tier.js';
import type { ItemPrices } from './pricing.types.js';

const D = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

const both: ItemPrices = {
  basePrice: D('100.00'),
  deferredPrice: D('110.00'),
  rrp: D('150.00'),
  wholesalePrice: D('90.00'),
  wholesaleDeferredPrice: D('95.00'),
  alifPrice: D('80.00'),
  alifDeferredPrice: D('85.00'),
};

const text = (prices: Pick<ItemPrices, 'basePrice' | 'deferredPrice'>) => ({
  basePrice: prices.basePrice.toFixed(2),
  deferredPrice: prices.deferredPrice?.toFixed(2) ?? null,
});

describe('tier prices [C, owner 2026-11-11]', () => {
  it('STANDARD gets the standard prices, WHOLESALE_PARTNER the wholesale ones', () => {
    expect(text(tierPrices(both, 'STANDARD'))).toEqual({
      basePrice: '100.00',
      deferredPrice: '110.00',
    });
    expect(text(tierPrices(both, 'WHOLESALE_PARTNER'))).toEqual({
      basePrice: '90.00',
      deferredPrice: '95.00',
    });
  });

  it('a wholesale price without a wholesale deferred price leaves DEFERRED impossible for that tier', () => {
    const item = { ...both, wholesaleDeferredPrice: null };
    expect(text(tierPrices(item, 'WHOLESALE_PARTNER'))).toEqual({
      basePrice: '90.00',
      deferredPrice: null,
    });
  });

  it('[P] no wholesale price: that tier falls back to BOTH standard prices', () => {
    const item = { ...both, wholesalePrice: null, wholesaleDeferredPrice: null };
    expect(text(tierPrices(item, 'WHOLESALE_PARTNER'))).toEqual({
      basePrice: '100.00',
      deferredPrice: '110.00',
    });
  });

  it('a resolved item carries no price of the other tier', () => {
    const standard = inTier(both, 'STANDARD');
    expect(standard.wholesalePrice).toBeNull();
    expect(standard.wholesaleDeferredPrice).toBeNull();
    expect(standard.basePrice.toFixed(2)).toBe('100.00');
    const wholesale = inTier(both, 'WHOLESALE_PARTNER');
    expect(wholesale.wholesalePrice).toBeNull();
    expect(wholesale.basePrice.toFixed(2)).toBe('90.00');
    expect(wholesale.deferredPrice?.toFixed(2)).toBe('95.00');
    // The RRP is the same for every tier.
    expect(wholesale.rrp?.toFixed(2)).toBe('150.00');
  });
});

describe('the Alif factoring tier [C, owner 2026-11-12]', () => {
  it('gets the Alif prices; the Alif deferred price may be missing', () => {
    expect(text(tierPrices(both, 'ALIF_FACTORING'))).toEqual({
      basePrice: '80.00',
      deferredPrice: '85.00',
    });
    expect(text(tierPrices({ ...both, alifDeferredPrice: null }, 'ALIF_FACTORING'))).toEqual({
      basePrice: '80.00',
      deferredPrice: null,
    });
  });

  it('an item without an Alif price is not offered to that tier, and never falls back', () => {
    const item = { ...both, alifPrice: null, alifDeferredPrice: null };
    expect(offeredInTier(item, 'ALIF_FACTORING')).toBe(false);
    expect(() => tierPrices(item, 'ALIF_FACTORING')).toThrow(/not offered/);
    // The other tiers are always offered the item.
    expect(offeredInTier(item, 'STANDARD')).toBe(true);
    expect(offeredInTier(item, 'WHOLESALE_PARTNER')).toBe(true);
    expect(offeredInTier(both, 'ALIF_FACTORING')).toBe(true);
  });

  it('a resolved item carries no Alif price for any tier, and no other tier price for Alif', () => {
    for (const tier of ['STANDARD', 'WHOLESALE_PARTNER', 'ALIF_FACTORING'] as const) {
      const resolved = inTier(both, tier);
      expect(resolved.alifPrice).toBeNull();
      expect(resolved.alifDeferredPrice).toBeNull();
      expect(resolved.wholesalePrice).toBeNull();
      expect(resolved.wholesaleDeferredPrice).toBeNull();
    }
    expect(inTier(both, 'ALIF_FACTORING').basePrice.toFixed(2)).toBe('80.00');
  });
});
