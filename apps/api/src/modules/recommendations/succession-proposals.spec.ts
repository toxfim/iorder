import { describe, expect, it } from 'vitest';
import {
  parseModelName,
  proposeSuccessions,
  type SuccessionCandidate,
} from './succession-proposals.js';

const product = (
  id: string,
  name: string,
  brandKey: string | null = 'xiaomi',
  isActive = true,
): SuccessionCandidate => ({ id, name, brandKey, isActive });

const all = (candidates: readonly SuccessionCandidate[]) => new Set(candidates.map((c) => c.id));

describe('parseModelName', () => {
  it('reads the generation with the words around it', () => {
    expect(parseModelName('Redmi Buds 6 Play')).toEqual({
      line: 'redmi buds',
      generation: 6,
      suffix: '',
      tail: 'play',
    });
    expect(parseModelName('Наушники REDMI Buds 8')).toEqual({
      line: 'наушники redmi buds',
      generation: 8,
      suffix: '',
      tail: '',
    });
    expect(parseModelName('Redmi 13C 4/128GB')).toEqual({
      line: 'redmi',
      generation: 13,
      suffix: 'c',
      tail: '4/128gb',
    });
  });

  it.each([
    'Baseus 20W zaryadlovchi',
    'Ugreen 65W GaN adapter',
    'Powerbank 10000 mAh',
    'Kassa lenta 80 mm',
    'Samsung Galaxy Tab A9 64GB',
    'Hoco USB-C kabel 1 m',
    'Himoya oynasi 6.5L',
    '13 Pro',
  ])('%s has no generation', (name) => {
    expect(parseModelName(name)).toBeNull();
  });
});

describe('proposeSuccessions', () => {
  it('pairs the same line with a higher generation, older products bought by someone', () => {
    const buds6 = product('p6', 'Redmi Buds 6');
    const buds8 = product('p8', 'Redmi Buds 8');
    expect(
      proposeSuccessions([buds6, buds8], {
        pricedProductIds: all([buds6, buds8]),
        boughtProductIds: new Set(['p6']),
      }),
    ).toEqual([{ olderProductId: 'p6', newerProductId: 'p8' }]);
  });

  it('points every older generation to the newest one only', () => {
    const products = [
      product('p6', 'Redmi Buds 6'),
      product('p7', 'Redmi Buds 7'),
      product('p8', 'Redmi Buds 8'),
    ];
    expect(
      proposeSuccessions(products, {
        pricedProductIds: all(products),
        boughtProductIds: all(products),
      }).sort((a, b) => a.olderProductId.localeCompare(b.olderProductId)),
    ).toEqual([
      { olderProductId: 'p6', newerProductId: 'p8' },
      { olderProductId: 'p7', newerProductId: 'p8' },
    ]);
  });

  it('keeps the suffix and the words after the number', () => {
    const products = [
      product('a', 'Redmi 13C 4/128GB'),
      product('b', 'Redmi 14C 4/128GB'),
      product('c', 'Redmi 14 4/128GB'),
      product('d', 'Redmi 14C 8/256GB'),
      product('e', 'Redmi Buds 6 Play'),
      product('f', 'Redmi Buds 8'),
    ];
    expect(
      proposeSuccessions(products, {
        pricedProductIds: all(products),
        boughtProductIds: all(products),
      }),
    ).toEqual([{ olderProductId: 'a', newerProductId: 'b' }]);
  });

  it.each([
    ['different brands', product('x', 'Buds 6', 'xiaomi'), product('y', 'Buds 8', 'huawei')],
    ['no brand', product('x', 'Buds 6', null), product('y', 'Buds 8', null)],
    ['a unit, not a generation', product('x', 'Baseus 20W'), product('y', 'Baseus 65W')],
    ['the same generation', product('x', 'Redmi Buds 6'), product('y', 'Redmi Buds 6')],
  ])('never pairs %s', (_, older, newer) => {
    expect(
      proposeSuccessions([older, newer], {
        pricedProductIds: all([older, newer]),
        boughtProductIds: all([older, newer]),
      }),
    ).toEqual([]);
  });

  it('needs the newer product to be active and in the price list, the older one to be bought', () => {
    const older = product('p6', 'Redmi Buds 6', 'xiaomi', false);
    const newer = product('p8', 'Redmi Buds 8');
    const bought = new Set(['p6']);
    expect(
      proposeSuccessions([older, newer], {
        pricedProductIds: new Set(['p8']),
        boughtProductIds: bought,
      }),
    ).toEqual([{ olderProductId: 'p6', newerProductId: 'p8' }]);
    expect(
      proposeSuccessions([older, newer], { pricedProductIds: new Set(), boughtProductIds: bought }),
    ).toEqual([]);
    expect(
      proposeSuccessions([older, product('p8', 'Redmi Buds 8', 'xiaomi', false)], {
        pricedProductIds: new Set(['p8']),
        boughtProductIds: bought,
      }),
    ).toEqual([]);
    expect(
      proposeSuccessions([older, newer], {
        pricedProductIds: new Set(['p8']),
        boughtProductIds: new Set(),
      }),
    ).toEqual([]);
  });
});
