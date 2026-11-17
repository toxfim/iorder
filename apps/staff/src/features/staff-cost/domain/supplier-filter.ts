// The «Поставщик» filter of Qoldiq and Narxlar (owner request 2026-11-13). A product passes when
// at least one of its LIVE delivery lines is from the chosen supplier, so a product bought from
// two suppliers is found under both. Supplier is cost-class data: this stays in the staff-cost
// chunk and the options come only from staff-only answers.

export const SUPPLIER_ALL = 'all';

export interface SupplierOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
}

export function matchesSupplier(suppliers: readonly string[], selected: string): boolean {
  return selected === SUPPLIER_ALL || suppliers.includes(selected);
}

/** Code unit order, the same on every device (as the api sorts each product's list). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every supplier of the given products with how many of them it keeps, by name. */
export function supplierOptions(lists: readonly (readonly string[])[]): SupplierOption[] {
  const counts = new Map<string, number>();
  for (const suppliers of lists) {
    for (const supplier of new Set(suppliers)) {
      counts.set(supplier, (counts.get(supplier) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([supplier, count]) => ({ value: supplier, label: supplier, count }));
}
