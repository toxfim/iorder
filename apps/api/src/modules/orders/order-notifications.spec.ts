import { describe, expect, it } from 'vitest';
import { findForbiddenKeys } from '../../../test/support/forbidden-fields.js';
import {
  addsMarkedProduct,
  buildItemsEditedNotifications,
  buildPurchasingItemsEditedNotification,
  buildPurchasingNotification,
  buildPaymentPlanChangedNotifications,
  buildSubmittedNotifications,
  buildTransitionNotifications,
  CUSTOMER_PAYLOAD_KEYS,
  type NotificationContext,
  type PurchasingOrderFacts,
} from './order-notifications.js';
import { decideTransition } from './order-state-machine.js';

const base: NotificationContext = {
  orderId: 'o1',
  orderNumber: 'IO-10001',
  organizationId: 'org1',
  placedByUserId: 'placer',
  actorUserId: 'actor',
  actorRole: 'MANAGER',
  totalAmount: '4500.00',
  currency: 'UZS',
  reason: null,
  driverUserId: null,
  accountingSkipped: false,
};

function effectsOf(decision: ReturnType<typeof decideTransition>) {
  if (decision.outcome !== 'ALLOWED') throw new Error(decision.outcome);
  return decision.effects;
}

describe('the warehouse and the driver get no money in their messages', () => {
  it.each([
    ['WAREHOUSE_MANAGERS', 'ORDER_READY_TO_PREPARE'],
    ['WAREHOUSE_MANAGERS', 'ORDER_CANCELLED'],
    ['DRIVER', 'ORDER_RELEASED'],
  ] as const)('%s %s', (target, type) => {
    const [row] = buildTransitionNotifications([{ target, type }], {
      ...base,
      driverUserId: 'driver-1',
    });
    expect(row?.payload).not.toHaveProperty('totalAmount');
    expect(row?.payload).not.toHaveProperty('currency');
  });

  describe("the accountant's approval details", () => {
    const line = {
      productCode: 'HN14A',
      name: 'Honor 14A',
      quantity: '4.000',
      unitPrice: '1000000.00',
      lineTotal: '4000000.00',
      supplies: [{ supplyRef: '77343', partyNumber: 'P-7', quantity: '4.000' }],
    };
    const accountantFacts = {
      paymentMethod: 'CASH' as const,
      paymentPlan: 'FULL' as const,
      lines: [line],
    };
    const effects = [
      { target: 'ACCOUNTANTS', type: 'ORDER_MANAGER_APPROVED' },
      { target: 'WAREHOUSE_MANAGERS', type: 'ORDER_READY_TO_PREPARE' },
    ] as const;

    it('reach the accountant row and no other', () => {
      const rows = buildTransitionNotifications(effects, { ...base, accountantFacts });
      const [accountant, warehouse] = rows;
      expect(accountant?.payload).toMatchObject({
        paymentMethod: 'CASH',
        paymentPlan: 'FULL',
        orderLineCount: 1,
        orderLines: [line],
      });
      for (const key of ['paymentMethod', 'paymentPlan', 'orderLines', 'orderLineCount']) {
        expect(warehouse?.payload).not.toHaveProperty(key);
      }
    });

    it('never reach the customer side, even if an effect asked for it', () => {
      const [row] = buildTransitionNotifications(
        [{ target: 'CUSTOMER', type: 'ORDER_MANAGER_APPROVED' }],
        { ...base, accountantFacts },
      );
      expect(Object.keys(row?.payload ?? {}).every((k) => CUSTOMER_PAYLOAD_KEYS.includes(k))).toBe(
        true,
      );
    });

    it('copy only the listed fields of a line', () => {
      const [row] = buildTransitionNotifications([effects[0]], {
        ...base,
        accountantFacts: {
          ...accountantFacts,
          lines: [
            { ...line, unitCost: '1', supplies: [{ ...line.supplies[0], supplier: 'ACME' }] },
          ] as unknown as typeof accountantFacts.lines,
        },
      });
      expect(JSON.stringify(row?.payload)).not.toMatch(/unitCost|supplier|ACME/);
    });

    it('cut a big order in the row but keep the real count', () => {
      const [row] = buildTransitionNotifications([effects[0]], {
        ...base,
        accountantFacts: { ...accountantFacts, lines: Array.from({ length: 45 }, () => line) },
      });
      expect(row?.payload.orderLines).toHaveLength(30);
      expect(row?.payload.orderLineCount).toBe(45);
    });
  });

  it('the accountant still sees the total', () => {
    const [row] = buildTransitionNotifications(
      [{ target: 'ACCOUNTANTS', type: 'ORDER_MANAGER_APPROVED' }],
      base,
    );
    expect(row?.payload.totalAmount).toBe('4500.00');
  });
});

describe('notification rows', () => {
  it('tells every manager about a new order', () => {
    const rows = buildSubmittedNotifications({ ...base, actorRole: 'SELLER' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'ORDER_SUBMITTED',
      recipientKind: 'ROLE',
      recipientRole: 'MANAGER',
      recipientUserId: null,
      recipientOrganizationId: null,
      dedupeKey: 'order:o1:ORDER_SUBMITTED:ROLE:MANAGER',
      payload: { orderNumber: 'IO-10001', status: 'SUBMITTED' },
    });
  });

  it('addresses the driver as a user; a release is silent for the customer ([C] 2026-11-09)', () => {
    const decision = decideTransition({
      from: 'ACCOUNTING_CLEARED',
      to: 'RELEASED',
      roles: ['WAREHOUSE_MANAGER'],
      driverUserId: 'driver-1',
    });
    const rows = buildTransitionNotifications(effectsOf(decision), {
      ...base,
      actorRole: 'WAREHOUSE_MANAGER',
      driverUserId: 'driver-1',
    });
    expect(
      rows.map((r) => [r.type, r.recipientKind, r.recipientUserId, r.recipientOrganizationId]),
    ).toEqual([['ORDER_RELEASED', 'USER', 'driver-1', null]]);
  });

  it('addresses the customer as the organization chat', () => {
    const decision = decideTransition({
      from: 'SUBMITTED',
      to: 'MANAGER_APPROVED',
      roles: ['MANAGER'],
      paymentMethod: 'OFFICIAL',
    });
    const rows = buildTransitionNotifications(effectsOf(decision), base);
    expect(
      rows
        .filter((r) => r.recipientKind === 'ORGANIZATION_CHAT')
        .map((r) => [r.type, r.recipientUserId, r.recipientOrganizationId]),
    ).toEqual([['ORDER_MANAGER_APPROVED', null, 'org1']]);
  });

  it('tells the organization chat and the placer when the manager cancels', () => {
    const cancel = decideTransition({
      from: 'SUBMITTED',
      to: 'CANCELLED',
      roles: ['MANAGER'],
      reason: 'mistake',
    });
    const rows = buildTransitionNotifications(effectsOf(cancel), {
      ...base,
      actorRole: 'MANAGER',
      actorUserId: 'manager-1',
      reason: 'mistake',
    });
    expect(
      rows.map((r) => [r.recipientKind, r.recipientOrganizationId ?? r.recipientUserId]),
    ).toEqual([
      ['ORGANIZATION_CHAT', 'org1'],
      ['USER', 'placer'],
    ]);
    expect(rows.every((r) => r.payload.reason === 'mistake')).toBe(true);
  });

  it('puts the reason in the payload and uses deterministic dedupe keys', () => {
    const decision = decideTransition({
      from: 'SUBMITTED',
      to: 'REJECTED',
      roles: ['MANAGER'],
      reason: 'out of stock',
    });
    const context = { ...base, reason: 'out of stock' };
    const first = buildTransitionNotifications(effectsOf(decision), context);
    const second = buildTransitionNotifications(effectsOf(decision), context);
    expect(first).toEqual(second);
    expect(first[0]?.payload.reason).toBe('out of stock');
    expect(first[0]?.dedupeKey).toBe('order:o1:ORDER_REJECTED:ORG:org1');
  });

  it('marks an accounting skip for the accountant', () => {
    const decision = decideTransition({
      from: 'SUBMITTED',
      to: 'MANAGER_APPROVED',
      roles: ['MANAGER'],
      skipAccounting: true,
      paymentMethod: 'CASH',
    });
    const rows = buildTransitionNotifications(effectsOf(decision), {
      ...base,
      accountingSkipped: true,
    });
    // [C] 2026-11-09: the customer chat gets the approval only, not the clearance.
    expect(rows.map((r) => [r.type, r.recipientKind, r.recipientRole, r.payload.status])).toEqual([
      ['ORDER_MANAGER_APPROVED', 'ROLE', 'ACCOUNTANT', 'MANAGER_APPROVED'],
      ['ORDER_MANAGER_APPROVED', 'ORGANIZATION_CHAT', null, 'MANAGER_APPROVED'],
      ['ORDER_ACCOUNTING_CLEARED', 'ROLE', 'WAREHOUSE_MANAGER', 'ACCOUNTING_CLEARED'],
    ]);
    expect(rows[0]?.payload.accountingSkipped).toBe(true);
    // the customer is never told that accounting was skipped
    expect(rows[1]?.payload.accountingSkipped).toBeUndefined();
    expect(rows[2]?.payload.accountingSkipped).toBeUndefined();
  });

  it('carries old and new totals for an edit and one key per row version', () => {
    const rows = buildItemsEditedNotifications(base, {
      oldTotal: '4500.00',
      newTotal: '3000.00',
      newRowVersion: 2,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'ORDER_ITEMS_EDITED',
      recipientKind: 'ORGANIZATION_CHAT',
      recipientOrganizationId: 'org1',
      dedupeKey: 'order:o1:ORDER_ITEMS_EDITED:ORG:org1:v2',
      payload: { oldTotalAmount: '4500.00', newTotalAmount: '3000.00' },
    });
  });

  it('keeps staff ids and internals out of everything addressed to the customer side', () => {
    const release = decideTransition({
      from: 'ACCOUNTING_CLEARED',
      to: 'RELEASED',
      roles: ['WAREHOUSE_MANAGER'],
      driverUserId: 'driver-1',
    });
    const approved = decideTransition({
      from: 'SUBMITTED',
      to: 'MANAGER_APPROVED',
      roles: ['MANAGER'],
      paymentMethod: 'CASH',
      skipAccounting: true,
    });
    const cancelled = decideTransition({
      from: 'MANAGER_APPROVED',
      to: 'CANCELLED',
      roles: ['MANAGER'],
      reason: '  customer asked  ',
    });
    const rows = [
      ...buildTransitionNotifications(effectsOf(release), {
        ...base,
        actorRole: 'WAREHOUSE_MANAGER',
        actorUserId: 'staff-uuid',
        driverUserId: 'driver-1',
      }),
      ...buildTransitionNotifications(effectsOf(approved), {
        ...base,
        actorUserId: 'staff-uuid',
        accountingSkipped: true,
      }),
      ...buildTransitionNotifications(effectsOf(cancelled), {
        ...base,
        actorUserId: 'staff-uuid',
        reason: 'customer asked',
      }),
      ...buildItemsEditedNotifications(base, {
        oldTotal: '1.00',
        newTotal: '2.00',
        newRowVersion: 2,
      }),
    ];
    const customerSide = rows.filter(
      (r) => r.recipientKind === 'ORGANIZATION_CHAT' || r.recipientUserId === 'placer',
    );
    expect(customerSide.length).toBeGreaterThanOrEqual(4);
    for (const r of customerSide) {
      expect(Object.keys(r.payload).filter((k) => !CUSTOMER_PAYLOAD_KEYS.includes(k))).toEqual([]);
      expect(JSON.stringify(r.payload)).not.toMatch(/driver-1|staff-uuid/);
    }
    // the reason reaches the customer as written
    expect(customerSide.find((r) => r.type === 'ORDER_CANCELLED')?.payload.reason).toBe(
      'customer asked',
    );
    // staff rows keep what staff need: the driver is told which order, the managers who acted
    const driverRow = rows.find((r) => r.recipientUserId === 'driver-1');
    expect(driverRow?.payload.driverUserId).toBe('driver-1');
    expect(driverRow?.payload.actorRole).toBe('WAREHOUSE_MANAGER');
  });

  it('never carries cost-like keys in any payload', () => {
    const rows = [
      ...buildSubmittedNotifications(base),
      ...buildTransitionNotifications(
        effectsOf(
          decideTransition({
            from: 'MANAGER_APPROVED',
            to: 'REJECTED',
            roles: ['ACCOUNTANT'],
            reason: 'x',
          }),
        ),
        { ...base, reason: 'x' },
      ),
      ...buildItemsEditedNotifications(base, {
        oldTotal: '1.00',
        newTotal: '2.00',
        newRowVersion: 2,
      }),
    ];
    expect(findForbiddenKeys(rows.map((r) => r.payload))).toEqual([]);
  });
});

describe('buildPaymentPlanChangedNotifications', () => {
  const context = {
    orderId: 'o1',
    orderNumber: 'IO-1',
    organizationId: 'org1',
    placedByUserId: 'u1',
    actorUserId: 'm1',
    actorRole: 'MANAGER' as const,
    totalAmount: '100.00',
    currency: 'UZS',
    reason: null,
    driverUserId: null,
    accountingSkipped: false,
  };

  it('tells the organization chat, with a key per version and only customer-safe fields', () => {
    const rows = buildPaymentPlanChangedNotifications(context, {
      oldPlan: 'FULL',
      newPlan: 'DEFERRED',
      oldTotal: '100.00',
      newTotal: '120.00',
      newRowVersion: 3,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0] as (typeof rows)[number];
    expect(row).toMatchObject({
      type: 'ORDER_PAYMENT_PLAN_CHANGED',
      recipientKind: 'ORGANIZATION_CHAT',
      recipientOrganizationId: 'org1',
      dedupeKey: 'order:o1:ORDER_PAYMENT_PLAN_CHANGED:ORG:org1:v3',
    });
    expect(row.payload).toMatchObject({
      oldPaymentPlan: 'FULL',
      newPaymentPlan: 'DEFERRED',
      oldTotalAmount: '100.00',
      newTotalAmount: '120.00',
      totalAmount: '120.00',
    });
    expect(row.payload).not.toHaveProperty('actorRole');
  });
});

describe('the purchasing manager rows ([C] 2026-10-30)', () => {
  const line = (code: string, marked: boolean): PurchasingOrderFacts['lines'][number] => ({
    productId: `id-${code}`,
    marked,
    productCode: code,
    name: `${code} name`,
    quantity: '1.000',
    unitPrice: '10.00',
    lineTotal: '10.00',
  });

  it('no marked product: no row, for the new order and the cancellation alike', () => {
    const facts = { lines: [line('A', false)] };
    expect(buildPurchasingNotification('ORDER_SUBMITTED', base, facts)).toBeNull();
    expect(buildPurchasingNotification('ORDER_CANCELLED', base, facts)).toBeNull();
  });

  it('a marked product: a role row with the marked lines first and no cost', () => {
    const row = buildPurchasingNotification('ORDER_SUBMITTED', base, {
      lines: [line('A', false), line('B', true)],
    });
    expect(row).toMatchObject({
      type: 'ORDER_SUBMITTED',
      recipientKind: 'ROLE',
      recipientRole: 'PURCHASING_MANAGER',
      dedupeKey: 'order:o1:ORDER_SUBMITTED:ROLE:PURCHASING_MANAGER',
      payload: { orderNumber: 'IO-10001', orderLineCount: 2 },
    });
    const lines = row?.payload.orderLines as { productCode: string; marked: boolean }[];
    expect(lines.map((l) => [l.productCode, l.marked])).toEqual([
      ['B', true],
      ['A', false],
    ]);
    expect(findForbiddenKeys(row?.payload)).toEqual([]);
    expect(lines.some((l) => 'productId' in l)).toBe(false);
  });

  it('an edit counts only a marked product that was not on the order before', () => {
    const before = ['id-A', 'id-B'];
    expect(addsMarkedProduct(before, [line('A', true), line('B', false)])).toBe(false);
    expect(addsMarkedProduct(before, [line('C', false)])).toBe(false);
    expect(addsMarkedProduct(before, [line('A', true), line('C', true)])).toBe(true);
  });

  it('the edit row names both totals and each edit has its own key', () => {
    const row = buildPurchasingItemsEditedNotification(
      base,
      { lines: [line('C', true)] },
      { oldTotal: '10.00', newTotal: '20.00', newRowVersion: 3 },
    );
    expect(row.recipientRole).toBe('PURCHASING_MANAGER');
    expect(row.dedupeKey).toBe('order:o1:ORDER_ITEMS_EDITED:ROLE:PURCHASING_MANAGER:v3');
    expect(row.payload).toMatchObject({ oldTotalAmount: '10.00', newTotalAmount: '20.00' });
  });
});
