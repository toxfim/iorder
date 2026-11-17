import { describe, expect, it } from 'vitest';
import {
  PIECE_UNIT,
  PRODUCT_NAME_LANG,
  commonProductName,
  createProductRequestSchema,
  updateProductRequestSchema,
} from '../index.js';

// Owner decision 2026-10-28: one product name for everyone, whatever the interface language;
// the company sells whole pieces only, so the unit is fixed.

describe('commonProductName', () => {
  it('ignores the reader: UZ first, then RU, then EN, then the fallback', () => {
    expect(
      commonProductName(
        [
          { lang: 'EN', name: 'Phone' },
          { lang: 'RU', name: 'Телефон' },
          { lang: 'UZ', name: 'Telefon' },
        ],
        'P-1',
      ),
    ).toBe('Telefon');
    expect(
      commonProductName(
        [
          { lang: 'EN', name: 'Phone' },
          { lang: 'RU', name: 'Телефон' },
        ],
        'P-1',
      ),
    ).toBe('Телефон');
    expect(commonProductName([{ lang: 'EN', name: 'Phone' }], 'P-1')).toBe('Phone');
    expect(commonProductName([], 'P-1')).toBe('P-1');
  });

  it('skips blank names', () => {
    expect(
      commonProductName(
        [
          { lang: 'UZ', name: '  ' },
          { lang: 'RU', name: ' Телефон ' },
        ],
        'P-1',
      ),
    ).toBe('Телефон');
  });

  it('staff write the common name into the default-language row', () => {
    expect(PRODUCT_NAME_LANG).toBe('UZ');
    expect(PIECE_UNIT).toBe('PIECE');
  });
});

describe('product requests carry one name and no unit', () => {
  it('create: product code and one name', () => {
    expect(createProductRequestSchema.parse({ productCode: ' A-1 ', name: ' Olma ' })).toEqual({
      productCode: 'A-1',
      name: 'Olma',
    });
  });

  it('rejects a unit or per-language names (strict)', () => {
    expect(
      createProductRequestSchema.safeParse({ productCode: 'A', name: 'x', unit: 'kg' }).success,
    ).toBe(false);
    expect(
      createProductRequestSchema.safeParse({
        productCode: 'A',
        translations: [{ lang: 'UZ', name: 'x' }],
      }).success,
    ).toBe(false);
    expect(updateProductRequestSchema.safeParse({ unit: 'kg' }).success).toBe(false);
  });

  it('update: name and/or isActive, a blank name is refused', () => {
    expect(updateProductRequestSchema.parse({ name: ' Nok ' })).toEqual({ name: 'Nok' });
    expect(updateProductRequestSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(updateProductRequestSchema.safeParse({}).success).toBe(false);
  });
});
