import {
  CUSTOMER_ORDER_GROUP_STATUSES,
  DEFAULT_ORDER_PAGE_SIZE,
  idempotencyKeySchema,
  submitOrderRequestSchema,
  type PaymentPlan,
  type SubmitOrderRequest,
} from '@iorder/shared';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { Actor } from '../../common/auth/actor.js';
import { can, holdsAnyGrantFor } from '../../common/auth/can.js';
import { effectiveMembership, isStaffViewer } from '../../common/auth/permission-matrix.js';
import { scopeFor } from '../../common/auth/scope-for.js';
import { Clock } from '../../common/clock/clock.js';
import { lockByName } from '../../common/database/advisory-lock.js';
import type { DbClient, Tx } from '../../common/database/db-client.js';
import { isUniqueViolation } from '../../common/database/errors.js';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import { APP_ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService, type AuditValue } from '../audit/index.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { OrganizationsService } from '../organizations/index.js';
import { CartService } from './cart.service.js';
import {
  judgePlan,
  samePlan,
  SupplyAllocationService,
  type PlanMode,
  type PlannedHold,
  type SupplyState,
} from '../pricing/index.js';
import {
  buildAllocationPreview,
  demandOf,
  holdsOf,
  trackedProductIds,
  type EarlierDemand,
} from './order-allocation-preview.js';
import { PickingService, type ReleasedCodesSummary } from './picking.service.js';
import {
  isStaffActor,
  resourceContextOf,
  submitterRoleOf,
  workflowRolesOf,
} from './order-actor.js';
import {
  fitsMoney,
  fitsUsd,
  formatUsdExact,
  formatAmount,
  formatQuantity,
  lineTotal,
  parseQuantity,
  sumAmounts,
} from './order-lines.js';
import { goodsReturnStateOf, toOrderSummary, toOrderView } from './order-mapper.js';
import {
  addsMarkedProduct,
  buildItemsEditedNotifications,
  buildPurchasingItemsEditedNotification,
  buildPurchasingNotification,
  buildPaymentPlanChangedByCustomerNotifications,
  buildPaymentPlanChangedNotifications,
  buildSubmittedNotifications,
  buildTransitionNotifications,
  eventIndexForNotification,
  type AccountantOrderFacts,
  type PurchasingOrderFacts,
  type NotificationContext,
  type OutboxRowInput,
  type PaymentPlanChangeFacts,
} from './order-notifications.js';
import { OrderItemAllocationsService } from './order-item-allocations.service.js';
import { formatOrderNumber } from './order-number.js';
import {
  orderTotalUsd,
  priceItems,
  repriceForPlan,
  type PriceBook,
  type SnapshotLine,
} from './order-pricing.js';
import { linesOverStock, stockLimitExceeded } from './stock-limit.js';
import {
  decideTransition,
  isAtOrBeyond,
  mayEverMoveTo,
  permissionFor,
  type WorkflowRole,
} from './order-state-machine.js';
import {
  OrdersRepository,
  type NewOrderEvent,
  type OrderItemRecord,
  type OrderRecord,
  type OrderTransitionData,
} from './orders.repository.js';
import {
  editItemsCommandSchema,
  goodsReturnedCommandSchema,
  orderListFiltersSchema,
  ownPaymentPlanCommandSchema,
  parseInput,
  setAllocationsCommandSchema,
  paymentMethodCommandSchema,
  paymentPlanCommandSchema,
  staffEditItemsCommandSchema,
  staffTransitionCommandSchema,
  transitionCommandSchema,
  type EditItemsCommand,
  type GoodsReturnedCommand,
  type OrderListFilters,
  type OwnPaymentPlanCommand,
  type PaymentMethodCommand,
  type PaymentPlanCommand,
  type SetAllocationsCommand,
  type TransitionCommand,
} from './orders.schemas.js';
import {
  createStaffOrderRequestSchema,
  type AllocationPreview,
  type AllocationRequestRow,
  type CreateStaffOrderRequest,
} from '@iorder/shared/staff-orders';
import type { OrderPage, OrderView, PaymentPlanChangeOffer } from './order.views.js';
import { paymentPlanChangeWindowMs } from './payment-plan.settings.js';
import { OrganizationPaymentsService } from './organization-payments.service.js';

/** An inserted event always has an id; the check keeps the type honest and the link mandatory. */
function requireId(id: string | undefined): string {
  if (id === undefined) throw new Error('The order event was not written');
  return id;
}

const ORDER_ENTITY = 'ORDER';
/** Approved and still alive: before approval there is no method, after reject/cancel it is history. */
const PAYMENT_METHOD_CHANGEABLE: readonly OrderRecord['status'][] = [
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
  'RELEASED',
  'DELIVERED',
  'RECEIVED',
];
const uuidSchema = z.uuid();
/** Holds may be read from before the approval until the release; changed only once approved. */
const ALLOCATION_READABLE: readonly OrderRecord['status'][] = [
  'SUBMITTED',
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
];
const ALLOCATION_CHANGEABLE: readonly OrderRecord['status'][] = [
  'MANAGER_APPROVED',
  'ACCOUNTING_CLEARED',
];

type PayloadLine = Record<string, AuditValue>;

function snapshotPayloadLine(line: SnapshotLine): PayloadLine {
  return {
    productCode: line.productCode,
    name: line.name,
    quantity: formatQuantity(line.quantity),
    unitPrice: formatAmount(line.unitPrice),
    lineTotal: formatAmount(line.lineTotal),
    fullUnitPriceUsd: line.fullUnitPriceUsd?.toFixed(2) ?? null,
    deferredUnitPriceUsd: line.deferredUnitPriceUsd?.toFixed(2) ?? null,
  };
}

function recordPayloadLine(item: OrderItemRecord): PayloadLine {
  return {
    productCode: item.productCodeSnapshot,
    name: item.nameSnapshot,
    quantity: formatQuantity(item.quantity),
    unitPrice: formatAmount(item.unitPrice),
    lineTotal: formatAmount(item.lineTotal),
  };
}

/**
 * The orders domain: submit, the ONE status-transition function, manager edits, payment status
 * and scoped reads. No HTTP here; a controller layer calls these methods with the resolved Actor.
 *
 * Hard rule 2: `orders.status` changes only in `transition`, as a conditional UPDATE on the
 * expected status and row_version, together with the `order_events` rows and the
 * `notification_outbox` rows, in ONE transaction.
 */
@Injectable()
export class OrdersService {
  constructor(
    private readonly repository: OrdersRepository,
    private readonly carts: CartService,
    private readonly organizations: OrganizationsService,
    private readonly identity: IdentityService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly picking: PickingService,
    private readonly payments: OrganizationPaymentsService,
    private readonly supply: SupplyAllocationService,
    private readonly itemAllocations: OrderItemAllocationsService,
    private readonly catalog: CatalogService,
    @Inject(APP_ENV) private readonly env: Env,
  ) {}

  /**
   * For the notification sender: the organization an order belongs to (null for an unknown
   * order). Not an endpoint, so no actor check; the sender uses it to keep messages inside the
   * order's own organization.
   */
  async findOrganizationIdOfOrder(orderId: string): Promise<string | null> {
    return (await this.repository.findById(orderId))?.organizationId ?? null;
  }

  /**
   * For the notification sender: the person who placed an order (null for an unknown order), so
   * the message to the organization's group can mention them. Not an endpoint, like the lookup
   * above; the group it is used for is the order's own organization.
   */
  async findPlacerIdOfOrder(orderId: string): Promise<string | null> {
    return (await this.repository.findById(orderId))?.placedByUserId ?? null;
  }

  // ------------------------------------------------------------------ submit

  /**
   * `submitCart` for the organization the actor's orders belong to: a customer's own, or for a
   * staff viewer the one configured for staff orders (refused where none is configured). The
   * organization is decided here, on the server, never by the request.
   */
  submitOwnCart(
    actor: Actor,
    idempotencyKey: string,
    rawRequest: SubmitOrderRequest,
  ): Promise<OrderView> {
    return this.submitCart(
      actor,
      this.carts.orderingOrganizationOf(actor),
      idempotencyKey,
      rawRequest,
    );
  }

  /**
   * Turns the cart into an order priced from the CURRENT published price list version, at the
   * prices of the plan the customer chose; both prices of every line are kept in the snapshot.
   * The customer states the total they saw: a price or rate that moved since refuses the order
   * rather than storing a total they never saw. Repeating the same idempotency key (per
   * organization) returns the existing order, whatever total it states, and creates nothing.
   * Payment status never blocks it (hard rule 11): nothing here looks at it.
   */
  async submitCart(
    actor: Actor,
    organizationId: string,
    idempotencyKey: string,
    rawRequest: SubmitOrderRequest,
  ): Promise<OrderView> {
    const key = parseInput(idempotencyKeySchema, idempotencyKey);
    const { paymentPlan, expectedTotalAmount } = parseInput(submitOrderRequestSchema, rawRequest);
    const ownOrganizationId = this.carts.orderingOrganizationOf(actor);
    if (organizationId !== ownOrganizationId) throw new ForbiddenError('Access denied');
    // A customer's cart is their organization's; a staff viewer's belongs to no organization.
    const cartOwner = this.carts.cartOwnerOf(actor);

    // Fast path for a repeated request: no pricing, no locks.
    const existing = await this.repository.findByIdempotencyKey(ownOrganizationId, key);
    if (existing) return this.replay(actor, existing);

    if (!(await this.organizations.isActive(ownOrganizationId))) {
      throw new ConflictError(
        'This organization cannot place orders',
        'ORDERING_ORGANIZATION_INACTIVE',
      );
    }
    // After the replay path above: an order that already exists is returned even if the contact
    // changed since. The manager calls this number, so a first order needs it (owner decision).
    // Not asked of a staff viewer: the contact is a customer's, and staff cannot enter one.
    if (!isStaffViewer(actor) && !(await this.identity.hasContact(actor.userId))) {
      throw new ConflictError('Enter your name and phone number first', 'CONTACT_REQUIRED');
    }
    try {
      const record = await this.repository.transaction(async (tx) => {
        // Two parallel requests with one key: the second waits here, then finds the first order.
        await lockByName(tx, `order-submit:${ownOrganizationId}:${key}`);
        const again = await this.repository.findByIdempotencyKey(ownOrganizationId, key, tx);
        if (again) return again;

        const now = this.clock.now();
        const cartId = await this.repository.lockCart(
          tx,
          cartOwner.userId,
          cartOwner.organizationId,
          now,
        );
        // Read as late as possible: after the locks, right before pricing. The pricing module has
        // its own connection, so this is not the transaction's snapshot; it does not need to be:
        // a published version and its items are immutable, so the book is one consistent version,
        // and a publish that lands a moment later only means the order used the list that was
        // current when the cart was submitted.
        const book = await this.carts.loadPriceBook(actor);
        if (book === null) {
          throw new ConflictError('No price list has been published yet', 'NO_PUBLISHED_VERSION');
        }
        const items = await this.repository.findCartItemsLocked(tx, cartId);
        if (items.length === 0) throw new ConflictError('The cart is empty', 'EMPTY_CART');

        const actorRole = submitterRoleOf(actor);
        if (actorRole === undefined) throw new ForbiddenError('Access denied');
        const order = await this.writeSubmittedOrder(tx, {
          actor,
          actorRole,
          organizationId: ownOrganizationId,
          placedByUserId: actor.userId,
          idempotencyKey: key,
          paymentPlan,
          expectedTotalAmount,
          book,
          items,
          customerComment: null,
          capByStock: true,
          onBehalfOf: false,
          now,
        });
        await this.repository.clearCart(tx, cartId, now);
        return order;
      });
      return this.replay(actor, record);
    } catch (error) {
      // The advisory lock makes this unreachable in practice; the unique index is the backstop.
      if (isUniqueViolation(error)) {
        const winner = await this.repository.findByIdempotencyKey(ownOrganizationId, key);
        if (winner) return this.replay(actor, winner);
      }
      throw error;
    }
  }

  /**
   * The order a submit writes, inside the caller's transaction: priced from `book` at the plan's
   * prices (both snapshots kept), the frozen USD rate, the SUBMITTED event and the staff outbox rows,
   * all in this one transaction (hard rules 2, 4, 12). Shared by the customer's submit and the
   * manager's order on a customer's behalf, so the two can never price or announce differently.
   * Nothing is reserved (hard rule 10): holds come with the manager's approval.
   */
  private async writeSubmittedOrder(
    tx: Tx,
    input: {
      actor: Actor;
      actorRole: WorkflowRole;
      organizationId: string;
      placedByUserId: string;
      idempotencyKey: string;
      paymentPlan: PaymentPlan;
      expectedTotalAmount: string;
      book: PriceBook;
      items: readonly { productId: string; quantity: Prisma.Decimal }[];
      customerComment: string | null;
      /** The customer's submit is capped by the free stock; the manager's order is not [P]. */
      capByStock: boolean;
      /** A manager placed it for the member: the event says so (hard rule 12). */
      onBehalfOf: boolean;
      now: Date;
    },
  ): Promise<OrderRecord> {
    const { actor, actorRole, book, items, paymentPlan, now } = input;
    const priced = priceItems(book, items, paymentPlan);
    if (priced.unorderableProductIds.length > 0) {
      throw new ConflictError(
        'Some products in the cart cannot be ordered right now',
        'PRODUCT_NOT_ORDERABLE',
        { productIds: priced.unorderableProductIds },
      );
    }
    // Checked on the list read just before: a price removed after the person saw it refuses the
    // order instead of pricing it at something they did not choose.
    if (priced.missingDeferredProductIds.length > 0) {
      throw this.deferredUnavailable(priced.missingDeferredProductIds);
    }
    // Read after the locks, like the book: a quantity the cart would refuse now is refused here
    // too [C, 2026-11-09]. Nothing is reserved by passing (hard rule 10): the manager's allocation
    // at approval settles two orders for the same last pieces.
    if (input.capByStock) {
      const overStock = linesOverStock(
        items,
        await this.carts.loadOrderableStock(
          book,
          items.map((item) => item.productId),
        ),
      );
      if (overStock.length > 0) throw stockLimitExceeded(overStock);
    }
    // The debt is counted in USD at this rate: an order with an unknown debt is never stored.
    // The rate comes from the read that priced the order, so a rate set a moment later cannot
    // disagree with the so'm prices.
    if (book.usdRate === null) {
      throw new ConflictError(
        'The order cannot be converted right now',
        'CURRENCY_CONVERSION_UNAVAILABLE',
      );
    }
    const totalUsd = orderTotalUsd(priced.lines, paymentPlan, book.usdRate);
    if (!fitsMoney(priced.total) || !fitsUsd(totalUsd)) {
      throw new InputValidationError([{ path: 'cart', message: 'The order total is too large' }]);
    }
    // Nothing was written yet, so the refusal leaves everything as it is.
    if (!priced.total.equals(input.expectedTotalAmount)) {
      throw new ConflictError('The total changed after the cart was read', 'CART_TOTAL_CHANGED', {
        currentTotalAmount: formatAmount(priced.total),
      });
    }

    const orderNumber = formatOrderNumber(await this.repository.nextOrderSequence(tx));
    const order = await this.repository.createOrder(tx, {
      orderNumber,
      organizationId: input.organizationId,
      placedByUserId: input.placedByUserId,
      priceListVersionId: book.versionId,
      // The tier the lines were priced with (hard rule 4: a later label change never alters it).
      priceTier: book.priceTier,
      idempotencyKey: input.idempotencyKey,
      paymentPlan,
      totalAmount: priced.total,
      usdRate: book.usdRate,
      totalUsd,
      customerComment: input.customerComment,
      now,
      items: priced.lines.map((line) => ({
        productId: line.productId,
        productCodeSnapshot: line.productCode,
        nameSnapshot: line.name,
        unitSnapshot: line.unit,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
        fullUnitPrice: line.fullUnitPrice,
        deferredUnitPrice: line.deferredUnitPrice,
        fullUnitPriceUsd: line.fullUnitPriceUsd,
        deferredUnitPriceUsd: line.deferredUnitPriceUsd,
      })),
    });

    const [submittedEventId] = await this.repository.insertEvents(tx, [
      {
        orderId: order.id,
        eventType: 'SUBMITTED',
        fromStatus: null,
        toStatus: 'SUBMITTED',
        // Who did it: the customer, or the manager who created it for them.
        actorUserId: actor.userId,
        actorRole,
        comment: null,
        payload: {
          before: null,
          after: {
            status: 'SUBMITTED',
            orderNumber,
            priceListVersionId: book.versionId,
            priceTier: book.priceTier,
            paymentPlan,
            totalAmount: formatAmount(order.totalAmount),
            usdRate: order.usdRate.toFixed(4),
            totalUsd: formatUsdExact(order.totalUsd),
            lines: priced.lines.map(snapshotPayloadLine),
            ...(input.onBehalfOf
              ? {
                  createdOnBehalfOf: {
                    organizationId: input.organizationId,
                    placedByUserId: input.placedByUserId,
                  },
                  customerComment: input.customerComment,
                }
              : {}),
          },
        },
        createdAt: now,
      },
    ]);
    const submitContext = this.notificationContext(order, actor, actorRole, null);
    const purchasingRow = buildPurchasingNotification(
      'ORDER_SUBMITTED',
      submitContext,
      await this.purchasingFacts(tx, order.items),
    );
    // The same staff messages whoever placed it; the customer side gets nothing on submit
    // (CUSTOMER_SIDE_NOTIFICATIONS).
    await this.repository.insertOutbox(
      tx,
      [
        ...buildSubmittedNotifications(submitContext),
        ...(purchasingRow === null ? [] : [purchasingRow]),
      ].map((row) => ({ ...row, orderEventId: requireId(submittedEventId) })),
      now,
    );
    return order;
  }

  // ------------------------------------------------------- manager's new order

  /**
   * [C, owner 2026-11-20] The manager creates an order on behalf of a customer. It is an ordinary
   * SUBMITTED order of the organization, placed by the chosen CURRENT member (so the customer side
   * sees it as its own), priced exactly like a submit from the organization's catalog at its tier,
   * with the same staff messages. The member is checked against the organization here, on the
   * server (hard rule 6). Not capped by the free stock [P], like the manager's edits; nothing is
   * held (hard rule 10). Approval stays a separate later step. A retry with the same
   * Idempotency-Key (per organization) returns the same order and creates nothing.
   */
  async createForCustomer(
    actor: Actor,
    idempotencyKey: string,
    rawRequest: CreateStaffOrderRequest,
  ): Promise<OrderView> {
    if (!can(actor, 'CREATE_ORDER_FOR_CUSTOMER')) throw new ForbiddenError('Access denied');
    const key = parseInput(idempotencyKeySchema, idempotencyKey);
    const request = parseInput(createStaffOrderRequestSchema, rawRequest);
    const { organizationId, placedByUserId } = request;

    // Fast path for a repeated request: no pricing, no locks.
    const existing = await this.repository.findByIdempotencyKey(organizationId, key);
    if (existing) return this.replayCreated(actor, existing);

    if (!(await this.organizations.isActive(organizationId))) {
      throw new ConflictError(
        'This organization cannot place orders',
        'ORDERING_ORGANIZATION_INACTIVE',
      );
    }
    const items = request.lines.map((line, index) => {
      const quantity = parseQuantity(line.quantity);
      if (quantity === null) {
        throw new InputValidationError([
          { path: `lines.${index}.quantity`, message: 'Quantity must be a whole number of pieces' },
        ]);
      }
      return { productId: line.productId, quantity };
    });
    const comment =
      request.comment === undefined || request.comment === '' ? null : request.comment;

    try {
      const record = await this.repository.transaction(async (tx) => {
        // Two parallel requests with one key: the second waits here, then finds the first order.
        await lockByName(tx, `order-submit:${organizationId}:${key}`);
        const again = await this.repository.findByIdempotencyKey(organizationId, key, tx);
        if (again) return again;
        // Under the organization's and the person's row locks: a member who leaves or is blocked
        // a moment earlier can never become the order's placer (hard rule 6).
        await this.assertMayPlaceFor(tx, organizationId, placedByUserId);
        // Read after the lock, right before pricing (see submitCart).
        const book = await this.carts.loadPriceBookForOrganization(organizationId);
        if (book === null) {
          throw new ConflictError('No price list has been published yet', 'NO_PUBLISHED_VERSION');
        }
        return this.writeSubmittedOrder(tx, {
          actor,
          actorRole: 'MANAGER',
          organizationId,
          placedByUserId,
          idempotencyKey: key,
          paymentPlan: request.paymentPlan,
          expectedTotalAmount: request.expectedTotalAmount,
          book,
          items,
          customerComment: comment,
          capByStock: false,
          onBehalfOf: true,
          now: this.clock.now(),
        });
      });
      return await this.replayCreated(actor, record);
    } catch (error) {
      // The advisory lock makes this unreachable in practice; the unique index is the backstop.
      if (isUniqueViolation(error)) {
        const winner = await this.repository.findByIdempotencyKey(organizationId, key);
        if (winner) return this.replayCreated(actor, winner);
      }
      throw error;
    }
  }

  /**
   * The person an order is placed by must be a CURRENT member of the organization with an active
   * account: never a staff member, never somebody of another organization (hard rule 6).
   */
  private async assertMayPlaceFor(tx: Tx, organizationId: string, userId: string): Promise<void> {
    const member = await this.organizations.lockActiveMember(tx, organizationId, userId);
    if (!member || !(await this.identity.lockActiveCustomer(tx, userId))) {
      throw new ConflictError(
        'The person is not a current member of this organization',
        'PLACER_NOT_MEMBER',
      );
    }
  }

  /** A retry of the manager's create: the same order, but only for the manager who created it. */
  private async replayCreated(actor: Actor, order: OrderRecord): Promise<OrderView> {
    const submitted = (await this.repository.findEvents(order.id)).find(
      (event) => event.eventType === 'SUBMITTED',
    );
    if (submitted?.actorUserId !== actor.userId) {
      throw new ConflictError(
        'This idempotency key was already used by another person',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
    return toOrderView(order, actor);
  }

  private replay(actor: Actor, order: OrderRecord): OrderView {
    if (order.placedByUserId !== actor.userId) {
      throw new ConflictError(
        'This idempotency key was already used by another person',
        'IDEMPOTENCY_KEY_REUSED',
      );
    }
    return toOrderView(order, actor);
  }

  // -------------------------------------------------------------- transition

  /**
   * THE status transition (hard rule 2). Loads the order, checks visibility, the state machine
   * and `can()` with the full resource context, then in ONE transaction: conditional UPDATE on
   * the expected status and row_version, the `order_events` rows and the `notification_outbox`
   * rows. Of two concurrent actions on one order exactly one wins; the other gets
   * ConflictError(ORDER_CHANGED).
   */
  async transition(
    actor: Actor,
    orderId: string,
    rawCommand: TransitionCommand,
  ): Promise<OrderView> {
    // Staff decide on what they saw: their command must carry the version they read.
    const command = parseInput(
      isStaffActor(actor) ? staffTransitionCommandSchema : transitionCommandSchema,
      rawCommand,
    );
    const driverUserId = command.driverUserId ?? null;

    const record = await this.repository.transaction(async (tx) => {
      const order = await this.loadVisible(tx, actor, orderId);
      const roles = workflowRolesOf(actor);
      // A stale version beats every other answer (for someone who could make this move at all):
      // the loser of a race must hear "changed", not "illegal" or "forbidden" about a state that
      // no longer exists. Roles that could never make the move still get Forbidden below.
      if (this.isStale(command.expectedRowVersion, order) && mayEverMoveTo(roles, command.to)) {
        throw this.changedError(order.status);
      }
      const decision = decideTransition({
        from: order.status,
        to: command.to,
        roles,
        reason: command.reason ?? null,
        driverUserId,
        skipAccounting: command.skipAccounting === true,
        paymentMethod: command.paymentMethod ?? null,
      });
      switch (decision.outcome) {
        case 'ILLEGAL_TRANSITION':
          // The order already is where this request wanted it, or further: someone got there first.
          if (isAtOrBeyond(order.status, command.to)) throw this.changedError(order.status);
          throw new ConflictError(
            `An order cannot move from ${order.status} to ${command.to}`,
            'ILLEGAL_ORDER_TRANSITION',
            { from: order.status, to: command.to },
          );
        case 'ROLE_NOT_ALLOWED':
          throw new ForbiddenError('Access denied');
        case 'INPUT_INVALID':
          throw new InputValidationError([...decision.issues]);
        case 'ALLOWED':
          break;
      }

      const context = resourceContextOf(order);
      if (!can(actor, permissionFor(order.status, command.to), context)) {
        throw new ForbiddenError('Access denied');
      }
      if (command.skipAccounting === true && !can(actor, 'SKIP_ACCOUNTING')) {
        throw new ForbiddenError('Access denied');
      }
      // Checked inside the release transaction, right before the write and after every other
      // check, so a driver deactivated a moment ago is caught as late as possible. The identity
      // module has its own connection, so a deactivation in the same instant can still slip
      // through; the admin can reassign (lifecycle: assigned driver deactivated).
      if (decision.driverUserId !== null) await this.assertActiveDriver(decision.driverUserId);

      const now = this.clock.now();
      const approving = decision.steps.some((step) => step.to === 'MANAGER_APPROVED');
      const allocated = await this.allocationOfMove(tx, actor, order, command, approving, now);
      // Unit codes ([C] 2026-10-25): the release needs every required code (checked under the
      // order row lock that scans also take); a cancel or reject frees the codes scanned so far,
      // under the same lock, so a scan running right now cannot leave a live code behind.
      let releasedCodes: ReleasedCodesSummary | null = null;
      let voidedCodes: number | null = null;
      // The goods left, or the order closed: the stock is free again, in the status's transaction.
      let holdsEnded = 0;
      if (decision.steps.some((step) => step.to === 'RELEASED')) {
        await this.repository.lockOrder(tx, order.id);
        // Approved and cleared around the deploy of the 2026-10-30 flow: the gate needs units.
        if (order.managerApprovedAt === null) await this.picking.createUnits(tx, order, now);
        releasedCodes = await this.picking.assertCodesComplete(tx, order);
        holdsEnded = await this.supply.endHolds(tx, order.id, now);
      }
      const closing = decision.steps.find(
        (step) => step.to === 'CANCELLED' || step.to === 'REJECTED',
      );
      if (closing !== undefined) {
        await this.repository.lockOrder(tx, order.id);
        voidedCodes = await this.picking.voidCodesOfClosedOrder(
          tx,
          order.id,
          actor.userId,
          closing.to === 'CANCELLED' ? 'ORDER_CANCELLED' : 'ORDER_REJECTED',
          now,
        );
        holdsEnded = await this.supply.endHolds(tx, order.id, now);
      }
      // A received order joins the organization's debt ([C] 2026-10-26). The ledger lock comes
      // BEFORE the order row is written, the same order the payment actions take the locks in.
      const receiving = decision.steps.some((step) => step.to === 'RECEIVED');
      if (receiving) await this.payments.lockLedger(tx, order.organizationId);
      const moves: OrderTransitionData[] = [];
      const events: NewOrderEvent[] = [];
      // An order the previous release approved in the deploy window has no approval time, and the
      // warehouse would never see it. Its first later move records one: the real time is in events.
      const approvalTimeMissing = order.managerApprovedAt === null && order.status !== 'SUBMITTED';
      let accountingMode = order.accountingMode;
      let clearedAt = order.accountingClearedAt;
      decision.steps.forEach((step, index) => {
        const before: Record<string, AuditValue> = { status: step.from };
        const after: Record<string, AuditValue> = { status: step.to };
        const move: OrderTransitionData = {
          status: step.to,
          updatedAt: now,
          bumpRowVersion: index === 0,
        };
        moves.push(move);
        if (index === 0 && approvalTimeMissing) {
          before.managerApprovedAt = null;
          after.managerApprovedAt = now.toISOString();
          move.managerApprovedAt = now;
        }
        if (step.to === 'MANAGER_APPROVED') {
          move.managerApprovedAt = now;
          if (allocated !== null) {
            after.allocationMode = allocated.mode;
            after.allocations = allocated.rows;
          }
        }
        if ((step.to === 'RELEASED' || step === closing) && holdsEnded > 0) {
          after.holdsEnded = holdsEnded;
        }
        if (step.to === 'ACCOUNTING_CLEARED') {
          const mode = step.eventType === 'ACCOUNTING_SKIPPED' ? 'SKIPPED_BY_MANAGER' : 'APPROVED';
          before.accountingMode = accountingMode;
          after.accountingMode = mode;
          before.accountingClearedAt = clearedAt?.toISOString() ?? null;
          after.accountingClearedAt = now.toISOString();
          accountingMode = mode;
          clearedAt = now;
          move.accountingMode = mode;
          move.accountingClearedAt = now;
        }
        if (index === 0 && decision.paymentMethod !== null) {
          before.paymentMethod = order.paymentMethod;
          after.paymentMethod = decision.paymentMethod;
          move.paymentMethod = decision.paymentMethod;
        }
        if (step.to === 'RELEASED') {
          before.driverUserId = order.driverUserId;
          after.driverUserId = decision.driverUserId;
          move.driverUserId = decision.driverUserId;
          if (releasedCodes !== null) {
            after.releasedUnits = releasedCodes.units;
            after.releasedUnitCodes = releasedCodes.codes;
          }
        }
        if (step.to === 'RECEIVED') move.receivedAt = now;
        if (step === closing && voidedCodes !== null && voidedCodes > 0) {
          after.unitCodesVoided = voidedCodes;
        }
        events.push({
          orderId: order.id,
          eventType: step.eventType,
          fromStatus: step.from,
          toStatus: step.to,
          actorUserId: actor.userId,
          actorRole: decision.actingRole,
          // The reason belongs to what the person actually decided: the first step.
          comment: index === 0 ? decision.reason : null,
          payload: { before, after },
          createdAt: now,
        });
      });

      // Each step is one legal move for the database trigger (skip accounting = two moves in one
      // transaction). The first is conditional on what the caller read, the second on the first.
      let expected = { status: order.status, rowVersion: order.rowVersion };
      for (const move of moves) {
        const applied = await this.repository.transitionGuarded(tx, order.id, expected, move);
        if (!applied) {
          const current = await this.repository.findById(order.id, tx);
          throw this.changedError(current?.status ?? order.status);
        }
        expected = { status: move.status, rowVersion: order.rowVersion + 1 };
        // Normally the approval already made them. Repeated at the clearance (idempotent) because
        // an order approved by the previous release has none, and without units the release gate
        // would have nothing to check.
        if (move.status === 'MANAGER_APPROVED' || move.status === 'ACCOUNTING_CLEARED') {
          await this.picking.createUnits(tx, order, now);
        }
      }
      const eventIds = await this.repository.insertEvents(tx, events);
      if (receiving) {
        await this.payments.reallocate(
          tx,
          order.organizationId,
          { userId: actor.userId, role: decision.actingRole },
          now,
        );
      }
      const moveContext = this.notificationContext(
        order,
        actor,
        decision.actingRole,
        decision.reason,
      );
      const rows = buildTransitionNotifications(decision.effects, {
        ...moveContext,
        driverUserId: decision.driverUserId,
        accountingSkipped: command.skipAccounting === true,
        accountantFacts: approving
          ? await this.accountantFacts(tx, order, decision.paymentMethod)
          : null,
      });
      // Asked of the move itself, not of its effects: who else hears about a cancellation (the
      // customer notification table) must not decide whether the purchasing manager does.
      if (closing?.to === 'CANCELLED') {
        const purchasingRow = buildPurchasingNotification(
          'ORDER_CANCELLED',
          moveContext,
          await this.purchasingFacts(tx, order.items),
        );
        if (purchasingRow !== null) rows.push(purchasingRow);
      }
      await this.repository.insertOutbox(
        tx,
        rows.map((row) => ({
          ...row,
          orderEventId: requireId(eventIds[eventIndexForNotification(row.type, events)]),
        })),
        now,
      );
      return this.requireRecord(tx, order.id);
    });
    return toOrderView(record, actor);
  }

  /**
   * The approval's holds. Lock order, the same in every path that takes both: the supply lock, then
   * the order row. The row is taken before the inserts so a concurrent item edit (order row, then
   * its lines) cannot wait for this transaction's foreign key locks while this one waits for the row.
   */
  private async allocationOfMove(
    tx: Tx,
    actor: Actor,
    order: OrderRecord,
    command: z.output<typeof transitionCommandSchema>,
    approving: boolean,
    now: Date,
  ): Promise<{ mode: PlanMode; rows: PayloadLine[] } | null> {
    if (!approving) {
      if (command.allocationMode !== undefined || command.allocations !== undefined) {
        throw new InputValidationError([
          { path: 'allocations', message: 'Stock is allocated while approving' },
        ]);
      }
      return null;
    }
    if (command.allocationMode === undefined || command.allocations === undefined) {
      throw new InputValidationError([
        { path: 'allocations', message: 'An allocation plan is required to approve' },
      ]);
    }
    if (!can(actor, 'MANAGE_ORDER_ALLOCATION')) throw new ForbiddenError('Access denied');
    await this.lockSupplyAndOrder(tx, order);
    const state = await this.supplyStateOf(tx, order);
    const holds = await this.judgedHolds(
      tx,
      order,
      state,
      command.allocationMode,
      command.allocations,
    );
    await this.createHolds(tx, actor, order, holds, now);
    return { mode: command.allocationMode, rows: this.allocationPayload(order, holds) };
  }

  /** After both locks the order must still be the one that was read; waiting may have changed it. */
  private async lockSupplyAndOrder(tx: Tx, order: OrderRecord): Promise<void> {
    await this.supply.lockSupply(tx);
    await this.repository.lockOrder(tx, order.id);
    const current = await this.repository.findById(order.id, tx);
    if (current?.rowVersion !== order.rowVersion || current.status !== order.status) {
      throw this.changedError(current?.status ?? order.status);
    }
  }

  private supplyStateOf(db: DbClient, order: OrderRecord): Promise<SupplyState> {
    return this.supply.readState(db, trackedProductIds(order.items), order.id);
  }

  /** The owner's rules for a plan: a fresh plan on a change, the shortage named, nothing silent. */
  private async judgedHolds(
    tx: Tx,
    order: OrderRecord,
    state: SupplyState,
    mode: PlanMode,
    requested: readonly AllocationRequestRow[],
  ): Promise<readonly PlannedHold[]> {
    const verdict = judgePlan(demandOf(order.items), state.lines, mode, holdsOf(requested));
    switch (verdict.outcome) {
      case 'ACCEPTED':
        return verdict.holds;
      case 'INVALID':
        throw new InputValidationError(verdict.issues);
      case 'ALLOCATION_CHANGED':
        throw new ConflictError('The stock changed; check the new plan', 'ALLOCATION_CHANGED', {
          preview: await this.previewOf(tx, order, state),
        });
      case 'STOCK_INSUFFICIENT':
        throw new ConflictError('Not enough stock for this order', 'STOCK_INSUFFICIENT', {
          preview: await this.previewOf(tx, order, state),
        });
    }
  }

  private async previewOf(
    db: DbClient,
    order: OrderRecord,
    state: SupplyState,
  ): Promise<AllocationPreview> {
    const earlier =
      order.status === 'SUBMITTED'
        ? await this.repository.earlierDemand(
            db,
            order.id,
            trackedProductIds(order.items),
            order.submittedAt,
          )
        : new Map<string, EarlierDemand>();
    return buildAllocationPreview(order, state, earlier);
  }

  private async createHolds(
    tx: Tx,
    actor: Actor,
    order: OrderRecord,
    holds: readonly PlannedHold[],
    now: Date,
  ): Promise<void> {
    const productOf = new Map(order.items.map((item) => [item.id, item.productId]));
    await this.supply.createHolds(tx, {
      orderId: order.id,
      holds,
      productOf: (orderItemId) => productOf.get(orderItemId) ?? '',
      createdBy: actor.userId,
      now,
    });
  }

  /**
   * What the event records: which line, how much. The line id and not its delivery ref, a staff-only
   * field kept out of every order payload; delivery lines are never deleted, so the id stays readable.
   */
  private allocationPayload(order: OrderRecord, holds: readonly PlannedHold[]): PayloadLine[] {
    const codeOf = new Map(order.items.map((item) => [item.id, item.productCodeSnapshot]));
    return holds.map((hold) => ({
      orderItemId: hold.orderItemId,
      productCode: codeOf.get(hold.orderItemId) ?? '',
      supplyLineId: hold.supplyLineId,
      quantity: formatQuantity(hold.quantity),
    }));
  }

  // -------------------------------------------------------------- stock holds

  /**
   * The manager's view of an order's stock: the FIFO proposal, what is short, who came earlier, the
   * current holds and what needs a look. For an approved order the FIFO is the ready alternative: the
   * order's own holds do not count against it. Reads only.
   */
  async allocationPreview(actor: Actor, orderId: string): Promise<AllocationPreview> {
    const db = this.repository.db;
    const order = await this.loadVisible(db, actor, orderId);
    if (!can(actor, 'MANAGE_ORDER_ALLOCATION')) throw new ForbiddenError('Access denied');
    if (!ALLOCATION_READABLE.includes(order.status)) throw this.allocationClosed(order);
    return this.previewOf(db, order, await this.supplyStateOf(db, order));
  }

  /**
   * [C] owner 2026-10-30: until the release the manager may move an approved order's holds. Old rows
   * are voided, new ones added, one ALLOCATION_CHANGED event with before and after, all in one
   * transaction. Not a workflow step, so the row version stays: an accountant's or warehouse decision
   * in progress is not made stale by it. An older approved order may get its first holds here.
   */
  async setAllocations(
    actor: Actor,
    orderId: string,
    rawCommand: SetAllocationsCommand,
  ): Promise<AllocationPreview> {
    const command = parseInput(setAllocationsCommandSchema, rawCommand);
    return this.repository.transaction(async (tx) => {
      const order = await this.loadVisible(tx, actor, orderId);
      if (!can(actor, 'MANAGE_ORDER_ALLOCATION')) throw new ForbiddenError('Access denied');
      if (this.isStale(command.expectedRowVersion, order)) throw this.changedError(order.status);
      await this.lockSupplyAndOrder(tx, order);
      if (!ALLOCATION_CHANGEABLE.includes(order.status)) throw this.allocationClosed(order);

      const before = await this.supplyStateOf(tx, order);
      const holds = await this.judgedHolds(
        tx,
        order,
        before,
        command.allocationMode,
        command.allocations,
      );
      if (samePlan(before.own, holds)) return this.previewOf(tx, order, before);

      const now = this.clock.now();
      const voided = await this.supply.voidHolds(tx, order.id, actor.userId, now);
      await this.createHolds(tx, actor, order, holds, now);
      await this.repository.insertEvents(tx, [
        {
          orderId: order.id,
          eventType: 'ALLOCATION_CHANGED',
          fromStatus: null,
          toStatus: null,
          actorUserId: actor.userId,
          actorRole: 'MANAGER',
          comment: command.comment?.trim() || null,
          payload: {
            before: { allocations: this.allocationPayload(order, before.own), voided },
            after: {
              allocationMode: command.allocationMode,
              allocations: this.allocationPayload(order, holds),
            },
          },
          createdAt: now,
        },
      ]);
      return this.previewOf(tx, order, await this.supplyStateOf(tx, order));
    });
  }

  private allocationClosed(order: OrderRecord): ConflictError {
    return new ConflictError(
      `Stock cannot be held while the order is ${order.status}`,
      'ALLOCATION_NOT_CHANGEABLE',
      { currentStatus: order.status },
    );
  }

  private isStale(expectedRowVersion: number | undefined, order: OrderRecord): boolean {
    return expectedRowVersion !== undefined && expectedRowVersion !== order.rowVersion;
  }

  private deferredUnavailable(productIds: string[]): ConflictError {
    return new ConflictError('Some products have no deferred price', 'DEFERRED_PRICE_UNAVAILABLE', {
      productIds,
    });
  }

  private changedError(currentStatus: OrderRecord['status']): ConflictError {
    return new ConflictError('The order was changed by someone else', 'ORDER_CHANGED', {
      currentStatus,
    });
  }

  private async assertActiveDriver(userId: string): Promise<void> {
    const person = (await this.identity.findSummaries([userId])).get(userId);
    if (!person || person.status !== 'ACTIVE' || !person.staffRoles.includes('DRIVER')) {
      throw new InputValidationError([
        { path: 'driverUserId', message: 'The driver must be an active user with the driver role' },
      ]);
    }
  }

  // ------------------------------------------------------------ manager edit

  /**
   * Lifecycle 3.2: while the order is SUBMITTED the manager can change quantities and remove
   * lines. Prices stay the order's own snapshot (no new price list). One ITEMS_EDITED event per
   * save with the before/after of all lines and totals, one notification to the customer with
   * the old and new totals, and a row_version bump.
   */
  async editItems(actor: Actor, orderId: string, rawCommand: EditItemsCommand): Promise<OrderView> {
    const command = parseInput(
      isStaffActor(actor) ? staffEditItemsCommandSchema : editItemsCommandSchema,
      rawCommand,
    );
    const record = await this.repository.transaction(async (tx) => {
      const order = await this.loadVisible(tx, actor, orderId);
      if (!holdsAnyGrantFor(actor, 'EDIT_ORDER_ITEMS')) throw new ForbiddenError('Access denied');
      if (this.isStale(command.expectedRowVersion, order)) throw this.changedError(order.status);
      if (order.status !== 'SUBMITTED') {
        throw new ConflictError(
          'The items of an order can only be edited while it is SUBMITTED',
          'ORDER_NOT_EDITABLE',
          { currentStatus: order.status },
        );
      }
      if (!can(actor, 'EDIT_ORDER_ITEMS', resourceContextOf(order))) {
        throw new ForbiddenError('Access denied');
      }

      const byId = new Map(order.items.map((item) => [item.id, item]));
      const unknown = command.changes
        .map((change, index) => ({ change, index }))
        .filter(({ change }) => !byId.has(change.itemId));
      if (unknown.length > 0) {
        throw new InputValidationError(
          unknown.map(({ index }) => ({
            path: `changes.${index}.itemId`,
            message: 'This line does not belong to the order',
          })),
        );
      }

      const updates = new Map<string, Prisma.Decimal>();
      const removals = new Set<string>();
      for (const change of command.changes) {
        const item = byId.get(change.itemId);
        if (item === undefined) continue;
        if (change.quantity === null) {
          removals.add(item.id);
          continue;
        }
        const quantity = parseQuantity(change.quantity);
        if (quantity !== null && !quantity.equals(item.quantity)) updates.set(item.id, quantity);
      }
      if (updates.size === 0 && removals.size === 0) return order; // nothing really changed

      const afterItems = order.items
        .filter((item) => !removals.has(item.id))
        .map((item) => {
          const quantity = updates.get(item.id) ?? item.quantity;
          return { ...item, quantity, lineTotal: lineTotal(quantity, item.unitPrice) };
        });
      if (afterItems.length === 0) {
        throw new InputValidationError([
          {
            path: 'changes',
            message: 'An order must keep at least one line; reject or cancel it instead',
          },
        ]);
      }
      const newTotal = sumAmounts(afterItems.map((item) => item.lineTotal));
      // The order's own rate, never the current one (owner rule).
      const newTotalUsd = orderTotalUsd(afterItems, order.paymentPlan, order.usdRate);
      if (!fitsMoney(newTotal) || !fitsUsd(newTotalUsd)) {
        throw new InputValidationError([
          { path: 'changes', message: 'The order total is too large' },
        ]);
      }

      const now = this.clock.now();
      const applied = await this.repository.updateGuarded(
        tx,
        order.id,
        { status: 'SUBMITTED', rowVersion: order.rowVersion },
        { totalAmount: newTotal, totalUsd: newTotalUsd, updatedAt: now },
      );
      if (!applied) {
        const current = await this.repository.findById(order.id, tx);
        throw this.changedError(current?.status ?? order.status);
      }
      for (const item of afterItems) {
        if (updates.has(item.id)) {
          await this.repository.updateItemQuantity(tx, item.id, item.quantity, item.lineTotal);
        }
      }
      for (const id of removals) await this.repository.deleteItem(tx, id);

      const actorRole = workflowRolesOf(actor)[0];
      if (actorRole === undefined) throw new ForbiddenError('Access denied');
      const [editEventId] = await this.repository.insertEvents(tx, [
        {
          orderId: order.id,
          eventType: 'ITEMS_EDITED',
          fromStatus: null,
          toStatus: null,
          actorUserId: actor.userId,
          actorRole,
          comment: command.reason?.trim() || null,
          payload: {
            before: {
              totalAmount: formatAmount(order.totalAmount),
              totalUsd: formatUsdExact(order.totalUsd),
              lines: order.items.map(recordPayloadLine),
            },
            after: {
              totalAmount: formatAmount(newTotal),
              totalUsd: formatUsdExact(newTotalUsd),
              lines: afterItems.map(recordPayloadLine),
            },
          },
          createdAt: now,
        },
      ]);
      const editContext = this.notificationContext(
        order,
        actor,
        actorRole,
        command.reason?.trim() || null,
      );
      const editChange = {
        oldTotal: formatAmount(order.totalAmount),
        newTotal: formatAmount(newTotal),
        newRowVersion: order.rowVersion + 1,
      };
      const purchasingFacts = await this.purchasingFacts(tx, afterItems);
      const addsMarked = addsMarkedProduct(
        order.items.map((item) => item.productId),
        purchasingFacts.lines,
      );
      await this.repository.insertOutbox(
        tx,
        [
          ...buildItemsEditedNotifications(editContext, editChange),
          ...(addsMarked
            ? [buildPurchasingItemsEditedNotification(editContext, purchasingFacts, editChange)]
            : []),
        ].map((row) => ({ ...row, orderEventId: requireId(editEventId) })),
        now,
      );
      return this.requireRecord(tx, order.id);
    });
    return toOrderView(record, actor);
  }

  // ------------------------------------------------------------ payment plan

  /**
   * Owner rule 2026-10-29: after submitting only the manager changes the customer's payment plan,
   * and only while the order is SUBMITTED. Prices and total are recomputed from the order's OWN
   * snapshots, never the current price list (hard rule 4). Like an edit: one transaction with the
   * guarded write, one event with what moved and the customer-side notification. Choosing the plan the
   * order already has changes nothing and writes nothing.
   */
  async setPaymentPlan(
    actor: Actor,
    orderId: string,
    rawCommand: PaymentPlanCommand,
  ): Promise<OrderView> {
    const command = parseInput(paymentPlanCommandSchema, rawCommand);
    const record = await this.repository.transaction(async (tx) => {
      const order = await this.loadVisible(tx, actor, orderId);
      if (!holdsAnyGrantFor(actor, 'SET_PAYMENT_PLAN')) throw new ForbiddenError('Access denied');
      if (this.isStale(command.expectedRowVersion, order)) throw this.changedError(order.status);
      if (order.status !== 'SUBMITTED') {
        throw new ConflictError(
          'The payment plan can only be changed while the order is SUBMITTED',
          'PAYMENT_PLAN_NOT_CHANGEABLE',
          { currentStatus: order.status },
        );
      }
      if (!can(actor, 'SET_PAYMENT_PLAN', resourceContextOf(order))) {
        throw new ForbiddenError('Access denied');
      }
      if (order.paymentPlan === command.paymentPlan) return order;

      return this.applyPaymentPlan(
        tx,
        actor,
        order,
        command.paymentPlan,
        command.reason?.trim() || null,
        buildPaymentPlanChangedNotifications,
      );
    });
    return toOrderView(record, actor);
  }

  /**
   * Owner rule 2026-10-30: the customer may change ONLY the plan, for a short time after submitting
   * and only while the order is SUBMITTED. The time is the server's: a client's countdown is only a
   * courtesy. Scoped to the actor's organization in the query (hard rule 6): anything else is 404.
   */
  async changeOwnPaymentPlan(
    actor: Actor,
    orderId: string,
    rawCommand: OwnPaymentPlanCommand,
  ): Promise<OrderView> {
    const command = parseInput(ownPaymentPlanCommandSchema, rawCommand);
    const organizationId = effectiveMembership(actor)?.organizationId;
    if (organizationId === undefined) throw new ForbiddenError('Access denied');
    const record = await this.repository.transaction(async (tx) => {
      const order = await this.repository.findByIdInOrganization(orderId, organizationId, tx);
      if (!order) throw new NotFoundError('Order not found');
      if (order.status !== 'SUBMITTED') {
        throw new ConflictError(
          'The payment plan can only be changed while the order is SUBMITTED',
          'PAYMENT_PLAN_NOT_CHANGEABLE',
          { currentStatus: order.status },
        );
      }
      if (!can(actor, 'CHANGE_OWN_PAYMENT_PLAN', resourceContextOf(order))) {
        throw new ForbiddenError('Access denied');
      }
      if (this.clock.now().getTime() >= this.paymentPlanChangeEnd(order.submittedAt).getTime()) {
        throw new ConflictError(
          'The time to change the payment plan is over',
          'PAYMENT_PLAN_WINDOW_ENDED',
        );
      }
      if (this.isStale(command.expectedRowVersion, order)) throw this.changedError(order.status);
      if (order.paymentPlan === command.paymentPlan) return order;
      return this.applyPaymentPlan(
        tx,
        actor,
        order,
        command.paymentPlan,
        null,
        buildPaymentPlanChangedByCustomerNotifications,
      );
    });
    return toOrderView(record, actor);
  }

  /** Null unless the customer may change the plan right now; read by the customer order response. */
  /**
   * The offer for the person reading the order: only someone who may change the plan gets one. A
   * staff viewer reads the test order they placed but never changes it.
   */
  paymentPlanChangeOfferFor(actor: Actor, order: OrderView): PaymentPlanChangeOffer | null {
    const mayChange = can(actor, 'CHANGE_OWN_PAYMENT_PLAN', {
      organizationId: order.organizationId,
      status: order.status,
    });
    return mayChange ? this.paymentPlanChangeOffer(order) : null;
  }

  paymentPlanChangeOffer(order: OrderView): PaymentPlanChangeOffer | null {
    const until = this.paymentPlanChangeEnd(order.submittedAt);
    if (order.status !== 'SUBMITTED' || this.clock.now().getTime() >= until.getTime()) return null;
    const deferred = repriceForPlan(order.items, 'DEFERRED');
    return {
      until,
      fullTotal: repriceForPlan(order.items, 'FULL').total,
      deferredTotal: deferred.missingDeferredProductIds.length > 0 ? null : deferred.total,
    };
  }

  private paymentPlanChangeEnd(submittedAt: Date): Date {
    return new Date(submittedAt.getTime() + paymentPlanChangeWindowMs(this.env));
  }

  /**
   * The one write of a plan change, whoever asked. Prices and total come from the order's OWN
   * snapshots, never the current price list (hard rule 4); one transaction with the guarded write,
   * one event with what moved and the notifications the caller chose.
   */
  private async applyPaymentPlan(
    tx: Tx,
    actor: Actor,
    order: OrderRecord,
    paymentPlan: PaymentPlan,
    reason: string | null,
    buildNotifications: (
      context: NotificationContext,
      change: PaymentPlanChangeFacts,
    ) => OutboxRowInput[],
  ): Promise<OrderRecord> {
    const repriced = repriceForPlan(order.items, paymentPlan);
    if (repriced.missingDeferredProductIds.length > 0) {
      throw this.deferredUnavailable(repriced.missingDeferredProductIds);
    }
    // The order's own rate, never the current one (owner rule).
    const totalUsd = orderTotalUsd(repriced.lines, paymentPlan, order.usdRate);
    if (!fitsMoney(repriced.total) || !fitsUsd(totalUsd)) {
      throw new InputValidationError([
        { path: 'paymentPlan', message: 'The order total is too large' },
      ]);
    }

    const now = this.clock.now();
    const applied = await this.repository.updateGuarded(
      tx,
      order.id,
      { status: 'SUBMITTED', rowVersion: order.rowVersion },
      { totalAmount: repriced.total, totalUsd, paymentPlan, updatedAt: now },
    );
    if (!applied) {
      const current = await this.repository.findById(order.id, tx);
      throw this.changedError(current?.status ?? order.status);
    }
    for (const line of repriced.lines) {
      await this.repository.updateItemPrice(tx, line.id, line.unitPrice, line.lineTotal);
    }

    const actorRole = workflowRolesOf(actor)[0];
    if (actorRole === undefined) throw new ForbiddenError('Access denied');
    const oldTotal = formatAmount(order.totalAmount);
    const newTotal = formatAmount(repriced.total);
    const [planEventId] = await this.repository.insertEvents(tx, [
      {
        orderId: order.id,
        eventType: 'PAYMENT_PLAN_CHANGED',
        fromStatus: null,
        toStatus: null,
        actorUserId: actor.userId,
        actorRole,
        comment: reason,
        payload: {
          before: {
            paymentPlan: order.paymentPlan,
            totalAmount: oldTotal,
            totalUsd: formatUsdExact(order.totalUsd),
            lines: order.items.map(recordPayloadLine),
          },
          after: {
            paymentPlan,
            totalAmount: newTotal,
            totalUsd: formatUsdExact(totalUsd),
            lines: repriced.lines.map(recordPayloadLine),
          },
        },
        createdAt: now,
      },
    ]);
    await this.repository.insertOutbox(
      tx,
      buildNotifications(this.notificationContext(order, actor, actorRole, reason), {
        oldPlan: order.paymentPlan,
        newPlan: paymentPlan,
        oldTotal,
        newTotal,
        newRowVersion: order.rowVersion + 1,
      }).map((row) => ({ ...row, orderEventId: requireId(planEventId) })),
      now,
    );
    return this.requireRecord(tx, order.id);
  }

  // ----------------------------------------------------------------- payment

  /**
   * [C] 2026-10-24: the manager chose the payment method when approving and may change it later,
   * while the order is approved and not rejected or cancelled. A staff fact like the payment status:
   * no row version, no notification, nothing in the workflow depends on it. The change is an order
   * event AND an audit row. Setting the value it already has changes nothing and writes nothing.
   */
  async setPaymentMethod(
    actor: Actor,
    orderId: string,
    rawCommand: PaymentMethodCommand,
  ): Promise<OrderView> {
    const command = parseInput(paymentMethodCommandSchema, rawCommand);
    if (!can(actor, 'SET_PAYMENT_METHOD')) throw new ForbiddenError('Access denied');
    const record = await this.repository.transaction(async (tx) => {
      const order = await this.loadVisible(tx, actor, orderId);
      if (!PAYMENT_METHOD_CHANGEABLE.includes(order.status)) {
        throw new ConflictError(
          `The payment method cannot be changed while the order is ${order.status}`,
          'PAYMENT_METHOD_NOT_CHANGEABLE',
          { currentStatus: order.status },
        );
      }
      if (order.paymentMethod === command.paymentMethod) return order;

      const now = this.clock.now();
      const applied = await this.repository.updatePaymentMethodGuarded(
        tx,
        order.id,
        { paymentMethod: order.paymentMethod, status: order.status },
        command.paymentMethod,
        now,
      );
      if (!applied) throw this.changedError(order.status);

      const comment = command.comment?.trim() || null;
      await this.repository.insertEvents(tx, [
        {
          orderId: order.id,
          eventType: 'PAYMENT_METHOD_CHANGED',
          fromStatus: null,
          toStatus: null,
          actorUserId: actor.userId,
          actorRole: 'MANAGER',
          comment,
          payload: {
            before: { paymentMethod: order.paymentMethod },
            after: { paymentMethod: command.paymentMethod },
          },
          createdAt: now,
        },
      ]);
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: ORDER_ENTITY,
        entityId: order.id,
        action: 'ORDER_PAYMENT_METHOD_CHANGED',
        changes: {
          paymentMethod: { from: order.paymentMethod, to: command.paymentMethod },
          ...(comment === null ? {} : { comment: { from: null, to: comment } }),
        },
      });
      return this.requireRecord(tx, order.id);
    });
    return toOrderView(record, actor);
  }

  // ----------------------------------------------------------- goods returned

  /**
   * [P] The warehouse says the goods of an order rejected or cancelled after approval are back. It
   * records a fact and never moves the status (hard rule 2 stays with `transition`). The column
   * write and the event share one transaction (hard rule 12).
   */
  async markGoodsReturned(
    actor: Actor,
    orderId: string,
    rawCommand: GoodsReturnedCommand,
  ): Promise<OrderView> {
    const command = parseInput(goodsReturnedCommandSchema, rawCommand);
    const record = await this.repository.transaction(async (tx) => {
      const order = await this.loadVisible(tx, actor, orderId);
      if (!holdsAnyGrantFor(actor, 'MARK_GOODS_RETURNED'))
        throw new ForbiddenError('Access denied');
      if (this.isStale(command.expectedRowVersion, order)) throw this.changedError(order.status);
      if (goodsReturnStateOf(order) !== 'PENDING') {
        throw new ConflictError(
          'This order has no goods waiting to be returned',
          'GOODS_RETURN_NOT_PENDING',
          { currentStatus: order.status },
        );
      }
      if (!can(actor, 'MARK_GOODS_RETURNED', resourceContextOf(order))) {
        throw new ForbiddenError('Access denied');
      }
      const now = this.clock.now();
      const applied = await this.repository.markGoodsReturnedGuarded(
        tx,
        order.id,
        order.rowVersion,
        actor.userId,
        now,
      );
      if (!applied) throw this.changedError(order.status);
      await this.repository.insertEvents(tx, [
        {
          orderId: order.id,
          eventType: 'GOODS_RETURNED',
          fromStatus: null,
          toStatus: null,
          actorUserId: actor.userId,
          actorRole: 'WAREHOUSE_MANAGER',
          comment: command.comment?.trim() || null,
          payload: {
            before: { goodsReturnedAt: null, goodsReturnedBy: null },
            after: { goodsReturnedAt: now.toISOString(), goodsReturnedBy: actor.userId },
          },
          createdAt: now,
        },
      ]);
      return this.requireRecord(tx, order.id);
    });
    return toOrderView(record, actor);
  }

  // ------------------------------------------------------------------- reads

  /**
   * Orders the actor may see, newest first. The query scope comes from `scopeFor`, the query-side
   * twin of `can`, and is applied in the WHERE clause (hard rule 6): customers get their
   * organization, staff roles all, the warehouse only from MANAGER_APPROVED (plus rejected and
   * cancelled orders that had been approved), a driver only assigned orders.
   */
  async listOrdersFor(actor: Actor, rawFilters: OrderListFilters = {}): Promise<OrderPage> {
    const filters = parseInput(orderListFiltersSchema, rawFilters);
    const scope = scopeFor(actor, 'VIEW_ORDER');
    if (scope.length === 0) return { orders: [], nextCursor: null };
    const limit = filters.limit ?? DEFAULT_ORDER_PAGE_SIZE;
    const page = await this.repository.list({
      filters: scope,
      limit,
      ...(filters.status === undefined ? {} : { status: filters.status }),
      ...(filters.group === undefined
        ? {}
        : { statuses: CUSTOMER_ORDER_GROUP_STATUSES[filters.group] }),
      ...(filters.paymentStatus === undefined ? {} : { paymentStatus: filters.paymentStatus }),
      ...(filters.organizationId === undefined ? {} : { organizationId: filters.organizationId }),
      ...(filters.search === undefined ? {} : { search: { text: filters.search } }),
      ...(filters.cursor === undefined ? {} : { cursor: filters.cursor }),
    });
    const last = page.rows[page.rows.length - 1];
    return {
      orders: page.rows.map((row) => toOrderSummary(row, actor)),
      nextCursor: page.hasMore && last ? last.id : null,
    };
  }

  /** NOT FOUND (never forbidden) when the order does not exist or the actor may not see it. */
  async getOrderFor(actor: Actor, orderId: string): Promise<OrderView> {
    const order = await this.loadVisible(this.repository.db, actor, orderId);
    return toOrderView(order, actor);
  }

  // ----------------------------------------------------------------- helpers

  private async loadVisible(
    client: Parameters<OrdersRepository['findById']>[1],
    actor: Actor,
    orderId: string,
  ): Promise<OrderRecord> {
    const notFound = new NotFoundError('Order not found');
    if (!uuidSchema.safeParse(orderId).success) throw notFound;
    const order = await this.repository.findById(orderId, client);
    if (!order || !can(actor, 'VIEW_ORDER', resourceContextOf(order))) throw notFound;
    return order;
  }

  private async requireRecord(tx: Tx, orderId: string): Promise<OrderRecord> {
    const order = await this.repository.findById(orderId, tx);
    if (!order) throw new Error(`Order ${orderId} vanished inside its own transaction`);
    return order;
  }

  /** The marked flag is the product's current one; the lines are the order's own snapshot. */
  private async purchasingFacts(
    tx: Tx,
    items: readonly OrderRecord['items'][number][],
  ): Promise<PurchasingOrderFacts> {
    const products = await this.catalog.findProductsByIds(
      [...new Set(items.map((item) => item.productId))],
      tx,
    );
    const marked = new Set(products.filter((p) => p.markingRequired).map((p) => p.id));
    return {
      lines: items.map((item) => ({
        productId: item.productId,
        marked: marked.has(item.productId),
        productCode: item.productCodeSnapshot,
        name: item.nameSnapshot,
        quantity: formatQuantity(item.quantity),
        unitPrice: formatAmount(item.unitPrice),
        lineTotal: formatAmount(item.lineTotal),
      })),
    };
  }

  /** Read in the approval's transaction, so the holds it just wrote are there. */
  private async accountantFacts(
    tx: Tx,
    order: OrderRecord,
    paymentMethod: OrderRecord['paymentMethod'],
  ): Promise<AccountantOrderFacts> {
    const allocations = await this.itemAllocations.ofOrder(order.id, tx);
    return {
      paymentMethod: paymentMethod ?? order.paymentMethod,
      paymentPlan: order.paymentPlan,
      lines: order.items.map((item) => ({
        productCode: item.productCodeSnapshot,
        name: item.nameSnapshot,
        quantity: formatQuantity(item.quantity),
        unitPrice: formatAmount(item.unitPrice),
        lineTotal: formatAmount(item.lineTotal),
        supplies: (allocations.get(item.id) ?? []).map((allocation) => ({
          supplyRef: allocation.supplyRef,
          partyNumber: allocation.partyNumber,
          quantity: formatQuantity(allocation.quantity),
        })),
      })),
    };
  }

  private notificationContext(
    order: OrderRecord,
    actor: Actor,
    actorRole: NotificationContext['actorRole'],
    reason: string | null,
  ): NotificationContext {
    return {
      orderId: order.id,
      orderNumber: order.orderNumber,
      organizationId: order.organizationId,
      placedByUserId: order.placedByUserId,
      actorUserId: actor.userId,
      actorRole,
      totalAmount: formatAmount(order.totalAmount),
      currency: order.currency,
      reason,
      driverUserId: order.driverUserId,
      accountingSkipped: false,
    };
  }
}
