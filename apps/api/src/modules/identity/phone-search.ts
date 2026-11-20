/**
 * The digits of a search text that looks like a phone number (spaces, brackets, dashes and a
 * leading + ignored), or null: fewer than three digits, or any other character, is not a phone
 * search (so "90" alone, or a name, never matches every phone).
 */
export function phoneSearchDigits(search: string): string | null {
  const digits = search.replace(/[\s()+-]/g, '');
  return /^\d{3,}$/.test(digits) ? digits : null;
}
