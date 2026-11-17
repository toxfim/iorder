import { describe, expect, it } from 'vitest';
import {
  PRODUCT_CODE_PATTERN,
  createProductRequestSchema,
  normalizeProductCode,
  productCodeKey,
  productCodeSchema,
} from '../index.js';

const REAL = 'HONOR-X7C-6GB128GB-MidnightBlack';

describe('product code rule: stored as entered, compared ignoring case', () => {
  it('trims plain spaces only and keeps the original spelling', () => {
    expect(normalizeProductCode('  ' + REAL + ' ')).toBe(REAL);
    expect(productCodeSchema.parse('  ' + REAL + ' ')).toBe(REAL);
    expect(productCodeSchema.parse('Honor-X7C')).toBe('Honor-X7C');
  });

  it('productCodeKey is the lowercase comparison key; spelling differences collapse', () => {
    expect(productCodeKey(' Honor-X7C ')).toBe('honor-x7c');
    expect(productCodeKey('HONOR-X7C')).toBe(productCodeKey('honor-x7c'));
    expect(productCodeKey(REAL)).toBe('honor-x7c-6gb128gb-midnightblack');
  });

  it.each(['A', '9', 'a.b_c-d/e', REAL, 'A'.repeat(64)])('accepts %s', (productCode) => {
    expect(productCodeSchema.safeParse(productCode).success).toBe(true);
    expect(PRODUCT_CODE_PATTERN.test(productCode)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['spaces only', '   '],
    ['an inner space', 'AB 1'],
    ['Cyrillic', 'КБ-15'],
    ['an emoji', 'AB-1😀'],
    ['sharp s', 'Straße-1'],
    ['an inner tab', 'AB\t1'],
    ['a tab at the edge (not trimmed)', '\tAB-1'],
    ['a newline at the edge (not trimmed)', 'AB-1\n'],
    ['a non-breaking space inside', 'AB\u00a01'],
    ['a non-breaking space at the edge (not trimmed)', '\u00a0AB-1'],
    ['a leading dash', '-AB1'],
    ['a leading dot', '.AB1'],
    ['a leading underscore', '_AB1'],
    ['a leading slash', '/AB1'],
    ['65 characters', 'A'.repeat(65)],
    ['a comma', 'AB,1'],
    ['a plus', 'AB+1'],
    ['a number', 5],
  ])('rejects %s', (_name, productCode) => {
    expect(productCodeSchema.safeParse(productCode).success).toBe(false);
  });

  it('is applied by the create-product request', () => {
    const ok = createProductRequestSchema.parse({ productCode: ' ' + REAL + ' ', name: 'x' });
    expect(ok.productCode).toBe(REAL);
    expect(createProductRequestSchema.safeParse({ productCode: 'КБ-15', name: 'x' }).success).toBe(
      false,
    );
  });
});
