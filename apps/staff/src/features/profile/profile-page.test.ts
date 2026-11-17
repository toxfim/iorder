import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { createMemoryHistory, RouterView } from 'vue-router';
import { servicesKey, type Services } from '@/app/services';
import { useTheme } from '@/features/preferences/composables/use-theme';
import { createFakeStaffNotificationsApi } from '@/features/staff-notifications/api/fake-staff-notifications';
import { createAppI18n } from '@/i18n';
import { ensureStaffSystemPagesMessages } from '@/i18n/staff-system-pages-messages';
import { createAppRouter } from '@/router';
import { createTestServices } from '@/test-utils/create-test-services';
import { withStaffCostMessages } from '@/test-utils/staff-cost-i18n';
import ProfilePage from './components/ProfilePage.vue';

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  document.body.innerHTML = '';
  // The theme choice is module state (and stored): put it back for the next test.
  useTheme().setChoice('system');
});

async function i18nWithPages() {
  const i18n = withStaffCostMessages(createAppI18n());
  await ensureStaffSystemPagesMessages(i18n);
  return i18n;
}

async function mountPage(
  identityId: string,
  overrides: Partial<Services> = {},
): Promise<VueWrapper> {
  const { services: base } = createTestServices({ identityId });
  await base.currentUser.ensureLoaded();
  const services: Services = { ...base, ...overrides };
  const wrapper = mount(ProfilePage, {
    attachTo: document.body,
    global: { plugins: [await i18nWithPages()], provide: { [servicesKey as symbol]: services } },
  });
  wrappers.push(wrapper);
  await flushPromises();
  return wrapper;
}

describe('profile page', () => {
  it("shows the signed-in person's name, role and what the role does", async () => {
    const wrapper = await mountPage('manager');
    const identity = wrapper.find('[data-testid="profile-identity"]').text();
    expect(identity).toContain('Menejer');
    expect(wrapper.find('[data-testid="profile-name"]').text().length).toBeGreaterThan(0);
    const role = wrapper.find('[data-testid="profile-role"]').text();
    expect(role).toContain('Sizning rolingiz: Menejer');
    expect(role).toContain('Rolni faqat administrator');
  });

  it('has no password form on the page: a password has no self-service endpoint', async () => {
    const wrapper = await mountPage('driver');
    expect(wrapper.findAll('input')).toHaveLength(0);
    expect(wrapper.find('[data-testid="profile-password-hint"]').text()).toContain(
      'administratorga murojaat qiling',
    );
    expect(wrapper.findAll('button').map((b) => b.text())).not.toContain("O'zgarishlarni saqlash");
  });

  it('shows the own bot connection for a non-admin and a note for an administrator', async () => {
    const connected = await mountPage('warehouse', {
      staffNotificationsApi: createFakeStaffNotificationsApi({
        telegramLinked: true,
        botConnected: true,
      }),
    });
    expect(connected.find('[data-testid="bot-state"]').text()).toBe('Ulangan');

    const admin = await mountPage('admin');
    expect(admin.find('[data-testid="bot-admin-note"]').exists()).toBe(true);
    expect(admin.find('[data-testid="bot-state"]').exists()).toBe(false);
  });

  it('the theme choice is the real preference (it sets the page theme)', async () => {
    const wrapper = await mountPage('accountant');
    const themeTrigger = wrapper
      .findAll('button[aria-haspopup]')
      .find((b) => b.attributes('aria-label') === 'Mavzu');
    expect(themeTrigger).toBeDefined();
    await themeTrigger?.trigger('click');
    await flushPromises();
    const dark = Array.from(document.body.querySelectorAll('[role="option"]')).find((o) =>
      (o.textContent ?? '').includes("Qorong'u"),
    );
    expect(dark).toBeDefined();
    (dark as HTMLElement).click();
    await flushPromises();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });
});

describe('system pages: routes per role', () => {
  async function visit(identityId: string | undefined, path: string): Promise<string> {
    const { services } = createTestServices({ identityId });
    const router = createAppRouter(services.currentUser, createMemoryHistory());
    await router.push(path);
    return String(router.currentRoute.value.name);
  }

  it('every staff role may open its own profile', async () => {
    for (const identity of ['admin', 'manager', 'accountant', 'warehouse', 'driver']) {
      expect(await visit(identity, '/staff/profile')).toBe('staff-profile');
    }
    expect(await visit('owner', '/staff/profile')).toBe('forbidden');
    expect(await visit(undefined, '/staff/profile')).toBe('login');
  });

  it('activity history and bot settings are for admin and manager only', async () => {
    for (const path of ['/staff/history', '/staff/bot-settings']) {
      expect(await visit('admin', path)).not.toBe('forbidden');
      expect(await visit('manager', path)).not.toBe('forbidden');
      for (const identity of ['accountant', 'warehouse', 'driver']) {
        expect(await visit(identity, path)).toBe('forbidden');
      }
    }
    expect(await visit('admin', '/staff/history')).toBe('staff-history');
    expect(await visit('manager', '/staff/bot-settings')).toBe('staff-botSettings');
  });

  it('the top bar avatar opens the profile', async () => {
    const { services } = createTestServices({ identityId: 'driver' });
    const router = createAppRouter(services.currentUser, createMemoryHistory());
    await router.push('/staff/deliveries');
    const host = defineComponent({ render: () => h(RouterView) });
    const wrapper = mount(host, {
      attachTo: document.body,
      global: {
        plugins: [router, await i18nWithPages()],
        provide: { [servicesKey as symbol]: services },
      },
    });
    wrappers.push(wrapper);
    await flushPromises();
    await flushPromises();
    const avatar = wrapper.find('[data-testid="topbar-avatar"]');
    expect(avatar.attributes('href')).toBe('/staff/profile');
    await avatar.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('staff-profile');
  });
});
