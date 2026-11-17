import { DomainError } from '../../common/errors/domain-errors.js';
import type { SheetTable } from './delivery-cost-source.js';
import { normalizeSheetText } from './sheet-values.js';

/**
 * The columns we read from «Поставка», by HEADER NAME [C, 2026-10-20, data-model §6.4]. Nothing
 * else is read, stored or logged. The left side is our English field, the right side the sheet's
 * header.
 */
export const SHEET_COLUMNS = {
  deliveredAt: 'Дата',
  deliveryRef: 'ID заявки (с таблицы Заяки)',
  supplier: 'Поставщик',
  purchaseMethod: 'Метод закупки',
  category: 'Категория',
  productCode: 'Товар_ID',
  productName: 'Наименование товара',
  // The quantity the warehouse confirmed on arrival.
  deliveredQuantity: 'Факт кол-во',
  costUsd: 'Цена закупа $',
  usdRateUsed: 'Курс на день поставки',
  costUzs: 'Цена закупа сумм',
  availableQuantity: 'Доступное кол-во',
} as const;

export type SheetField = keyof typeof SHEET_COLUMNS;
export type SheetHeader = (typeof SHEET_COLUMNS)[SheetField];
/** A data row reduced to the required columns, keyed by the sheet's own header names. */
export type SheetRecord = Record<SheetHeader, unknown>;

/**
 * The read cannot proceed: required columns are missing (or ambiguous). Names HEADERS only, never
 * cell contents. The whole read fails: syncing with a column missing would silently drop data.
 */
export class SheetFormatError extends DomainError {
  readonly code = 'SHEET_FORMAT_INVALID';

  constructor(
    readonly missingHeaders: readonly string[],
    readonly duplicatedHeaders: readonly string[],
  ) {
    super(
      [
        missingHeaders.length > 0 ? `Missing required columns: ${missingHeaders.join(', ')}` : '',
        duplicatedHeaders.length > 0
          ? `Ambiguous (repeated) required columns: ${duplicatedHeaders.join(', ')}`
          : '',
      ]
        .filter((part) => part !== '')
        .join('. '),
    );
  }
}

// Header comparison ignores letter case and whitespace differences. The real casing and spacing of
// the headers is unverified until a real sheet is seen.
const headerKey = (header: string): string => header.toLowerCase();

/**
 * Locates the required columns by header name and returns each data row reduced to them. Extra
 * columns are dropped here, so nothing else can reach storage, logs or error messages.
 */
export function readRequiredColumns(table: SheetTable): SheetRecord[] {
  const positions = new Map<string, number[]>();
  table.headers.forEach((cell, index) => {
    const text = normalizeSheetText(cell);
    if (text === null) return;
    positions.set(headerKey(text), [...(positions.get(headerKey(text)) ?? []), index]);
  });

  const missing: string[] = [];
  const duplicated: string[] = [];
  const columnIndex = new Map<SheetHeader, number>();
  for (const header of Object.values(SHEET_COLUMNS)) {
    const found = positions.get(headerKey(header)) ?? [];
    if (found.length === 0) missing.push(header);
    else if (found.length > 1) duplicated.push(header);
    else columnIndex.set(header, found[0] ?? -1);
  }
  if (missing.length > 0 || duplicated.length > 0) throw new SheetFormatError(missing, duplicated);

  return table.rows.map((cells) => {
    const record = {} as SheetRecord;
    for (const [header, index] of columnIndex) record[header] = cells[index];
    return record;
  });
}
