import { describe, expect, it } from 'vitest';
import { brandOptions, findBrandByName, withBrand } from './brand-options';

const brand = (name: string) => ({ id: `00000000-0000-4000-8000-${name.length}`, name });
const BRANDS = [brand('Apple'), brand('Honor'), brand('Huawei'), brand('OnePlus'), brand('Xiaomi')];
const names = (query: string): string[] => brandOptions(BRANDS, query).matches.map((b) => b.name);

describe('brandOptions', () => {
  it('shows every brand and offers no creation while nothing is typed', () => {
    expect(names('  ')).toEqual(BRANDS.map((b) => b.name));
    expect(brandOptions(BRANDS, '').createName).toBeNull();
  });

  it('lists names starting with the text first, then the ones containing it', () => {
    expect(names('on')).toEqual(['OnePlus', 'Honor']);
    expect(names('HU')).toEqual(['Huawei']);
  });

  it('offers to create the typed name only when no brand has it, ignoring case', () => {
    expect(brandOptions(BRANDS, ' huawei ').createName).toBeNull();
    expect(brandOptions(BRANDS, 'Hua').createName).toBe('Hua');
    expect(brandOptions(BRANDS, '  Redmi ').createName).toBe('Redmi');
    expect(brandOptions(BRANDS, 'x'.repeat(81)).createName).toBeNull();
  });
});

describe('findBrandByName and withBrand', () => {
  it('finds a brand ignoring case and spaces', () => {
    expect(findBrandByName(BRANDS, ' XIAOMI')?.name).toBe('Xiaomi');
    expect(findBrandByName(BRANDS, 'Redmi')).toBeNull();
  });

  it('adds a new brand in name order, once', () => {
    const redmi = { id: '00000000-0000-4000-8000-000000000099', name: 'Redmi' };
    const next = withBrand(BRANDS, redmi);
    expect(next.map((b) => b.name)).toEqual([
      'Apple',
      'Honor',
      'Huawei',
      'OnePlus',
      'Redmi',
      'Xiaomi',
    ]);
    expect(withBrand(next, redmi)).toBe(next);
  });
});
