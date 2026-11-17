import { BRAND_NAME_MAX_LENGTH, type BrandResponse } from '@iorder/shared/staff-cost';

export interface BrandOptions {
  /** Brands whose name contains the typed text (all of them when nothing is typed). */
  readonly matches: readonly BrandResponse[];
  /** The name a new brand would get, or null when nothing is typed or the brand exists. */
  readonly createName: string | null;
}

/** The server compares brand names ignoring letter case (409 DUPLICATE_BRAND_NAME). */
const key = (name: string): string => name.trim().toLocaleLowerCase();

export function findBrandByName(
  brands: readonly BrandResponse[],
  name: string,
): BrandResponse | null {
  const wanted = key(name);
  return brands.find((brand) => key(brand.name) === wanted) ?? null;
}

/**
 * The options of one brand picker for the typed text: names starting with it first, then the
 * ones that contain it, each group in the list's own (alphabetical) order. "Create" is offered
 * only for a text that names no existing brand and fits the contract's length.
 */
export function brandOptions(brands: readonly BrandResponse[], query: string): BrandOptions {
  const typed = query.trim();
  if (typed === '') return { matches: brands, createName: null };
  const wanted = key(typed);
  const starts = brands.filter((brand) => key(brand.name).startsWith(wanted));
  const contains = brands.filter(
    (brand) => !key(brand.name).startsWith(wanted) && key(brand.name).includes(wanted),
  );
  const exists = findBrandByName(brands, typed) !== null;
  return {
    matches: [...starts, ...contains],
    createName: exists || typed.length > BRAND_NAME_MAX_LENGTH ? null : typed,
  };
}

/** Adds a brand (created now or found after a 409) and keeps the list sorted by name. */
export function withBrand(
  brands: readonly BrandResponse[],
  brand: BrandResponse,
): readonly BrandResponse[] {
  if (brands.some((b) => b.id === brand.id)) return brands;
  return [...brands, brand].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  );
}
