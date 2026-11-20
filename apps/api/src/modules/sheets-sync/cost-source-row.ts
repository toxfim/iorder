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
    // Only a missing or blank cell is empty: anything else that is not a sheet string (a JSON
    // number, say) is a broken cell and must reject the row, not pass as "cost pending".
    const blank = raw === null || raw === undefined || typeof raw === 'string';
    if (blank && normalizeSheetText(raw) === null) return null;
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
 * Owner 2026-11-17: an empty rate ALONE is fine too (OMEGA Electronics lines carry USD and so'm costs
 * but no rate): the line is stored without a rate and staff see its so'm cost.
 * Owner 2026-11-18 ("even without the purchase amounts it must count for stock"): any OTHER partly
 * empty set no longer rejects the row either. Its stock counts and its costs are stored as "cost
 * pending" (all three null): the DB keeps USD and so'm together, and half a cost is never guessed
 * into a whole one. The row is flagged `costIncomplete`, so the sync report lists it for the sheet
 * to be fixed; once the cells are typed, the next sync fills the costs in. A cost cell that is
 * written but is not a valid number still rejects the row: that is a typo, not a missing price.
 */
type CostCells = Record<
  typeof SHEET_COLUMNS.costUsd | typeof SHEET_COLUMNS.usdRateUsed | typeof SHEET_COLUMNS.costUzs,
  string | null
>;

/** The cost cells as stored: as written when USD and so'm are both there, else all null. */
function storedCosts(row: CostCells): {
  costUsd: string | null;
  usdRateUsed: string | null;
  costUzs: string | null;
  costIncomplete: boolean;
} {
  const costUsd = row[SHEET_COLUMNS.costUsd];
  const usdRateUsed = row[SHEET_COLUMNS.usdRateUsed];
  const costUzs = row[SHEET_COLUMNS.costUzs];
  if (costUsd !== null && costUzs !== null) {
    return { costUsd, usdRateUsed, costUzs, costIncomplete: false };
  }
  const allEmpty = costUsd === null && usdRateUsed === null && costUzs === null;
  return { costUsd: null, usdRateUsed: null, costUzs: null, costIncomplete: !allEmpty };
}

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
    .transform((row) => ({
      deliveredAt: row[SHEET_COLUMNS.deliveredAt],
      deliveryRef: row[SHEET_COLUMNS.deliveryRef],
      supplier: row[SHEET_COLUMNS.supplier],
      purchaseMethod: row[SHEET_COLUMNS.purchaseMethod],
      category: row[SHEET_COLUMNS.category],
      productCode: row[SHEET_COLUMNS.productCode],
      productName: row[SHEET_COLUMNS.productName],
      deliveredQuantity: row[SHEET_COLUMNS.deliveredQuantity],
      ...storedCosts(row),
      availableQuantity: row[SHEET_COLUMNS.availableQuantity],
    }));

export type CostSourceRow = z.output<ReturnType<typeof createCostSourceRowSchema>>;
