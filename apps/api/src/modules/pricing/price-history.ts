import type { Prisma } from '../../generated/prisma/client.js';
import type { PriceHistoryEntry, VersionView } from './pricing.types.js';

export interface PriceAtVersion {
  basePrice: Prisma.Decimal;
  deferredPrice: Prisma.Decimal | null;
  rrp: Prisma.Decimal | null;
  currency: string;
}

/**
 * A product's price history, derived from published/archived versions (no extra table,
 * data-model §6.1). One entry per version in which a price (sale, deferred or RRP) CHANGED,
 * appeared or was removed, with the old prices (previous published version) and the new ones. Versions must be the
 * non-draft ones; they are ordered here by publication time.
 */
export function computePriceHistory(
  versions: readonly VersionView[],
  priceByVersionId: ReadonlyMap<string, PriceAtVersion>,
): PriceHistoryEntry[] {
  const ordered = versions
    .filter(
      (v): v is VersionView & { publishedAt: Date; publishedBy: string } =>
        v.publishedAt !== null && v.publishedBy !== null,
    )
    .sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime() || a.number - b.number);

  const entries: PriceHistoryEntry[] = [];
  let previous: PriceAtVersion | null = null;
  for (const version of ordered) {
    const current = priceByVersionId.get(version.id) ?? null;
    const unchanged =
      current === previous ||
      (current !== null &&
        previous !== null &&
        current.basePrice.equals(previous.basePrice) &&
        sameOptionalPrice(current.deferredPrice, previous.deferredPrice) &&
        sameOptionalPrice(current.rrp, previous.rrp) &&
        current.currency === previous.currency);
    if (!unchanged) {
      entries.push({
        versionId: version.id,
        versionNumber: version.number,
        publishedAt: version.publishedAt,
        publishedBy: version.publishedBy,
        source: version.source,
        oldPrice: previous?.basePrice ?? null,
        newPrice: current?.basePrice ?? null,
        oldDeferredPrice: previous?.deferredPrice ?? null,
        newDeferredPrice: current?.deferredPrice ?? null,
        oldRrp: previous?.rrp ?? null,
        newRrp: current?.rrp ?? null,
        oldCurrency: (previous ?? current)?.currency ?? 'UZS',
        currency: (current ?? previous)?.currency ?? 'UZS',
      });
    }
    previous = current;
  }
  return entries;
}

/** Two optional prices are the same when both are absent or both equal. */
export function sameOptionalPrice(a: Prisma.Decimal | null, b: Prisma.Decimal | null): boolean {
  return a === null || b === null ? a === b : a.equals(b);
}
