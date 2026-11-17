import { describe, expect, it, vi } from 'vitest';
import { InvalidResponseError } from '@core/lib/api-errors';
import { createHttpClient } from '@core/lib/http-client';
import { formatMoney } from '@core/lib/format';
import { usdToUzs, uzsToUsd } from '@core/lib/money';
import { waitFor } from '@core/test-utils/wait';
import {
  bodyText,
  click,
  findButton,
  mountCustomerApp,
  seededOrderId,
  useCustomerTestLifecycle,
} from '@/test-utils/customer-app';
import { createHttpCustomerBalanceApi } from './api/customer-balance-api';

useCustomerTestLifecycle();

const ORG_ACTIVE_OWNER = 'fake-owner';
const RATE = '12650.0000'; // the fake backend's
const due = (): string => document.querySelector('[data-testid="amount-due"]')?.textContent ?? '';
const nothing = (): Element | null => document.querySelector('[data-testid="nothing-due"]');

describe('GET /me/balance client', () => {
  function setup(status: number, body: unknown) {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
    const http = createHttpClient({ baseUrl: 'https://api.test', fetchImpl });
    return { fetchImpl, api: createHttpCustomerBalanceApi(http) };
  }

  it('reads the amount with a GET and parses it with the shared schema', async () => {
    const { api, fetchImpl } = setup(200, { amountDue: '1250000.00', currency: 'UZS' });
    expect(await api.getBalance()).toEqual({ amountDue: '1250000.00', currency: 'UZS' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/me/balance');
    expect(init.method).toBe('GET');
  });

  it('refuses an answer that carries more than the amount (no payment list for customers)', async () => {
    const { api } = setup(200, { amountDue: '0.00', currency: 'UZS', payments: [] });
    await expect(api.getBalance()).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe('amount to pay card', () => {
  it('shows a calm "nothing to pay" on the home screen when every received order is paid', async () => {
    await mountCustomerApp(ORG_ACTIVE_OWNER, '/');
    await waitFor(() => expect(nothing()).not.toBeNull());
    expect(nothing()?.textContent).toBe("Hozircha to'lanadigan summa yo'q");
    expect(document.querySelector('[data-testid="amount-due"]')).toBeNull();
  });

  it('shows the amount on the profile once a received order is unpaid, and none after a payment', async () => {
    const { backend, services, router } = await mountCustomerApp(ORG_ACTIVE_OWNER, '/orders');
    const order = await backend.ordersApi.get(seededOrderId(10487));
    await backend.ordersApi.receive(order.id, { expectedRowVersion: order.rowVersion });
    await router.push('/profile');
    await waitFor(() => expect(due()).not.toBe(''));
    // The debt is USD on the server; the customer sees it back in whole so'm at the current rate.
    expect(due()).toBe(`${formatMoney(usdToUzs(uzsToUsd(order.totalAmount, RATE), RATE))} so'm`);
    expect(bodyText()).toContain("To'lanishi kerak");

    const organizationId = services.session.me.value?.membership?.organizationId ?? '';
    backend.recordPayment(organizationId, order.totalAmount);
    await router.push('/');
    await waitFor(() => expect(nothing()).not.toBeNull());
  });

  it('says when the amount cannot be loaded and retries on request', async () => {
    let fail = true;
    await mountCustomerApp(ORG_ACTIVE_OWNER, '/profile', {
      decorate: (backend) => {
        const real = backend.balanceApi.getBalance.bind(backend.balanceApi);
        backend.balanceApi.getBalance = () => (fail ? Promise.reject(new Error('down')) : real());
      },
    });
    await waitFor(() => expect(bodyText()).toContain("Summani yuklab bo'lmadi"));
    fail = false;
    await click(findButton('Qayta urinish'));
    await waitFor(() => expect(nothing()).not.toBeNull());
  });
});
