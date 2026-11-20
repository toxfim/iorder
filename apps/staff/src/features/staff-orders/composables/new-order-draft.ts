import { ref, shallowRef, watch } from 'vue';
import type { PaymentPlan } from '@iorder/shared';
import type { NewOrderCustomer, NewOrderCustomerMember } from '@iorder/shared/staff-orders';
import { newOrderKey, type NewOrderLine } from '../domain/new-order';

// The manager's new order while it is being put together: step 1 (the dialog over the orders list)
// and steps 2-4 (the new order page) share it, so "O'zgartirish" can go back to the customer and
// keep the cart, as the design asks. Kept in memory only: a reload starts over, nothing is sent
// before «Buyurtmani yaratish». One draft at a time; it belongs to the person signed in and is
// emptied with the other per-person data when the session changes (the orders store's reset).

const customer = shallowRef<NewOrderCustomer | null>(null);
const member = shallowRef<NewOrderCustomerMember | null>(null);
const lines = shallowRef<readonly NewOrderLine[]>([]);
// Nothing is preselected [C, 2026-11-09 for the cart; the design's step 3].
const plan = ref<PaymentPlan | null>(null);
const comment = ref('');
/** Why the manager was sent back to step 1 (the server refused the customer); shown there. */
const notice = ref<string | null>(null);

/**
 * One key per CONTENT of the order: a retry of the unchanged draft after a lost answer gets the
 * order the server already created, but any change (customer, member, lines, plan, comment) is a
 * different order and gets a new key, so the server never answers it with the earlier one.
 */
const idempotencyKey = ref(newOrderKey());
const contentOf = (): string =>
  JSON.stringify([
    customer.value?.organizationId ?? null,
    member.value?.userId ?? null,
    lines.value,
    plan.value,
    comment.value.trim(),
  ]);
let content = contentOf();
watch(
  [customer, member, lines, plan, comment],
  () => {
    const next = contentOf();
    if (next === content) return;
    content = next;
    idempotencyKey.value = newOrderKey();
  },
  { flush: 'sync' },
);

export interface NewOrderDraft {
  readonly customer: typeof customer;
  readonly member: typeof member;
  readonly lines: typeof lines;
  readonly plan: typeof plan;
  readonly comment: typeof comment;
  readonly notice: typeof notice;
  readonly idempotencyKey: typeof idempotencyKey;
  /** The customer and the member the order is placed by. */
  choose: (next: NewOrderCustomer, by: NewOrderCustomerMember) => void;
  /** Cancel, the order was created, or the session changed: everything starts over. */
  reset: () => void;
}

function reset(): void {
  customer.value = null;
  member.value = null;
  lines.value = [];
  plan.value = null;
  comment.value = '';
  notice.value = null;
  idempotencyKey.value = newOrderKey();
}

/** For the per-person reset of a session change (the orders store calls it). */
export const resetNewOrderDraft = reset;

export function useNewOrderDraft(): NewOrderDraft {
  return {
    customer,
    member,
    lines,
    plan,
    comment,
    notice,
    idempotencyKey,
    choose(next, by) {
      customer.value = next;
      member.value = by;
      notice.value = null;
    },
    reset,
  };
}
