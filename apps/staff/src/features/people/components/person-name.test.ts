import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import type { StaffRole } from '@iorder/shared';
import { ApiResponseError } from '@core/lib/api-errors';
import { servicesKey } from '@/app/services';
import PersonName from './PersonName.vue';

const USER = '00000000-0000-7000-8000-000000000042';
const CARD = {
  id: USER,
  fullName: 'Aziza Yusupova',
  phone: '+998901234567',
  status: 'ACTIVE' as const,
  staffRoles: ['MANAGER' as const],
  membership: null,
};

function setup(role: StaffRole, card = vi.fn().mockResolvedValue(CARD), props = {}) {
  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    missingWarn: false,
    fallbackWarn: false,
    messages: { en: { roles: { staff: { MANAGER: 'Manager' } } } },
  });
  const user = ref({ staffRoles: [role] });
  const wrapper = mount(PersonName, {
    attachTo: document.body,
    props: { name: 'Aziza Y.', userId: USER, ...props },
    global: {
      plugins: [i18n],
      provide: {
        [servicesKey as symbol]: {
          peopleApi: { card },
          currentUser: { user: computed(() => user.value) },
        },
      },
    },
  });
  return { wrapper, card };
}

const hover = async (wrapper: ReturnType<typeof setup>['wrapper'], pointerType = 'mouse') => {
  // A native event: test-utils' trigger() cannot set clientX, which is getter-only on the event.
  wrapper
    .find('[data-testid="person-name"]')
    .element.dispatchEvent(
      new PointerEvent('pointerenter', { pointerType, clientX: 50, clientY: 50 }),
    );
  await vi.advanceTimersByTimeAsync(300);
  await flushPromises();
  await nextTick();
};

const shown = () => document.body.querySelector('[data-testid="person-card"]');

describe('PersonName', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('shows name, role and phone on a mouse hover', async () => {
    const { wrapper, card } = setup('MANAGER');
    await hover(wrapper);
    expect(card).toHaveBeenCalledWith({ userId: USER });
    expect(shown()?.textContent).toContain('Aziza Yusupova');
    expect(shown()?.textContent).toContain('Manager');
    expect(shown()?.textContent).toContain('+998901234567');
    wrapper.unmount();
  });

  it('does not open on touch', async () => {
    const { wrapper, card } = setup('MANAGER');
    await hover(wrapper, 'touch');
    expect(shown()).toBeNull();
    expect(card).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('is a plain name for the warehouse and asks the api nothing', async () => {
    const { wrapper, card } = setup('WAREHOUSE_MANAGER');
    expect(wrapper.find('[data-testid="person-name"]').exists()).toBe(false);
    expect(wrapper.text()).toBe('Aziza Y.');
    expect(card).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it('is a plain name when nothing identifies the person', () => {
    const { wrapper } = setup('MANAGER', undefined, { userId: null });
    expect(wrapper.find('[data-testid="person-name"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('closes after the pointer leaves', async () => {
    const { wrapper } = setup('MANAGER');
    await hover(wrapper);
    await wrapper.find('[data-testid="person-name"]').trigger('pointerleave');
    await vi.advanceTimersByTimeAsync(200);
    await nextTick();
    expect(shown()).toBeNull();
    wrapper.unmount();
  });

  it('still shows the name for a Telegram id nobody has', async () => {
    const card = vi.fn().mockRejectedValue(new ApiResponseError('Not found', 404, 'NOT_FOUND'));
    const { wrapper } = setup('MANAGER', card, { userId: null, telegramUserId: '777' });
    await hover(wrapper);
    expect(card).toHaveBeenCalledWith({ telegramUserId: '777' });
    expect(shown()?.textContent).toContain('Aziza Y.');
    wrapper.unmount();
  });
});
