import {
  ORGANIZATION_ROLES,
  STAFF_ROLES,
  type OrderStatus,
  type OrganizationRole,
  type StaffRole,
} from '@iorder/shared';
import type { PermissionAction } from '../../common/auth/permission-matrix.js';
import type { PaymentMethod } from '@iorder/shared/staff-orders';
import {
  customerSideTargetsOfMove,
  type CustomerSideTarget,
} from './customer-notification-rules.js';
import type { NotificationType, OrderEventType } from './order-types.js';

// Source: docs/domain/order-lifecycle.md §3 (transition table), §3.1 (manager skips accounting),
// §5 (admin never performs workflow steps). PURE: no I/O, no clock, no database. The service
// asks it "is this move legal for these roles with this input, and what follows from it?" and
// does the rest inside one transaction. Anything not in TRANSITION_RULES is forbidden.

/** The role an actor acts in: a staff role, or the customer membership role. */
export type WorkflowRole = StaffRole | OrganizationRole;
export const WORKFLOW_ROLES: readonly WorkflowRole[] = [...STAFF_ROLES, ...ORGANIZATION_ROLES];

/** A staff recipient of a side effect. The service turns it into outbox recipient rows. */
export type StaffNotifyTarget = 'MANAGERS' | 'ACCOUNTANTS' | 'WAREHOUSE_MANAGERS' | 'DRIVER';

/**
 * Who a side effect is for. The customer side (the organization chat and the person who placed
 * the order) never appears in the transition table below: `customer-notification-rules.ts` alone
 * decides which moves tell it.
 */
export type NotifyTarget = StaffNotifyTarget | CustomerSideTarget;

export interface SideEffect {
  target: NotifyTarget;
  type: NotificationType;
}

export interface StaffSideEffect extends SideEffect {
  target: StaffNotifyTarget;
}

export interface TransitionRule {
  from: OrderStatus;
  to: OrderStatus;
  /** Roles that may perform the move. Resource conditions (own order, assigned driver) are `can()`'s job. */
  roles: readonly WorkflowRole[];
  /** A reason is mandatory (reject, cancel). */
  reasonRequired: boolean;
  /** The warehouse must name the driver. */
  driverRequired: boolean;
  /** The manager may tick "skip accounting" on this move. */
  allowsSkipAccounting: boolean;
  /** The manager must choose the payment method ([C] 2026-10-24: on approval only). */
  paymentMethodRequired: boolean;
  /** Staff messages only; the customer side is added by `effectsOfRule`. */
  effects: readonly StaffSideEffect[];
}

const CUSTOMERS: readonly WorkflowRole[] = ['SHOP_OWNER', 'SELLER'];

function rule(
  from: OrderStatus,
  to: OrderStatus,
  roles: readonly WorkflowRole[],
  effects: readonly StaffSideEffect[],
  options: { reason?: true; driver?: true; skip?: true; paymentMethod?: true } = {},
): TransitionRule {
  return Object.freeze({
    from,
    to,
    roles: Object.freeze([...roles]),
    reasonRequired: options.reason === true,
    driverRequired: options.driver === true,
    allowsSkipAccounting: options.skip === true,
    paymentMethodRequired: options.paymentMethod === true,
    effects: Object.freeze(effects.map((effect) => Object.freeze({ ...effect }))),
  });
}

/** The message announcing a move to each status (SUBMITTED has its own, see order-notifications). */
export const NOTIFICATION_FOR_STATUS: Readonly<Partial<Record<OrderStatus, NotificationType>>> = {
  MANAGER_APPROVED: 'ORDER_MANAGER_APPROVED',
  ACCOUNTING_CLEARED: 'ORDER_ACCOUNTING_CLEARED',
  REJECTED: 'ORDER_REJECTED',
  CANCELLED: 'ORDER_CANCELLED',
  RELEASED: 'ORDER_RELEASED',
  DELIVERED: 'ORDER_DELIVERED',
  RECEIVED: 'ORDER_RECEIVED',
};

export const TRANSITION_RULES: readonly TransitionRule[] = Object.freeze([
  rule(
    'SUBMITTED',
    'MANAGER_APPROVED',
    ['MANAGER'],
    [
      { target: 'ACCOUNTANTS', type: 'ORDER_MANAGER_APPROVED' },
      // [C] 2026-10-30: the warehouse starts preparing now; the release waits for accounting.
      { target: 'WAREHOUSE_MANAGERS', type: 'ORDER_READY_TO_PREPARE' },
    ],
    { skip: true, paymentMethod: true },
  ),
  rule('SUBMITTED', 'REJECTED', ['MANAGER'], [], { reason: true }),
  // [C] 2026-10-22: only the manager cancels (not customers, not admin). The REJECTED moves are
  // separate transitions and unchanged.
  rule('SUBMITTED', 'CANCELLED', ['MANAGER'], [], { reason: true }),
  rule(
    'MANAGER_APPROVED',
    'ACCOUNTING_CLEARED',
    ['ACCOUNTANT'],
    [{ target: 'WAREHOUSE_MANAGERS', type: 'ORDER_ACCOUNTING_CLEARED' }],
  ),
  rule(
    'MANAGER_APPROVED',
    'REJECTED',
    ['ACCOUNTANT'],
    // [P] The warehouse may already be preparing, as with a cancel.
    [
      { target: 'MANAGERS', type: 'ORDER_REJECTED' },
      { target: 'WAREHOUSE_MANAGERS', type: 'ORDER_REJECTED' },
    ],
    { reason: true },
  ),
  rule(
    'MANAGER_APPROVED',
    'CANCELLED',
    ['MANAGER'],
    // The accountants and the warehouse were told about the approval, so they are told it was
    // cancelled.
    [
      { target: 'ACCOUNTANTS', type: 'ORDER_CANCELLED' },
      { target: 'WAREHOUSE_MANAGERS', type: 'ORDER_CANCELLED' },
    ],
    { reason: true },
  ),
  rule(
    'ACCOUNTING_CLEARED',
    'RELEASED',
    ['WAREHOUSE_MANAGER'],
    [{ target: 'DRIVER', type: 'ORDER_RELEASED' }],
    { driver: true },
  ),
  rule(
    'ACCOUNTING_CLEARED',
    'CANCELLED',
    ['MANAGER'],
    [{ target: 'WAREHOUSE_MANAGERS', type: 'ORDER_CANCELLED' }],
    { reason: true },
  ),
  rule('RELEASED', 'DELIVERED', ['DRIVER'], []),
  rule('DELIVERED', 'RECEIVED', CUSTOMERS, [{ target: 'MANAGERS', type: 'ORDER_RECEIVED' }]),
]);

/**
 * The permission-matrix action that guards a move. The matrix adds the resource conditions
 * (own organization, assigned driver, placed by the actor) that this pure table cannot know.
 */
export function permissionFor(from: OrderStatus, to: OrderStatus): PermissionAction {
  switch (to) {
    case 'MANAGER_APPROVED':
      return 'MANAGER_DECIDE_ORDER';
    case 'REJECTED':
      return from === 'SUBMITTED' ? 'MANAGER_DECIDE_ORDER' : 'ACCOUNTING_DECIDE_ORDER';
    case 'CANCELLED':
      return 'CANCEL_ORDER';
    case 'ACCOUNTING_CLEARED':
      return 'ACCOUNTING_DECIDE_ORDER';
    case 'RELEASED':
      return 'RELEASE_ORDER';
    case 'DELIVERED':
      return 'MARK_DELIVERED';
    case 'RECEIVED':
      return 'CONFIRM_RECEIPT';
    case 'SUBMITTED':
      throw new Error('No move leads to SUBMITTED: an order starts there');
  }
}

/**
 * Everything one move sends: its staff messages, then the customer side when the customer
 * notification table names the move ([C] 2026-11-09), the group before the placer.
 */
export function effectsOfRule(transition: TransitionRule): readonly SideEffect[] {
  const type = NOTIFICATION_FOR_STATUS[transition.to];
  if (type === undefined) return transition.effects;
  const customerSide = customerSideTargetsOfMove(transition.from, transition.to);
  return [...transition.effects, ...customerSide.map((target): SideEffect => ({ target, type }))];
}

export function findRule(from: OrderStatus, to: OrderStatus): TransitionRule | undefined {
  return TRANSITION_RULES.find((candidate) => candidate.from === from && candidate.to === to);
}

/** The statuses an order can still move to from `from`, for any role (UI hints, tests). */
export function nextStatuses(from: OrderStatus): readonly OrderStatus[] {
  return TRANSITION_RULES.filter((candidate) => candidate.from === from).map((r) => r.to);
}

/** True when some role in `roles` may perform any move that leads to `to` (ignores the from status). */
export function mayEverMoveTo(roles: readonly WorkflowRole[], to: OrderStatus): boolean {
  return TRANSITION_RULES.some(
    (candidate) => candidate.to === to && candidate.roles.some((role) => roles.includes(role)),
  );
}

/**
 * True when an order that is now `current` already is `target` or has moved past it. Used to
 * tell the loser of a race ("someone already did this or more") from a really illegal request.
 */
export function isAtOrBeyond(current: OrderStatus, target: OrderStatus): boolean {
  // Nothing leads to SUBMITTED, so a request for it is never "somebody was faster".
  if (!TRANSITION_RULES.some((candidate) => candidate.to === target)) return false;
  const seen = new Set<OrderStatus>([target]);
  const queue: OrderStatus[] = [target];
  for (let status = queue.shift(); status !== undefined; status = queue.shift()) {
    for (const next of nextStatuses(status)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen.has(current);
}

export interface TransitionInput {
  from: OrderStatus;
  to: OrderStatus;
  /** Every role the actor could act in (several staff roles are possible). */
  roles: readonly WorkflowRole[];
  reason?: string | null;
  driverUserId?: string | null;
  skipAccounting?: boolean;
  paymentMethod?: PaymentMethod | null;
}

/** One status change that ends up as one `order_events` row. */
export interface TransitionStep {
  from: OrderStatus;
  to: OrderStatus;
  eventType: Extract<OrderEventType, 'STATUS_CHANGED' | 'ACCOUNTING_SKIPPED'>;
}

export interface InputIssue {
  path: string;
  message: string;
}

export type TransitionDecision =
  | {
      outcome: 'ALLOWED';
      /** The role that is allowed to do it, recorded as `actor_role`. */
      actingRole: WorkflowRole;
      /** One step, or two when the manager skips accounting. The last step's `to` is the final status. */
      steps: readonly TransitionStep[];
      effects: readonly SideEffect[];
      /** Trimmed reason, null when none was given. */
      reason: string | null;
      driverUserId: string | null;
      /** Set exactly when the move requires it (the manager's approval). */
      paymentMethod: PaymentMethod | null;
    }
  | { outcome: 'ILLEGAL_TRANSITION' }
  | { outcome: 'ROLE_NOT_ALLOWED'; allowedRoles: readonly WorkflowRole[] }
  | { outcome: 'INPUT_INVALID'; issues: readonly InputIssue[] };

function checkInput(
  transition: TransitionRule,
  input: TransitionInput,
  reason: string | null,
  driverUserId: string | null,
): InputIssue[] {
  const issues: InputIssue[] = [];
  if (transition.reasonRequired && reason === null) {
    issues.push({ path: 'reason', message: 'A reason is required' });
  }
  if (transition.driverRequired && driverUserId === null) {
    issues.push({ path: 'driverUserId', message: 'A driver is required to release the order' });
  }
  if (!transition.driverRequired && driverUserId !== null) {
    issues.push({ path: 'driverUserId', message: 'A driver can only be set when releasing' });
  }
  const paymentMethod = input.paymentMethod ?? null;
  if (transition.paymentMethodRequired && paymentMethod === null) {
    issues.push({ path: 'paymentMethod', message: 'A payment method is required to approve' });
  }
  if (!transition.paymentMethodRequired && paymentMethod !== null) {
    issues.push({
      path: 'paymentMethod',
      message: 'A payment method is chosen on approval or changed on its own endpoint',
    });
  }
  if (input.skipAccounting === true && !transition.allowsSkipAccounting) {
    issues.push({
      path: 'skipAccounting',
      message: 'Accounting can only be skipped while the manager approves a submitted order',
    });
  }
  return issues;
}

function isBlank(value: string | null | undefined): value is null | undefined {
  return value === null || value === undefined || value.trim() === '';
}

/**
 * Decides one requested move. Order of the answers: a move that does not exist for anyone is
 * ILLEGAL_TRANSITION; a move that exists but not for these roles is ROLE_NOT_ALLOWED; missing or
 * unexpected input is INPUT_INVALID. Resource facts (own organization, assigned driver) are NOT
 * checked here: `can()` does that with the loaded order.
 */
export function decideTransition(input: TransitionInput): TransitionDecision {
  const transition = findRule(input.from, input.to);
  if (!transition) return { outcome: 'ILLEGAL_TRANSITION' };

  const actingRole = input.roles.find((role) => transition.roles.includes(role));
  if (actingRole === undefined) {
    return { outcome: 'ROLE_NOT_ALLOWED', allowedRoles: transition.roles };
  }

  const reason = isBlank(input.reason) ? null : input.reason.trim();
  const driverUserId = isBlank(input.driverUserId) ? null : input.driverUserId.trim();
  const issues = checkInput(transition, input, reason, driverUserId);
  if (issues.length > 0) return { outcome: 'INPUT_INVALID', issues };

  const steps: TransitionStep[] = [
    { from: transition.from, to: transition.to, eventType: 'STATUS_CHANGED' },
  ];
  let effects = effectsOfRule(transition);

  if (input.skipAccounting === true) {
    // §3.1: in the same transaction SUBMITTED -> MANAGER_APPROVED continues to ACCOUNTING_CLEARED.
    // The accountant is still told about a new order (first effect list). The warehouse gets ONE
    // message, "ready" from the clearing step: "prepare, accounting pending" would be untrue here.
    // The customer side hears about the approval only: the clearance is silent for it.
    const clearing = findRule('MANAGER_APPROVED', 'ACCOUNTING_CLEARED');
    if (!clearing)
      throw new Error('The transition table has no MANAGER_APPROVED -> ACCOUNTING_CLEARED');
    steps.push({
      from: 'MANAGER_APPROVED',
      to: 'ACCOUNTING_CLEARED',
      eventType: 'ACCOUNTING_SKIPPED',
    });
    effects = [
      ...effects.filter((effect) => effect.target !== 'WAREHOUSE_MANAGERS'),
      ...effectsOfRule(clearing),
    ];
  }

  return {
    outcome: 'ALLOWED',
    actingRole,
    steps,
    effects,
    reason,
    driverUserId,
    paymentMethod: input.paymentMethod ?? null,
  };
}
