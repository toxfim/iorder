import type { AllocationPreview, PaymentMethod } from '@iorder/shared/staff-orders';
import type { PlanState } from '../composables/use-allocation-plan';
import type { PickingState } from '../composables/use-order-picking';
import { checkItem, type PlanDraft } from './allocation-plan';

// Why a step of the order cannot be taken right now (owner, 2026-11-09: a dead button must say
// why). One list per action, the first thing the person must do first; the same list feeds the
// text beside the button, its tooltip and the dialog a tap opens. An empty list means the button
// works, so every condition that locks a button MUST be a blocker here.

export type BlockerCode =
  | 'BUSY'
  | 'ORDER_LOADING'
  | 'ORDER_UNAVAILABLE'
  | 'UNSAVED_ITEMS'
  | 'PLAN_LOADING'
  | 'PLAN_UNAVAILABLE'
  | 'PLAN_DENIED'
  | 'PLAN_CLOSED'
  | 'STOCK_SHORT'
  | 'STOCK_SHORT_ONE'
  | 'STOCK_SHORT_MANY'
  | 'PLAN_INVALID_ONE'
  | 'PLAN_INVALID_MANY'
  | 'NO_PAYMENT_METHOD'
  | 'WAITING_ACCOUNTING'
  | 'CODES_CHECKING'
  | 'CODES_UNAVAILABLE'
  | 'CODES_MISSING'
  | 'DRIVERS_LOADING'
  | 'DRIVERS_UNAVAILABLE'
  | 'NO_DRIVERS'
  | 'NO_DRIVER_CHOSEN';

export interface Blocker {
  readonly code: BlockerCode;
  /** Values the sentence names (a product, a count). */
  readonly params?: Readonly<Record<string, string | number>>;
}

/** A request is running: nothing else is worth saying until it ends. */
const BUSY: readonly Blocker[] = [{ code: 'BUSY' }];

/** "This product", or "this product and N more". */
function named(one: BlockerCode, many: BlockerCode, names: readonly string[]): Blocker | null {
  const first = names[0];
  if (first === undefined) return null;
  return names.length === 1
    ? { code: one, params: { name: first } }
    : { code: many, params: { name: first, count: names.length - 1 } };
}

export interface ApproveGate {
  readonly busy: boolean;
  /** The approval dialog reads the order itself; the order page already has it. */
  readonly order?: 'loading' | 'error' | 'ready';
  /** The manager has item edits that are not saved. */
  readonly draftPending: boolean;
  readonly planState: PlanState;
  readonly preview: AllocationPreview | null;
  readonly draft: PlanDraft;
  readonly paymentMethod: PaymentMethod | null;
}

function planBlocker(gate: ApproveGate): Blocker | null {
  const { preview } = gate;
  if (preview === null) {
    if (gate.planState === 'error') return { code: 'PLAN_UNAVAILABLE' };
    if (gate.planState === 'denied') return { code: 'PLAN_DENIED' };
    if (gate.planState === 'closed') return { code: 'PLAN_CLOSED' };
    return { code: 'PLAN_LOADING' };
  }
  if (!preview.feasible) {
    const short = preview.items
      .filter((item) => item.stockTracked && item.shortQuantity !== '0.000')
      .map((item) => item.name);
    // The server can refuse a plan without naming a line (stock taken by another order).
    return named('STOCK_SHORT_ONE', 'STOCK_SHORT_MANY', short) ?? { code: 'STOCK_SHORT' };
  }
  const wrong = preview.items
    .filter((item) => checkItem(item, gate.draft) !== 'OK')
    .map((item) => item.name);
  return named('PLAN_INVALID_ONE', 'PLAN_INVALID_MANY', wrong);
}

/**
 * Why the manager cannot approve now. In the order of the screen, which is the order of the work:
 * the items (unsaved edits change what is approved), then the stock plan, then the sale type.
 */
export function approveBlockers(gate: ApproveGate): readonly Blocker[] {
  if (gate.busy) return BUSY;
  if (gate.order === 'loading') return [{ code: 'ORDER_LOADING' }];
  if (gate.order === 'error') return [{ code: 'ORDER_UNAVAILABLE' }];
  const blockers: Blocker[] = [];
  if (gate.draftPending) blockers.push({ code: 'UNSAVED_ITEMS' });
  const plan = planBlocker(gate);
  if (plan !== null) blockers.push(plan);
  if (gate.paymentMethod === null) blockers.push({ code: 'NO_PAYMENT_METHOD' });
  return blockers;
}

/** Why the manager cannot reject now: a rejection would silently drop unsaved item edits. */
export function rejectBlockers(gate: {
  readonly busy: boolean;
  readonly draftPending: boolean;
}): readonly Blocker[] {
  if (gate.busy) return BUSY;
  return gate.draftPending ? [{ code: 'UNSAVED_ITEMS' }] : [];
}

export interface ReleaseGate {
  readonly busy: boolean;
  /** False while the order still waits for accounting (the warehouse only prepares it). */
  readonly cleared: boolean;
  readonly codesState: PickingState;
  readonly codesComplete: boolean;
  readonly codesProgress: { readonly done: number; readonly total: number };
  readonly driversState: 'idle' | 'loading' | 'ready' | 'error' | 'denied';
  readonly driverCount: number;
  readonly driverChosen: boolean;
}

function codesBlocker(gate: ReleaseGate): Blocker | null {
  if (gate.codesComplete) return null;
  if (gate.codesState === 'ready') {
    return { code: 'CODES_MISSING', params: { ...gate.codesProgress } };
  }
  return gate.codesState === 'idle' || gate.codesState === 'loading'
    ? { code: 'CODES_CHECKING' }
    : { code: 'CODES_UNAVAILABLE' };
}

function driverBlocker(gate: ReleaseGate): Blocker | null {
  if (gate.driverChosen) return null;
  if (gate.driversState === 'idle' || gate.driversState === 'loading') {
    return { code: 'DRIVERS_LOADING' };
  }
  if (gate.driversState !== 'ready') return { code: 'DRIVERS_UNAVAILABLE' };
  return gate.driverCount === 0 ? { code: 'NO_DRIVERS' } : { code: 'NO_DRIVER_CHOSEN' };
}

/**
 * Why the warehouse cannot release now: accounting first (nothing the warehouse can do about it),
 * then the goods (every required code scanned), then the driver who takes them.
 */
export function releaseBlockers(gate: ReleaseGate): readonly Blocker[] {
  if (gate.busy) return BUSY;
  const blockers: Blocker[] = [];
  if (!gate.cleared) blockers.push({ code: 'WAITING_ACCOUNTING' });
  const codes = codesBlocker(gate);
  if (codes !== null) blockers.push(codes);
  // The drivers are offered only once the order is cleared; before that there is none to choose.
  const driver = gate.cleared ? driverBlocker(gate) : null;
  if (driver !== null) blockers.push(driver);
  return blockers;
}
