import { computed, shallowRef, type Ref } from 'vue';
import type { EditOrderItemsRequest } from '@iorder/shared/staff-orders';
import {
  stageQuantity,
  summarizeDraft,
  type DraftItem,
  type ItemDraft,
  type ItemDraftSummary,
} from '../domain/item-draft';

/**
 * The manager's unsaved quantity edits for one order page. Nothing reaches the server until
 * `changes()` is saved: one save is one history event and one customer notification.
 */
export function useItemDraft(items: Readonly<Ref<readonly DraftItem[]>>) {
  const draft = shallowRef<ItemDraft>(new Map());
  const summary = computed<ItemDraftSummary>(() => summarizeDraft(items.value, draft.value));
  const dirty = computed(() => summary.value.changes.length > 0);

  function setQuantity(itemId: string, quantity: string | null): void {
    draft.value = stageQuantity(draft.value, items.value, itemId, quantity);
  }

  function discard(): void {
    draft.value = new Map();
  }

  /** Only the lines that really differ from the saved order. */
  function changes(): EditOrderItemsRequest['changes'] {
    return summary.value.changes.map((c) => ({ itemId: c.itemId, quantity: c.to }));
  }

  return { draft, summary, dirty, setQuantity, discard, changes };
}
