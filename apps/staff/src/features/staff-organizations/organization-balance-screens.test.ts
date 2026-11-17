import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { servicesKey } from '@/app/services';
import { dismissToast, useToast } from '@core/composables/use-toast';
import { fakeOrderId, fakeUuid } from '@core/lib/fake-ids';
import { formatNumber } from '@core/lib/format';
import { fromCents, toCents } from '@core/lib/money';
import type { FakeScenario } from '@core/lib/fake-scenario';
import { createTestServices } from '@/test-utils/create-test-services';
import OrganizationBalanceSection from './components/OrganizationBalanceSection.vue';

// The organization balance section ([C] 2026-10-26) over the in-memory fakes: the manager records
// a payment, the admin corrects or voids one, the accountant only reads, and warehouse and driver
// do not see the section at all.

const GSM = fakeUuid('org-gsm-plus'); // one RECEIVED order (IO-10470), unpaid, no payments
const IDEAL = fakeUuid('org-orion-mobile'); // one RECEIVED order (IO-10455), paid by a seeded payment

const wrappers: VueWrapper[] = [];
let wide = true;

beforeEach(() => {
  wide = true;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: wide }) as MediaQueryList,
  });
});
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  dismissToast();
});

async function mountSection(identity: string, organizationId = GSM, scenario?: FakeScenario) {
  const created = createTestServices({ identityId: identity, scenario });
  const { services } = created;
  await services.currentUser.ensureLoaded();
  const getBalance = vi.spyOn(services.organizationBalanceApi, 'getBalance');
  const wrapper = mount(OrganizationBalanceSection, {
    attachTo: document.body,
    props: { organizationId },
    global: { provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return { ...created, getBalance };
}

const squash = (value: string | null | undefined): string =>
  (value ?? '').replace(/\s+/g, ' ').trim();
const text = (selector: string): string =>
  squash(document.body.querySelector(selector)?.textContent);
const all = (selector: string): HTMLElement[] =>
  Array.from(document.body.querySelectorAll<HTMLElement>(selector));
const money = (amount: string): string => `$${formatNumber(amount, { minFractionDigits: 2 })}`;

async function type(selector: string, value: string): Promise<void> {
  const input = document.body.querySelector(selector) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  await flushPromises();
}
async function click(selector: string): Promise<void> {
  (document.body.querySelector(selector) as HTMLElement).click();
  await flushPromises();
}

async function chooseCurrency(value: 'USD' | 'UZS'): Promise<void> {
  const currency = document.body.querySelector(
    '[data-testid="payment-currency"]',
  ) as HTMLSelectElement;
  currency.value = value;
  currency.dispatchEvent(new Event('change'));
  await flushPromises();
}
/** Past the form to the confirm step, then the save itself. */
async function submitAndConfirm(): Promise<void> {
  await click('[data-testid="payment-submit"]');
  await click('[data-testid="payment-submit"]');
}

describe('organization balance section', () => {
  it('shows the manager the server figures and records a payment with today as the default day', async () => {
    const { services } = await mountSection('manager');
    const before = await services.organizationBalanceApi.getBalance(GSM);
    expect(text('[data-testid="balance-due"]')).toBe(money(before.amountDue));
    expect(text('[data-testid="balance-received"]')).toBe(money(before.receivedTotal));
    expect(text('[data-testid="balance-due-uzs"]')).toContain("so'm");
    expect(text('[data-testid="balance-rate-note"]')).toContain("1 USD = 12 650 so'm");
    expect(text('[data-testid="balance-paid"]')).toBe('$0,00');
    expect(document.body.querySelector('[data-testid="balance-overpaid"]')).toBeNull();
    expect(text('[data-testid="organization-balance"]')).toContain("Hali to'lov kiritilmagan.");
    expect(all('[data-testid="correct-payment"], [data-testid="void-payment"]')).toHaveLength(0);

    await click('[data-testid="record-payment"]');
    const day = document.body.querySelector('[data-testid="payment-paid-on"]') as HTMLInputElement;
    expect(day.value).toBe('2026-10-19'); // TEST_NOW in Asia/Tashkent
    expect(day.max).toBe('2026-10-19');
    await chooseCurrency('USD');
    expect(document.body.querySelector('[data-testid="payment-rate"]')).toBeNull();
    await type('[data-testid="payment-amount"]', '100');
    await type('[data-testid="payment-comment"]', 'Naqd, kassaga');
    await submitAndConfirm();

    expect(useToast().toast.value?.message).toBe("To'lov kiritildi");
    // the dialog closes (after its exit animation)
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="payment-amount"]')).toBeNull(),
    );
    expect(text('[data-testid="balance-paid"]')).toBe('$100,00');
    const row = text('tbody tr');
    expect(row).toContain('19.10.2026');
    expect(row).toContain('$100,00');
    expect(row).toContain("≈ 1 265 000 so'm");
    expect(row).toContain('Naqd, kassaga');
    expect(row).toContain('Aziza Yusupova');
  });

  it('turns the received order PAID once the payments cover it, and shows an overpayment', async () => {
    const { services } = await mountSection('manager');
    const { amountDue } = await services.organizationBalanceApi.getBalance(GSM);
    await click('[data-testid="record-payment"]');
    await chooseCurrency('USD');
    await type('[data-testid="payment-amount"]', amountDue);
    await submitAndConfirm();
    expect(text('[data-testid="balance-due"]')).toBe("Qarzdorlik yo'q");
    const order = await services.ordersApi.getOrder(fakeOrderId('IO-10470'));
    expect(order.detail === 'FULL' && order.paymentStatus).toBe('PAID');

    await click('[data-testid="record-payment"]');
    await chooseCurrency('USD');
    await type('[data-testid="payment-amount"]', '5000');
    await submitAndConfirm();
    expect(text('[data-testid="balance-overpaid"]')).toBe('$5 000,00');
  });

  it('records a so\u2019m payment with a rate that starts from the current one and is required', async () => {
    const { services } = await mountSection('manager');
    const record = vi.spyOn(services.organizationBalanceApi, 'recordPayment');
    await click('[data-testid="record-payment"]');
    await chooseCurrency('UZS');
    const rate = document.body.querySelector('[data-testid="payment-rate"]') as HTMLInputElement;
    expect(rate.value).toBe('12650');
    await type('[data-testid="payment-amount"]', '1 200 000');
    await type('[data-testid="payment-rate"]', '');
    await click('[data-testid="payment-submit"]');
    expect(record).not.toHaveBeenCalled();
    expect(text('[data-testid="payment-error"]')).toBe(
      "Musbat kurs kiriting (ko'pi bilan 4 ta kasr raqami).",
    );

    await type('[data-testid="payment-rate"]', '12 000');
    await submitAndConfirm();
    expect(record).toHaveBeenCalledWith(GSM, {
      amount: '1200000',
      currency: 'UZS',
      rate: '12000',
      paidOn: '2026-10-19',
    });
    expect(text('[data-testid="balance-paid"]')).toBe('$100,00');
    const row = text('tbody tr');
    expect(row).toContain('$100,00');
    expect(row).toContain("1 200 000 so'm, kurs 12 000");
  });

  it('has no default currency: the amount waits for it, and its label names it', async () => {
    const { services } = await mountSection('manager');
    const record = vi.spyOn(services.organizationBalanceApi, 'recordPayment');
    await click('[data-testid="record-payment"]');
    const currency = document.body.querySelector(
      '[data-testid="payment-currency"]',
    ) as HTMLSelectElement;
    const amount = document.body.querySelector(
      '[data-testid="payment-amount"]',
    ) as HTMLInputElement;
    expect(currency.selectedOptions[0]?.disabled).toBe(true); // the placeholder: nothing chosen
    expect(amount.disabled).toBe(true);
    await click('[data-testid="payment-submit"]');
    expect(record).not.toHaveBeenCalled();
    expect(document.body.querySelector('[data-testid="payment-confirm"]')).toBeNull();
    expect(text('[data-testid="payment-error"]')).toBe('Valyutani tanlang.');

    await chooseCurrency('UZS');
    expect(amount.disabled).toBe(false);
    expect(text('[data-testid="payment-amount-label"]')).toBe("Summa (so'm)");
    await chooseCurrency('USD');
    expect(text('[data-testid="payment-amount-label"]')).toBe('Summa (USD)');
  });

  it('asks to confirm with the amount in both currencies and the debt after payment', async () => {
    const { services } = await mountSection('manager');
    const record = vi.spyOn(services.organizationBalanceApi, 'recordPayment');
    const { amountDue } = await services.organizationBalanceApi.getBalance(GSM);
    await click('[data-testid="record-payment"]');
    await chooseCurrency('UZS');
    await type('[data-testid="payment-amount"]', '1 265 000');
    await click('[data-testid="payment-submit"]');
    expect(record).not.toHaveBeenCalled();
    expect(text('[data-testid="payment-confirm-usd"]')).toBe('$100,00');
    expect(text('[data-testid="payment-confirm-uzs"]')).toBe("1 265 000 so'm");
    expect(text('[data-testid="payment-confirm-after"]')).toBe(
      money(fromCents(toCents(amountDue) - 10_000n)),
    );

    // Back keeps what was typed; a dollar amount shows its so'm at the current rate.
    await click('[data-testid="payment-back"]');
    expect(document.body.querySelector('[data-testid="payment-confirm"]')).toBeNull();
    await chooseCurrency('USD');
    await type('[data-testid="payment-amount"]', '999999');
    await click('[data-testid="payment-submit"]');
    expect(text('[data-testid="payment-confirm-uzs"]')).toBe("≈ 12 649 987 350 so'm");
    expect(text('[data-testid="payment-confirm-after-label"]')).toBe(
      "To'lovdan keyin ortiqcha to'lov",
    );

    await click('[data-testid="payment-submit"]');
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('confirms an admin correction as well, counting the debt without the old value', async () => {
    const { services } = await mountSection('admin', IDEAL);
    const { payments } = await services.organizationBalanceApi.getBalance(IDEAL);
    const correct = vi.spyOn(services.organizationBalanceApi, 'correctPayment');
    await click('[data-testid="correct-payment"]');
    expect(text('[data-testid="payment-amount-label"]')).toBe('Summa (USD)');
    await type('[data-testid="payment-amount"]', '1');
    await type('[data-testid="payment-reason"]', 'Summa xato');
    await click('[data-testid="payment-submit"]');
    expect(correct).not.toHaveBeenCalled();
    expect(text('[data-testid="payment-confirm-after"]')).toBe(
      money(fromCents(toCents(payments[0]?.amountUsd ?? '0') - 100n)),
    );
    await click('[data-testid="payment-submit"]');
    expect(correct).toHaveBeenCalledTimes(1);
  });

  it('checks the amount before sending and shows the server refusal of a future day', async () => {
    const { services } = await mountSection('manager');
    const record = vi.spyOn(services.organizationBalanceApi, 'recordPayment');
    await click('[data-testid="record-payment"]');
    await chooseCurrency('USD');
    await type('[data-testid="payment-amount"]', '0');
    await click('[data-testid="payment-submit"]');
    expect(record).not.toHaveBeenCalled();
    expect(text('[data-testid="payment-error"]')).toBe(
      "Musbat summa kiriting (ko'pi bilan 2 ta kasr raqami).",
    );

    await type('[data-testid="payment-amount"]', '1000');
    await type('[data-testid="payment-paid-on"]', '2026-10-20');
    await submitAndConfirm();
    expect(record).toHaveBeenCalledTimes(1);
    expect(text('[data-testid="payment-error"]')).toBe(
      "To'langan sana kelajakda bo'lishi mumkin emas.",
    );
    // the refusal goes back to the form, the dialog stays open with what was typed
    expect(
      (document.body.querySelector('[data-testid="payment-amount"]') as HTMLInputElement).value,
    ).toBe('1000');
  });

  it('lets the admin correct a payment with a required reason, and offers no recording', async () => {
    await mountSection('admin', IDEAL);
    expect(document.body.querySelector('[data-testid="record-payment"]')).toBeNull();
    expect(text('[data-testid="balance-due"]')).toBe("Qarzdorlik yo'q");
    await click('[data-testid="correct-payment"]');
    await type('[data-testid="payment-amount"]', '1');
    await click('[data-testid="payment-submit"]');
    expect(text('[data-testid="payment-error"]')).toBe('Sababni yozing.');
    await type('[data-testid="payment-reason"]', 'Summa xato kiritilgan');
    await submitAndConfirm();
    expect(useToast().toast.value?.message).toBe("To'lov tuzatildi");
    expect(text('[data-testid="balance-paid"]')).toBe('$1,00');
    expect(text('[data-testid="balance-due"]')).not.toBe("Qarzdorlik yo'q");
  });

  it('lets the admin void a payment: the row is marked with the reason and has no actions left', async () => {
    await mountSection('admin', IDEAL);
    await click('[data-testid="void-payment"]');
    expect(document.body.querySelector('[data-testid="payment-amount"]')).toBeNull();
    await type('[data-testid="payment-reason"]', 'Ikki marta kiritilgan');
    await click('[data-testid="payment-submit"]');
    expect(useToast().toast.value?.message).toBe("To'lov bekor qilindi");
    expect(text('[data-testid="payment-voided"]')).toContain('Bekor qilingan');
    expect(text('[data-testid="payment-voided"]')).toContain('Ikki marta kiritilgan');
    expect(all('[data-testid="void-payment"]')).toHaveLength(0);
    expect(text('[data-testid="balance-paid"]')).toBe('$0,00');
    expect(document.body.querySelector('tbody tr')?.className).toMatch(/muted/);
  });

  it('says so and shows the server state when the payment was voided meanwhile (409 PAYMENT_VOIDED)', async () => {
    const { services } = await mountSection('admin', IDEAL);
    const { payments } = await services.organizationBalanceApi.getBalance(IDEAL);
    await services.organizationBalanceApi.voidPayment(payments[0]?.id ?? '', { reason: 'Boshqa' });
    await click('[data-testid="correct-payment"]');
    await type('[data-testid="payment-amount"]', '1000');
    await type('[data-testid="payment-reason"]', 'x');
    await submitAndConfirm();
    expect(useToast().toast.value?.message).toBe(
      "Bu to'lov allaqachon bekor qilingan. Ma'lumot yangilandi.",
    );
    await vi.waitFor(() => expect(text('[data-testid="payment-voided"]')).toContain('Boshqa'));
    await vi.waitFor(() =>
      expect(document.body.querySelector('[data-testid="payment-reason"]')).toBeNull(),
    );
  });

  it('shows the accountant the balance read-only', async () => {
    await mountSection('accountant', IDEAL);
    expect(text('[data-testid="balance-due"]')).toBe("Qarzdorlik yo'q");
    expect(all('tbody tr')).toHaveLength(1);
    expect(
      all(
        '[data-testid="record-payment"], [data-testid="correct-payment"], [data-testid="void-payment"]',
      ),
    ).toHaveLength(0);
  });

  it('is not shown to the warehouse or the driver, and asks the server nothing', async () => {
    for (const identity of ['warehouse', 'driver']) {
      const { getBalance } = await mountSection(identity);
      expect(document.body.querySelector('[data-testid="organization-balance"]')).toBeNull();
      expect(getBalance).not.toHaveBeenCalled();
      for (const w of wrappers.splice(0)) w.unmount();
    }
  });

  it('has loading, error (with retry) and permission-denied states', async () => {
    await mountSection('manager', GSM, 'error');
    expect(document.body.querySelector('[data-state="error"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="record-payment"]')).toBeNull();
    for (const w of wrappers.splice(0)) w.unmount();
    document.body.innerHTML = '';
    await mountSection('manager', GSM, 'denied');
    expect(document.body.querySelector('[data-state="denied"]')).not.toBeNull();
    for (const w of wrappers.splice(0)) w.unmount();
    document.body.innerHTML = '';
    await mountSection('manager', GSM, 'loading');
    expect(document.body.querySelector('[data-state="loading"]')).not.toBeNull();
  });

  it('shows payments as cards on a phone, voided ones marked', async () => {
    wide = false;
    await mountSection('admin', IDEAL);
    expect(document.body.querySelector('table')).toBeNull();
    await click('[data-testid="void-payment"]');
    await type('[data-testid="payment-reason"]', 'Xato');
    await click('[data-testid="payment-submit"]');
    expect(text('[data-testid="payment-voided"]')).toContain('Bekor qilingan');
    expect(text('[data-testid="payment-voided"]')).toContain('Xato');
  });
});
