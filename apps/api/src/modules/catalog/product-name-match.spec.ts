import { describe, expect, it } from 'vitest';
import {
  SIMILARITY_TIERS,
  collapseProductName,
  compactProductName,
  pairSheetMatches,
  rankSimilarProducts,
  similarityTier,
} from './product-name-match.js';

const candidate = (productCode: string, name: string) => ({ productCode, name });

describe('product name normalisation', () => {
  it('collapses case and whitespace only', () => {
    expect(collapseProductName('  Redmi   Buds\t3  Pro ')).toBe('redmi buds 3 pro');
    expect(collapseProductName('Кабель  USB-C')).toBe('кабель usb-c');
  });

  it('compacts to letters and digits of any script', () => {
    expect(compactProductName('Buds 3 Pro')).toBe('buds3pro');
    expect(compactProductName('Buds-3, Pro!')).toBe('buds3pro');
    expect(compactProductName('Кабель USB-C «тип 2»')).toBe('кабельusbcтип2');
    expect(compactProductName('---')).toBe('');
  });
});

describe('similarityTier', () => {
  it('is EXACT for the same name ignoring case and spacing', () => {
    expect(similarityTier('buds 3 pro', 'Buds  3 Pro')).toBe(SIMILARITY_TIERS.EXACT);
  });

  it('is COMPACT when only spaces or punctuation differ', () => {
    expect(similarityTier('Buds3 Pro', 'Buds 3 Pro')).toBe(SIMILARITY_TIERS.COMPACT);
    expect(similarityTier('Buds-3 Pro', 'Buds 3 Pro')).toBe(SIMILARITY_TIERS.COMPACT);
  });

  it('is CONTAINS when one name holds the whole other one', () => {
    expect(similarityTier('Buds 3', 'Redmi Buds 3 Pro')).toBe(SIMILARITY_TIERS.CONTAINS);
    expect(similarityTier('Redmi Buds 3 Pro', 'buds 3')).toBe(SIMILARITY_TIERS.CONTAINS);
  });

  it('is null for unrelated names and for empty keys', () => {
    expect(similarityTier('Buds 3', 'Kabel USB-C')).toBeNull();
    expect(similarityTier('Buds 4', 'Buds 3')).toBeNull();
    expect(similarityTier('   ', 'Buds 3')).toBeNull();
    expect(similarityTier('---', 'Buds 3')).toBeNull();
  });
});

describe('rankSimilarProducts', () => {
  const candidates = [
    candidate('C-1', 'Redmi Buds 3 Pro Black'),
    candidate('A-2', 'buds 3 pro'),
    candidate('B-3', 'Buds-3 Pro'),
    candidate('Z-9', 'Kabel USB-C'),
    candidate('A-1', 'Buds 3 Pro'),
    candidate('D-4', 'Buds 3'),
  ];

  it('orders exact, then compact, then containment; names then codes inside a tier', () => {
    expect(rankSimilarProducts('Buds 3 Pro', candidates).map((c) => c.productCode)).toEqual([
      'A-1',
      'A-2',
      'B-3',
      'D-4',
      'C-1',
    ]);
  });

  it('drops unrelated candidates and keeps at most the limit', () => {
    const ranked = rankSimilarProducts('Buds 3 Pro', candidates, 2);
    expect(ranked.map((c) => c.productCode)).toEqual(['A-1', 'A-2']);
    expect(rankSimilarProducts('Kabel', candidates).map((c) => c.productCode)).toEqual(['Z-9']);
    expect(rankSimilarProducts('Nothing like it', candidates)).toEqual([]);
  });

  it('defaults to five results', () => {
    const many = Array.from({ length: 8 }, (_, i) => candidate(`P-${i}`, `Buds 3 Pro ${i}`));
    expect(rankSimilarProducts('Buds 3 Pro', many)).toHaveLength(5);
  });
});

describe('pairSheetMatches', () => {
  const sheet = [
    { productCode: 'KB-20', name: 'Buds 3 Pro' },
    { productCode: 'KB-15', name: 'buds3pro' },
    { productCode: 'X-1', name: 'Кабель USB-C' },
    { productCode: 'P-0', name: '---' },
  ];

  it('pairs on the compact name and prefers the smallest product code', () => {
    const pairs = pairSheetMatches(
      [
        { id: 'g1', name: 'BUDS 3  PRO' },
        { id: 'g2', name: 'Kabel USB-C' },
        { id: 'g3', name: 'Кабель usb c' },
        { id: 'g4', name: '---' },
      ],
      sheet,
    );
    expect([...pairs].map(([id, match]) => [id, match.productCode])).toEqual([
      ['g1', 'KB-15'],
      ['g3', 'X-1'],
    ]);
  });

  it('never pairs on a containment alone', () => {
    expect(pairSheetMatches([{ id: 'g1', name: 'Buds 3' }], sheet).size).toBe(0);
  });
});
