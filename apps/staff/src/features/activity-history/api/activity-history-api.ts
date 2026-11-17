import type { OrderStatus, StaffRole } from '@iorder/shared';

// The "Faoliyat tarixi" page: one list over the audit trail (order_events for orders, audit_log
// for everything else; data-model invariant 10). The api does not expose that trail over HTTP
// yet, so this is a UI contract only: the real adapter answers "not available" and only the
// in-memory fake (dev and tests) has rows. Each entry is typed, not a sentence: the wording lives
// in i18n (`activityHistory.*`).

export const HISTORY_OBJECT_TYPES = [
  'ORDER',
  'PRICE_LIST',
  'PAYMENT',
  'STAFF',
  'ORGANIZATION',
] as const;
export type HistoryObjectType = (typeof HISTORY_OBJECT_TYPES)[number];

export const HISTORY_ACTIONS = [
  'ORDER_SUBMITTED',
  'ORDER_APPROVED',
  'ORDER_ACCOUNTING_CLEARED',
  'ORDER_RELEASED',
  'ORDER_DELIVERED',
  'ORDER_CANCELLED',
  'PRICE_LIST_PUBLISHED',
  'PAYMENT_RECORDED',
  'STAFF_BLOCKED',
  'STAFF_ROLE_GRANTED',
  'ORGANIZATION_ACTIVATED',
] as const;
export type HistoryAction = (typeof HISTORY_ACTIONS)[number];

/** Who did it: a staff member (with the role they acted in), a customer, or the system itself. */
export type HistoryActor =
  | { readonly kind: 'STAFF'; readonly name: string; readonly role: StaffRole }
  | { readonly kind: 'CUSTOMER'; readonly name: string; readonly organization: string }
  | { readonly kind: 'SYSTEM' };

/** One side of "before → after", typed so the page can translate and format it. */
export type HistoryValue =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'STATUS'; readonly status: OrderStatus }
  /** UZS, decimal string (hard rule 1: never a float). */
  | { readonly kind: 'MONEY'; readonly amount: string }
  | { readonly kind: 'VERSION'; readonly number: number }
  | { readonly kind: 'ROLE'; readonly role: StaffRole }
  | { readonly kind: 'ACTIVE'; readonly active: boolean };

export interface ActivityHistoryEntry {
  readonly id: string;
  /** ISO UTC instant; shown in Asia/Tashkent. */
  readonly at: string;
  readonly actor: HistoryActor;
  readonly object: {
    readonly type: HistoryObjectType;
    /** What the object is called where it lives (`IO-1048`, a person's name, `v12`). */
    readonly label: string;
    /** Second line: the organization of an order, the login of a person... */
    readonly detail: string | null;
  };
  readonly action: HistoryAction;
  readonly before: HistoryValue;
  readonly after: HistoryValue;
  /** The reason or comment as the person wrote it, if any. */
  readonly note: string | null;
}

/**
 * `available: false` is the honest answer of a build whose api has no history route: the page
 * says so instead of showing an empty list (which would read as "nothing ever happened").
 */
export type ActivityHistoryResult =
  | { readonly available: true; readonly entries: readonly ActivityHistoryEntry[] }
  | { readonly available: false };

export interface ActivityHistoryApi {
  /** Newest first. */
  list: () => Promise<ActivityHistoryResult>;
}

/** The real build: the audit trail is written on the server but not readable over HTTP yet. */
export const unavailableActivityHistoryApi: ActivityHistoryApi = {
  list: () => Promise.resolve({ available: false }),
};
