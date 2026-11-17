import { describe, expect, it } from 'vitest';
import { FAKE_ORDER_PRODUCTS } from '@/features/directory/api/fake-backoffice-fixtures';
import { FAKE_PRODUCT_SEEDS, FAKE_VERSION_NUMBERS } from './fake-price-fixtures';

// The demo price list and the demo orders must tell the same story, or a manager comparing them
// in the dev server sees two different catalogs.
describe('demo data coherence', () => {
  const published = String(FAKE_VERSION_NUMBERS.published);

  it('every product inside a demo order is in the published price list with the same name and price', () => {
    for (const [name, unitPrice] of Object.values(FAKE_ORDER_PRODUCTS)) {
      const seed = FAKE_PRODUCT_SEEDS.find((p) => p.names.UZ === name);
      expect(seed, `price list is missing "${name}"`).toBeDefined();
      expect(seed?.prices[Number(published)], name).toBe(unitPrice);
    }
  });

  it("uses 5-digit product codes and whole-so'm prices without odd fractions", () => {
    for (const seed of FAKE_PRODUCT_SEEDS) {
      expect(seed.productCode).toMatch(/^\d{5}$/);
      for (const price of Object.values(seed.prices)) {
        expect(price).toMatch(/^\d+\.00$/);
      }
    }
  });

  it('keeps product codes and names unique', () => {
    const codes = FAKE_PRODUCT_SEEDS.map((p) => p.productCode);
    const names = FAKE_PRODUCT_SEEDS.map((p) => p.names.UZ);
    expect(new Set(codes).size).toBe(codes.length);
    expect(new Set(names).size).toBe(names.length);
  });
});
