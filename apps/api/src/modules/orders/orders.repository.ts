import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { OrderStatus, PaymentPlan, PaymentStatus, PriceTier } from '@iorder/shared';
import type { AccountingMode, PaymentMethod } from '@iorder/shared/staff-orders';
import type { ScopeFilter } from '../../common/auth/scope-for.js';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { escapeLike } from '../../common/database/like.js';
import { PrismaService } from '../../common/database/prisma.service.js';
import { runInTransaction } from '../../common/database/transaction.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { AuditValue } from '../audit/index.js';
import type { OutboxRowInput } from './order-notifications.js';
import type {
  NotificationRecipientKind,
  NotificationStatus,
  OrderEventType,
} from './order-types.js';

export interface OrderItemRecord {
  id: string;
  productId: string;
  productCodeSnapshot: string;
  nameSnapshot: string;
  unitSnapshot: string;
  quantity: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  lineTotal: Prisma.Decimal;
  fullUnitPrice: Prisma.Decimal;
  deferredUnitPrice: Prisma.Decimal | null;
  /** Staff-only; never leaves the module (the views have no such field). */
  fullUnitPriceUsd: Prisma.Decimal | null;
  deferredUnitPriceUsd: Prisma.Decimal | null;
  /**
   * False for a staff-added product without a sheet code [C, 2026-11-09]: it has no delivery lines
   * and is outside the allocation plan (no hold, never short). Read live from the product.
   */
  stockTracked: boolean;
}

/** Everything the services need to know about an order. Never leaves the module. */
export interface OrderRecord {
  id: string;
  orderNumber: string;
  organizationId: string;
  placedByUserId: string;
  priceListVersionId: string;
  /** The price list tier the order was priced with (frozen) [C, owner 2026-11-11]. */
  priceTier: PriceTier;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  paymentPlan: PaymentPlan;
  managerApprovedAt: Date | null;
  accountingMode: AccountingMode;
  accountingClearedAt: Date | null;
  accountingReviewedAt: Date | null;
  accountingReviewedBy: string | null;
  driverUserId: string | null;
  goodsReturnedAt: Date | null;
  goodsReturnedBy: string | null;
  totalAmount: Prisma.Decimal;
  currency: string;
  /** Staff-only: frozen at submit. */
  usdRate: Prisma.Decimal;
  /** Staff-only: the sum of the lines' USD values, six decimals (orderTotalUsd). */
  totalUsd: Prisma.Decimal;
  customerComment: string | null;
  idempotencyKey: string;
  rowVersion: number;
  submittedAt: Date;
  updatedAt: Date;
  items: OrderItemRecord[];
}

export interface NewOrder {
  orderNumber: string;
  organizationId: string;
  placedByUserId: string;
  priceListVersionId: string;
  priceTier: PriceTier;
  idempotencyKey: string;
  paymentPlan: PaymentPlan;
  totalAmount: Prisma.Decimal;
  usdRate: Prisma.Decimal;
  totalUsd: Prisma.Decimal;
  customerComment: string | null;
  now: Date;
  /** `stockTracked` is read live from the product, never stored. */
  items: Omit<OrderItemRecord, 'id' | 'stockTracked'>[];
}

/**
 * What a manager edit may write: the totals and the plan (row_version is bumped). Never the status,
 * never the rate.
 */
export interface OrderEditData {
  totalAmount: Prisma.Decimal;
  totalUsd: Prisma.Decimal;
  paymentPlan?: PaymentPlan;
  updatedAt: Date;
}

/** One legal move of the state machine and the facts that go with it. */
export interface OrderTransitionData {
  status: OrderStatus;
  updatedAt: Date;
  /** The first step of a transition bumps row_version; a second step (skip accounting) does not. */
  bumpRowVersion: boolean;
  managerApprovedAt?: Date;
  accountingMode?: AccountingMode;
  accountingClearedAt?: Date;
  driverUserId?: string | null;
  paymentMethod?: PaymentMethod;
  receivedAt?: Date;
}

export interface NewOrderEvent {
  orderId: string;
  eventType: OrderEventType;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  actorUserId: string | null;
  actorRole: string;
  comment: string | null;
  payload: { before: AuditValue; after: AuditValue };
  createdAt: Date;
}

/** Which orders match; shared by the list and its counts. */
export interface OrderMatchQuery {
  filters: readonly ScopeFilter[];
  statuses?: readonly OrderStatus[];
  status?: OrderStatus;
  paymentStatus?: PaymentStatus;
  organizationId?: string;
  placedByUserId?: string;
  /** Submitted in [from, to) (the caller owns the business day). */
  submitted?: { from: Date; to: Date };
  search?: OrderSearch;
  /** Only the orders whose goods still have to come back. */
  goodsReturnPending?: true;
}

/**
 * Part of the order number, OR one of the organizations / people whose name matched (found by
 * their own modules: this module never reads their tables).
 */
export interface OrderSearch {
  text: string;
  organizationIds?: readonly string[];
  placedByUserIds?: readonly string[];
}

export interface OrderListQuery extends OrderMatchQuery {
  limit: number;
  cursor?: string;
}

/** An order_events row as stored; the payload is JSON of unknown shape until the reader parses it. */
export interface OrderEventRecord {
  id: string;
  eventType: OrderEventType;
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus | null;
  actorUserId: string | null;
  actorRole: string;
  comment: string | null;
  payload: unknown;
  createdAt: Date;
}

/** A notification_outbox row WITHOUT its payload: the timeline needs the fact, not the message. */
export interface OutboxRecord {
  id: string;
  type: string;
  recipientKind: NotificationRecipientKind;
  recipientUserId: string | null;
  recipientRole: string | null;
  recipientOrganizationId: string | null;
  status: NotificationStatus;
  attempts: number;
  dedupeKey: string;
  /** The event this message belongs to; null for rows written before the link existed. */
  orderEventId: string | null;
  createdAt: Date;
  sentAt: Date | null;
}

/** An outbox row together with the (already inserted) event it announces. */
export type LinkedOutboxRow = OutboxRowInput & { orderEventId: string };

export interface CartItemRecord {
  productId: string;
  quantity: Prisma.Decimal;
}

const WITH_ITEMS = {
  items: {
    orderBy: [{ productCodeSnapshot: 'asc' }, { id: 'asc' }],
    // Only the one flag the plan needs; no other product column reaches an order record this way.
    include: { product: { select: { codeGenerated: true } } },
  },
} satisfies Prisma.OrderInclude;

type OrderRow = Prisma.OrderGetPayload<{ include: typeof WITH_ITEMS }>;

function toRecord(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    organizationId: row.organizationId,
    placedByUserId: row.placedByUserId,
    priceListVersionId: row.priceListVersionId,
    priceTier: row.priceTier,
    status: row.status,
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    paymentPlan: row.paymentPlan,
    managerApprovedAt: row.managerApprovedAt,
    accountingMode: row.accountingMode,
    accountingClearedAt: row.accountingClearedAt,
    accountingReviewedAt: row.accountingReviewedAt,
    accountingReviewedBy: row.accountingReviewedBy,
    driverUserId: row.driverUserId,
    goodsReturnedAt: row.goodsReturnedAt,
    goodsReturnedBy: row.goodsReturnedBy,
    totalAmount: row.totalAmount,
    currency: row.currency,
    usdRate: row.usdRate,
    totalUsd: row.totalUsd,
    customerComment: row.customerComment,
    idempotencyKey: row.idempotencyKey,
    rowVersion: row.rowVersion,
    submittedAt: row.submittedAt,
    updatedAt: row.updatedAt,
    items: row.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productCodeSnapshot: item.productCodeSnapshot,
      nameSnapshot: item.nameSnapshot,
      unitSnapshot: item.unitSnapshot,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      lineTotal: item.lineTotal,
      fullUnitPrice: item.fullUnitPrice,
      deferredUnitPrice: item.deferredUnitPrice,
      fullUnitPriceUsd: item.fullUnitPriceUsd,
      deferredUnitPriceUsd: item.deferredUnitPriceUsd,
      stockTracked: !item.product.codeGenerated,
    })),
  };
}

// One builder per ScopeFilter field. The mapped type makes a new field without a builder a
// compile error, so the query scope can never silently drop a restriction (fail-open).
type WhereBuilders = {
  [K in keyof ScopeFilter]-?: (value: NonNullable<ScopeFilter[K]>) => Prisma.OrderWhereInput;
};

const WHERE_BUILDERS: WhereBuilders = {
  organizationId: (value) => ({ organizationId: value }),
  placedByUserId: (value) => ({ placedByUserId: value }),
  assignedDriverId: (value) => ({ driverUserId: value }),
  managerApproved: () => ({ managerApprovedAt: { not: null } }),
  statuses: (value) => ({ status: { in: [...value] } }),
};

/** All present fields of one filter are ANDed; a filter without fields matches everything. */
function filterToWhere(filter: ScopeFilter): Prisma.OrderWhereInput | null {
  const parts: Prisma.OrderWhereInput[] = [];
  for (const key of Object.keys(WHERE_BUILDERS) as (keyof ScopeFilter)[]) {
    const value = filter[key];
    if (value === undefined) continue;
    parts.push((WHERE_BUILDERS[key] as (v: unknown) => Prisma.OrderWhereInput)(value));
  }
  return parts.length === 0 ? null : { AND: parts };
}

/** The OR of an actor's scope filters. `null` = unrestricted ("all"); the caller handles "nothing". */
function matchWhere(query: OrderMatchQuery): Prisma.OrderWhereInput {
  const scope = scopeToWhere(query.filters);
  return {
    AND: [
      ...(scope === null ? [] : [scope]),
      ...(query.status === undefined ? [] : [{ status: query.status }]),
      ...(query.statuses === undefined ? [] : [{ status: { in: [...query.statuses] } }]),
      ...(query.paymentStatus === undefined ? [] : [{ paymentStatus: query.paymentStatus }]),
      ...(query.organizationId === undefined ? [] : [{ organizationId: query.organizationId }]),
      ...(query.placedByUserId === undefined ? [] : [{ placedByUserId: query.placedByUserId }]),
      ...(query.submitted === undefined
        ? []
        : [{ submittedAt: { gte: query.submitted.from, lt: query.submitted.to } }]),
      ...(query.search === undefined ? [] : [searchWhere(query.search)]),
      ...(query.goodsReturnPending === undefined ? [] : [GOODS_RETURN_PENDING]),
    ],
  };
}

/** The database form of the PENDING state of `goodsReturnStateOf`. */
const GOODS_RETURN_PENDING: Prisma.OrderWhereInput = {
  status: { in: ['REJECTED', 'CANCELLED'] },
  managerApprovedAt: { not: null },
  goodsReturnedAt: null,
};

function searchWhere(search: OrderSearch): Prisma.OrderWhereInput {
  const organizations = search.organizationIds ?? [];
  const people = search.placedByUserIds ?? [];
  return {
    OR: [
      { orderNumber: { contains: escapeLike(search.text), mode: 'insensitive' } },
      ...(organizations.length === 0 ? [] : [{ organizationId: { in: [...organizations] } }]),
      ...(people.length === 0 ? [] : [{ placedByUserId: { in: [...people] } }]),
    ],
  };
}

export function scopeToWhere(filters: readonly ScopeFilter[]): Prisma.OrderWhereInput | null {
  const alternatives: Prisma.OrderWhereInput[] = [];
  for (const filter of filters) {
    const where = filterToWhere(filter);
    if (where === null) return null;
    alternatives.push(where);
  }
  return { OR: alternatives };
}

/** The WHERE of a scope for queries that have no other filter; no filter at all means "all". */
function scopedWhere(filters: readonly ScopeFilter[]): Prisma.OrderWhereInput {
  return scopeToWhere(filters) ?? {};
}

// The statuses a dashboard queue shows an age for (the rest are not work waiting for somebody).
const WAITING_STATUSES: readonly OrderStatus[] = [
  'SUBMITTED',
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
  'RELEASED',
];

@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return runInTransaction(this.prisma, work);
  }

  /** The plain client for reads that need no transaction. */
  get db(): DbClient {
    return this.prisma;
  }

  // ------------------------------------------------------------------ orders

  /**
   * Row lock on the order until the transaction ends: picking scans and the release take it
   * first, so a code cannot be removed between the release's completeness check and its commit.
   */
  async lockOrder(tx: Tx, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM orders WHERE id = ${id}::uuid FOR UPDATE`;
  }

  /** What SUBMITTED orders placed before this one want per product. They hold nothing yet. */
  async earlierDemand(
    db: DbClient,
    orderId: string,
    productIds: readonly string[],
    before: Date,
  ): Promise<Map<string, { orders: number; quantity: Prisma.Decimal }>> {
    if (productIds.length === 0) return new Map();
    const ids = [...productIds];
    const rows = await db.$queryRaw<
      { productId: string; orders: number; quantity: Prisma.Decimal }[]
    >`
      SELECT i.product_id AS "productId", COUNT(DISTINCT o.id)::int AS orders,
             SUM(i.quantity) AS quantity
      FROM order_items i
      JOIN orders o ON o.id = i.order_id
      WHERE o.status = 'SUBMITTED' AND o.id <> ${orderId}::uuid AND o.submitted_at < ${before}
        AND i.product_id = ANY(${ids}::uuid[])
      GROUP BY i.product_id`;
    return new Map(rows.map((row) => [row.productId, row]));
  }

  async findById(id: string, db: DbClient = this.prisma): Promise<OrderRecord | null> {
    const row = await db.order.findUnique({ where: { id }, include: WITH_ITEMS });
    return row ? toRecord(row) : null;
  }

  /** The customer's read: the organization is part of the query (hard rule 6). */
  async findByIdInOrganization(
    id: string,
    organizationId: string,
    db: DbClient = this.prisma,
  ): Promise<OrderRecord | null> {
    const row = await db.order.findFirst({ where: { id, organizationId }, include: WITH_ITEMS });
    return row ? toRecord(row) : null;
  }

  async findByIdempotencyKey(
    organizationId: string,
    key: string,
    db: DbClient = this.prisma,
  ): Promise<OrderRecord | null> {
    const row = await db.order.findUnique({
      where: { organizationId_idempotencyKey: { organizationId, idempotencyKey: key } },
      include: WITH_ITEMS,
    });
    return row ? toRecord(row) : null;
  }

  async nextOrderSequence(tx: Tx): Promise<bigint> {
    const rows = await tx.$queryRaw<
      { n: bigint }[]
    >`SELECT nextval('order_number_seq')::bigint AS n`;
    const value = rows[0]?.n;
    if (value === undefined) throw new Error('order_number_seq returned no value');
    return value;
  }

  async createOrder(tx: Tx, order: NewOrder): Promise<OrderRecord> {
    const row = await tx.order.create({
      data: {
        orderNumber: order.orderNumber,
        organizationId: order.organizationId,
        placedByUserId: order.placedByUserId,
        priceListVersionId: order.priceListVersionId,
        priceTier: order.priceTier,
        idempotencyKey: order.idempotencyKey,
        paymentPlan: order.paymentPlan,
        totalAmount: order.totalAmount,
        usdRate: order.usdRate,
        totalUsd: order.totalUsd,
        customerComment: order.customerComment,
        submittedAt: order.now,
        updatedAt: order.now,
        items: { create: order.items },
      },
      include: WITH_ITEMS,
    });
    return toRecord(row);
  }

  /**
   * Guarded write for everything EXCEPT the status (a manager edit): applies the new total (and
   * the payment plan, when the edit changes it) only
   * when the order still has the status and row_version the caller read, and bumps row_version.
   * Returns false when somebody else got there first. The data type has no `status` on purpose:
   * only `transitionGuarded` moves it.
   */
  async updateGuarded(
    tx: Tx,
    id: string,
    expected: { status: OrderStatus; rowVersion: number },
    data: OrderEditData,
  ): Promise<boolean> {
    const result = await tx.order.updateMany({
      where: { id, status: expected.status, rowVersion: expected.rowVersion },
      data: {
        totalAmount: data.totalAmount,
        totalUsd: data.totalUsd,
        ...(data.paymentPlan === undefined ? {} : { paymentPlan: data.paymentPlan }),
        rowVersion: { increment: 1 },
        updatedAt: data.updatedAt,
      },
    });
    return result.count === 1;
  }

  /**
   * THE status write (hard rule 2), used only by `OrdersService.transition` (an architecture test
   * enforces it). Conditional on the status and row_version the caller read; false when somebody
   * else got there first. One call is one legal move: the database trigger rejects any other pair.
   */
  async transitionGuarded(
    tx: Tx,
    id: string,
    expected: { status: OrderStatus; rowVersion: number },
    data: OrderTransitionData,
  ): Promise<boolean> {
    const result = await tx.order.updateMany({
      where: { id, status: expected.status, rowVersion: expected.rowVersion },
      data: {
        status: data.status,
        updatedAt: data.updatedAt,
        ...(data.bumpRowVersion ? { rowVersion: { increment: 1 } } : {}),
        ...(data.managerApprovedAt === undefined
          ? {}
          : { managerApprovedAt: data.managerApprovedAt }),
        ...(data.accountingMode === undefined ? {} : { accountingMode: data.accountingMode }),
        ...(data.accountingClearedAt === undefined
          ? {}
          : { accountingClearedAt: data.accountingClearedAt }),
        ...(data.driverUserId === undefined ? {} : { driverUserId: data.driverUserId }),
        ...(data.paymentMethod === undefined ? {} : { paymentMethod: data.paymentMethod }),
        ...(data.receivedAt === undefined ? {} : { receivedAt: data.receivedAt }),
      },
    });
    return result.count === 1;
  }

  /** Never the status. Conditional on the version that was read and on nobody having said so yet. */
  async markGoodsReturnedGuarded(
    tx: Tx,
    id: string,
    expectedRowVersion: number,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await tx.order.updateMany({
      where: { id, rowVersion: expectedRowVersion, goodsReturnedAt: null },
      data: {
        goodsReturnedAt: now,
        goodsReturnedBy: userId,
        rowVersion: { increment: 1 },
        updatedAt: now,
      },
    });
    return result.count === 1;
  }

  /** Guarded by the method that was read and by the status not moving. */
  async updatePaymentMethodGuarded(
    tx: Tx,
    id: string,
    expected: { paymentMethod: PaymentMethod | null; status: OrderStatus },
    next: PaymentMethod,
    now: Date,
  ): Promise<boolean> {
    const result = await tx.order.updateMany({
      where: { id, paymentMethod: expected.paymentMethod, status: expected.status },
      data: { paymentMethod: next, updatedAt: now },
    });
    return result.count === 1;
  }

  /**
   * The derived payment status (organization payments, [C] 2026-10-26). Guarded by the status that
   * was read; the caller holds the organization's ledger lock, so a miss is a bug, not a race.
   */
  async updatePaymentStatusGuarded(
    tx: Tx,
    id: string,
    expected: PaymentStatus,
    next: PaymentStatus,
    now: Date,
  ): Promise<boolean> {
    const result = await tx.order.updateMany({
      where: { id, paymentStatus: expected },
      data: { paymentStatus: next, updatedAt: now },
    });
    return result.count === 1;
  }

  async updateItemQuantity(
    tx: Tx,
    itemId: string,
    quantity: Prisma.Decimal,
    lineTotal: Prisma.Decimal,
  ): Promise<void> {
    await tx.orderItem.update({ where: { id: itemId }, data: { quantity, lineTotal } });
  }

  /** A plan change: the charged price moves to the other snapshot; the snapshots never change. */
  async updateItemPrice(
    tx: Tx,
    itemId: string,
    unitPrice: Prisma.Decimal,
    lineTotal: Prisma.Decimal,
  ): Promise<void> {
    await tx.orderItem.update({ where: { id: itemId }, data: { unitPrice, lineTotal } });
  }

  async deleteItem(tx: Tx, itemId: string): Promise<void> {
    await tx.orderItem.delete({ where: { id: itemId } });
  }

  /** Returns the new event ids in the order of `events`. */
  async insertEvents(tx: Tx, events: readonly NewOrderEvent[]): Promise<string[]> {
    const ids: string[] = [];
    // One INSERT per event so the sequence numbers follow the array order.
    for (const event of events) {
      const created = await tx.orderEvent.create({
        data: {
          orderId: event.orderId,
          eventType: event.eventType,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          actorUserId: event.actorUserId,
          actorRole: event.actorRole,
          comment: event.comment,
          // AuditValue admits only JSON-safe values; Prisma cannot see that through interfaces.
          payload: event.payload as unknown as Prisma.InputJsonObject,
          createdAt: event.createdAt,
        },
        select: { id: true },
      });
      ids.push(created.id);
    }
    return ids;
  }

  /** Duplicates (same dedupe key) are skipped, so a retried transition cannot double-notify. */
  async insertOutbox(tx: Tx, rows: readonly LinkedOutboxRow[], now: Date): Promise<void> {
    if (rows.length === 0) return;
    await tx.notificationOutbox.createMany({
      data: rows.map((row) => ({
        type: row.type,
        recipientKind: row.recipientKind,
        recipientUserId: row.recipientUserId,
        recipientRole: row.recipientRole,
        recipientOrganizationId: row.recipientOrganizationId,
        orderId: row.orderId,
        orderEventId: row.orderEventId,
        payload: row.payload as unknown as Prisma.InputJsonObject,
        dedupeKey: row.dedupeKey,
        createdAt: now,
      })),
      skipDuplicates: true,
    });
  }

  async list(query: OrderListQuery): Promise<{ rows: OrderRecord[]; hasMore: boolean }> {
    const where: Prisma.OrderWhereInput = {
      AND: [
        matchWhere(query),
        ...(query.cursor === undefined ? [] : [{ id: { lt: query.cursor } }]),
      ],
    };
    // uuid v7 ids sort by creation time, so "id desc" is "newest first" and a stable keyset.
    const rows = await this.prisma.order.findMany({
      where,
      orderBy: { id: 'desc' },
      take: query.limit + 1,
      include: WITH_ITEMS,
    });
    return { rows: rows.slice(0, query.limit).map(toRecord), hasMore: rows.length > query.limit };
  }

  /** How many orders match and the sum of their totals, per status (empty statuses left out). */
  async countMatching(
    query: OrderMatchQuery,
  ): Promise<
    { status: OrderStatus; count: number; total: Prisma.Decimal; totalUsd: Prisma.Decimal }[]
  > {
    const groups = await this.prisma.order.groupBy({
      by: ['status'],
      where: matchWhere(query),
      _count: { _all: true },
      _sum: { totalAmount: true, totalUsd: true },
    });
    return groups.map((group) => ({
      status: group.status,
      count: group._count._all,
      total: group._sum.totalAmount ?? new Prisma.Decimal(0),
      totalUsd: group._sum.totalUsd ?? new Prisma.Decimal(0),
    }));
  }

  /** The same as countMatching, per organization (organizations without any are left out). */
  async countMatchingByOrganization(
    query: OrderMatchQuery,
  ): Promise<
    { organizationId: string; count: number; total: Prisma.Decimal; totalUsd: Prisma.Decimal }[]
  > {
    const groups = await this.prisma.order.groupBy({
      by: ['organizationId'],
      where: matchWhere(query),
      _count: { _all: true },
      _sum: { totalAmount: true, totalUsd: true },
    });
    return groups.map((group) => ({
      organizationId: group.organizationId,
      count: group._count._all,
      total: group._sum.totalAmount ?? new Prisma.Decimal(0),
      totalUsd: group._sum.totalUsd ?? new Prisma.Decimal(0),
    }));
  }

  // --------------------------------------------------------------- aggregates

  // Read-only counts for the staff dashboard. Every one applies the caller's scope in the WHERE
  // clause (the same `scopeToWhere` as the list), so a count can never include an order the
  // caller could not open. The status index serves the group by; the table is one company's
  // orders, so no extra index is needed for the date range.

  /**
   * Count per status, plus how long the oldest order has been waiting in that status: measured
   * from the latest order_events row that moved the order INTO its current status (not from
   * `submitted_at`, which says nothing about a queue further down the line).
   */
  async countByStatus(
    filters: readonly ScopeFilter[],
  ): Promise<{ status: OrderStatus; count: number; oldestWaitingSince: Date | null }[]> {
    const where = scopedWhere(filters);
    const groups = await this.prisma.order.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    const since = await this.oldestEnteredCurrentStatus(
      await this.idsInScope(where, WAITING_STATUSES),
    );
    return groups.map((group) => ({
      status: group.status,
      count: group._count._all,
      oldestWaitingSince: since.get(group.status) ?? null,
    }));
  }

  /**
   * Orders whose accounting step the manager skipped and no accountant has acknowledged yet, and
   * the oldest time a manager skipped it. PROVISIONAL (manager question Q14): nothing sets
   * `accounting_reviewed_at` yet, so this does not drain. Rejected, cancelled and fully received
   * orders are left out; DELIVERED stays in because payment may still be open [P].
   */
  async countSkippedUnreviewed(
    filters: readonly ScopeFilter[],
  ): Promise<{ count: number; oldestWaitingSince: Date | null }> {
    const rows = await this.prisma.order.findMany({
      where: {
        AND: [
          scopedWhere(filters),
          {
            accountingMode: 'SKIPPED_BY_MANAGER',
            accountingReviewedAt: null,
            status: { notIn: ['REJECTED', 'CANCELLED', 'RECEIVED'] },
          },
        ],
      },
      select: { id: true },
    });
    if (rows.length === 0) return { count: 0, oldestWaitingSince: null };
    const result = await this.prisma.$queryRaw<{ since: Date | null }[]>`
      SELECT MIN(COALESCE(
        (SELECT MAX(e.created_at) FROM order_events e
          WHERE e.order_id = o.id AND e.event_type = 'ACCOUNTING_SKIPPED'),
        o.submitted_at)) AS since
      FROM orders o WHERE o.id = ANY(${rows.map((row) => row.id)}::uuid[])`;
    return { count: rows.length, oldestWaitingSince: result[0]?.since ?? null };
  }

  /**
   * The lines of products outside the allocation plan (a generated code, read live from the
   * product like `stockTracked`) in the visible orders of the given statuses, the order that was
   * submitted first first. One statement; the caller names the statuses that still wait for goods.
   */
  async findOpenLinesOutsidePlan<Status extends OrderStatus>(
    filters: readonly ScopeFilter[],
    statuses: readonly Status[],
  ): Promise<
    {
      productId: string;
      quantity: Prisma.Decimal;
      orderId: string;
      orderNumber: string;
      organizationId: string;
      status: Status;
      submittedAt: Date;
    }[]
  > {
    const rows = await this.prisma.orderItem.findMany({
      where: {
        product: { codeGenerated: true },
        order: { AND: [scopedWhere(filters), { status: { in: [...statuses] } }] },
      },
      select: {
        productId: true,
        quantity: true,
        order: {
          select: {
            id: true,
            orderNumber: true,
            organizationId: true,
            status: true,
            submittedAt: true,
          },
        },
      },
      orderBy: [{ order: { submittedAt: 'asc' } }, { orderId: 'asc' }],
    });
    return rows.map((row) => ({
      productId: row.productId,
      quantity: row.quantity,
      orderId: row.order.id,
      orderNumber: row.order.orderNumber,
      organizationId: row.order.organizationId,
      // The WHERE above admits these statuses only.
      status: row.order.status as Status,
      submittedAt: row.order.submittedAt,
    }));
  }

  private async idsInScope(
    where: Prisma.OrderWhereInput,
    statuses: readonly OrderStatus[],
  ): Promise<string[]> {
    const rows = await this.prisma.order.findMany({
      where: { AND: [where, { status: { in: [...statuses] } }] },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /**
   * Per current status, the earliest "entered this status" time among the given orders. A
   * lateral subquery probes the (order_id, seq) index of order_events once per order; an order
   * with no such event (should not happen) falls back to its submission time.
   */
  private async oldestEnteredCurrentStatus(
    orderIds: readonly string[],
  ): Promise<Map<OrderStatus, Date>> {
    if (orderIds.length === 0) return new Map();
    const rows = await this.prisma.$queryRaw<{ status: OrderStatus; since: Date }[]>`
      SELECT o.status::text AS status,
             MIN(COALESCE(entered.at, o.submitted_at)) AS since
      FROM orders o
      LEFT JOIN LATERAL (
        SELECT MAX(e.created_at) AS at FROM order_events e
        WHERE e.order_id = o.id AND e.to_status = o.status
      ) entered ON true
      WHERE o.id = ANY(${[...orderIds]}::uuid[])
      GROUP BY o.status`;
    return new Map(rows.map((row) => [row.status, row.since]));
  }

  /** Orders whose goods still have to come back, and since when (the time they were closed). */
  async countGoodsToReturn(
    filters: readonly ScopeFilter[],
  ): Promise<{ count: number; oldestWaitingSince: Date | null }> {
    const result = await this.prisma.order.aggregate({
      where: { AND: [scopedWhere(filters), GOODS_RETURN_PENDING] },
      _count: { _all: true },
      _min: { updatedAt: true },
    });
    return { count: result._count._all, oldestWaitingSince: result._min.updatedAt };
  }

  /** Delivered (DELIVERED or RECEIVED) orders that are still UNPAID. */
  countUnpaidDelivered(filters: readonly ScopeFilter[]): Promise<number> {
    return this.prisma.order.count({
      where: {
        AND: [
          scopedWhere(filters),
          { paymentStatus: 'UNPAID', status: { in: ['DELIVERED', 'RECEIVED'] } },
        ],
      },
    });
  }

  /** Orders submitted in [from, to) that are not REJECTED or CANCELLED, with their summed total. */
  async sumSubmittedBetween(
    filters: readonly ScopeFilter[],
    from: Date,
    to: Date,
  ): Promise<{ count: number; total: Prisma.Decimal }> {
    const result = await this.prisma.order.aggregate({
      where: {
        AND: [
          scopedWhere(filters),
          { submittedAt: { gte: from, lt: to }, status: { notIn: ['REJECTED', 'CANCELLED'] } },
        ],
      },
      _count: { _all: true },
      _sum: { totalAmount: true },
    });
    return { count: result._count._all, total: result._sum.totalAmount ?? new Prisma.Decimal(0) };
  }

  // ---------------------------------------------------------------- timeline

  /** All events of one order in the order they happened (seq breaks ties of equal timestamps). */
  async findEvents(orderId: string, db: DbClient = this.prisma): Promise<OrderEventRecord[]> {
    const rows = await db.orderEvent.findMany({ where: { orderId }, orderBy: { seq: 'asc' } });
    return rows.map((row) => ({
      id: row.id,
      eventType: row.eventType,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      actorUserId: row.actorUserId,
      actorRole: row.actorRole,
      comment: row.comment,
      payload: row.payload,
      createdAt: row.createdAt,
    }));
  }

  /** Newest first; the rows are the same ones the bot delivers, whatever their delivery status. */
  async findRoleNotifications(
    role: string,
    limit: number,
  ): Promise<
    { id: string; type: string; orderId: string | null; payload: unknown; createdAt: Date }[]
  > {
    return this.prisma.notificationOutbox.findMany({
      where: { recipientKind: 'ROLE', recipientRole: role },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true, type: true, orderId: true, payload: true, createdAt: true },
    });
  }

  async findOutbox(orderId: string, db: DbClient = this.prisma): Promise<OutboxRecord[]> {
    const rows = await db.notificationOutbox.findMany({
      where: { orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        type: true,
        recipientKind: true,
        recipientUserId: true,
        recipientRole: true,
        recipientOrganizationId: true,
        status: true,
        attempts: true,
        dedupeKey: true,
        orderEventId: true,
        createdAt: true,
        sentAt: true,
      },
    });
    return rows;
  }

  // ------------------------------------------------------------------- carts

  /** `organizationId` null: the personal cart of a staff viewer, which belongs to no organization. */
  async findCartItems(
    userId: string,
    organizationId: string | null,
    db: DbClient = this.prisma,
  ): Promise<CartItemRecord[]> {
    const rows = await db.cartItem.findMany({
      where: { cart: { userId, organizationId } },
      orderBy: [{ updatedAt: 'asc' }, { productId: 'asc' }],
    });
    return rows.map((row) => ({ productId: row.productId, quantity: row.quantity }));
  }

  /** Open cart lines of a product over every cart (a count; no rows are loaded). */
  countCartLines(productId: string): Promise<number> {
    return this.prisma.cartItem.count({ where: { productId } });
  }

  /**
   * Creates the cart when missing and locks it until the transaction ends. `organizationId` null is
   * the personal cart of a staff viewer: one per person, kept unique by a partial index (the
   * compound unique key cannot do it, NULLs are distinct there).
   */
  async lockCart(
    tx: Tx,
    userId: string,
    organizationId: string | null,
    now: Date,
  ): Promise<string> {
    const cartId =
      organizationId === null
        ? await this.upsertPersonalCart(tx, userId, now)
        : (
            await tx.cart.upsert({
              where: { userId_organizationId: { userId, organizationId } },
              create: { userId, organizationId, createdAt: now, updatedAt: now },
              update: {},
              select: { id: true },
            })
          ).id;
    await tx.$queryRaw`SELECT id FROM carts WHERE id = ${cartId}::uuid FOR UPDATE`;
    return cartId;
  }

  private async upsertPersonalCart(tx: Tx, userId: string, now: Date): Promise<string> {
    // ON CONFLICT on the partial index: two first requests at once still end with one cart. The
    // no-op update makes RETURNING answer for the existing row too.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO carts (id, user_id, organization_id, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${userId}::uuid, NULL, ${now}, ${now})
      ON CONFLICT (user_id) WHERE organization_id IS NULL
      DO UPDATE SET user_id = EXCLUDED.user_id
      RETURNING id`;
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('The personal cart was not written');
    return id;
  }

  async findCartItemsLocked(tx: Tx, cartId: string): Promise<CartItemRecord[]> {
    const rows = await tx.cartItem.findMany({
      where: { cartId },
      orderBy: [{ updatedAt: 'asc' }, { productId: 'asc' }],
    });
    return rows.map((row) => ({ productId: row.productId, quantity: row.quantity }));
  }

  async upsertCartItem(
    tx: Tx,
    cartId: string,
    productId: string,
    quantity: Prisma.Decimal,
    now: Date,
  ): Promise<void> {
    await tx.cartItem.upsert({
      where: { cartId_productId: { cartId, productId } },
      create: { cartId, productId, quantity, updatedAt: now },
      update: { quantity, updatedAt: now },
    });
    await tx.cart.update({ where: { id: cartId }, data: { updatedAt: now } });
  }

  async deleteCartItem(tx: Tx, cartId: string, productId: string, now: Date): Promise<void> {
    await tx.cartItem.deleteMany({ where: { cartId, productId } });
    await tx.cart.update({ where: { id: cartId }, data: { updatedAt: now } });
  }

  async clearCart(tx: Tx, cartId: string, now: Date): Promise<void> {
    await tx.cartItem.deleteMany({ where: { cartId } });
    await tx.cart.update({ where: { id: cartId }, data: { updatedAt: now } });
  }

  /**
   * A product merge: every cart line of `sourceProductId` becomes a line of `targetProductId`. A
   * cart that already has the target adds the quantities (capped at `maxQuantity`, the cart's
   * own limit) and loses the source line; the others simply change product. Three statements for
   * any number of carts. Returns how many source lines there were.
   */
  async moveCartLines(
    tx: Tx,
    sourceProductId: string,
    targetProductId: string,
    maxQuantity: Prisma.Decimal,
    now: Date,
  ): Promise<number> {
    const merged = await tx.$executeRaw`
      UPDATE cart_items AS t
      SET quantity = LEAST(t.quantity + s.quantity, ${maxQuantity.toFixed(3)}::numeric),
          updated_at = ${now}
      FROM cart_items AS s
      WHERE s.cart_id = t.cart_id
        AND s.product_id = ${sourceProductId}::uuid
        AND t.product_id = ${targetProductId}::uuid`;
    const dropped = await tx.$executeRaw`
      DELETE FROM cart_items AS s
      WHERE s.product_id = ${sourceProductId}::uuid
        AND EXISTS (
          SELECT 1 FROM cart_items AS t
          WHERE t.cart_id = s.cart_id AND t.product_id = ${targetProductId}::uuid)`;
    const moved = await tx.$executeRaw`
      UPDATE cart_items
      SET product_id = ${targetProductId}::uuid, updated_at = ${now}
      WHERE product_id = ${sourceProductId}::uuid`;
    if (merged !== dropped) {
      throw new Error('Cart merge wrote an unexpected number of rows');
    }
    return dropped + moved;
  }
}
