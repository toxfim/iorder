import { describe, expect, it, vi } from 'vitest';
import {
  ORGANIZATION_PAYMENT_ROUTES,
  type OrganizationBalanceResponse,
} from '@iorder/shared/staff-orders';
import {
  ApiConflictError,
  ApiValidationError,
  InvalidResponseError,
  PermissionDeniedError,
} from '@core/lib/api-errors';
import { fakeUuid } from '@core/lib/fake-ids';
import { createHttpClient } from '@core/lib/http-client';
import { createHttpOrganizationBalanceApi } from './organization-balance-api';

// CONTRACT test of the HTTP adapter: each method hits its route from the shared table with the
// body the shared schema wants and parses the answer with the shared strict schema.

const ORG = fakeUuid('org-gsm-plus');
const PAYMENT = fakeUuid('payment:1');

const BALANCE: OrganizationBalanceResponse = {
  organizationId: ORG,
  currency: 'USD',
  receivedTotal: '150.00',
  paidTotal: '50.00',
  amountDue: '100.00',
  overpaid: '0.00',
  usdRate: '12000.0000',
  uzsEquivalent: {
    receivedTotal: '1800000.00',
    paidTotal: '600000.00',
    amountDue: '1200000.00',
    overpaid: '0.00',
  },
  payments: [
    {
      id: PAYMENT,
      organizationId: ORG,
      amount: '600000.00',
      currency: 'UZS',
      rate: '12000.0000',
      amountUsd: '50.00',
      amountUzs: '600000.00',
      paidOn: '2026-10-18',
      comment: null,
      recordedByName: 'Aziza Yusupova',
      recordedByUserId: '00000000-0000-7000-8000-00000000a001',
      recordedAt: '2026-10-18T05:00:00.000Z',
      voidedAt: null,
      voidReason: null,
      updatedAt: '2026-10-18T05:00:00.000Z',
    },
  ],
};

function setup(status: number, body: unknown = BALANCE) {
  const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
  return { fetchImpl, api: createHttpOrganizationBalanceApi(http) };
}

function call(fetchImpl: ReturnType<typeof setup>['fetchImpl']): [string, RequestInit] {
  return fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
}

describe('createHttpOrganizationBalanceApi', () => {
  it('reads the balance of one organization', async () => {
    const { api, fetchImpl } = setup(200);
    expect(await api.getBalance(ORG)).toEqual(BALANCE);
    const [url, init] = call(fetchImpl);
    expect(init.method).toBe('GET');
    expect(url).toBe(`https://api.test/staff/organizations/${ORG}/balance`);
  });

  it.each([
    [
      'recordPayment',
      'POST',
      `/staff/organizations/${ORG}/payments`,
      ORG,
      { amount: '250000', currency: 'UZS', rate: '12000', paidOn: '2026-10-19', comment: 'Naqd' },
    ],
    [
      'correctPayment',
      'PATCH',
      `/staff/organization-payments/${PAYMENT}`,
      PAYMENT,
      { amount: '450000', rate: '12500', reason: 'Xato summa' },
    ],
    [
      'voidPayment',
      'POST',
      `/staff/organization-payments/${PAYMENT}/void`,
      PAYMENT,
      { reason: 'Ikki marta kiritilgan' },
    ],
  ] as const)(
    '%s sends %s %s with exactly the request body',
    async (method, verb, path, id, body) => {
      const { api, fetchImpl } = setup(200);
      const result = await (api[method] as (id: string, request: unknown) => Promise<unknown>)(
        id,
        body,
      );
      expect(result).toEqual(BALANCE);
      const [url, init] = call(fetchImpl);
      expect(init.method).toBe(verb);
      expect(url).toBe(`https://api.test${path}`);
      expect(JSON.parse(String(init.body))).toEqual(body);
    },
  );

  it('is built from the shared route table', () => {
    expect(ORGANIZATION_PAYMENT_ROUTES.voidPayment).toEqual({
      method: 'POST',
      path: '/staff/organization-payments/:id/void',
    });
  });

  it('maps 403, 409 PAYMENT_VOIDED and 422 to typed errors', async () => {
    await expect(
      setup(403, { error: { code: 'FORBIDDEN', message: 'x' } }).api.getBalance(ORG),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const voided = await setup(409, {
      error: { code: 'CONFLICT', message: 'x', reason: 'PAYMENT_VOIDED' },
    })
      .api.voidPayment(PAYMENT, { reason: 'x' })
      .catch((e: unknown) => e);
    expect(voided).toBeInstanceOf(ApiConflictError);
    expect((voided as ApiConflictError).reason).toBe('PAYMENT_VOIDED');
    await expect(
      setup(422, {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'x',
          details: [{ path: 'paidOn', message: 'future' }],
        },
      }).api.recordPayment(ORG, { amount: '1', currency: 'USD', paidOn: '2026-10-30' }),
    ).rejects.toBeInstanceOf(ApiValidationError);
  });

  it('refuses an answer that is not the contract (an unknown field)', async () => {
    const { api } = setup(200, { ...BALANCE, costUsd: '1' });
    await expect(api.getBalance(ORG)).rejects.toBeInstanceOf(InvalidResponseError);
  });
});
