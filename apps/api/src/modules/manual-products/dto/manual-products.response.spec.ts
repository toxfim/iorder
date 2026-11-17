import {
  manualProductCheckResponseSchema,
  mergePreviewResponseSchema,
} from '@iorder/shared/staff-cost';
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.js';
import type { ProductView } from '../../catalog/index.js';
import {
  toManualProductCheckResponse,
  toMergePreviewResponse,
  type MergePreviewView,
} from './manual-products.response.js';

const SOURCE_ID = '019a0000-0000-7000-8000-000000000001';
const TARGET_ID = '019a0000-0000-7000-8000-000000000002';

const product = (
  id: string,
  productCode: string,
  name: string,
  codeGenerated: boolean,
): ProductView => ({
  id,
  productCode,
  category: 'Кабели',
  categoryId: null,
  trackingType: 'NONE',
  markingRequired: false,
  codeRuleConfigured: false,
  isActive: true,
  codeGenerated,
  mergedIntoProductId: null,
  brandId: null,
  createdAt: new Date('2026-11-09T00:00:00Z'),
  updatedAt: new Date('2026-11-09T00:00:00Z'),
  translations: [{ lang: codeGenerated ? 'UZ' : 'RU', name, description: 'internal' }],
});

const source = product(SOURCE_ID, 'IO-000001', 'Kabel USB-C', true);
const target = product(TARGET_ID, 'KB-15', 'Кабель USB-C', false);

describe('toManualProductCheckResponse', () => {
  it('names each alike product with its priced flag and the brand found; nothing else', () => {
    const dto = toManualProductCheckResponse({
      similar: [source, target],
      pricedProductIds: new Set([TARGET_ID]),
      brandFound: { id: '019a0000-0000-7000-8000-00000000000b', name: 'Xiaomi' },
    });
    expect(manualProductCheckResponseSchema.parse(dto)).toEqual({
      similar: [
        {
          productId: SOURCE_ID,
          productCode: 'IO-000001',
          name: 'Kabel USB-C',
          codeGenerated: true,
          priced: false,
        },
        {
          productId: TARGET_ID,
          productCode: 'KB-15',
          name: 'Кабель USB-C',
          codeGenerated: false,
          priced: true,
        },
      ],
      brandFound: { id: '019a0000-0000-7000-8000-00000000000b', name: 'Xiaomi' },
    });
    expect(JSON.stringify(dto)).not.toContain('Кабели');
    expect(
      toManualProductCheckResponse({ similar: [], pricedProductIds: new Set(), brandFound: null }),
    ).toEqual({ similar: [], brandFound: null });
  });
});

describe('toMergePreviewResponse', () => {
  const view: MergePreviewView = {
    source: {
      product: source,
      brandName: 'Xiaomi',
      prices: { basePrice: new Prisma.Decimal('12.5'), deferredPrice: new Prisma.Decimal('13') },
      imageCount: 2,
      cartLineCount: 3,
    },
    target: {
      product: target,
      brandName: null,
      prices: { basePrice: new Prisma.Decimal('5'), deferredPrice: null },
      stockQuantity: new Prisma.Decimal('250.5'),
      costUsd: new Prisma.Decimal('4.1'),
    },
    nextVersionNumber: 8,
  };

  it('formats money with two, stock with three and cost with four fraction digits', () => {
    const dto = mergePreviewResponseSchema.parse(toMergePreviewResponse(view));
    expect(dto).toEqual({
      source: {
        productId: SOURCE_ID,
        productCode: 'IO-000001',
        name: 'Kabel USB-C',
        brandName: 'Xiaomi',
        basePrice: '12.50',
        deferredPrice: '13.00',
        imageCount: 2,
        cartLineCount: 3,
      },
      target: {
        productId: TARGET_ID,
        productCode: 'KB-15',
        name: 'Кабель USB-C',
        brandName: null,
        basePrice: '5.00',
        deferredPrice: null,
        stockQuantity: '250.500',
        costUsd: '4.1000',
      },
      nextVersionNumber: 8,
    });
  });

  it('carries null for an unpriced side, unknown stock, no cost (or no right to see it)', () => {
    const dto = toMergePreviewResponse({
      ...view,
      source: { ...view.source, prices: null },
      target: { ...view.target, stockQuantity: null, costUsd: null },
      nextVersionNumber: null,
    });
    expect(dto.source).toMatchObject({ basePrice: null, deferredPrice: null });
    expect(dto.target).toMatchObject({ stockQuantity: null, costUsd: null });
    expect(dto.nextVersionNumber).toBeNull();
    expect(mergePreviewResponseSchema.parse(dto)).toEqual(dto);
  });
});
