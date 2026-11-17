// Deterministic uuids for the in-memory fake: the real contract wants uuid ids, the sample data
// has readable ones ('IO-10491', 's-06'). The same source text always gives the same uuid, so
// links and tests can name an order by its number.

function hash32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function fakeUuid(source: string): string {
  const hex = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35]
    .map((seed) => hash32(source, seed).toString(16).padStart(8, '0'))
    .join('');
  // Version 4, variant 8: accepted by the contract's z.uuid().
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The id the fake gives to the order with this display number. */
export const fakeOrderId = (orderNumber: string): string => fakeUuid(`order:${orderNumber}`);
