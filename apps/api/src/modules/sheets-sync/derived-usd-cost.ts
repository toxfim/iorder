import { Prisma } from '../../generated/prisma/client.js';
import { SHEET_COLUMNS, type SheetRecord } from './sheet-columns.js';
import {
  isPlausibleDeliveryDate,
  normalizeSheetText,
  parseSheetDate,
  parseSheetNumber,
} from './sheet-values.js';

/** A rate seen anywhere in the sheet, and the instant of its row. */
export interface SheetRate {
  at: number;
  /** Canonical decimal text, as `parseSheetNumber` returns it. */
  rate: string;
}

/**
 * Every usable rate in the sheet, from ALL rows: a skipped supplier's row lends its rate here and
 * nothing else of it is kept. A typo'd future date must not win "nearest", so the same plausibility
 * window as a stored delivery applies.
 */
export function collectSheetRates(records: readonly SheetRecord[], now: Date): SheetRate[] {
  const rates: SheetRate[] = [];
  for (const record of records) {
    const date = parseSheetDate(record[SHEET_COLUMNS.deliveredAt]);
    const rate = parseSheetNumber(record[SHEET_COLUMNS.usdRateUsed]);
    if (date === null || rate === null || !isPlausibleDeliveryDate(date, now)) continue;
    if (new Prisma.Decimal(rate).lessThanOrEqualTo(0)) continue;
    rates.push({ at: date.getTime(), rate });
  }
  return rates;
}

/**
 * The rate closest in time. The tie-breaks make the result independent of row order, so re-reading
 * the same sheet never looks like a change: the earlier row wins (its rate was already known at the
 * delivery), then the lower rate (one instant can carry different rates in the real sheet).
 */
export function nearestSheetRate(rates: readonly SheetRate[], deliveredAt: Date): string | null {
  const target = deliveredAt.getTime();
  let best: SheetRate | null = null;
  for (const candidate of rates) {
    if (best === null || isCloser(candidate, best, target)) best = candidate;
  }
  return best?.rate ?? null;
}

function isCloser(candidate: SheetRate, best: SheetRate, target: number): boolean {
  const distance = Math.abs(candidate.at - target) - Math.abs(best.at - target);
  if (distance !== 0) return distance < 0;
  if (candidate.at !== best.at) return candidate.at < best.at;
  return new Prisma.Decimal(candidate.rate).lessThan(best.rate);
}

/**
 * Owner decision 2026-11-04: a delivery with a UZS cost but neither a USD cost nor a rate is not
 * rejected; USD = UZS / the nearest rate in the sheet. Any other incomplete row returns unchanged,
 * the same object, and validation decides about it. Real values typed into the sheet later take
 * over by themselves, because the row no longer qualifies.
 */
export function withDerivedUsdCost(record: SheetRecord, rates: readonly SheetRate[]): SheetRecord {
  if (
    normalizeSheetText(record[SHEET_COLUMNS.costUsd]) !== null ||
    normalizeSheetText(record[SHEET_COLUMNS.usdRateUsed]) !== null
  ) {
    return record;
  }
  const costUzs = parseSheetNumber(record[SHEET_COLUMNS.costUzs]);
  const deliveredAt = parseSheetDate(record[SHEET_COLUMNS.deliveredAt]);
  if (costUzs === null || deliveredAt === null || new Prisma.Decimal(costUzs).isZero()) {
    return record;
  }
  const rate = nearestSheetRate(rates, deliveredAt);
  if (rate === null) return record;
  return {
    ...record,
    // Four digits is the scale of cost_usd; the row schema rejects anything longer.
    [SHEET_COLUMNS.costUsd]: new Prisma.Decimal(costUzs)
      .div(rate)
      .toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP)
      .toFixed(4),
    [SHEET_COLUMNS.usdRateUsed]: rate,
  };
}
