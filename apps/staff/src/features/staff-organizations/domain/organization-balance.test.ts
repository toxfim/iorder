import { describe, expect, it } from 'vitest';
import { ApiConflictError, ApiValidationError, PermissionDeniedError } from '@core/lib/api-errors';
import {
  balancePermissions,
  buildCorrectRequest,
  buildRecordRequest,
  businessToday,
  describeBalanceError,
  formatPaidOn,
  normalizeAmount,
  paymentPreview,
  plainRate,
} from './organization-balance';

const PAYMENT = {
  amount: '500000.00',
  currency: 'UZS' as const,
  rate: '12000.0000',
  paidOn: '2026-10-18',
  comment: 'Naqd',
};
const USD_FORM = { currency: 'USD' as const, rate: '' };
const SOM_FORM = { currency: 'UZS' as const, rate: '12000' };

describe('organization balance domain', () => {
  it('gives each role what the rule says (UI only; the server decides)', () => {
    expect(balancePermissions(['MANAGER'])).toEqual({
      canView: true,
      canRecord: true,
      canFix: false,
    });
    expect(balancePermissions(['ADMIN'])).toEqual({
      canView: true,
      canRecord: false,
      canFix: true,
    });
    expect(balancePermissions(['ACCOUNTANT'])).toEqual({
      canView: true,
      canRecord: false,
      canFix: false,
    });
    expect(balancePermissions(['WAREHOUSE_MANAGER', 'DRIVER']).canView).toBe(false);
  });

  it('dates "today" in Asia/Tashkent, not UTC', () => {
    // 20:30 UTC on the 18th is already 01:30 on the 19th in Tashkent.
    expect(businessToday({ now: () => new Date('2026-10-18T20:30:00.000Z') })).toBe('2026-10-19');
    expect(formatPaidOn('2026-10-09')).toBe('09.10.2026');
  });

  it('reads typed amounts with spaces and a decimal comma', () => {
    expect(normalizeAmount('1 500 000,5')).toBe('1500000.5');
  });

  it('builds the record request with the shared schema; an empty comment is left out', () => {
    const form = { ...USD_FORM, paidOn: '2026-10-19', comment: '' };
    expect(buildRecordRequest({ ...form, amount: '1 000', comment: '  ' })).toEqual({
      ok: true,
      request: { amount: '1000', currency: 'USD', paidOn: '2026-10-19' },
    });
    expect(buildRecordRequest({ ...form, amount: '0' })).toEqual({ ok: false, field: 'amount' });
    expect(buildRecordRequest({ ...form, amount: '1.234' })).toEqual({
      ok: false,
      field: 'amount',
    });
    expect(buildRecordRequest({ ...form, amount: '5', paidOn: '' })).toEqual({
      ok: false,
      field: 'paidOn',
    });
  });

  it('a so\u2019m payment needs a positive rate; a USD payment sends none', () => {
    const form = { amount: '1000', paidOn: '2026-10-19', comment: '' };
    expect(buildRecordRequest({ ...form, currency: 'UZS', rate: '12 650,5' })).toEqual({
      ok: true,
      request: { amount: '1000', currency: 'UZS', rate: '12650.5', paidOn: '2026-10-19' },
    });
    for (const rate of ['', '0', '-1', '1.23456']) {
      expect(buildRecordRequest({ ...form, currency: 'UZS', rate }), rate).toEqual({
        ok: false,
        field: 'rate',
      });
    }
    expect(buildRecordRequest({ ...form, currency: 'USD', rate: '12000' })).toEqual({
      ok: true,
      request: { amount: '1000', currency: 'USD', paidOn: '2026-10-19' },
    });
  });

  it('a form without a chosen currency is not valid, whatever the amount', () => {
    const form = { amount: '1000', currency: null, rate: '', paidOn: '2026-10-19', comment: '' };
    expect(buildRecordRequest(form)).toEqual({ ok: false, field: 'currency' });
    expect(buildRecordRequest({ ...form, amount: '' })).toEqual({ ok: false, field: 'currency' });
    expect(buildCorrectRequest(PAYMENT, form, 'x')).toEqual({ ok: false, field: 'currency' });
  });

  describe('paymentPreview', () => {
    const balance = { amountDue: '500.00', overpaid: '0.00' };

    it('a so\u2019m payment: USD at its own rate, so\u2019m as entered, the debt after it', () => {
      expect(
        paymentPreview(
          { amount: '1 265 000', currency: 'UZS', rate: '12650' },
          balance,
          '13000',
          null,
        ),
      ).toEqual({
        usd: '100.00',
        uzs: '1265000.00',
        uzsApprox: false,
        debtAfter: '400.00',
        overpaidAfter: '0.00',
      });
    });

    it('a USD payment: so\u2019m at the current rate, or none without a rate', () => {
      expect(
        paymentPreview({ amount: '100', currency: 'USD', rate: '' }, balance, '12650', null),
      ).toMatchObject({ usd: '100.00', uzs: '1265000.00', uzsApprox: true, debtAfter: '400.00' });
      expect(
        paymentPreview({ amount: '100', currency: 'USD', rate: '' }, balance, null, null),
      ).toMatchObject({ usd: '100.00', uzs: null });
    });

    it('more than the debt shows as overpaid; an old overpayment counts', () => {
      expect(
        paymentPreview({ amount: '600', currency: 'USD', rate: '' }, balance, null, null),
      ).toMatchObject({ debtAfter: '0.00', overpaidAfter: '100.00' });
      expect(
        paymentPreview(
          { amount: '100', currency: 'USD', rate: '' },
          { amountDue: '0.00', overpaid: '50.00' },
          null,
          null,
        ),
      ).toMatchObject({ debtAfter: '0.00', overpaidAfter: '150.00' });
    });

    it('a correction takes the old value out first', () => {
      expect(
        paymentPreview({ amount: '300', currency: 'USD', rate: '' }, balance, null, {
          amountUsd: '200.00',
        }),
      ).toMatchObject({ debtAfter: '400.00', overpaidAfter: '0.00' });
    });
  });

  it('shows a stored rate the way a person types it', () => {
    expect(plainRate('12650.0000')).toBe('12650');
    expect(plainRate('12650.5000')).toBe('12650.5');
    expect(plainRate('12000')).toBe('12000');
  });

  it('sends only the changed fields of a correction, and refuses no change', () => {
    const form = { ...SOM_FORM, amount: '500000', paidOn: '2026-10-18', comment: 'Naqd' };
    expect(buildCorrectRequest(PAYMENT, form, 'x')).toEqual({ ok: false, field: 'nothing' });
    expect(buildCorrectRequest(PAYMENT, { ...form, amount: '450000' }, ' Xato ')).toEqual({
      ok: true,
      request: { amount: '450000', reason: 'Xato' },
    });
    expect(buildCorrectRequest(PAYMENT, { ...form, comment: '' }, 'x')).toEqual({
      ok: true,
      request: { comment: null, reason: 'x' },
    });
    expect(buildCorrectRequest(PAYMENT, { ...form, paidOn: '2026-10-17' }, '')).toEqual({
      ok: false,
      field: 'reason',
    });
  });

  it('corrects the rate and the currency of a payment', () => {
    const form = { ...SOM_FORM, amount: '500000', paidOn: '2026-10-18', comment: 'Naqd' };
    expect(buildCorrectRequest(PAYMENT, { ...form, rate: '12500' }, 'x')).toEqual({
      ok: true,
      request: { rate: '12500', reason: 'x' },
    });
    expect(buildCorrectRequest(PAYMENT, { ...form, currency: 'USD', amount: '40' }, 'x')).toEqual({
      ok: true,
      request: { amount: '40', currency: 'USD', reason: 'x' },
    });
    const usd = { ...PAYMENT, amount: '40.00', currency: 'USD' as const, rate: null };
    const back = { ...form, amount: '40', currency: 'UZS' as const, rate: '12000' };
    expect(buildCorrectRequest(usd, back, 'x')).toEqual({
      ok: true,
      request: { currency: 'UZS', rate: '12000', reason: 'x' },
    });
    expect(buildCorrectRequest(usd, { ...back, rate: '' }, 'x')).toEqual({
      ok: false,
      field: 'rate',
    });
  });

  it('maps the server answers to translated keys', () => {
    expect(
      describeBalanceError(new ApiConflictError('x', 'CONFLICT', {}, 'PAYMENT_VOIDED')),
    ).toEqual({ key: 'organizations.balance.errors.voided', reload: true });
    expect(
      describeBalanceError(
        new ApiValidationError('x', 'VALIDATION_FAILED', [{ path: 'paidOn', message: 'future' }]),
      ),
    ).toEqual({ key: 'organizations.balance.errors.paidOn', reload: false });
    expect(
      describeBalanceError(
        new ApiValidationError('x', 'VALIDATION_FAILED', [{ path: 'rate', message: 'bad' }]),
      ),
    ).toEqual({ key: 'organizations.balance.errors.rate', reload: false });
    expect(describeBalanceError(new PermissionDeniedError()).key).toBe('apiErrors.denied');
    expect(describeBalanceError(new Error('x')).key).toBe('apiErrors.generic');
  });
});
