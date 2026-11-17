import type {
  CustomerTimelineEvent,
  CustomerTimelineResponse,
  OrderItemsChange,
} from '@iorder/shared';
import type { StaffTimelineEvent, StaffTimelineResponse } from '@iorder/shared/staff-orders';
import type { OrderTimelineView } from '../order-timeline.service.js';
import type { TimelineEventView, TimelineItemsChange } from '../order-timeline.js';

// Field-by-field mappers. The builder already redacted per audience; these only choose the
// response shape, so a field added to a view never reaches a response by accident.

const CUSTOMER_TYPES = [
  'SUBMITTED',
  'STATUS_CHANGED',
  'ITEMS_EDITED',
  'PAYMENT_STATUS_CHANGED',
  'PAYMENT_PLAN_CHANGED',
];

function itemsChange(change: TimelineItemsChange | null): OrderItemsChange | null {
  if (change === null) return null;
  return {
    oldTotal: change.oldTotal,
    newTotal: change.newTotal,
    lines: change.lines.map((line) => ({
      productCode: line.productCode,
      name: line.name,
      change: line.change,
      oldQuantity: line.oldQuantity,
      newQuantity: line.newQuantity,
      oldLineTotal: line.oldLineTotal,
      newLineTotal: line.newLineTotal,
    })),
  };
}

function customerEvent(event: TimelineEventView): CustomerTimelineEvent {
  const type = CUSTOMER_TYPES.find((t) => t === event.type);
  if (type === undefined) throw new Error(`Event type ${event.type} is not for customers`);
  return {
    id: event.id,
    type: type as CustomerTimelineEvent['type'],
    occurredAt: event.occurredAt.toISOString(),
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actor: event.actor === null ? null : { role: event.actor.role, name: event.actor.name },
    comment: event.comment,
    itemsChange: itemsChange(event.itemsChange),
    paymentChange: event.paymentChange === null ? null : { ...event.paymentChange },
    paymentPlanChange: event.paymentPlanChange === null ? null : { ...event.paymentPlanChange },
    customerNotified: event.customerNotified,
  };
}

export function toCustomerTimeline(timeline: OrderTimelineView): CustomerTimelineResponse {
  return { orderId: timeline.orderId, events: timeline.events.map(customerEvent) };
}

function staffEvent(event: TimelineEventView): StaffTimelineEvent {
  if (event.actor === null) throw new Error('A staff timeline event always has an actor');
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt.toISOString(),
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actor: { userId: event.actor.userId, role: event.actor.role, name: event.actor.name },
    comment: event.comment,
    accountingMode:
      event.accountingMode === null
        ? null
        : { from: event.accountingMode.from, to: event.accountingMode.to },
    driver:
      event.driver === null
        ? null
        : {
            userId: event.driver.userId,
            fullName: event.driver.fullName,
            phone: event.driver.phone,
          },
    itemsChange: itemsChange(event.itemsChange),
    paymentChange: event.paymentChange === null ? null : { ...event.paymentChange },
    paymentMethodChange:
      event.paymentMethodChange === null ? null : { ...event.paymentMethodChange },
    paymentPlanChange: event.paymentPlanChange === null ? null : { ...event.paymentPlanChange },
    notifications: event.notifications.map((n) => ({
      id: n.id,
      type: n.type,
      recipientKind: n.recipientKind,
      recipientRole: n.recipientRole,
      recipientUserId: n.recipientUserId,
      recipientName: n.recipientName,
      status: n.status,
      attempts: n.attempts,
      createdAt: n.createdAt.toISOString(),
      sentAt: n.sentAt?.toISOString() ?? null,
    })),
  };
}

export function toStaffTimeline(timeline: OrderTimelineView): StaffTimelineResponse {
  return {
    orderId: timeline.orderId,
    detail: timeline.audience === 'FULL' ? 'FULL' : 'FULFILMENT',
    events: timeline.events.map(staffEvent),
  };
}
