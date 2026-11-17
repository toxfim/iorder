import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { UnprocessableError } from '../../../common/errors/domain-errors.js';
import { PRICE_IMPORT_HEADERS } from './price-import-rows.js';
import { buildTemplateWorkbook, readImportWorkbook } from './price-import-workbook.js';

/** A workbook of several sheets, each given as its rows (an empty list makes an empty sheet). */
async function workbook(sheets: readonly (readonly unknown[][])[]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  sheets.forEach((rows, index) => {
    const sheet = book.addWorksheet(`Sheet${index + 1}`);
    for (const row of rows) sheet.addRow([...row]);
  });
  return Buffer.from(await book.xlsx.writeBuffer());
}

async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof UnprocessableError) {
      return (error.details as { reason?: unknown } | undefined)?.reason;
    }
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('readImportWorkbook', () => {
  it('reads the first worksheet whose header row is the template, skipping an empty first sheet', async () => {
    const bytes = await workbook([
      [],
      [['Notes', 'about the file']],
      [
        [...PRICE_IMPORT_HEADERS.RU],
        ['KB-15', 'Кабель', null, 'Кабели', '12,5', 13, 19.9],
        [null, null, null],
      ],
    ]);
    const rows = await readImportWorkbook(bytes);
    expect(rows).toEqual([
      {
        rowNumber: 2,
        productCode: 'KB-15',
        name: 'Кабель',
        brandName: null,
        category: 'Кабели',
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
      },
    ]);
  });

  it('reads the optional «Оптовик/Партнер» columns by their header, anywhere after the required ones', async () => {
    const bytes = await workbook([
      [
        [...PRICE_IMPORT_HEADERS.UZ, 'Izoh', 'Оптовик/Партнер Отсрочка $', 'Оптовик/Партнер'],
        ['KB-15', 'Kabel', null, null, 12.5, 13, null, 'x', null, '11,5'],
        ['KB-16', 'Kabel 2', null, null, 12.5, null, null, null, 9, null],
      ],
    ]);
    const rows = await readImportWorkbook(bytes);
    expect(rows[0]).toMatchObject({
      wholesalePrice: '11.50',
      wholesaleDeferredPrice: null,
      alifPrice: null,
      alifDeferredPrice: null,
      wholesaleGiven: true,
      alifGiven: false,
      issues: [],
    });
    expect(rows[1]).toMatchObject({
      wholesalePrice: null,
      wholesaleDeferredPrice: '9.00',
      alifPrice: null,
      alifDeferredPrice: null,
      issues: ['WHOLESALE_PRICE_MISSING'],
    });
  });

  it('refuses a file of the older five-column template', async () => {
    const old = await workbook([
      [
        ['Tovar ID', 'Mahsulot', 'Brend', 'Цена $', 'Отсрочка $'],
        ['KB-15', 'Kabel', null, 12.5, 13],
      ],
    ]);
    expect(await reasonOf(readImportWorkbook(old))).toBe('FILE_HEADERS_INVALID');
  });

  it('refuses the file only when no worksheet has the template headers', async () => {
    const none = await workbook([
      [],
      [
        ['Tovar ID', 'Narx'],
        ['A', 1],
      ],
    ]);
    expect(await reasonOf(readImportWorkbook(none))).toBe('FILE_HEADERS_INVALID');
    const noRows = await workbook([[[...PRICE_IMPORT_HEADERS.UZ]]]);
    expect(await reasonOf(readImportWorkbook(noRows))).toBe('FILE_EMPTY');
    expect(await reasonOf(readImportWorkbook(Buffer.from('hello')))).toBe('FILE_NOT_XLSX');
  });
});

describe('buildTemplateWorkbook', () => {
  const headerOf = async (bytes: Uint8Array): Promise<unknown[]> => {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
    const sheet = book.worksheets[0];
    if (!sheet) throw new Error('the template has no worksheet');
    return PRICE_IMPORT_HEADERS.UZ.map((_, index) => sheet.getRow(1).getCell(index + 1).value);
  };

  it('the empty template is the seven headers, in every language', async () => {
    expect(await headerOf(await buildTemplateWorkbook([]))).toEqual([
      'Tovar ID',
      'Mahsulot',
      'Brend',
      'Kategoriya',
      'Цена $',
      'Отсрочка $',
      'RRP $',
    ]);
    for (const lang of ['UZ', 'RU', 'EN'] as const) {
      expect(await headerOf(await buildTemplateWorkbook([], lang))).toEqual([
        ...PRICE_IMPORT_HEADERS[lang],
      ]);
    }
  });

  it('a filled template reads back as the rows it was built from, category and RRP included', async () => {
    const bytes = await buildTemplateWorkbook([
      {
        productCode: 'IO-000001',
        name: 'Quloqchin',
        brandName: 'Xiaomi',
        category: 'Aksessuarlar',
        basePrice: '12.50',
        deferredPrice: '13.00',
        rrp: '19.90',
        wholesalePrice: '11.00',
        wholesaleDeferredPrice: null,
        alifPrice: '10.00',
        alifDeferredPrice: '10.50',
      },
      {
        productCode: 'IO-000002',
        name: 'Kabel',
        brandName: null,
        category: null,
        basePrice: '5.00',
        deferredPrice: null,
        rrp: null,
        wholesalePrice: null,
        wholesaleDeferredPrice: null,
        alifPrice: null,
        alifDeferredPrice: null,
      },
    ]);
    expect(await readImportWorkbook(Buffer.from(bytes))).toEqual([
      {
        rowNumber: 2,
        productCode: 'IO-000001',
        name: 'Quloqchin',
        brandName: 'Xiaomi',
        category: 'Aksessuarlar',
        basePrice: '12.50',
        deferredPrice: '13.00',
        rrp: '19.90',
        wholesalePrice: '11.00',
        wholesaleDeferredPrice: null,
        alifPrice: '10.00',
        alifDeferredPrice: '10.50',
        wholesaleGiven: true,
        alifGiven: true,
        issues: [],
      },
      {
        rowNumber: 3,
        productCode: 'IO-000002',
        name: 'Kabel',
        brandName: null,
        category: null,
        basePrice: '5.00',
        deferredPrice: null,
        rrp: null,
        wholesalePrice: null,
        wholesaleDeferredPrice: null,
        alifPrice: null,
        alifDeferredPrice: null,
        wholesaleGiven: true,
        alifGiven: true,
        issues: [],
      },
    ]);
  });
});
