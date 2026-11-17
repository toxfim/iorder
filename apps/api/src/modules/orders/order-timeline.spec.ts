import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  personIdsOf,
  type TimelineAudience,
  type TimelineInput,
  type TimelinePerson,
} from './order-timeline.js';
import type { OrderEventRecord, OutboxRecord } from './orders.repository.js';

const PLACER = '00000000-0000-7000-8000-000000000001';
const MANAGER = '00000000-0000-7000-8000-000000000002';
const T = new Date('2026-10-20T09:00:00.000Z');

const people = new Map<string, TimelinePerson>([
  [PLACER, { userId: PLACER, fullName: 'Seller A', phone: null }],
  [MANAGER, { userId: MANAGER, fullName: 'Manager', phone: '+998900000000' }],
]);

let counter = 0;
function event(overrides: Partial<OrderEventRecord>): OrderEventRecord {
  counter += 1;
  return {
    id: `event-${counter}`,
    eventType: 'STATUS_CHANGED',
    fromStatus: 'SUBMITTED',
    toStatus: 'MANAGER_APPROVED',
    actorUserId: MANAGER,
    actorRole: 'MANAGER',
    comment: null,
    payload: { before: { status: 'SUBMITTED' }, after: { status: 'MANAGER_APPROVED' } },
    createdAt: T,
    ...overrides,
  };
}

function row(overrides: Partial<OutboxRecord>): OutboxRecord {
  counter += 1;
  return {
    id: `row-${counter}`,
    type: 'ORDER_MANAGER_APPROVED',
    recipientKind: 'ORGANIZATION_CHAT',
    recipientUserId: null,
    recipientRole: null,
    recipientOrganizationId: 'org-1',
    status: 'SENT',
    attempts: 1,
    dedupeKey: `order:o:ORDER_MANAGER_APPROVED:ORG:org-1:${counter}`,
    orderEventId: null,
    createdAt: T,
    sentAt: T,
    ...overrides,
  };
}

function build(
  audience: TimelineAudience,
  events: OrderEventRecord[],
  notifications: OutboxRecord[] = [],
  showsPaymentMethod = audience === 'FULL',
): ReturnType<typeof buildTimeline> {
  const input: TimelineInput = {
    audience,
    showsPaymentMethod,
    order: { placedByUserId: PLACER },
    events,
    notifications,
    people,
    organizationNames: new Map([['org-1', 'Alpha shop']]),
  };
  return buildTimeline(input);
}

const edit = (before: string, after: string, at: Date): OrderEventRecord =>
  event({
    eventType: 'ITEMS_EDITED',
    fromStatus: null,
    toStatus: null,
    comment: 'stock',
    createdAt: at,
    payload: {
      before: {
        totalAmount: before,
        lines: [
          {
            productCode: 'A',
            name: 'Apple',
            quantity: '2.000',
            unitPrice: '10.00',
            lineTotal: before,
          },
        ],
      },
      after: {
        totalAmount: after,
        lines: [
          {
            productCode: 'A',
            name: 'Apple',
            quantity: '1.000',
            unitPrice: '10.00',
            lineTotal: after,
          },
        ],
      },
    },
  });

describe('buildTimeline: what each audience may see', () => {
  const skip = event({
    eventType: 'ACCOUNTING_SKIPPED',
    fromStatus: 'MANAGER_APPROVED',
    toStatus: 'ACCOUNTING_CLEARED',
    payload: {
      before: { status: 'MANAGER_APPROVED', accountingMode: 'PENDING' },
      after: { status: 'ACCOUNTING_CLEARED', accountingMode: 'SKIPPED_BY_MANAGER' },
    },
  });

  it('customer: the skip is a plain status change by the MANAGER, with no accounting data', () => {
    const odd = event({ ...skip, actorRole: 'SYSTEM', actorUserId: null, comment: 'skip: urgent' });
    for (const folded of [skip, odd]) {
      const [shown] = build('CUSTOMER', [folded]);
      expect(shown).toMatchObject({
        type: 'STATUS_CHANGED',
        toStatus: 'ACCOUNTING_CLEARED',
        actor: { userId: null, role: 'MANAGER', name: null },
        accountingMode: null,
        comment: null,
      });
    }
  });

  it('customer and fulfilment: a real accountant clearance wears the same role as a folded skip', () => {
    // Otherwise the role alone (ACCOUNTANT vs MANAGER) would tell a customer whether accounting
    // was skipped, which is staff information.
    const cleared = event({
      fromStatus: 'MANAGER_APPROVED',
      toStatus: 'ACCOUNTING_CLEARED',
      actorRole: 'ACCOUNTANT',
      actorUserId: 'accountant-1',
      comment: 'checked',
    });
    for (const audience of ['CUSTOMER', 'FULFILMENT'] as const) {
      const [fromSkip] = build(audience, [skip]);
      const [fromAccountant] = build(audience, [cleared]);
      expect(fromAccountant?.actor).toEqual(fromSkip?.actor);
      expect(fromAccountant).toMatchObject({
        type: 'STATUS_CHANGED',
        actor: { userId: null, role: 'MANAGER', name: null },
        accountingMode: null,
        comment: null,
      });
    }
    // Staff keep the truth.
    expect(build('FULL', [cleared])[0]?.actor?.role).toBe('ACCOUNTANT');
  });

  it('fulfilment: the skip is also folded into a manager move', () => {
    const [shown] = build('FULFILMENT', [skip]);
    expect(shown).toMatchObject({
      type: 'STATUS_CHANGED',
      actor: { userId: null, role: 'MANAGER', name: null },
      accountingMode: null,
    });
  });

  it('fulfilment: roles only (no names, no user ids), comments only on release, delivery, cancel', () => {
    const events = [
      event({ toStatus: 'MANAGER_APPROVED', comment: 'approval note' }),
      event({ toStatus: 'ACCOUNTING_CLEARED', actorRole: 'ACCOUNTANT', comment: 'checked' }),
      event({ toStatus: 'RELEASED', actorRole: 'WAREHOUSE_MANAGER', comment: 'packed' }),
      event({ toStatus: 'DELIVERED', actorRole: 'DRIVER', comment: 'left at the door' }),
      event({ toStatus: 'CANCELLED', comment: 'cancelled' }),
      event({ eventType: 'COMMENT_ADDED', toStatus: null, comment: 'free note' }),
    ];
    const shown = build('FULFILMENT', events);
    expect(shown.map((e) => e.comment)).toEqual([
      null,
      null,
      'packed',
      'left at the door',
      'cancelled',
      null,
    ]);
    for (const e of shown) {
      expect(e.actor?.userId).toBeNull();
      expect(e.actor?.name).toBeNull();
    }
    expect(JSON.stringify(shown)).not.toContain(MANAGER);
    expect(JSON.stringify(shown)).not.toContain('Manager');
  });

  it('full staff: the skip keeps its own type and the accounting mode', () => {
    const [shown] = build('FULL', [skip]);
    expect(shown).toMatchObject({
      type: 'ACCOUNTING_SKIPPED',
      accountingMode: { from: 'PENDING', to: 'SKIPPED_BY_MANAGER' },
      actor: { userId: MANAGER, role: 'MANAGER', name: 'Manager' },
    });
  });

  it('customers never see accounting reviews, free comments or driver assignments', () => {
    const hidden = (['ACCOUNTING_REVIEWED', 'COMMENT_ADDED', 'DRIVER_ASSIGNED'] as const).map((t) =>
      event({ eventType: t }),
    );
    expect(build('CUSTOMER', hidden)).toEqual([]);
    expect(build('FULL', hidden)).toHaveLength(3);
    // The warehouse sees the driver and free comments, but not the accountant's review.
    expect(build('FULFILMENT', hidden).map((e) => e.type)).toEqual([
      'COMMENT_ADDED',
      'DRIVER_ASSIGNED',
    ]);
  });

  it('customers read reasons of rejections and cancellations and edit reasons, not working notes', () => {
    const events = [
      event({ comment: 'called the shop' }),
      event({ toStatus: 'REJECTED', comment: 'out of stock' }),
      event({ toStatus: 'CANCELLED', comment: 'ordered twice' }),
      edit('20.00', '10.00', T),
    ];
    expect(build('CUSTOMER', events).map((e) => e.comment)).toEqual([
      null,
      'out of stock',
      'ordered twice',
      'stock',
    ]);
    expect(build('FULL', events).map((e) => e.comment)).toEqual([
      'called the shop',
      'out of stock',
      'ordered twice',
      'stock',
    ]);
  });

  it('customers see names of their own colleagues and only the role of staff', () => {
    const shown = build('CUSTOMER', [
      event({ actorUserId: PLACER, actorRole: 'SELLER', comment: 'my own note' }),
      event({}),
    ]);
    expect(shown.map((e) => e.actor)).toEqual([
      { userId: null, role: 'SELLER', name: 'Seller A' },
      { userId: null, role: 'MANAGER', name: null },
    ]);
    // A customer's own note is readable by the organization.
    expect(shown[0]?.comment).toBe('my own note');
  });

  it('an unknown or missing actor becomes SYSTEM instead of failing', () => {
    const shown = build('FULL', [event({ actorUserId: null, actorRole: 'robot' })]);
    expect(shown[0]?.actor).toEqual({ userId: null, role: 'SYSTEM', name: null });
  });

  it('the fulfilment view carries no money in an edit', () => {
    const [shown] = build('FULFILMENT', [edit('20.00', '10.00', T)]);
    expect(shown?.itemsChange).toEqual({
      oldTotal: null,
      newTotal: null,
      lines: [
        {
          productCode: 'A',
          name: 'Apple',
          change: 'QUANTITY_CHANGED',
          oldQuantity: '2.000',
          newQuantity: '1.000',
          oldLineTotal: null,
          newLineTotal: null,
        },
      ],
    });
  });
});

describe('buildTimeline: robustness', () => {
  it('a payload of the wrong shape loses its detail, not the event', () => {
    const shown = build('FULL', [
      event({ eventType: 'ITEMS_EDITED', payload: 'garbage' }),
      event({ eventType: 'PAYMENT_STATUS_CHANGED', payload: { before: {}, after: null } }),
      event({ eventType: 'STATUS_CHANGED', payload: null }),
    ]);
    expect(
      shown.map((e) => [e.type, e.itemsChange, e.paymentChange, e.accountingMode, e.driver]),
    ).toEqual([
      ['ITEMS_EDITED', null, null, null, null],
      ['PAYMENT_STATUS_CHANGED', null, null, null, null],
      ['STATUS_CHANGED', null, null, null, null],
    ]);
  });

  it('only changed lines are listed, in product code order', () => {
    const payload = {
      before: {
        totalAmount: '60.00',
        lines: [
          {
            productCode: 'C',
            name: 'Cherry',
            quantity: '1.000',
            unitPrice: '10.00',
            lineTotal: '10.00',
          },
          {
            productCode: 'B',
            name: 'Banana',
            quantity: '2.000',
            unitPrice: '10.00',
            lineTotal: '20.00',
          },
          {
            productCode: 'A',
            name: 'Apple',
            quantity: '3.000',
            unitPrice: '10.00',
            lineTotal: '30.00',
          },
        ],
      },
      after: {
        totalAmount: '40.00',
        lines: [
          {
            productCode: 'C',
            name: 'Cherry',
            quantity: '1.000',
            unitPrice: '10.00',
            lineTotal: '10.00',
          },
          {
            productCode: 'A',
            name: 'Apple',
            quantity: '3.000',
            unitPrice: '10.00',
            lineTotal: '30.00',
          },
        ],
      },
    };
    const [shown] = build('FULL', [event({ eventType: 'ITEMS_EDITED', payload })]);
    expect(shown?.itemsChange?.lines.map((l) => [l.productCode, l.change])).toEqual([
      ['B', 'REMOVED'],
    ]);
  });

  it('matches rows to events by the event id, even for two events with the same timestamp', () => {
    const first = edit('40.00', '30.00', T);
    const second = edit('30.00', '20.00', T);
    const rows = [
      row({ orderEventId: second.id, type: 'ORDER_ITEMS_EDITED', status: 'PENDING' }),
      row({ orderEventId: first.id, type: 'ORDER_ITEMS_EDITED', status: 'SENT' }),
    ];
    // The rows are listed in the "wrong" order on purpose: only the link decides.
    const shown = build('FULL', [first, second], rows);
    expect(shown.map((e) => e.notifications.map((n) => n.status))).toEqual([['SENT'], ['PENDING']]);
  });

  it('rows of another event, or without a link (written before the link existed), never attach', () => {
    const mine = event({});
    const shown = build(
      'FULL',
      [mine],
      [
        row({ orderEventId: 'another-event' }),
        row({ orderEventId: null }),
        row({ id: 'mine', orderEventId: mine.id }),
      ],
    );
    expect(shown[0]?.notifications.map((n) => n.id)).toEqual(['mine']);
  });

  it('"customer notified" counts only SENT rows to the chat or the placer', () => {
    const e = event({});
    const rows = [
      row({ orderEventId: e.id, status: 'PENDING' }),
      row({
        orderEventId: e.id,
        recipientKind: 'ROLE',
        recipientRole: 'ACCOUNTANT',
        recipientOrganizationId: null,
      }),
    ];
    expect(build('CUSTOMER', [e], rows)[0]?.customerNotified).toBe(false);
    const sentToChat = row({ orderEventId: e.id });
    expect(build('CUSTOMER', [e], [...rows, sentToChat])[0]?.customerNotified).toBe(true);
    const toPlacer = row({
      orderEventId: e.id,
      recipientKind: 'USER',
      recipientUserId: PLACER,
      recipientOrganizationId: null,
    });
    expect(build('CUSTOMER', [e], [toPlacer])[0]?.customerNotified).toBe(true);
    // The customer view never lists notifications themselves.
    expect(build('CUSTOMER', [e], [toPlacer])[0]?.notifications).toEqual([]);
  });

  it('personIdsOf lists actors, assigned drivers and message recipients once', () => {
    const release = event({
      payload: { before: { driverUserId: null }, after: { driverUserId: 'driver-1' } },
    });
    const rows = [row({ recipientKind: 'USER', recipientUserId: 'driver-1' }), row({})];
    const ids = personIdsOf('FULL', [event({}), event({}), release], rows);
    expect(ids.sort()).toEqual(['driver-1', MANAGER].sort());
  });

  it('personIdsOf: a customer fetches no recipients and no drivers, the fulfilment view no actors', () => {
    const release = event({
      payload: { before: { driverUserId: null }, after: { driverUserId: 'driver-1' } },
    });
    const rows = [row({ recipientKind: 'USER', recipientUserId: 'recipient-1' })];
    expect(personIdsOf('CUSTOMER', [release], rows)).toEqual([MANAGER]);
    expect(personIdsOf('FULFILMENT', [release], rows)).toEqual(['driver-1']);
  });
});

describe('payment method ([C] 2026-10-24: manager and accountant only)', () => {
  const approval = event({
    payload: {
      before: { status: 'SUBMITTED', paymentMethod: null },
      after: { status: 'MANAGER_APPROVED', paymentMethod: 'CASH' },
    },
  });
  const changed = event({
    eventType: 'PAYMENT_METHOD_CHANGED',
    fromStatus: null,
    toStatus: null,
    payload: { before: { paymentMethod: 'CASH' }, after: { paymentMethod: 'OFFICIAL' } },
  });

  it('shows the choice on the approval and the later change to whoever may see it', () => {
    const shown = build('FULL', [approval, changed]);
    expect(shown.map((e) => [e.type, e.paymentMethodChange])).toEqual([
      ['STATUS_CHANGED', { from: null, to: 'CASH' }],
      ['PAYMENT_METHOD_CHANGED', { from: 'CASH', to: 'OFFICIAL' }],
    ]);
  });

  it('hides it from the admin (FULL detail without the permission)', () => {
    const shown = build('FULL', [approval, changed], [], false);
    expect(shown.map((e) => [e.type, e.paymentMethodChange])).toEqual([['STATUS_CHANGED', null]]);
  });

  it.each(['CUSTOMER', 'FULFILMENT'] as const)('never reaches the %s view', (audience) => {
    const shown = build(audience, [approval, changed], [], true);
    expect(shown.map((e) => [e.type, e.paymentMethodChange])).toEqual([['STATUS_CHANGED', null]]);
  });
});

describe('the warehouse flow in the timeline', () => {
  const returned = event({
    eventType: 'GOODS_RETURNED',
    fromStatus: null,
    toStatus: null,
    actorRole: 'WAREHOUSE_MANAGER',
    comment: "joyiga qo'yildi",
    payload: { before: { goodsReturnedAt: null }, after: { goodsReturnedAt: T.toISOString() } },
  });

  it('shows the return to staff, with its note, and never to the customer', () => {
    expect(build('CUSTOMER', [returned])).toEqual([]);
    for (const audience of ['FULL', 'FULFILMENT'] as const) {
      const [shown] = build(audience, [returned]);
      expect(shown?.type).toBe('GOODS_RETURNED');
      expect(shown?.comment).toBe("joyiga qo'yildi");
    }
  });

  it('lets the warehouse read why an order was rejected, but not the approval note', () => {
    const rejected = event({
      fromStatus: 'MANAGER_APPROVED',
      toStatus: 'REJECTED',
      actorRole: 'ACCOUNTANT',
      comment: 'kredit limiti',
    });
    const approved = event({ comment: 'ichki izoh' });
    const [approval, rejection] = build('FULFILMENT', [approved, rejected]);
    expect(approval?.comment).toBeNull();
    expect(rejection?.comment).toBe('kredit limiti');
  });
});
