import { describe, expect, it } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { createFakeAuthApi } from '@/features/auth/api/fake-auth-api';
import { createCurrentUserStore } from '@/features/auth/composables/current-user-store';
import { createAppRouter } from '@/router';
import { createAppI18n } from './index';
import { ensureStaffOrdersMessages } from './staff-orders-messages';

const hasLabels = (i18n: ReturnType<typeof createAppI18n>, locale: 'uz' | 'ru' | 'en'): boolean =>
  i18n.global.te('orders.contact.title', locale);

describe('lazy staff order labels', () => {
  it('are missing from a fresh instance and merged per locale on demand', async () => {
    const i18n = createAppI18n('RU');
    expect(hasLabels(i18n, 'ru')).toBe(false);
    expect(hasLabels(i18n, 'uz')).toBe(false);
    await ensureStaffOrdersMessages(i18n);
    expect(hasLabels(i18n, 'ru')).toBe(true);
    expect(hasLabels(i18n, 'uz')).toBe(true); // the fallback language
    expect(hasLabels(i18n, 'en')).toBe(false); // not needed yet
  });

  it('load the new language when the person switches language', async () => {
    const i18n = createAppI18n('UZ');
    await ensureStaffOrdersMessages(i18n);
    i18n.global.locale.value = 'en';
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(i18n.global.t('orders.contact.title')).toBe('Delivery contact');
  });

  it('are loaded by the router for staff pages only', async () => {
    const customerI18n = createAppI18n('UZ');
    const customer = createAppRouter(
      createCurrentUserStore(createFakeAuthApi({ initialIdentityId: 'owner' })),
      createMemoryHistory(),
      customerI18n,
    );
    await customer.push('/cart');
    expect(hasLabels(customerI18n, 'uz')).toBe(false);

    for (const [identity, page] of [
      ['manager', '/staff/orders'],
      ['accountant', '/staff/accounting'],
      ['warehouse', '/staff/warehouse'],
      ['driver', '/staff/deliveries'],
    ] as const) {
      const staffI18n = createAppI18n('UZ');
      const staff = createAppRouter(
        createCurrentUserStore(createFakeAuthApi({ initialIdentityId: identity })),
        createMemoryHistory(),
        staffI18n,
      );
      await staff.push(page);
      expect(hasLabels(staffI18n, 'uz')).toBe(true);
      expect(staff.currentRoute.value.path).toBe(page);
    }
  });
});
