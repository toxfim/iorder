import { describe, expect, it } from 'vitest';
import { resolveBrand, visibleBrands } from './brand.service.js';
import type { BrandView, ProductView } from './product.view.js';

const brand = (name: string): BrandView => ({ id: `id-${name}`, name });
const BRANDS = ['Xiaomi', 'Redmi', 'Mijia', 'Huawei'].map(brand);

const product = (name: string): ProductView =>
  ({ translations: [{ lang: 'RU', name, description: null }] }) as unknown as ProductView;

describe('resolveBrand: Redmi and Mijia are part of Xiaomi', () => {
  it.each([
    ['Наушники REDMI Buds 8 Black', 'Xiaomi'],
    ['Аэрофритюрница Mijia Smart Steam Air Fryer 7L EU', 'Xiaomi'],
    ['Xiaomi Robot Vacuum 6 EU', 'Xiaomi'],
    ['HUAWEI Watch D2', 'Huawei'],
  ])('%s -> %s', (name, expected) => {
    expect(resolveBrand(product(name), null, BRANDS)?.name).toBe(expected);
  });

  it('an older staff choice of Redmi or Mijia also lands on Xiaomi', () => {
    expect(resolveBrand(product('Any'), 'id-Redmi', BRANDS)?.name).toBe('Xiaomi');
    expect(resolveBrand(product('Any'), 'id-Mijia', BRANDS)?.name).toBe('Xiaomi');
  });

  it('another staff choice still wins over the finder', () => {
    expect(resolveBrand(product('REDMI Buds'), 'id-Huawei', BRANDS)?.name).toBe('Huawei');
  });

  it('a name without a brand stays without one', () => {
    expect(resolveBrand(product('FreeBuds 6i Black'), null, BRANDS)).toBeNull();
  });
});

describe('visibleBrands', () => {
  it('offers neither Redmi nor Mijia to staff, in any letter case', () => {
    expect(visibleBrands([...BRANDS, brand('REDMI')]).map((b) => b.name)).toEqual([
      'Xiaomi',
      'Huawei',
    ]);
  });
});
