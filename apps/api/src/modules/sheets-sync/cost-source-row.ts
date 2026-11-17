import {
  decimalStringSchema,
  hasGeneratedProductCodePrefix,
  productCodeSchema,
} from '@iorder/shared';
import { z } from 'zod';
import { SHEET_COLUMNS } from './sheet-columns.js';
import {
  isPlausibleDeliveryDate,
  normalizeSheetText,
  parseSheetDate,
  parseSheetNumber,
} from './sheet-values.js';

// The ONLY shape the sync accepts for a row: strict, keyed by the sheet's own header names, so an
// unexpected column can never get through (readRequiredColumns already dropped extras), and a
// missing or malformed cell rejects the row. Numbers and dates go through sheet-values.ts, the one
// module that knows how the sheet writes them.
//
// Decimals must fit the table's scale exactly: extra fraction digits are rejected, never rounded,
// so a sync can neither lose precision nor see a phantom change on every run. The digit limits
// mirror the Decimal(p, s) columns of price_reference.

// Same limit as the staff translation name, so a sheet name can always become a translation.
const PRODUCT_NAME_MAX_LENGTH = 200;

// A NUL (or any control character left after whitespace normalization) cannot be stored in a
// PostgreSQL text column and would fail the whole chunk; the product name is the only free text
// that becomes a stored translation, so it is checked here and the row is rejected on its own.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const text = (maxLength: number, rejectControl = false) =>
  z.unknown().transform((raw, ctx): string => {
    const value = normalizeSheetText(raw);
    if (
      value === null ||
      value.length > maxLength ||
      (rejectControl && CONTROL_CHARACTERS.test(value))
    ) {
      ctx.addIssue({ code: 'custom', message: `Expected text of 1-${maxLength} characters` });
      return z.NEVER;
    }
    return value;
  });

const decimal = (maxIntegerDigits: number, maxFractionDigits: number, positive = false) =>
  z
    .unknown()
    .transform((raw, ctx): string => {
      const value = parseSheetNumber(raw);
      if (value === null) {
        ctx.addIssue({ code: 'custom', message: 'Not a valid non-negative number' });
        return z.NEVER;
      }
      return value;
    })
    .pipe(decimalStringSchema({ maxIntegerDigits, maxFractionDigits, positive }));

/**
 * A date written DD.MM.YYYY within the plausibility window (2000-01-01 up to `now` + 2 days, see
 * sheet-values.ts): a typo'd future date must not become the permanent "latest" delivery.
 */
const sheetDate = (now: Date) =>
  z.unknown().transform((raw, ctx): Date => {
    const value = parseSheetDate(raw);
    if (value === null) {
      ctx.addIssue({ code: 'custom', message: 'Expected a date written DD.MM.YYYY' });
      return z.NEVER;
    }
    if (!isPlausibleDeliveryDate(value, now)) {
      ctx.addIssue({ code: 'custom', message: 'Date is outside the plausible delivery window' });
      return z.NEVER;
    }
    return value;
  });

const productCode = z.unknown().transform((raw, ctx): string => {
  const parsed = productCodeSchema.safeParse(typeof raw === 'string' ? raw : '');
  if (!parsed.success) {
    ctx.addIssue({ code: 'custom', message: 'Not a valid product code' });
    return z.NEVER;
  }
  // IO- is the shape of the codes the system makes for staff-added products [C, 2026-11-09]: a
  // sheet row with such a «Товар_ID» is a reported row error, never a product.
  if (hasGeneratedProductCodePrefix(parsed.data)) {
    ctx.addIssue({ code: 'custom', message: 'Product code prefix IO- is reserved' });
    return z.NEVER;
  }
  return parsed.data;
});

/**
 * A cost cell that may be EMPTY (null); a non-empty cell must be a valid decimal like `decimal`.
 * See COST_HEADERS: emptiness is only allowed for all three cost cells together.
 */
const costDecimal = (maxIntegerDigits: number, maxFractionDigits: number, positive = false) =>
  z.unknown().transform((raw, ctx): string | null => {
    if (normalizeSheetText(raw) === null) return null;
    const value = parseSheetNumber(raw);
    if (value === null) {
      ctx.addIssue({ code: 'custom', message: 'Not a valid non-negative number' });
      return z.NEVER;
    }
    const checked = decimalStringSchema({
      maxIntegerDigits,
      maxFractionDigits,
      positive,
    }).safeParse(value);
    if (!checked.success) {
      for (const issue of checked.error.issues)
        ctx.addIssue({ code: 'custom', message: issue.message });
      return z.NEVER;
    }
    return checked.data;
  });

/**
 * The three cost cells of a line. Seen in the real sheet (2026-11-06): a fresh delivery is written
 * with its quantities first, and the purchase price, the rate and the UZS cost are typed later.
 * Such a row is NOT rejected: all three empty means "cost pending", the line is stored with null
 * costs so its stock counts at once, and the next sync after the cells are typed fills them in.
 * One or two empty cells are still a broken row.
 */
const COST_HEADERS = [
  SHEET_COLUMNS.costUsd,
  SHEET_COLUMNS.usdRateUsed,
  SHEET_COLUMNS.costUzs,
] as const;
export const COST_CELLS_MESSAGE = 'Cost cells must be all filled or all empty';

/** The row schema for a given "now" (from the Clock; the date window depends on it). */
export const createCostSourceRowSchema = (now: Date) =>
  z
    .strictObject({
      [SHEET_COLUMNS.deliveredAt]: sheetDate(now),
      [SHEET_COLUMNS.deliveryRef]: text(100),
      [SHEET_COLUMNS.supplier]: text(200),
      [SHEET_COLUMNS.purchaseMethod]: text(100),
      [SHEET_COLUMNS.category]: text(200),
      [SHEET_COLUMNS.productCode]: productCode,
      [SHEET_COLUMNS.productName]: text(PRODUCT_NAME_MAX_LENGTH, true),
      [SHEET_COLUMNS.deliveredQuantity]: decimal(15, 3),
      [SHEET_COLUMNS.costUsd]: costDecimal(14, 4),
      [SHEET_COLUMNS.usdRateUsed]: costDecimal(14, 4, true),
      [SHEET_COLUMNS.costUzs]: costDecimal(16, 2),
      [SHEET_COLUMNS.availableQuantity]: decimal(15, 3),
    })
    .superRefine((row, ctx) => {
      const empty = COST_HEADERS.filter((header) => row[header] === null);
      if (empty.length === 0 || empty.length === COST_HEADERS.length) return;
      for (const header of empty) {
        ctx.addIssue({ code: 'custom', path: [header], message: COST_CELLS_MESSAGE });
      }
    })
    .transform((row) => ({
      deliveredAt: row[SHEET_COLUMNS.deliveredAt],
      deliveryRef: row[SHEET_COLUMNS.deliveryRef],
      supplier: row[SHEET_COLUMNS.supplier],
      purchaseMethod: row[SHEET_COLUMNS.purchaseMethod],
      category: row[SHEET_COLUMNS.category],
      productCode: row[SHEET_COLUMNS.productCode],
      productName: row[SHEET_COLUMNS.productName],
      deliveredQuantity: row[SHEET_COLUMNS.deliveredQuantity],
      costUsd: row[SHEET_COLUMNS.costUsd],
      usdRateUsed: row[SHEET_COLUMNS.usdRateUsed],
      costUzs: row[SHEET_COLUMNS.costUzs],
      availableQuantity: row[SHEET_COLUMNS.availableQuantity],
    }));

export type CostSourceRow = z.output<ReturnType<typeof createCostSourceRowSchema>>;
