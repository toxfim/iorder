import type { OrderStatus, PaymentPlan, PaymentStatus } from '@iorder/shared';
import type { AccountingMode, GoodsReturnState, PaymentMethod } from '@iorder/shared/staff-orders';
import type { Prisma } from '../../generated/prisma/client.js';

// Plain domain objects returned by the orders services. NOT Prisma entities and NOT HTTP DTOs
// (a later task maps them to DTOs). Nothing here carries cost data (hard rule 7): an order holds
// only what the customer saw when ordering.

export interface OrderItemView {
  id: string;
  productId: string;
  productCode: string;
  name: string;
  unit: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  fullUnitPrice: Prisma.Decimal;
  deferredUnitPrice: Prisma.Decimal | null;
  /** False: a staff-added product outside the allocation plan (staff DTOs only). */
  stockTracked: boolean;
}

/**
 * Facts for manager, accountant and admin: how the accounting step was passed, who drives, which
 * list priced it. The warehouse and the driver get FulfilmentOrderDetails instead.
 */
export interface StaffOrderDetails {
  detail: 'FULL';
  priceListVersionId: string;
  accountingMode: AccountingMode;
  accountingClearedAt: Date | null;
  accountingReviewedAt: Date | null;
  accountingReviewedBy: string | null;
  driverUserId: string | null;
  /** Frozen at submit; cost-class, so never in a customer or fulfilment view. */
  usdRate: Prisma.Decimal;
  totalUsd: Prisma.Decimal;
  /** Present only for manager and accountant (VIEW_PAYMENT_METHOD); null until approval. */
  paymentMethod?: PaymentMethod | null;
  goodsReturn: GoodsReturnState;
  goodsReturnedAt: Date | null;
}

/**
 * What the warehouse and the driver need for their step: who the driver is. Items are in the
 * order view; no accounting mode, no price list version.
 */
export interface FulfilmentOrderDetails {
  detail: 'FULFILMENT';
  driverUserId: string | null;
  goodsReturn: GoodsReturnState;
  goodsReturnedAt: Date | null;
}

export interface OrderSummaryView {
  id: string;
  orderNumber: string;
  organizationId: string;
  placedByUserId: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentPlan: PaymentPlan;
  totalAmount: Prisma.Decimal;
  currency: 'UZS';
  customerComment: string | null;
  submittedAt: Date;
  updatedAt: Date;
  rowVersion: number;
  itemCount: number;
  /** Null for customers, who never see accounting internals. */
  staff: StaffOrderDetails | FulfilmentOrderDetails | null;
}

export interface OrderView extends OrderSummaryView {
  items: OrderItemView[];
}

export interface OrderPage {
  orders: OrderSummaryView[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

/** The customer may still change the plan until `until`; what each plan would cost. */
export interface PaymentPlanChangeOffer {
  until: Date;
  fullTotal: Prisma.Decimal;
  /** Null: a line of the order has no deferred price, so that plan is impossible. */
  deferredTotal: Prisma.Decimal | null;
}

export interface CartLineView {
  productId: string;
  productCode: string;
  name: string;
  unit: string;
  quantity: Prisma.Decimal;
  /** Null when the product cannot be ordered now (see `problem`). */
  unitPrice: Prisma.Decimal | null;
  lineTotal: Prisma.Decimal | null;
  /** Null when the product has no deferred price or cannot be ordered now. */
  deferredUnitPrice: Prisma.Decimal | null;
  deferredLineTotal: Prisma.Decimal | null;
  /** The recommended retail price of one piece; null when none or the product cannot be ordered now. */
  rrp: Prisma.Decimal | null;
  /**
   * How many whole pieces can be ordered now [C, 2026-11-09]; zero = out of stock; null = no
   * figure and no cap, also when the product cannot be ordered for another reason.
   */
  orderableStock: Prisma.Decimal | null;
  /**
   * INCOMPLETE: the product has no unit or name yet (for example created from the sheet).
   * STOCK_EXCEEDED: the product can be ordered, but the quantity is above `orderableStock` (the
   * stock fell after the line was put in the cart); the line keeps its prices.
   */
  problem: 'INACTIVE' | 'NOT_PRICED' | 'INCOMPLETE' | 'STOCK_EXCEEDED' | null;
}

export interface CartView {
  /** Null while no price list is published. */
  priceListVersionNumber: number | null;
  lines: CartLineView[];
  /** Sum of the priced lines (a line above the stock still has its price), at the sale price (plan FULL). */
  totalAmount: Prisma.Decimal;
  /** Plan DEFERRED; null (not choosable) unless every line has a deferred price. */
  deferredTotalAmount: Prisma.Decimal | null;
  currency: 'UZS';
  canSubmit: boolean;
}
