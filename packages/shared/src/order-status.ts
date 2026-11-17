// Source: docs/domain/order-lifecycle.md §2. The transition rules themselves live in the api
// (`orders` module), never here: this file only names the states.

export const ORDER_STATUSES = [
  'SUBMITTED',
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
  'RELEASED',
  'DELIVERED',
  'RECEIVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Payment is a separate track and never blocks fulfillment (CLAUDE.md hard rule 11). */
export const PAYMENT_STATUSES = ['UNPAID', 'PAID'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const TERMINAL_ORDER_STATUSES: readonly OrderStatus[] = [
  'RECEIVED',
  'REJECTED',
  'CANCELLED',
];
