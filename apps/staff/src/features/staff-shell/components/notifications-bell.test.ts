import { flushPromises, mount, RouterLinkStub } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';
import { createI18n } from 'vue-i18n';
import type { StaffRole } from '@iorder/shared';
import { servicesKey } from '@/app/services';
import NotificationsBell from './NotificationsBell.vue';

const ITEM = {
  id: '01900000-0000-7000-8000-00000000f001',
  type: 'ORDER_SUBMITTED' as const,
  orderId: '01900000-0000-7000-8000-000000000001',
  orderNumber: '1001',
  createdAt: '2026-10-31T10:00:00.000Z',
  lines: [{ productCode: 'P-1', name: 'Robot pylesos', quantity: '2.000' }],
};

function setup(role: StaffRole, markedOrders = vi.fn().mockResolvedValue({ items: [ITEM] })) {
  const i18n = createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false });
  const wrapper = mount(NotificationsBell, {
    global: {
      plugins: [i18n],
      stubs: { RouterLink: RouterLinkStub },
      provide: {
        [servicesKey as symbol]: {
          staffNotificationsApi: { markedOrders },
          currentUser: { user: computed(() => ({ id: 'user-1', staffRoles: [role] })) },
        },
      },
    },
  });
  return { wrapper, markedOrders };
}

describe('NotificationsBell', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('asks the server nothing for a role without a feed', async () => {
    const { wrapper, markedOrders } = setup('MANAGER');
    await flushPromises();
    expect(markedOrders).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="notifications-unread"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('shows the dot, lists the order on open, and the dot stays gone after that', async () => {
    const first = setup('PURCHASING_MANAGER');
    await flushPromises();
    expect(first.wrapper.find('[data-testid="notifications-unread"]').exists()).toBe(true);

    await first.wrapper.find('[data-testid="notifications-bell"]').trigger('click');
    await flushPromises();
    expect(first.wrapper.find('[data-testid="marked-orders"]').text()).toContain('Robot pylesos');
    expect(first.wrapper.find('[data-testid="marked-orders"]').text()).not.toContain('2.000');
    expect(first.wrapper.find('[data-testid="notifications-unread"]').exists()).toBe(false);
    first.wrapper.unmount();

    const second = setup('PURCHASING_MANAGER');
    await flushPromises();
    expect(second.wrapper.find('[data-testid="notifications-unread"]').exists()).toBe(false);
    second.wrapper.unmount();
  });

  it('says so when the list cannot be read', async () => {
    const { wrapper } = setup('PURCHASING_MANAGER', vi.fn().mockRejectedValue(new Error('down')));
    await flushPromises();
    await wrapper.find('[data-testid="notifications-bell"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[role="alert"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="marked-orders"]').exists()).toBe(false);
    wrapper.unmount();
  });
});
