import { PRODUCT_CODE_RULE, normalizeProductCode } from '@iorder/shared';
import type { StaffProductDetailResponse } from '@iorder/shared/staff-cost';
import { describe, expect, it } from 'vitest';
import {
  buildCreateRequest,
  buildUpdateRequest,
  emptyForm,
  formFromProduct,
  productCodeRuleParams,
} from './product-form';

const product: StaffProductDetailResponse = {
  id: '00000000-0000-4000-8000-000000000001',
  productCode: 'ABC-1',
  name: 'Kabel',
  unit: 'PIECE',
  category: null,
  categoryId: null,
  trackingType: 'NONE',
  markingRequired: false,
  codeRuleConfigured: false,
  isActive: true,
  codeGenerated: false,
  mergedIntoProductId: null,
  translations: [
    { lang: 'UZ', name: 'Kabel', description: 'Tavsif' },
    { lang: 'RU', name: 'Кабель', description: null },
  ],
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
};

describe('product code normalization', () => {
  it('trims only: the code is stored and shown as entered', () => {
    expect(normalizeProductCode('  HONOR-X7C-6GB128GB-MidnightBlack ')).toBe(
      'HONOR-X7C-6GB128GB-MidnightBlack',
    );
    expect(normalizeProductCode(' abc-12x ')).toBe('abc-12x');
  });

  it('reads the hint values from the shared rule', () => {
    expect(productCodeRuleParams()).toEqual({
      max: PRODUCT_CODE_RULE.maxLength,
      symbols: '. _ / -',
    });
  });
});

describe('buildCreateRequest', () => {
  it('keeps the entered case, trims, and sends one name and no unit', () => {
    const form = emptyForm();
    form.productCode = ' Kab-1 ';
    form.name = ' Kabel ';
    expect(buildCreateRequest(form)).toEqual({
      ok: true,
      request: { productCode: 'Kab-1', name: 'Kabel' },
    });
  });

  it('reports productCode and name errors from the shared schema', () => {
    expect(buildCreateRequest(emptyForm())).toEqual({
      ok: false,
      errors: { productCode: 'productCode', name: 'name' },
    });
    const form = emptyForm();
    form.name = 'a';
    // Too long, bad characters (space inside, Cyrillic, leading symbol): the shared rule decides.
    for (const bad of ['X'.repeat(65), 'AB CD', 'Товар-1', '-ABC', 'AB	CD']) {
      form.productCode = bad;
      expect(buildCreateRequest(form)).toEqual({
        ok: false,
        errors: { productCode: 'productCode' },
      });
    }
    form.productCode = 'X'.repeat(64);
    expect(buildCreateRequest(form).ok).toBe(true);
    form.productCode = 'a.b_c/d-1';
    expect(buildCreateRequest(form).ok).toBe(true);
  });
});

describe('formFromProduct', () => {
  it('starts from the common name the api resolved, whatever the UI language', () => {
    const sheetProduct = {
      ...product,
      name: 'Кабель',
      translations: [{ lang: 'RU' as const, name: 'Кабель', description: null }],
    };
    expect(formFromProduct(sheetProduct)).toEqual({ productCode: 'ABC-1', name: 'Кабель' });
  });
});

describe('buildUpdateRequest', () => {
  it('returns null when nothing changed and never sends the product code', () => {
    expect(buildUpdateRequest(product, formFromProduct(product))).toEqual({
      ok: true,
      request: null,
    });
    const form = formFromProduct(product);
    form.productCode = 'CHANGED';
    expect(buildUpdateRequest(product, form)).toEqual({ ok: true, request: null });
  });

  it('sends the changed name only', () => {
    const form = formFromProduct(product);
    form.name = ' Kabel 2 ';
    expect(buildUpdateRequest(product, form)).toEqual({ ok: true, request: { name: 'Kabel 2' } });
  });

  it('rejects clearing the name', () => {
    const form = formFromProduct(product);
    form.name = ' ';
    expect(buildUpdateRequest(product, form)).toEqual({ ok: false, errors: { name: 'name' } });
  });
});
