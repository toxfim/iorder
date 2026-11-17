import { Injectable } from '@nestjs/common';
import {
  correctPaymentRequestSchema,
  recordPaymentRequestSchema,
  voidPaymentRequestSchema,
  type CorrectPaymentRequest,
  type PaymentCurrency,
  type RecordPaymentRequest,
  type VoidPaymentRequest,
} from '@iorder/shared/staff-orders';
import { USD_SETTLED_UNDER } from '@iorder/shared';
import type { Actor } from '../../common/auth/actor.js';
import { can } from '../../common/auth/can.js';
import { effectiveMembership, isStaffViewer } from '../../common/auth/permission-matrix.js';
import { businessDayOf } from '../../common/clock/business-time.js';
import { Clock } from '../../common/clock/clock.js';
import type { Tx } from '../../common/database/db-client.js';
import {
  ConflictError,
  ForbiddenError,
  InputValidationError,
  NotFoundError,
} from '../../common/errors/domain-errors.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService, diffFields, type AuditValue } from '../audit/index.js';
import { OrganizationsService } from '../organizations/index.js';
import { toUzs, UsdRateService, uzsToUsd } from '../pricing/index.js';
import { fitsUsd, formatUsdExact } from './order-lines.js';
import { OrdersRepository } from './orders.repository.js';
import { parseInput } from './orders.schemas.js';
import {
  OrganizationPaymentsRepository,
  type OrganizationPaymentRecord,
  type PaymentValue,
} from './organization-payments.repository.js';
import { allocatePayments, balanceOf, type OrganizationBalance } from './payment-allocation.js';

const PAYMENT_ENTITY = 'ORGANIZATION_PAYMENT';

/** A stored payment and its so'm figure; null when it is USD and no rate is known. */
export interface OrganizationPaymentView extends OrganizationPaymentRecord {
  amountUzs: Prisma.Decimal | null;
}

export interface UzsEquivalent {
  receivedTotal: Prisma.Decimal;
  paidTotal: Prisma.Decimal;
  amountDue: Prisma.Decimal;
  overpaid: Prisma.Decimal;
}

/** Every figure of OrganizationBalance is USD. Staff-only (cost-class: the rates). */
export interface OrganizationBalanceView extends OrganizationBalance {
  organizationId: string;
  usdRate: Prisma.Decimal | null;
  uzsEquivalent: UzsEquivalent | null;
  payments: OrganizationPaymentView[];
}

/** Who caused a reallocation: written on every PAYMENT_STATUS_CHANGED order event. */
export interface LedgerActor {
  userId: string;
  role: string;
}

/**
 * Organization payments ([C] 2026-10-26). The debt is kept per organization, in USD (owner rule):
 * the USD totals of its RECEIVED orders, each at its rate from submit, minus the USD values of the
 * payments that are not voided. The manager records payments for the organization (never
 * for an order); the admin corrects or voids a wrong one. The orders' PAID / UNPAID is derived
 * (oldest received order first) and rewritten in the same transaction as whatever changed the
 * debt, with one PAYMENT_STATUS_CHANGED order event per order that changed. Nothing in the
 * fulfillment workflow depends on any of it (hard rule 11).
 */
/** What a payment is worth. */
function paymentValue(
  amount: string,
  currency: PaymentCurrency,
  rate: string | null,
): PaymentValue {
  const decimal = new Prisma.Decimal(amount);
  if (currency === 'USD') return { amount: decimal, currency, rate: null, amountUsd: decimal };
  if (rate === null) {
    throw new InputValidationError([{ path: 'rate', message: "A so'm payment needs a rate" }]);
  }
  const usdRate = new Prisma.Decimal(rate);
  return { amount: decimal, currency, rate: usdRate, amountUsd: uzsToUsd(decimal, usdRate) };
}

/**
 * A so'm amount worth under half a cent is refused, not stored as a payment that shows as $0.00; one
 * too large for the column is refused as well. Applied to a new USD value
 * only: an old tiny payment from before the USD debt can still get its comment corrected.
 */
function assertUsableUsdValue(value: PaymentValue): void {
  if (value.amountUsd.lessThan(USD_SETTLED_UNDER) || !fitsUsd(value.amountUsd)) {
    throw new InputValidationError([
      { path: 'amount', message: 'The amount at this rate is not a valid USD value' },
    ]);
  }
}

function auditedValue(value: PaymentValue): Record<string, AuditValue> {
  return {
    amount: value.amount.toFixed(2),
    currency: value.currency,
    rate: value.rate?.toFixed(4) ?? null,
    amountUsd: formatUsdExact(value.amountUsd),
  };
}

@Injectable()
export class OrganizationPaymentsService {
  constructor(
    private readonly repository: OrganizationPaymentsRepository,
    private readonly orders: OrdersRepository,
    private readonly organizations: OrganizationsService,
    private readonly audit: AuditService,
    private readonly usdRate: UsdRateService,
    private readonly clock: Clock,
  ) {}

  async getBalance(actor: Actor, organizationId: string): Promise<OrganizationBalanceView> {
    if (!can(actor, 'VIEW_ORGANIZATION_BALANCE')) throw new ForbiddenError('Access denied');
    await this.requireOrganization(organizationId);
    return this.balanceView(organizationId);
  }

  /**
   * The caller's own organization: only what is due, in whole so'm at the CURRENT rate, the same
   * rule as the prices customers see (hard rule 1; [P]: the owner's "default USD" may be meant for
   * customers too). Customers never see the payments, the USD figure or the rate.
   */
  async getOwnAmountDue(actor: Actor): Promise<Prisma.Decimal> {
    // A staff viewer belongs to no organization ([C] 2026-11-09): nothing is due, and no
    // organization's balance is read to say so.
    if (isStaffViewer(actor) && can(actor, 'VIEW_OWN_BALANCE')) return new Prisma.Decimal(0);
    const organizationId = effectiveMembership(actor)?.organizationId;
    if (organizationId === undefined || !can(actor, 'VIEW_OWN_BALANCE')) {
      throw new ForbiddenError('Access denied');
    }
    const [received, paid] = await Promise.all([
      this.repository.receivedTotal(organizationId),
      this.repository.paidTotal(organizationId),
    ]);
    const { amountDue } = balanceOf(received, paid);
    if (amountDue.isZero()) return amountDue;
    // A corrupt setting is the same as no rate here: the documented refusal, never a guess.
    const uzs = toUzs(amountDue, 'USD', await this.usdRate.readRateOrNull());
    if (uzs === null) {
      throw new ConflictError(
        'The amount cannot be converted right now',
        'CURRENCY_CONVERSION_UNAVAILABLE',
      );
    }
    return uzs;
  }

  async recordPayment(
    actor: Actor,
    organizationId: string,
    raw: RecordPaymentRequest,
  ): Promise<OrganizationBalanceView> {
    const input = parseInput(recordPaymentRequestSchema, raw);
    if (!can(actor, 'RECORD_ORGANIZATION_PAYMENT')) throw new ForbiddenError('Access denied');
    await this.requireOrganization(organizationId);
    const now = this.clock.now();
    this.assertNotInFuture(input.paidOn, now);
    await this.repository.transaction(async (tx) => {
      await this.repository.lockOrganizationLedger(tx, organizationId);
      const comment = input.comment ?? null;
      const value = paymentValue(input.amount, input.currency, input.rate ?? null);
      assertUsableUsdValue(value);
      const id = await this.repository.insertPayment(tx, {
        organizationId,
        value,
        paidOn: input.paidOn,
        comment,
        recordedBy: actor.userId,
        now,
      });
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: PAYMENT_ENTITY,
        entityId: id,
        action: 'ORGANIZATION_PAYMENT_RECORDED',
        changes: diffFields(
          {},
          { organizationId, ...auditedValue(value), paidOn: input.paidOn, comment },
        ),
      });
      await this.reallocate(tx, organizationId, { userId: actor.userId, role: 'MANAGER' }, now);
    });
    return this.balanceView(organizationId);
  }

  /** Admin only: a wrong amount, currency, rate, day or comment. The reason goes into the audit row. */
  async correctPayment(
    actor: Actor,
    paymentId: string,
    raw: CorrectPaymentRequest,
  ): Promise<OrganizationBalanceView> {
    const input = parseInput(correctPaymentRequestSchema, raw);
    if (!can(actor, 'CORRECT_ORGANIZATION_PAYMENT')) throw new ForbiddenError('Access denied');
    const now = this.clock.now();
    if (input.paidOn !== undefined) this.assertNotInFuture(input.paidOn, now);
    const organizationId = await this.repository.transaction(async (tx) => {
      const before = await this.requireLivePayment(tx, paymentId);
      const currency = input.currency ?? before.currency;
      if (currency === 'USD' && input.rate !== undefined) {
        throw new InputValidationError([{ path: 'rate', message: 'A USD payment has no rate' }]);
      }
      // Staying on so'm keeps the stored rate unless a new one came; USD has none.
      const rate = input.rate ?? (currency === 'UZS' ? before.rate?.toFixed(4) : undefined) ?? null;
      const after = {
        value: paymentValue(input.amount ?? before.amount.toFixed(2), currency, rate),
        paidOn: input.paidOn ?? before.paidOn,
        comment: input.comment === undefined ? before.comment : input.comment,
      };
      if (!after.value.amountUsd.equals(before.amountUsd)) assertUsableUsdValue(after.value);
      const changes = diffFields(
        { ...auditedValue(before), paidOn: before.paidOn, comment: before.comment },
        { ...auditedValue(after.value), paidOn: after.paidOn, comment: after.comment },
      );
      if (Object.keys(changes).length === 0) return before.organizationId;
      await this.repository.correctPayment(tx, paymentId, { ...after, now });
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: PAYMENT_ENTITY,
        entityId: paymentId,
        action: 'ORGANIZATION_PAYMENT_CORRECTED',
        changes: { ...changes, reason: { from: null, to: input.reason } },
      });
      await this.reallocate(
        tx,
        before.organizationId,
        { userId: actor.userId, role: 'ADMIN' },
        now,
      );
      return before.organizationId;
    });
    return this.balanceView(organizationId);
  }

  /** Admin only: the payment stops counting; the row and its history stay. */
  async voidPayment(
    actor: Actor,
    paymentId: string,
    raw: VoidPaymentRequest,
  ): Promise<OrganizationBalanceView> {
    const input = parseInput(voidPaymentRequestSchema, raw);
    if (!can(actor, 'CORRECT_ORGANIZATION_PAYMENT')) throw new ForbiddenError('Access denied');
    const now = this.clock.now();
    const organizationId = await this.repository.transaction(async (tx) => {
      const before = await this.requireLivePayment(tx, paymentId);
      await this.repository.voidPayment(tx, paymentId, {
        voidedBy: actor.userId,
        reason: input.reason,
        now,
      });
      await this.audit.record(tx, {
        actorUserId: actor.userId,
        entityType: PAYMENT_ENTITY,
        entityId: paymentId,
        action: 'ORGANIZATION_PAYMENT_VOIDED',
        changes: {
          voidedAt: { from: null, to: now.toISOString() },
          reason: { from: null, to: input.reason },
        },
      });
      await this.reallocate(
        tx,
        before.organizationId,
        { userId: actor.userId, role: 'ADMIN' },
        now,
      );
      return before.organizationId;
    });
    return this.balanceView(organizationId);
  }

  /**
   * Inside the caller's transaction: takes the organization's ledger lock, then rewrites the
   * PAID / UNPAID of its received orders from the payments, one order event per change. Called by
   * the payment actions above and by the order transition into RECEIVED (which must call it BEFORE
   * it writes the order row, so both paths take the locks in the same order).
   */
  async lockLedger(tx: Tx, organizationId: string): Promise<void> {
    await this.repository.lockOrganizationLedger(tx, organizationId);
  }

  async reallocate(tx: Tx, organizationId: string, by: LedgerActor, now: Date): Promise<void> {
    await this.repository.lockOrganizationLedger(tx, organizationId);
    const [orders, paid] = await Promise.all([
      this.repository.receivedOrdersOldestFirst(tx, organizationId),
      this.repository.paidTotal(organizationId, tx),
    ]);
    const changes = allocatePayments(orders, paid);
    for (const change of changes) {
      const applied = await this.orders.updatePaymentStatusGuarded(
        tx,
        change.id,
        change.from,
        change.to,
        now,
      );
      if (!applied)
        throw new Error(`Payment status of order ${change.id} changed under the ledger lock`);
    }
    await this.orders.insertEvents(
      tx,
      changes.map((change) => ({
        orderId: change.id,
        eventType: 'PAYMENT_STATUS_CHANGED' as const,
        fromStatus: null,
        toStatus: null,
        actorUserId: by.userId,
        actorRole: by.role,
        comment: null,
        payload: {
          before: { paymentStatus: change.from },
          after: { paymentStatus: change.to },
        },
        createdAt: now,
      })),
    );
  }

  private async balanceView(organizationId: string): Promise<OrganizationBalanceView> {
    const [received, paid, payments, usdRate] = await Promise.all([
      this.repository.receivedTotal(organizationId),
      this.repository.paidTotal(organizationId),
      this.repository.listPayments(organizationId),
      // The so'm figures are a courtesy: a corrupt rate setting must not hide the USD debt from staff.
      this.usdRate.readRateOrNull(),
    ]);
    const balance = balanceOf(received, paid);
    const inUzs = (usd: Prisma.Decimal): Prisma.Decimal | null => toUzs(usd, 'USD', usdRate);
    const receivedTotal = inUzs(balance.receivedTotal);
    const paidTotal = inUzs(balance.paidTotal);
    const amountDue = inUzs(balance.amountDue);
    const overpaid = inUzs(balance.overpaid);
    return {
      organizationId,
      ...balance,
      usdRate,
      uzsEquivalent:
        receivedTotal && paidTotal && amountDue && overpaid
          ? { receivedTotal, paidTotal, amountDue, overpaid }
          : null,
      payments: payments.map((payment) => ({
        ...payment,
        amountUzs: payment.currency === 'UZS' ? payment.amount : inUzs(payment.amount),
      })),
    };
  }

  private async requireOrganization(organizationId: string): Promise<void> {
    const found = await this.organizations.findContactInfo([organizationId]);
    if (!found.has(organizationId)) throw new NotFoundError('Organization not found');
  }

  private async requireLivePayment(tx: Tx, paymentId: string): Promise<OrganizationPaymentRecord> {
    const payment = await this.repository.findPayment(paymentId, tx);
    if (payment === null) throw new NotFoundError('Payment not found');
    await this.repository.lockOrganizationLedger(tx, payment.organizationId);
    // Read again under the lock: a void that committed meanwhile is final.
    const locked = await this.repository.findPayment(paymentId, tx);
    if (locked === null) throw new NotFoundError('Payment not found');
    if (locked.voidedAt !== null) {
      throw new ConflictError('The payment is voided', 'PAYMENT_VOIDED');
    }
    return locked;
  }

  // Business days are Asia/Tashkent (hard rule 9): "today" there may already be tomorrow in UTC.
  private assertNotInFuture(paidOn: string, now: Date): void {
    if (paidOn > businessDayOf(now).date) {
      throw new InputValidationError([
        { path: 'paidOn', message: 'The payment day cannot be in the future' },
      ]);
    }
  }
}
