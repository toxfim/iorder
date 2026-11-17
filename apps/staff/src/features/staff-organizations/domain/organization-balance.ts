import type { StaffRole } from '@iorder/shared';
import {
  correctPaymentRequestSchema,
  recordPaymentRequestSchema,
  type CorrectPaymentRequest,
  type OrganizationPayment,
  type PaymentCurrency,
  type RecordPaymentRequest,
} from '@iorder/shared/staff-orders';
import {
  ApiConflictError,
  ApiNotFoundError,
  ApiValidationError,
  InvalidResponseError,
  NetworkError,
  PermissionDeniedError,
  RequestTimeoutError,
} from '@core/lib/api-errors';
import { businessParts, type Clock } from '@core/lib/business-clock';
import { compareMoney, fromCents, isMoney, toCents, usdToUzs, uzsToUsd } from '@core/lib/money';

// Who may do what with an organization's balance ([C] 2026-10-26). UI convenience only: the
// server re-checks every call. Warehouse and driver never see the section.
const BALANCE_READ_ROLES: readonly StaffRole[] = [
  'MANAGER',
  'ADMIN',
  'ACCOUNTANT',
  'PURCHASING_MANAGER',
];

export interface BalancePermissions {
  readonly canView: boolean;
  /** The manager records a payment for the organization (never for an order). */
  readonly canRecord: boolean;
  /** The admin corrects or voids a payment, always with a reason. */
  readonly canFix: boolean;
}

export function balancePermissions(roles: readonly StaffRole[]): BalancePermissions {
  return {
    canView: roles.some((role) => BALANCE_READ_ROLES.includes(role)),
    canRecord: roles.includes('MANAGER'),
    canFix: roles.includes('ADMIN'),
  };
}

/** Today as a calendar day in Asia/Tashkent, `YYYY-MM-DD` (the default "day paid"). */
export function businessToday(clock: Clock): string {
  const p = businessParts(clock.now());
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** `2026-10-19` → `19.10.2026`: a calendar day, so no time zone conversion. */
export function formatPaidOn(day: string): string {
  const [year, month, date] = day.split('-');
  return year && month && date ? `${date}.${month}.${year}` : day;
}

/**
 * What a person typed as an amount (`1 500 000`, `1500000,50`) as a contract money string. `\s`
 * also covers the no-break spaces a pasted formatted amount carries.
 */
export function normalizeAmount(typed: string): string {
  return typed.replace(/\s/g, '').replace(',', '.');
}

/** `12650.0000` -> `12650`: a stored rate as a person would type it. */
export function plainRate(rate: string): string {
  return rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate;
}

export interface PaymentForm {
  readonly amount: string;
  /** Null until the manager picks one: there is no default, a wrong-currency entry costs too much. */
  readonly currency: PaymentCurrency | null;
  /** Only read for a so'm payment. */
  readonly rate: string;
  readonly paidOn: string;
  readonly comment: string;
}

export type PaymentFormField =
  'amount' | 'currency' | 'rate' | 'paidOn' | 'comment' | 'reason' | 'nothing';

export type FormResult<T> =
  | { readonly ok: true; readonly request: T }
  | { readonly ok: false; readonly field: PaymentFormField };

function firstField(issues: readonly { path: readonly PropertyKey[] }[]): PaymentFormField {
  const head = issues[0]?.path[0];
  return head === 'amount' ||
    head === 'currency' ||
    head === 'rate' ||
    head === 'paidOn' ||
    head === 'comment' ||
    head === 'reason'
    ? head
    : 'nothing';
}

/** The manager's new payment, checked with the shared request schema. */
export function buildRecordRequest(form: PaymentForm): FormResult<RecordPaymentRequest> {
  if (form.currency === null) return { ok: false, field: 'currency' };
  const comment = form.comment.trim();
  const parsed = recordPaymentRequestSchema.safeParse({
    amount: normalizeAmount(form.amount),
    currency: form.currency,
    ...(form.currency === 'UZS' ? { rate: normalizeAmount(form.rate) } : {}),
    paidOn: form.paidOn,
    ...(comment === '' ? {} : { comment }),
  });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, field: firstField(parsed.error.issues) };
}

/**
 * The admin's correction: only the fields that differ from the payment are sent, an emptied
 * comment removes it (`null`), and the reason is required. Nothing changed is its own error. A switch
 * to so'm always brings the rate; a switch to USD never does (the server drops the old one).
 */
export function buildCorrectRequest(
  payment: Pick<OrganizationPayment, 'amount' | 'currency' | 'rate' | 'paidOn' | 'comment'>,
  form: PaymentForm,
  reason: string,
): FormResult<CorrectPaymentRequest> {
  if (form.currency === null) return { ok: false, field: 'currency' };
  const amount = normalizeAmount(form.amount);
  const comment = form.comment.trim();
  const changes: {
    amount?: string;
    currency?: PaymentCurrency;
    rate?: string;
    paidOn?: string;
    comment?: string | null;
  } = {};
  // `1500000` and `1500000.00` are the same amount: nothing to correct.
  const sameAmount = isMoney(amount) && compareMoney(amount, payment.amount) === 0;
  if (!sameAmount) changes.amount = amount;
  if (form.currency !== payment.currency) changes.currency = form.currency;
  if (form.currency === 'UZS') {
    const rate = normalizeAmount(form.rate);
    const sameRate = payment.rate !== null && plainRate(rate) === plainRate(payment.rate);
    if (!sameRate) changes.rate = rate;
  }
  if (form.paidOn !== payment.paidOn) changes.paidOn = form.paidOn;
  if (comment !== (payment.comment ?? '')) changes.comment = comment === '' ? null : comment;
  if (Object.keys(changes).length === 0) return { ok: false, field: 'nothing' };
  const parsed = correctPaymentRequestSchema.safeParse({ ...changes, reason: reason.trim() });
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, field: firstField(parsed.error.issues) };
}

/** What the confirm step shows. A preview at two decimals: the server's answer is the real figure. */
export interface PaymentPreview {
  readonly usd: string;
  /** Null: a USD payment while no rate is known. */
  readonly uzs: string | null;
  /** True when `uzs` is the current rate's equivalent rather than what was entered. */
  readonly uzsApprox: boolean;
  readonly debtAfter: string;
  readonly overpaidAfter: string;
}

/**
 * The payment in both currencies and the debt after it, for a form that already passed its checks.
 * A correction replaces the old value, so that value is taken out of the debt first.
 */
export function paymentPreview(
  form: { readonly amount: string; readonly currency: PaymentCurrency; readonly rate: string },
  balance: { readonly amountDue: string; readonly overpaid: string },
  currentRate: string | null,
  replaced: { readonly amountUsd: string } | null,
): PaymentPreview {
  const amount = fromCents(toCents(normalizeAmount(form.amount)));
  const som = form.currency === 'UZS';
  const usd = som ? uzsToUsd(amount, normalizeAmount(form.rate)) : amount;
  const uzs = som ? amount : currentRate === null ? null : usdToUzs(usd, currentRate);
  const after =
    toCents(balance.amountDue) -
    toCents(balance.overpaid) +
    toCents(replaced?.amountUsd ?? '0') -
    toCents(usd);
  return {
    usd,
    uzs,
    uzsApprox: !som,
    debtAfter: fromCents(after > 0n ? after : 0n),
    overpaidAfter: fromCents(after < 0n ? -after : 0n),
  };
}

export interface BalanceErrorMessage {
  readonly key: string;
  /** The payment changed or vanished since it was read: read the balance again. */
  readonly reload: boolean;
}

/** Maps a failed payment call to an i18n key; the server's English text is never shown. */
export function describeBalanceError(error: unknown): BalanceErrorMessage {
  if (error instanceof PermissionDeniedError) return { key: 'apiErrors.denied', reload: false };
  if (error instanceof ApiConflictError && error.reason === 'PAYMENT_VOIDED') {
    return { key: 'organizations.balance.errors.voided', reload: true };
  }
  if (error instanceof ApiConflictError) {
    return { key: 'organizations.balance.errors.conflict', reload: true };
  }
  if (error instanceof ApiNotFoundError) {
    return { key: 'organizations.balance.errors.gone', reload: true };
  }
  if (error instanceof ApiValidationError) {
    const fields = error.issues.map((issue) => issue.path.split('.')[0]);
    if (fields.includes('paidOn'))
      return { key: 'organizations.balance.errors.paidOn', reload: false };
    if (fields.includes('amount'))
      return { key: 'organizations.balance.errors.amount', reload: false };
    if (fields.includes('rate')) return { key: 'organizations.balance.errors.rate', reload: false };
    return { key: 'apiErrors.validation', reload: false };
  }
  if (error instanceof RequestTimeoutError) return { key: 'apiErrors.timeout', reload: false };
  if (error instanceof NetworkError) return { key: 'apiErrors.network', reload: false };
  if (error instanceof InvalidResponseError) {
    return { key: 'apiErrors.invalidResponse', reload: false };
  }
  return { key: 'apiErrors.generic', reload: false };
}
