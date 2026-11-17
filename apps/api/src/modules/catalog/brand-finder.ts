/**
 * The "brand finder" ([C] 2026-10-28): which known brand a product name mentions. A brand
 * matches when its words appear in the name as whole words, in the same order, ignoring case
 * ("Наушники REDMI Buds 8" -> Redmi). Words are runs of letters and digits in any script, so
 * Cyrillic text around a Latin brand is no problem and "Mi" never matches inside "Mijia".
 * When several brands match, the one that starts earliest wins; at the same start the longer
 * brand wins ("Black Shark" over a brand "Black").
 */
export function findBrand<B extends { name: string }>(
  productName: string,
  brands: readonly B[],
): B | null {
  const words = wordsOf(productName);
  let best: { brand: B; start: number; length: number } | null = null;
  for (const brand of brands) {
    const brandWords = wordsOf(brand.name);
    if (brandWords.length === 0) continue;
    const start = indexOfSequence(words, brandWords);
    if (start < 0) continue;
    const length = brandWords.join(' ').length;
    if (best === null || start < best.start || (start === best.start && length > best.length)) {
      best = { brand, start, length };
    }
  }
  return best?.brand ?? null;
}

const WORD = /[\p{L}\p{N}]+/gu;

function wordsOf(text: string): string[] {
  return (text.match(WORD) ?? []).map((word) => word.toLowerCase());
}

/** Position (in words) of the first occurrence of `needle` in `haystack`, or -1. */
function indexOfSequence(haystack: readonly string[], needle: readonly string[]): number {
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((word, offset) => haystack[i + offset] === word)) return i;
  }
  return -1;
}
