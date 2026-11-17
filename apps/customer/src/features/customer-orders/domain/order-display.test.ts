import { ORDER_STATUSES, type CustomerTimelineEvent, type OrderStatus } from '@iorder/shared';
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_ORDER_STATES,
  STATE_TONE,
  canOfferCancelHint,
  canOfferReceive,
  customerHistory,
  customerOrderState,
  showsPaymentBadge,
  stateHintKey,
  stateLabelKey,
  stateNoteKey,
  stateTone,
  statusesOfState,
} from './order-display';

// The owner's rule of 2026-11-09: a customer sees three states. Every status is listed here by
// hand, so a new status cannot slip into a state unnoticed.
const EXPECTED: Readonly<Record<OrderStatus, 'ACCEPTED' | 'DELIVERED' | 'REFUSED'>> = {
  SUBMITTED: 'ACCEPTED',
  MANAGER_APPROVED: 'ACCEPTED',
  ACCOUNTING_CLEARED: 'ACCEPTED',
  RELEASED: 'ACCEPTED',
  DELIVERED: 'DELIVERED',
  RECEIVED: 'DELIVERED',
  REJECTED: 'REFUSED',
  CANCELLED: 'REFUSED',
};

describe('the three customer states', () => {
  it.each(ORDER_STATUSES)('%s maps to its state, label and tone', (status) => {
    const state = EXPECTED[status];
    expect(customerOrderState(status)).toBe(state);
    expect(stateLabelKey(status)).toBe(`customer.orderState.${state}`);
    expect(stateTone(status)).toBe(STATE_TONE[state]);
  });

  it('gives each state its own tone: amber, green, red', () => {
    expect(STATE_TONE).toEqual({ ACCEPTED: 'warning', DELIVERED: 'success', REFUSED: 'danger' });
  });

  it('every status belongs to exactly one state filter', () => {
    expect(statusesOfState('ACCEPTED')).toEqual([
      'SUBMITTED',
      'MANAGER_APPROVED',
      'ACCOUNTING_CLEARED',
      'RELEASED',
    ]);
    expect(statusesOfState('DELIVERED')).toEqual(['DELIVERED', 'RECEIVED']);
    expect(statusesOfState('REFUSED')).toEqual(['REJECTED', 'CANCELLED']);
    const all = CUSTOMER_ORDER_STATES.flatMap((state) => statusesOfState(state));
    expect([...all].sort()).toEqual([...ORDER_STATUSES].sort());
  });

  it('a delivered order says whether the receipt is still to be confirmed', () => {
    expect(stateHintKey('DELIVERED')).toBe('customer.orderState.hint.AWAITING_RECEIPT');
    expect(stateHintKey('RECEIVED')).toBe('customer.orderState.hint.RECEIPT_CONFIRMED');
    expect(stateNoteKey('DELIVERED')).toBe('customer.orderState.note.AWAITING_RECEIPT');
    expect(stateNoteKey('RECEIVED')).toBe('customer.orderState.note.RECEIPT_CONFIRMED');
  });

  it.each(['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED', 'RELEASED'] as const)(
    '%s: one hint for the whole accepted state and no card note',
    (status) => {
      expect(stateHintKey(status)).toBe('customer.orderState.hint.ACCEPTED');
      expect(stateNoteKey(status)).toBeNull();
    },
  );

  it.each(['REJECTED', 'CANCELLED'] as const)('%s: the refused hint, no card note', (status) => {
    expect(stateHintKey(status)).toBe('customer.orderState.hint.REFUSED');
    expect(stateNoteKey(status)).toBeNull();
  });
});

describe('behaviour keeps reading the real status', () => {
  it('the receive action is offered at DELIVERED only, although RECEIVED shares its state', () => {
    for (const status of ORDER_STATUSES) {
      expect(canOfferReceive({ status, placedByMe: true }, 'SHOP_OWNER')).toBe(
        status === 'DELIVERED',
      );
    }
    expect(canOfferReceive({ status: 'DELIVERED', placedByMe: false }, 'SELLER')).toBe(false);
    expect(canOfferReceive({ status: 'DELIVERED', placedByMe: true }, 'SELLER')).toBe(true);
    expect(canOfferReceive({ status: 'DELIVERED', placedByMe: true }, null)).toBe(false);
  });

  it('the cancel hint stops at the release, inside the accepted state', () => {
    const offered = ORDER_STATUSES.filter((status) => canOfferCancelHint({ status }));
    expect(offered).toEqual(['SUBMITTED', 'MANAGER_APPROVED', 'ACCOUNTING_CLEARED']);
  });

  it('the payment badge: never on a refused order, always once delivered, earlier only PAID', () => {
    for (const status of ORDER_STATUSES) {
      const state = customerOrderState(status);
      expect(showsPaymentBadge({ status, paymentStatus: 'UNPAID' })).toBe(state === 'DELIVERED');
      expect(showsPaymentBadge({ status, paymentStatus: 'PAID' })).toBe(state !== 'REFUSED');
    }
  });
});

describe('the order history a customer reads', () => {
  let seq = 0;
  const event = (
    type: CustomerTimelineEvent['type'],
    occurredAt: string,
    toStatus: OrderStatus | null = null,
  ): CustomerTimelineEvent => ({
    id: `event-${++seq}`,
    type,
    occurredAt,
    fromStatus: null,
    toStatus,
    actor: null,
    comment: null,
    customerNotified: false,
    itemsChange: null,
    paymentChange: null,
    paymentPlanChange: null,
  });
  const kinds = (events: readonly CustomerTimelineEvent[]): string[] =>
    customerHistory(events, '2026-10-23T09:00:00.000Z').map((entry) => entry.kind);

  it('keeps accepted, changes, delivery and receipt; drops the steps inside the company', () => {
    const events = [
      event('STATUS_CHANGED', '2026-10-25T10:00:00.000Z', 'RECEIVED'),
      event('STATUS_CHANGED', '2026-10-24T12:00:00.000Z', 'DELIVERED'),
      event('STATUS_CHANGED', '2026-10-24T10:00:00.000Z', 'RELEASED'),
      event('PAYMENT_STATUS_CHANGED', '2026-10-24T09:00:00.000Z'),
      event('STATUS_CHANGED', '2026-10-23T12:00:00.000Z', 'ACCOUNTING_CLEARED'),
      event('STATUS_CHANGED', '2026-10-23T11:00:00.000Z', 'MANAGER_APPROVED'),
      event('PAYMENT_PLAN_CHANGED', '2026-10-23T10:30:00.000Z'),
      event('ITEMS_EDITED', '2026-10-23T10:00:00.000Z'),
      event('SUBMITTED', '2026-10-23T09:00:00.000Z', 'SUBMITTED'),
    ];
    expect(kinds(events)).toEqual([
      'ACCEPTED',
      'ITEMS_CHANGED',
      'PLAN_CHANGED',
      'DELIVERED',
      'RECEIPT_CONFIRMED',
    ]);
  });

  it.each(['REJECTED', 'CANCELLED'] as const)('%s ends the history as refused', (status) => {
    const events = [
      event('SUBMITTED', '2026-10-23T09:00:00.000Z', 'SUBMITTED'),
      event('STATUS_CHANGED', '2026-10-23T11:00:00.000Z', 'MANAGER_APPROVED'),
      event('STATUS_CHANGED', '2026-10-23T12:00:00.000Z', status),
    ];
    const history = customerHistory(events, '2026-10-23T09:00:00.000Z');
    expect(history.map((entry) => entry.kind)).toEqual(['ACCEPTED', 'REFUSED']);
    expect(history[1]?.event?.toStatus).toBe(status);
  });

  it('an order without a submit event still starts with "accepted", at the order time', () => {
    const history = customerHistory(
      [event('STATUS_CHANGED', '2026-10-24T12:00:00.000Z', 'DELIVERED')],
      '2026-10-23T09:00:00.000Z',
    );
    expect(history.map((entry) => [entry.kind, entry.occurredAt])).toEqual([
      ['ACCEPTED', '2026-10-23T09:00:00.000Z'],
      ['DELIVERED', '2026-10-24T12:00:00.000Z'],
    ]);
    expect(history[0]?.event).toBeNull();
    expect(kinds([])).toEqual(['ACCEPTED']);
  });
});
