import { commonProductName, type Locale } from '@iorder/shared';

export interface LocalizedName {
  readonly lang: Locale;
  readonly name: string;
}

/**
 * The product's one common name, the same in every UI language (owner, 2026-10-28): the shared
 * rule picks UZ, then RU, then EN. The api guarantees at least one name.
 */
export function pickName(names: readonly LocalizedName[]): string {
  return commonProductName(names, '');
}
