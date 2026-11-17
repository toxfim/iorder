import {
  ORDER_STATUSES,
  type CustomerOrderSummary,
  type CustomerTimelineEvent,
  type OrderStatus,
  type OrganizationRole,
  type PaymentStatus,
} from '@iorder/shared';
import type { BadgeTone } from '@core/components/ui/AppBadge.vue';

// How an order looks to a customer. Display only: which moves are allowed is decided by the
// server on every request (hard rule 2), and every behaviour (the receive button, the cancel hint,
// the payment badge) keeps reading the real status the api sends.

/**
 * The three states a customer sees (owner rule 2026-11-09). The steps inside the company between
 * placing an order and its delivery are not the customer's business, so they share one state.
 */
export const CUSTOMER_ORDER_STATES = ['ACCEPTED', 'DELIVERED', 'REFUSED'] as const;
export type CustomerOrderState = (typeof CUSTOMER_ORDER_STATES)[number];

const STATE_OF_STATUS: Readonly<Record<OrderStatus, CustomerOrderState>> = {
  SUBMITTED: 'ACCEPTED',
  MANAGER_APPROVED: 'ACCEPTED',
  ACCOUNTING_CLEARED: 'ACCEPTED',
  RELEASED: 'ACCEPTED',
  DELIVERED: 'DELIVERED',
  RECEIVED: 'DELIVERED',
  REJECTED: 'REFUSED',
  CANCELLED: 'REFUSED',
};

export const customerOrderState = (status: OrderStatus): CustomerOrderState =>
  STATE_OF_STATUS[status];

/** The statuses behind a state: what the list asks the server for when filtering by that state. */
export const statusesOfState = (state: CustomerOrderState): readonly OrderStatus[] =>
  ORDER_STATUSES.filter((status) => STATE_OF_STATUS[status] === state);

/**
 * Amber, green, red. "Accepted" is not the accent tone: the customer accent is an orange-red that
 * sits too close to the refusal red. The label always carries the meaning, never the colour alone.
 */
export const STATE_TONE: Readonly<Record<CustomerOrderState, BadgeTone>> = {
  ACCEPTED: 'warning',
  DELIVERED: 'success',
  REFUSED: 'danger',
};

export const stateTone = (status: OrderStatus): BadgeTone => STATE_TONE[customerOrderState(status)];

/** Message key of the state label of a state (the list filter) and of an order's status. */
export const stateKey = (state: CustomerOrderState): string => `customer.orderState.${state}`;
export const stateLabelKey = (status: OrderStatus): string => stateKey(customerOrderState(status));

/**
 * One sentence under the state: what happens next, or what the customer should do. A delivered
 * order says whether the receipt still has to be confirmed; that is the only place where two
 * statuses of one state read differently.
 */
export function stateHintKey(status: OrderStatus): string {
  if (status === 'DELIVERED') return 'customer.orderState.hint.AWAITING_RECEIPT';
  if (status === 'RECEIVED') return 'customer.orderState.hint.RECEIPT_CONFIRMED';
  return `customer.orderState.hint.${customerOrderState(status)}`;
}

/** The short form of the same for a list card; null where the state label says it all. */
export function stateNoteKey(status: OrderStatus): string | null {
  if (status === 'DELIVERED') return 'customer.orderState.note.AWAITING_RECEIPT';
  if (status === 'RECEIVED') return 'customer.orderState.note.RECEIPT_CONFIRMED';
  return null;
}

export const PAYMENT_TONE: Readonly<Record<PaymentStatus, BadgeTone>> = {
  UNPAID: 'neutral',
  PAID: 'success',
};

/**
 * The payment badge is shown only where it means something to the customer (F-09, [P]): after the
 * goods were delivered, or earlier only as good news (PAID). Never on an order that was rejected or
 * cancelled, and never "unpaid" on an order that is still on its way.
 */
export function showsPaymentBadge(
  order: Pick<CustomerOrderSummary, 'status' | 'paymentStatus'>,
): boolean {
  if (order.status === 'REJECTED' || order.status === 'CANCELLED') return false;
  if (order.status === 'DELIVERED' || order.status === 'RECEIVED') return true;
  return order.paymentStatus === 'PAID';
}

/**
 * Customers cannot cancel (owner rule 2026-10-22, only the manager does). While the manager still
 * can cancel (before release), the order page says to contact the manager. This is narrower than
 * the "accepted" state on purpose: a released order can no longer be cancelled.
 */
export const canOfferCancelHint = (order: Pick<CustomerOrderSummary, 'status'>): boolean =>
  order.status === 'SUBMITTED' ||
  order.status === 'MANAGER_APPROVED' ||
  order.status === 'ACCOUNTING_CLEARED';

/**
 * "Qabul qildim" is offered for a delivered order to the shop owner (any order of the
 * organization) and to a seller only for an order they placed. The server re-checks both.
 */
export function canOfferReceive(
  order: Pick<CustomerOrderSummary, 'status' | 'placedByMe'>,
  role: OrganizationRole | null,
): boolean {
  if (order.status !== 'DELIVERED' || role === null) return false;
  return role === 'SHOP_OWNER' || order.placedByMe;
}

// ------------------------------------------------------------------------------------ history

/** What a row of the order history says. */
export const HISTORY_KINDS = [
  'ACCEPTED',
  'ITEMS_CHANGED',
  'PLAN_CHANGED',
  'DELIVERED',
  'RECEIPT_CONFIRMED',
  'REFUSED',
] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

export interface HistoryEntry {
  readonly id: string;
  readonly kind: HistoryKind;
  readonly occurredAt: string;
  /** Null only for the "accepted" row of an order whose submit event was not sent. */
  readonly event: CustomerTimelineEvent | null;
}

function historyKind(event: CustomerTimelineEvent): HistoryKind | null {
  switch (event.type) {
    case 'SUBMITTED':
      return 'ACCEPTED';
    case 'ITEMS_EDITED':
      return 'ITEMS_CHANGED';
    case 'PAYMENT_PLAN_CHANGED':
      return 'PLAN_CHANGED';
    case 'STATUS_CHANGED':
      if (event.toStatus === 'DELIVERED') return 'DELIVERED';
      if (event.toStatus === 'RECEIVED') return 'RECEIPT_CONFIRMED';
      if (event.toStatus === 'REJECTED' || event.toStatus === 'CANCELLED') return 'REFUSED';
      // Approvals and the release are steps inside the company.
      return null;
    case 'PAYMENT_STATUS_CHANGED':
      // Derived from the organization's payments; the payment badge already shows it.
      return null;
  }
}

/**
 * The history a customer reads, oldest first: the order was accepted, what was changed in it (lines
 * and the payment plan move the amount to pay), it was delivered, the receipt was confirmed, or it
 * was refused. The api sends every event the customer may see; the internal steps are left out
 * here because the three states have no word for them.
 */
export function customerHistory(
  events: readonly CustomerTimelineEvent[],
  orderedAt: string,
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const event of events) {
    const kind = historyKind(event);
    if (kind !== null) entries.push({ id: event.id, kind, occurredAt: event.occurredAt, event });
  }
  if (!entries.some((entry) => entry.kind === 'ACCEPTED')) {
    entries.push({ id: 'accepted', kind: 'ACCEPTED', occurredAt: orderedAt, event: null });
  }
  // A stable sort keeps the server's order for events of the same instant, with "accepted" first.
  return entries.sort(
    (a, b) =>
      a.occurredAt.localeCompare(b.occurredAt) ||
      Number(b.kind === 'ACCEPTED') - Number(a.kind === 'ACCEPTED'),
  );
}
