import { describe, expect, it } from 'vitest';
import type { ProductView } from '../product.view.js';
import { toStaffProductResponse } from './product.response.js';
import { createProductRequestSchema, updateProductRequestSchema } from '@iorder/shared';

describe('product schemas', () => {
  const valid = { productCode: ' A-1 ', name: ' Olma ' };

  it('trims the product code and the one name', () => {
    expect(createProductRequestSchema.parse(valid)).toEqual({ productCode: 'A-1', name: 'Olma' });
  });

  it.each([
    ['no name', { productCode: 'A-1' }],
    ['a blank name', { ...valid, name: '  ' }],
    ['a unit (pieces only)', { ...valid, unit: 'box' }],
    ['per-language names', { ...valid, translations: [{ lang: 'UZ', name: 'x' }] }],
    ['unknown field (cost leak attempt)', { ...valid, purchasePrice: '5' }],
    ['empty productCode', { ...valid, productCode: '  ' }],
  ])('rejects create with %s', (_name, input) => {
    expect(createProductRequestSchema.safeParse(input).success).toBe(false);
  });

  it('rejects an empty update and an attempt to change the productCode', () => {
    expect(updateProductRequestSchema.safeParse({}).success).toBe(false);
    expect(updateProductRequestSchema.safeParse({ productCode: 'B' }).success).toBe(false);
    expect(updateProductRequestSchema.safeParse({ isActive: false }).success).toBe(true);
  });
});

describe('toStaffProductResponse', () => {
  it('maps to an explicit allow-listed shape with ISO dates', () => {
    const product: ProductView & { secret: string } = {
      id: 'p1',
      productCode: 'A',
      category: 'Phones',
      categoryId: null,
      trackingType: 'NONE',
      markingRequired: false,
      codeRuleConfigured: false,
      isActive: true,
      codeGenerated: false,
      mergedIntoProductId: null,
      brandId: 'brand-1',
      createdAt: new Date('2026-10-20T08:00:00Z'),
      updatedAt: new Date('2026-10-20T09:00:00Z'),
      translations: [{ lang: 'RU', name: 'Яблоко', description: null }],
      secret: 'must not leak',
    };
    const response = toStaffProductResponse(product);
    expect(Object.keys(response).sort()).toEqual(
      [
        'category',
        'categoryId',
        'codeGenerated',
        'codeRuleConfigured',
        'createdAt',
        'id',
        'isActive',
        'markingRequired',
        'mergedIntoProductId',
        'name',
        'trackingType',
        'productCode',
        'translations',
        'unit',
        'updatedAt',
      ].sort(),
    );
    expect(response.category).toBe('Phones');
    // One common name and the piece unit, whatever the stored rows say.
    expect(response.name).toBe('Яблоко');
    expect(response.unit).toBe('PIECE');
    expect(response.createdAt).toBe('2026-10-20T08:00:00.000Z');
  });
});
