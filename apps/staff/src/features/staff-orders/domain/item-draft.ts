import { fromCents, sumMoney, toCents } from '@core/lib/money';
import { isSameQuantity, lineTotal, normalizeQuantity } from '@core/lib/quantity';
import type { FullOrderDetail } from './order-model';

export type DraftItem = FullOrderDetail['items'][number];

/**
 * The manager's unsaved item edits: item id -> wanted quantity (`null` removes the line). A
 * quantity equal to the saved one is not a change, so it never appears in the map. The totals shown
 * from a draft are a PREVIEW; the server prices the saved edit and its answer replaces them.
 */
export type ItemDraft = ReadonlyMap<string, string | null>;

export interface ItemDraftChange {
  readonly itemId: string;
  readonly name: string;
  readonly from: string;
  /** `null` means the line is removed. */
  readonly to: string | null;
}

export interface ItemDraftSummary {
  readonly changes: readonly ItemDraftChange[];
  readonly oldTotal: string;
  readonly newTotal: string;
  /** Signed decimal string: `2950000.00` or `-150000.00`. */
  readonly difference: string;
}

/** Returns a new draft with one line set to `quantity` (`null` or a non-positive value removes it). */
export function stageQuantity(
  draft: ItemDraft,
  items: readonly DraftItem[],
  itemId: string,
  quantity: string | null,
): ItemDraft {
  const item = items.find((i) => i.id === itemId);
  if (!item) return draft;
  const next = new Map(draft);
  const wanted = quantity === null ? null : normalizeQuantity(quantity);
  if (wanted !== null && isSameQuantity(wanted, item.quantity)) next.delete(itemId);
  else next.set(itemId, wanted === '0' ? null : wanted);
  return next;
}

/** The quantity to show for a line; `null` when the draft removes it. */
export const effectiveQuantity = (item: DraftItem, draft: ItemDraft): string | null =>
  draft.has(item.id) ? (draft.get(item.id) ?? null) : item.quantity;

/** What the draft would do to the saved lines: the change list and the totals, all in cents. */
export function summarizeDraft(items: readonly DraftItem[], draft: ItemDraft): ItemDraftSummary {
  const changes = items.flatMap((item): ItemDraftChange[] => {
    const to = effectiveQuantity(item, draft);
    return to !== null && isSameQuantity(to, item.quantity)
      ? []
      : [{ itemId: item.id, name: item.name, from: item.quantity, to }];
  });
  const oldTotal = sumMoney(items.map((i) => lineTotal(i.unitPrice, i.quantity)));
  const newTotal = sumMoney(
    items.map((i) => {
      const quantity = effectiveQuantity(i, draft);
      return quantity === null ? '0.00' : lineTotal(i.unitPrice, quantity);
    }),
  );
  return {
    changes,
    oldTotal,
    newTotal,
    difference: fromCents(toCents(newTotal) - toCents(oldTotal)),
  };
}
