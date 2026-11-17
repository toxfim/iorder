import { describe, expect, it } from 'vitest';
import { Prisma } from '../../../generated/prisma/client.js';
import { PRICE_IMPORT_COLUMNS } from '@iorder/shared/staff-cost';
import {
  PRICE_IMPORT_HEADERS,
  cellText,
  findAlifColumns,
  findWholesaleColumns,
  isBlankRow,
  judgeRows,
  matchHeaders,
  parsePriceCell,
  readRow,
  summarize,
  type ImportContext,
  type ImportProductFact,
  type ImportRowInput,
} from './price-import-rows.js';

const dec = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

describe('matchHeaders', () => {
  it('accepts the UZ, RU and EN template headers, trimmed and in any case', () => {
    expect(
      matchHeaders([
        'Tovar ID',
        'Mahsulot',
        'Brend',
        'Kategoriya',
        'Цена $',
        'Отсрочка $',
        'RRP $',
      ]),
    ).toBe('UZ');
    expect(
      matchHeaders([
        ' id товара ',
        'ТОВАР',
        'Бренд',
        'категория',
        'Цена $',
        'Отсрочка $',
        'rrp  $',
      ]),
    ).toBe('RU');
    expect(
      matchHeaders([
        'Product ID',
        'Product',
        'Brand',
        'Category',
        'Price $',
        'Deferred $',
        'RRP $',
      ]),
    ).toBe('EN');
  });

  it('every language has the seven columns: category after the brand, the RRP last', () => {
    for (const headers of Object.values(PRICE_IMPORT_HEADERS)) {
      expect(headers).toHaveLength(PRICE_IMPORT_COLUMNS.length);
      expect(headers.at(-1)).toBe('RRP $');
    }
    expect(PRICE_IMPORT_HEADERS.UZ[PRICE_IMPORT_COLUMNS.indexOf('category')]).toBe('Kategoriya');
    expect(PRICE_IMPORT_HEADERS.RU[PRICE_IMPORT_COLUMNS.indexOf('category')]).toBe('Категория');
  });

  it('refuses a renamed, missing or reordered column', () => {
    const uz = PRICE_IMPORT_HEADERS.UZ;
    expect(matchHeaders(uz.map((header) => (header === 'Цена $' ? 'Narx' : header)))).toBeNull();
    expect(matchHeaders(uz.slice(0, -1))).toBeNull();
    expect(matchHeaders([uz[1], uz[0], ...uz.slice(2)])).toBeNull();
    expect(matchHeaders([])).toBeNull();
  });

  it('refuses the older five-column template: its rows would otherwise read as "no RRP"', () => {
    expect(matchHeaders(['Tovar ID', 'Mahsulot', 'Brend', 'Цена $', 'Отсрочка $'])).toBeNull();
  });
});

describe('cellText', () => {
  it('reads strings, numbers, formula results and rich text; blanks and dates are empty', () => {
    expect(cellText('  Olma ')).toBe('Olma');
    expect(cellText('   ')).toBeNull();
    expect(cellText(12.5)).toBe('12.5');
    expect(cellText({ formula: 'A1*2', result: 25 })).toBe('25');
    expect(cellText({ richText: [{ text: 'Red' }, { text: 'mi' }] })).toBe('Redmi');
    expect(cellText(null)).toBeNull();
    expect(cellText(undefined)).toBeNull();
    expect(cellText(new Date())).toBeNull();
    expect(cellText(true)).toBeNull();
  });
});

describe('parsePriceCell', () => {
  it.each([
    [12.5, '12.50'],
    [1250, '1250.00'],
    ['12.5', '12.50'],
    ['12,5', '12.50'],
    ['1 250', '1250.00'],
    ['1 250,75', '1250.75'],
    ['$12.50', '12.50'],
    ['1,250.50', '1250.50'],
    ['012.5', '12.50'],
    [{ formula: 'B2', result: '7' }, '7.00'],
  ])('reads %j as %s', (cell, expected) => {
    expect(parsePriceCell(cell)).toEqual({ kind: 'OK', value: expected });
  });

  it.each([
    ['three decimals', '12.345'],
    ['zero', '0'],
    ['negative', '-5'],
    ['text', 'abc'],
    ['comma with three decimals', '1,250'],
    ['exponent', 1e21],
    ['too many digits', '12345678901234567.00'],
  ])('refuses %s', (_label, cell) => {
    expect(parsePriceCell(cell)).toEqual({ kind: 'INVALID' });
  });

  it('tells an empty cell apart from an unreadable one', () => {
    expect(parsePriceCell(null)).toEqual({ kind: 'EMPTY' });
    expect(parsePriceCell('   ')).toEqual({ kind: 'EMPTY' });
  });
});

describe('readRow', () => {
  it('trims the cells, normalizes the prices and keeps a code as typed', () => {
    expect(
      readRow(2, [' KB-15 ', ' Kabel ', ' Xiaomi ', ' Kabellar ', '12,5', 13, '19,9']),
    ).toEqual({
      rowNumber: 2,
      productCode: 'KB-15',
      name: 'Kabel',
      brandName: 'Xiaomi',
      category: 'Kabellar',
      basePrice: '12.50',
      deferredPrice: '13.00',
      rrp: '19.90',
      wholesalePrice: null,
      wholesaleDeferredPrice: null,
      alifPrice: null,
      alifDeferredPrice: null,
      wholesaleGiven: false,
      alifGiven: false,
      issues: [],
    });
  });

  it('finds the wholesale columns by header and reads them; without them nothing is given', () => {
    const header = [...Array(7).fill('h'), 'Wholesale $', 'wholesale deferred'];
    const columns = findWholesaleColumns(header);
    expect(columns).toEqual({ wholesalePrice: 7, wholesaleDeferredPrice: 8 });
    expect(findWholesaleColumns(Array(7).fill('h'))).toEqual({
      wholesalePrice: null,
      wholesaleDeferredPrice: null,
    });
    const cells = [null, 'Kabel', null, null, 5, null, null, '4,5', 'abc'];
    expect(readRow(2, cells, columns)).toMatchObject({
      wholesalePrice: '4.50',
      wholesaleDeferredPrice: null,
      alifPrice: null,
      alifDeferredPrice: null,
      wholesaleGiven: true,
      alifGiven: false,
      issues: ['WHOLESALE_DEFERRED_PRICE_INVALID'],
    });
    expect(readRow(2, cells)).toMatchObject({ wholesaleGiven: false, issues: [] });
  });

  it('finds the Alif factoring columns by header [C, owner 2026-11-12] and checks the pair', () => {
    const header = [...Array(7).fill('h'), 'Wholesale $', 'Alif $', 'alif отсрочка $'];
    const wholesale = findWholesaleColumns(header);
    const alif = findAlifColumns(header);
    expect(alif).toEqual({ alifPrice: 8, alifDeferredPrice: 9 });
    expect(findAlifColumns(Array(7).fill('h'))).toEqual({
      alifPrice: null,
      alifDeferredPrice: null,
    });
    expect(
      readRow(2, [null, 'Kabel', null, null, 5, null, null, null, '7,5', '8'], wholesale, alif),
    ).toMatchObject({ alifPrice: '7.50', alifDeferredPrice: '8.00', alifGiven: true, issues: [] });
    expect(
      readRow(2, [null, 'Kabel', null, null, 5, null, null, null, null, '8'], wholesale, alif)
        .issues,
    ).toEqual(['ALIF_PRICE_MISSING']);
    expect(
      readRow(2, [null, 'Kabel', null, null, 5, null, null, null, 'x', null], wholesale, alif)
        .issues,
    ).toEqual(['ALIF_PRICE_INVALID']);
    // Only the Alif cell filled is still a row.
    const onlyAlif = [null, null, null, null, null, null, null, null, '7'];
    expect(isBlankRow(onlyAlif, wholesale)).toBe(true);
    expect(isBlankRow(onlyAlif, wholesale, alif)).toBe(false);
  });

  it('the category and the RRP are optional: empty cells are no issue', () => {
    expect(readRow(2, [null, 'Kabel', null, null, 5, null, null])).toMatchObject({
      category: null,
      rrp: null,
      issues: [],
    });
    expect(readRow(2, [null, 'Kabel', null, '   ', 5, null, '  '])).toMatchObject({
      category: null,
      rrp: null,
      issues: [],
    });
  });

  it('an unreadable RRP and a too long category are row issues', () => {
    for (const rrp of ['abc', '0', '-3', '1.234']) {
      expect(readRow(2, [null, 'Kabel', null, null, 5, null, rrp])).toMatchObject({
        rrp: null,
        issues: ['RRP_INVALID'],
      });
    }
    expect(readRow(2, [null, 'Kabel', null, 'x'.repeat(200), 5, null, null]).issues).toEqual([]);
    expect(readRow(2, [null, 'Kabel', null, 'x'.repeat(201), 5, null, null]).issues).toEqual([
      'CATEGORY_TOO_LONG',
    ]);
  });

  it('reports the cell problems it can see without a lookup', () => {
    const row = readRow(5, ['bad code!', '', null, null, 'x', '1.234', null]);
    expect(row.issues).toEqual([
      'CODE_FORMAT_INVALID',
      'NAME_MISSING',
      'PRICE_INVALID',
      'DEFERRED_PRICE_INVALID',
    ]);
    // Kept as typed so the preview can show it next to the issue.
    expect(row.productCode).toBe('bad code!');
    expect(readRow(3, [null, 'Olma', null, null, null, null, null]).issues).toEqual([
      'PRICE_MISSING',
    ]);
    expect(readRow(4, [null, 'x'.repeat(201), null, null, '1', null, null]).issues).toEqual([
      'NAME_TOO_LONG',
    ]);
  });

  it('knows a blank line', () => {
    expect(isBlankRow([null, '  ', undefined, null, null, null, null])).toBe(true);
    expect(isBlankRow([null, null, null, null, 5, null, null])).toBe(false);
    // A row with only one of the new cells is still a row (and then fails on its missing name).
    expect(isBlankRow([null, null, null, 'Kabellar', null, null, null])).toBe(false);
    expect(isBlankRow([null, null, null, null, null, null, 9])).toBe(false);
    // Extra columns count only when recognised (the wholesale ones).
    const extra = [null, null, null, null, null, null, null, 'note', '4.50'];
    expect(isBlankRow(extra)).toBe(true);
    expect(isBlankRow(extra, { wholesalePrice: 8, wholesaleDeferredPrice: null })).toBe(false);
  });
});

describe('judgeRows', () => {
  const row = (overrides: Partial<ImportRowInput>): ImportRowInput => ({
    rowNumber: 2,
    productCode: null,
    name: 'Kabel',
    brandName: null,
    category: null,
    basePrice: '10.00',
    deferredPrice: null,
    rrp: null,
    wholesalePrice: null,
    wholesaleDeferredPrice: null,
    alifPrice: null,
    alifDeferredPrice: null,
    wholesaleGiven: false,
    alifGiven: false,
    issues: [],
    ...overrides,
  });
  const fact = (overrides: Partial<ImportProductFact> & { id: string }): ImportProductFact => ({
    name: overrides.id,
    codeGenerated: true,
    isActive: true,
    mergedIntoProductId: null,
    ...overrides,
  });
  const context: ImportContext = {
    productsByCodeKey: new Map([
      ['kb-15', fact({ id: 'p-sheet', name: 'Кабель', codeGenerated: false })],
      ['io-000001', fact({ id: 'p-gen', name: 'Quloqchin' })],
      ['io-000002', fact({ id: 'p-merged', isActive: false, mergedIntoProductId: 'p-sheet' })],
      ['old-1', fact({ id: 'p-old', codeGenerated: false, isActive: false })],
    ]),
    brandIdsByNameKey: new Map([['xiaomi', 'b-xiaomi']]),
    publishedPrices: new Map([
      [
        'p-sheet',
        {
          basePrice: dec('10.00'),
          deferredPrice: dec('11.00'),
          rrp: dec('15.00'),
          wholesalePrice: dec('9.00'),
          wholesaleDeferredPrice: null,
          alifPrice: null,
          alifDeferredPrice: null,
        },
      ],
      [
        'p-gen',
        {
          basePrice: dec('5.00'),
          deferredPrice: null,
          rrp: null,
          wholesalePrice: null,
          wholesaleDeferredPrice: null,
          alifPrice: null,
          alifDeferredPrice: null,
        },
      ],
    ]),
    activeNameKeys: new Set(['kabel']),
  };

  it('a code-less row is NEW with the generation warning and the same-name warning', () => {
    const [judged] = judgeRows([row({})], context);
    expect(judged?.preview).toMatchObject({
      status: 'NEW',
      productId: null,
      codeGenerated: null,
      issues: [],
      warnings: ['CODE_WILL_BE_GENERATED', 'SAME_NAME_EXISTS'],
      currentBasePrice: null,
    });
  });

  it('two code-less rows of one name warn each other', () => {
    const judged = judgeRows(
      [row({ name: 'Yangi' }), row({ rowNumber: 3, name: ' yangi ' })],
      context,
    );
    expect(judged.map((r) => r.preview.warnings)).toEqual([
      ['CODE_WILL_BE_GENERATED', 'DUPLICATE_NAME_IN_FILE'],
      ['CODE_WILL_BE_GENERATED', 'DUPLICATE_NAME_IN_FILE'],
    ]);
  });

  it('an existing product is UNCHANGED when every price equals, else PRICE_CHANGED', () => {
    const judged = judgeRows(
      [
        row({ productCode: 'KB-15', basePrice: '10.00', deferredPrice: '11.00', rrp: '15.00' }),
        row({ rowNumber: 3, productCode: 'kb-15', basePrice: '10.00', deferredPrice: null }),
        row({ rowNumber: 4, productCode: 'IO-000001', basePrice: '5.00' }),
        row({ rowNumber: 5, productCode: 'IO-000001', basePrice: '6.00' }),
      ],
      context,
    );
    expect(judged.map((r) => [r.preview.status, r.preview.issues])).toEqual([
      ['UNCHANGED', []],
      ['ERROR', ['DUPLICATE_CODE_IN_FILE']],
      ['UNCHANGED', []],
      ['ERROR', ['DUPLICATE_CODE_IN_FILE']],
    ]);
    expect(judged[0]?.preview).toMatchObject({
      productId: 'p-sheet',
      codeGenerated: false,
      currentBasePrice: '10.00',
      currentDeferredPrice: '11.00',
      currentRrp: '15.00',
      rrp: '15.00',
      warnings: [],
    });
    const [changed] = judgeRows([row({ productCode: 'IO-000001', basePrice: '6.00' })], context);
    expect(changed?.preview).toMatchObject({ status: 'PRICE_CHANGED', codeGenerated: true });
    expect(changed?.currentName).toBe('Quloqchin');
  });

  it('a changed, added or removed RRP alone makes the row PRICE_CHANGED', () => {
    const sheet = { productCode: 'KB-15', basePrice: '10.00', deferredPrice: '11.00' };
    const statusOf = (input: Partial<ImportRowInput>): unknown =>
      judgeRows([row(input)], context)[0]?.preview.status;
    expect(statusOf({ ...sheet, rrp: '15.00' })).toBe('UNCHANGED');
    expect(statusOf({ ...sheet, rrp: '15.5' })).toBe('PRICE_CHANGED');
    // An empty RRP cell removes the RRP, like an empty deferred cell removes that price.
    expect(statusOf({ ...sheet, rrp: null })).toBe('PRICE_CHANGED');
    expect(statusOf({ productCode: 'IO-000001', basePrice: '5.00', rrp: null })).toBe('UNCHANGED');
    const [added] = judgeRows(
      [row({ productCode: 'IO-000001', basePrice: '5.00', rrp: '7.00' })],
      context,
    );
    expect(added?.preview).toMatchObject({
      status: 'PRICE_CHANGED',
      rrp: '7.00',
      currentRrp: null,
    });
  });

  it('the category is stored for a new product only: an existing product ignores the cell', () => {
    const tooLong = 'x'.repeat(201);
    const judged = judgeRows(
      [
        row({ name: 'Yangi', category: 'Kabellar' }),
        row({ rowNumber: 3, name: 'Yangi 2', category: null }),
        row({ rowNumber: 4, productCode: 'KB-15', category: 'Boshqa' }),
        row({
          rowNumber: 5,
          productCode: 'IO-000001',
          category: tooLong,
          issues: ['CATEGORY_TOO_LONG'],
        }),
        row({ rowNumber: 6, name: 'Yangi 3', category: tooLong, issues: ['CATEGORY_TOO_LONG'] }),
        row({
          rowNumber: 7,
          productCode: 'NOPE',
          category: tooLong,
          issues: ['CATEGORY_TOO_LONG'],
        }),
      ],
      context,
    );
    expect(judged.map((r) => [r.preview.status, r.preview.category, r.preview.issues])).toEqual([
      ['NEW', 'Kabellar', []],
      ['NEW', null, []],
      // A sheet product and a staff-added one alike: the preview shows no category it will not store.
      ['PRICE_CHANGED', null, []],
      ['PRICE_CHANGED', null, []],
      ['ERROR', tooLong, ['CATEGORY_TOO_LONG']],
      ['ERROR', tooLong, ['CATEGORY_TOO_LONG', 'UNKNOWN_PRODUCT_CODE']],
    ]);
  });

  it('a sheet product keeps its stored name: an empty or too long name cell is no issue', () => {
    const judged = judgeRows(
      [
        row({ productCode: 'KB-15', name: '', issues: ['NAME_MISSING'] }),
        row({
          rowNumber: 3,
          productCode: 'kb-15',
          name: 'x'.repeat(201),
          issues: ['NAME_TOO_LONG', 'PRICE_INVALID'],
          basePrice: null,
        }),
        row({ rowNumber: 4, productCode: 'IO-000001', name: '', issues: ['NAME_MISSING'] }),
      ],
      context,
    );
    expect(judged.map((r) => [r.preview.status, r.preview.issues, r.preview.name])).toEqual([
      ['PRICE_CHANGED', [], 'Кабель'],
      ['ERROR', ['PRICE_INVALID', 'DUPLICATE_CODE_IN_FILE'], 'Кабель'],
      ['ERROR', ['NAME_MISSING'], ''],
    ]);
    expect(judged[0]?.currentName).toBe('Кабель');
    // A code-less row and an unknown code have no stored name to fall back on.
    expect(
      judgeRows([row({}), row({ productCode: 'NOPE' })], context).map((r) => r.currentName),
    ).toEqual([null, null]);
  });

  it('names the lookup problems', () => {
    const judged = judgeRows(
      [
        row({ productCode: 'NOPE' }),
        row({ rowNumber: 3, productCode: 'OLD-1' }),
        row({ rowNumber: 4, productCode: 'IO-000002' }),
        row({ rowNumber: 5, brandName: 'Nokia' }),
        row({ rowNumber: 6, productCode: 'KB-15', brandName: ' XIAOMI ' }),
      ],
      context,
    );
    expect(judged.map((r) => r.preview.issues)).toEqual([
      ['UNKNOWN_PRODUCT_CODE'],
      ['PRODUCT_INACTIVE'],
      ['PRODUCT_MERGED'],
      ['UNKNOWN_BRAND'],
      [],
    ]);
    expect(judged[4]?.brandId).toBe('b-xiaomi');
    expect(judged[3]?.brandId).toBeNull();
  });

  it('keeps the parser issues, makes the row ERROR and counts the summary', () => {
    const judged = judgeRows(
      [row({ issues: ['PRICE_MISSING'], basePrice: null }), row({ rowNumber: 3 })],
      context,
    );
    expect(judged[0]?.preview.status).toBe('ERROR');
    expect(summarize(judged.map((r) => r.preview))).toEqual({
      newCount: 1,
      priceChangedCount: 0,
      unchangedCount: 0,
      errorCount: 1,
    });
  });
});
