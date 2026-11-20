import { submitOrderRequestSchema } from './orders.js';
import { describe, expect, it } from 'vitest';
import * as shared from '../index.js';
import * as staffOrders from '../staff-orders.js';
import {
  ORDER_ROUTES,
  buildPath,
  cartResponseSchema,
  customerOrderListQuerySchema,
  customerOrderListResponseSchema,
  customerOrderSchema,
  customerReceiveOrderRequestSchema,
  customerTimelineResponseSchema,
  idempotencyKeySchema,
  setCartItemRequestSchema,
  stockLimitExceededDetailsSchema,
} from '../index.js';
import {
  STAFF_DRIVER_ROUTES,
  STAFF_ORDER_ROUTES,
  approveOrderRequestSchema,
  deliveryContactSchema,
  editOrderItemsRequestSchema,
  orderDecisionWithReasonRequestSchema,
  releaseOrderRequestSchema,
  setPaymentMethodRequestSchema,
  recordPaymentRequestSchema,
  correctPaymentRequestSchema,
  staffDriverListResponseSchema,
  staffOrderListQuerySchema,
  staffOrderListResponseSchema,
  staffOrderSchema,
  staffTimelineResponseSchema,
} from '../staff-orders.js';

const id = '019a0000-0000-7000-8000-000000000001';
const id2 = '019a0000-0000-7000-8000-000000000002';
const id3 = '019a0000-0000-7000-8000-000000000003';
const at = '2026-10-20T08:00:00.000Z';

const customerItem = {
  id,
  productId: id2,
  productCode: 'P-1',
  name: 'Olma',
  unit: 'box',
  quantity: '2.000',
  unitPrice: '1500.00',
  lineTotal: '3000.00',
};

const customerSummary = {
  id,
  orderNumber: 'IO-10001',
  status: 'SUBMITTED',
  paymentStatus: 'UNPAID',
  paymentPlan: 'FULL',
  totalAmount: '3750.50',
  currency: 'UZS',
  itemCount: 2,
  customerComment: null,
  placedByName: 'Seller A',
  placedByMe: true,
  submittedAt: at,
  updatedAt: at,
  rowVersion: 1,
};

const person = { userId: id3, fullName: 'Driver', phone: '+998901234567' };

const fullOrder = {
  detail: 'FULL',
  id,
  orderNumber: 'IO-10001',
  organizationId: id2,
  organizationName: 'Alpha shop',
  organizationType: 'GROUP',
  organizationLabel: 'PARTNER',
  status: 'ACCOUNTING_CLEARED',
  itemCount: 1,
  submittedAt: at,
  updatedAt: at,
  rowVersion: 3,
  driver: null,
  goodsReturn: 'NOT_NEEDED',
  goodsReturnedAt: null,
  paymentStatus: 'PAID',
  paymentPlan: 'FULL',
  totalAmount: '3000.00',
  currency: 'UZS',
  usdRate: '12000.0000',
  totalUsd: '0.25',
  customerComment: null,
  placedBy: person,
  priceListVersionId: id3,
  accounting: {
    mode: 'SKIPPED_BY_MANAGER',
    clearedAt: at,
    reviewedAt: null,
    reviewedByUserId: null,
  },
  items: [
    {
      ...customerItem,
      fullUnitPrice: '1500.00',
      deferredUnitPrice: null,
      allocations: [],
      stockTracked: true,
    },
  ],
  deliveryContact: {
    organizationName: 'Alpha shop',
    contacts: [
      {
        userId: '00000000-0000-7000-8000-000000000001',
        fullName: 'Owner A',
        phone: null,
        placedTheOrder: false,
        isShopOwner: true,
      },
    ],
  },
};

const fulfilmentOrder = {
  detail: 'FULFILMENT',
  id,
  orderNumber: 'IO-10001',
  organizationId: id2,
  organizationName: 'Alpha shop',
  organizationType: 'PERSON',
  status: 'RELEASED',
  itemCount: 1,
  submittedAt: at,
  updatedAt: at,
  rowVersion: 4,
  driver: person,
  goodsReturn: 'NOT_NEEDED',
  goodsReturnedAt: null,
  items: [
    {
      id,
      productId: id2,
      productCode: 'P-1',
      name: 'Olma',
      unit: 'box',
      quantity: '2.000',
      stockTracked: true,
    },
  ],
  deliveryContact: fullOrder.deliveryContact,
};

describe('order requests', () => {
  it('idempotency keys: 8 to 128 safe characters', () => {
    expect(idempotencyKeySchema.safeParse('a1b2c3d4-e5f6').success).toBe(true);
    expect(idempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(idempotencyKeySchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(idempotencyKeySchema.safeParse('has space in it').success).toBe(false);
    expect(idempotencyKeySchema.safeParse(undefined).success).toBe(false);
  });

  it('cart quantities are whole-number strings, never numbers, fractions or zero', () => {
    expect(setCartItemRequestSchema.safeParse({ quantity: '2' }).success).toBe(true);
    expect(setCartItemRequestSchema.safeParse({ quantity: '2.5' }).success).toBe(false);
    expect(setCartItemRequestSchema.safeParse({ quantity: 2 }).success).toBe(false);
    expect(setCartItemRequestSchema.safeParse({ quantity: '0' }).success).toBe(false);
    expect(setCartItemRequestSchema.safeParse({ quantity: '1.2345' }).success).toBe(false);
    expect(setCartItemRequestSchema.safeParse({ quantity: '1000000' }).success).toBe(false);
    expect(setCartItemRequestSchema.safeParse({ quantity: '1', extra: 1 }).success).toBe(false);
  });

  it('approval requires a payment method, and only CASH or OFFICIAL', () => {
    expect(approveOrderRequestSchema.safeParse({ expectedRowVersion: 1 }).success).toBe(false);
    expect(
      approveOrderRequestSchema.safeParse({ expectedRowVersion: 1, paymentMethod: 'CARD' }).success,
    ).toBe(false);
    expect(setPaymentMethodRequestSchema.safeParse({ paymentMethod: 'OFFICIAL' }).success).toBe(
      true,
    );
    expect(setPaymentMethodRequestSchema.safeParse({}).success).toBe(false);
  });

  it('receive accepts no body at all', () => {
    expect(customerReceiveOrderRequestSchema.parse(undefined)).toEqual({});
    expect(customerReceiveOrderRequestSchema.safeParse({ comment: 'ok' }).success).toBe(true);
  });

  it('every staff decision requires expectedRowVersion', () => {
    const plan = { allocationMode: 'FIFO', allocations: [] };
    expect(approveOrderRequestSchema.safeParse({ paymentMethod: 'CASH', ...plan }).success).toBe(
      false,
    );
    expect(
      approveOrderRequestSchema.safeParse({
        expectedRowVersion: 1,
        paymentMethod: 'CASH',
        ...plan,
      }).success,
    ).toBe(true);
    // A plan is part of every approval ([C] 2026-10-30).
    expect(
      approveOrderRequestSchema.safeParse({ expectedRowVersion: 1, paymentMethod: 'CASH' }).success,
    ).toBe(false);
    expect(
      approveOrderRequestSchema.safeParse({
        expectedRowVersion: 1,
        paymentMethod: 'OFFICIAL',
        skipAccounting: true,
        ...plan,
      }).success,
    ).toBe(true);
    expect(orderDecisionWithReasonRequestSchema.safeParse({ reason: 'no' }).success).toBe(false);
    expect(
      orderDecisionWithReasonRequestSchema.safeParse({ reason: 'no', expectedRowVersion: 2 })
        .success,
    ).toBe(true);
    expect(releaseOrderRequestSchema.safeParse({ expectedRowVersion: 1 }).success).toBe(false);
    expect(
      releaseOrderRequestSchema.safeParse({ driverUserId: 'not-a-uuid', expectedRowVersion: 1 })
        .success,
    ).toBe(false);
    expect(
      editOrderItemsRequestSchema.safeParse({
        changes: [{ itemId: id, quantity: '3' }],
      }).success,
    ).toBe(false);
  });

  it('an edit removes a line with null and rejects a repeated line', () => {
    expect(
      editOrderItemsRequestSchema.safeParse({
        changes: [{ itemId: id, quantity: null }],
        expectedRowVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      editOrderItemsRequestSchema.safeParse({
        changes: [
          { itemId: id, quantity: '1' },
          { itemId: id, quantity: '2' },
        ],
        expectedRowVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      editOrderItemsRequestSchema.safeParse({ changes: [], expectedRowVersion: 1 }).success,
    ).toBe(false);
  });

  it('organization payments: a positive decimal string, a calendar day, a reason to correct', () => {
    const usd = { amount: '2100.00', currency: 'USD', paidOn: '2026-10-20' };
    const som = { amount: '27000000.00', currency: 'UZS', rate: '12650.5', paidOn: '2026-10-20' };
    expect(recordPaymentRequestSchema.safeParse(usd).success).toBe(true);
    expect(recordPaymentRequestSchema.safeParse(som).success).toBe(true);
    for (const bad of [
      { ...usd, amount: 27000000 },
      { ...usd, amount: '0' },
      { ...usd, amount: '-5' },
      { ...usd, paidOn: '2026-10-20T00:00:00Z' },
      { ...usd, extra: 1 },
      { amount: '1.00', paidOn: '2026-10-20' }, // a currency is chosen per payment
      { ...usd, currency: 'EUR' },
      { ...usd, rate: '12000' }, // a USD payment has no rate
      { ...som, rate: undefined }, // a so'm payment must have one
      { ...som, rate: '0' },
      { ...som, rate: '-1' },
      { ...som, rate: 12650 },
      { ...som, rate: '1.23456' },
    ]) {
      expect(recordPaymentRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(correctPaymentRequestSchema.safeParse({ rate: '12000', reason: 'x' }).success).toBe(
      true,
    );
    expect(correctPaymentRequestSchema.safeParse({ currency: 'USD', reason: 'x' }).success).toBe(
      true,
    );
    for (const bad of [
      { currency: 'UZS', reason: 'x' },
      { currency: 'USD', rate: '12000', reason: 'x' },
    ]) {
      expect(correctPaymentRequestSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(correctPaymentRequestSchema.safeParse({ amount: '5.00' }).success).toBe(false);
    expect(correctPaymentRequestSchema.safeParse({ reason: 'typo' }).success).toBe(false);
    expect(correctPaymentRequestSchema.safeParse({ comment: null, reason: 'typo' }).success).toBe(
      true,
    );
  });

  it('list queries coerce the page size and bound it', () => {
    expect(customerOrderListQuerySchema.parse({ limit: '10', status: 'SUBMITTED' })).toEqual({
      limit: 10,
      status: 'SUBMITTED',
    });
    expect(customerOrderListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(customerOrderListQuerySchema.safeParse({ cursor: 'nope' }).success).toBe(false);
    // The customer query has no organization filter: its scope already pins the organization.
    expect(customerOrderListQuerySchema.safeParse({ organizationId: id }).success).toBe(false);
    expect(
      staffOrderListQuerySchema.safeParse({ organizationId: id, search: ' 10005 ' }).success,
    ).toBe(true);
  });
});

describe('order responses', () => {
  it('parses a cart shaped like the api answer, with a problem line', () => {
    const cart = {
      priceListVersionNumber: 3,
      lines: [
        {
          productId: id,
          productCode: 'P-1',
          name: 'Olma',
          unit: 'box',
          quantity: '2.000',
          unitPrice: '1500.00',
          lineTotal: '3000.00',
          deferredUnitPrice: null,
          deferredLineTotal: null,
          rrp: '1900.00',
          orderableStock: 45,
          problem: null,
        },
        {
          productId: id2,
          productCode: 'P-3',
          name: 'P-3',
          unit: 'box',
          quantity: '1.000',
          unitPrice: null,
          lineTotal: null,
          deferredUnitPrice: null,
          deferredLineTotal: null,
          rrp: null,
          orderableStock: null,
          problem: 'NOT_PRICED',
        },
      ],
      totalAmount: '3000.00',
      deferredTotalAmount: null,
      currency: 'UZS',
      canSubmit: false,
    };
    expect(cartResponseSchema.safeParse(cart).success).toBe(true);
    expect(cartResponseSchema.safeParse({ ...cart, totalAmount: 3000 }).success).toBe(false);
    expect(cartResponseSchema.safeParse({ ...cart, extra: 1 }).success).toBe(false);
    // The RRP is a required key (null = none) and a money string, never a number.
    const [first, second] = cart.lines;
    const withoutRrp = Object.fromEntries(Object.entries(first!).filter(([key]) => key !== 'rrp'));
    expect(cartResponseSchema.safeParse({ ...cart, lines: [withoutRrp, second] }).success).toBe(
      false,
    );
    expect(
      cartResponseSchema.safeParse({ ...cart, lines: [{ ...first, rrp: 1900 }, second] }).success,
    ).toBe(false);
  });

  it('a cart line above the stock keeps its prices and says how many can be ordered', () => {
    const line = {
      productId: id,
      productCode: 'P-1',
      name: 'Olma',
      unit: 'box',
      quantity: '50.000',
      unitPrice: '1500.00',
      lineTotal: '75000.00',
      deferredUnitPrice: null,
      deferredLineTotal: null,
      rrp: null,
      orderableStock: 10 as unknown,
      problem: 'STOCK_EXCEEDED',
    };
    const cart = {
      priceListVersionNumber: 3,
      lines: [line],
      totalAmount: '75000.00',
      deferredTotalAmount: null,
      currency: 'UZS',
      canSubmit: false,
    };
    expect(cartResponseSchema.safeParse(cart).success).toBe(true);
    // Nothing left at all is the same problem with a figure of zero.
    expect(
      cartResponseSchema.safeParse({ ...cart, lines: [{ ...line, orderableStock: 0 }] }).success,
    ).toBe(true);
    // The figure is a count of pieces: never negative, a fraction or a string, and always present.
    for (const orderableStock of [-1, 2.5, '10']) {
      expect(
        cartResponseSchema.safeParse({ ...cart, lines: [{ ...line, orderableStock }] }).success,
      ).toBe(false);
    }
    const withoutFigure = Object.fromEntries(
      Object.entries(line).filter(([key]) => key !== 'orderableStock'),
    );
    expect(cartResponseSchema.safeParse({ ...cart, lines: [withoutFigure] }).success).toBe(false);
  });

  it('the stock refusal names each product with the figure it may be ordered at', () => {
    const details = { lines: [{ productId: id, orderableStock: 10 }] };
    expect(stockLimitExceededDetailsSchema.safeParse(details).success).toBe(true);
    // Out of stock is refused with a figure of zero.
    expect(
      stockLimitExceededDetailsSchema.safeParse({ lines: [{ productId: id, orderableStock: 0 }] })
        .success,
    ).toBe(true);
    expect(
      stockLimitExceededDetailsSchema.safeParse({ lines: [{ productId: id, orderableStock: -1 }] })
        .success,
    ).toBe(false);
    expect(stockLimitExceededDetailsSchema.safeParse({ lines: [] }).success).toBe(false);
    expect(
      stockLimitExceededDetailsSchema.safeParse({
        lines: [{ productId: id, orderableStock: null }],
      }).success,
    ).toBe(false);
    // Nothing but the product and the figure travels in a refusal.
    expect(
      stockLimitExceededDetailsSchema.safeParse({
        lines: [{ productId: id, orderableStock: 10, heldQuantity: '5' }],
      }).success,
    ).toBe(false);
  });

  it('parses customer orders and rejects staff-only extras', () => {
    const planFields = { paymentPlanChangeableUntil: null, paymentPlanTotals: null };
    // The frozen rate and the USD total are staff-only: the strict customer shape refuses them.
    for (const leak of [{ usdRate: '12000.0000' }, { totalUsd: '1.00' }]) {
      expect(
        customerOrderSchema.safeParse({
          ...customerSummary,
          ...planFields,
          items: [customerItem],
          ...leak,
        }).success,
      ).toBe(false);
    }
    expect(
      customerOrderSchema.safeParse({ ...customerSummary, ...planFields, items: [customerItem] })
        .success,
    ).toBe(true);
    expect(
      customerOrderSchema.safeParse({
        ...customerSummary,
        paymentPlanChangeableUntil: at,
        paymentPlanTotals: { FULL: '100.00', DEFERRED: null },
        items: [customerItem],
      }).success,
    ).toBe(true);
    // Both plan fields are required, and the totals carry nothing else.
    expect(customerOrderSchema.safeParse({ ...customerSummary, items: [] }).success).toBe(false);
    expect(
      customerOrderSchema.safeParse({
        ...customerSummary,
        paymentPlanChangeableUntil: at,
        paymentPlanTotals: { FULL: '100.00', DEFERRED: null, cost: '1.00' },
        items: [],
      }).success,
    ).toBe(false);
    expect(
      customerOrderListResponseSchema.safeParse({ orders: [customerSummary], nextCursor: null })
        .success,
    ).toBe(true);
    for (const extra of [
      { accountingMode: 'PENDING' },
      { priceListVersionId: id },
      { driverUserId: id },
      { placedByUserId: id },
    ]) {
      expect(
        customerOrderSchema.safeParse({ ...customerSummary, ...planFields, items: [], ...extra })
          .success,
      ).toBe(false);
    }
    expect(
      customerOrderSchema.safeParse({
        ...customerSummary,
        ...planFields,
        items: [{ ...customerItem, quantity: 2 }],
      }).success,
    ).toBe(false);
  });

  it('parses the FULL and FULFILMENT staff orders and keeps them apart', () => {
    expect(staffOrderSchema.safeParse(fullOrder).success).toBe(true);
    expect(staffOrderSchema.safeParse(fulfilmentOrder).success).toBe(true);
    // The warehouse shape has no accounting, no prices, no price list version.
    expect(
      staffOrderSchema.safeParse({ ...fulfilmentOrder, accounting: fullOrder.accounting }).success,
    ).toBe(false);
    expect(staffOrderSchema.safeParse({ ...fulfilmentOrder, priceListVersionId: id }).success).toBe(
      false,
    );
    // The label is a price tier: only the roles that see money get it.
    expect(
      staffOrderSchema.safeParse({ ...fulfilmentOrder, organizationLabel: 'PARTNER' }).success,
    ).toBe(false);
    expect(
      staffOrderSchema.safeParse({
        ...fulfilmentOrder,
        items: [{ ...fulfilmentOrder.items[0], unitPrice: '1.00' }],
      }).success,
    ).toBe(false);
    // The accountant gets no delivery contact; the warehouse always does.
    expect(staffOrderSchema.safeParse({ ...fullOrder, deliveryContact: null }).success).toBe(true);
    expect(staffOrderSchema.safeParse({ ...fulfilmentOrder, deliveryContact: null }).success).toBe(
      false,
    );
    expect(deliveryContactSchema.safeParse(fullOrder.deliveryContact).success).toBe(true);
  });

  it('parses a staff order list with both shapes', () => {
    const summaryOf = (order: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(order).filter(([key]) => key !== 'items' && key !== 'deliveryContact'),
      );
    const fullSummary = summaryOf(fullOrder);
    const fulfilmentSummary = summaryOf(fulfilmentOrder);
    expect(
      staffOrderListResponseSchema.safeParse({
        orders: [fullSummary, fulfilmentSummary],
        nextCursor: id,
      }).success,
    ).toBe(true);
  });

  const editedEvent = {
    id,
    type: 'ITEMS_EDITED',
    occurredAt: at,
    fromStatus: null,
    toStatus: null,
    actor: { role: 'MANAGER', name: null },
    comment: 'out of stock',
    itemsChange: {
      oldTotal: '3750.50',
      newTotal: '2250.50',
      lines: [
        {
          productCode: 'P-1',
          name: 'Olma',
          change: 'QUANTITY_CHANGED',
          oldQuantity: '2.000',
          newQuantity: '1.000',
          oldLineTotal: '3000.00',
          newLineTotal: '1500.00',
        },
        {
          productCode: 'P-2',
          name: 'Nok',
          change: 'REMOVED',
          oldQuantity: '1.000',
          newQuantity: null,
          oldLineTotal: '750.50',
          newLineTotal: null,
        },
      ],
    },
    paymentChange: null,
    paymentPlanChange: null,
    customerNotified: true,
  };

  it('parses a customer timeline and rejects staff internals', () => {
    const body = { orderId: id, events: [editedEvent] };
    expect(customerTimelineResponseSchema.safeParse(body).success).toBe(true);
    for (const extra of [
      { notifications: [] },
      { accountingMode: { from: null, to: 'APPROVED' } },
      { driver: person },
    ]) {
      expect(
        customerTimelineResponseSchema.safeParse({
          orderId: id,
          events: [{ ...editedEvent, ...extra }],
        }).success,
      ).toBe(false);
    }
    // Customers never see an accounting-only event kind.
    expect(
      customerTimelineResponseSchema.safeParse({
        orderId: id,
        events: [{ ...editedEvent, type: 'ACCOUNTING_SKIPPED' }],
      }).success,
    ).toBe(false);
  });

  it('parses a staff timeline with notifications', () => {
    const body = {
      orderId: id,
      detail: 'FULL',
      events: [
        {
          id,
          type: 'ACCOUNTING_SKIPPED',
          occurredAt: at,
          fromStatus: 'MANAGER_APPROVED',
          toStatus: 'ACCOUNTING_CLEARED',
          actor: { userId: id2, role: 'MANAGER', name: 'Manager' },
          comment: null,
          accountingMode: { from: 'PENDING', to: 'SKIPPED_BY_MANAGER' },
          driver: null,
          itemsChange: null,
          paymentChange: null,
          paymentPlanChange: null,
          paymentMethodChange: null,
          notifications: [
            {
              id: id3,
              type: 'ORDER_ACCOUNTING_CLEARED',
              recipientKind: 'ROLE',
              recipientRole: 'WAREHOUSE_MANAGER',
              recipientUserId: null,
              recipientName: null,
              status: 'PENDING',
              attempts: 0,
              createdAt: at,
              sentAt: null,
            },
          ],
        },
      ],
    };
    expect(staffTimelineResponseSchema.safeParse(body).success).toBe(true);
    expect(staffTimelineResponseSchema.safeParse({ ...body, detail: 'OTHER' }).success).toBe(false);
  });
});

describe('ORDER_ROUTES and STAFF_ORDER_ROUTES', () => {
  const customer = Object.values(ORDER_ROUTES);
  const staff = Object.values(STAFF_ORDER_ROUTES);

  it('have no duplicate method + path', () => {
    const keys = [...customer, ...staff].map((r) => r.method + ' ' + r.path);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('customer routes stay outside /staff and staff routes inside /staff/orders', () => {
    expect(customer.filter((r) => r.path.startsWith('/staff'))).toEqual([]);
    expect(staff.every((r) => r.path.startsWith('/staff/orders'))).toBe(true);
  });

  it('the driver list route is its own staff route and repeats no other', () => {
    expect(STAFF_DRIVER_ROUTES.listDrivers).toEqual({ method: 'GET', path: '/staff/drivers' });
    const all = [...customer, ...staff, ...Object.values(STAFF_DRIVER_ROUTES)].map(
      (r) => r.method + ' ' + r.path,
    );
    expect(new Set(all).size).toBe(all.length);
  });

  it('the driver list schema is strict: no phone or Telegram id may ride along', () => {
    expect(
      staffDriverListResponseSchema.safeParse({ items: [{ id, fullName: 'A' }] }).success,
    ).toBe(true);
    expect(
      staffDriverListResponseSchema.safeParse({ items: [{ id, fullName: 'A', phone: '+998' }] })
        .success,
    ).toBe(false);
  });

  it('builds paths', () => {
    expect(buildPath(ORDER_ROUTES.setCartItem, { productId: id })).toBe('/cart/items/' + id);
    expect(buildPath(STAFF_ORDER_ROUTES.releaseOrder, { id })).toBe(
      '/staff/orders/' + id + '/release',
    );
    expect(buildPath(ORDER_ROUTES.listOrders)).toBe('/orders');
  });
});

describe('staff order contracts stay out of the customer barrel', () => {
  const STAFF_ONLY = [
    'STAFF_ORDER_ROUTES',
    'ACCOUNTING_MODES',
    'ORDER_EVENT_TYPES',
    'NOTIFICATION_TYPES',
    'NOTIFICATION_STATUSES',
    'NOTIFICATION_RECIPIENT_KINDS',
    'MAX_EDIT_CHANGES',
    'ORDER_SEARCH_MAX_LENGTH',
    'approveOrderRequestSchema',
    'orderDecisionWithReasonRequestSchema',
    'orderDecisionWithCommentRequestSchema',
    'releaseOrderRequestSchema',
    'editOrderItemsRequestSchema',
    'setPaymentMethodRequestSchema',
    'PAYMENT_METHODS',
    'paymentMethodSchema',
    'staffOrderListQuerySchema',
    'staffOrderPersonSchema',
    'deliveryContactSchema',
    'staffOrderSchema',
    'staffOrderSummarySchema',
    'staffOrderListResponseSchema',
    'timelineNotificationSchema',
    'staffTimelineEventSchema',
    'staffTimelineResponseSchema',
  ];

  it('every staff-only name is an export of the staff-orders entry and not of the barrel', () => {
    for (const name of STAFF_ONLY) {
      expect(Object.keys(staffOrders), name).toContain(name);
      expect(Object.keys(shared), name + ' must not be in the barrel').not.toContain(name);
    }
  });

  it('the barrel carries no staff route path', () => {
    const text = JSON.stringify(Object.values(shared).filter((v) => typeof v !== 'function'));
    expect(text).not.toContain('/staff/orders');
    expect(text).not.toContain('SKIPPED_BY_MANAGER');
  });
});

describe('payment plan contract', () => {
  it('the customer must send a known plan', () => {
    const expectedTotalAmount = '100.00';
    for (const paymentPlan of ['FULL', 'DEFERRED']) {
      expect(submitOrderRequestSchema.safeParse({ paymentPlan, expectedTotalAmount }).success).toBe(
        true,
      );
    }
    expect(submitOrderRequestSchema.safeParse({}).success).toBe(false);
    expect(submitOrderRequestSchema.safeParse({ expectedTotalAmount }).success).toBe(false);
    // The total the customer was shown is required too.
    expect(submitOrderRequestSchema.safeParse({ paymentPlan: 'FULL' }).success).toBe(false);
    // The payment method ("Savdo turi") is a different thing.
    expect(
      submitOrderRequestSchema.safeParse({ paymentPlan: 'CASH', expectedTotalAmount }).success,
    ).toBe(false);
  });
});

describe("the manager's new order contract [C, owner 2026-11-20]", () => {
  const { createStaffOrderRequestSchema, newOrderCatalogItemSchema, newOrderCustomerQuerySchema } =
    staffOrders;
  const productId = '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0b';
  const valid = {
    organizationId: '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0c',
    placedByUserId: '0195f0a0-1c2d-7e3f-8a4b-5c6d7e8f9a0d',
    paymentPlan: 'FULL',
    lines: [{ productId, quantity: '2' }],
    expectedTotalAmount: '3000.00',
  };

  it('requires a plan (nothing preselected), whole quantities and one line per product', () => {
    expect(createStaffOrderRequestSchema.safeParse(valid).success).toBe(true);
    expect(createStaffOrderRequestSchema.safeParse({ ...valid, comment: 'Ertaga' }).success).toBe(
      true,
    );
    const { paymentPlan: _plan, ...noPlan } = valid;
    void _plan;
    expect(createStaffOrderRequestSchema.safeParse(noPlan).success).toBe(false);
    expect(
      createStaffOrderRequestSchema.safeParse({ ...valid, lines: [{ productId, quantity: '1.5' }] })
        .success,
    ).toBe(false);
    expect(createStaffOrderRequestSchema.safeParse({ ...valid, lines: [] }).success).toBe(false);
    expect(
      createStaffOrderRequestSchema.safeParse({
        ...valid,
        lines: [
          { productId, quantity: '1' },
          { productId, quantity: '2' },
        ],
      }).success,
    ).toBe(false);
    expect(createStaffOrderRequestSchema.safeParse({ ...valid, extra: 1 }).success).toBe(false);
  });

  it('filters customers by the real types and labels only', () => {
    expect(newOrderCustomerQuerySchema.safeParse({ label: 'ALIF_FACTORING' }).success).toBe(true);
    expect(newOrderCustomerQuerySchema.safeParse({ type: 'PERSON' }).success).toBe(true);
    expect(newOrderCustomerQuerySchema.safeParse({ label: 'VIP' }).success).toBe(false);
  });

  it('a catalog item has no cost field (strict)', () => {
    const item = {
      productId,
      productCode: '40799',
      name: 'Air Fryer',
      category: null,
      brand: 'Xiaomi',
      imageUrl: null,
      imageLargeUrl: null,
      unitPrice: '1500.00',
      deferredUnitPrice: null,
      stock: 28,
    };
    expect(newOrderCatalogItemSchema.safeParse(item).success).toBe(true);
    expect(newOrderCatalogItemSchema.safeParse({ ...item, stock: null }).success).toBe(true);
    expect(newOrderCatalogItemSchema.safeParse({ ...item, costUsd: '1.00' }).success).toBe(false);
  });
});
