import type { StaffRole } from '@iorder/shared';
import type { GoodsReturnState } from '@iorder/shared/staff-orders';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { isStaffActor } from './order-actor.js';
import type { OrderRecord } from './orders.repository.js';
import type {
  FulfilmentOrderDetails,
  OrderSummaryView,
  OrderView,
  StaffOrderDetails,
} from './order.views.js';

/** Staff roles that may see how an order was priced and cleared (decision 8e). */
const FULL_DETAIL_ROLES: readonly StaffRole[] = [
  'MANAGER',
  'ACCOUNTANT',
  'ADMIN',
  'PURCHASING_MANAGER',
];

/** True when the actor holds a role that may see money, payment and accounting facts. */
export function seesFullOrderDetail(actor: Actor): boolean {
  return actor.staffRoles.some((role) => FULL_DETAIL_ROLES.includes(role));
}

/**
 * Does the warehouse have goods to bring back? Only an order closed after the manager's approval
 * can. A return time without a person means the order closed before this rule: nothing to do.
 */
export function goodsReturnStateOf(
  order: Pick<OrderRecord, 'status' | 'managerApprovedAt' | 'goodsReturnedAt' | 'goodsReturnedBy'>,
): GoodsReturnState {
  const closed = order.status === 'REJECTED' || order.status === 'CANCELLED';
  if (!closed || order.managerApprovedAt === null) return 'NOT_NEEDED';
  if (order.goodsReturnedBy !== null) return 'RETURNED';
  return order.goodsReturnedAt === null ? 'PENDING' : 'NOT_NEEDED';
}

function staffDetails(
  order: OrderRecord,
  actor: Actor,
): StaffOrderDetails | FulfilmentOrderDetails | null {
  if (!isStaffActor(actor)) return null;
  const goodsReturn = goodsReturnStateOf(order);
  const goodsReturnedAt = order.goodsReturnedBy === null ? null : order.goodsReturnedAt;
  if (!seesFullOrderDetail(actor)) {
    return {
      detail: 'FULFILMENT',
      driverUserId: order.driverUserId,
      goodsReturn,
      goodsReturnedAt,
    };
  }
  return {
    detail: 'FULL',
    priceListVersionId: order.priceListVersionId,
    accountingMode: order.accountingMode,
    accountingClearedAt: order.accountingClearedAt,
    accountingReviewedAt: order.accountingReviewedAt,
    accountingReviewedBy: order.accountingReviewedBy,
    driverUserId: order.driverUserId,
    usdRate: order.usdRate,
    totalUsd: order.totalUsd,
    goodsReturn,
    goodsReturnedAt,
    // The admin also gets FULL detail but not the payment method ([C] 2026-10-24).
    ...(can(actor, 'VIEW_PAYMENT_METHOD') ? { paymentMethod: order.paymentMethod } : {}),
  };
}

/**
 * Explicit field-by-field mapping (never a spread of the record): a new database column cannot
 * reach a response by accident. Customers receive no staff details.
 */
export function toOrderSummary(order: OrderRecord, actor: Actor): OrderSummaryView {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    organizationId: order.organizationId,
    placedByUserId: order.placedByUserId,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentPlan: order.paymentPlan,
    totalAmount: order.totalAmount,
    currency: 'UZS',
    customerComment: order.customerComment,
    submittedAt: order.submittedAt,
    updatedAt: order.updatedAt,
    rowVersion: order.rowVersion,
    itemCount: order.items.length,
    staff: staffDetails(order, actor),
  };
}

export function toOrderView(order: OrderRecord, actor: Actor): OrderView {
  return {
    ...toOrderSummary(order, actor),
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productCode: item.productCodeSnapshot,
      name: item.nameSnapshot,
      unit: item.unitSnapshot,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      fullUnitPrice: item.fullUnitPrice,
      deferredUnitPrice: item.deferredUnitPrice,
      stockTracked: item.stockTracked,
    })),
  };
}
