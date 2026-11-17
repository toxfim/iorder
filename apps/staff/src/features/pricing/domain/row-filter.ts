import type { LocalizedName } from './localized-name';

export interface SearchableRow {
  readonly productCode: string;
  readonly names: readonly LocalizedName[];
}

/**
 * "Product ID or product name" search (design placeholder). Names are matched in every language: a
 * manager typing a Russian word still finds the product while the UI is in Uzbek.
 */
export function filterRows<T extends SearchableRow>(rows: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...rows];
  return rows.filter(
    (row) =>
      row.productCode.toLowerCase().includes(needle) ||
      row.names.some((entry) => entry.name.toLowerCase().includes(needle)),
  );
}
