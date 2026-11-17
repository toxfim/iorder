import { describe, expect, it } from 'vitest';
import { findBrand } from './brand-finder.js';

const SEED = ['Xiaomi', 'Redmi', 'Mijia', 'Huawei', 'Motorola', 'Black Shark'].map((name) => ({
  name,
}));
const brandOf = (name: string, brands = SEED): string | null =>
  findBrand(name, brands)?.name ?? null;

describe('findBrand', () => {
  it.each([
    ['Наушники REDMI Buds 8 Black', 'Redmi'],
    ['Xiaomi Robot Vacuum 6 EU', 'Xiaomi'],
    ['Mijia Vacuum Cleaner 4 EU', 'Mijia'],
    ['HUAWEI Watch D2', 'Huawei'],
    ['Black Shark Pad 7 Pro', 'Black Shark'],
    ['Redmi watch 5 active Silver', 'Redmi'],
    ['Смарт часы Redmi Watch 6 Glacier Blue', 'Redmi'],
    ['Робот-пылесос Xiaomi Robot Vacuum 5 EU', 'Xiaomi'],
    ['Аэрофритюрница Mijia Smart Steam Air Fryer 7L EU', 'Mijia'],
    ['Motorola G06 4/128 Tapestry (Blue)', 'Motorola'],
  ])('%s -> %s', (name, brand) => {
    expect(brandOf(name)).toBe(brand);
  });

  it('finds nothing in names without a known brand', () => {
    expect(brandOf('FreeBuds 6i Black')).toBeNull();
    expect(brandOf('Mi Wi-Fi Range Extender Pro CE')).toBeNull();
    expect(brandOf('')).toBeNull();
  });

  it('matches whole words only: "Mi" never matches inside "Mijia" or "Xiaomi"', () => {
    const brands = [{ name: 'Mi' }];
    expect(brandOf('Mijia Vacuum Cleaner 4 EU', brands)).toBeNull();
    expect(brandOf('Xiaomi Smart Band 10', brands)).toBeNull();
    expect(brandOf('Mi Wi-Fi Range Extender Pro CE', brands)).toBe('Mi');
    expect(brandOf('Термометр Mi Temperature and Humidity Monitor 3', brands)).toBe('Mi');
  });

  it('the earliest match wins', () => {
    expect(brandOf('Redmi Buds by Xiaomi')).toBe('Redmi');
    expect(brandOf('Xiaomi Redmi Note 14')).toBe('Xiaomi');
  });

  it('at the same position the longer brand wins, whatever the list order', () => {
    const brands = [{ name: 'Black' }, { name: 'Black Shark' }];
    expect(brandOf('Black Shark Pad 7 Pro', brands)).toBe('Black Shark');
    expect(brandOf('Black Shark Pad 7 Pro', [...brands].reverse())).toBe('Black Shark');
    expect(brandOf('Black Cable', brands)).toBe('Black');
  });

  it('a multi-word brand needs its words in order and next to each other', () => {
    expect(brandOf('Shark Black Pad')).toBeNull();
    expect(brandOf('Black Pad Shark')).toBeNull();
    expect(brandOf('black-shark pad')).toBe('Black Shark');
  });

  it('matches Cyrillic brand names case-insensitively', () => {
    expect(brandOf('Чайник ВИТЯЗЬ белый', [{ name: 'Витязь' }])).toBe('Витязь');
  });
});
