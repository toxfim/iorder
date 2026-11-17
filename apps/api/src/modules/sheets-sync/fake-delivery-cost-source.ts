import { Prisma } from '../../generated/prisma/client.js';
import { DeliveryCostSource, type SheetTable } from './delivery-cost-source.js';
import { SHEET_COLUMNS, type SheetField } from './sheet-columns.js';

/** In-memory source for tests and local development. It can only be read, like the real one. */
export class FakeDeliveryCostSource extends DeliveryCostSource {
  constructor(private table: SheetTable) {
    super();
  }

  readDeliveryTable(): Promise<SheetTable> {
    return Promise.resolve(this.table);
  }

  /** Test helper to simulate the sheet changing between two syncs. */
  replaceTable(table: SheetTable): void {
    this.table = table;
  }
}

/** USD x rate rounded to 2 digits: what a CONSISTENT sheet row holds as its UZS cost. */
export function uzsFor(costUsd: string, usdRate: string): string {
  return new Prisma.Decimal(costUsd).mul(usdRate).toFixed(2);
}

/** The real sheet shows the rate as `12,650`. */
export const FIXTURE_RATE = '12650.0000';

/** A cell written exactly as given (not reformatted), e.g. a misplaced-comma `12,65`. */
export const rawCell = (raw: string): { raw: string } => ({ raw });

/**
 * `1690000.50` -> `1,690,000.5`: how the real (en-US) sheet shows a number. Comma groups thousands,
 * the dot is the decimal mark, trailing zeros are not shown.
 */
export function formatLikeSheet(decimal: string): string {
  const [integer = '', fraction] = decimal.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const shown = fraction?.replace(/0+$/, '');
  return shown ? `${grouped}.${shown}` : grouped;
}

/** A fixture line in OUR terms (English fields, plain decimal strings, a sheet-style timestamp). */
export type FixtureLine = Record<SheetField, string>;

/** The time of day fixtures use when a test gives only a date, like a real morning delivery. */
export const FIXTURE_TIME = '09:15:00';

/**
 * `DD.MM.YYYY` (a test's shorthand) -> `DD/MM/YYYY 09:15:00`, the real sheet format. Anything
 * else (a full timestamp, or deliberate garbage) passes through untouched.
 */
function toSheetTimestamp(value: string): string {
  const short = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value);
  return short ? `${short[1]}/${short[2]}/${short[3]} ${FIXTURE_TIME}` : value;
}

/**
 * One consistent fixture line: costUzs is costUsd x rate unless overridden. Supplier defaults to a
 * selected one. `deliveredAt` is written `DD/MM/YYYY HH:MM:SS` like the real sheet.
 */
export function fixtureLine(
  productCode: string,
  deliveryRef: string,
  deliveredAt: string,
  overrides: Partial<FixtureLine> = {},
): FixtureLine {
  const costUsd = overrides.costUsd ?? '12.34';
  return {
    deliveredAt: toSheetTimestamp(deliveredAt),
    deliveryRef,
    supplier: 'alpha trade import',
    purchaseMethod: 'Безнал',
    category: 'Смартфоны',
    productCode,
    productName: `Товар ${productCode}`,
    deliveredQuantity: '1000',
    availableQuantity: '250.5',
    costUsd,
    usdRateUsed: FIXTURE_RATE,
    // A deliberately broken or empty costUsd (tests of rejected and cost-pending rows) has no
    // consistent UZS counterpart.
    costUzs:
      typeof costUsd !== 'string' || costUsd.trim() === '' || Number.isNaN(Number(costUsd))
        ? '1'
        : uzsFor(costUsd, FIXTURE_RATE),
    ...overrides,
  };
}

const NUMERIC_FIELDS: readonly SheetField[] = [
  'deliveredQuantity',
  'availableQuantity',
  'costUsd',
  'usdRateUsed',
  'costUzs',
];

/**
 * Builds a sheet-shaped table: Russian headers, numbers written like the real sheet shows them
 * (`1,690,000`), and two extra columns that must be ignored. Column order is not the order of
 * SHEET_COLUMNS (headers are found by name).
 */
export function fixtureTable(
  lines: readonly (FixtureLine | Partial<Record<SheetField, unknown>>)[],
  options: { omitFields?: readonly SheetField[] } = {},
): SheetTable {
  const fields = (Object.keys(SHEET_COLUMNS) as SheetField[])
    .filter((field) => !(options.omitFields ?? []).includes(field))
    .reverse();
  const headers: unknown[] = [
    'Склад',
    ...fields.map((field) => SHEET_COLUMNS[field]),
    'Комментарий',
  ];
  const rows = lines.map((line) => [
    'Склад 1 (must never be read)',
    ...fields.map((field) => {
      const value = (line as Record<string, unknown>)[field];
      if (typeof value === 'object' && value !== null && 'raw' in value) return value.raw;
      return typeof value === 'string' && NUMERIC_FIELDS.includes(field)
        ? formatLikeSheet(value)
        : value;
    }),
    'secret comment (must never be read)',
  ]);
  return { headers, rows };
}

/**
 * Product 10482 has three deliveries (product ids in the real sheet are 5-digit numbers; one cell is
 * padded with spaces, as a sheet might). All lines are internally consistent (costUzs = costUsd x
 * rate) EXCEPT 10931 / REQ-021, which is deliberately inconsistent (a wrong UZS figure typed in the
 * sheet) to exercise the mismatch report. 99999 is deliberately unknown to the catalog. 20001
 * belongs to a supplier we do not read, and the last line to the real near-miss supplier name.
 */
export const FIXTURE_LINES: readonly FixtureLine[] = [
  fixtureLine('10482', 'REQ-001', '01.08.2026', { availableQuantity: '0' }),
  fixtureLine(' 10482 ', 'REQ-014', '10.09.2026', { availableQuantity: '12', costUsd: '12.8' }),
  fixtureLine('10482', 'REQ-027', '12.10.2026', { availableQuantity: '300', costUsd: '13.1' }),
  fixtureLine('10931', 'REQ-020', '01.10.2026'),
  fixtureLine('10931', 'REQ-021', '01.10.2026', { costUzs: '999999' }),
  fixtureLine('99999', 'REQ-099', '05.10.2026', { productName: 'Неизвестный товар' }),
  fixtureLine('20001', 'REQ-500', '05.10.2026', { supplier: 'Some Other Supplier' }),
  // A real near-miss: NOT a selected supplier, so it lands in the skipped list.
  fixtureLine('20002', 'REQ-501', '05.10.2026', {
    supplier: 'Склад Север BM Восток F114 ECO sistem',
  }),
];

/** Real-shaped extras, used by dedicated tests: one request containing many products. */
export const MANY_PRODUCTS_REQUEST: readonly FixtureLine[] = Array.from({ length: 6 }, (_, i) =>
  fixtureLine(String(30001 + i), 'REQ-100', '20/10/2026 09:15:00', {
    deliveredQuantity: String(35 + i),
    availableQuantity: String(20 + i),
    costUsd: '123.45',
    costUzs: uzsFor('123.45', FIXTURE_RATE),
  }),
);

/** The real sheet has rows with a NEGATIVE available quantity: a row error, never stored. */
export const NEGATIVE_AVAILABLE_LINE: FixtureLine = fixtureLine(
  '10482',
  'REQ-777',
  '20/10/2026 09:15:00',
  { availableQuantity: '-3' },
);
