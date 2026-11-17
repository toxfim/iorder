import ExcelJS from 'exceljs';
import { Prisma } from '../../../generated/prisma/client.js';
import type { MegaReportLine } from '../price-reference.types.js';

/**
 * The unit purchase price of one delivery line in USD, by the owner's rule (mega-report.md,
 * 2026-11-10): «Цена закупа $» when the sheet has it; otherwise «Цена закупа сумм» / «Курс на
 * день поставки». A line priced in so'm without a rate gets NO price and says so (owner's choice
 * "variant 1" of 2026-11-10: never guess a rate). A line whose cost cells are all still empty
 * (cost pending) says that instead.
 */
export type SupplyPrice =
  { kind: 'USD'; usd: Prisma.Decimal } | { kind: 'NO_RATE' } | { kind: 'PENDING' };

/** Same scale as price_reference.cost_usd. */
const USD_SCALE = 4;

export function supplyPriceUsd(
  line: Pick<MegaReportLine, 'costUsd' | 'usdRateUsed' | 'costUzs'>,
): SupplyPrice {
  // An explicit 0 in the sheet is a price (the rule falls back only for an EMPTY dollar cell).
  if (line.costUsd !== null) return { kind: 'USD', usd: line.costUsd };
  if (line.costUzs !== null && line.usdRateUsed !== null && line.usdRateUsed.greaterThan(0)) {
    return {
      kind: 'USD',
      usd: line.costUzs
        .div(line.usdRateUsed)
        .toDecimalPlaces(USD_SCALE, Prisma.Decimal.ROUND_HALF_UP),
    };
  }
  return line.costUzs !== null ? { kind: 'NO_RATE' } : { kind: 'PENDING' };
}

export interface MegaReportSupply {
  deliveryRef: string;
  availableQuantity: Prisma.Decimal;
  price: SupplyPrice;
}

export interface MegaReportProduct {
  productCode: string;
  name: string;
  /** Oldest delivery first. */
  supplies: MegaReportSupply[];
}

// Russian only (owner, mega-report.md).
export const MEGA_REPORT_TEXT = {
  sheet: 'Mega report',
  productCode: 'ID товара',
  productName: 'Наименование товара',
  supply: (n: number): string => `Поставка ${n}`,
  deliveryRef: 'ID заявки',
  quantity: 'Доступное кол-во',
  price: 'Цена закупа $',
  noRate: 'нет курса',
  pending: 'нет цены',
} as const;

const FIXED_COLUMNS = 2;
const COLUMNS_PER_SUPPLY = 3;
const HEADER_ROWS = 2;
/** A decimal with at most this many significant digits round-trips through a double unchanged. */
const MAX_EXACT_DIGITS = 15;
// The staff design tokens (--ink, --t2), the same colors as the price list file.
const INK = 'FF202020';
const MUTED = 'FF5F6368';
const ZEBRA = ['FFFFFFFF', 'FFF6F7F8'] as const;
const SUPPLY_BAND = ['FF2F3237', 'FF44484F'] as const;
const NO_RATE_FILL = 'FFFFF4E5';
const GRID = { style: 'thin', color: { argb: 'FFE1E3E6' } } as const;
const BORDER = { top: GRID, left: GRID, bottom: GRID, right: GRID };
const HEADER_EDGE = { style: 'thin', color: { argb: INK } } as const;
const HEADER_BORDER = {
  top: HEADER_EDGE,
  left: HEADER_EDGE,
  bottom: HEADER_EDGE,
  right: HEADER_EDGE,
};
const COLLATOR = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

/**
 * Groups the lines by product (one row per product code) and keeps each product's lines in the
 * order given (the repository returns them oldest first). Products are ordered by code, numbers
 * by value. A line of a product the catalog does not return is left out.
 */
export function toReportProducts(
  lines: readonly MegaReportLine[],
  products: ReadonlyMap<string, { productCode: string; name: string }>,
): MegaReportProduct[] {
  const byProduct = new Map<string, MegaReportProduct>();
  for (const line of lines) {
    const product = products.get(line.productId);
    if (product === undefined) continue;
    const row = byProduct.get(line.productId) ?? { ...product, supplies: [] };
    row.supplies.push({
      deliveryRef: line.deliveryRef,
      availableQuantity: line.availableQuantity,
      price: supplyPriceUsd(line),
    });
    byProduct.set(line.productId, row);
  }
  return [...byProduct.values()].sort((a, b) => COLLATOR.compare(a.productCode, b.productCode));
}

/**
 * One sheet: «ID товара», «Наименование товара», then one band of three columns per delivery
 * («ID заявки», «Доступное кол-во», «Цена закупа $»), as many bands as the product with the most
 * deliveries has. Two header rows (the band title over its three columns); the header rows and
 * the two product columns stay in view while scrolling.
 */
export async function buildMegaReportWorkbook(
  products: readonly MegaReportProduct[],
): Promise<Uint8Array> {
  const bands = Math.max(1, ...products.map((p) => p.supplies.length));
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(MEGA_REPORT_TEXT.sheet, {
    views: [{ state: 'frozen', xSplit: FIXED_COLUMNS, ySplit: HEADER_ROWS }],
  });
  sheet.columns = [
    { width: 14 },
    { width: 48 },
    ...Array.from({ length: bands }, () => [{ width: 12 }, { width: 12 }, { width: 14 }]).flat(),
  ];
  writeHeader(sheet, bands);

  products.forEach((product, index) => {
    const row = sheet.getRow(HEADER_ROWS + 1 + index);
    row.getCell(1).value = product.productCode;
    row.getCell(2).value = product.name;
    product.supplies.forEach((supply, band) => {
      const first = FIXED_COLUMNS + 1 + band * COLUMNS_PER_SUPPLY;
      row.getCell(first).value = supply.deliveryRef;
      // A format with optional decimals leaves a trailing dot on whole numbers in Excel ("14.").
      const quantityFormat = supply.availableQuantity.isInteger() ? '#,##0' : '#,##0.###';
      writeDecimal(row.getCell(first + 1), supply.availableQuantity, quantityFormat);
      writePrice(row.getCell(first + 2), supply.price);
    });
    styleDataRow(row, FIXED_COLUMNS + bands * COLUMNS_PER_SUPPLY, ZEBRA[index % 2] ?? ZEBRA[0]);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

function writeHeader(sheet: ExcelJS.Worksheet, bands: number): void {
  const header = (cell: ExcelJS.Cell, text: string, fill: string): void => {
    cell.value = text;
    cell.font = { name: 'Calibri', bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    cell.border = HEADER_BORDER;
  };
  sheet.getRow(1).height = 22;
  sheet.getRow(2).height = 30;
  header(sheet.getCell(1, 1), MEGA_REPORT_TEXT.productCode, INK);
  header(sheet.getCell(1, 2), MEGA_REPORT_TEXT.productName, INK);
  sheet.mergeCells(1, 1, 2, 1);
  sheet.mergeCells(1, 2, 2, 2);
  for (let band = 0; band < bands; band += 1) {
    const first = FIXED_COLUMNS + 1 + band * COLUMNS_PER_SUPPLY;
    // Neighbouring bands alternate two dark shades, so a band is easy to follow down the sheet.
    const fill = SUPPLY_BAND[band % 2] ?? INK;
    header(sheet.getCell(1, first), MEGA_REPORT_TEXT.supply(band + 1), fill);
    sheet.mergeCells(1, first, 1, first + COLUMNS_PER_SUPPLY - 1);
    header(sheet.getCell(2, first), MEGA_REPORT_TEXT.deliveryRef, fill);
    header(sheet.getCell(2, first + 1), MEGA_REPORT_TEXT.quantity, fill);
    header(sheet.getCell(2, first + 2), MEGA_REPORT_TEXT.price, fill);
  }
  sheet.autoFilter = {
    from: { row: HEADER_ROWS, column: 1 },
    to: { row: HEADER_ROWS, column: FIXED_COLUMNS + bands * COLUMNS_PER_SUPPLY },
  };
}

function styleDataRow(row: ExcelJS.Row, columns: number, fill: string): void {
  for (let column = 1; column <= columns; column += 1) {
    const cell = row.getCell(column);
    const marked = cell.value === MEGA_REPORT_TEXT.noRate;
    cell.border = BORDER;
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: marked ? NO_RATE_FILL : fill },
    };
    const isMark = marked || cell.value === MEGA_REPORT_TEXT.pending;
    cell.font = {
      name: column === 1 ? 'Consolas' : 'Calibri',
      size: 10,
      italic: isMark,
      color: { argb: isMark ? MUTED : INK },
    };
    const position = column <= FIXED_COLUMNS ? -1 : (column - FIXED_COLUMNS - 1) % 3;
    cell.alignment = {
      vertical: 'middle',
      horizontal: column === 2 ? 'left' : position === 0 || column === 1 ? 'center' : 'right',
    };
  }
}

function writePrice(cell: ExcelJS.Cell, price: SupplyPrice): void {
  if (price.kind === 'NO_RATE') cell.value = MEGA_REPORT_TEXT.noRate;
  else if (price.kind === 'PENDING') cell.value = MEGA_REPORT_TEXT.pending;
  else writeDecimal(cell, price.usd, '#,##0.00##');
}

/**
 * A numeric cell when the value round-trips through a double (a display conversion, not
 * arithmetic; hard rule 1), otherwise the exact digits as text.
 */
function writeDecimal(cell: ExcelJS.Cell, value: Prisma.Decimal, numFmt: string): void {
  const digits = value.toFixed();
  if (digits.replace(/^-/, '').replace('.', '').length <= MAX_EXACT_DIGITS) {
    cell.value = Number(digits);
    cell.numFmt = numFmt;
  } else {
    cell.value = digits;
  }
}
