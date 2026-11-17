import type { PriceImportPreviewRow } from '@iorder/shared/staff-cost';
import { describe, expect, it } from 'vitest';
import { ApiConflictError, ApiNotFoundError, ApiValidationError } from '@core/lib/api-errors';
import {
  checkImportFile,
  describeManualProductError,
  describeMergeError,
  errorRowsCsv,
  fileErrorOf,
  importableRows,
  invalidRowsOf,
  orderPreviewRows,
  replacesPrice,
  toConfirmRows,
} from './manual-products';

const row = (
  rowNumber: number,
  parts: Partial<PriceImportPreviewRow> = {},
): PriceImportPreviewRow => ({
  rowNumber,
  productCode: null,
  productId: null,
  codeGenerated: null,
  name: `Row ${rowNumber}`,
  brandName: null,
  category: null,
  basePrice: '1.00',
  deferredPrice: null,
  rrp: null,
  currentBasePrice: null,
  currentDeferredPrice: null,
  currentRrp: null,
  wholesalePrice: null,
  wholesaleDeferredPrice: null,
  wholesaleGiven: false,
  currentWholesalePrice: null,
  currentWholesaleDeferredPrice: null,
  alifPrice: null,
  alifDeferredPrice: null,
  alifGiven: false,
  currentAlifPrice: null,
  currentAlifDeferredPrice: null,
  status: 'NEW',
  issues: [],
  warnings: [],
  ...parts,
});

describe('the import confirm request', () => {
  it('sends every row the preview did not refuse, in order, and nothing without a price', () => {
    const rows = [
      row(2, { productCode: '10482', status: 'PRICE_CHANGED', currentBasePrice: '2.00' }),
      row(3, { productCode: '10483', status: 'UNCHANGED', rrp: '1.90', currentRrp: '1.90' }),
      row(4, { category: 'Kabellar', rrp: '1.50' }),
      row(5, { status: 'ERROR', basePrice: null, issues: ['PRICE_MISSING'] }),
      row(6, { basePrice: null }),
    ];
    expect(importableRows(rows).map((r) => r.rowNumber)).toEqual([2, 3, 4]);
    expect(toConfirmRows(rows)).toEqual([
      {
        productCode: '10482',
        name: 'Row 2',
        brandName: null,
        category: null,
        basePrice: '1.00',
        deferredPrice: null,
        rrp: null,
      },
      {
        productCode: '10483',
        name: 'Row 3',
        brandName: null,
        category: null,
        basePrice: '1.00',
        deferredPrice: null,
        // The RRP goes back as the preview read it: leaving it out would remove it.
        rrp: '1.90',
      },
      {
        productCode: null,
        name: 'Row 4',
        brandName: null,
        category: 'Kabellar',
        basePrice: '1.00',
        deferredPrice: null,
        rrp: '1.50',
      },
    ]);
  });

  it('a price is "replaced" only when a published one differs from the new one or is removed', () => {
    expect(replacesPrice(null, '5.00')).toBe(false);
    expect(replacesPrice(null, null)).toBe(false);
    expect(replacesPrice('5.00', '5')).toBe(false);
    expect(replacesPrice('5.00', '5.5')).toBe(true);
    expect(replacesPrice('5.00', null)).toBe(true);
  });
});

describe('the check screen: order and the error rows file', () => {
  const rows = [
    row(2, { productCode: '10482', status: 'PRICE_CHANGED', currentBasePrice: '2.00' }),
    row(3, { status: 'ERROR', basePrice: null, issues: ['PRICE_MISSING'] }),
    row(4, { name: 'Demo; "kabel"' }),
    row(5, {
      status: 'ERROR',
      brandName: 'Huawei',
      category: 'Telefonlar',
      basePrice: '29.90',
      deferredPrice: '31.00',
      rrp: '39.90',
      issues: ['UNKNOWN_BRAND'],
    }),
  ];
  const isError = (r: PriceImportPreviewRow): boolean => r.status === 'ERROR';

  it('puts the error rows first, each group in file order', () => {
    expect(orderPreviewRows(rows, isError).map((r) => r.rowNumber)).toEqual([3, 5, 2, 4]);
    // A refusal the confirm added counts as an error too (the caller decides what an error is).
    expect(orderPreviewRows(rows, (r) => r.rowNumber === 4).map((r) => r.rowNumber)).toEqual([
      4, 2, 3, 5,
    ]);
  });

  it('writes the error rows as a BOM-prefixed, semicolon-separated CSV with the translated issue', () => {
    const csv = errorRowsCsv(
      rows.filter(isError),
      {
        row: 'Qator',
        code: 'Товар_ID',
        name: 'Nomi',
        brand: 'Brend',
        category: 'Kategoriya',
        price: 'Цена $',
        deferred: 'Отсрочка $',
        rrp: 'RRP $',
        issue: 'Xato',
      },
      (r) => r.issues.join(', '),
    );
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')).toEqual([
      // The template's seven columns in the template's order, between the row number and the issue.
      'Qator;Товар_ID;Nomi;Brend;Kategoriya;Цена $;Отсрочка $;RRP $;Xato',
      '3;;Row 3;;;;;;PRICE_MISSING',
      '5;;Row 5;Huawei;Telefonlar;29.90;31.00;39.90;UNKNOWN_BRAND',
      '',
    ]);
  });

  it('quotes a cell that holds the separator or a quote', () => {
    const csv = errorRowsCsv(
      [rows[2] as PriceImportPreviewRow],
      {
        row: 'r',
        code: 'c',
        name: 'n',
        brand: 'b',
        category: 'k',
        price: 'p',
        deferred: 'd',
        rrp: 'rrp',
        issue: 'i',
      },
      () => 'x',
    );
    expect(csv).toContain('4;;"Demo; ""kabel""";;;1.00;;;x');
  });
});

describe('the file check and the refusals', () => {
  it('refuses the wrong extension and an oversized file before the upload', () => {
    expect(checkImportFile({ name: 'narx.csv', size: 10 })).toBe('FILE_NOT_XLSX');
    expect(checkImportFile({ name: 'NARX.XLSX', size: 6 * 1024 * 1024 })).toBe('FILE_TOO_LARGE');
    // The design's "5 MB gacha": a file just under it passes.
    expect(checkImportFile({ name: 'narx.xlsx', size: 5 * 1024 * 1024 })).toBeNull();
    expect(checkImportFile({ name: 'narx.xlsx', size: 10 })).toBeNull();
  });

  it('reads the whole-file reason only from a 422 PRICE_IMPORT_FILE_INVALID with a known reason', () => {
    const file = (code: string, details?: unknown): ApiValidationError =>
      new ApiValidationError('x', code, [], details);
    expect(fileErrorOf(file('PRICE_IMPORT_FILE_INVALID', { reason: 'FILE_EMPTY' }))).toBe(
      'FILE_EMPTY',
    );
    expect(fileErrorOf(file('PRICE_IMPORT_FILE_INVALID', { reason: 'SOMETHING_NEW' }))).toBeNull();
    expect(fileErrorOf(file('PRICE_IMPORT_FILE_INVALID'))).toBeNull();
    // A field validation error that happens to carry a reason is not a file refusal.
    expect(fileErrorOf(file('VALIDATION_FAILED', { reason: 'FILE_EMPTY' }))).toBeNull();
    expect(fileErrorOf(new Error('boom'))).toBeNull();
  });

  it('names the unknown brand of a create from the 404 details, else the generic text', () => {
    const unknown = new ApiNotFoundError('x', 'NOT_FOUND', { reason: 'UNKNOWN_BRAND' });
    expect(describeManualProductError(unknown).key).toBe('staffCost.manual.unknownBrand');
    const plain = new ApiNotFoundError('x', 'NOT_FOUND');
    expect(describeManualProductError(plain).key).not.toBe('staffCost.manual.unknownBrand');
    // The word in the error code alone (an older fake shape) is not what the api sends.
    const inCode = new ApiNotFoundError('x', 'UNKNOWN_BRAND');
    expect(describeManualProductError(inCode).key).not.toBe('staffCost.manual.unknownBrand');
  });

  it('reads the refused rows of IMPORT_ROWS_INVALID and drops what it cannot read', () => {
    const invalid = new ApiValidationError('x', 'IMPORT_ROWS_INVALID', [], {
      rows: [
        { index: 0, issues: ['UNKNOWN_BRAND', 'NOT_A_REAL_ISSUE'] },
        { index: 'two', issues: ['PRICE_MISSING'] },
        { index: 3 },
        null,
      ],
    });
    expect(invalidRowsOf(invalid)).toEqual([
      { index: 0, issues: ['UNKNOWN_BRAND'] },
      { index: 3, issues: [] },
    ]);
    const plain = new ApiValidationError('x', 'VALIDATION_FAILED', [], { rows: [{ index: 0 }] });
    expect(invalidRowsOf(plain)).toEqual([]);
  });

  it('names the merge-only refusals from the typed conflict reason, else the generic text', () => {
    const refused = new ApiConflictError('x', 'CONFLICT', undefined, 'TARGET_IS_GENERATED');
    expect(describeMergeError(refused).key).toBe('staffCost.merge.errors.TARGET_IS_GENERATED');
    const inactive = new ApiConflictError('x', 'CONFLICT', undefined, 'INACTIVE_PRODUCT');
    expect(describeMergeError(inactive).key).toBe('apiErrors.inactiveProducts');
    // A reason only in the details is not the contract: the client does not read it from there.
    const inDetails = new ApiConflictError('x', 'CONFLICT', { reason: 'TARGET_IS_GENERATED' });
    expect(describeMergeError(inDetails).key).toBe('apiErrors.conflict');
  });
});
