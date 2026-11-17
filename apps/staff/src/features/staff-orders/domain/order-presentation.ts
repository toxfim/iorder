import type { OrderStatus, PaymentStatus } from '@iorder/shared';
import type { AccountingMode } from '@iorder/shared/staff-orders';
import type { TimelineEvent } from './timeline-model';
import type { BadgeTone } from '@core/components/ui/AppBadge.vue';
import { stageIndex } from './order-model';

/** Pill colour per status, as design v8 assigns them (SGT): orange while with the manager or
 * accountant, blue in the warehouse and on the road, green once delivered, red text when closed. */
const STAGE_TONES: Record<OrderStatus, BadgeTone> = {
  SUBMITTED: 'accent',
  MANAGER_APPROVED: 'accent',
  ACCOUNTING_CLEARED: 'info',
  RELEASED: 'info',
  DELIVERED: 'success',
  RECEIVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'danger',
};

export const stageTone = (status: OrderStatus): BadgeTone => STAGE_TONES[status];
/** v8: paid is green, unpaid a neutral grey pill (payment never blocks the workflow). */
export const paymentTone = (status: PaymentStatus): BadgeTone =>
  status === 'PAID' ? 'success' : 'neutral';

/**
 * `skipped`: the manager let the order pass without the accountant (not a real clearance).
 * `closed`: the step where a rejected or cancelled order stopped.
 */
export type ProgressSegmentState = 'done' | 'skipped' | 'next' | 'todo' | 'closed';

/** Index of the accounting step among the six segments. */
const ACCOUNTING_SEGMENT = 2;

/**
 * State of the six progress segments on the order page: everything up to the current stage is done,
 * the next one is highlighted, the rest wait. When the manager skipped accounting, that segment is
 * marked apart from a real accountant clearance. A closed order shows the steps it had passed and
 * the step it stopped at, when `closedFrom` (the status it left, read from the closing event) is
 * known; without it nothing is shown as done.
 */
export function progressSegments(
  status: OrderStatus,
  accountingMode?: AccountingMode,
  closedFrom?: OrderStatus | null,
): ProgressSegmentState[] {
  const open = stageIndex(status);
  const current = open !== -1 ? open : closedFrom ? stageIndex(closedFrom) : -1;
  return Array.from({ length: 6 }, (_, index) => {
    if (current === -1) return 'todo';
    if (
      index === ACCOUNTING_SEGMENT &&
      index <= current &&
      accountingMode === 'SKIPPED_BY_MANAGER'
    ) {
      return 'skipped';
    }
    if (index <= current) return 'done';
    if (index !== current + 1) return 'todo';
    return open === -1 ? 'closed' : 'next';
  });
}

/**
 * i18n key (under orders.detail.events) that names a timeline event. The server sends the event
 * type and the status move; what the move means ("manager approved", "accountant rejected") comes
 * from the target status and the acting role.
 */
export function eventTitleKey(event: TimelineEvent): string {
  switch (event.type) {
    case 'SUBMITTED':
      return 'SUBMITTED';
    case 'ITEMS_EDITED':
      return 'ITEMS_EDITED';
    case 'PAYMENT_STATUS_CHANGED':
      return 'PAYMENT_CHANGED';
    case 'PAYMENT_METHOD_CHANGED':
      return 'PAYMENT_METHOD_CHANGED';
    case 'PAYMENT_PLAN_CHANGED':
      return 'PAYMENT_PLAN_CHANGED';
    case 'ACCOUNTING_SKIPPED':
      return 'ACCOUNTING_SKIPPED';
    // Scans (UNIT_CODE_*) are kept out of the timeline by the api today; named in case one comes.
    case 'DRIVER_ASSIGNED':
    case 'ACCOUNTING_REVIEWED':
    case 'COMMENT_ADDED':
    case 'UNIT_CODE_RECORDED':
    case 'UNIT_CODE_CLEARED':
    case 'GOODS_RETURNED':
    case 'ALLOCATION_CHANGED':
    case 'UNKNOWN': // a type this build does not know: the generic label
      return event.type;
    case 'STATUS_CHANGED':
      if (event.toStatus === 'REJECTED') {
        return event.actor.role === 'ACCOUNTANT' ? 'ACCOUNTING_REJECTED' : 'REJECTED';
      }
      if (event.toStatus === 'ACCOUNTING_CLEARED') {
        return event.actor.role === 'ACCOUNTANT' ? 'ACCOUNTING_APPROVED' : 'ACCOUNTING_CLEARED';
      }
      return event.toStatus ?? 'STATUS_CHANGED';
  }
}
