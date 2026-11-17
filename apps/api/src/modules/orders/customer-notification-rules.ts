import type { OrderStatus } from '@iorder/shared';

// Source: docs/domain/order-lifecycle.md §6.3 ([C] owner 2026-11-09). PURE.
//
// THE one place that says which order events send a bot message to the CUSTOMER SIDE. The owner's
// rule: the customer side hears from the bot only when the manager approves the order, when the
// order is refused (rejected by the manager or the accountant, cancelled by the manager), and when
// the manager changes what the order costs (its lines or its payment plan). Every other event is
// silent for the customer side: it stays in the order timeline and in the staff messages.
//
// This replaces the list of statuses echoed to the customer chat (2026-10-29) and the earlier idea
// of "three customer states" for bot messages. Staff messages are NOT decided here: they live in
// the transition table (order-state-machine.ts) and are unchanged.
//
// Order events that write no outbox row at all are not listed: the payment method, the derived
// payment status and organization payments, warehouse scans, stock holds, returned goods.

/**
 * `CUSTOMER`: the organization's Telegram group. `PLACER`: the private chat of the person who
 * placed the order (it exists so a cancellation reason reaches that person as written, [C]
 * 2026-10-22; in the group the same person is mentioned).
 */
export type CustomerSideTarget = 'CUSTOMER' | 'PLACER';

const SILENT: readonly CustomerSideTarget[] = Object.freeze([]);
const GROUP: readonly CustomerSideTarget[] = Object.freeze(['CUSTOMER']);
const GROUP_AND_PLACER: readonly CustomerSideTarget[] = Object.freeze(['CUSTOMER', 'PLACER']);

export const CUSTOMER_SIDE_NOTIFICATIONS = Object.freeze({
  // The customer's own act: they know.
  ORDER_SUBMITTED: SILENT,

  // Status moves (lifecycle §3), "FROM>TO". A skipped accounting step is two moves in one
  // transaction: the approval speaks, the clearance does not, so the customer gets one message.
  'SUBMITTED>MANAGER_APPROVED': GROUP,
  'SUBMITTED>REJECTED': GROUP,
  'SUBMITTED>CANCELLED': GROUP_AND_PLACER,
  'MANAGER_APPROVED>ACCOUNTING_CLEARED': SILENT,
  'MANAGER_APPROVED>REJECTED': GROUP,
  'MANAGER_APPROVED>CANCELLED': GROUP_AND_PLACER,
  'ACCOUNTING_CLEARED>RELEASED': SILENT,
  'ACCOUNTING_CLEARED>CANCELLED': GROUP_AND_PLACER,
  'RELEASED>DELIVERED': SILENT,
  'DELIVERED>RECEIVED': SILENT,

  // Changes without a status move. Both manager changes move the order's total.
  ITEMS_EDITED_BY_MANAGER: GROUP,
  PAYMENT_PLAN_CHANGED_BY_MANAGER: GROUP,
  // The customer's own act again.
  PAYMENT_PLAN_CHANGED_BY_CUSTOMER: SILENT,
} satisfies Record<string, readonly CustomerSideTarget[]>);

export type OrderOccurrence = keyof typeof CUSTOMER_SIDE_NOTIFICATIONS;

export function customerSideTargets(occurrence: OrderOccurrence): readonly CustomerSideTarget[] {
  return CUSTOMER_SIDE_NOTIFICATIONS[occurrence];
}

function isOccurrence(key: string): key is OrderOccurrence {
  return Object.hasOwn(CUSTOMER_SIDE_NOTIFICATIONS, key);
}

/**
 * The customer-side targets of one status move. A move missing from the table is silent: a
 * forgotten entry must never start messaging customers (a unit test keeps the table complete).
 */
export function customerSideTargetsOfMove(
  from: OrderStatus,
  to: OrderStatus,
): readonly CustomerSideTarget[] {
  const key = `${from}>${to}`;
  return isOccurrence(key) ? CUSTOMER_SIDE_NOTIFICATIONS[key] : SILENT;
}
