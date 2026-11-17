import { normalizeSheetText } from './sheet-values.js';

/**
 * WHICH sheet rows we read [C, 2026-10-20, data-model §6.4]: by the «Поставщик» column, exact
 * full-value match. This is CONFIGURATION, kept in this one constant; every other supplier's rows
 * are skipped, counted in the report and never stored.
 *
 * Matching compares the WHOLE value after trimming and collapsing inner whitespace, ignoring
 * letter case. The real casing in the sheet is UNVERIFIED (the product owner wrote
 * `alpha trade import` and `Beta system tm fbs`), so case is ignored on purpose. A partial match
 * never counts: `alpha trade import 2` is a different supplier.
 */
export interface SupplierRule {
  /** The full supplier value to match (case, spacing as the owner wrote it). */
  readonly supplier: string;
}

// All dates of every supplier: the owner dropped the September limit of `Beta system tm fbs` on
// 2026-11-04. `TV Gamma Import` added by the owner on 2026-11-10; its first rows in the sheet are
// of 2026-11-09, so no date limit is needed. `Delta Import` and `Samsung Trading (North)` added by
// the owner on 2026-11-13, all dates, spelled as in that day's sync report.
export const SUPPLIER_RULES: readonly SupplierRule[] = [
  { supplier: 'alpha trade import' },
  { supplier: 'Beta system tm fbs' },
  { supplier: 'TV Gamma Import' },
  { supplier: 'Delta Import' },
  { supplier: 'Samsung Trading (North)' },
];

const comparisonKey = (value: string): string => value.toLowerCase();

/** The rule that selects this supplier cell, or null when the supplier is not read at all. */
export function findSupplierRule(
  rawSupplier: unknown,
  rules: readonly SupplierRule[] = SUPPLIER_RULES,
): SupplierRule | null {
  const supplier = normalizeSheetText(rawSupplier);
  if (supplier === null) return null;
  const key = comparisonKey(supplier);
  return (
    rules.find((rule) => comparisonKey(normalizeSheetText(rule.supplier) ?? '') === key) ?? null
  );
}
