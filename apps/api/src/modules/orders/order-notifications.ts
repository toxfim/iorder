import type { OrderStatus, PaymentPlan, StaffRole } from '@iorder/shared';
import type { PaymentMethod } from '@iorder/shared/staff-orders';
import type { AuditValue } from '../audit/index.js';
import {
  customerSideTargets,
  type CustomerSideTarget,
  type OrderOccurrence,
} from './customer-notification-rules.js';
import {
  NOTIFICATION_FOR_STATUS,
  type SideEffect,
  type WorkflowRole,
} from './order-state-machine.js';
import type { NotificationRecipientKind, NotificationType } from './order-types.js';

// Turns the state machine's side-effect descriptors into `notification_outbox` rows. PURE.
// Payloads are an ALLOW-LIST of order facts (order number, status, reason, the customer's own
// totals). They are built field by field and never copied from a database row, so cost data
// (hard rule 7) cannot reach a message. Recipients are resolved to Telegram chats later, by the
// worker that sends the outbox.

export interface OutboxRowInput {
  type: NotificationType;
  recipientKind: NotificationRecipientKind;
  recipientUserId: string | null;
  recipientRole: StaffRole | null;
  recipientOrganizationId: string | null;
  orderId: string;
  payload: Record<string, AuditValue>;
  /** Deterministic: the same fact always yields the same key, so a retry cannot duplicate it. */
  dedupeKey: string;
}

export interface NotificationContext {
  orderId: string;
  orderNumber: string;
  organizationId: string;
  placedByUserId: string;
  actorUserId: string;
  actorRole: WorkflowRole;
  /** Formatted with two decimals. */
  totalAmount: string;
  currency: string;
  reason: string | null;
  driverUserId: string | null;
  /** The manager skipped accounting while approving. */
  accountingSkipped: boolean;
  /** Set only on the manager's approval; it goes to the accountant's row and to no other. */
  accountantFacts?: AccountantOrderFacts | null;
}

/** What the accountant's approval message lists ([C] owner 2026-10-30). No cost, no supplier. */
export interface AccountantOrderFacts {
  paymentMethod: PaymentMethod | null;
  paymentPlan: PaymentPlan;
  lines: readonly {
    productCode: string;
    name: string;
    /** As stored: "4.000". */
    quantity: string;
    unitPrice: string;
    lineTotal: string;
    supplies: readonly { supplyRef: string; partyNumber: string | null; quantity: string }[];
  }[];
}

/**
 * What the purchasing manager's message lists ([C] owner 2026-10-30: "bu tovar va buyurtma raqamlari
 * va order details"): the order's lines, each saying whether it is a marked product. Selling
 * figures only: the role may read cost on its pages, messages stay cost-free.
 */
export interface PurchasingOrderFacts {
  lines: readonly {
    productId: string;
    marked: boolean;
    productCode: string;
    name: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
  }[];
}

/**
 * The outbox row carries at most this much. A big order must not grow every row of the history; the
 * message itself is cut further to Telegram's length (notifications/message-templates.ts).
 */
const MAX_ACCOUNTANT_LINES = 30;
const MAX_ACCOUNTANT_SUPPLIES = 60;

/** The status each notification type announces (the payload names it explicitly). */
const STATUS_OF_NOTIFICATION: Readonly<Record<NotificationType, OrderStatus | null>> = {
  ORDER_SUBMITTED: 'SUBMITTED',
  ORDER_MANAGER_APPROVED: 'MANAGER_APPROVED',
  ORDER_READY_TO_PREPARE: 'MANAGER_APPROVED',
  ORDER_ACCOUNTING_CLEARED: 'ACCOUNTING_CLEARED',
  ORDER_REJECTED: 'REJECTED',
  ORDER_CANCELLED: 'CANCELLED',
  ORDER_RELEASED: 'RELEASED',
  ORDER_DELIVERED: 'DELIVERED',
  ORDER_RECEIVED: 'RECEIVED',
  ORDER_ITEMS_EDITED: null,
  ORDER_PAYMENT_PLAN_CHANGED: null,
};

type Recipient = Pick<
  OutboxRowInput,
  'recipientKind' | 'recipientUserId' | 'recipientRole' | 'recipientOrganizationId'
>;

const role = (staffRole: StaffRole): Recipient => ({
  recipientKind: 'ROLE',
  recipientUserId: null,
  recipientRole: staffRole,
  recipientOrganizationId: null,
});
const user = (userId: string): Recipient => ({
  recipientKind: 'USER',
  recipientUserId: userId,
  recipientRole: null,
  recipientOrganizationId: null,
});
const organizationChat = (organizationId: string): Recipient => ({
  recipientKind: 'ORGANIZATION_CHAT',
  recipientUserId: null,
  recipientRole: null,
  recipientOrganizationId: organizationId,
});

function recipientKey(recipient: Recipient): string {
  switch (recipient.recipientKind) {
    case 'ROLE':
      return `ROLE:${recipient.recipientRole}`;
    case 'USER':
      return `USER:${recipient.recipientUserId}`;
    case 'ORGANIZATION_CHAT':
      return `ORG:${recipient.recipientOrganizationId}`;
  }
}

function customerSideRecipient(
  target: CustomerSideTarget,
  context: NotificationContext,
): Recipient {
  return target === 'CUSTOMER'
    ? organizationChat(context.organizationId)
    : user(context.placedByUserId);
}

/** Null when the target does not apply (a release without a driver). */
function resolveTarget(effect: SideEffect, context: NotificationContext): Recipient | null {
  switch (effect.target) {
    case 'MANAGERS':
      return role('MANAGER');
    case 'ACCOUNTANTS':
      return role('ACCOUNTANT');
    case 'WAREHOUSE_MANAGERS':
      return role('WAREHOUSE_MANAGER');
    case 'DRIVER':
      return context.driverUserId === null ? null : user(context.driverUserId);
    case 'CUSTOMER':
    case 'PLACER':
      return customerSideRecipient(effect.target, context);
  }
}

/**
 * The ONLY keys a message for the customer side may carry: the organization chat and the person
 * who placed the order. Internal staff ids (driver, actor), the actor's role and accounting
 * internals stay out. The reason is the one the staff member wrote, unchanged (decision 8d).
 */
export const CUSTOMER_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  'orderId',
  'orderNumber',
  'status',
  'totalAmount',
  'currency',
  'reason',
  'oldTotalAmount',
  'newTotalAmount',
  'oldPaymentPlan',
  'newPaymentPlan',
]);

/** Customer-facing payloads are cut down to the allow-list, whatever the builder put in. */
function forAudience(
  payload: Record<string, AuditValue>,
  customerFacing: boolean,
): Record<string, AuditValue> {
  if (!customerFacing) return payload;
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => CUSTOMER_PAYLOAD_KEYS.includes(key)),
  );
}

function basePayload(
  type: NotificationType,
  context: NotificationContext,
): Record<string, AuditValue> {
  const payload: Record<string, AuditValue> = {
    orderId: context.orderId,
    orderNumber: context.orderNumber,
    status: STATUS_OF_NOTIFICATION[type],
    actorRole: context.actorRole,
    totalAmount: context.totalAmount,
    currency: context.currency,
  };
  if (context.reason !== null) payload.reason = context.reason;
  if (type === 'ORDER_RELEASED' && context.driverUserId !== null) {
    payload.driverUserId = context.driverUserId;
  }
  if (type === 'ORDER_MANAGER_APPROVED' && context.accountingSkipped) {
    payload.accountingSkipped = true;
  }
  return payload;
}

function row(
  type: NotificationType,
  recipient: Recipient,
  context: NotificationContext,
  payload: Record<string, AuditValue>,
  customerFacing: boolean,
  dedupeSuffix = '',
): OutboxRowInput {
  return {
    type,
    ...recipient,
    orderId: context.orderId,
    // The organization chat is always customer-facing, whoever asked.
    payload: forAudience(
      payload,
      customerFacing || recipient.recipientKind === 'ORGANIZATION_CHAT',
    ),
    dedupeKey: `order:${context.orderId}:${type}:${recipientKey(recipient)}${dedupeSuffix}`,
  };
}

/**
 * The customer-side rows of a change that is not a status move: whoever the customer notification
 * table names for it (nobody, for a silent occurrence).
 */
function customerSideRows(
  occurrence: OrderOccurrence,
  type: NotificationType,
  context: NotificationContext,
  payload: Record<string, AuditValue>,
  dedupeSuffix = '',
): OutboxRowInput[] {
  return customerSideTargets(occurrence).map((target) =>
    row(type, customerSideRecipient(target, context), context, payload, true, dedupeSuffix),
  );
}

/**
 * The event a row belongs to: the step whose target status the row announces, otherwise the
 * last step (the move the person actually asked for ends the transition).
 */
export function eventIndexForNotification(
  type: NotificationType,
  steps: readonly { toStatus: OrderStatus | null }[],
): number {
  const index = steps.findIndex(
    (step) => step.toStatus !== null && NOTIFICATION_FOR_STATUS[step.toStatus] === type,
  );
  return index >= 0 ? index : steps.length - 1;
}

/**
 * The warehouse and the driver work without money (lifecycle 5, their order view has no total), so
 * their messages have none either.
 */
function withoutMoney(payload: Record<string, AuditValue>): Record<string, AuditValue> {
  return Object.fromEntries(
    Object.entries(payload).filter(([key]) => key !== 'totalAmount' && key !== 'currency'),
  );
}

/** Field by field, never spreading what the caller passed: the same allow-list as everything here. */
function accountantDetails(facts: AccountantOrderFacts): Record<string, AuditValue> {
  const kept: AuditValue[] = [];
  let supplies = 0;
  for (const line of facts.lines) {
    if (kept.length === MAX_ACCOUNTANT_LINES) break;
    supplies += line.supplies.length;
    if (supplies > MAX_ACCOUNTANT_SUPPLIES) break;
    kept.push({
      productCode: line.productCode,
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      supplies: line.supplies.map((supply) => ({
        supplyRef: supply.supplyRef,
        partyNumber: supply.partyNumber,
        quantity: supply.quantity,
      })),
    });
  }
  return {
    ...(facts.paymentMethod === null ? {} : { paymentMethod: facts.paymentMethod }),
    paymentPlan: facts.paymentPlan,
    orderLines: kept,
    orderLineCount: facts.lines.length,
  };
}

/** Marked lines first, so a cut can only lose the others. Field by field, like the accountant's. */
function purchasingDetails(facts: PurchasingOrderFacts): Record<string, AuditValue> {
  const ordered = [
    ...facts.lines.filter((line) => line.marked),
    ...facts.lines.filter((line) => !line.marked),
  ];
  return {
    orderLines: ordered.slice(0, MAX_ACCOUNTANT_LINES).map((line) => ({
      productCode: line.productCode,
      name: line.name,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      lineTotal: line.lineTotal,
      marked: line.marked,
      supplies: [],
    })),
    orderLineCount: facts.lines.length,
  };
}

/** True when the edit put a marked product on the order that was not on it before. */
export function addsMarkedProduct(
  productIdsBefore: readonly string[],
  linesAfter: readonly { productId: string; marked: boolean }[],
): boolean {
  return linesAfter.some((line) => line.marked && !productIdsBefore.includes(line.productId));
}

/**
 * The purchasing manager's row, or null when the order holds no marked product: only those orders
 * concern this role ([C] 2026-10-30). Same staff message, with the lines added.
 */
export function buildPurchasingNotification(
  type: 'ORDER_SUBMITTED' | 'ORDER_CANCELLED',
  context: NotificationContext,
  facts: PurchasingOrderFacts,
): OutboxRowInput | null {
  if (!facts.lines.some((line) => line.marked)) return null;
  const payload = { ...basePayload(type, context), ...purchasingDetails(facts) };
  return row(type, role('PURCHASING_MANAGER'), context, payload, false);
}

/** The caller decides whether the edit concerns the role (`addsMarkedProduct`). */
export function buildPurchasingItemsEditedNotification(
  context: NotificationContext,
  facts: PurchasingOrderFacts,
  change: { oldTotal: string; newTotal: string; newRowVersion: number },
): OutboxRowInput {
  const payload = {
    ...basePayload('ORDER_ITEMS_EDITED', context),
    ...purchasingDetails(facts),
    oldTotalAmount: change.oldTotal,
    newTotalAmount: change.newTotal,
    totalAmount: change.newTotal,
  };
  return row(
    'ORDER_ITEMS_EDITED',
    role('PURCHASING_MANAGER'),
    context,
    payload,
    false,
    `:v${change.newRowVersion}`,
  );
}

/** Rows for the effects of one transition (one or two steps). Unresolvable targets are skipped. */
export function buildTransitionNotifications(
  effects: readonly SideEffect[],
  context: NotificationContext,
): OutboxRowInput[] {
  const rows = new Map<string, OutboxRowInput>();
  for (const effect of effects) {
    const recipient = resolveTarget(effect, context);
    if (recipient === null) continue;
    const customerFacing = effect.target === 'CUSTOMER' || effect.target === 'PLACER';
    const fulfilment = effect.target === 'WAREHOUSE_MANAGERS' || effect.target === 'DRIVER';
    const payload = basePayload(effect.type, context);
    if (
      effect.target === 'ACCOUNTANTS' &&
      effect.type === 'ORDER_MANAGER_APPROVED' &&
      context.accountantFacts
    ) {
      Object.assign(payload, accountantDetails(context.accountantFacts));
    }
    const built = row(
      effect.type,
      recipient,
      context,
      fulfilment ? withoutMoney(payload) : payload,
      customerFacing,
    );
    rows.set(built.dedupeKey, built);
  }
  return [...rows.values()];
}

/**
 * The submit notifications: every manager is told about the new order. The customer side is not
 * (its own act; see the customer notification table).
 */
export function buildSubmittedNotifications(context: NotificationContext): OutboxRowInput[] {
  const payload = basePayload('ORDER_SUBMITTED', context);
  return [
    row('ORDER_SUBMITTED', role('MANAGER'), context, payload, false),
    ...customerSideRows('ORDER_SUBMITTED', 'ORDER_SUBMITTED', context, payload),
  ];
}

/**
 * The customer side is told about every manager edit, with the old and new totals [C]. The dedupe
 * key carries the new row_version because an order can be edited more than once.
 */
export function buildItemsEditedNotifications(
  context: NotificationContext,
  change: { oldTotal: string; newTotal: string; newRowVersion: number },
): OutboxRowInput[] {
  const payload = basePayload('ORDER_ITEMS_EDITED', context);
  payload.oldTotalAmount = change.oldTotal;
  payload.newTotalAmount = change.newTotal;
  payload.totalAmount = change.newTotal;
  return customerSideRows(
    'ITEMS_EDITED_BY_MANAGER',
    'ORDER_ITEMS_EDITED',
    context,
    payload,
    `:v${change.newRowVersion}`,
  );
}

export interface PaymentPlanChangeFacts {
  oldPlan: PaymentPlan;
  newPlan: PaymentPlan;
  oldTotal: string;
  newTotal: string;
  newRowVersion: number;
}

function paymentPlanPayload(
  context: NotificationContext,
  change: PaymentPlanChangeFacts,
): Record<string, AuditValue> {
  const payload = basePayload('ORDER_PAYMENT_PLAN_CHANGED', context);
  payload.oldPaymentPlan = change.oldPlan;
  payload.newPaymentPlan = change.newPlan;
  payload.oldTotalAmount = change.oldTotal;
  payload.newTotalAmount = change.newTotal;
  payload.totalAmount = change.newTotal;
  return payload;
}

/**
 * The customer side is told when the manager changes the payment plan, with both totals, like an
 * edit. An order can go back and forth, so the dedupe key carries the new row_version here too.
 */
export function buildPaymentPlanChangedNotifications(
  context: NotificationContext,
  change: PaymentPlanChangeFacts,
): OutboxRowInput[] {
  return customerSideRows(
    'PAYMENT_PLAN_CHANGED_BY_MANAGER',
    'ORDER_PAYMENT_PLAN_CHANGED',
    context,
    paymentPlanPayload(context, change),
    `:v${change.newRowVersion}`,
  );
}

/**
 * The customer changed the plan themselves: the managers are told [P], because the total moved and
 * one of them may be looking at the order. The customer side hears nothing: they did it.
 */
export function buildPaymentPlanChangedByCustomerNotifications(
  context: NotificationContext,
  change: PaymentPlanChangeFacts,
): OutboxRowInput[] {
  const payload = paymentPlanPayload(context, change);
  const suffix = `:v${change.newRowVersion}`;
  return [
    row('ORDER_PAYMENT_PLAN_CHANGED', role('MANAGER'), context, payload, false, suffix),
    ...customerSideRows(
      'PAYMENT_PLAN_CHANGED_BY_CUSTOMER',
      'ORDER_PAYMENT_PLAN_CHANGED',
      context,
      payload,
      suffix,
    ),
  ];
}
