import type { OrderStatus, PaymentStatus, StaffRole } from '@iorder/shared';
import {
  correctPaymentRequestSchema,
  recordPaymentRequestSchema,
  voidPaymentRequestSchema,
  type OrganizationBalanceResponse,
  type OrganizationPayment,
  type PaymentCurrency,
} from '@iorder/shared/staff-orders';
import {
  ApiConflictError,
  ApiError,
  ApiNotFoundError,
  ApiValidationError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { businessParts } from '@core/lib/business-clock';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { fakeUuid } from '@core/lib/fake-ids';
import { USD_SETTLED_UNDER } from '@iorder/shared';
import {
  fromCents,
  microsToMoney,
  toCents,
  usdToMicros,
  usdToUzs,
  uzsToUsdExact,
} from '@core/lib/money';
import type { OrganizationBalanceApi } from './organization-balance-api';

// In-memory stand-in for the organization payment endpoints (dev and tests only, never in a
// production bundle). It mirrors the server's rules: the debt is the USD totals of the RECEIVED
// orders minus the USD values of the non-voided payments, PAID / UNPAID of those orders follows from
// the payments (oldest received order first), reading is manager / admin / accountant, recording is
// the manager, correcting and voiding is the admin, a voided payment is final (409 PAYMENT_VOIDED), a
// day in the future (Asia/Tashkent) is 422 on `paidOn`, a so'm payment needs its rate and one worth
// under half a cent is 422 on `amount`. USD adds up at six decimals with the server's half cent.

const FAKE_BALANCE_MARKER = 'fake-organization-balance';

/** One order as the balance sees it; `setPaymentStatus` writes the derived status back. */
export interface FakeBalanceOrder {
  readonly organizationId: string;
  readonly status: OrderStatus;
  readonly submittedAt: string;
  /** At the order's rate from submit; up to six decimals, like the server's column. */
  readonly totalUsd: string;
  readonly paymentStatus: PaymentStatus;
  readonly setPaymentStatus: (status: PaymentStatus) => void;
}

export interface FakeOrganizationBalanceOptions {
  readonly latencyMs?: number;
  readonly scenario?: () => FakeScenario;
  readonly actor?: () => { readonly name: string; readonly roles: readonly StaffRole[] } | null;
  readonly now?: () => Date;
  /** Every order, read at call time (totals change with item edits). */
  readonly orders: () => readonly FakeBalanceOrder[];
  /** The current rate setting; null = none exists. */
  readonly currentRate?: () => string | null;
  /** Who recorded the seeded payments (a manager of the fixtures). */
  readonly seedRecorderName?: string;
}

interface PaymentRecord {
  id: string;
  organizationId: string;
  amount: string;
  currency: PaymentCurrency;
  rate: string | null;
  /** Two decimals, as the API answers it. */
  amountUsd: string;
  /** What the debt counts: six decimals, like the server's column. */
  usdMicros: bigint;
  paidOn: string;
  comment: string | null;
  recordedByName: string;
  recordedByUserId: string;
  recordedAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  updatedAt: string;
}

const READ_ROLES: readonly StaffRole[] = ['MANAGER', 'ADMIN', 'ACCOUNTANT', 'PURCHASING_MANAGER'];
const SETTLED_UNDER = usdToMicros(USD_SETTLED_UNDER);

function issuesOf(error: {
  issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): ApiValidationError {
  return new ApiValidationError(
    'Request validation failed',
    'VALIDATION_FAILED',
    error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  );
}

function businessDay(instant: Date): string {
  const p = businessParts(instant);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function createFakeOrganizationBalance(
  options: FakeOrganizationBalanceOptions,
): OrganizationBalanceApi {
  const latencyMs = options.latencyMs ?? 0;
  const now = options.now ?? (() => new Date());
  let counter = 0;
  const payments: PaymentRecord[] = [];
  const currentRate = options.currentRate ?? (() => '12650.0000');

  // The seeded orders already marked PAID among the RECEIVED ones were paid by someone: one
  // seeded payment per organization covers exactly them, so the first figures agree with the
  // orders' badges.
  const seeded = new Map<string, bigint>();
  for (const order of options.orders()) {
    if (order.status !== 'RECEIVED' || order.paymentStatus !== 'PAID') continue;
    seeded.set(
      order.organizationId,
      (seeded.get(order.organizationId) ?? 0n) + usdToMicros(order.totalUsd),
    );
  }
  for (const [organizationId, micros] of seeded) {
    const at = new Date(now().getTime() - 3 * 24 * 60 * 60_000).toISOString();
    payments.push({
      id: fakeUuid(`payment:seed:${organizationId}`),
      organizationId,
      amount: microsToMoney(micros),
      currency: 'USD',
      rate: null,
      amountUsd: microsToMoney(micros),
      usdMicros: micros,
      paidOn: businessDay(new Date(at)),
      comment: null,
      recordedByName: options.seedRecorderName ?? 'Manager',
      recordedByUserId: fakeUuid(`person:${options.seedRecorderName ?? 'Manager'}`),
      recordedAt: at,
      voidedAt: null,
      voidReason: null,
      updatedAt: at,
    });
  }

  async function delay(): Promise<void> {
    if (latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, latencyMs));
  }

  function gate(roles: readonly StaffRole[]): { readonly name: string } {
    const who = options.actor?.();
    if (!who || !who.roles.some((role) => roles.includes(role))) throw new PermissionDeniedError();
    return who;
  }

  function received(organizationId: string): FakeBalanceOrder[] {
    return options
      .orders()
      .filter((o) => o.organizationId === organizationId && o.status === 'RECEIVED')
      .sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  }

  function paidMicros(organizationId: string): bigint {
    return payments
      .filter((p) => p.organizationId === organizationId && p.voidedAt === null)
      .reduce((sum, p) => sum + p.usdMicros, 0n);
  }

  // Oldest received order first; the first one the money does not cover stops the run. Only money
  // really left covers an order, and a shortfall under half a cent is settled, as on the server.
  function derive(organizationId: string): void {
    let left = paidMicros(organizationId);
    let covering = true;
    for (const order of received(organizationId)) {
      const total = usdToMicros(order.totalUsd);
      covering = covering && left > 0n && total - left < SETTLED_UNDER;
      if (covering) left -= total;
      const status: PaymentStatus = covering ? 'PAID' : 'UNPAID';
      if (order.paymentStatus !== status) order.setPaymentStatus(status);
    }
  }

  function balanceOf(organizationId: string): OrganizationBalanceResponse {
    const receivedMicros = received(organizationId).reduce(
      (sum, o) => sum + usdToMicros(o.totalUsd),
      0n,
    );
    const paid = paidMicros(organizationId);
    const difference = receivedMicros - paid;
    const settled = (difference < 0n ? -difference : difference) < SETTLED_UNDER;
    const rate = currentRate();
    const inUzs = (usd: string): string | null => (rate === null ? null : usdToUzs(usd, rate));
    const figures = {
      receivedTotal: microsToMoney(receivedMicros),
      paidTotal: microsToMoney(paid),
      amountDue: microsToMoney(!settled && difference > 0n ? difference : 0n),
      overpaid: microsToMoney(!settled && difference < 0n ? -difference : 0n),
    };
    const list: OrganizationPayment[] = payments
      .filter((p) => p.organizationId === organizationId)
      .sort((a, b) => b.paidOn.localeCompare(a.paidOn) || b.recordedAt.localeCompare(a.recordedAt))
      .map((p) => ({
        id: p.id,
        organizationId: p.organizationId,
        amount: p.amount,
        currency: p.currency,
        rate: p.rate,
        amountUsd: p.amountUsd,
        amountUzs: p.currency === 'UZS' ? p.amount : inUzs(p.amount),
        paidOn: p.paidOn,
        comment: p.comment,
        recordedByName: p.recordedByName,
        recordedByUserId: p.recordedByUserId,
        recordedAt: p.recordedAt,
        voidedAt: p.voidedAt,
        voidReason: p.voidReason,
        updatedAt: p.updatedAt,
      }));
    return {
      organizationId,
      currency: 'USD',
      ...figures,
      usdRate: rate,
      uzsEquivalent:
        rate === null
          ? null
          : {
              receivedTotal: usdToUzs(figures.receivedTotal, rate),
              paidTotal: usdToUzs(figures.paidTotal, rate),
              amountDue: usdToUzs(figures.amountDue, rate),
              overpaid: usdToUzs(figures.overpaid, rate),
            },
      payments: list,
    };
  }

  function usdMicrosOf(amount: string, currency: PaymentCurrency, rate: string | null): bigint {
    if (currency === 'USD') return usdToMicros(fromCents(toCents(amount)));
    if (rate === null) throw invalid('rate', "A so'm payment needs a rate");
    const micros = usdToMicros(uzsToUsdExact(amount, rate));
    if (micros < SETTLED_UNDER) throw invalid('amount', 'The amount at this rate is worth nothing');
    return micros;
  }

  function invalid(path: string, message: string): ApiValidationError {
    return new ApiValidationError('Request validation failed', 'VALIDATION_FAILED', [
      { path, message },
    ]);
  }

  function notInFuture(paidOn: string | undefined): void {
    if (paidOn !== undefined && paidOn > businessDay(now())) {
      throw invalid('paidOn', 'The payment day cannot be in the future');
    }
  }

  function editable(paymentId: string): PaymentRecord {
    const payment = payments.find((p) => p.id === paymentId);
    if (!payment) throw new ApiNotFoundError('Payment not found', 'NOT_FOUND');
    if (payment.voidedAt !== null) {
      throw new ApiConflictError('The payment is voided', 'CONFLICT', {}, 'PAYMENT_VOIDED');
    }
    return payment;
  }

  function changed(payment: PaymentRecord): OrganizationBalanceResponse {
    payment.updatedAt = now().toISOString();
    derive(payment.organizationId);
    return balanceOf(payment.organizationId);
  }

  return {
    async getBalance(organizationId) {
      const current = options.scenario?.() ?? 'ready';
      if (current === 'loading') return new Promise<never>(() => undefined);
      await delay();
      if (current === 'denied') throw new PermissionDeniedError();
      if (current === 'error') throw new ApiError(`${FAKE_BALANCE_MARKER}: simulated failure`);
      gate(READ_ROLES);
      return balanceOf(organizationId);
    },

    async recordPayment(organizationId, request) {
      await delay();
      const who = gate(['MANAGER']);
      const parsed = recordPaymentRequestSchema.safeParse(request);
      if (!parsed.success) throw issuesOf(parsed.error);
      notInFuture(parsed.data.paidOn);
      const rate = parsed.data.rate ?? null;
      const usdMicros = usdMicrosOf(parsed.data.amount, parsed.data.currency, rate);
      const at = now().toISOString();
      counter += 1;
      payments.push({
        id: fakeUuid(`payment:${organizationId}:${counter}`),
        organizationId,
        amount: fromCents(toCents(parsed.data.amount)),
        currency: parsed.data.currency,
        rate,
        amountUsd: microsToMoney(usdMicros),
        usdMicros,
        paidOn: parsed.data.paidOn,
        comment: parsed.data.comment ?? null,
        recordedByName: who.name,
        recordedByUserId: fakeUuid(`person:${who.name}`),
        recordedAt: at,
        voidedAt: null,
        voidReason: null,
        updatedAt: at,
      });
      derive(organizationId);
      return balanceOf(organizationId);
    },

    async correctPayment(paymentId, request) {
      await delay();
      gate(['ADMIN']);
      const parsed = correctPaymentRequestSchema.safeParse(request);
      if (!parsed.success) throw issuesOf(parsed.error);
      const payment = editable(paymentId);
      notInFuture(parsed.data.paidOn);
      const currency = parsed.data.currency ?? payment.currency;
      if (currency === 'USD' && parsed.data.rate !== undefined) {
        throw invalid('rate', 'A USD payment has no rate');
      }
      const amount = fromCents(toCents(parsed.data.amount ?? payment.amount));
      const rate = currency === 'USD' ? null : (parsed.data.rate ?? payment.rate);
      payment.usdMicros = usdMicrosOf(amount, currency, rate);
      payment.amountUsd = microsToMoney(payment.usdMicros);
      payment.amount = amount;
      payment.currency = currency;
      payment.rate = rate;
      if (parsed.data.paidOn !== undefined) payment.paidOn = parsed.data.paidOn;
      if (parsed.data.comment !== undefined) payment.comment = parsed.data.comment;
      return changed(payment);
    },

    async voidPayment(paymentId, request) {
      await delay();
      gate(['ADMIN']);
      const parsed = voidPaymentRequestSchema.safeParse(request);
      if (!parsed.success) throw issuesOf(parsed.error);
      const payment = editable(paymentId);
      payment.voidedAt = now().toISOString();
      payment.voidReason = parsed.data.reason;
      return changed(payment);
    },
  };
}
