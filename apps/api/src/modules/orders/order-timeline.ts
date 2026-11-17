import {
  ORDER_ACTOR_ROLES,
  ORGANIZATION_ROLES,
  PAYMENT_PLANS,
  STAFF_ROLES,
  type OrderActorRole,
  type OrderStatus,
  type PaymentPlanChange,
  type PaymentStatus,
  type StaffRole,
} from '@iorder/shared';
import {
  PAYMENT_METHODS,
  type AccountingMode,
  type PaymentMethod,
} from '@iorder/shared/staff-orders';
import { z } from 'zod';
import type {
  NotificationRecipientKind,
  NotificationStatus,
  NotificationType,
  OrderEventType,
} from './order-types.js';
import type { OrderEventRecord, OutboxRecord } from './orders.repository.js';

// The order timeline: every order_events row turned into a view that is safe for ONE audience.
// PURE (no I/O): the service loads events, notifications and names with a fixed number of
// queries and calls `buildTimeline`. Redaction happens HERE, before any DTO exists:
//
//   CUSTOMER    the product's main value, "where is my order": status moves, edits and payment
//               changes, the role of the staff actor (never their name), the reasons as written.
//               No accounting mode, no skip marker, no driver, no outbox data.
//   FULL        manager, accountant, admin: everything, including who was notified.
//   FULFILMENT  warehouse and driver: the moves and the driver, with no prices, no accounting
//               and no payment events.

export type TimelineAudience = 'CUSTOMER' | 'FULL' | 'FULFILMENT';

export interface TimelinePerson {
  userId: string;
  fullName: string;
  phone: string | null;
}

export interface TimelineLineChange {
  productCode: string;
  name: string;
  change: 'QUANTITY_CHANGED' | 'REMOVED';
  oldQuantity: string;
  newQuantity: string | null;
  /** Null for the FULFILMENT audience (no prices). */
  oldLineTotal: string | null;
  newLineTotal: string | null;
}

export interface TimelineItemsChange {
  oldTotal: string | null;
  newTotal: string | null;
  lines: TimelineLineChange[];
}

export interface TimelineNotificationView {
  id: string;
  type: NotificationType;
  recipientKind: NotificationRecipientKind;
  recipientRole: StaffRole | null;
  recipientUserId: string | null;
  recipientName: string | null;
  status: NotificationStatus;
  attempts: number;
  createdAt: Date;
  sentAt: Date | null;
}

export interface TimelineEventView {
  id: string;
  type: OrderEventType;
  occurredAt: Date;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  /** Null: no actor to show (the customer view of an accounting step). */
  actor: { userId: string | null; role: OrderActorRole; name: string | null } | null;
  comment: string | null;
  accountingMode: { from: AccountingMode | null; to: AccountingMode } | null;
  driver: TimelinePerson | null;
  itemsChange: TimelineItemsChange | null;
  paymentChange: { from: PaymentStatus; to: PaymentStatus } | null;
  /** Only when the input allows it (manager, accountant): the approval and PAYMENT_METHOD_CHANGED. */
  paymentMethodChange: { from: PaymentMethod | null; to: PaymentMethod } | null;
  /** PAYMENT_PLAN_CHANGED: never reaches the warehouse or the driver (not in their event list). */
  paymentPlanChange: PaymentPlanChange | null;
  /** A message about this event was SENT to the organization chat or to the placer. */
  customerNotified: boolean;
  notifications: TimelineNotificationView[];
}

export interface TimelineInput {
  audience: TimelineAudience;
  /** VIEW_PAYMENT_METHOD: the admin reads the FULL timeline without the payment method. */
  showsPaymentMethod: boolean;
  order: { placedByUserId: string };
  events: readonly OrderEventRecord[];
  notifications: readonly OutboxRecord[];
  people: ReadonlyMap<string, TimelinePerson>;
  organizationNames: ReadonlyMap<string, string>;
}

// ------------------------------------------------------------------ payload parsing
// Payloads are JSON written by this module; they are still parsed, not trusted. A payload that
// does not have the expected shape only loses its detail, it never fails the whole timeline.

const sideSchema = z.looseObject({}).nullable();
const payloadSchema = z.looseObject({
  before: sideSchema.optional(),
  after: sideSchema.optional(),
});

const lineSchema = z.looseObject({
  productCode: z.string(),
  name: z.string(),
  quantity: z.string(),
  lineTotal: z.string(),
});
const itemsSideSchema = z.looseObject({ totalAmount: z.string(), lines: z.array(lineSchema) });
const paymentSideSchema = z.looseObject({ paymentStatus: z.enum(['UNPAID', 'PAID']) });
const paymentMethodSideSchema = z.looseObject({
  paymentMethod: z.enum(PAYMENT_METHODS).nullable().optional(),
});
const paymentPlanSideSchema = z.looseObject({
  paymentPlan: z.enum(PAYMENT_PLANS),
  totalAmount: z.string(),
});
const accountingSideSchema = z.looseObject({
  accountingMode: z.enum(['PENDING', 'APPROVED', 'SKIPPED_BY_MANAGER']).optional(),
});
const driverSideSchema = z.looseObject({ driverUserId: z.string().nullable().optional() });

function sides(payload: unknown): { before: unknown; after: unknown } {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success
    ? { before: parsed.data.before ?? null, after: parsed.data.after ?? null }
    : { before: null, after: null };
}

function itemsChangeOf(payload: unknown, withMoney: boolean): TimelineItemsChange | null {
  const { before, after } = sides(payload);
  const old = itemsSideSchema.safeParse(before);
  const next = itemsSideSchema.safeParse(after);
  if (!old.success || !next.success) return null;
  const nextByCode = new Map(next.data.lines.map((line) => [line.productCode, line]));
  const lines: TimelineLineChange[] = [];
  for (const line of old.data.lines) {
    const kept = nextByCode.get(line.productCode);
    if (kept !== undefined && kept.quantity === line.quantity) continue;
    lines.push({
      productCode: line.productCode,
      name: line.name,
      change: kept === undefined ? 'REMOVED' : 'QUANTITY_CHANGED',
      oldQuantity: line.quantity,
      newQuantity: kept?.quantity ?? null,
      oldLineTotal: withMoney ? line.lineTotal : null,
      newLineTotal: withMoney ? (kept?.lineTotal ?? null) : null,
    });
  }
  lines.sort((a, b) => a.productCode.localeCompare(b.productCode));
  return {
    oldTotal: withMoney ? old.data.totalAmount : null,
    newTotal: withMoney ? next.data.totalAmount : null,
    lines,
  };
}

function paymentChangeOf(payload: unknown): TimelineEventView['paymentChange'] {
  const { before, after } = sides(payload);
  const from = paymentSideSchema.safeParse(before);
  const to = paymentSideSchema.safeParse(after);
  return from.success && to.success
    ? { from: from.data.paymentStatus, to: to.data.paymentStatus }
    : null;
}

function paymentMethodChangeOf(payload: unknown): TimelineEventView['paymentMethodChange'] {
  const { before, after } = sides(payload);
  const to = paymentMethodSideSchema.safeParse(after);
  if (!to.success || to.data.paymentMethod === undefined || to.data.paymentMethod === null) {
    return null;
  }
  const from = paymentMethodSideSchema.safeParse(before);
  return {
    from: from.success ? (from.data.paymentMethod ?? null) : null,
    to: to.data.paymentMethod,
  };
}

function paymentPlanChangeOf(payload: unknown): PaymentPlanChange | null {
  const { before, after } = sides(payload);
  const from = paymentPlanSideSchema.safeParse(before);
  const to = paymentPlanSideSchema.safeParse(after);
  return from.success && to.success
    ? {
        from: from.data.paymentPlan,
        to: to.data.paymentPlan,
        oldTotal: from.data.totalAmount,
        newTotal: to.data.totalAmount,
      }
    : null;
}

function accountingModeOf(payload: unknown): TimelineEventView['accountingMode'] {
  const { before, after } = sides(payload);
  const to = accountingSideSchema.safeParse(after);
  if (!to.success || to.data.accountingMode === undefined) return null;
  const from = accountingSideSchema.safeParse(before);
  return {
    from: from.success ? (from.data.accountingMode ?? null) : null,
    to: to.data.accountingMode,
  };
}

function assignedDriverIdOf(payload: unknown): string | null {
  const parsed = driverSideSchema.safeParse(sides(payload).after);
  return parsed.success ? (parsed.data.driverUserId ?? null) : null;
}

/** Every user id the timeline will name, so the caller can fetch the names in ONE query. */
export function personIdsOf(
  audience: TimelineAudience,
  events: readonly OrderEventRecord[],
  notifications: readonly OutboxRecord[],
): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    // The warehouse and the driver see roles only, never who the actor was.
    if (event.actorUserId !== null && audience !== 'FULFILMENT') ids.add(event.actorUserId);
    const driverId = assignedDriverIdOf(event.payload);
    if (driverId !== null && audience !== 'CUSTOMER') ids.add(driverId);
  }
  // Recipients are shown to the full staff view only; a customer never even causes the lookup.
  if (audience === 'FULL') {
    for (const row of notifications) {
      if (row.recipientUserId !== null) ids.add(row.recipientUserId);
    }
  }
  return [...ids];
}

// ------------------------------------------------------------------ visibility

const CUSTOMER_ROLES: readonly string[] = ORGANIZATION_ROLES;
const ROLE_NAMES: readonly string[] = ORDER_ACTOR_ROLES;
const REASON_STATUSES: readonly OrderStatus[] = ['REJECTED', 'CANCELLED'];

const VISIBLE_EVENT_TYPES: Readonly<Record<TimelineAudience, readonly OrderEventType[]>> = {
  CUSTOMER: [
    'SUBMITTED',
    'STATUS_CHANGED',
    // Shown as the plain status change; the skip itself is staff information.
    'ACCOUNTING_SKIPPED',
    'ITEMS_EDITED',
    'PAYMENT_STATUS_CHANGED',
    'PAYMENT_PLAN_CHANGED',
  ],
  FULFILMENT: [
    'SUBMITTED',
    'STATUS_CHANGED',
    'ACCOUNTING_SKIPPED',
    'ITEMS_EDITED',
    'DRIVER_ASSIGNED',
    'COMMENT_ADDED',
    'GOODS_RETURNED',
  ],
  FULL: [
    'SUBMITTED',
    'STATUS_CHANGED',
    'ACCOUNTING_SKIPPED',
    'ACCOUNTING_REVIEWED',
    'ITEMS_EDITED',
    'PAYMENT_STATUS_CHANGED',
    'PAYMENT_METHOD_CHANGED',
    'PAYMENT_PLAN_CHANGED',
    'DRIVER_ASSIGNED',
    'COMMENT_ADDED',
    'GOODS_RETURNED',
    'ALLOCATION_CHANGED',
  ],
};

function actorRoleOf(event: OrderEventRecord): OrderActorRole {
  return ROLE_NAMES.includes(event.actorRole) ? (event.actorRole as OrderActorRole) : 'SYSTEM';
}

/**
 * Fulfilment staff read working notes only where they matter for the goods: release, delivery, the
 * reason goods have to come back, and the note on the return itself.
 */
const FULFILMENT_COMMENT_STATUSES: readonly OrderStatus[] = [
  'RELEASED',
  'DELIVERED',
  'CANCELLED',
  'REJECTED',
];

function fulfilmentMayReadComment(event: OrderEventRecord): boolean {
  return (
    event.eventType === 'GOODS_RETURNED' ||
    (event.toStatus !== null && FULFILMENT_COMMENT_STATUSES.includes(event.toStatus))
  );
}

/** The comment a customer may read: reasons as written, edit reasons, and their own colleagues' notes. */
function customerMayReadComment(event: OrderEventRecord, role: OrderActorRole): boolean {
  return (
    (event.toStatus !== null && REASON_STATUSES.includes(event.toStatus)) ||
    event.eventType === 'ITEMS_EDITED' ||
    event.eventType === 'PAYMENT_PLAN_CHANGED' ||
    CUSTOMER_ROLES.includes(role)
  );
}

// ------------------------------------------------------------------ notifications

/**
 * A message belongs to the event named by its order_event_id, written in the same transaction.
 * Rows created before that column existed have no link: they are shown without a marker.
 */
function notificationsByEvent(rows: readonly OutboxRecord[]): Map<string, OutboxRecord[]> {
  const result = new Map<string, OutboxRecord[]>();
  for (const row of rows) {
    if (row.orderEventId === null) continue;
    result.set(row.orderEventId, [...(result.get(row.orderEventId) ?? []), row]);
  }
  return result;
}

function toNotificationView(
  row: OutboxRecord,
  people: ReadonlyMap<string, TimelinePerson>,
  organizationNames: ReadonlyMap<string, string>,
): TimelineNotificationView {
  const staffRole = STAFF_ROLES.find((role) => role === row.recipientRole) ?? null;
  return {
    id: row.id,
    type: row.type as NotificationType,
    recipientKind: row.recipientKind,
    recipientRole: staffRole,
    recipientUserId: row.recipientUserId,
    recipientName:
      row.recipientUserId !== null
        ? (people.get(row.recipientUserId)?.fullName ?? null)
        : row.recipientOrganizationId !== null
          ? (organizationNames.get(row.recipientOrganizationId) ?? null)
          : null,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}

// ------------------------------------------------------------------ the builder

function commentFor(
  audience: TimelineAudience,
  event: OrderEventRecord,
  role: OrderActorRole,
): string | null {
  if (event.comment === null) return null;
  if (audience === 'CUSTOMER') return customerMayReadComment(event, role) ? event.comment : null;
  if (audience === 'FULFILMENT') return fulfilmentMayReadComment(event) ? event.comment : null;
  return event.comment;
}

export function buildTimeline(input: TimelineInput): TimelineEventView[] {
  const { audience, people } = input;
  const visible = VISIBLE_EVENT_TYPES[audience];
  const rowsByEvent = notificationsByEvent(input.notifications);

  const isCustomerRow = (row: OutboxRecord): boolean =>
    row.recipientKind === 'ORGANIZATION_CHAT' ||
    (row.recipientKind === 'USER' && row.recipientUserId === input.order.placedByUserId);

  return input.events
    .filter((event) => visible.includes(event.eventType))
    .filter((event) => event.eventType !== 'PAYMENT_METHOD_CHANGED' || input.showsPaymentMethod)
    .map((event): TimelineEventView => {
      const foldedSkip = event.eventType === 'ACCOUNTING_SKIPPED' && audience !== 'FULL';
      // Outside the FULL audience, EVERY move into ACCOUNTING_CLEARED (a skip by the manager or
      // a real accountant clearance) is shown as the manager's move: with one fixed role for
      // both, a skip cannot be inferred from the role of the event.
      const hidesAccountingRole = audience !== 'FULL' && event.toStatus === 'ACCOUNTING_CLEARED';
      const role = foldedSkip || hidesAccountingRole ? 'MANAGER' : actorRoleOf(event);
      const rows = rowsByEvent.get(event.id) ?? [];
      const person = event.actorUserId === null ? undefined : people.get(event.actorUserId);
      const driverId = assignedDriverIdOf(event.payload);
      const withMoney = audience !== 'FULFILMENT';

      let actor: TimelineEventView['actor'];
      if (audience === 'CUSTOMER') {
        // Roles of staff, names only of the customer's own colleagues.
        actor = {
          userId: null,
          role,
          name: CUSTOMER_ROLES.includes(role) ? (person?.fullName ?? null) : null,
        };
      } else if (audience === 'FULFILMENT') {
        actor = { userId: null, role, name: null };
      } else {
        actor = { userId: event.actorUserId, role, name: person?.fullName ?? null };
      }

      return {
        id: event.id,
        type: foldedSkip ? 'STATUS_CHANGED' : event.eventType,
        occurredAt: event.createdAt,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        actor,
        comment: commentFor(audience, event, role),
        accountingMode: audience === 'FULL' ? accountingModeOf(event.payload) : null,
        driver:
          audience === 'CUSTOMER' || driverId === null
            ? null
            : (people.get(driverId) ?? { userId: driverId, fullName: '', phone: null }),
        itemsChange:
          event.eventType === 'ITEMS_EDITED' ? itemsChangeOf(event.payload, withMoney) : null,
        paymentChange:
          event.eventType === 'PAYMENT_STATUS_CHANGED' ? paymentChangeOf(event.payload) : null,
        paymentMethodChange:
          audience === 'FULL' && input.showsPaymentMethod
            ? paymentMethodChangeOf(event.payload)
            : null,
        paymentPlanChange:
          event.eventType === 'PAYMENT_PLAN_CHANGED' ? paymentPlanChangeOf(event.payload) : null,
        customerNotified: rows.some((row) => isCustomerRow(row) && row.status === 'SENT'),
        notifications:
          audience === 'FULL'
            ? rows.map((row) => toNotificationView(row, people, input.organizationNames))
            : [],
      };
    });
}
