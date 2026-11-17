import { InputValidationError } from '../../common/errors/domain-errors.js';

// Cursor of the staff unpriced / stock lists: base64url of the last product code of the previous
// page. The product code is unique (and the lists are ordered by it), so it is a stable sort key
// and no tiebreaker is needed. Opaque to clients; anything that does not round-trip is rejected.

export function encodeStaffListCursor(productCode: string): string {
  return Buffer.from(productCode, 'utf8').toString('base64url');
}

export function decodeStaffListCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  // Round trip: rejects stray characters, non-canonical padding and invalid UTF-8 (U+FFFD).
  if (decoded === '' || encodeStaffListCursor(decoded) !== cursor) {
    throw new InputValidationError([{ path: 'cursor', message: 'Invalid cursor' }]);
  }
  return decoded;
}

/** The same order on every machine (UTF-16 code units), unlike localeCompare. */
export function compareProductCodes(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

/**
 * One page of `entries` after `cursor`, in product code order. A cursor whose product has since
 * disappeared still works (the next greater code is used), so a concurrent insert or a product
 * that became priced never causes a gap or a repeat.
 */
export function pageByProductCode<T>(
  entries: readonly T[],
  codeOf: (entry: T) => string,
  limit: number,
  cursor: string | undefined,
): Page<T> {
  const after = cursor === undefined ? undefined : decodeStaffListCursor(cursor);
  const sorted = [...entries].sort((a, b) => compareProductCodes(codeOf(a), codeOf(b)));
  const rest =
    after === undefined ? sorted : sorted.filter((e) => compareProductCodes(codeOf(e), after) > 0);
  const items = rest.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rest.length > limit && last ? encodeStaffListCursor(codeOf(last)) : null,
    total: sorted.length,
  };
}
