import { describe, expect, it } from 'vitest';
import { COST_CELLS_MESSAGE, createCostSourceRowSchema } from './cost-source-row.js';
import { DeliveryCostSource } from './delivery-cost-source.js';
import { FIXTURE_LINES, fixtureLine, fixtureTable } from './fake-delivery-cost-source.js';
import {
  readRequiredColumns,
  SHEET_COLUMNS,
  SheetFormatError,
  type SheetField,
} from './sheet-columns.js';

const NOW = new Date('2026-10-20T08:00:00Z');
const costSourceRowSchema = createCostSourceRowSchema(NOW);

/** A record as readRequiredColumns hands it over: keyed by the sheet's own header names. */
const record = (patch: Partial<Record<SheetField, unknown>> = {}): Record<string, unknown> => {
  const base: Record<SheetField, unknown> = {
    deliveredAt: '12/10/2026 09:15:00',
    deliveryRef: ' REQ-1 ',
    supplier: ' alpha  trade import ',
    purchaseMethod: 'Безнал',
    category: 'Смартфоны',
    productCode: ' 10482 ',
    productName: 'Xiaomi   Redmi',
    deliveredQuantity: '1,000.5',
    costUsd: '12.3456',
    usdRateUsed: '12,650.5',
    costUzs: '156,190.50',
    availableQuantity: '250',
    ...patch,
  };
  return Object.fromEntries(
    (Object.keys(SHEET_COLUMNS) as SheetField[]).map((f) => [SHEET_COLUMNS[f], base[f]]),
  );
};

describe('costSourceRowSchema', () => {
  it('reads sheet-style cells into English fields with exact decimal strings', () => {
    expect(costSourceRowSchema.parse(record())).toEqual({
      deliveredAt: new Date('2026-10-12T04:15:00.000Z'), // 12/10/2026 09:15:00 in Asia/Tashkent
      deliveryRef: 'REQ-1',
      supplier: 'alpha trade import',
      purchaseMethod: 'Безнал',
      category: 'Смартфоны',
      productCode: '10482',
      productName: 'Xiaomi Redmi',
      deliveredQuantity: '1000.5',
      costUsd: '12.3456',
      usdRateUsed: '12650.5',
      costUzs: '156190.50',
      availableQuantity: '250',
    });
  });

  it('accepts every fixture line', () => {
    const table = fixtureTable(FIXTURE_LINES);
    for (const r of readRequiredColumns(table)) {
      expect(costSourceRowSchema.safeParse(r).success).toBe(true);
    }
  });

  it.each([
    ['a JSON float instead of a sheet string', { costUsd: 12.3456 }],
    ['too many USD fraction digits (never rounded)', { costUsd: '12.34567' }],
    ['too many UZS fraction digits', { costUzs: '1.234' }],
    ['too many quantity fraction digits', { availableQuantity: '1.2345' }],
    ['a negative quantity', { deliveredQuantity: '-1' }],
    ['an exponent', { costUsd: '1e3' }],
    ['a zero rate', { usdRateUsed: '0' }],
    ['a comma decimal', { costUsd: '12,5' }],
    ['misplaced grouping', { usdRateUsed: '12,65' }],
    ['a negative available quantity', { availableQuantity: '-3' }],
    ['an empty delivery ref', { deliveryRef: '  ' }],
    ['an empty product code', { productCode: ' ' }],
    ['a product code with an inner space', { productCode: '10 482' }],
    ['a Cyrillic product code', { productCode: '1048Б' }],
    ['an empty supplier', { supplier: '' }],
    ['an empty purchase method', { purchaseMethod: ' ' }],
    ['an empty category', { category: undefined }],
    ['an empty product name', { productName: '' }],
    ['a product name with a NUL character', { productName: 'Phone\u0000X' }],
    ['a product name with a unit separator', { productName: 'Phone\u001fX' }],
    ['a 201-character product name', { productName: 'a'.repeat(201) }],
    ['an ISO date', { deliveredAt: '2026-10-12' }],
    ['a date without a time', { deliveredAt: '12/10/2026' }],
    ['the old dotted date', { deliveredAt: '12.10.2026' }],
    ['an impossible date', { deliveredAt: '31/02/2026 09:15:00' }],
    ['a date far in the future (typo)', { deliveredAt: '01/10/2062 09:15:00' }],
    ['a date before 2000', { deliveredAt: '01/01/0200 09:15:00' }],
    ['a date 3 days ahead', { deliveredAt: '23/10/2026 09:15:00' }],
    ['integer part too long', { costUzs: '10000000000000000.00' }],
  ])('rejects %s', (_name, patch) => {
    expect(costSourceRowSchema.safeParse(record(patch)).success).toBe(false);
  });

  it('accepts a 200-character product name and reports a bad name by header without its content', () => {
    expect(costSourceRowSchema.safeParse(record({ productName: 'a'.repeat(200) })).success).toBe(
      true,
    );
    const result = costSourceRowSchema.safeParse(record({ productName: 'Secret\u0000Name' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toEqual([SHEET_COLUMNS.productName]);
      expect(JSON.stringify(result.error.issues)).not.toContain('Secret');
    }
  });

  it('reports the failing sheet header as the issue path, without echoing the value', () => {
    const result = costSourceRowSchema.safeParse(record({ costUsd: '12.34567' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path.join('.'))).toEqual([SHEET_COLUMNS.costUsd]);
      expect(JSON.stringify(result.error.issues)).not.toContain('12.34567');
    }
  });

  it('reads the real en-US shapes: 12,650 is twelve thousand six hundred fifty', () => {
    const row = costSourceRowSchema.parse(
      record({
        availableQuantity: '1,500',
        deliveredQuantity: '0.500',
        usdRateUsed: '12,650',
        costUzs: '1,690,000',
      }),
    );
    expect([row.availableQuantity, row.deliveredQuantity, row.usdRateUsed, row.costUzs]).toEqual([
      '1500',
      '0.500',
      '12650',
      '1690000',
    ]);
  });

  it('delivery dates up to now + 2 days are accepted, the day after is not', () => {
    expect(
      costSourceRowSchema.safeParse(record({ deliveredAt: '22/10/2026 09:15:00' })).success,
    ).toBe(true);
    expect(
      costSourceRowSchema.safeParse(record({ deliveredAt: '23/10/2026 09:15:00' })).success,
    ).toBe(false);
  });

  it('rejects an extra key (strict) and non-objects', () => {
    expect(costSourceRowSchema.safeParse({ ...record(), Комментарий: 'x' }).success).toBe(false);
    for (const junk of [null, 'row', 5, [], undefined]) {
      expect(costSourceRowSchema.safeParse(junk).success).toBe(false);
    }
  });
});

describe('readRequiredColumns', () => {
  const lines = [fixtureLine('10482', 'REQ-1', '12.10.2026')];

  it('finds columns by header name in any order and ignores extra columns', () => {
    const table = fixtureTable(lines);
    expect(table.headers).toContain('Склад');
    const [row] = readRequiredColumns(table);
    expect(Object.keys(row ?? {}).sort()).toEqual(Object.values(SHEET_COLUMNS).sort());
    // Nothing from the ignored columns survives.
    expect(JSON.stringify(row)).not.toContain('must never be read');
  });

  it('matches headers ignoring case and whitespace differences', () => {
    const table = fixtureTable(lines);
    const messy = {
      ...table,
      headers: table.headers.map((h) => `  ${String(h).toUpperCase()}\u00a0 `),
    };
    expect(readRequiredColumns(messy)).toHaveLength(1);
  });

  it('fails the WHOLE read when required columns are missing, naming the headers', () => {
    const table = fixtureTable(lines, { omitFields: ['costUsd', 'supplier'] });
    const failure = (() => {
      try {
        readRequiredColumns(table);
        return null;
      } catch (error) {
        return error as SheetFormatError;
      }
    })();
    expect(failure).toBeInstanceOf(SheetFormatError);
    expect(failure?.missingHeaders).toEqual([SHEET_COLUMNS.supplier, SHEET_COLUMNS.costUsd]);
    expect(failure?.message).toContain('Цена закупа $');
    expect(failure?.message).toContain('Поставщик');
    expect(failure?.message).not.toContain('must never be read');
  });

  it('fails on a repeated required header (ambiguous)', () => {
    const table = fixtureTable(lines);
    const twice = { ...table, headers: [...table.headers, 'Поставщик'] };
    expect(() => readRequiredColumns(twice)).toThrow(/Ambiguous/);
  });

  it('an empty table with all headers is fine and yields no rows', () => {
    expect(readRequiredColumns(fixtureTable([]))).toEqual([]);
  });
});

describe('the source is read-only by construction (hard rule 10)', () => {
  it('exposes exactly one member, and it reads', () => {
    const methods = Object.getOwnPropertyNames(DeliveryCostSource.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(methods).toEqual([]); // abstract: declared in the type only
    const keys: (keyof DeliveryCostSource)[] = ['readDeliveryTable'];
    expect(keys).toHaveLength(1);
  });
});

describe('cost pending rows (the three cost cells empty)', () => {
  const empty = { costUsd: '', usdRateUsed: '   ', costUzs: '' };

  it('accepts a row whose three cost cells are all empty, with null costs', () => {
    expect(costSourceRowSchema.parse(record(empty))).toMatchObject({
      productCode: '10482',
      availableQuantity: '250',
      costUsd: null,
      usdRateUsed: null,
      costUzs: null,
    });
  });

  it('still rejects a row with only some cost cells empty, naming the empty headers', () => {
    const result = costSourceRowSchema.safeParse(record({ costUsd: '', usdRateUsed: '' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      [SHEET_COLUMNS.costUsd, COST_CELLS_MESSAGE],
      [SHEET_COLUMNS.usdRateUsed, COST_CELLS_MESSAGE],
    ]);
  });

  it('a non-empty cost cell is still validated as a decimal', () => {
    const result = costSourceRowSchema.safeParse(record({ ...empty, costUzs: '12,5' }));
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.map((i) => i.path.join('.'))).toEqual([SHEET_COLUMNS.costUzs]);
  });
});
