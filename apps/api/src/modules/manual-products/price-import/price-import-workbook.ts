import ExcelJS from 'exceljs';
import { DEFAULT_LOCALE, type Locale } from '@iorder/shared';
import {
  PRICE_IMPORT_ALIF_COLUMNS,
  PRICE_IMPORT_COLUMNS,
  PRICE_IMPORT_WHOLESALE_COLUMNS,
  PRICE_IMPORT_MAX_ROWS,
  type PriceImportColumn,
  type PriceImportFileError,
} from '@iorder/shared/staff-cost';
import { UnprocessableError } from '../../../common/errors/domain-errors.js';
import {
  PRICE_IMPORT_ALIF_HEADERS,
  PRICE_IMPORT_HEADERS,
  PRICE_IMPORT_WHOLESALE_HEADERS,
  findAlifColumns,
  findWholesaleColumns,
  isBlankRow,
  matchHeaders,
  readRow,
  type ImportRowInput,
} from './price-import-rows.js';

// The .xlsx side of the price list import [C, 2026-11-09]: the template staff download and the
// reading of the file they upload. Style follows the price list file (price-list-export.service).

/** One pre-filled row of the template: a generated-code product of the published list. */
export interface TemplateRow {
  productCode: string;
  name: string;
  brandName: string | null;
  /** The product's category label, for reading: an import never changes it. */
  category: string | null;
  /** USD decimal strings from the list; never put through arithmetic. */
  basePrice: string;
  deferredPrice: string | null;
  rrp: string | null;
  wholesalePrice: string | null;
  wholesaleDeferredPrice: string | null;
  alifPrice: string | null;
  alifDeferredPrice: string | null;
}

/** The template's wholesale columns come right after the required ones. */
const wholesaleColumnOf = (column: (typeof PRICE_IMPORT_WHOLESALE_COLUMNS)[number]): number =>
  PRICE_IMPORT_COLUMNS.length + PRICE_IMPORT_WHOLESALE_COLUMNS.indexOf(column) + 1;
/** And the Alif factoring columns right after the wholesale ones [C, owner 2026-11-12]. */
const alifColumnOf = (column: (typeof PRICE_IMPORT_ALIF_COLUMNS)[number]): number =>
  PRICE_IMPORT_COLUMNS.length +
  PRICE_IMPORT_WHOLESALE_COLUMNS.length +
  PRICE_IMPORT_ALIF_COLUMNS.indexOf(column) +
  1;

const COLUMN_WIDTHS: Record<PriceImportColumn, number> = {
  productCode: 16,
  name: 50,
  brand: 18,
  category: 22,
  basePrice: 14,
  deferredPrice: 14,
  rrp: 14,
};
/** The 1-based sheet column of a template column: the layout has ONE definition, the shared list. */
const columnOf = (column: PriceImportColumn): number => PRICE_IMPORT_COLUMNS.indexOf(column) + 1;
const PRICE_COLUMNS = new Set<number>([
  columnOf('basePrice'),
  columnOf('deferredPrice'),
  columnOf('rrp'),
  wholesaleColumnOf('wholesalePrice'),
  wholesaleColumnOf('wholesaleDeferredPrice'),
  alifColumnOf('alifPrice'),
  alifColumnOf('alifDeferredPrice'),
]);
/** Columns read from an uploaded row: the template's and a few extra (where wholesale may be). */
const MAX_READ_COLUMNS = 20;
const INK = 'FF202020';
const WHITE = 'FFFFFFFF';
/** A decimal with at most this many significant digits round-trips through a double unchanged. */
const MAX_EXACT_DIGITS = 15;
/** The ZIP magic every .xlsx starts with ("PK\x03\x04"). */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** The template: the headers (UZ by default), one row per given product, prices as numbers. */
export async function buildTemplateWorkbook(
  rows: readonly TemplateRow[],
  lang: Locale = DEFAULT_LOCALE,
): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'iOrder.uz';
  const sheet = workbook.addWorksheet('Import', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = [
    ...PRICE_IMPORT_COLUMNS.map((column) => ({ width: COLUMN_WIDTHS[column] })),
    ...PRICE_IMPORT_WHOLESALE_COLUMNS.map(() => ({ width: 18 })),
    ...PRICE_IMPORT_ALIF_COLUMNS.map(() => ({ width: 18 })),
  ];
  const header = sheet.getRow(1);
  header.height = 22;
  const headers = [
    ...PRICE_IMPORT_HEADERS[lang],
    ...PRICE_IMPORT_WHOLESALE_COLUMNS.map((c) => PRICE_IMPORT_WHOLESALE_HEADERS[c].template[lang]),
    ...PRICE_IMPORT_ALIF_COLUMNS.map((c) => PRICE_IMPORT_ALIF_HEADERS[c].template[lang]),
  ];
  headers.forEach((text, index) => {
    const cell = header.getCell(index + 1);
    cell.value = text;
    cell.font = { name: 'Calibri', bold: true, size: 11, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INK } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  rows.forEach((item, index) => {
    const row = sheet.getRow(index + 2);
    const code = row.getCell(columnOf('productCode'));
    code.value = item.productCode;
    code.font = { name: 'Consolas', size: 10 };
    row.getCell(columnOf('name')).value = item.name;
    if (item.brandName !== null) row.getCell(columnOf('brand')).value = item.brandName;
    if (item.category !== null) row.getCell(columnOf('category')).value = item.category;
    writePrice(row.getCell(columnOf('basePrice')), item.basePrice);
    if (item.deferredPrice !== null) {
      writePrice(row.getCell(columnOf('deferredPrice')), item.deferredPrice);
    }
    if (item.rrp !== null) writePrice(row.getCell(columnOf('rrp')), item.rrp);
    if (item.wholesalePrice !== null) {
      writePrice(row.getCell(wholesaleColumnOf('wholesalePrice')), item.wholesalePrice);
    }
    if (item.wholesaleDeferredPrice !== null) {
      writePrice(
        row.getCell(wholesaleColumnOf('wholesaleDeferredPrice')),
        item.wholesaleDeferredPrice,
      );
    }
    if (item.alifPrice !== null) writePrice(row.getCell(alifColumnOf('alifPrice')), item.alifPrice);
    if (item.alifDeferredPrice !== null) {
      writePrice(row.getCell(alifColumnOf('alifDeferredPrice')), item.alifDeferredPrice);
    }
  });
  // The price columns stay money-formatted for the rows staff add below the pre-filled ones.
  for (const column of PRICE_COLUMNS) sheet.getColumn(column).numFmt = '0.00';
  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

/** A money string as a numeric cell when a double keeps every digit, else as text (hard rule 1). */
function writePrice(cell: ExcelJS.Cell, price: string): void {
  if (/^\d+(\.\d+)?$/.test(price) && price.replace('.', '').length <= MAX_EXACT_DIGITS) {
    cell.value = Number(price);
    cell.numFmt = '0.00';
  } else {
    cell.value = price;
  }
}

function fileError(reason: PriceImportFileError, message: string): UnprocessableError {
  return new UnprocessableError('PRICE_IMPORT_FILE_INVALID', message, { reason });
}

/**
 * Reads the first worksheet whose header row is the template's (in any language) of an uploaded
 * .xlsx into rows; a leading empty or unrelated sheet is skipped. Whole-file problems are 422 with
 * the reason in `details.reason`: not an .xlsx, no worksheet with the template's headers, no data
 * rows, or more than PRICE_IMPORT_MAX_ROWS. Blank lines are skipped; the row number is the sheet's own.
 */
export async function readImportWorkbook(data: Buffer): Promise<ImportRowInput[]> {
  if (!data.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    throw fileError('FILE_NOT_XLSX', 'The file is not an .xlsx workbook');
  }
  const workbook = new ExcelJS.Workbook();
  try {
    // ExcelJS types its input as an ArrayBuffer but reads a Node Buffer.
    await workbook.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw fileError('FILE_NOT_XLSX', 'The file could not be read as an .xlsx workbook');
  }
  if (workbook.worksheets.length === 0) {
    throw fileError('FILE_EMPTY', 'The workbook has no worksheet');
  }
  const sheet = workbook.worksheets.find((s) => matchHeaders(cellsOf(s.getRow(1))) !== null);
  if (sheet === undefined) {
    throw fileError('FILE_HEADERS_INVALID', 'No worksheet has the template header row');
  }
  // Optional «Оптовик/Партнер» columns, found by their header [C, owner 2026-11-11].
  const wholesale = findWholesaleColumns(cellsOf(sheet.getRow(1)));
  // And the optional «Alif factoring» ones [C, owner 2026-11-12].
  const alif = findAlifColumns(cellsOf(sheet.getRow(1)));
  const rows: ImportRowInput[] = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const cells = cellsOf(sheet.getRow(rowNumber));
    if (isBlankRow(cells, wholesale, alif)) continue;
    rows.push(readRow(rowNumber, cells, wholesale, alif));
    if (rows.length > PRICE_IMPORT_MAX_ROWS) {
      throw fileError('FILE_TOO_MANY_ROWS', `More than ${PRICE_IMPORT_MAX_ROWS} rows`);
    }
  }
  if (rows.length === 0) throw fileError('FILE_EMPTY', 'The file has no data rows');
  return rows;
}

/** The values of the first MAX_READ_COLUMNS cells of one row (1-based cells to a 0-based list). */
function cellsOf(row: ExcelJS.Row): unknown[] {
  return Array.from({ length: MAX_READ_COLUMNS }, (_, index) => row.getCell(index + 1).value);
}
