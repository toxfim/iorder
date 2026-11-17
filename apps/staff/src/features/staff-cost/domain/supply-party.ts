import {
  SUPPLY_PRODUCT_NAMES_SHOWN,
  supplyNotAvailableDetailsSchema,
  supplyPartyChangedDetailsSchema,
  supplyPartyConflictDetailsSchema,
  type SupplyPartyChangedDetails,
  type SupplyPartyConflictDetails,
  type SupplyPartyState,
  type SupplySummary,
} from '@iorder/shared/staff-cost';
import { pickName } from '@/features/pricing/domain/localized-name';

/** The first product names of a supply, and that there are more: a supply can hold dozens. */
export function productPreview(supply: SupplySummary): string {
  const names = supply.products.slice(0, SUPPLY_PRODUCT_NAMES_SHOWN).map((p) => pickName(p.names));
  const rest = supply.productCount - names.length;
  return rest > 0 ? `${names.join(', ')} +${rest}` : names.join(', ');
}

/** What the conflict dialog has to ask. */
export type ConflictKind = 'SUPPLY' | 'PARTY' | 'BOTH';

export function conflictKindOf(details: SupplyPartyConflictDetails): ConflictKind {
  if (details.supplyConflicts.length > 0) {
    return details.partyMembers.length > 0 ? 'BOTH' : 'SUPPLY';
  }
  return 'PARTY';
}

/** The chosen rows with the parties the server just told about. */
export function withCurrentParties(
  selected: readonly SupplySummary[],
  parties: readonly SupplyPartyState[],
): readonly SupplySummary[] {
  const current = new Map(parties.map((row) => [row.deliveryRef, row.partyNumber]));
  return selected.map((supply) => {
    const party = current.get(supply.deliveryRef);
    return party === undefined ? supply : { ...supply, partyNumber: party };
  });
}

export function conflictDetailsOf(details: unknown): SupplyPartyConflictDetails | null {
  const parsed = supplyPartyConflictDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : null;
}

export function changedDetailsOf(details: unknown): SupplyPartyChangedDetails | null {
  const parsed = supplyPartyChangedDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data : null;
}

export function notAvailableRefsOf(details: unknown): readonly string[] | null {
  const parsed = supplyNotAvailableDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data.deliveryRefs : null;
}
