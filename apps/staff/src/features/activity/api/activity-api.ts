// UI-ONLY. The recent-actions feed of the home page ("So'nggi harakatlar"); the real source will
// be the audit log (data-model invariant 10). Each entry is a typed event, not a sentence: the
// wording lives in i18n (`activity.<kind>`), filled from `params`.

export const ACTIVITY_KINDS = [
  'ORDER_CREATED',
  'ORDER_APPROVED',
  'ORDER_APPROVED_SKIP_ACCOUNTING',
  'ORDER_REJECTED',
  'ORDER_CANCELLED',
  'ORDER_RELEASED',
  'ORDER_PAID',
  'ORDER_UNPAID',
  'ORDER_ITEMS_EDITED',
  'ORGANIZATION_BLOCKED',
  'ORGANIZATION_ACTIVATED',
  'MEMBER_BLOCKED',
  'MEMBER_ACTIVATED',
  'MEMBER_ROLE_CHANGED',
  'STAFF_CREATED',
  'STAFF_UPDATED',
  'STAFF_BLOCKED',
  'STAFF_ACTIVATED',
  'STAFF_ROLE_GRANTED',
  'STAFF_ROLE_REVOKED',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ActivityEntry {
  readonly id: string;
  /** ISO UTC instant. */
  readonly at: string;
  readonly kind: ActivityKind;
  /** Values for the message: orderId, organization, name, role, reason, driver... */
  readonly params: Readonly<Record<string, string>>;
}

export interface ActivityApi {
  /** Newest first. */
  listRecent: (limit: number) => Promise<readonly ActivityEntry[]>;
}
