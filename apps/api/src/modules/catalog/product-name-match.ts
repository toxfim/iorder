/**
 * Product names compared "by meaning" [P, design 2026-11-09]: the staff form's "is there such a
 * product already?" check and the "Sheetda bor" pairing of a staff-added product with the sheet
 * product of the same goods. One pure helper, so both read a name the same way.
 */

/** Lower-case, outer spaces removed, inner whitespace collapsed to one space. */
export function collapseProductName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/gu, ' ');
}

/**
 * Letters and digits only (any script), lower-case: `Buds3 Pro`, `Buds 3 Pro` and `Buds-3 Pro`
 * are one key. Empty for a name made of punctuation alone.
 */
export function compactProductName(name: string): string {
  return (name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join('');
}

/** How close a candidate's name is to the typed one; lower is closer. */
export const SIMILARITY_TIERS = {
  /** The same name ignoring case and spacing. */
  EXACT: 0,
  /** The same letters and digits (`Buds3 Pro` ≈ `Buds 3 Pro`). */
  COMPACT: 1,
  /** One name contains the whole other one. */
  CONTAINS: 2,
} as const;
export type SimilarityTier = (typeof SIMILARITY_TIERS)[keyof typeof SIMILARITY_TIERS];

/** The tier of `candidateName` against `typedName`; null when they are not alike. */
export function similarityTier(typedName: string, candidateName: string): SimilarityTier | null {
  const typed = collapseProductName(typedName);
  const candidate = collapseProductName(candidateName);
  if (typed === '' || candidate === '') return null;
  if (typed === candidate) return SIMILARITY_TIERS.EXACT;
  const typedCompact = compactProductName(typedName);
  if (typedCompact !== '' && typedCompact === compactProductName(candidateName)) {
    return SIMILARITY_TIERS.COMPACT;
  }
  if (typed.includes(candidate) || candidate.includes(typed)) return SIMILARITY_TIERS.CONTAINS;
  return null;
}

export const SIMILAR_PRODUCTS_LIMIT = 5;

/**
 * The candidates alike to the typed name, closest tier first; inside a tier by name, then code;
 * at most `limit`. Candidates that are not alike are dropped (the caller's query may be looser).
 */
export function rankSimilarProducts<C extends { name: string; productCode: string }>(
  typedName: string,
  candidates: readonly C[],
  limit: number = SIMILAR_PRODUCTS_LIMIT,
): C[] {
  const ranked: { candidate: C; tier: SimilarityTier }[] = [];
  for (const candidate of candidates) {
    const tier = similarityTier(typedName, candidate.name);
    if (tier !== null) ranked.push({ candidate, tier });
  }
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      compareText(a.candidate.name, b.candidate.name) ||
      compareText(a.candidate.productCode, b.candidate.productCode),
  );
  return ranked.slice(0, limit).map((entry) => entry.candidate);
}

/**
 * For each generated-code product, the sheet product with the same compact name (the EXACT and
 * COMPACT tiers above), else none. When several sheet products share the name, the smallest
 * product code wins, so the answer never flips between two reads.
 */
export function pairSheetMatches<
  G extends { id: string; name: string },
  S extends { name: string; productCode: string },
>(generated: readonly G[], sheetProducts: readonly S[]): Map<string, S> {
  const byKey = new Map<string, S>();
  for (const sheet of sheetProducts) {
    const key = compactProductName(sheet.name);
    if (key === '') continue;
    const current = byKey.get(key);
    if (current === undefined || compareText(sheet.productCode, current.productCode) < 0) {
      byKey.set(key, sheet);
    }
  }
  const pairs = new Map<string, S>();
  for (const product of generated) {
    const match = byKey.get(compactProductName(product.name));
    if (match !== undefined) pairs.set(product.id, match);
  }
  return pairs;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}
