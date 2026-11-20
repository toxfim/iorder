import type {
  CartResponse,
  CustomerOrder,
  CustomerOrderListResponse,
  CustomerOrderSummary,
} from '@iorder/shared';
import type {
  StaffOrder,
  StaffOrderListResponse,
  StaffOrderSummary,
} from '@iorder/shared/staff-orders';
import { CURRENCY } from '@iorder/shared';
import type { Actor } from '../../../common/auth/actor.js';
import type {
  ItemAllocations,
  OrderItemAllocationView,
} from '../order-item-allocations.service.js';
import type { DeliveryContactView, OrderDirectory } from '../order-directory.service.js';
import { formatAmount, formatQuantity } from '../order-lines.js';
import { toPieceCount } from '../../pricing/index.js';
import type {
  CartView,
  FulfilmentOrderDetails,
  OrderItemView,
  OrderPage,
  OrderSummaryView,
  OrderView,
  PaymentPlanChangeOffer,
  StaffOrderDetails,
} from '../order.views.js';

// Explicit allow-lists, field by field; nothing is spread from a view, so a field added to a
// view later never reaches a response by accident (hard rule 7). The SHAPES are defined in
// @iorder/shared and the api tests parse live responses with those strict schemas.

export function toCartResponse(cart: CartView): CartResponse {
  return {
    priceListVersionNumber: cart.priceListVersionNumber,
    lines: cart.lines.map((line) => ({
      productId: line.productId,
      productCode: line.productCode,
      name: line.name,
      unit: line.unit,
      quantity: formatQuantity(line.quantity),
      unitPrice: line.unitPrice === null ? null : formatAmount(line.unitPrice),
      lineTotal: line.lineTotal === null ? null : formatAmount(line.lineTotal),
      deferredUnitPrice:
        line.deferredUnitPrice === null ? null : formatAmount(line.deferredUnitPrice),
      deferredLineTotal:
        line.deferredLineTotal === null ? null : formatAmount(line.deferredLineTotal),
      // Customer-visible by the owner's decision [C, 2026-11-09]; a price, never cost data.
      rrp: line.rrp === null ? null : formatAmount(line.rrp),
      // Customer-visible by the owner's decision [C, 2026-11-09]: whole pieces, nothing else.
      orderableStock: toPieceCount(line.orderableStock),
      problem: line.problem,
    })),
    totalAmount: formatAmount(cart.totalAmount),
    deferredTotalAmount:
      cart.deferredTotalAmount === null ? null : formatAmount(cart.deferredTotalAmount),
    currency: CURRENCY,
    canSubmit: cart.canSubmit,
  };
}

// ------------------------------------------------------------------ customer

function customerSummary(
  order: OrderSummaryView,
  actor: Actor,
  directory: OrderDirectory,
): CustomerOrderSummary {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentPlan: order.paymentPlan,
    totalAmount: formatAmount(order.totalAmount),
    currency: CURRENCY,
    itemCount: order.itemCount,
    customerComment: order.customerComment,
    placedByName: directory.person(order.placedByUserId)?.fullName ?? '',
    placedByMe: order.placedByUserId === actor.userId,
    submittedAt: order.submittedAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    rowVersion: order.rowVersion,
  };
}

function priced(item: OrderItemView): CustomerOrder['items'][number] {
  return {
    id: item.id,
    productId: item.productId,
    productCode: item.productCode,
    name: item.name,
    unit: item.unit,
    quantity: formatQuantity(item.quantity),
    unitPrice: formatAmount(item.unitPrice),
    lineTotal: formatAmount(item.lineTotal),
  };
}

export function toItemAllocation(allocation: OrderItemAllocationView) {
  return {
    supplyRef: allocation.supplyRef,
    partyNumber: allocation.partyNumber,
    quantity: formatQuantity(allocation.quantity),
  };
}

function pricedForStaff(
  item: OrderItemView,
  allocations: ItemAllocations | null,
): Extract<StaffOrder, { detail: 'FULL' }>['items'][number] {
  return {
    ...priced(item),
    fullUnitPrice: formatAmount(item.fullUnitPrice),
    deferredUnitPrice:
      item.deferredUnitPrice === null ? null : formatAmount(item.deferredUnitPrice),
    allocations: (allocations?.get(item.id) ?? []).map(toItemAllocation),
    stockTracked: item.stockTracked,
  };
}

export function toCustomerOrder(
  order: OrderView,
  actor: Actor,
  directory: OrderDirectory,
  planChange: PaymentPlanChangeOffer | null,
): CustomerOrder {
  return {
    ...customerSummary(order, actor, directory),
    items: order.items.map(priced),
    paymentPlanChangeableUntil: planChange?.until.toISOString() ?? null,
    paymentPlanTotals:
      planChange === null
        ? null
        : {
            FULL: formatAmount(planChange.fullTotal),
            DEFERRED:
              planChange.deferredTotal === null ? null : formatAmount(planChange.deferredTotal),
          },
  };
}

export function toCustomerOrderList(
  page: OrderPage,
  actor: Actor,
  directory: OrderDirectory,
): CustomerOrderListResponse {
  return {
    orders: page.orders.map((order) => customerSummary(order, actor, directory)),
    nextCursor: page.nextCursor,
  };
}

// --------------------------------------------------------------------- staff

function person(directory: OrderDirectory, userId: string | null) {
  const found = directory.person(userId);
  return found === null ? null : { ...found };
}

function placedBy(directory: OrderDirectory, userId: string) {
  // A user row always exists (foreign key); the fallback only keeps the type honest.
  return person(directory, userId) ?? { userId, fullName: '', phone: null };
}

function staffBase(
  order: OrderSummaryView,
  directory: OrderDirectory,
  detail: StaffOrderDetails | FulfilmentOrderDetails,
) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    organizationId: order.organizationId,
    organizationName: directory.organizationName(order.organizationId),
    organizationType: directory.organizationType(order.organizationId),
    status: order.status,
    itemCount: order.itemCount,
    submittedAt: order.submittedAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
    rowVersion: order.rowVersion,
    driver: person(directory, detail.driverUserId),
    goodsReturn: detail.goodsReturn,
    goodsReturnedAt: detail.goodsReturnedAt?.toISOString() ?? null,
  };
}

function fullSummary(
  order: OrderSummaryView,
  detail: StaffOrderDetails,
  directory: OrderDirectory,
): Extract<StaffOrderSummary, { detail: 'FULL' }> {
  return {
    ...staffBase(order, directory, detail),
    detail: 'FULL',
    organizationLabel: directory.organizationLabel(order.organizationId),
    paymentStatus: order.paymentStatus,
    paymentPlan: order.paymentPlan,
    totalAmount: formatAmount(order.totalAmount),
    currency: CURRENCY,
    usdRate: detail.usdRate.toFixed(4),
    totalUsd: formatAmount(detail.totalUsd),
    customerComment: order.customerComment,
    placedBy: placedBy(directory, order.placedByUserId),
    priceListVersionId: detail.priceListVersionId,
    accounting: {
      mode: detail.accountingMode,
      clearedAt: detail.accountingClearedAt?.toISOString() ?? null,
      reviewedAt: detail.accountingReviewedAt?.toISOString() ?? null,
      reviewedByUserId: detail.accountingReviewedBy,
    },
    ...(detail.paymentMethod === undefined ? {} : { paymentMethod: detail.paymentMethod }),
  };
}

function fulfilmentSummary(
  order: OrderSummaryView,
  detail: FulfilmentOrderDetails,
  directory: OrderDirectory,
): Extract<StaffOrderSummary, { detail: 'FULFILMENT' }> {
  return { ...staffBase(order, directory, detail), detail: 'FULFILMENT' };
}

/** A staff view always carries a `staff` block; a customer view reaching here is a bug. */
function requireStaffDetail(order: OrderSummaryView): StaffOrderDetails | FulfilmentOrderDetails {
  if (order.staff === null) throw new Error('A staff response needs the staff block of the view');
  return order.staff;
}

export function toStaffOrderSummary(
  order: OrderSummaryView,
  directory: OrderDirectory,
): StaffOrderSummary {
  const detail = requireStaffDetail(order);
  return detail.detail === 'FULL'
    ? fullSummary(order, detail, directory)
    : fulfilmentSummary(order, detail, directory);
}

export function toStaffOrderList(
  page: OrderPage,
  directory: OrderDirectory,
): StaffOrderListResponse {
  return {
    orders: page.orders.map((order) => toStaffOrderSummary(order, directory)),
    nextCursor: page.nextCursor,
  };
}

function contact(view: DeliveryContactView) {
  return {
    organizationName: view.organizationName,
    contacts: view.contacts.map((c) => ({
      userId: c.userId,
      fullName: c.fullName,
      phone: c.phone,
      placedTheOrder: c.placedTheOrder,
      isShopOwner: c.isShopOwner,
    })),
  };
}

/** `allocations`: null when the reader may not see supplies (the driver); the field is then absent. */
export function toStaffOrder(
  order: OrderView,
  directory: OrderDirectory,
  allocations: ItemAllocations | null,
): StaffOrder {
  const detail = requireStaffDetail(order);
  const deliveryContact = directory.deliveryContact(order);
  if (detail.detail === 'FULL') {
    return {
      ...fullSummary(order, detail, directory),
      items: order.items.map((item) => pricedForStaff(item, allocations)),
      deliveryContact: deliveryContact === null ? null : contact(deliveryContact),
    };
  }
  // Warehouse and driver: what to pack and where to go. No prices, no totals, no accounting.
  if (deliveryContact === null) throw new Error('The fulfilment roles must get a delivery contact');
  return {
    ...fulfilmentSummary(order, detail, directory),
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productCode: item.productCode,
      name: item.name,
      unit: item.unit,
      quantity: formatQuantity(item.quantity),
      ...(allocations === null
        ? {}
        : { allocations: (allocations.get(item.id) ?? []).map(toItemAllocation) }),
      stockTracked: item.stockTracked,
    })),
    deliveryContact: contact(deliveryContact),
  };
}
